/**
 * M5-K — the MetadataStore factory. Kept separate from store.ts (the pure
 * interface + shared helpers) so store.ts never imports a concrete backend —
 * no import cycle, and a memory-only path never has to touch node:sqlite.
 */
import type { MetadataStore } from "./store";
import { InMemoryStore } from "./in-memory-store";
import { SqliteStore } from "./sqlite-store";

export interface MakeStoreOptions {
  kind?: "sqlite" | "memory";
  /** sqlite db path (default "./selfqa.db", gitignored). */
  path?: string;
}

/**
 * The seam the worker depends on: `const store = makeMetadataStore()`. Defaults
 * to the durable SQLite store at ./selfqa.db; `SELFQA_STORE=memory` (or
 * `{ kind: "memory" }`) selects the in-memory double for tests/ephemeral runs.
 */
export function makeMetadataStore(opts: MakeStoreOptions = {}): MetadataStore {
  const kind =
    opts.kind ?? (process.env.SELFQA_STORE === "memory" ? "memory" : "sqlite");
  if (kind === "memory") return new InMemoryStore();
  const path = opts.path ?? process.env.SELFQA_DB_PATH ?? "./selfqa.db";
  return new SqliteStore(path);
}
