/**
 * M7 — coverage report (SPEC §17; OPTIONAL, supplementary to the mission list).
 *
 * PURE. Turns raw crawled states into the reviewable surface: how many distinct
 * states the agent saw BEYOND the missions, and how many look SUSPICIOUS — flagged
 * mechanically (console errors / a visible known-error selector / an HTTP error),
 * never by an LLM in this default path. The headline product (the mission verdict
 * list + run-to-run diff) is unaffected if this is cut.
 */
import { stateKey } from "./skeleton";

/** Convention set the build-agent is taught to emit (mirrors checker.KNOWN_ERROR_SELECTORS). */
export const ERROR_SELECTORS: readonly string[] = [
  "[role=alert]",
  "[data-testid=error]",
  "[data-testid$=-error]",
  "[aria-invalid=true]",
];

/** A raw state captured by the light crawl (before dedup/classification). */
export interface RawCoverageState {
  route: string;
  url: string;
  html: string;
  consoleErrors: string[];
  httpStatus?: number;
  /** did any ERROR_SELECTORS resolve visible on this state? (resolved by the crawler) */
  errorSelectorVisible: boolean;
  /** the data-testid / selector of the element whose click reached this state */
  via: string;
  screenshot?: string;
}

export interface CoverageState {
  route: string;
  url: string;
  key: string; // route + skeleton hash
  via: string;
  suspicious: boolean;
  reason: string; // why suspicious, or "clean"
  screenshot?: string;
}

export interface CoverageReport {
  /** distinct states seen beyond the missions (after cheap dedup) */
  statesSeen: number;
  /** of those, how many look suspicious */
  suspicious: number;
  /** how many raw states were folded away as structural duplicates */
  duplicatesFolded: number;
  states: CoverageState[];
}

/** Mechanical suspicion (NO LLM): a console error, a visible error affordance, or an HTTP error. */
export function classifySuspicious(s: {
  consoleErrors: string[];
  httpStatus?: number;
  errorSelectorVisible: boolean;
}): { suspicious: boolean; reason: string } {
  if (s.consoleErrors.length > 0) return { suspicious: true, reason: `console error: ${s.consoleErrors[0].slice(0, 80)}` };
  if (s.httpStatus !== undefined && s.httpStatus >= 400) return { suspicious: true, reason: `http ${s.httpStatus}` };
  if (s.errorSelectorVisible) return { suspicious: true, reason: "a known-error selector is visible" };
  return { suspicious: false, reason: "clean" };
}

export function buildCoverageReport(
  raw: RawCoverageState[],
  opts: { missionKeys?: ReadonlySet<string> } = {},
): CoverageReport {
  // Drop states the missions already covered (same route + skeleton) so the count
  // is genuinely "states BEYOND your missions".
  const beyond = opts.missionKeys
    ? raw.filter((s) => !opts.missionKeys!.has(stateKey(s.route, s.html)))
    : raw;

  // Classify BEFORE dedup, and NEVER fold a suspicious state into a clean survivor:
  // when two states share a skeleton, the survivor inherits suspicion (P1-flavored —
  // a flagged state must not vanish just because a clean one looked the same).
  const byKey = new Map<string, CoverageState>();
  let duplicatesFolded = 0;
  for (const s of beyond) {
    const key = stateKey(s.route, s.html);
    const c = classifySuspicious(s);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { route: s.route, url: s.url, key, via: s.via, suspicious: c.suspicious, reason: c.reason, screenshot: s.screenshot });
      continue;
    }
    duplicatesFolded++;
    if (c.suspicious && !existing.suspicious) {
      // adopt the suspicious member as the representative so the flag is never lost
      existing.suspicious = true;
      existing.reason = c.reason;
      existing.url = s.url;
      existing.via = s.via;
      existing.screenshot = s.screenshot;
    }
  }
  const states = [...byKey.values()];
  return {
    statesSeen: states.length,
    suspicious: states.filter((s) => s.suspicious).length,
    duplicatesFolded,
    states,
  };
}

/** The one-line, deliberately-supplementary framing for the UI/log. */
export function coverageHeadline(r: CoverageReport): string {
  return `The agent saw ${r.statesSeen} state${r.statesSeen === 1 ? "" : "s"} beyond your missions` +
    (r.suspicious > 0 ? ` and flagged ${r.suspicious} as suspicious.` : ` (none looked suspicious).`);
}
