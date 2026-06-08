/**
 * Provider factory — the swappable seam in action (SPEC §15).
 *
 * Returns the real Anthropic provider when a key is present, otherwise the
 * deterministic StubProvider so the whole loop runs with zero API spend. One
 * line decides; nothing downstream knows the difference.
 *
 * Server-only.
 */
import type { LLMProvider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { StubProvider } from "./stub";

export function getProvider(): LLMProvider {
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider();
  }
  console.warn(
    "[selfqa] ANTHROPIC_API_KEY not set — using StubProvider (canned, deterministic codegen).",
  );
  return new StubProvider();
}
