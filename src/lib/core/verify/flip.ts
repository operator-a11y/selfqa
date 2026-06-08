/**
 * Flip comparator (SPEC §3, §6.2) — the load-bearing close-the-loop step.
 *
 * PURE: zero LLM, zero Playwright. Calls checkAssertion TWICE (before & after) —
 * NEVER a new predicate engine. "flipped" = the assertion was NOT true before and
 * IS true after; direction lives entirely in the assertion's polarity. before/after
 * are ObservedState produced by rebuildObservedState (M5-A) / reconstructBefore
 * (M5-I), so any selector the comment names is evaluable, not only criteria ones.
 */
import type { Assertion } from "../domain/types";
import { checkAssertion, type CheckResult, type ObservedState } from "./checker";

export type FlipStatus =
  | "flipped"
  | "not-flipped"
  | "already-satisfied"
  | "needs-semantic"
  | "could-not-evaluate";

export interface FlipResult {
  status: FlipStatus;
  detail: string;
  before: CheckResult | null;
  after: CheckResult | null;
}

export function evaluateFlip(
  assertion: Assertion,
  before: ObservedState,
  after: ObservedState,
): FlipResult {
  if (assertion.type === "semantic") {
    return { status: "needs-semantic", detail: "semantic assertion", before: null, after: null };
  }
  const b = checkAssertion(assertion, before);
  const a = checkAssertion(assertion, after);

  // Reachability/evaluability dominates: if either side could-not-evaluate, no flip.
  if (a.satisfied === null) return { status: "could-not-evaluate", detail: "after: " + a.detail, before: b, after: a };
  if (b.satisfied === null) return { status: "could-not-evaluate", detail: "before: " + b.detail, before: b, after: a };

  // Already true at comment time -> suspicious (the grounded-looking-but-wrong tuple, P2).
  if (b.satisfied === true) return { status: "already-satisfied", detail: "true before the edit", before: b, after: a };

  // before is false here:
  if (a.satisfied === true) return { status: "flipped", detail: "false -> true", before: b, after: a };
  return { status: "not-flipped", detail: "still false after the edit", before: b, after: a };
}
