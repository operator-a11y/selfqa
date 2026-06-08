/**
 * Build-agent (SPEC §8.2) — prompt → a generated app's files.
 *
 * The initial build is the ONE full generation; every later fix is an
 * incremental edit (see edit-agent). This module only produces files; writing
 * them to a workspace git repo is the workspace writer's job (SPEC §11.1).
 *
 * Server-intended (it drives an LLMProvider) but framework-agnostic.
 */
import type { LLMProvider } from "../provider/types";
import { parseFileBlocks, type GeneratedFile } from "./protocol";
import { BUILD_SYSTEM_PROMPT, buildUserPrompt } from "./prompts";

export interface GeneratedApp {
  prompt: string;
  files: GeneratedFile[];
}

export async function buildApp(
  provider: LLMProvider,
  prompt: string,
): Promise<GeneratedApp> {
  const res = await provider.complete({
    system: BUILD_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(prompt) }],
    maxTokens: 16384,
    temperature: 0,
  });

  const files = parseFileBlocks(res.text);
  if (files.length === 0) {
    throw new Error(
      "build-agent: provider returned no <selfqa:file> blocks (cannot build app)",
    );
  }
  if (!files.some((f) => f.path === "package.json")) {
    throw new Error("build-agent: generated app is missing package.json");
  }
  return { prompt, files };
}
