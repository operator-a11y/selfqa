/**
 * Run orchestrator — derive -> compile -> walk (parallel, isolated) -> first-walk
 * verdict -> sorted RunRecord (SPEC §7). This is the off-hot-path conductor: it
 * DOES call the LLM provider (derive + compile), so it lives outside walk/ (the
 * hot-path dir) by design.
 */
import type { Browser } from "playwright";
import type { LLMProvider } from "./provider/types";
import type { GeneratedApp } from "./codegen/build-agent";
import type { MissionRun, RunRecord, VerdictStatus } from "./domain/types";
import type { IsolationProvider } from "./walk/isolation";
import { deriveMissions } from "./codegen/mission-deriver";
import { compileSequence } from "./codegen/mission-compiler";
import { walkAll, type MissionPlan } from "./walk/walker";
import { assignFirstWalkVerdict } from "./verify/first-walk";
import { checkAssertion } from "./verify/checker";
import { serializeObservedState } from "./verify/observed-serde";

/** Sort order for the review list (SPEC §7): failed > ambiguous > passed. */
function rank(s: VerdictStatus): number {
  return s === "fail" ? 0 : s === "ambiguous" ? 1 : 2;
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
}): Promise<RunRecord> {
  const { missions } = await deriveMissions(args.provider, {
    appPrompt: args.app.prompt,
    files: args.app.files,
  });

  const plans: MissionPlan[] = [];
  for (const m of missions) {
    plans.push({
      mission: m,
      actions: await compileSequence(args.provider, m, args.app.files),
    });
  }

  const walked = await walkAll(
    args.browser,
    args.iso,
    args.baseUrl,
    args.runId,
    plans,
    args.concurrency ?? 4,
  );

  const runs: MissionRun[] = walked.map((w, i) => {
    const mission = plans[i].mission;
    const verdict = assignFirstWalkVerdict(mission, w.observed, {
      reached: w.trace.reached,
      buildSha: args.buildSha,
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
  });

  runs.sort((a, b) => rank(a.verdict.status) - rank(b.verdict.status));
  return { appId: args.appId, buildSha: args.buildSha, missions: runs };
}
