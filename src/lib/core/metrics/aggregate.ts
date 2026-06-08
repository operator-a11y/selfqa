/**
 * M6-B — dashboard aggregations (SPEC §12). PURE: reduces a list of MetricEvents
 * to the four headline numbers. A DERIVED query over the durable metric_event log,
 * never a stored second source of truth (mirrors the run-to-run diff's discipline).
 */
import type { MetricEvent } from "../persist/store";
import type { MetricEventType } from "./events";

/** SPEC §12 — deterministic assertions should dominate (the novelty is grounded,
 *  replayable, deterministic feedback; semantic is the fallback, not the norm). */
export const DET_SEMANTIC_TARGET = 0.8;
/** SPEC §11.3 — the mechanical convergence cap the attempts histogram is read against. */
export const ATTEMPTS_CAP = 3;

export interface DetSemantic {
  deterministic: number;
  semantic: number;
  ratio: number; // deterministic / (deterministic + semantic); 0 when no data
  meetsTarget: boolean; // ratio ≥ target (vacuously true with no data)
}
export interface Recompile {
  recompiled: number;
  reused: number;
  rate: number; // recompiled / total; 0 when no data
}
export interface BucketSplit {
  everything: number;
  local: number;
  everythingFraction: number; // everything / total; 0 when no data
}
export interface Attempts {
  histogram: Record<number, number>; // attempts -> count of comments that took that many
  cap: number;
  total: number; // comments that terminated
  resolved: number; // of those, how many resolved (vs needs-human)
}

export interface DashboardMetrics {
  detSemantic: DetSemantic;
  recompile: Recompile;
  bucket: BucketSplit;
  attempts: Attempts;
  totalEvents: number;
}

function ofType(events: MetricEvent[], t: MetricEventType): MetricEvent[] {
  return events.filter((e) => e.type === t);
}

export function detSemanticRatio(events: MetricEvent[]): DetSemantic {
  const c = ofType(events, "comment-assertion-compiled");
  const deterministic = c.filter((e) => e.value === 1).length;
  const semantic = c.length - deterministic;
  const ratio = c.length ? deterministic / c.length : 0;
  return { deterministic, semantic, ratio, meetsTarget: c.length === 0 || ratio >= DET_SEMANTIC_TARGET };
}

export function recompileRate(events: MetricEvent[]): Recompile {
  const c = ofType(events, "rewalk-mission-replay");
  const recompiled = c.filter((e) => e.value === 1).length;
  const reused = c.length - recompiled;
  return { recompiled, reused, rate: c.length ? recompiled / c.length : 0 };
}

export function everythingBucketFraction(events: MetricEvent[]): BucketSplit {
  const c = ofType(events, "rewalk-bucket-decided");
  const everything = c.filter((e) => e.value === 1).length;
  const local = c.length - everything;
  return { everything, local, everythingFraction: c.length ? everything / c.length : 0 };
}

export function attemptsHistogram(events: MetricEvent[]): Attempts {
  const c = ofType(events, "comment-loop-terminated");
  const histogram: Record<number, number> = {};
  let resolved = 0;
  for (const e of c) {
    const n = Math.round(e.value);
    histogram[n] = (histogram[n] ?? 0) + 1;
    if (e.detail === "resolved") resolved++;
  }
  return { histogram, cap: ATTEMPTS_CAP, total: c.length, resolved };
}

export function aggregateMetrics(events: MetricEvent[]): DashboardMetrics {
  return {
    detSemantic: detSemanticRatio(events),
    recompile: recompileRate(events),
    bucket: everythingBucketFraction(events),
    attempts: attemptsHistogram(events),
    totalEvents: events.length,
  };
}
