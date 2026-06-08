/**
 * Batched semantic verdict (SPEC §6.1, §6.3) — the ONE off-loop LLM judgment for
 * the SEMANTIC half. Deliberately NOT checkAssertion (that's the deterministic
 * spine); this is the spec's single batched verdict call, fired AFTER the
 * deterministic replay finishes. Deterministic-only re-walks cost ZERO LLM.
 *
 * Off-hot-path (drives the provider); shared by re-walk + regression replay so
 * the semantic path never forks.
 */
import { z } from "zod";
import type { LLMProvider } from "../provider/types";
import { extractJson } from "../codegen/schema";
import {
  SEMANTIC_VERDICT_SYSTEM_PROMPT,
  semanticVerdictUserPrompt,
} from "../codegen/prompts";

export interface SemanticItem {
  commentId: string;
  nl: string;
  beforeSnapshot: string;
  afterSnapshot: string;
}
export interface SemanticVerdict {
  commentId: string;
  satisfied: boolean | null;
  confidence: "high" | "low";
}

const Schema = z.object({
  verdicts: z.array(
    z.object({
      commentId: z.string(),
      satisfied: z.boolean().nullable(),
      confidence: z.enum(["high", "low"]),
    }),
  ),
});

export async function batchSemanticVerdict(
  provider: LLMProvider,
  items: SemanticItem[],
): Promise<SemanticVerdict[]> {
  if (items.length === 0) return []; // deterministic-only re-walk -> zero LLM
  const res = await provider.complete({
    system: SEMANTIC_VERDICT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: semanticVerdictUserPrompt(items) }],
    maxTokens: 2048,
    temperature: 0,
  });
  return Schema.parse(JSON.parse(extractJson(res.text))).verdicts;
}
