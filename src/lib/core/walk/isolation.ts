/**
 * Isolation seam (SPEC §9.1–§9.3).
 *
 * Every mission walks in a FRESH BrowserContext (the pool creates one per
 * mission) so a verdict is a property of (mission, build), not of mission order.
 * The IsolationProvider hooks let later milestones add server-side restore
 * WITHOUT changing walker/harness callers.
 *
 * ── HONEST ARCHITECTURE NOTE (do not paper over) ───────────────────────────
 * The runner starts ONE `next dev` per app, so N parallel BrowserContexts share
 * ONE server and ONE (future) DB. BrowserContext isolation is therefore
 * per-mission CLIENT isolation only (cookies/localStorage/sessionStorage).
 * DbRestoreIsolation is NOT a frozen-seam no-op: once the build-agent emits
 * Prisma+SQLite, server-side restore-to-seed requires a SCOPED RUNNER CHANGE
 * (per-worker DB path threaded through the dev server, or one server per pool
 * worker). That change is the concrete M5 task; the seam keeps callers stable,
 * the runner explicitly changes.
 *
 * §9.3 trap: when DB restore lands, a shared SQLite connection / leaked WAL
 * surfaces as the literal string "database is locked" — KEEP that textually
 * distinct in logs from settle timeouts so it is never misdiagnosed as flake.
 *
 * HOT-PATH file (SPEC §6.3): Playwright types only, NEVER a provider import.
 */
import type { BrowserContext } from "playwright";

export interface IsolationProvider {
  readonly kind: string;
  /** before a mission walks, with its fresh context */
  before(ctx: BrowserContext): Promise<void>;
  /** after a mission walks (and before the context is closed) */
  after(ctx: BrowserContext): Promise<void>;
}

/** M3 default: a fresh BrowserContext per mission gives client-state isolation. */
export class ClientContextIsolation implements IsolationProvider {
  readonly kind = "client-context";
  async before(_ctx: BrowserContext): Promise<void> {
    /* the pool already handed us a fresh context */
  }
  async after(_ctx: BrowserContext): Promise<void> {
    /* the pool closes the context */
  }
}

/**
 * Server-side restore-to-seed seam. INTENTIONAL no-op in M3 (the canned app is
 * client-state only; there is no server DB to restore). Wiring the real restore
 * — and the runner change it requires — lands in M5. The extension point below
 * is where the future strict file-per-worker / no-shared-connection /
 * no-WAL-leak assertion attaches.
 */
export class DbRestoreIsolation implements IsolationProvider {
  readonly kind = "db-restore-noop";
  readonly noopReason =
    "M3: client-state app, no server DB yet; restore + runner change land in M5";
  async before(_ctx: BrowserContext): Promise<void> {
    /* intentional no-op — see noopReason */
  }
  async after(_ctx: BrowserContext): Promise<void> {
    /* intentional no-op — see noopReason */
  }
}
