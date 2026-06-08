/**
 * Isolation seam (SPEC §9.1–§9.3).
 *
 * Every mission walks in a FRESH BrowserContext (the pool creates one per
 * mission) so a verdict is a property of (mission, build), not of mission order.
 * The IsolationProvider hooks are SLOT-AWARE: `before/after(ctx, slot)` receive
 * the pool's stable lane id, so server-side restore can target that lane's DB.
 *
 * ── ARCHITECTURE (M5-F made the DB path real) ──────────────────────────────────
 * Two isolation modes, selected by fixtures.snapshotRestore.kind:
 *  - kind 'none'  -> ClientContextIsolation: ONE shared `next start` server; a
 *    fresh BrowserContext per mission gives per-mission CLIENT isolation
 *    (cookies/localStorage/sessionStorage). Parallelizes freely.
 *  - kind 'db-file-copy' -> DbRestoreIsolation: the runner's startAppPool gives
 *    N servers (production `next build` once + N `next start`), each on its own
 *    port with its own DATABASE_URL pointing at a per-LANE SQLite file copied from
 *    the seed. before(ctx, slot) restores lane `slot`'s file to the seed.
 *
 * §9.3 trap: a shared SQLite connection / leaked WAL surfaces as the literal
 * string "database is locked" — kept TEXTUALLY DISTINCT from settle-timeout
 * strings so it is never misdiagnosed as flake. restoreToSeed removes the
 * -wal/-shm sidecars precisely to avoid that leak.
 *
 * HOT-PATH file (SPEC §6.3): Playwright types + a restore-fn TYPE only at the
 * seam — NEVER a provider or runner import. (The file copy itself is node:fs in
 * the runner, injected here as a function.)
 */
import type { BrowserContext } from "playwright";

export interface IsolationProvider {
  readonly kind: string;
  /** before a mission walks on lane `slot`, with its fresh context */
  before(ctx: BrowserContext, slot: number): Promise<void>;
  /** after a mission walks (and before the context is closed) */
  after(ctx: BrowserContext, slot: number): Promise<void>;
}

/** Default: a fresh BrowserContext per mission gives client-state isolation. */
export class ClientContextIsolation implements IsolationProvider {
  readonly kind = "client-context";
  async before(_ctx: BrowserContext, _slot: number): Promise<void> {
    /* the pool already handed us a fresh context */
  }
  async after(_ctx: BrowserContext, _slot: number): Promise<void> {
    /* the pool closes the context */
  }
}

/**
 * A restore-to-seed function injected by the runner. Only this TYPE crosses the
 * hot-path seam — the implementation (node:fs byte-copy of seed.db -> lane file +
 * -wal/-shm removal) lives in runner/app-runner.ts, never imported here.
 */
export type RestoreToSeed = (slot: number) => Promise<void>;

/**
 * Server-side restore-to-seed (SPEC §9.2/§9.3) — REAL as of M5-F. Before each
 * mission replays on lane `slot`, that lane's SQLite file is reset to the seed,
 * so the verdict is a property of (mission, build), never of what an earlier
 * mission on the same lane wrote.
 */
export class DbRestoreIsolation implements IsolationProvider {
  readonly kind = "db-restore";
  constructor(private readonly restore: RestoreToSeed) {}
  async before(_ctx: BrowserContext, slot: number): Promise<void> {
    await this.restore(slot);
  }
  async after(_ctx: BrowserContext, _slot: number): Promise<void> {
    /* discard: the next mission's before() restores this lane to seed */
  }
}
