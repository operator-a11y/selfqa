/**
 * Mission derivation (SPEC §7.1) — the third codegen agent.
 *
 * Derives 8-15 typed missions from prompt + code. Runs COLD (no prior missions)
 * or INFORMED (handed existing missions + frozen regression tests, proposing
 * NET-NEW only, SPEC §7.5). Output validated by the SHARED DerivedMissionsSchema;
 * invariants enforced with loud throws.
 *
 * Server-intended (drives an LLMProvider).
 */
import type { LLMProvider } from "../provider/types";
import type { Mission } from "../domain/types";
import type { GeneratedFile } from "./protocol";
import { DerivedMissionsSchema, extractJson } from "./schema";
import {
  MISSION_DERIVER_SYSTEM_PROMPT,
  missionDeriverUserPrompt,
} from "./prompts";

export interface DerivedMissions {
  missions: Mission[];
  reusedIds: string[];
}

const MIN_MISSIONS = 8;
const MAX_MISSIONS = 15;

export async function deriveMissions(
  provider: LLMProvider,
  args: {
    appPrompt: string;
    files: GeneratedFile[];
    existingMissions?: Mission[];
    frozenRegressionTests?: Mission[];
  },
): Promise<DerivedMissions> {
  const informed =
    (args.existingMissions?.length ?? 0) > 0 ||
    (args.frozenRegressionTests?.length ?? 0) > 0;

  const res = await provider.complete({
    system: MISSION_DERIVER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: missionDeriverUserPrompt(args) }],
    maxTokens: 8192,
    temperature: 0,
  });

  const parsed = DerivedMissionsSchema.parse(JSON.parse(extractJson(res.text)));
  const missions = parsed.missions as Mission[];

  const ids = missions.map((m) => m.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("mission-deriver: duplicate mission ids within batch");
  }

  if (!informed) {
    if (missions.length < MIN_MISSIONS || missions.length > MAX_MISSIONS) {
      throw new Error(
        `mission-deriver: cold run produced ${missions.length} missions (expected ${MIN_MISSIONS}-${MAX_MISSIONS})`,
      );
    }
  } else {
    const existing = new Set(
      [...(args.existingMissions ?? []), ...(args.frozenRegressionTests ?? [])].map(
        (m) => m.id,
      ),
    );
    const collide = ids.filter((id) => existing.has(id));
    if (collide.length) {
      throw new Error(
        `mission-deriver: informed run re-proposed existing ids (${collide.join(", ")}); must be net-new only (SPEC §7.5)`,
      );
    }
  }

  return { missions, reusedIds: parsed.reusedIds };
}
