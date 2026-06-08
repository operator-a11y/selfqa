/**
 * M5-G — flip comparator + re-walk verdict (pure; no LLM, no browser).
 * Run: `npx tsx scripts/verify-flip.ts`.
 */
import { readFileSync } from "node:fs";
import { evaluateFlip } from "../src/lib/core/verify/flip";
import { assignReWalkVerdict } from "../src/lib/core/verify/rewalk-verdict";
import type { Assertion } from "../src/lib/core/domain/types";
import type { ObservedState } from "../src/lib/core/verify/checker";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

function stateWithTitle(text: string | null): ObservedState {
  return {
    url: "http://x/",
    consoleErrors: [],
    q: (s) =>
      s === "[data-testid=title]"
        ? text === null
          ? null
          : { present: true, visible: true, text }
        : { present: false, visible: false, text: "" },
  };
}
const titleEq: Assertion = { type: "deterministic", predicate: { kind: "text-equals", selector: "[data-testid=title]", expected: "EDITED" }, nl: "title==EDITED" };
const sem: Assertion = { type: "semantic", nl: "looks better" };

// flipped fail->pass (the headline mechanism)
const f1 = evaluateFlip(titleEq, stateWithTitle("Todo"), stateWithTitle("EDITED"));
truthy("false->true => flipped", f1.status === "flipped");
const v1 = assignReWalkVerdict({ reached: true, flip: f1 });
truthy("flipped -> pass + resolved", v1.verdict.status === "pass" && v1.resolved);

// not-flipped
const f2 = evaluateFlip(titleEq, stateWithTitle("Todo"), stateWithTitle("Todo"));
truthy("false->false => not-flipped", f2.status === "not-flipped");
const v2 = assignReWalkVerdict({ reached: true, flip: f2 });
truthy("not-flipped -> fail + unresolved", v2.verdict.status === "fail" && !v2.resolved);

// already-satisfied -> needs-human
const f3 = evaluateFlip(titleEq, stateWithTitle("EDITED"), stateWithTitle("EDITED"));
truthy("true-before => already-satisfied", f3.status === "already-satisfied");
truthy("already-satisfied -> semantic-needs-human", assignReWalkVerdict({ reached: true, flip: f3 }).verdict.ambiguousReason === "semantic-needs-human");

// could-not-evaluate -> replay-failed
const f4 = evaluateFlip(titleEq, stateWithTitle("Todo"), stateWithTitle(null));
truthy("after null => could-not-evaluate", f4.status === "could-not-evaluate");
truthy("could-not-evaluate -> replay-failed", assignReWalkVerdict({ reached: true, flip: f4 }).verdict.ambiguousReason === "replay-failed");

// semantic path
const f5 = evaluateFlip(sem, stateWithTitle("Todo"), stateWithTitle("EDITED"));
truthy("semantic assertion => needs-semantic", f5.status === "needs-semantic");
truthy("needs-semantic, no verdict -> needs-human", assignReWalkVerdict({ reached: true, flip: f5 }).verdict.ambiguousReason === "semantic-needs-human");
truthy("needs-semantic + high/true -> pass", assignReWalkVerdict({ reached: true, flip: f5, semantic: { satisfied: true, confidence: "high" } }).verdict.status === "pass");
truthy("needs-semantic + low -> semantic-low-confidence", assignReWalkVerdict({ reached: true, flip: f5, semantic: { satisfied: true, confidence: "low" } }).verdict.ambiguousReason === "semantic-low-confidence");

// reachability dominates
truthy("!reached -> replay-failed", assignReWalkVerdict({ reached: false, flip: f1 }).verdict.ambiguousReason === "replay-failed");

// single-checker contract (no deterministic fork)
const flipSrc = readFileSync("src/lib/core/verify/flip.ts", "utf8");
truthy("flip.ts uses the ONE checker (checkAssertion from ./checker)", flipSrc.includes("checkAssertion") && flipSrc.includes('from "./checker"'));

if (failures) {
  console.error("\n" + failures + " flip check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: M5-G flip comparator + re-walk verdict green");
