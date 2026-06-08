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
 * Run persistence is in-memory for M3–M4 (durable SQLite arrives in M5 with the
 * run-to-run diff). The executable half of the tuple (codegen consuming the typed
 * assertion + re-asserting on re-walk) is M5 per SPEC §10.5.
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import { getProvider } from "../src/lib/core/provider/factory";
import { buildApp, type GeneratedApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { extractSpec } from "../src/lib/core/codegen/spec-extractor";
import { editApp } from "../src/lib/core/codegen/edit-agent";
import {
  writeGeneratedApp,
  currentSha,
  type AppRepo,
} from "../src/lib/core/workspace/repo";
import {
  startApp,
  rebuildApp,
  stopAll,
  type RunningApp,
} from "../src/lib/core/runner/app-runner";
import { runMissions } from "../src/lib/core/run";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";
import { ClientContextIsolation } from "../src/lib/core/walk/isolation";
import { resolveTraceCoordinate } from "../src/lib/core/walk/comment-anchor";
import { isUnderArtifactsRoot } from "../src/lib/core/walk/capture";
import type { RunRecord } from "../src/lib/core/domain/types";

const PORT = Number(process.env.SELFQA_WORKER_PORT ?? 4317);
const provider = getProvider();
const iso = new ClientContextIsolation();

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
      console.log(`[worker] walk ${appId}: ${run.missions.length} missions`);
      return sendJson(res, 200, run);
    }

    if (req.method === "GET" && pathname === "/api/missions") {
      const appId = url.searchParams.get("appId") ?? "";
      const run = runs.get(appId);
      if (!run) return sendJson(res, 404, { error: "no run for appId" });
      return sendJson(res, 200, run);
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
      const nl = String(body.nl ?? "");

      // Trace-anchored (P2) when missionId is present: read {url, domPath} OFF the
      // stored trace at the coordinate. Otherwise fall back to a direct anchor.
      let target: { url: string; domPath: string };
      if (body.missionId) {
        const run = runs.get(appId);
        const mr = run?.missions.find((m) => m.mission.id === String(body.missionId));
        if (!mr) return sendJson(res, 404, { error: "unknown mission in run" });
        const stepIndex =
          typeof body.stepIndex === "number" ? body.stepIndex : undefined;
        target = resolveTraceCoordinate(mr.trace, stepIndex);
      } else {
        target = {
          url: String(body.url ?? built.running.url),
          domPath: String(body.domPath ?? ""),
        };
      }

      const spec = await extractSpec(provider, { comment: nl, ...target });
      const edit = await editApp(provider, { dir: built.repo.dir, comment: nl, ...target });
      const rebuilt = await rebuildApp(built.running);
      built.running = rebuilt;
      console.log(`[worker] comment on ${appId} -> edit ${edit.sha}, rebuilt at ${rebuilt.url}`);
      return sendJson(res, 200, {
        sha: edit.sha,
        changed: edit.changed,
        url: rebuilt.url,
        assertion: spec.assertion,
        clarifyingQuestion: spec.clarifyingQuestion,
        note: "M5: typed assertion persisted but not yet consumed by codegen / re-asserted on re-walk (SPEC §10.5)",
      });
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
  void Promise.allSettled([stopAll(), closeBrowser()]).finally(() =>
    process.exit(0),
  );
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
