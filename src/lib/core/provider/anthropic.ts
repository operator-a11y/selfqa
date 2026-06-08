import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResult,
} from "./types";

/**
 * Default codegen model. Opus 4.8 is the most capable Claude model; per-request
 * overrides are supported via `LLMCompletionRequest.model`.
 */
export const DEFAULT_MODEL = "claude-opus-4-8";

export interface AnthropicProviderOptions {
  apiKey?: string;
  defaultModel?: string;
}

/** SPEC §15 — the concrete Anthropic implementation of the swappable interface. */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private defaultModel: string;

  constructor(opts: AnthropicProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Fail loudly — codegen cannot run without it (see .env.example).
      throw new Error(
        "ANTHROPIC_API_KEY is not set. SelfQA's codegen requires it. " +
          "Copy .env.example to .env and set the key.",
      );
    }
    this.client = new Anthropic({ apiKey });
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    // `temperature` is DEPRECATED on current Claude models (Opus 4.8+ reject it
    // with a 400), so we don't forward it — callers pass temperature:0 for
    // determinism, which these models approximate without the knob. An older model
    // that still accepts it could be handled behind a model check if ever needed.
    const res = await this.client.messages.create({
      model: req.model ?? this.defaultModel,
      max_tokens: req.maxTokens ?? 8192,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    // Concatenate text blocks; tool/other blocks are ignored at this layer.
    const text = res.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    return {
      text,
      stopReason: res.stop_reason,
      usage: res.usage
        ? {
            inputTokens: res.usage.input_tokens,
            outputTokens: res.usage.output_tokens,
          }
        : undefined,
    };
  }
}
