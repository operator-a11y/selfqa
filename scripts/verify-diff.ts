/**
 * M5-L — run-to-run diff (SPEC §11.1). Run: `npx tsx scripts/verify-diff.ts`.
 * FAST (pure: no browser, no LLM, no store).
 *
 * The diff is a DERIVED query over two RunRecords, matched by STABLE mission id.
 * Proves every transition bucket + the counts, and the null-prev (first run) case.
 */
import type { RunRecord, MissionRun, Mission, VerdictStatus } from "../src/lib/core/domain/types";
import { computeRunDiff, idsOfKind } from "../src/lib/core/regression/diff";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

function mission(id: string): Mission {
  return { id, name: id, description: id, intendedSteps: [], acceptanceCriteria: [] };
}
function mr(id: string, status: VerdictStatus): MissionRun {
  return {
    mission: mission(id),
    verdict: { status, humanApproved: false, buildSha: "sha" },
    trace: { missionId: id, reached: true, attempts: 1, entryRoute: "/", steps: [], terminalUrl: "/", consoleErrors: [] },
  };
}
function run(buildSha: string, ms: MissionRun[]): RunRecord {
  return { appId: "app", buildSha, missions: ms };
}

// prev → curr covering EVERY transition:
//   newly-pass  : m-pass     fail      -> pass
//   newly-fail  : m-fail     pass      -> fail
//   changed     : m-chg      fail      -> ambiguous (status change, neither pass nor pass→fail)
//   unchanged   : m-same     pass      -> pass
//   new-surface : m-new      (absent)  -> pass
//   retired     : m-gone     ambiguous -> (absent)
const prev = run("shaPrev", [
  mr("m-pass", "fail"),
  mr("m-fail", "pass"),
  mr("m-chg", "fail"),
  mr("m-same", "pass"),
  mr("m-gone", "ambiguous"),
]);
const curr = run("shaCurr", [
  mr("m-pass", "pass"),
  mr("m-fail", "fail"),
  mr("m-chg", "ambiguous"),
  mr("m-same", "pass"),
  mr("m-new", "pass"),
]);

const diff = computeRunDiff(prev, curr);

truthy("fromSha = prev build, toSha = curr build", diff.fromSha === "shaPrev" && diff.toSha === "shaCurr");
truthy("newly-pass: m-pass (fail→pass)", idsOfKind(diff, "newly-pass").join() === "m-pass");
truthy("newly-fail: m-fail (pass→fail)", idsOfKind(diff, "newly-fail").join() === "m-fail");
truthy("changed-outcome: m-chg (fail→ambiguous)", idsOfKind(diff, "changed-outcome").join() === "m-chg");
truthy("unchanged: m-same (pass→pass)", idsOfKind(diff, "unchanged").join() === "m-same");
truthy("new-surface: m-new (∅→pass)", idsOfKind(diff, "new-surface").join() === "m-new");
truthy("retired-surface: m-gone (ambiguous→∅)", idsOfKind(diff, "retired-surface").join() === "m-gone");

truthy(
  "counts tally exactly one per bucket",
  diff.counts.newlyPass === 1 &&
    diff.counts.newlyFail === 1 &&
    diff.counts.changedOutcome === 1 &&
    diff.counts.unchanged === 1 &&
    diff.counts.newSurface === 1 &&
    diff.counts.retiredSurface === 1,
);

const retired = diff.entries.find((e) => e.missionId === "m-gone");
truthy("retired entry has from set, to null", retired?.from === "ambiguous" && retired?.to === null);
const surfaced = diff.entries.find((e) => e.missionId === "m-new");
truthy("new-surface entry has from null, to set", surfaced?.from === null && surfaced?.to === "pass");

// null prev (the very first run): everything is a new surface.
const first = computeRunDiff(null, curr);
truthy("null prev → fromSha null, all new-surface", first.fromSha === null && first.counts.newSurface === curr.missions.length && first.counts.unchanged === 0);

if (failures) {
  console.error("\n" + failures + " diff check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: M5-L run-to-run diff — every transition + counts, stable-id matched, pure");
