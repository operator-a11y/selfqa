/**
 * M6-B — the four dashboard metric events (SPEC §12).
 *
 * PURE: each constructor turns a GENUINE decision the system already made into a
 * MetricEvent. It does NOT touch the store — emission (store.recordMetric) happens
 * at the call site, off the hot path, "once at birth". Keeping construction pure
 * means a metric can never be fabricated: its value is computed from the real
 * assertion / recompile flag / bucket / attempt count, not asserted by hand.
 *
 * The four metrics (SPEC §12):
 *   1. det:semantic ratio — are comment assertions mostly deterministic? (target ≥80%)
 *   2. recompile rate     — how often did a re-walk recompile vs reuse the cache?
 *   3. everything-bucket  — how often did the diff fall to the safe "everything" bucket?
 *   4. attempts histogram — how many loop attempts did a comment take to resolve? (cap 3)
 */
import type { Assertion } from "../domain/types";
import type { MetricEvent } from "../persist/store";

export type MetricEventType =
  | "comment-assertion-compiled" // metric 1 — value: deterministic=1, semantic=0
  | "rewalk-mission-replay" // metric 2 — value: recompiled=1, reused=0
  | "rewalk-bucket-decided" // metric 3 — value: everything=1, local=0
  | "comment-loop-terminated"; // metric 4 — value: attempt count to termination

/** Metric 1 — born when a comment's typed assertion is compiled (SPEC §10.4). */
export function commentAssertionCompiled(
  appId: string,
  assertion: Assertion,
  buildSha?: string,
): MetricEvent {
  return {
    appId,
    type: "comment-assertion-compiled",
    value: assertion.type === "deterministic" ? 1 : 0,
    detail: assertion.type,
    buildSha,
  };
}

/** Metric 2 — born per re-walked mission, when the planner reused or recompiled. */
export function rewalkMissionReplay(
  appId: string,
  missionId: string,
  recompiled: boolean,
  buildSha?: string,
): MetricEvent {
  return {
    appId,
    type: "rewalk-mission-replay",
    value: recompiled ? 1 : 0,
    detail: missionId,
    buildSha,
  };
}

/** Metric 3 — born when the manifest classifies a diff (SPEC §8.3). */
export function rewalkBucketDecided(
  appId: string,
  bucket: "everything" | "local",
  buildSha?: string,
): MetricEvent {
  return {
    appId,
    type: "rewalk-bucket-decided",
    value: bucket === "everything" ? 1 : 0,
    detail: bucket,
    buildSha,
  };
}

/** Metric 4 — born when a comment-resolution loop terminates (SPEC §11.3). */
export function commentLoopTerminated(
  appId: string,
  attempts: number,
  resolved: boolean,
  buildSha?: string,
): MetricEvent {
  return {
    appId,
    type: "comment-loop-terminated",
    value: attempts,
    detail: resolved ? "resolved" : "needs-human",
    buildSha,
  };
}
