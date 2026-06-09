/**
 * Mission-compiler (SPEC §8.1) — compile a mission's NL intent into a
 * deterministic Action[] the harness replays. Runs OFF the hot path (it is an
 * LLM call); the result is the build-specific cache, NOT the mission's identity
 * (SPEC §7.4). zod-validated; loud on malformed output.
 *
 * Server-intended (drives an LLMProvider).
 */
import { z } from "zod";
import type { LLMProvider } from "../provider/types";
import type { Action, Mission } from "../domain/types";
import type { GeneratedFile } from "./protocol";
import { extractJson } from "./schema";
import {
  MISSION_COMPILER_SYSTEM_PROMPT,
  missionCompilerUserPrompt,
} from "./prompts";

const StrategyEnum = z.enum(["data-testid", "role+name", "text", "xpath"]);
// A real model freely emits a number/boolean where a string is meant (e.g. a
// "type" action with value: 5, or a selector value 12). Coerce to string rather
// than crash the whole compiled sequence on one type slip.
const looseString = z.preprocess(
  (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v),
  z.string(),
);
const SelectorRefSchema = z.object({
  strategy: StrategyEnum,
  value: looseString,
  fallbacks: z
    .array(z.object({ strategy: StrategyEnum, value: looseString }))
    .optional(),
});
const ActionSchema = z.object({
  kind: z.enum(["navigate", "click", "type", "press", "select", "wait"]),
  target: SelectorRefSchema.optional(),
  value: looseString.optional(),
});
const CompiledSchema = z.object({ actions: z.array(ActionSchema) });

export async function compileSequence(
  provider: LLMProvider,
  mission: Mission,
  files: GeneratedFile[],
): Promise<Action[]> {
  const res = await provider.complete({
    system: MISSION_COMPILER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: missionCompilerUserPrompt(mission, files) }],
    maxTokens: 4096,
    temperature: 0,
  });
  const parsed = CompiledSchema.parse(JSON.parse(extractJson(res.text)));
  return parsed.actions as Action[];
}
