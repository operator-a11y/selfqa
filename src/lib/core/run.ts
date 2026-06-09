/**
 * Run orchestrator — derive -> compile -> walk (parallel, isolated) -> first-walk
 * verdict -> sorted RunRecord (SPEC §7). This is the off-hot-path conductor: it
 * DOES call the LLM provider (derive + compile), so it lives outside walk/ (the
 * hot-path dir) by design.
 */
import type { Browser } from "playwright";
import type { LLMProvider } from "./provider/types";
import type { GeneratedApp } from "./codegen/build-agent";
import type { Action, Mission, MissionRun, RunRecord, VerdictStatus } from "./domain/types";
import type { IsolationProvider } from "./walk/isolation";
import { deriveMissions } from "./codegen/mission-deriver";
import { compileSequence } from "./codegen/mission-compiler";
import { walkAll, type MissionPlan, type WalkedMission } from "./walk/walker";
import { assignFirstWalkVerdict } from "./verify/first-walk";
import { checkAssertion } from "./verify/checker";
import { serializeObservedState } from "./verify/observed-serde";

/** Sort order for the review list (SPEC §7): failed > ambiguous > passed. */
export function rankVerdict(s: VerdictStatus): number {
  return s === "fail" ? 0 : s === "ambiguous" ? 1 : 2;
}

/**
 * SPEC §9.3 hard precondition (M5-F-INT): until verify-db-e2e flips
 * `parallelDbVerdictsTrusted`, a db-file-copy app is walked at concurrency 1
 * (correct-but-slow) so no UNTRUSTED parallel DB verdict can ever be produced.
 * Client-state apps (kind 'none') parallelize freely.
 */
export function effectiveConcurrency(
  requested: number,
  snapshotRestoreKind: "db-file-copy" | "none",
  parallelDbVerdictsTrusted: boolean,
): number {
  if (snapshotRestoreKind === "db-file-copy" && !parallelDbVerdictsTrusted) return 1;
  return requested;
}

/** Build a MissionRun (verdict + serializable before-state) from a walked mission. */
export function missionRunFromWalked(
  mission: Mission,
  w: WalkedMission,
  buildSha: string,
): MissionRun {
  const verdict = assignFirstWalkVerdict(mission, w.observed, {
    reached: w.trace.reached,
    buildSha,
  });
  const mr: MissionRun = { mission, verdict, trace: w.trace };
  // Persist a SERIALIZABLE before-state baseline for REACHED missions only —
  // an unreached mission's "before" is genuinely could-not-evaluate (M5-A).
  if (w.trace.reached) {
    const selectors = mission.acceptanceCriteria.flatMap((c) =>
      c.type === "deterministic" && c.predicate.selector ? [c.predicate.selector] : [],
    );
    mr.beforeState = serializeObservedState(w.observed, selectors);
    mr.criteriaResults = mission.acceptanceCriteria.map((c, ci) => ({
      criterionIndex: ci,
      check: checkAssertion(c, w.observed),
    }));
  }
  return mr;
}

/**
 * Assemble the full plan set for a run (SPEC §7.1 / §7.5). COLD when nothing is
 * carried: the deriver returns the whole 8-15 suite. INFORMED when prior missions
 * are carried forward: the deriver is handed them as `existingMissions` (+ frozen
 * regression tests) and returns NET-NEW missions only, which are compiled fresh and
 * APPENDED. Carried missions keep their already-compiled actions VERBATIM — stable
 * id, no recompile, so no provider drift — which is what lets a re-run ACCRETE
 * coverage for just-added features instead of regenerating the suite from scratch
 * (a cold re-derive would also scramble the stable ids the run-diff matches on).
 */
/** A mission carried forward from the prior run. `actions` present => reuse it
 *  verbatim (a REACHED mission — stable, no recompile, no provider drift). `actions`
 *  ABSENT => recompile fresh (a prior UNREACHED mission carries no usable sequence;
 *  give it a new shot against the current code, never replay a known-failing dud). */
export interface CarriedMission {
  mission: Mission;
  actions?: Action[];
}

export async function assembleRunPlans(
  provider: LLMProvider,
  args: {
    app: GeneratedApp;
    carryForward?: CarriedMission[];
    /** active frozen regression tests, so the deriver never re-proposes a frozen id. */
    frozenRegressionTests?: Mission[];
  },
): Promise<MissionPlan[]> {
  const carry = args.carryForward ?? [];
  const existingMissions = carry.map((c) => c.mission);

  const { missions: derived } = await deriveMissions(provider, {
    appPrompt: args.app.prompt,
    files: args.app.files,
    existingMissions: existingMissions.length ? existingMissions : undefined,
    frozenRegressionTests: args.frozenRegressionTests?.length
      ? args.frozenRegressionTests
      : undefined,
  });

  // Carried missions reuse their compiled actions when present; recompile (loudly)
  // when absent so a prior unreached/degenerate mission gets a real sequence instead
  // of a silent navigate-only walk. `[]` is a VALID reused sequence (a reached
  // navigate-only mission), so only `undefined` triggers a recompile.
  let recompiled = 0;
  const carriedPlans: MissionPlan[] = [];
  for (const c of carry) {
    let actions = c.actions;
    if (actions === undefined) {
      actions = await compileSequence(provider, c.mission, args.app.files);
      recompiled++;
    }
    carriedPlans.push({ mission: c.mission, actions });
  }
  if (recompiled) {
    console.log(`[run] recompiled ${recompiled} carried mission(s) with no reusable actions`);
  }

  // Compile ONLY the net-new missions and append. Dedup by id (a carried id always
  // wins) — now a LIVE guard: the deriver drops re-proposed ids tolerantly (SPEC §7.5),
  // so this still protects against any slipping through.
  const carriedIds = new Set(existingMissions.map((m) => m.id));
  const netNewPlans: MissionPlan[] = [];
  for (const m of derived) {
    if (carriedIds.has(m.id)) continue;
    netNewPlans.push({
      mission: m,
      actions: await compileSequence(provider, m, args.app.files),
    });
  }
  return [...carriedPlans, ...netNewPlans];
}

export async function runMissions(args: {
  provider: LLMProvider;
  browser: Browser;
  iso: IsolationProvider;
  baseUrl: string;
  runId: string;
  appId: string;
  app: GeneratedApp;
  buildSha: string;
  concurrency?: number;
  /** re-walk scope (SPEC §8.3); absent = walk all (M4 behavior unchanged) */
  missionIds?: string[];
  /**
   * INFORMED re-run (SPEC §7.5): prior-run missions carried forward, so the deriver
   * proposes NET-NEW missions only and this run ACCRETES them onto the kept set.
   * Absent/empty => a COLD run that derives the whole suite (M4 behavior).
   */
  carryForward?: CarriedMission[];
  /** active frozen regression tests handed to the deriver (never re-proposed). */
  frozenRegressionTests?: Mission[];
  /** SPEC §9.3: db-file-copy + untrusted -> forced to concurrency 1 (M5-F-INT) */
  snapshotRestoreKind?: "db-file-copy" | "none";
  parallelDbVerdictsTrusted?: boolean;
}): Promise<RunRecord> {
  const allPlans = await assembleRunPlans(args.provider, {
    app: args.app,
    carryForward: args.carryForward,
    frozenRegressionTests: args.frozenRegressionTests,
  });

  // re-walk scope filter (SPEC §8.3) applies to the full carried + net-new set.
  const selected = args.missionIds
    ? allPlans.filter((p) => args.missionIds!.includes(p.mission.id))
    : allPlans;

  const concurrency = effectiveConcurrency(
    args.concurrency ?? 4,
    args.snapshotRestoreKind ?? "none",
    args.parallelDbVerdictsTrusted ?? false,
  );
  const walked = await walkAll(
    args.browser,
    args.iso,
    args.baseUrl,
    args.runId,
    selected,
    concurrency,
  );

  const runs: MissionRun[] = walked.map((w, i) =>
    missionRunFromWalked(selected[i].mission, w, args.buildSha),
  );

  runs.sort((a, b) => rankVerdict(a.verdict.status) - rankVerdict(b.verdict.status));
  return { appId: args.appId, buildSha: args.buildSha, missions: runs };
}
