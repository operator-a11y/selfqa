/**
 * Spec-extractor (SPEC §10.4).
 *
 * Every comment passes through here. It emits the typed assertion (SPEC §6.1)
 * and — when the comment is vague — exactly one clarifying question (then the
 * caller proceeds on best guess). The output is validated with zod so a
 * malformed LLM response is a loud failure, not a silent bad assertion.
 *
 * Server-intended (drives an LLMProvider).
 */
import { z } from "zod";
import type { LLMProvider } from "../provider/types";
import type { Assertion } from "../domain/types";
import {
  SPEC_EXTRACTOR_SYSTEM_PROMPT,
  specExtractorUserPrompt,
} from "./prompts";

const PredicateSchema = z.object({
  kind: z.enum([
    "http-status",
    "url-equals",
    "element-visible",
    "element-absent",
    "text-equals",
    "form-validation-blocks",
    "console-error-absent",
  ]),
  selector: z.string().optional(),
  expected: z.union([z.string(), z.number()]).optional(),
});

const AssertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("deterministic"),
    predicate: PredicateSchema,
    nl: z.string(),
  }),
  z.object({ type: z.literal("semantic"), nl: z.string() }),
]);

const SpecSchema = z.object({
  assertion: AssertionSchema,
  clarifyingQuestion: z.string().nullable().optional(),
});

export interface ExtractedSpec {
  assertion: Assertion;
  clarifyingQuestion: string | null;
}

/** Pull the outermost JSON object out of a possibly-chatty response. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("spec-extractor: no JSON object found in response");
  }
  return text.slice(start, end + 1);
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
