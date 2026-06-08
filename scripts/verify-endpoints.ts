/**
 * M4-C — worker endpoints end-to-end (spawns the worker; stub provider; real
 * Chromium build+walk). Run: `npx tsx scripts/verify-endpoints.ts`.
 *
 * Pure: resolveTraceCoordinate + isUnderArtifactsRoot.
 * HTTP: /api/build -> /api/walk (sorted) -> /api/missions -> /api/artifact
 *       (stream + escape-reject) -> /api/comment (trace-anchored).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveTraceCoordinate } from "../src/lib/core/walk/comment-anchor";
import { isUnderArtifactsRoot, ARTIFACTS_ROOT } from "../src/lib/core/walk/capture";
import type { MissionTrace, VerdictStatus } from "../src/lib/core/domain/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rank(s: VerdictStatus): number {
  return s === "fail" ? 0 : s === "ambiguous" ? 1 : 2;
}

async function main(): Promise<void> {
  // ── pure ──────────────────────────────────────────────────────────────────
  const trace: MissionTrace = {
    missionId: "mission-x",
    reached: true,
    attempts: 1,
    entryRoute: "/",
    steps: [
      { index: 0, actionKind: "navigate", url: "http://x/", screenshot: "s0", dom: "d0" },
      { index: 1, actionKind: "click", url: "http://x/?a", screenshot: "s1", dom: "d1" },
    ],
    terminalUrl: "http://x/term",
    consoleErrors: [],
  };
  truthy("anchor: step coordinate uses the step's url", resolveTraceCoordinate(trace, 1).url === "http://x/?a");
  truthy("anchor: mission-level uses terminal url", resolveTraceCoordinate(trace).url === "http://x/term");
  truthy("artifact guard: in-root path allowed", isUnderArtifactsRoot(path.join(ARTIFACTS_ROOT, "run", "m", "step-0.png")));
  truthy("artifact guard: escape rejected", !isUnderArtifactsRoot("/etc/passwd"));

  // ── HTTP end-to-end ─────────────────────────────────────────────────────────
  const PORT = 4400;
  const base = `http://127.0.0.1:${PORT}`;
  const worker = spawn("npx", ["tsx", "worker/index.ts"], {
    env: { ...process.env, SELFQA_WORKER_PORT: String(PORT), SELFQA_STORE: "memory" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });

  try {
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) {
          healthy = true;
          break;
        }
      } catch {
        /* starting */
      }
      await sleep(500);
    }
    truthy("worker /api/health up", healthy);

    const build = await (
      await fetch(base + "/api/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "a todo app" }),
      })
    ).json();
    truthy("/api/build returns appId + url", !!build.appId && !!build.url);

    const run = await (
      await fetch(base + "/api/walk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: build.appId }),
      })
    ).json();
    truthy("/api/walk returns >= 8 missions", Array.isArray(run.missions) && run.missions.length >= 8);
    const ranks = run.missions.map((m: { verdict: { status: VerdictStatus } }) => rank(m.verdict.status));
    truthy("/api/walk sorted failed>ambiguous>passed", ranks.every((r: number, i: number) => i === 0 || ranks[i - 1] <= r));

    const got = await (await fetch(base + `/api/missions?appId=${build.appId}`)).json();
    truthy("/api/missions replays the run", got.missions?.length === run.missions.length);

    const step0 = run.missions[0].trace.steps[0];
    const art = await fetch(base + `/api/artifact?path=${encodeURIComponent(step0.screenshot)}`);
    truthy("/api/artifact streams a screenshot (image/png)", art.status === 200 && (art.headers.get("content-type") ?? "").includes("image/png"));
    const esc = await fetch(base + `/api/artifact?path=${encodeURIComponent("/etc/passwd")}`);
    truthy("/api/artifact rejects an escaping path (403)", esc.status === 403);

    interface MR { mission: { id: string }; trace: { steps: unknown[] }; verdict: { status: string } }
    const missionsArr = run.missions as MR[];
    const target = missionsArr.find((m) => m.mission.id === "mission-add-todo") ?? missionsArr[0];
    const stepIndex = target.trace.steps.length - 1;
    const cmt = await (
      await fetch(base + "/api/comment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: build.appId,
          missionId: target.mission.id,
          stepIndex,
          nl: "the title should indicate it was edited",
          commentType: "step-anchored",
        }),
      })
    ).json();
    truthy("/api/comment returns ok + a flip outcome", cmt.ok === true && !!cmt.flip);
    truthy(
      "/api/comment: the comment's assertion FLIPS fail->pass through the worker",
      cmt.flip?.assertionResult === "flipped" && cmt.flip?.verdict?.status === "pass",
    );

    const prom = await (
      await fetch(base + "/api/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: build.appId, missionId: target.mission.id }),
      })
    ).json();
    truthy("/api/promote mints a regression test", prom.ok === true && prom.regressionPromoted === true);

    // M6-B: the comment above emitted the four metric events; the dashboard aggregates them.
    const metrics = await (await fetch(base + `/api/metrics?appId=${build.appId}`)).json();
    truthy(
      "/api/metrics aggregates the comment's deterministic assertion (≥1 det, meets target)",
      metrics.detSemantic?.deterministic >= 1 && metrics.detSemantic?.meetsTarget === true,
    );
    truthy(
      "/api/metrics reports a bucket decision + a terminated loop attempt",
      (metrics.bucket?.everything + metrics.bucket?.local) >= 1 && metrics.attempts?.total >= 1,
    );

    // M5-L: the promoted test is a durable, Mission-shaped, kind-derived regression test.
    const regs1 = await (await fetch(base + `/api/regressions?appId=${build.appId}`)).json();
    truthy(
      "/api/regressions lists the promoted test as ACTIVE (kind derived, frozen at a sha)",
      Array.isArray(regs1.tests) &&
        regs1.tests.some((t: { id: string; status: string; kind: string; frozenAtSha: string }) => t.id === target.mission.id && t.status === "active" && (t.kind === "deterministic" || t.kind === "semantic") && !!t.frozenAtSha),
    );

    // M5-L lifecycle: propose-then-human-approve, NEVER an auto-drop (P1).
    await fetch(base + "/api/retire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: build.appId, missionId: target.mission.id, reason: "noisy" }) });
    const regs2 = await (await fetch(base + `/api/regressions?appId=${build.appId}`)).json();
    truthy("/api/retire (propose) -> status retirement-proposed, test NOT dropped", regs2.tests.some((t: { id: string; status: string }) => t.id === target.mission.id && t.status === "retirement-proposed"));
    await fetch(base + "/api/retire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: build.appId, missionId: target.mission.id, approve: true }) });
    const regs3 = await (await fetch(base + `/api/regressions?appId=${build.appId}`)).json();
    truthy("/api/retire (approve) -> status retired (human-approved only)", regs3.tests.some((t: { id: string; status: string }) => t.id === target.mission.id && t.status === "retired"));

    // M5-L: the run-to-run diff is a durable, derived SHA_n-vs-SHA_{n-1} query.
    const diff = await (await fetch(base + `/api/diff?appId=${build.appId}&from=${build.sha}&to=${cmt.sha}`)).json();
    truthy("/api/diff returns the durable rich diff (entries + counts, fromSha/toSha)", Array.isArray(diff.entries) && !!diff.counts && diff.fromSha === build.sha && diff.toSha === cmt.sha);
  } finally {
    if (worker.pid) {
      try {
        process.kill(-worker.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  }

  if (failures) {
    console.error("\n" + failures + " endpoint check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: worker endpoints green (build -> walk -> missions -> artifact -> comment)");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
