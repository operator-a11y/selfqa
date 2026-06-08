/**
 * Shared validation schema (SPEC §6).
 *
 * PredicateSchema + AssertionSchema live HERE so mission acceptance criteria
 * (mission-deriver) and comment assertions (spec-extractor) validate through ONE
 * definition — never two that drift apart. extractJson is the shared chatty-JSON
 * salvager. Pure (zod only) — safe to import anywhere.
 */
import { z } from "zod";

export const PredicateSchema = z.object({
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

export const AssertionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("deterministic"),
    predicate: PredicateSchema,
    nl: z.string(),
  }),
  z.object({ type: z.literal("semantic"), nl: z.string() }),
]);

/** SPEC §7.1 / §7.4 — a mission's durable identity. */
export const MissionSchema = z.object({
  id: z.string().regex(/^mission-[a-z0-9-]+$/, "id must match /^mission-[a-z0-9-]+$/"),
  name: z.string().min(1),
  description: z.string().min(1),
  intendedSteps: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(AssertionSchema).min(1),
});

/** SPEC §7.5 — deriver output: net-new missions + the ids it reused (informed runs). */
export const DerivedMissionsSchema = z.object({
  missions: z.array(MissionSchema),
  reusedIds: z.array(z.string()).default([]),
});

/** Pull the outermost JSON object out of a possibly-chatty LLM response. */
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in response");
  }
  return text.slice(start, end + 1);
}
