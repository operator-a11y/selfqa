/**
 * Local LLM provider (SPEC §15) — the swappable seam pointed at a local **Ollama**
 * server so SelfQA's codegen runs with zero API spend.
 *
 * Uses Ollama's NATIVE /api/chat (not the OpenAI /v1 shim) for two reasons the
 * loop needs: `think: false` disables a reasoning model's chain-of-thought (e.g.
 * qwen3 would otherwise burn the whole budget "thinking" and emit empty content),
 * and `options.num_ctx` widens the context window so the build-agent has room to
 * emit a whole app. Streaming NDJSON, so a long generation never trips Node's
 * ~5-min response timeout.
 *
 * Config (env): SELFQA_LOCAL_MODEL (required to select this provider; e.g.
 * "qwen3.6:35b" or "llama3:latest"), SELFQA_LOCAL_BASE_URL (default Ollama's
 * http://localhost:11434), SELFQA_LOCAL_NUM_CTX (default 16384).
 * Server-only.
 */
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResult,
} from "./types";

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3.6:35b";

export interface LocalProviderOptions {
  baseUrl?: string;
  model?: string;
  numCtx?: number;
}

export class LocalProvider implements LLMProvider {
  readonly name: string;
  private host: string;
  private model: string;
  private numCtx: number;

  constructor(opts: LocalProviderOptions = {}) {
    const raw = opts.baseUrl ?? process.env.SELFQA_LOCAL_BASE_URL ?? DEFAULT_HOST;
    // normalize to the Ollama host (tolerate a trailing /v1 or /api the user may add)
    this.host = raw.replace(/\/+$/, "").replace(/\/(v1|api)$/, "");
    this.model = opts.model ?? process.env.SELFQA_LOCAL_MODEL ?? DEFAULT_MODEL;
    this.numCtx = opts.numCtx ?? Number(process.env.SELFQA_LOCAL_NUM_CTX ?? 16384);
    this.name = "local:" + this.model;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });

    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: req.model ?? this.model,
          messages,
          think: false, // no chain-of-thought — we want the formatted answer, not the reasoning
          stream: true,
          options: {
            num_ctx: this.numCtx,
            num_predict: req.maxTokens ?? 8192,
            temperature: req.temperature ?? 0,
          },
        }),
      });
    } catch (e) {
      throw new Error(`local provider unreachable at ${this.host} (is Ollama running? is "${this.model}" pulled?): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`local provider ${this.host}/api/chat -> HTTP ${res.status} ${detail.slice(0, 300)}`);
    }

    // Ollama streams NDJSON: one JSON object per line, the last with done:true.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let doneReason: string | null = null;
    const consume = (line: string): void => {
      const t = line.trim();
      if (!t) return;
      let j: { message?: { content?: string }; done?: boolean; done_reason?: string; error?: string };
      try {
        j = JSON.parse(t);
      } catch {
        return; // partial line; the remainder is kept in `buffer`
      }
      if (j.error) throw new Error(`ollama error: ${j.error}`);
      if (typeof j.message?.content === "string") text += j.message.content;
      if (j.done) doneReason = j.done_reason ?? doneReason;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    if (buffer) consume(buffer);

    return { text, stopReason: doneReason };
  }
}
