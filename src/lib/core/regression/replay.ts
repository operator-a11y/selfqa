/**
 * Regression replay (SPEC §6.2, §7.5, §11.4) — the THIRD entry point of the ONE
 * deterministic checker. First-walk (M4-B) and re-walk (M5-I) are the other two;
 * this replays a FROZEN, human-approved test's criteria on a later build and is
 * how regression MEMORY catches a re-break: a test that was pass flips to fail.
 *
 * PURE: `checkAssertion` only — ZERO LLM for deterministic criteria. Semantic
 * criteria reuse the SAME batched off-loop verdict as re-walk (never a fork); a
 * pending semantic criterion leaves the replay ambiguous until that verdict lands.
 *
 * The live re-walk already runs `checkAssertion` over every mission's criteria
 * (run.ts `missionRunFromWalked` → `criteriaResults`), so the worker's regression
 * gate replays through THAT result via `frozenStatus` — there is no second walker.
 */
import type { Assertion, Verdict, VerdictStatus, RegressionKind } from "../domain/types";
import { checkAssertion, type ObservedState, type CheckResult } from "../verify/checker";
import { deriveRegressionKind } from "./gate";

/** Reachability-dominates verdict from per-criterion check outcomes (true|false|null). */
export function frozenStatus(checks: (boolean | null)[]): VerdictStatus {
  let anyFalse = false;
  let anyNull = false;
  for (const c of checks) {
    if (c === false) anyFalse = true;
    else if (c === null) anyNull = true;
  }
  if (anyFalse) return "fail"; // a mechanically-failed criterion dominates
  if (anyNull) return "ambiguous"; // pending semantic / could-not-evaluate
  return "pass";
}

export interface FrozenReplay {
  verdict: Verdict;
  kind: RegressionKind; // DERIVED from the criteria, never declared
  results: { criterionIndex: number; check: CheckResult }[];
}

/**
 * Replay a frozen test's criteria against an observed state (null = unreachable).
 * Deterministic criteria → checkAssertion (zero LLM). The verdict mirrors the
 * first-walk/re-walk rule exactly so the three entry points cannot drift.
 */
export function replayFrozenCriteria(args: {
  criteria: Assertion[];
  observed: ObservedState | null;
  buildSha?: string;
}): FrozenReplay {
  const kind = deriveRegressionKind(args.criteria);
  const base = { humanApproved: false, buildSha: args.buildSha };
  if (!args.observed) {
    return {
      verdict: { status: "ambiguous", ambiguousReason: "replay-failed", ...base },
      kind,
      results: [],
    };
  }
  const results = args.criteria.map((c, i) => ({ criterionIndex: i, check: checkAssertion(c, args.observed!) }));
  const status = frozenStatus(results.map((r) => r.check.satisfied));
  const verdict: Verdict =
    status === "ambiguous"
      ? { status, ambiguousReason: kind === "semantic" ? "semantic-needs-human" : "replay-failed", ...base }
      : { status, ...base };
  return { verdict, kind, results };
}
