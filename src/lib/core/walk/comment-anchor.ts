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
import { promises as fs } from "node:fs";
import type { Action, MissionTrace, TupleSnapshot } from "../domain/types";

export interface TraceCoordinate {
  url: string;
  domPath: string;
}

export type TuplePrefixResult =
  | { actionSequencePrefix: Action[]; snapshot: TupleSnapshot }
  | { unresolved: "empty-trace" | "step-out-of-range" | "missing-artifact" };

/**
 * Read the tuple's action-sequence prefix + captured-DOM snapshot OFF the trace
 * at a coordinate (P2 — never inferred, never fabricated). stepIndex present =
 * step-anchored (prefix = steps 0..idx); absent = mission-level (terminal step).
 * Three guards return an explicit `unresolved` reason rather than a fake tuple.
 */
export async function resolveTuplePrefix(
  trace: MissionTrace,
  stepIndex?: number,
): Promise<TuplePrefixResult> {
  if (trace.steps.length === 0) return { unresolved: "empty-trace" };

  let idx: number;
  if (typeof stepIndex === "number") {
    if (stepIndex < 0 || stepIndex > trace.steps.length - 1) {
      return { unresolved: "step-out-of-range" };
    }
    idx = stepIndex;
  } else {
    idx = trace.steps.length - 1; // mission-level -> terminal step (§10.2)
  }

  const prefix = trace.steps
    .slice(0, idx + 1)
    .map((s) => s.action)
    .filter((a): a is Action => !!a);

  const step = trace.steps[idx];
  // ARTIFACTS_ROOT is ephemeral; the DOM may have been GC'd — guard, never substitute.
  try {
    await fs.access(step.dom);
    await fs.access(step.screenshot);
  } catch {
    return { unresolved: "missing-artifact" };
  }
  const domHtml = await fs.readFile(step.dom, "utf8");

  return {
    actionSequencePrefix: prefix,
    snapshot: {
      url: step.url,
      domPath: step.dom,
      domHtml,
      screenshotPath: step.screenshot,
    },
  };
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
