/**
 * SelfQA core domain types.
 *
 * These are the single spine the whole system shares (SPEC §6). The same typed
 * `Assertion` is used by mission acceptance criteria (SPEC §7.1) and by comment
 * assertions (SPEC §3); one checker dispatches on `type` at three entry points
 * (initial walk, re-walk, regression replay).
 *
 * See SPEC.md for the authoritative definitions; section references are inline.
 */

/** SPEC §6.1 — the single typed-assertion spine. */
export type AssertionType = "deterministic" | "semantic";

/**
 * SPEC §7.2 — the *fixed* first-walk whitelist of mechanically-knowable
 * predicates. The agent auto-asserts ONLY these; everything else is left
 * `ambiguous: semantic-needs-human` rather than guessed (P1).
 */
export type DeterministicPredicateKind =
  | "http-status" // response status code for a navigation/action
  | "url-equals" // post-action URL
  | "element-visible" // an element matching `selector` is visible
  | "element-absent" // no element matching `selector` is visible
  | "text-equals" // `selector`'s text content equals `expected`
  | "form-validation-blocks" // native form validation blocked submission
  | "console-error-absent"; // no console error thrown during the action

export interface DeterministicPredicate {
  kind: DeterministicPredicateKind;
  selector?: string;
  expected?: string | number;
}

/**
 * SPEC §6.1 — an assertion is either:
 *  - deterministic: a checkable predicate, checked with ZERO LLM at check time; or
 *  - semantic: judged by one batched LLM verdict, OFF the hot path (SPEC §6.3).
 * `nl` always carries the natural-language statement of the requested change.
 */
export type Assertion =
  | { type: "deterministic"; predicate: DeterministicPredicate; nl: string }
  | { type: "semantic"; nl: string };

/** SPEC §7.3 — `ambiguous` is a defined state with a reason, never a vague middle. */
export type AmbiguousReason =
  | "replay-failed" // selector ladder exhausted / flake-after-retry; state unreachable
  | "semantic-low-confidence" // reached the state, but the LLM verdict was uncertain
  | "semantic-needs-human"; // reached the state, but judging it requires taste

export type VerdictStatus = "pass" | "fail" | "ambiguous";

export interface Verdict {
  status: VerdictStatus;
  /** present iff `status === "ambiguous"` (SPEC §7.3) */
  ambiguousReason?: AmbiguousReason;
  /** a verdict becomes ground truth only on human approval (SPEC §7.5) */
  humanApproved: boolean;
  /** the build (commit SHA) this verdict is a property of (SPEC §9.1, §11.1) */
  buildSha?: string;
}

/** SPEC §13.2 — selector ladder rung used to (re)resolve an element at replay. */
export type SelectorStrategy = "data-testid" | "role+name" | "text" | "xpath";

export interface SelectorRef {
  strategy: SelectorStrategy;
  value: string;
  /** lower-priority fallbacks, tried in ladder order at replay time (SPEC §13.2) */
  fallbacks?: { strategy: SelectorStrategy; value: string }[];
}

/** A single recorded step in a deterministic action sequence (SPEC §3). */
export type ActionKind =
  | "navigate"
  | "click"
  | "type"
  | "press"
  | "select"
  | "wait";

export interface Action {
  kind: ActionKind;
  target?: SelectorRef;
  /** text to type, key to press, url to navigate to, option to select, etc. */
  value?: string;
}

/** SPEC §3 — DOM + screenshot captured at the commented moment. */
export interface Snapshot {
  url: string;
  /** DOM path of the anchored element — the grounded-in-location anchor (SPEC §10.5) */
  domPath: string;
  /** serialized DOM at the moment (added M3+) */
  html?: string;
  /** filesystem path to the screenshot artifact (SPEC §14.5) */
  screenshotPath?: string;
  /** the commented region within the screenshot */
  screenshotRegion?: { x: number; y: number; width: number; height: number };
}

/**
 * SPEC §7.1 / §7.4 — a mission's DURABLE identity is `{id, NL intent, typed
 * criteria}`. The action sequence is a build-specific *cache*, NOT identity.
 */
export interface Mission {
  id: string;
  name: string;
  description: string; // NL description
  intendedSteps: string[]; // ordered intended steps, in language (the durable intent)
  acceptanceCriteria: Assertion[]; // typed exactly like comment assertions (SPEC §7.1)
}

/** SPEC §10.2 — comment taxonomy, routed mechanically by UI affordance (SPEC §10.3). */
export type CommentType = "step-anchored" | "mission-level" | "meta";

/**
 * SPEC §3 — the grounded executable feedback tuple.
 *
 * In M1, comments are grounded-IN-LOCATION only (URL + DOM path + screenshot
 * region) and NOT replayable (SPEC §10.5) — so `actionSequence` and `assertion`
 * are absent until M3+/M5, when feedback first attaches to a deterministic trace.
 */
export interface Comment {
  id: string;
  type: CommentType;
  missionId?: string; // present for step-anchored & mission-level
  stepIndex?: number; // present for step-anchored
  nl: string; // what the human said
  snapshot: Snapshot; // read off the trace (M3+) or captured live (M1)
  actionSequence?: Action[]; // M5: deterministic steps to reach the state
  assertion?: Assertion; // M5: emitted by the spec-extractor (SPEC §10.4)
}

// ── Walk artifacts (additive; existing types above are frozen) ───────────────

/** SPEC §14.5 — a captured artifact reference; bytes live on disk, metadata holds the path. */
export interface CaptureRef {
  kind: "screenshot" | "dom" | "video";
  path: string;
}

/** One captured step of a mission walk (SPEC §7, §14.5). */
export interface StepCapture {
  index: number;
  actionKind: ActionKind;
  url: string;
  screenshot: string; // artifact path
  dom: string; // artifact path (serialized HTML)
}

/**
 * A mission's walk trace. The compiled Action[] is a build-specific cache, NOT
 * identity (SPEC §7.4). `entryRoute` is the mechanical mission->route signal the
 * M5 touched-routes manifest builds on.
 */
export interface MissionTrace {
  missionId: string;
  reached: boolean; // did replay reach the terminal state?
  attempts: number;
  entryRoute: string;
  steps: StepCapture[];
  video?: string; // artifact path
  terminalUrl: string;
  httpStatus?: number;
  consoleErrors: string[];
}

/**
 * A mission's result for one build: its (provisional) verdict + the trace that
 * produced it. The optional fields are forward-compat for M5's §7.5
 * promotion/retirement so frozen types above don't need to change.
 */
export interface MissionRun {
  mission: Mission;
  verdict: Verdict;
  trace: MissionTrace;
  regressionPromoted?: boolean;
  retirementProposed?: { reason: string };
}

/** A whole run for one app build; `missions` is sorted failed > ambiguous > passed. */
export interface RunRecord {
  appId: string;
  buildSha: string;
  missions: MissionRun[];
}
