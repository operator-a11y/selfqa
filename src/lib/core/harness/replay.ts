/**
 * Replay with retry-once (SPEC §13.3, §8.1).
 *
 * Each attempt uses a FRESH BrowserContext, then restore (iso.before) BEFORE the
 * replay — a retry against a dirty state is worthless. Exactly one retry; a final
 * failure is the caller's `replay-failed` signal (SPEC §7.3).
 *
 * HOT-PATH file (SPEC §6.3): Playwright + harness/walk only, NEVER a provider import.
 */
import type { Browser } from "playwright";
import type { Action } from "../domain/types";
import type { IsolationProvider } from "../walk/isolation";
import { executeSequence } from "./executor";
import { installSettle, waitForSettled } from "./settle";

export interface ReplayResult {
  ok: boolean;
  attempts: number;
  error?: string;
}

export async function replaySequence(
  browser: Browser,
  iso: IsolationProvider,
  url: string,
  actions: Action[],
  opts: { retries?: number } = {},
): Promise<ReplayResult> {
  const maxAttempts = (opts.retries ?? 1) + 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctx = await browser.newContext();
    try {
      await iso.before(ctx); // restore BEFORE replay (order matters)
      const page = await ctx.newPage();
      await installSettle(page);
      await page.goto(url, { waitUntil: "load" });
      await waitForSettled(page);
      await executeSequence(page, actions);
      await iso.after(ctx);
      await ctx.close();
      return { ok: true, attempts: attempt };
    } catch (e) {
      lastErr = e;
      await ctx.close().catch(() => {});
      // next attempt recreates a FRESH context and restores again
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
}
