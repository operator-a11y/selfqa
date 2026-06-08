/**
 * Re-walk planner (SPEC §8.1) — the recompile PRE-PASS, off the hot path.
 *
 * Per affected mission: UNTOUCHED path -> reuse the cached trace.actions (REPLAY,
 * zero LLM); TOUCHED path (per the manifest) -> compileSequence (RECOMPILE,
 * off-loop LLM). Recompile happens HERE, never inside the per-mission replay loop.
 */
import type { LLMProvider } from "../provider/types";
import type { GeneratedApp } from "../codegen/build-agent";
import type { Mission, MissionTrace } from "../domain/types";
import type { MissionPlan } from "../walk/walker";
import { compileSequence } from "../codegen/mission-compiler";
import { missionTouched, type DiffClassification } from "../verify/manifest";

export interface ReWalkPlan {
  plans: MissionPlan[];
  recompiled: Record<string, boolean>;
}

export async function planReWalk(
  provider: LLMProvider,
  args: {
    app: GeneratedApp;
    missions: Mission[];
    priorTraces: Map<string, MissionTrace>;
    cls: DiffClassification;
  },
): Promise<ReWalkPlan> {
  const plans: MissionPlan[] = [];
  const recompiled: Record<string, boolean> = {};
  for (const mission of args.missions) {
    const trace = args.priorTraces.get(mission.id);
    if (!missionTouched(trace, args.cls) && trace && trace.actions) {
      plans.push({ mission, actions: trace.actions }); // REPLAY (zero LLM)
      recompiled[mission.id] = false;
    } else {
      plans.push({ mission, actions: await compileSequence(provider, mission, args.app.files) }); // RECOMPILE
      recompiled[mission.id] = true;
    }
  }
  return { plans, recompiled };
}
