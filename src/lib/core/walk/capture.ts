/**
 * Per-step capture + ObservedState assembly (SPEC §7, §14.5).
 *
 * Heavy artifacts (PNG/HTML) are written under ARTIFACTS_ROOT (gitignored, beside
 * the workspace, never inside a generated app's repo); metadata carries PATHS only.
 *
 * buildObservedState pre-resolves the criteria selectors against the REACHED
 * terminal page into a sync ObservedState for the pure checker. q() returns null
 * ONLY for an UNREACHED state (unreachableState) — never as a false element-absent
 * (SPEC §7.3); a reached page with no match returns { present: false }.
 *
 * HOT-PATH file (SPEC §6.3): Playwright + node:fs, NEVER a provider import.
 */
import type { Page } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ObservedState, ResolvedElement } from "../verify/checker";

export const ARTIFACTS_ROOT = path.resolve(process.cwd(), "artifacts");

export async function captureStep(
  page: Page,
  runId: string,
  missionId: string,
  index: number,
): Promise<{ screenshot: string; dom: string; url: string }> {
  const dir = path.join(ARTIFACTS_ROOT, runId, missionId);
  await fs.mkdir(dir, { recursive: true });
  const screenshot = path.join(dir, `step-${index}.png`);
  const dom = path.join(dir, `step-${index}.html`);
  await page.screenshot({ path: screenshot }).catch(() => {});
  const html = await page.content().catch(() => "");
  await fs.writeFile(dom, html, "utf8");
  return { screenshot, dom, url: page.url() };
}

export async function resolveOnPage(
  page: Page,
  selector: string,
): Promise<ResolvedElement | null> {
  try {
    const loc = page.locator(selector);
    const count = await loc.count();
    if (count === 0) return { present: false, visible: false, text: "" };
    const first = loc.first();
    const visible = await first.isVisible().catch(() => false);
    // Trim: JSX formats element text with surrounding whitespace; text-equals
    // compares the rendered content, not the indentation.
    const text = ((await first.textContent().catch(() => "")) ?? "").trim();
    return { present: true, visible, text };
  } catch {
    // Malformed selector / evaluation failure = could-not-evaluate.
    return null;
  }
}

export async function buildObservedState(
  page: Page,
  opts: { httpStatus?: number; consoleErrors: string[]; selectors: string[] },
): Promise<ObservedState> {
  const resolved = new Map<string, ResolvedElement | null>();
  for (const sel of opts.selectors) resolved.set(sel, await resolveOnPage(page, sel));
  return {
    url: page.url(),
    httpStatus: opts.httpStatus,
    consoleErrors: opts.consoleErrors,
    q: (s: string) =>
      resolved.has(s)
        ? (resolved.get(s) as ResolvedElement | null)
        : { present: false, visible: false, text: "" },
  };
}

/** A state that was never reached: q() is always could-not-evaluate (SPEC §7.3). */
export function unreachableState(url: string): ObservedState {
  return { url, consoleErrors: [], q: () => null };
}

/** Guard for /api/artifact: the path must stay within ARTIFACTS_ROOT (no escape). */
export function isUnderArtifactsRoot(p: string): boolean {
  const resolved = path.resolve(p);
  return (
    resolved === ARTIFACTS_ROOT || resolved.startsWith(ARTIFACTS_ROOT + path.sep)
  );
}
