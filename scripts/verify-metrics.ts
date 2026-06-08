/**
 * M6-B — four-metric dashboard (SPEC §12). Run: `npx tsx scripts/verify-metrics.ts`.
 * FAST (pure: no browser, no LLM, no store).
 *
 * Proves:
 *  1. The event constructors are PURE and compute value from the genuine decision
 *     (deterministic vs semantic, recompiled vs reused, everything vs local,
 *     attempt count) — never fabricated.
 *  2. The four aggregations: det:semantic ratio + ≥80% target, recompile rate,
 *     everything-bucket fraction, attempts histogram read against the cap.
 *  3. Empty input is safe (vacuous target pass, zero rates, empty histogram).
 */
import {
  commentAssertionCompiled,
  rewalkMissionReplay,
  rewalkBucketDecided,
  commentLoopTerminated,
} from "../src/lib/core/metrics/events";
import {
  aggregateMetrics,
  detSemanticRatio,
  recompileRate,
  everythingBucketFraction,
  attemptsHistogram,
  DET_SEMANTIC_TARGET,
  ATTEMPTS_CAP,
} from "../src/lib/core/metrics/aggregate";
import type { MetricEvent } from "../src/lib/core/persist/store";
import type { Assertion } from "../src/lib/core/domain/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const DET: Assertion = { type: "deterministic", predicate: { kind: "text-equals", selector: "#t", expected: "x" }, nl: "n" };
const SEM: Assertion = { type: "semantic", nl: "looks nice" };

// ── 1. constructors are pure + value reflects the decision ──────────────────────
truthy("commentAssertionCompiled: deterministic -> value 1", commentAssertionCompiled("a", DET).value === 1);
truthy("commentAssertionCompiled: semantic -> value 0", commentAssertionCompiled("a", SEM).value === 0);
truthy("commentAssertionCompiled: detail carries the type", commentAssertionCompiled("a", SEM).detail === "semantic");
truthy("rewalkMissionReplay: recompiled -> 1", rewalkMissionReplay("a", "m1", true).value === 1);
truthy("rewalkMissionReplay: reused -> 0, detail=missionId", rewalkMissionReplay("a", "m1", false).value === 0 && rewalkMissionReplay("a", "m1", false).detail === "m1");
truthy("rewalkBucketDecided: everything -> 1", rewalkBucketDecided("a", "everything").value === 1);
truthy("rewalkBucketDecided: local -> 0", rewalkBucketDecided("a", "local").value === 0);
truthy("commentLoopTerminated: value=attempts, resolved detail", commentLoopTerminated("a", 2, true).value === 2 && commentLoopTerminated("a", 2, true).detail === "resolved");
truthy("commentLoopTerminated: needs-human detail", commentLoopTerminated("a", 3, false).detail === "needs-human");

// ── 2. aggregations over a realistic mixed log ──────────────────────────────────
const events: MetricEvent[] = [
  // 8 deterministic + 2 semantic -> ratio exactly 0.8 (meets target)
  ...Array.from({ length: 8 }, () => commentAssertionCompiled("app", DET)),
  ...Array.from({ length: 2 }, () => commentAssertionCompiled("app", SEM)),
  // 1 recompiled + 3 reused -> rate 0.25
  rewalkMissionReplay("app", "m1", true),
  rewalkMissionReplay("app", "m2", false),
  rewalkMissionReplay("app", "m3", false),
  rewalkMissionReplay("app", "m4", false),
  // 1 everything + 4 local -> fraction 0.2
  rewalkBucketDecided("app", "everything"),
  ...Array.from({ length: 4 }, () => rewalkBucketDecided("app", "local")),
  // attempts: 1,1,2,3 (one unresolved at the cap)
  commentLoopTerminated("app", 1, true),
  commentLoopTerminated("app", 1, true),
  commentLoopTerminated("app", 2, true),
  commentLoopTerminated("app", 3, false),
];

const ds = detSemanticRatio(events);
truthy("det:semantic counts 8/2", ds.deterministic === 8 && ds.semantic === 2);
truthy("det:semantic ratio = 0.8 and meets the ≥80% target", close(ds.ratio, 0.8) && ds.meetsTarget === true);
truthy("target constant is 0.8", DET_SEMANTIC_TARGET === 0.8);

const below = detSemanticRatio([
  ...Array.from({ length: 7 }, () => commentAssertionCompiled("app", DET)),
  ...Array.from({ length: 3 }, () => commentAssertionCompiled("app", SEM)),
]);
truthy("det:semantic 0.7 is BELOW target", close(below.ratio, 0.7) && below.meetsTarget === false);

const rc = recompileRate(events);
truthy("recompile rate = 0.25 (1 of 4)", rc.recompiled === 1 && rc.reused === 3 && close(rc.rate, 0.25));

const bk = everythingBucketFraction(events);
truthy("everything-bucket fraction = 0.2 (1 of 5)", bk.everything === 1 && bk.local === 4 && close(bk.everythingFraction, 0.2));

const at = attemptsHistogram(events);
truthy("attempts histogram {1:2, 2:1, 3:1}", at.histogram[1] === 2 && at.histogram[2] === 1 && at.histogram[3] === 1);
truthy("attempts total=4, resolved=3", at.total === 4 && at.resolved === 3);
truthy("attempts cap is the convergence cap (3)", at.cap === ATTEMPTS_CAP && ATTEMPTS_CAP === 3);

const agg = aggregateMetrics(events);
truthy("aggregateMetrics combines all four + totalEvents", agg.totalEvents === events.length && agg.detSemantic.deterministic === 8 && agg.recompile.recompiled === 1 && agg.bucket.everything === 1 && agg.attempts.total === 4);

// ── 3. empty input is safe ──────────────────────────────────────────────────────
const empty = aggregateMetrics([]);
truthy("empty: det ratio 0, target vacuously met", empty.detSemantic.ratio === 0 && empty.detSemantic.meetsTarget === true);
truthy("empty: zero rates + empty histogram", empty.recompile.rate === 0 && empty.bucket.everythingFraction === 0 && Object.keys(empty.attempts.histogram).length === 0 && empty.totalEvents === 0);

if (failures) {
  console.error("\n" + failures + " metric check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: M6-B four-metric dashboard — pure events + aggregations green");
