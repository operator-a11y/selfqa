/**
 * SelfQA core — shared by the Next UI and the long-running worker (SPEC §14.1).
 * The single verification spine, domain types, and the swappable LLM provider
 * all live here.
 */
export * from "./domain/types";
export * from "./provider/types";
export * from "./provider/anthropic";
