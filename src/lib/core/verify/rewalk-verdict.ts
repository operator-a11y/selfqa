/**
 * Re-walk verdict assignment (SPEC §7.3, §11.3) — PURE. Mirrors first-walk.ts's
 * reachability-dominates rule EXACTLY so the two entry points cannot drift.
 * Routes the deterministic flip; for needs-semantic, takes the batched semantic
 * verdict (M5-H) if provided.
 */
import type { Verdict } from "../domain/types";
import type { FlipResult } from "./flip";

export interface ReWalkVerdict {
  verdict: Verdict;
  resolved: boolean; // did this comment's assertion get satisfied this re-walk?
}

export function assignReWalkVerdict(args: {
  reached: boolean;
  buildSha?: string;
  flip: FlipResult;
  semantic?: { satisfied: boolean | null; confidence: "high" | "low" };
}): ReWalkVerdict {
  const base = { humanApproved: false, buildSha: args.buildSha };

  if (!args.reached) {
    return { verdict: { status: "ambiguous", ambiguousReason: "replay-failed", ...base }, resolved: false };
  }

  switch (args.flip.status) {
    case "could-not-evaluate":
      return { verdict: { status: "ambiguous", ambiguousReason: "replay-failed", ...base }, resolved: false };
    case "flipped":
      return { verdict: { status: "pass", ...base }, resolved: true };
    case "not-flipped":
      return { verdict: { status: "fail", ...base }, resolved: false };
    case "already-satisfied":
      return { verdict: { status: "ambiguous", ambiguousReason: "semantic-needs-human", ...base }, resolved: false };
    case "needs-semantic": {
      if (!args.semantic) {
        return { verdict: { status: "ambiguous", ambiguousReason: "semantic-needs-human", ...base }, resolved: false };
      }
      if (args.semantic.confidence === "low" || args.semantic.satisfied === null) {
        return { verdict: { status: "ambiguous", ambiguousReason: "semantic-low-confidence", ...base }, resolved: false };
      }
      return args.semantic.satisfied
        ? { verdict: { status: "pass", ...base }, resolved: true }
        : { verdict: { status: "fail", ...base }, resolved: false };
    }
  }
}
