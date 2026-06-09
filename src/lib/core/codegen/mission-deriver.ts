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
import { DerivedMissionsSchema, extractJson, coerceAssertion } from "./schema";
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

  // Normalize each acceptance criterion BEFORE strict validation: a real model
  // invents predicate kinds / boolean `expected`, which would otherwise crash the
  // whole batch. coerceAssertion degrades any non-conforming deterministic
  // predicate to semantic (P1). Missions with no usable criteria get one semantic.
  const rawObj = JSON.parse(extractJson(res.text)) as { missions?: unknown[]; reusedIds?: unknown };
  const normalized = {
    reusedIds: rawObj.reusedIds,
    missions: Array.isArray(rawObj.missions)
      ? rawObj.missions.map((mUnknown) => {
          const m = (mUnknown ?? {}) as { acceptanceCriteria?: unknown[]; description?: unknown };
          const criteria = Array.isArray(m.acceptanceCriteria) && m.acceptanceCriteria.length
            ? m.acceptanceCriteria.map(coerceAssertion)
            : [{ type: "semantic" as const, nl: typeof m.description === "string" ? m.description : "works as intended" }];
          return { ...m, acceptanceCriteria: criteria };
        })
      : [],
  };

  const parsed = DerivedMissionsSchema.parse(normalized);
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
