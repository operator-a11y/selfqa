/**
 * M4-B — first-walk verdict assignment (pure; no LLM, no browser).
 * Run: `npx tsx scripts/verify-first-walk.ts`.
 */
import { assignFirstWalkVerdict } from "../src/lib/core/verify/first-walk";
import type { Mission, Assertion } from "../src/lib/core/domain/types";
import type { ObservedState } from "../src/lib/core/verify/checker";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) console.log("ok   " + name + " = " + JSON.stringify(actual));
  else {
    failures++;
    console.error("FAIL " + name + ": got " + JSON.stringify(actual) + " expected " + JSON.stringify(expected));
  }
}

function mission(criteria: Assertion[]): Mission {
  return {
    id: "mission-x",
    name: "x",
    description: "d",
    intendedSteps: ["s"],
    acceptanceCriteria: criteria,
  };
}
function state(o: { httpStatus?: number; consoleErrors?: string[]; url?: string } = {}): ObservedState {
  return {
    url: o.url ?? "http://x/",
    httpStatus: o.httpStatus,
    consoleErrors: o.consoleErrors ?? [],
    q: () => ({ present: false, visible: false, text: "" }),
  };
}

const consoleAbsent: Assertion = { type: "deterministic", predicate: { kind: "console-error-absent" }, nl: "no console errors" };
const httpOk: Assertion = { type: "deterministic", predicate: { kind: "http-status", expected: 200 }, nl: "200" };
const semantic: Assertion = { type: "semantic", nl: "looks right" };
const textEquals: Assertion = { type: "deterministic", predicate: { kind: "text-equals", selector: "[data-testid=title]", expected: "Todo" }, nl: "title" };

// pass: all whitelisted + true
eq("all whitelisted+true -> pass", assignFirstWalkVerdict(mission([consoleAbsent]), state({ consoleErrors: [] }), { reached: true }).status, "pass");

// fail: a whitelisted criterion is false
eq("whitelisted false -> fail", assignFirstWalkVerdict(mission([consoleAbsent]), state({ consoleErrors: ["boom"] }), { reached: true }).status, "fail");

// semantic -> needs-human
const semV = assignFirstWalkVerdict(mission([semantic]), state(), { reached: true });
eq("semantic -> ambiguous", semV.status, "ambiguous");
eq("semantic -> semantic-needs-human", semV.ambiguousReason, "semantic-needs-human");

// text-equals is off-whitelist -> needs-human (not auto-asserted)
eq("text-equals -> semantic-needs-human", assignFirstWalkVerdict(mission([textEquals]), state(), { reached: true }).ambiguousReason, "semantic-needs-human");

// could-not-evaluate (http-status with no httpStatus) -> replay-failed
eq("could-not-evaluate -> replay-failed", assignFirstWalkVerdict(mission([httpOk]), state({ httpStatus: undefined }), { reached: true }).ambiguousReason, "replay-failed");

// !reached -> replay-failed
eq("!reached -> replay-failed", assignFirstWalkVerdict(mission([consoleAbsent]), state(), { reached: false }).ambiguousReason, "replay-failed");

// BOTH-HOLD: !reached AND a semantic criterion -> replay-failed (reachability dominates)
eq("both-hold (!reached + semantic) -> replay-failed", assignFirstWalkVerdict(mission([semantic]), state(), { reached: false }).ambiguousReason, "replay-failed");

// fail beats needs-human: a whitelisted false + a semantic -> fail
eq("whitelisted-false + semantic -> fail", assignFirstWalkVerdict(mission([consoleAbsent, semantic]), state({ consoleErrors: ["boom"] }), { reached: true }).status, "fail");

// whitelisted pass + semantic -> needs-human
eq("whitelisted-pass + semantic -> ambiguous(needs-human)", assignFirstWalkVerdict(mission([consoleAbsent, semantic]), state({ consoleErrors: [] }), { reached: true }).ambiguousReason, "semantic-needs-human");

// no confidence parameter (P1): the signature is (mission, observed, opts) only
eq("no confidence parameter (arity 3)", assignFirstWalkVerdict.length, 3);

if (failures) {
  console.error("\n" + failures + " first-walk check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: first-walk verdict green (pure, no LLM)");
