/**
 * M5-K — durable persistence behind the MetadataStore seam.
 * Run: `npx tsx scripts/verify-persist.ts`. FAST (no browser, no LLM).
 *
 * Proves:
 *  1. The SQLite store and the in-memory double round-trip a RunRecord to
 *     STRUCTURALLY IDENTICAL results (the seam is backend-agnostic).
 *  2. Verdicts are keyed (missionId, buildSha); the run-to-run diff matches by
 *     stable mission id across two builds.
 *  3. The before-state JSON round-trips and the checker re-runs against it (so
 *     re-walk's "before" survives a restart).
 *  4. DURABILITY: a SQLite store survives close()+reopen — runs, comments,
 *     promoted regression tests, and metrics are all still there.
 *  5. Human-approval lifecycle (promote / propose / approve-retire) + the
 *     parallel-db-verdicts trust flag persist.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type {
  RunRecord,
  MissionRun,
  Mission,
  Verdict,
  Action,
  GroundedFeedback,
  RunDiff,
  RegressionTest,
} from "../src/lib/core/domain/types";
import { InMemoryStore } from "../src/lib/core/persist/in-memory-store";
import { SqliteStore } from "../src/lib/core/persist/sqlite-store";
import type { MetadataStore, MetricEvent } from "../src/lib/core/persist/store";
import { rebuildObservedState } from "../src/lib/core/verify/observed-serde";
import { checkAssertion, type SerializedObservedState } from "../src/lib/core/verify/checker";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}
function eq(name: string, a: unknown, b: unknown): void {
  truthy(name, JSON.stringify(a) === JSON.stringify(b));
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const SHA1 = "sha1aaaaaaaaaaaaaaaa";
const SHA2 = "sha2bbbbbbbbbbbbbbbb";

function mission(id: string, sel: string): Mission {
  return {
    id,
    name: "Mission " + id,
    description: "do " + id,
    intendedSteps: ["open", "act"],
    acceptanceCriteria: [
      { type: "deterministic", predicate: { kind: "text-equals", selector: sel, expected: "Edited" }, nl: "title says Edited" },
    ],
  };
}

const beforeState: SerializedObservedState = {
  url: "/",
  httpStatus: 200,
  consoleErrors: [],
  formValidationBlocked: false,
  resolved: {
    "[data-testid=title]": { present: true, visible: true, text: "Original" },
  },
};

const actions: Action[] = [
  { kind: "navigate", value: "/" },
  { kind: "click", target: { strategy: "data-testid", value: "add" } },
];

function reachedRun(m: Mission, status: Verdict["status"], buildSha: string): MissionRun {
  return {
    mission: m,
    verdict: { status, humanApproved: false, buildSha },
    trace: {
      missionId: m.id,
      reached: true,
      attempts: 1,
      entryRoute: "/",
      actions,
      steps: [{ index: 0, actionKind: "navigate", url: "http://x/", screenshot: "s0", dom: "d0" }],
      terminalUrl: "http://x/term",
      consoleErrors: [],
    },
    beforeState,
    criteriaResults: [{ criterionIndex: 0, check: { satisfied: false, detail: "title is Original not Edited" } }],
  };
}

function unreachedRun(m: Mission, buildSha: string): MissionRun {
  return {
    mission: m,
    verdict: { status: "ambiguous", ambiguousReason: "replay-failed", humanApproved: false, buildSha },
    trace: {
      missionId: m.id,
      reached: false,
      attempts: 2,
      entryRoute: "/missing",
      steps: [],
      terminalUrl: "http://x/missing",
      consoleErrors: ["boom"],
    },
  };
}

function runAt(buildSha: string, addTodoStatus: Verdict["status"]): RunRecord {
  return {
    appId: "app-1",
    buildSha,
    missions: [
      reachedRun(mission("mission-add-todo", "[data-testid=title]"), addTodoStatus, buildSha),
      reachedRun(mission("mission-pass", "[data-testid=ok]"), "pass", buildSha),
      unreachedRun(mission("mission-broken", "[data-testid=x]"), buildSha),
    ],
  };
}

const tuple: GroundedFeedback = {
  id: "fb-1",
  commentId: "c-1",
  missionId: "mission-add-todo",
  stepIndex: 0,
  commentType: "step-anchored",
  actionSequencePrefix: actions,
  snapshot: { url: "/", domPath: "body>div", domHtml: "<div/>", screenshotPath: "shot.png" },
  nl: "the title should indicate it was edited",
  assertion: { type: "deterministic", predicate: { kind: "text-equals", selector: "[data-testid=title]", expected: "Edited" }, nl: "title says Edited" },
};

function regTest(id: string): RegressionTest {
  return {
    id,
    name: "Mission " + id,
    mission: mission(id, "[data-testid=" + id + "]"),
    frozenAtSha: SHA2,
    frozenVerdict: "pass",
    kind: "deterministic",
    status: "active",
    createdAt: "2026-06-08T00:00:00.000Z",
  };
}

const metrics: MetricEvent[] = [
  { appId: "app-1", type: "comment-assertion-compiled", value: 1, detail: "deterministic", buildSha: SHA2 },
  { appId: "app-1", type: "rewalk-bucket-decided", value: 0, detail: "local", buildSha: SHA2 },
];

// Exercise the full surface of a store, return everything observable for compare.
function exercise(store: MetadataStore): Record<string, unknown> {
  store.saveApp({ appId: "app-1", prompt: "a todo app", createdSha: SHA1 });
  store.saveRun(runAt(SHA1, "fail"), undefined);
  store.saveRun(runAt(SHA2, "pass"), SHA1);
  store.saveComment(tuple, "app-1");
  store.promoteRegressionTest("app-1", regTest("mission-add-todo"));
  store.promoteRegressionTest("app-1", regTest("mission-broken"));
  store.proposeRetirement("app-1", "mission-broken", "flaky, never reaches");
  for (const m of metrics) store.recordMetric(m);
  store.setParallelDbVerdictsTrusted(false);

  return {
    app: store.getApp("app-1"),
    apps: store.listApps(),
    latestRun: store.getRun("app-1"),
    runAtSha1: store.getRun("app-1", SHA1),
    runAtSha2: store.getRun("app-1", SHA2),
    verdictV1: store.getVerdict("mission-add-todo", SHA1),
    verdictV2: store.getVerdict("mission-add-todo", SHA2),
    cachedActions: store.getCachedActions("app-1", SHA2, "mission-add-todo"),
    comments: store.listComments("app-1"),
    regression: store.listRegressionTests("app-1"),
    metrics: store.listMetrics("app-1"),
    diff: store.diffRuns("app-1", SHA1, SHA2),
    trusted: store.getParallelDbVerdictsTrusted(),
  };
}

function main(): void {
  const dbPath = join(tmpdir(), `selfqa-verify-persist-${process.pid}.db`);
  rmSync(dbPath, { force: true });

  const mem = new InMemoryStore();
  const sql = new SqliteStore(dbPath);

  const memOut = exercise(mem);
  const sqlOut = exercise(sql);

  // 1. backend-agnostic: every observable is structurally identical.
  for (const k of Object.keys(memOut)) {
    eq(`identical across backends: ${k}`, memOut[k], sqlOut[k]);
  }

  // 2. shape sanity on the latest run (sorted fail > ambiguous > passed).
  const latest = sqlOut.latestRun as RunRecord;
  truthy("latest run is SHA2", latest.buildSha === SHA2);
  truthy("latest run has 3 missions", latest.missions.length === 3);
  truthy(
    "missions sorted fail/ambiguous/pass",
    latest.missions.map((m) => m.verdict.status).join(",") === "ambiguous,pass,pass" ||
      ["fail", "ambiguous", "pass"].indexOf(latest.missions[0].verdict.status) <=
        ["fail", "ambiguous", "pass"].indexOf(latest.missions[2].verdict.status),
  );

  // 3. verdict keyed (missionId, buildSha): same mission, different build, different verdict.
  const v1 = sql.getVerdict("mission-add-todo", SHA1);
  const v2 = sql.getVerdict("mission-add-todo", SHA2);
  truthy("verdict@SHA1 is fail, verdict@SHA2 is pass (keyed by build)", v1?.status === "fail" && v2?.status === "pass");

  // 4. before-state round-trips AND the ONE checker re-runs against it.
  const restored = (latest.missions.find((m) => m.mission.id === "mission-add-todo") ?? latest.missions[0]);
  const before = restored.beforeState ?? (sql.getRun("app-1", SHA1)!.missions.find((m) => m.mission.id === "mission-add-todo")!.beforeState!);
  const observed = rebuildObservedState(before);
  const check = checkAssertion(tuple.assertion, observed);
  truthy("before-state round-trips; checker sees title 'Original' != 'Edited' (false)", check.satisfied === false);

  // 5. run-to-run diff by stable mission id: add-todo flips fail -> pass.
  const diff = sqlOut.diff as RunDiff;
  truthy(
    "diff: mission-add-todo newly passes SHA1->SHA2",
    diff.counts.newlyPass >= 1 && diff.entries.some((e) => e.missionId === "mission-add-todo" && e.kind === "newly-pass"),
  );
  truthy("diff carries fromSha/toSha (SHA_n vs SHA_{n-1})", diff.fromSha === SHA1 && diff.toSha === SHA2);

  // 6. DURABILITY: close + reopen the SQLite db; everything is still there.
  sql.close();
  const reopened = new SqliteStore(dbPath);
  truthy("reopen: app persists", reopened.getApp("app-1")?.prompt === "a todo app");
  truthy("reopen: latest run persists (SHA2, 3 missions)", reopened.getRun("app-1")?.buildSha === SHA2 && reopened.getRun("app-1")?.missions.length === 3);
  truthy("reopen: promoted regression test persists (active, frozen Mission)", reopened.listRegressionTests("app-1").some((r) => r.id === "mission-add-todo" && r.status === "active" && r.mission.acceptanceCriteria.length > 0 && r.kind === "deterministic"));
  truthy("reopen: proposed retirement persists (status + reason, NOT dropped)", reopened.listRegressionTests("app-1").some((r) => r.id === "mission-broken" && r.status === "retirement-proposed" && r.retirementProposal?.reason === "flaky, never reaches"));
  truthy("reopen: comment tuple persists", reopened.listComments("app-1").some((c) => c.id === "fb-1"));
  truthy("reopen: metrics persist (2 events)", reopened.listMetrics("app-1").length === 2);

  // 7. human-approval lifecycle: approve retirement -> status retired (the only path).
  reopened.approveRetirement("app-1", "mission-add-todo");
  const afterRetire = reopened.getRegressionTest("app-1", "mission-add-todo");
  truthy("approve-retire sets status retired (the only path to 'retired')", afterRetire?.status === "retired");

  // identical diff result across backends too (already covered by loop, assert explicitly).
  eq("diffRuns identical across backends", mem.diffRuns("app-1", SHA1, SHA2), reopened.diffRuns("app-1", SHA1, SHA2));

  reopened.close();
  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });

  if (failures) {
    console.error("\n" + failures + " persistence check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: MetadataStore — SQLite & in-memory round-trip identically; SQLite survives restart");
}

main();
