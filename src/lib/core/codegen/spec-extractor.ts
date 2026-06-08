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
import { z } from "zod";
import type { LLMProvider } from "../provider/types";
import type { Assertion } from "../domain/types";
import { AssertionSchema, extractJson } from "./schema";
import {
  SPEC_EXTRACTOR_SYSTEM_PROMPT,
  specExtractorUserPrompt,
} from "./prompts";

const SpecSchema = z.object({
  assertion: AssertionSchema,
  clarifyingQuestion: z.string().nullable().optional(),
});

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

  const parsed = SpecSchema.parse(JSON.parse(extractJson(res.text)));
  return {
    assertion: parsed.assertion as Assertion,
    clarifyingQuestion: parsed.clarifyingQuestion ?? null,
  };
}
