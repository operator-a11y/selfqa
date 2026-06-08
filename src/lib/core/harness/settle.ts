/**
 * Settling predicate (SPEC §13.3) — NEVER `networkidle`.
 *
 * A state is settled IFF, SIMULTANEOUSLY:
 *   (RAF quiescent) AND (MutationObserver quiet for >= 500ms) AND (no pending fetches/XHR)
 *
 * An init script installs counters in the page; waitForSettled polls the single
 * conjunction. Counters decrement in finally/loadend so abort/error never leak.
 *
 * HOT-PATH file (SPEC §6.3): Playwright types only, NEVER a provider import.
 */
import type { Page } from "playwright";

export interface SettleWindow extends Window {
  __selfqa_settle?: { pendingFetches: number; rafScheduled: number; lastMutation: number };
  __selfqa_isSettled?: (quietMs: number) => boolean;
  __selfqa_settleState?: () => {
    pendingFetches: number;
    rafScheduled: number;
    sinceMutation: number;
  };
  __selfqa_raf_stop?: boolean;
}

/** Injected into the page (as a string — runs in the browser, not type-checked here). */
export const SETTLE_INIT_SCRIPT = `(() => {
  if (window.__selfqa_settle) return;
  var s = { pendingFetches: 0, rafScheduled: 0, lastMutation: performance.now() };
  window.__selfqa_settle = s;

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function () {
      s.pendingFetches++;
      return origFetch.apply(null, arguments).finally(function () {
        s.pendingFetches = Math.max(0, s.pendingFetches - 1);
      });
    };
  }

  var X = window.XMLHttpRequest;
  if (X) {
    var send = X.prototype.send;
    X.prototype.send = function () {
      s.pendingFetches++;
      this.addEventListener('loadend', function () {
        s.pendingFetches = Math.max(0, s.pendingFetches - 1);
      });
      return send.apply(this, arguments);
    };
  }

  var rAF = window.requestAnimationFrame;
  if (rAF) {
    window.requestAnimationFrame = function (cb) {
      s.rafScheduled++;
      return rAF.call(window, function (t) {
        s.rafScheduled = Math.max(0, s.rafScheduled - 1);
        cb(t);
      });
    };
  }

  var observe = function () {
    new MutationObserver(function () { s.lastMutation = performance.now(); })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  if (document.documentElement) observe();
  else document.addEventListener('readystatechange', observe, { once: true });

  window.__selfqa_isSettled = function (quietMs) {
    var q = typeof quietMs === 'number' ? quietMs : 500;
    return s.pendingFetches === 0 && s.rafScheduled === 0 && (performance.now() - s.lastMutation) >= q;
  };
  window.__selfqa_settleState = function () {
    return { pendingFetches: s.pendingFetches, rafScheduled: s.rafScheduled, sinceMutation: performance.now() - s.lastMutation };
  };
})();`;

/** Install the settle counters. Must be called BEFORE the page's first navigation. */
export async function installSettle(page: Page): Promise<void> {
  await page.addInitScript(SETTLE_INIT_SCRIPT);
}

export async function waitForSettled(
  page: Page,
  opts: { timeoutMs?: number; quietMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const quietMs = opts.quietMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const settled = await page
      .evaluate((q) => {
        const w = window as unknown as SettleWindow;
        return typeof w.__selfqa_isSettled === "function" ? w.__selfqa_isSettled(q) : false;
      }, quietMs)
      .catch(() => false);
    if (settled) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  const state = await page
    .evaluate(() => {
      const w = window as unknown as SettleWindow;
      return typeof w.__selfqa_settleState === "function" ? w.__selfqa_settleState() : null;
    })
    .catch(() => null);
  // Distinct wording from the §9.3 "database is locked" failure mode on purpose.
  throw new Error(
    `settle: state did not quiesce within ${timeoutMs}ms (settleState=${JSON.stringify(state)})`,
  );
}
