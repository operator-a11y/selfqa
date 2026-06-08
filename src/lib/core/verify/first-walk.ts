/**
 * First-walk verdict assignment (SPEC §7.2, §7.3, §4 / P1).
 *
 * A PURE function — no LLM, no confidence parameter. The agent proposes the most
 * honest verdict it can and NEVER guesses on taste:
 *
 *   1. Reachability DOMINATES: a state never reached (or with a deciding criterion
 *      that could-not-evaluate) -> ambiguous:replay-failed. Beats the semantic
 *      floor — you cannot judge taste on a state you never reached.
 *   2. A whitelisted (machine-verifiable) criterion that is FALSE -> fail.
 *   3. Anything taste-requiring (semantic, or off-whitelist incl. text-equals)
 *      -> ambiguous:semantic-needs-human.
 *   4. Every criterion whitelisted AND machine-verified true -> pass (green means
 *      machine-verified, full stop).
 *
 * A verdict is provisional until a human approves it (SPEC §7.5).
 */
import type { Mission, Verdict } from "../domain/types";
import type { ObservedState } from "./checker";
import { checkAssertion, isFirstWalkAutoAssertable } from "./checker";

export function assignFirstWalkVerdict(
  mission: Mission,
  observed: ObservedState,
  opts: { reached: boolean; buildSha?: string },
): Verdict {
  const base = { humanApproved: false, buildSha: opts.buildSha };

  // 1a. Unreached -> replay-failed (nothing is evaluable).
  if (!opts.reached) {
    return { status: "ambiguous", ambiguousReason: "replay-failed", ...base };
  }

  const results = mission.acceptanceCriteria.map((c) => ({
    auto: isFirstWalkAutoAssertable(c),
    check: checkAssertion(c, observed),
  }));

  // 1b. could-not-evaluate on a deciding (whitelisted) criterion -> replay-failed
  //     (reachability/evaluability dominates the semantic floor).
  const couldNotEvaluate = results.some(
    (r) =>
      r.auto &&
      r.check.satisfied === null &&
      r.check.detail.includes("could-not-evaluate"),
  );
  if (couldNotEvaluate) {
    return { status: "ambiguous", ambiguousReason: "replay-failed", ...base };
  }

  // 2. A machine-verified whitelisted criterion that is FALSE -> certain fail.
  if (results.some((r) => r.auto && r.check.satisfied === false)) {
    return { status: "fail", ...base };
  }

  // 3. Anything taste-requiring (semantic, or off-whitelist) -> refuse to guess (P1).
  if (results.some((r) => !r.auto)) {
    return { status: "ambiguous", ambiguousReason: "semantic-needs-human", ...base };
  }

  // 4. Every criterion whitelisted AND machine-verified true -> green.
  return { status: "pass", ...base };
}
