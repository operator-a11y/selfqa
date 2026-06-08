/**
 * Run orchestrator — derive -> compile -> walk (parallel, isolated) -> first-walk
 * verdict -> sorted RunRecord (SPEC §7). This is the off-hot-path conductor: it
 * DOES call the LLM provider (derive + compile), so it lives outside walk/ (the
 * hot-path dir) by design.
 */
import type { Browser } from "playwright";
import type { LLMProvider } from "./provider/types";
import type { GeneratedApp } from "./codegen/build-agent";
import type { Mission, MissionRun, RunRecord, VerdictStatus } from "./domain/types";
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
  /** SPEC §9.3: db-file-copy + untrusted -> forced to concurrency 1 (M5-F-INT) */
  snapshotRestoreKind?: "db-file-copy" | "none";
  parallelDbVerdictsTrusted?: boolean;
}): Promise<RunRecord> {
  const { missions } = await deriveMissions(args.provider, {
    appPrompt: args.app.prompt,
    files: args.app.files,
  });

  const selected = args.missionIds
    ? missions.filter((m) => args.missionIds!.includes(m.id))
    : missions;

  const plans: MissionPlan[] = [];
  for (const m of selected) {
    plans.push({
      mission: m,
      actions: await compileSequence(args.provider, m, args.app.files),
    });
  }

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
    plans,
    concurrency,
  );

  const runs: MissionRun[] = walked.map((w, i) =>
    missionRunFromWalked(plans[i].mission, w, args.buildSha),
  );

  runs.sort((a, b) => rankVerdict(a.verdict.status) - rankVerdict(b.verdict.status));
  return { appId: args.appId, buildSha: args.buildSha, missions: runs };
}
