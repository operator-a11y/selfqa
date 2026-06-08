/**
 * M8 — the reproducible hero demo. Run: `npm run demo` (or `npx tsx scripts/demo.ts`).
 *
 * Drives the REAL worker over HTTP on the deterministic stub provider (no API key)
 * and narrates the win-condition arc: build → walk → a reached-but-failing mission →
 * a step-anchored comment → the five-leg tuple → codegen consumes the assertion →
 * re-walk flips fail→pass → promote → it appears in the run diff → kill + restart the
 * worker → it's all still there. This is a human-facing narration of the same loop
 * that `scripts/verify-loop-e2e.ts` proves with hard assertions; see DEMO.md for the
 * storyboard and the honest caveats (stub provider, happy-path hero, steady-state timing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { getProvider } from "../src/lib/core/provider/factory";
import { assembleTuple } from "../src/lib/core/codegen/tuple";
import type { MissionTrace } from "../src/lib/core/domain/types";

const PORT = 4600;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `selfqa-demo-${process.pid}.db`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const since = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

function say(beat: string, line: string): void {
  console.log(`\n\x1b[1m${beat}\x1b[0m  ${line}`);
}
function detail(line: string): void {
  console.log(`        ${line}`);
}
const post = (p: string, body: unknown) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p: string) => fetch(BASE + p).then((r) => r.json());

function spawnWorker(): ChildProcess {
  return spawn("npx", ["tsx", "worker/index.ts"], {
    env: { ...process.env, SELFQA_WORKER_PORT: String(PORT), SELFQA_DB_PATH: DB },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
}
async function waitHealth(tries = 120): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(BASE + "/api/health")).ok) return true;
    } catch {
      /* starting */
    }
    await sleep(500);
  }
  return false;
}
function kill(p: ChildProcess): void {
  if (p.pid) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

interface MR {
  mission: { id: string; name: string };
  verdict: { status: string };
  trace: MissionTrace & { reached: boolean; steps: { index: number; screenshot: string }[] };
  regressionPromoted?: boolean;
}

async function main(): Promise<void> {
  rmSync(DB, { force: true });
  console.log("\n\x1b[1mSelfQA — an agent that builds a web app, then verifies its own work. You are the judge.\x1b[0m");
  console.log("(deterministic stub provider — no API key; reproducible by construction)\n");
  let worker = spawnWorker();
  try {
    if (!(await waitHealth())) throw new Error("worker did not start");

    let t = Date.now();
    const build = await post("/api/build", { prompt: "a todo app" });
    say("① BUILD", `a Next.js todo app from one line — it owns the routes, test-ids, and seed data.`);
    detail(`appId ${build.appId} · build ${String(build.sha).slice(0, 10)} · serving at ${build.url} (${since(t)})`);

    t = Date.now();
    const run = await post("/api/walk", { appId: build.appId });
    const missions = run.missions as MR[];
    say("② WALK", `derives named missions and walks each in real Chromium → a verdict list, sorted most-actionable first (fail > ambiguous > pass).`);
    detail(`${missions.length} missions (${since(t)}): ` + missions.slice(0, 4).map((m) => `${m.mission.id}=${m.verdict.status}`).join(", ") + " …");

    const hero = missions.find((m) => m.mission.id === "mission-add-todo" && m.trace.reached && m.verdict.status !== "pass") ?? missions.find((m) => m.trace.reached && m.verdict.status !== "pass")!;
    const stepIndex = hero.trace.steps.length - 1;
    say("③ A REACHED-BUT-UNPROVEN MISSION", `reached, but its typed assertion is cleanly false — so it's ${hero.verdict.status}, flagged, not faked green.`);
    detail(`hero: ${hero.mission.id} (${hero.verdict.status}) · last-step screenshot: ${hero.trace.steps[stepIndex]?.screenshot ?? "—"}`);

    const nl = "the title should indicate it was edited";
    const tuple = await assembleTuple(getProvider(), { trace: hero.trace, stepIndex, nl, commentType: "step-anchored" });
    say("④ YOUR COMMENT → A 5-LEG TUPLE", `"${nl}"`);
    if (tuple.ok) {
      const f = tuple.feedback;
      detail(`1/5 mission id        ${f.missionId}`);
      detail(`2/5 action prefix     ${f.actionSequencePrefix.length} action(s)`);
      detail(`3/5 snapshot          ${f.snapshot.domPath.split("/").slice(-2).join("/")} (+ screenshot)`);
      detail(`4/5 your words        "${f.nl}"`);
      detail(`5/5 typed assertion   ${f.assertion.type}` + (f.assertion.type === "deterministic" ? ` ${f.assertion.predicate.kind} expected=${JSON.stringify(f.assertion.predicate.expected)}` : ""));
      detail(`(only leg 5 is the contribution — the only leg a machine can re-check)`);
    }

    t = Date.now();
    const cmt = await post("/api/comment", { appId: build.appId, missionId: hero.mission.id, stepIndex, nl, commentType: "step-anchored" });
    say("⑤ CONSUME → RE-WALK → FLIP", `codegen consumes the typed assertion, edits the code, re-walks, and re-checks.`);
    detail(`result: ${cmt.flip?.assertionResult} → verdict ${cmt.flip?.verdict?.status}  (${since(t)}, ONE re-walk — not the cap-3 loop)`);
    detail(`the after-state is freshly walked; the before-state is your comment-time snapshot, reconstructed into the same checker.`);

    say("⑥ TWO QUIET GUARANTEES", `the re-walk scope came mechanically from the git diff, and the re-check loop is provider-free — both asserted by verify-loop-e2e / verify-hot-path.`);
    const newlyPass = (cmt.diff?.entries ?? []).filter((e: { kind: string }) => e.kind === "newly-pass").map((e: { missionId: string }) => e.missionId);
    detail(`evidence here: the run-to-run diff records newly-pass = [${newlyPass.join(", ")}]`);

    const prom = await post("/api/promote", { appId: build.appId, missionId: hero.mission.id });
    say("⑦ PROMOTE (your approval only)", `the fixed mission is frozen into a permanent regression test, replayed on every later build.`);
    detail(`regression test minted · status ${prom.status} (a frozen Mission, re-checked by the same checker as a third entry point)`);

    const metrics = await get(`/api/metrics?appId=${build.appId}`);
    detail(`metrics: ${metrics.detSemantic?.deterministic} deterministic / ${metrics.detSemantic?.semantic} semantic assertion(s) (target ≥ ${Math.round(0.8 * 100)}% deterministic)`);

    kill(worker);
    await sleep(1500);
    worker = spawnWorker();
    await waitHealth();
    const reviewed = await get(`/api/missions?appId=${build.appId}`);
    const heroAfter = (reviewed.missions as MR[]).find((m) => m.mission.id === hero.mission.id);
    const metricsAfter = await get(`/api/metrics?appId=${build.appId}`);
    say("⑧ KILL + RESTART", `the worker comes back against the same SQLite db — the flip, verdict, regression, and metrics are all still there.`);
    detail(`after restart: ${hero.mission.id} verdict = ${heroAfter?.verdict.status} · regression promoted = ${heroAfter?.regressionPromoted} · metric events = ${metricsAfter.totalEvents}`);

    console.log("\n\x1b[1mBuild → walk → comment → flip → promote → remember — one tight loop, durable, with you as the judge.\x1b[0m");
    console.log("Reproduce the hard-assertion proof: npx tsx scripts/verify-loop-e2e.ts");
    console.log("Drive it yourself in a browser:    npm run worker  +  npm run build && npm run start\n");
  } finally {
    kill(worker);
    await sleep(400);
    for (const sfx of ["", "-wal", "-shm"]) rmSync(DB + sfx, { force: true });
  }
}

main().catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
