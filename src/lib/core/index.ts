/**
 * SelfQA core — CLIENT-SAFE barrel.
 *
 * Only pure types/interfaces are re-exported here, so importing `@/lib/core`
 * from a client component never pulls server-only code (the Anthropic SDK,
 * `node:fs`, `child_process`) into the browser bundle.
 *
 * Server-only modules are imported directly from their paths:
 *   @/lib/core/provider/anthropic   — AnthropicProvider (SDK + env)
 *   @/lib/core/provider/stub        — StubProvider (deterministic, no API)
 *   @/lib/core/codegen/build-agent  — buildApp()
 *   @/lib/core/workspace/repo       — writeGeneratedApp() (node:fs + git)
 */
export * from "./domain/types";
export * from "./provider/types";
export * from "./codegen/protocol";
