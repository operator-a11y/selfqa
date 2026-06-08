/**
 * Fix-induced regression gate (SPEC §11.4) — PURE. Routes ALREADY-COMPUTED flips
 * of active frozen regression tests by their (mechanically derived) kind. Makes
 * ZERO judgments of its own:
 *   - deterministic frozen test that WAS pass and flipped to fail -> hard-block
 *     (mechanically certain; enforce past human judgment, relationship #2);
 *   - semantic frozen test that flipped -> surface (newly-failing, relationship #3).
 */
import type { Assertion, RegressionKind } from "../domain/types";

export type { RegressionKind };

export interface FrozenResult {
  testId: string;
  kind: RegressionKind;
  wasPass: boolean;
  flippedToFail: boolean;
}
export interface GateResult {
  blocked: boolean;
  hardBlocks: string[];
  surfaced: string[];
}

/** A regression test is deterministic iff EVERY frozen criterion is deterministic. */
export function deriveRegressionKind(criteria: Assertion[]): RegressionKind {
  return criteria.length > 0 && criteria.every((c) => c.type === "deterministic")
    ? "deterministic"
    : "semantic";
}

export function evaluateRegressionGate(activeFrozenResults: FrozenResult[]): GateResult {
  const hardBlocks: string[] = [];
  const surfaced: string[] = [];
  for (const r of activeFrozenResults) {
    if (!(r.wasPass && r.flippedToFail)) continue;
    if (r.kind === "deterministic") hardBlocks.push(r.testId);
    else surfaced.push(r.testId);
  }
  return { blocked: hardBlocks.length > 0, hardBlocks, surfaced };
}
