/**
 * The verification spine's ONE checker (SPEC §6.2).
 *
 * checkAssertion is the single place a typed Assertion meets a walked state.
 * First-walk verdicts (M4-B), and later re-walk + regression replay (M5), all
 * call THIS function — never a fork.
 *
 * Pure + engine-agnostic: NO LLM, NO Playwright, NO node. Safe to import anywhere.
 */
import type { Assertion } from "../domain/types";

/** Result of resolving a selector against a REACHED state. */
export interface ResolvedElement {
  present: boolean; // did the resolver find a matching element on the page?
  visible: boolean;
  text: string;
}

/**
 * A walked state observed off a mission trace's terminal step.
 *
 * `q(selector)` returns `null` ONLY when the resolver could not run at all
 * (the state was unreachable) — that is "could-not-evaluate", and it is NEVER
 * read as "element absent". A reached page with no matching element returns a
 * `ResolvedElement { present: false }`.
 */
export interface ObservedState {
  url: string;
  httpStatus?: number;
  consoleErrors: string[];
  formValidationBlocked?: boolean;
  q(selector: string): ResolvedElement | null;
}

export interface CheckResult {
  /** true = mechanically pass · false = mechanically fail · null = semantic OR could-not-evaluate (see detail) */
  satisfied: boolean | null;
  detail: string;
}

/**
 * SPEC §7.2 — the FIXED first-walk whitelist. A strict subset of
 * DeterministicPredicateKind that DELIBERATELY EXCLUDES `text-equals`.
 * Do NOT widen this to "all deterministic kinds": that would let the agent
 * auto-assert content equality on the first walk — a P1 violation.
 */
export const FIRST_WALK_WHITELIST: ReadonlySet<string> = new Set([
  "http-status",
  "url-equals",
  "element-visible",
  "element-absent",
  "form-validation-blocks",
  "console-error-absent",
]);

/** Convention set the build-agent is taught to emit (M3-E, SPEC §7.2). */
export const KNOWN_ERROR_SELECTORS: readonly string[] = [
  "[role=alert]",
  "[data-testid=error]",
  "[data-testid$=-error]",
  "[aria-invalid=true]",
];

function isKnownErrorSelector(sel: string | undefined): boolean {
  return !!sel && KNOWN_ERROR_SELECTORS.includes(sel.trim());
}

/**
 * SPEC §7.2 / §4 (P1) — only these are AUTO-asserted on the first walk; the
 * agent never guesses. element-visible/absent are gated to KNOWN_ERROR_SELECTORS
 * so the agent cannot auto-assert positive happy-path selectors.
 */
export function isFirstWalkAutoAssertable(a: Assertion): boolean {
  if (a.type !== "deterministic") return false;
  const p = a.predicate;
  if (!FIRST_WALK_WHITELIST.has(p.kind)) return false; // excludes text-equals
  if (p.kind === "element-visible" || p.kind === "element-absent") {
    return isKnownErrorSelector(p.selector);
  }
  return true;
}

export function checkAssertion(a: Assertion, s: ObservedState): CheckResult {
  if (a.type === "semantic") {
    return { satisfied: null, detail: "requires semantic verdict" };
  }
  const p = a.predicate;
  switch (p.kind) {
    case "http-status": {
      if (s.httpStatus === undefined)
        return { satisfied: null, detail: "could-not-evaluate: no httpStatus" };
      return {
        satisfied: s.httpStatus === Number(p.expected),
        detail: `httpStatus=${s.httpStatus} expected=${p.expected}`,
      };
    }
    case "url-equals":
      return {
        satisfied: s.url === String(p.expected),
        detail: `url=${s.url} expected=${p.expected}`,
      };
    case "console-error-absent":
      return {
        satisfied: s.consoleErrors.length === 0,
        detail: `consoleErrors=${s.consoleErrors.length}`,
      };
    case "form-validation-blocks": {
      if (s.formValidationBlocked === undefined)
        return {
          satisfied: null,
          detail: "could-not-evaluate: formValidationBlocked unknown",
        };
      return {
        satisfied: s.formValidationBlocked === true,
        detail: `formValidationBlocked=${s.formValidationBlocked}`,
      };
    }
    case "element-visible": {
      if (!p.selector)
        return { satisfied: null, detail: "could-not-evaluate: no selector" };
      const el = s.q(p.selector);
      if (el === null)
        return { satisfied: null, detail: "could-not-evaluate: selector unresolved" };
      return {
        satisfied: el.present && el.visible,
        detail: `present=${el.present} visible=${el.visible}`,
      };
    }
    case "element-absent": {
      if (!p.selector)
        return { satisfied: null, detail: "could-not-evaluate: no selector" };
      const el = s.q(p.selector);
      // CRITICAL (SPEC §7.3): q()===null is could-not-evaluate, NEVER absent=true.
      if (el === null)
        return {
          satisfied: null,
          detail: "could-not-evaluate: selector unresolved (not read as absent)",
        };
      return {
        satisfied: !el.present || !el.visible,
        detail: `present=${el.present} visible=${el.visible}`,
      };
    }
    case "text-equals": {
      if (!p.selector)
        return { satisfied: null, detail: "could-not-evaluate: no selector" };
      const el = s.q(p.selector);
      if (el === null)
        return { satisfied: null, detail: "could-not-evaluate: selector unresolved" };
      if (!el.present)
        return { satisfied: false, detail: "element absent; cannot match text" };
      return {
        satisfied: el.text === String(p.expected),
        detail: `text=${JSON.stringify(el.text)} expected=${JSON.stringify(String(p.expected))}`,
      };
    }
    default:
      return { satisfied: null, detail: "could-not-evaluate: unknown predicate kind" };
  }
}
