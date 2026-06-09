/**
 * Spec-extractor (SPEC §10.4).
 *
 * Every comment passes through here. It emits the typed assertion (SPEC §6.1)
 * and — when the comment is vague — exactly one clarifying question (then the
 * caller proceeds on best guess). The output is validated with the SHARED
 * schema (codegen/schema.ts) so mission criteria and comment assertions can
 * never drift apart, and a malformed LLM response is a loud failure.
 *
 * Server-intended (drives an LLMProvider).
 */
import type { LLMProvider } from "../provider/types";
import type { Assertion } from "../domain/types";
import { coerceAssertion, extractJson } from "./schema";
import {
  SPEC_EXTRACTOR_SYSTEM_PROMPT,
  specExtractorUserPrompt,
} from "./prompts";

export interface ExtractedSpec {
  assertion: Assertion;
  clarifyingQuestion: string | null;
}

export async function extractSpec(
  provider: LLMProvider,
  args: { comment: string; url: string; domPath: string },
): Promise<ExtractedSpec> {
  const res = await provider.complete({
    system: SPEC_EXTRACTOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: specExtractorUserPrompt(args) }],
    maxTokens: 1024,
    temperature: 0,
  });

  // Coerce instead of strict-parse: a real model may emit a predicate kind outside
  // the whitelist or a boolean `expected` — coerceAssertion degrades that to a
  // semantic assertion (P1) rather than throwing on the user's comment.
  const obj = JSON.parse(extractJson(res.text)) as { assertion?: unknown; clarifyingQuestion?: unknown };
  return {
    assertion: coerceAssertion(obj.assertion) as Assertion,
    clarifyingQuestion: typeof obj.clarifyingQuestion === "string" ? obj.clarifyingQuestion : null,
  };
}
