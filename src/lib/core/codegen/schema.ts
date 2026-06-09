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

const VALID_KINDS = new Set([
  "http-status",
  "url-equals",
  "element-visible",
  "element-absent",
  "text-equals",
  "form-validation-blocks",
  "console-error-absent",
]);
/** Kinds whose check is meaningless without a string/number `expected`. */
const NEEDS_EXPECTED = new Set(["http-status", "url-equals", "text-equals"]);

export type AssertionT = z.infer<typeof AssertionSchema>;

/**
 * Coerce a (possibly model-malformed) assertion into a SCHEMA-VALID one — never
 * throws. A real LLM cheerfully invents predicate kinds outside the fixed
 * whitelist or uses a boolean `expected`; rather than crash the whole batch, a
 * non-conforming deterministic predicate DEGRADES to a semantic assertion. That
 * is exactly SelfQA's own rule (P1): don't fake a precise mechanical check — if
 * it doesn't fit the whitelist, it isn't mechanical, so mark it semantic.
 */
export function coerceAssertion(raw: unknown): AssertionT {
  const direct = AssertionSchema.safeParse(raw);
  if (direct.success) return direct.data;

  const r = raw as { type?: unknown; predicate?: { kind?: unknown; selector?: unknown; expected?: unknown }; nl?: unknown };
  const nl = typeof r?.nl === "string" && r.nl.trim() ? r.nl : "the result is correct";

  if (r?.type === "deterministic" && r.predicate && typeof r.predicate.kind === "string" && VALID_KINDS.has(r.predicate.kind)) {
    const kind = r.predicate.kind;
    const exp = r.predicate.expected;
    const expOk = typeof exp === "string" || typeof exp === "number";
    if (!(NEEDS_EXPECTED.has(kind) && !expOk)) {
      const predicate: Record<string, unknown> = { kind };
      if (typeof r.predicate.selector === "string") predicate.selector = r.predicate.selector;
      if (expOk) predicate.expected = exp;
      const v = AssertionSchema.safeParse({ type: "deterministic", predicate, nl });
      if (v.success) return v.data;
    }
  }
  return { type: "semantic", nl };
}

/** Pull the outermost JSON object out of a possibly-chatty LLM response. */
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in response");
  }
  return text.slice(start, end + 1);
}
