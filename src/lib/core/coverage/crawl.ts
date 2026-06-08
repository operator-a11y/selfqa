/**
 * M7 — the light coverage crawl (SPEC §17; OPTIONAL, supplementary).
 *
 * From the entry page, pick up to N (default 3) interactive elements and click each
 * in a FRESH context (so client state is reset between probes), capturing the
 * resulting state. Deliberately SHALLOW — this is supplementary exploration around
 * the missions, never a full crawler; the headline product is unaffected if it's cut.
 *
 * Off the verification hot path (it's exploration, not a verdict): Playwright +
 * harness only, NEVER a provider import — enforced by verify-hot-path, which scans
 * coverage/ alongside harness/ and walk/. The cheap dedup + suspicion live in the
 * pure report module; this file only gathers raw states.
 */
import type { Browser } from "playwright";
import { installSettle, waitForSettled } from "../harness/settle";
import { normalizeRoute } from "../verify/manifest";
import { ERROR_SELECTORS, type RawCoverageState } from "./report";

const CANDIDATE_SELECTOR = "button, a[href], [role=button], [data-testid]";

async function errorSelectorVisible(page: import("playwright").Page): Promise<boolean> {
  for (const es of ERROR_SELECTORS) {
    if (await page.locator(es).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function crawlBeyondMissions(args: {
  browser: Browser;
  baseUrl: string;
  perPage?: number;
}): Promise<RawCoverageState[]> {
  const perPage = args.perPage ?? 3;
  const out: RawCoverageState[] = [];

  // discover up to `perPage` candidate elements on the entry page (document order).
  // Record whether each candidate's data-testid is UNIQUE — only then is it safe to
  // re-resolve by testid in the fresh click context; otherwise fall back to nth.
  const probe = await args.browser.newContext();
  const candidates: { testid?: string; index: number; testidUnique: boolean }[] = [];
  try {
    const page = await probe.newPage();
    await installSettle(page);
    await page.goto(args.baseUrl, { waitUntil: "load" });
    await waitForSettled(page).catch(() => {});
    const all = await page.locator(CANDIDATE_SELECTOR).all();
    const testids = await Promise.all(all.map((h) => h.getAttribute("data-testid").catch(() => null)));
    const freq = new Map<string, number>();
    for (const t of testids) if (t) freq.set(t, (freq.get(t) ?? 0) + 1);
    for (let i = 0; i < all.length && candidates.length < perPage; i++) {
      const t = testids[i] ?? undefined;
      candidates.push({ testid: t, index: i, testidUnique: !!t && freq.get(t) === 1 });
    }
  } finally {
    await probe.close().catch(() => {});
  }

  // click each candidate in a fresh context; capture the reached state.
  for (const cand of candidates) {
    const ctx = await args.browser.newContext();
    const consoleErrors: string[] = [];
    let docStatus: number | undefined;
    try {
      const page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      // track the status of the MAIN-FRAME document — so a click that navigates to a
      // 4xx/5xx is reflected, not just the entry-page load (the http>=400 signal).
      page.on("response", (r) => {
        try {
          if (r.request().resourceType() === "document" && r.frame() === page.mainFrame()) docStatus = r.status();
        } catch {
          /* response gone */
        }
      });
      await installSettle(page);
      await page.goto(args.baseUrl, { waitUntil: "load" });
      await waitForSettled(page).catch(() => {});

      const useTestid = cand.testid !== undefined && cand.testidUnique;
      const via = useTestid ? `[data-testid=${cand.testid}]` : `${CANDIDATE_SELECTOR} :nth(${cand.index})`;
      const loc = useTestid
        ? page.locator(`[data-testid="${cand.testid}"]`)
        : page.locator(CANDIDATE_SELECTOR).nth(cand.index);
      await loc.click({ timeout: 4000 }).catch(() => {});
      await waitForSettled(page).catch(() => {});

      const url = page.url();
      out.push({
        route: normalizeRoute(url),
        url,
        html: await page.content().catch(() => ""),
        consoleErrors,
        httpStatus: docStatus, // the clicked-to document's status (entry status if no nav)
        errorSelectorVisible: await errorSelectorVisible(page),
        via,
      });
    } catch {
      /* a flaky candidate is skipped — coverage is best-effort */
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  return out;
}
