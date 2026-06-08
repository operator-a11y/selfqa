/**
 * Trace-anchor adapter (SPEC §10, P2).
 *
 * The ONLY comment-to-code path is selecting a coordinate in a deterministic
 * trace. This reads {url, domPath} OFF the stored trace at that coordinate — it
 * is never inferred — and feeds the EXISTING extractSpec/editApp signatures
 * ({comment, url, domPath}) via a clean adapter (not a fictional match).
 *
 * No provider import (safe under the hot-path rule).
 */
import type { MissionTrace } from "../domain/types";

export interface TraceCoordinate {
  url: string;
  domPath: string;
}

/** stepIndex present = step-anchored; absent = mission-level (terminal state). */
export function resolveTraceCoordinate(
  trace: MissionTrace,
  stepIndex?: number,
): TraceCoordinate {
  const step =
    typeof stepIndex === "number" ? trace.steps[stepIndex] : undefined;
  return {
    url: step?.url ?? trace.terminalUrl,
    domPath: step
      ? `mission:${trace.missionId} step:${step.index} (${step.actionKind})`
      : `mission:${trace.missionId}`,
  };
}
