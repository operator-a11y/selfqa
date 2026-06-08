/**
 * M6-D — the end-to-end WIN CONDITION (SPEC §1, §3, §15). Run:
 * `npx tsx scripts/verify-loop-e2e.ts`. HEAVY (spawns the worker, real Chromium
 * build + walk, durable SQLite store, a worker restart).
 *
 * One uninterrupted proof of the whole novelty, through the real worker:
 *   build → walk → find a REACHED-but-non-pass mission → step-anchored comment →
 *   the 5-leg grounded tuple (every leg exists by construction) → codegen CONSUMES
 *   the typed assertion → re-walk REPLAYS + RE-ASSERTS → the deterministic
 *   assertion FLIPS fail→pass → promote to a permanent regression test → it shows
 *   up in the run-to-run diff → and the per-comment re-walk loop is provably
 *   PROVIDER-FREE (no LLM on the hot path).
 *
 * Plus the M5-K durability tie-in: kill the worker, restart it against the same
 * ./selfqa.db, and the flipped + promoted verdict is still reviewable.
 *
 * BUDGET HONESTY: correctness is asserted hard; wall-clock is soft-logged only.
 * The ~minutes here are steady-state (warm deps, one re-walk) — NOT a cold first
 * build and NOT the cap-3 convergence loop; do not read these timings as a cap.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";
import { getProvider } from "../src/lib/core/provider/factory";
import { assembleTuple } from "../src/lib/core/codegen/tuple";
import type { MissionTrace } from "../src/lib/core/domain/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const since = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

const PORT = 4500;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `selfqa-loop-e2e-${process.pid}.db`);

function spawnWorker(): ChildProcess {
  return spawn("npx", ["tsx", "worker/index.ts"], {
    env: { ...process.env, SELFQA_WORKER_PORT: String(PORT), SELFQA_DB_PATH: DB },
    stdio: ["ignore", "inherit", "inherit"],
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
const post = (path: string, body: unknown) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

interface MR {
  mission: { id: string; name: string };
  verdict: { status: string };
  trace: MissionTrace & { reached: boolean; steps: { index: number }[] };
  regressionPromoted?: boolean;
}

async function main(): Promise<void> {
  rmSync(DB, { force: true });
  let worker = spawnWorker();
  try {
    truthy("worker up (durable SQLite store)", await waitHealth());

    // ── build ──────────────────────────────────────────────────────────────
    let t = Date.now();
    const build = await post("/api/build", { prompt: "a todo app" });
    console.log(`   [timing] build: ${since(t)} (steady-state; cold first build installs deps)`);
    truthy("build → appId + url + sha", !!build.appId && !!build.url && !!build.sha);

    // ── walk ───────────────────────────────────────────────────────────────
    t = Date.now();
    const run = await post("/api/walk", { appId: build.appId });
    console.log(`   [timing] walk (derive+compile+walk all missions): ${since(t)}`);
    truthy("walk → ≥ 8 missions", Array.isArray(run.missions) && run.missions.length >= 8);

    // the hero: a mission we genuinely REACHED but whose verdict is not pass —
    // its "before" is cleanly FALSE, so a flip is a real fail→pass.
    const missions = run.missions as MR[];
    const target =
      missions.find((m) => m.mission.id === "mission-add-todo" && m.trace.reached && m.verdict.status !== "pass") ??
      missions.find((m) => m.trace.reached && m.verdict.status !== "pass");
    truthy("found a REACHED-but-non-pass mission (the hero)", !!target);
    if (!target) throw new Error("no reached-but-non-pass mission to drive the loop");
    const stepIndex = target.trace.steps.length - 1;
    const preStatus = target.verdict.status;
    truthy(`hero '${target.mission.id}' is reached + non-pass (${preStatus})`, target.trace.reached && preStatus !== "pass");

    // ── the 5-leg grounded tuple (direct, off the same trace) ────────────────
    const nl = "the title should indicate it was edited";
    const tuple = await assembleTuple(getProvider(), { trace: target.trace, stepIndex, nl, commentType: "step-anchored" });
    truthy("tuple assembles (not needs-human)", tuple.ok === true);
    if (tuple.ok) {
      const f = tuple.feedback;
      truthy("tuple leg 1/5 — mission id", f.missionId === target.mission.id);
      truthy("tuple leg 2/5 — action-sequence prefix (≥1 action)", Array.isArray(f.actionSequencePrefix) && f.actionSequencePrefix.length >= 1);
      truthy("tuple leg 3/5 — snapshot (url + domPath + domHtml + screenshot)", !!f.snapshot.url && !!f.snapshot.domPath && !!f.snapshot.domHtml && !!f.snapshot.screenshotPath);
      truthy("tuple leg 4/5 — natural-language comment", f.nl === nl);
      truthy("tuple leg 5/5 — typed deterministic assertion", f.assertion.type === "deterministic");
    }

    // ── comment through the worker: edit → rebuild → re-walk → flip ──────────
    t = Date.now();
    const cmt = await post("/api/comment", { appId: build.appId, missionId: target.mission.id, stepIndex, nl, commentType: "step-anchored" });
    console.log(`   [timing] comment→edit→rebuild→re-walk→flip: ${since(t)} (ONE re-walk, not the cap-3 loop)`);
    truthy("codegen consumed the assertion → re-walk FLIPPED fail→pass", cmt.flip?.assertionResult === "flipped" && cmt.flip?.verdict?.status === "pass");
    truthy("re-walk recompile rate is a number (manifest-scoped)", typeof cmt.recompileRate === "number");
    truthy("run-to-run diff: the hero newly PASSES", Array.isArray(cmt.diff?.newlyPass) && cmt.diff.newlyPass.includes(target.mission.id));

    // ── promote to a permanent regression test (human approval) ──────────────
    const prom = await post("/api/promote", { appId: build.appId, missionId: target.mission.id });
    truthy("promote mints a permanent regression test", prom.ok === true && prom.regressionPromoted === true);

    // ── NO LLM ON THE HOT PATH (structural; the marked re-walk loop region) ──
    const rewalkSrc = readFileSync("src/lib/core/rewalk/run-rewalk.ts", "utf8");
    const region = rewalkSrc.match(/SELFQA-REWALK-LOOP-START([\s\S]*?)SELFQA-REWALK-LOOP-END/)?.[1] ?? "";
    truthy("re-walk per-comment loop region is marked", region.length > 0);
    // No LLM on the hot path: the loop body makes no provider CALL and pulls in no
    // codegen (the word "provider-free" in the sentinel comment is fine).
    truthy(
      "re-walk loop region invokes NO provider/LLM (no provider. call, no getProvider/compileSequence/anthropic)",
      region.length > 0 && !/provider\s*\./.test(region) && !/getProvider|compileSequence|anthropic/i.test(region),
    );
    const manifestSrc = readFileSync("src/lib/core/verify/manifest.ts", "utf8");
    truthy("earned-optimization boundary is documented (precise import-graph)", /SELFQA-EARNED-OPTIMIZATION/.test(manifestSrc));

    // ── M5-K durability: restart the worker; review survives ─────────────────
    kill(worker);
    await sleep(1500);
    worker = spawnWorker();
    truthy("worker restarted against the same ./selfqa.db", await waitHealth());
    const reviewed = await (await fetch(BASE + `/api/missions?appId=${build.appId}`)).json();
    const heroAfter = (reviewed.missions as MR[] | undefined)?.find((m) => m.mission.id === target.mission.id);
    truthy("after restart: the run is still reviewable (durable, M5-K)", Array.isArray(reviewed.missions) && reviewed.missions.length >= 8);
    truthy("after restart: the hero's flipped verdict persisted (pass)", heroAfter?.verdict.status === "pass");
    truthy("after restart: the promoted regression test persisted", heroAfter?.regressionPromoted === true);
    const metrics = await (await fetch(BASE + `/api/metrics?appId=${build.appId}`)).json();
    truthy("after restart: the comment's metric events persisted (det assertion)", metrics.detSemantic?.deterministic >= 1);
  } finally {
    kill(worker);
    await sleep(500);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
  }

  if (failures) {
    console.error("\n" + failures + " win-condition check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: SelfQA closes the loop end-to-end — comment → tuple → consume → re-walk → flip → promote → diff, durable across restart, zero LLM on the hot path");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
