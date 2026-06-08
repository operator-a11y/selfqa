/**
 * SelfQA worker — the long-running process (SPEC §14.1).
 *
 * Owns codegen (via the swappable LLMProvider), the lifecycle of generated-app
 * subprocesses, and mission runs. Endpoints:
 *   GET  /api/health
 *   POST /api/build     { prompt }            -> build + instrument + run an app
 *   POST /api/walk      { appId }             -> derive/compile/walk/verdict, sorted
 *   GET  /api/missions?appId=...              -> the persisted run (sorted)
 *   GET  /api/artifact?path=...               -> stream a captured artifact (confined)
 *   POST /api/comment   { appId, missionId?, stepIndex?, url?, domPath?, nl }
 *                                             -> trace-anchored edit + rebuild
 *
 * Metadata persistence is durable as of M5-K: apps, runs, verdicts (keyed by
 * (missionId, buildSha)), the grounded-feedback tuples, and the human-approved
 * regression registry are written through the MetadataStore seam (node:sqlite,
 * ./selfqa.db) and survive a restart. The repo, app subprocess, and browser are
 * process-local handles (held in `apps`) and intentionally do NOT persist.
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import { getProvider } from "../src/lib/core/provider/factory";
import { buildApp, type GeneratedApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { assembleTuple } from "../src/lib/core/codegen/tuple";
import { editFromTuples } from "../src/lib/core/codegen/edit-agent";
import {
  writeGeneratedApp,
  currentSha,
  diffFiles,
  type AppRepo,
} from "../src/lib/core/workspace/repo";
import {
  startApp,
  rebuildApp,
  stopAll,
  type RunningApp,
} from "../src/lib/core/runner/app-runner";
import { runMissions, rankVerdict } from "../src/lib/core/run";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";
import { ClientContextIsolation } from "../src/lib/core/walk/isolation";
import { isUnderArtifactsRoot } from "../src/lib/core/walk/capture";
import { classifyDiff, selectRewalkSet } from "../src/lib/core/verify/manifest";
import { planReWalk } from "../src/lib/core/rewalk/plan";
import { reWalk } from "../src/lib/core/rewalk/run-rewalk";
import { computeRunDiff } from "../src/lib/core/regression/diff";
import { makeMetadataStore } from "../src/lib/core/persist/factory";
import {
  commentAssertionCompiled,
  rewalkMissionReplay,
  rewalkBucketDecided,
  commentLoopTerminated,
} from "../src/lib/core/metrics/events";
import { aggregateMetrics } from "../src/lib/core/metrics/aggregate";
import type { CommentType, RunRecord } from "../src/lib/core/domain/types";

const PORT = Number(process.env.SELFQA_WORKER_PORT ?? 4317);
const provider = getProvider();
const iso = new ClientContextIsolation();
// Durable metadata (SPEC §11.1, M5-K): apps/runs/verdicts/comments/regressions
// survive a restart. The repo, subprocess, and browser handles below stay
// process-local (they cannot be serialized) — only metadata crosses the seam.
const store = makeMetadataStore();

interface BuiltApp {
  appId: string;
  repo: AppRepo;
  app: GeneratedApp;
  running: RunningApp;
}
const apps = new Map<string, BuiltApp>();
const runs = new Map<string, RunRecord>();

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return prefix + "-" + Date.now().toString(36) + "-" + counter;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function contentType(p: string): string {
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".webm")) return "video/webm";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  try {
    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, provider: provider.name });
    }

    if (req.method === "POST" && pathname === "/api/build") {
      const body = await readJson(req);
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) return sendJson(res, 400, { error: "prompt is required" });
      const appId = newId("app");
      console.log(`[worker] build ${appId}: ${prompt}`);
      const generated = instrument(await buildApp(provider, prompt));
      const repo = await writeGeneratedApp(appId, generated.files);
      const running = await startApp(repo.dir, { id: appId });
      const sha = await currentSha(repo.dir);
      apps.set(appId, { appId, repo, app: generated, running });
      store.saveApp({ appId, prompt, createdSha: sha });
      console.log(`[worker] build ${appId} ready at ${running.url} (sha ${sha})`);
      return sendJson(res, 200, { appId, url: running.url, sha });
    }

    if (req.method === "POST" && pathname === "/api/walk") {
      const body = await readJson(req);
      const appId = String(body.appId ?? "");
      const built = apps.get(appId);
      if (!built) return sendJson(res, 404, { error: "unknown appId" });
      const browser = await getBrowser();
      const buildSha = await currentSha(built.repo.dir);
      console.log(`[worker] walk ${appId} (sha ${buildSha})`);
      const run = await runMissions({
        provider,
        browser,
        iso,
        baseUrl: built.running.url,
        runId: newId("run"),
        appId,
        app: built.app,
        buildSha,
      });
      runs.set(appId, run);
      store.saveRun(run);
      console.log(`[worker] walk ${appId}: ${run.missions.length} missions`);
      return sendJson(res, 200, run);
    }

    if (req.method === "GET" && pathname === "/api/missions") {
      const appId = url.searchParams.get("appId") ?? "";
      // In-memory live copy first; fall back to the durable store so review
      // survives a worker restart even when the app subprocess is gone (M5-K).
      const run = runs.get(appId) ?? store.getRun(appId) ?? undefined;
      if (!run) return sendJson(res, 404, { error: "no run for appId" });
      return sendJson(res, 200, run);
    }

    if (req.method === "GET" && pathname === "/api/metrics") {
      const appId = url.searchParams.get("appId") ?? "";
      // Derived dashboard (M6-B, SPEC §12): aggregate the durable metric_event log.
      return sendJson(res, 200, aggregateMetrics(store.listMetrics(appId)));
    }

    if (req.method === "GET" && pathname === "/api/artifact") {
      const p = url.searchParams.get("path") ?? "";
      if (!p) return sendJson(res, 400, { error: "path required" });
      if (!isUnderArtifactsRoot(p)) {
        return sendJson(res, 403, { error: "path escapes artifacts root" });
      }
      try {
        const buf = await fs.readFile(p);
        res.writeHead(200, { "content-type": contentType(p) });
        res.end(buf);
      } catch {
        sendJson(res, 404, { error: "artifact not found" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/comment") {
      const body = await readJson(req);
      const appId = String(body.appId ?? "");
      const built = apps.get(appId);
      if (!built) return sendJson(res, 404, { error: "unknown appId" });
      const run = runs.get(appId);
      if (!run) return sendJson(res, 400, { error: "run /api/walk before commenting" });
      const missionId = String(body.missionId ?? "");
      const mr = run.missions.find((m) => m.mission.id === missionId);
      if (!mr) return sendJson(res, 404, { error: "unknown mission in run" });
      const nl = String(body.nl ?? "");
      const stepIndex = typeof body.stepIndex === "number" ? body.stepIndex : undefined;
      const commentType = (body.commentType as CommentType) ?? "step-anchored";

      // 1. compile the comment to the full grounded tuple (off the trace, never inferred)
      const tuple = await assembleTuple(provider, { trace: mr.trace, stepIndex, nl, commentType });
      if (!tuple.ok) return sendJson(res, 200, { route: "needs-human", reason: tuple.reason });
      store.saveComment(tuple.feedback, appId); // the grounded tuple is durable (SPEC §3, M5-K)

      // 2. codegen CONSUMES the tuple -> edit -> commit -> rebuild
      const shaBefore = await currentSha(built.repo.dir);
      await editFromTuples(provider, { dir: built.repo.dir, feedback: [tuple.feedback] });
      const rebuilt = await rebuildApp(built.running);
      built.running = rebuilt;
      const shaAfter = await currentSha(built.repo.dir);

      // 3. mechanical re-walk scope from the git diff (never editApp.changed, P1)
      const changed = await diffFiles(built.repo.dir, shaBefore, shaAfter);
      const cls = classifyDiff(changed);
      const priorTraces = new Map(run.missions.map((m) => [m.mission.id, m.trace]));
      const missionObjs = run.missions.map((m) => m.mission);
      const affectedIds = selectRewalkSet(missionObjs, priorTraces, cls, []);
      const affected = missionObjs.filter((m) => affectedIds.includes(m.id));
      const plan = await planReWalk(provider, { app: built.app, missions: affected, priorTraces, cls });

      // 4. re-walk REPLAYS + RE-ASSERTS the comment's assertion (the flip)
      const browser = await getBrowser();
      const record = await reWalk({ provider, browser, iso, baseUrl: rebuilt.url, runId: newId("rewalk"), buildSha: shaAfter, feedback: [tuple.feedback], plans: plan.plans, recompiled: plan.recompiled });

      // 5. merge updated verdicts (preserving promotion flags); compute the diff
      const updatedById = new Map((record.missions ?? []).map((m) => [m.mission.id, m]));
      // A grounded comment whose deterministic assertion FLIPPED fail→pass elevates
      // its mission's verdict to pass — provisional until human promote (SPEC §3,
      // §11.1). The mission's own first-walk criteria may still be ambiguous (e.g.
      // text-equals is off the whitelist), so without this the flip would never
      // surface in the run-to-run diff. The pass is EARNED (deterministic + human-
      // grounded), never guessed; humanApproved stays false until promote.
      const resolvedVerdict = new Map(
        record.outcomes
          .filter((o) => o.resolved && o.verdict.status === "pass")
          .map((o) => [o.missionId, o.verdict]),
      );
      const prior = run.missions;
      const next = run.missions.map((m) => {
        const u = updatedById.get(m.mission.id);
        const merged = u ? { ...u, regressionPromoted: m.regressionPromoted, retirementProposed: m.retirementProposed } : m;
        const rv = resolvedVerdict.get(m.mission.id);
        return rv ? { ...merged, verdict: { ...rv, buildSha: shaAfter } } : merged;
      });
      next.sort((a, b) => rankVerdict(a.verdict.status) - rankVerdict(b.verdict.status));
      const nextRun: RunRecord = { appId, buildSha: shaAfter, missions: next };
      runs.set(appId, nextRun);
      store.saveRun(nextRun, shaBefore); // new build's verdicts are durable; parent = pre-edit sha
      const diff = computeRunDiff(prior, next);
      const flip = record.outcomes[0];

      // metrics (M6-B) — emitted once, off the hot path, from GENUINE decisions:
      // the compiled assertion's type, the planner's per-mission recompile flag,
      // the manifest bucket, and the loop's attempts-to-termination (single-shot
      // here = 1 attempt; the cap-3 path lives in rewalk/loop.ts converge()).
      store.recordMetric(commentAssertionCompiled(appId, tuple.feedback.assertion, shaAfter));
      for (const [mid, recompiled] of Object.entries(plan.recompiled)) {
        store.recordMetric(rewalkMissionReplay(appId, mid, recompiled, shaAfter));
      }
      store.recordMetric(rewalkBucketDecided(appId, cls.bucket, shaAfter));
      store.recordMetric(commentLoopTerminated(appId, 1, !!flip?.resolved, shaAfter));

      console.log(`[worker] comment ${appId}/${missionId} -> ${flip?.assertionResult} (sha ${shaAfter.slice(0, 10)})`);
      return sendJson(res, 200, {
        ok: true,
        sha: shaAfter,
        url: rebuilt.url,
        changed,
        recompileRate: record.recompileRate,
        flip,
        diff,
        commentAssertion: tuple.feedback.assertion,
      });
    }

    if (req.method === "POST" && pathname === "/api/promote") {
      const body = await readJson(req);
      const run = runs.get(String(body.appId ?? ""));
      const mr = run?.missions.find((m) => m.mission.id === String(body.missionId ?? ""));
      if (!run || !mr) return sendJson(res, 404, { error: "unknown mission/run" });
      // Human approval mints a permanent regression test (§7.5) — durable (M5-K).
      mr.regressionPromoted = true;
      mr.retirementProposed = undefined;
      store.promoteRegressionTest(run.appId, mr.mission.id);
      store.saveRun(run); // persist the per-run promotion flag too
      return sendJson(res, 200, { ok: true, missionId: mr.mission.id, regressionPromoted: true });
    }

    if (req.method === "POST" && pathname === "/api/retire") {
      const body = await readJson(req);
      const run = runs.get(String(body.appId ?? ""));
      const mr = run?.missions.find((m) => m.mission.id === String(body.missionId ?? ""));
      if (!run || !mr) return sendJson(res, 404, { error: "unknown mission/run" });
      if (body.approve === true) {
        // human-approved retirement only — never an auto-drop (P1).
        mr.regressionPromoted = false;
        mr.retirementProposed = undefined;
        store.approveRetirement(run.appId, mr.mission.id);
        store.saveRun(run);
        return sendJson(res, 200, { ok: true, retired: true });
      }
      mr.retirementProposed = { reason: String(body.reason ?? "proposed") };
      store.proposeRetirement(run.appId, mr.mission.id, mr.retirementProposed.reason);
      store.saveRun(run);
      return sendJson(res, 200, { ok: true, retirementProposed: mr.retirementProposed });
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[worker] error:", e);
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[selfqa-worker] http://127.0.0.1:${PORT} (provider: ${provider.name}, pid ${process.pid})`,
  );
});

function shutdown(signal: string): void {
  console.log(`[selfqa-worker] ${signal} — stopping ${apps.size} app(s)`);
  void Promise.allSettled([stopAll(), closeBrowser()]).finally(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
