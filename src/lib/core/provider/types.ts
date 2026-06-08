/**
 * SPEC §15 — the codegen engine is the Anthropic API behind a *swappable*
 * provider interface. Everything in SelfQA that calls an LLM (build-agent,
 * edit-agent, spec-extractor, semantic verdicts) goes through `LLMProvider`,
 * never the Anthropic SDK directly.
 */

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMCompletionRequest {
  system?: string;
  messages: LLMMessage[];
  /** overrides the provider's default model when set */
  model?: string;
  maxTokens?: number;
  /** defaults to 0 — codegen is deterministic-leaning */
  temperature?: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMCompletionResult {
  text: string;
  stopReason: string | null;
  usage?: LLMUsage;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
