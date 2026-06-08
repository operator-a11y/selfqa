/**
 * M5-K — the MetadataStore seam (SPEC §11.1, §14.4).
 *
 * SelfQA's own metadata — apps, runs, verdicts, the grounded-feedback tuples,
 * human-approved regression tests, and metric events — must survive a worker
 * restart (today they live in two in-memory Maps and are lost). This interface
 * is the single seam: the worker depends on `MetadataStore`, never on a concrete
 * backend, so the durable SQLite store and the in-memory test double are exactly
 * interchangeable (verify-persist round-trips BOTH to identical results).
 *
 * Process-local handles that CANNOT be serialized — the git repo, the running
 * subprocess, the live browser — stay in the worker's own Map. Only durable
 * metadata crosses this seam.
 *
 * Off the hot path by construction (SPEC §6.3): this module imports domain +
 * verify TYPES and node:sqlite, never an LLM provider.
 */
import type {
  RunRecord,
  MissionRun,
  Verdict,
  GroundedFeedback,
  Action,
  RegressionTest,
  RegressionStatus,
} from "../domain/types";
import type { RunDiff } from "../regression/diff";
import { computeRunDiff } from "../regression/diff";

export type { RegressionTest } from "../domain/types";

/** Durable identity of a built app (the repo/subprocess handles stay in-process). */
export interface AppMeta {
  appId: string;
  prompt: string;
  /** the commit SHA the app was first written at (SPEC §9.1) */
  createdSha?: string;
}

/**
 * A metric event, persisted at birth off the hot path (SPEC §12, M6-B). The
 * store stays AGNOSTIC to the event vocabulary — `type` is an opaque string here;
 * the metrics module (M6-B) owns the typed `MetricEventType` union and the
 * aggregations. `value` is the numeric payload (e.g. det=1/sem=0, recompiled=1/
 * reused=0, everything=1/local=0, the attempt count).
 */
export interface MetricEvent {
  appId: string;
  type: string;
  value: number;
  detail?: string;
  buildSha?: string;
}

/**
 * The one seam every durable fact crosses. Synchronous: node:sqlite's
 * DatabaseSync is synchronous, and the in-memory double trivially is — keeping
 * the interface sync means the two backends are drop-in identical.
 */
export interface MetadataStore {
  readonly kind: "sqlite" | "memory";

  // ── apps ──────────────────────────────────────────────────────────────────
  saveApp(app: AppMeta): void;
  getApp(appId: string): AppMeta | null;
  listApps(): AppMeta[];

  // ── runs ──────────────────────────────────────────────────────────────────
  /** Persist a whole run (mission_run rows + verdict rows + action cache). */
  saveRun(run: RunRecord, parentSha?: string): void;
  /** A specific build's run, or — buildSha omitted — the latest run for the app. */
  getRun(appId: string, buildSha?: string): RunRecord | null;
  /** The build-specific compiled action sequence (SPEC §7.4 cache); re-walk reuses
   *  it for untouched missions without re-loading the whole trace. */
  getCachedActions(appId: string, buildSha: string, missionId: string): Action[] | null;

  // ── verdicts (the unit of the run-to-run diff) ──────────────────────────────
  /** Upsert a verdict keyed by (missionId, verdict.buildSha) (SPEC §11.1). */
  upsertVerdict(missionId: string, verdict: Verdict): void;
  getVerdict(missionId: string, buildSha: string): Verdict | null;

  // ── comments (the grounded executable feedback tuple, SPEC §3) ──────────────
  saveComment(feedback: GroundedFeedback, appId: string): void;
  listComments(appId: string): GroundedFeedback[];

  // ── regression lifecycle — human approval only (SPEC §7.5, P1) ──────────────
  /** Mint/replace a frozen, Mission-shaped regression test (status active). */
  promoteRegressionTest(appId: string, test: RegressionTest): void;
  /** Propose retirement: status -> retirement-proposed. NEVER drops the test (P1). */
  proposeRetirement(appId: string, missionId: string, reason: string): void;
  /** The ONLY path that retires a test: status -> retired (human-approved). */
  approveRetirement(appId: string, missionId: string): void;
  getRegressionTest(appId: string, missionId: string): RegressionTest | null;
  listRegressionTests(appId: string, opts?: { status?: RegressionStatus }): RegressionTest[];

  // ── metrics (M6-B) ──────────────────────────────────────────────────────────
  recordMetric(event: MetricEvent): void;
  listMetrics(appId: string): MetricEvent[];

  // ── derived: run-to-run diff (never a stored second source of truth) ────────
  diffRuns(appId: string, fromSha: string, toSha: string): RunDiff | null;

  /**
   * SPEC §8 / M5-F gate: until per-slot DB isolation is proven, verdicts from a
   * parallel run that touched a shared SQLite app are NOT trusted as ground
   * truth. Default false; flipped only when the isolation gate passes.
   */
  getParallelDbVerdictsTrusted(): boolean;
  setParallelDbVerdictsTrusted(trusted: boolean): void;

  close(): void;
}

/**
 * Shared helper: a run-to-run diff from two persisted runs, matched by stable
 * mission id (SPEC §11.1). Lives here so BOTH stores return identical diffs.
 */
export function diffFromRuns(
  store: MetadataStore,
  appId: string,
  fromSha: string,
  toSha: string,
): RunDiff | null {
  const from = store.getRun(appId, fromSha);
  const to = store.getRun(appId, toSha);
  if (!from || !to) return null;
  return computeRunDiff(from, to);
}

/** Deep, JSON-canonical clone — drops `undefined`, identical to a SQLite JSON
 *  round-trip, so the in-memory double and the SQLite store agree exactly. */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Sort missions failed > ambiguous > passed, mirroring the run orchestrator. */
export function sortMissions(missions: MissionRun[]): MissionRun[] {
  const rank = (s: string): number => (s === "fail" ? 0 : s === "ambiguous" ? 1 : 2);
  return [...missions].sort(
    (a, b) => rank(a.verdict.status) - rank(b.verdict.status),
  );
}

/**
 * The store-internal decomposition of a MissionRun's heavy half (everything but
 * mission identity + verdict). Both backends persist exactly these fields and
 * rebuild through `rebuildMissionRun`, so a round-trip is identical regardless of
 * backend.
 */
export interface MissionRunParts {
  trace: MissionRun["trace"];
  beforeState?: MissionRun["beforeState"];
  criteriaResults?: MissionRun["criteriaResults"];
  regressionPromoted: boolean;
  retirementReason?: string;
}

/** Canonical Verdict shape on read: buildSha materialized from the key, booleans
 *  forced, ambiguousReason present only when set. SHARED by both backends. */
export function normalizeVerdict(v: Verdict, buildSha: string): Verdict {
  const out: Verdict = {
    status: v.status,
    humanApproved: !!v.humanApproved,
    buildSha,
  };
  if (v.ambiguousReason) out.ambiguousReason = v.ambiguousReason;
  return out;
}

/** Canonical MissionRun reassembly. SHARED by both backends so getRun agrees. */
export function rebuildMissionRun(
  mission: MissionRun["mission"],
  verdict: Verdict,
  buildSha: string,
  parts: MissionRunParts,
): MissionRun {
  const mr: MissionRun = {
    mission: jsonClone(mission),
    verdict: normalizeVerdict(verdict, buildSha),
    trace: jsonClone(parts.trace),
    regressionPromoted: parts.regressionPromoted,
  };
  if (parts.beforeState) mr.beforeState = jsonClone(parts.beforeState);
  if (parts.criteriaResults) mr.criteriaResults = jsonClone(parts.criteriaResults);
  if (parts.retirementReason !== undefined) mr.retirementProposed = { reason: parts.retirementReason };
  return mr;
}

