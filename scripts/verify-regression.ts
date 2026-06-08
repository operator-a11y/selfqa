/**
 * M5-L — regression memory (SPEC §7.5, §11.4). Run: `npx tsx scripts/verify-regression.ts`.
 * FAST (pure replay + in-memory store; no browser, no LLM, no API key).
 *
 * Proves:
 *  1. The THIRD entry point of the ONE checker: a frozen deterministic test
 *     PASSES when the fix holds and FLIPS to fail (a caught REGRESSION) when the
 *     fix is undone — note it checks text-equals, which first-walk never
 *     auto-asserts, because these criteria are human-approved.
 *  2. The lifecycle is propose-then-human-approve: promote→active,
 *     propose→retirement-proposed (the test is NOT dropped), approve→retired.
 *  3. P1 — NO code path sets 'retired' except approveRetirement (grep).
 */
import { readFileSync } from "node:fs";
import type { Mission, Assertion, RegressionTest } from "../src/lib/core/domain/types";
import { replayFrozenCriteria, frozenStatus } from "../src/lib/core/regression/replay";
import { rebuildObservedState } from "../src/lib/core/verify/observed-serde";
import { InMemoryStore } from "../src/lib/core/persist/in-memory-store";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

const titleSel = "[data-testid=title]";
const editedCriterion: Assertion = {
  type: "deterministic",
  predicate: { kind: "text-equals", selector: titleSel, expected: "Edited" },
  nl: "title says Edited",
};
function obs(text: string) {
  return rebuildObservedState({ url: "/", consoleErrors: [], resolved: { [titleSel]: { present: true, visible: true, text } } });
}
function missionWith(criteria: Assertion[]): Mission {
  return { id: "m1", name: "M1", description: "m1", intendedSteps: [], acceptanceCriteria: criteria };
}

// ── 1. the third entry point: pass when the fix holds, fail when undone ─────────
const passReplay = replayFrozenCriteria({ criteria: [editedCriterion], observed: obs("Edited"), buildSha: "sha2" });
truthy("frozen replay PASSES when the fix holds (deterministic, zero LLM)", passReplay.verdict.status === "pass" && passReplay.kind === "deterministic" && passReplay.verdict.buildSha === "sha2");
const failReplay = replayFrozenCriteria({ criteria: [editedCriterion], observed: obs("Original"), buildSha: "sha3" });
truthy("REGRESSION caught: frozen test flips pass→fail when the fix is undone", failReplay.verdict.status === "fail");
truthy("frozen replay checks text-equals (off the first-walk whitelist, but human-approved)", failReplay.results[0]?.check.satisfied === false);
const unreached = replayFrozenCriteria({ criteria: [editedCriterion], observed: null });
truthy("frozen replay: unreachable -> ambiguous replay-failed", unreached.verdict.status === "ambiguous" && unreached.verdict.ambiguousReason === "replay-failed");

truthy("frozenStatus reachability-dominates: any false -> fail", frozenStatus([true, false, null]) === "fail");
truthy("frozenStatus: any null (no false) -> ambiguous", frozenStatus([true, null]) === "ambiguous");
truthy("frozenStatus: all true -> pass", frozenStatus([true, true]) === "pass");

const semReplay = replayFrozenCriteria({ criteria: [{ type: "semantic", nl: "looks nicer" }], observed: obs("x") });
truthy("semantic frozen test -> kind semantic, ambiguous needs-human (off-loop verdict)", semReplay.kind === "semantic" && semReplay.verdict.status === "ambiguous" && semReplay.verdict.ambiguousReason === "semantic-needs-human");

// ── 2. lifecycle: promote → active; propose (NOT dropped) → retirement-proposed; approve → retired ──
const store = new InMemoryStore();
const test: RegressionTest = { id: "m1", name: "M1", mission: missionWith([editedCriterion]), frozenAtSha: "sha2", frozenVerdict: "pass", kind: "deterministic", status: "active", createdAt: "t0" };
store.promoteRegressionTest("app", test);
truthy("promote -> active (frozen Mission, kind derived)", store.getRegressionTest("app", "m1")?.status === "active");
truthy("active filter lists it", store.listRegressionTests("app", { status: "active" }).length === 1);

store.proposeRetirement("app", "m1", "noisy on CI");
const proposed = store.getRegressionTest("app", "m1");
truthy("propose -> retirement-proposed, NOT dropped (P1)", proposed?.status === "retirement-proposed" && proposed?.retirementProposal?.reason === "noisy on CI" && store.listRegressionTests("app").length === 1);
truthy("a retirement-proposed test is no longer in the active set", store.listRegressionTests("app", { status: "active" }).length === 0);

store.approveRetirement("app", "m1");
truthy("approve -> retired (still on record; human-approved only)", store.getRegressionTest("app", "m1")?.status === "retired" && store.listRegressionTests("app").length === 1);

// ── 3. P1 grep: 'retired' is set ONLY by approveRetirement ───────────────────────
function onlySetInApprove(file: string): boolean {
  const src = readFileSync(file, "utf8");
  if (src.split('"retired"').length - 1 !== 1) return false; // exactly one literal
  const method = src.match(/approveRetirement\([\s\S]*?\n {2}\}/);
  return !!method && method[0].includes('"retired"');
}
truthy("in-memory store: 'retired' set ONLY in approveRetirement", onlySetInApprove("src/lib/core/persist/in-memory-store.ts"));
truthy("sqlite store: 'retired' set ONLY in approveRetirement", onlySetInApprove("src/lib/core/persist/sqlite-store.ts"));
truthy("worker never assigns 'retired' directly (delegates to store.approveRetirement)", readFileSync("worker/index.ts", "utf8").split('"retired"').length - 1 === 0);

if (failures) {
  console.error("\n" + failures + " regression-memory check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: M5-L regression memory — frozen replay catches re-breaks; propose-then-approve, no auto-drop");
