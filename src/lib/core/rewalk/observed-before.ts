/**
 * Reconstruct an ObservedState from a CAPTURED DOM (SPEC §3, M5-I).
 *
 * Loads the genuinely-captured DOM HTML into a fresh Playwright page via
 * setContent, then runs the EXACT SAME resolver capture.ts uses — so the "before"
 * (comment-time DOM) and "after" (post-edit terminal DOM) resolve identically and
 * the flip is real, not fabricated. Works for ANY selector the comment names, not
 * just mission-criteria selectors.
 *
 * Off-hot-path (rewalk/, uses Playwright) — NOT in walk/.
 */
import type { Browser } from "playwright";
import type { ObservedState, ResolvedElement } from "../verify/checker";
import { resolveOnPage } from "../walk/capture";

export async function reconstructObservedFromDom(
  browser: Browser,
  domHtml: string,
  selectors: string[],
  url = "about:blank",
): Promise<ObservedState> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.setContent(domHtml, { waitUntil: "domcontentloaded" });
    const resolved = new Map<string, ResolvedElement | null>();
    for (const sel of selectors) resolved.set(sel, await resolveOnPage(page, sel));
    return {
      url,
      consoleErrors: [],
      q: (s: string) =>
        resolved.has(s)
          ? (resolved.get(s) as ResolvedElement | null)
          : { present: false, visible: false, text: "" },
    };
  } finally {
    await ctx.close();
  }
}
