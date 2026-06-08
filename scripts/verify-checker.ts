/**
 * M3-A — unit test of the ONE checker (no LLM, no browser).
 * Run: `npx tsx scripts/verify-checker.ts`.
 */
import {
  checkAssertion,
  isFirstWalkAutoAssertable,
  FIRST_WALK_WHITELIST,
  type ObservedState,
  type ResolvedElement,
} from "../src/lib/core/verify/checker";
import type { Assertion, DeterministicPredicate } from "../src/lib/core/domain/types";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log("ok   " + name + " = " + JSON.stringify(actual));
  } else {
    failures++;
    console.error(
      "FAIL " + name + ": got " + JSON.stringify(actual) + " expected " + JSON.stringify(expected),
    );
  }
}
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

interface StateOver {
  url?: string;
  httpStatus?: number;
  consoleErrors?: string[];
  formValidationBlocked?: boolean;
  qmap?: Record<string, ResolvedElement>;
  qnull?: boolean;
}
function state(o: StateOver = {}): ObservedState {
  const qmap = o.qmap ?? {};
  return {
    url: o.url ?? "http://x/",
    httpStatus: o.httpStatus,
    consoleErrors: o.consoleErrors ?? [],
    formValidationBlocked: o.formValidationBlocked,
    q: o.qnull
      ? () => null
      : (sel: string) =>
          sel in qmap ? qmap[sel] : { present: false, visible: false, text: "" },
  };
}
const det = (predicate: DeterministicPredicate): Assertion => ({
  type: "deterministic",
  predicate,
  nl: "x",
});

// deterministic pass/fail
eq("http-status pass", checkAssertion(det({ kind: "http-status", expected: 200 }), state({ httpStatus: 200 })).satisfied, true);
eq("http-status fail", checkAssertion(det({ kind: "http-status", expected: 200 }), state({ httpStatus: 500 })).satisfied, false);
eq("url-equals pass", checkAssertion(det({ kind: "url-equals", expected: "http://x/login" }), state({ url: "http://x/login" })).satisfied, true);
eq("console-error-absent pass", checkAssertion(det({ kind: "console-error-absent" }), state({ consoleErrors: [] })).satisfied, true);
eq("console-error-absent fail", checkAssertion(det({ kind: "console-error-absent" }), state({ consoleErrors: ["boom"] })).satisfied, false);

// semantic -> null
eq("semantic -> null", checkAssertion({ type: "semantic", nl: "cluttered" }, state()).satisfied, null);

// element-visible found+visible
eq(
  "element-visible pass",
  checkAssertion(det({ kind: "element-visible", selector: "[data-testid=error]" }), state({ qmap: { "[data-testid=error]": { present: true, visible: true, text: "" } } })).satisfied,
  true,
);

// q()===null -> could-not-evaluate (null), NOT false
const cne = checkAssertion(det({ kind: "element-visible", selector: "[data-testid=error]" }), state({ qnull: true }));
eq("element-visible q()=null -> null", cne.satisfied, null);
truthy("could-not-evaluate detail", cne.detail.includes("could-not-evaluate"));

// CRITICAL: element-absent must NOT read q()===null as satisfied:true
const absNull = checkAssertion(det({ kind: "element-absent", selector: "[data-testid=error]" }), state({ qnull: true }));
eq("element-absent q()=null -> null (not true)", absNull.satisfied, null);
// element-absent on a reachable page with no match -> true
eq("element-absent reachable+absent -> true", checkAssertion(det({ kind: "element-absent", selector: "[data-testid=error]" }), state({ qmap: {} })).satisfied, true);

// whitelist: text-equals excluded
truthy("text-equals NOT in FIRST_WALK_WHITELIST", !FIRST_WALK_WHITELIST.has("text-equals"));
eq("text-equals not auto-assertable", isFirstWalkAutoAssertable(det({ kind: "text-equals", selector: "[data-testid=title]", expected: "Todo" })), false);
// happy-path positive selector not auto-assertable; known-error selector is
eq("happy-path element-visible not auto-assertable", isFirstWalkAutoAssertable(det({ kind: "element-visible", selector: "[data-testid=todo-item]" })), false);
eq("known-error element-visible auto-assertable", isFirstWalkAutoAssertable(det({ kind: "element-visible", selector: "[data-testid=error]" })), true);
eq("http-status auto-assertable", isFirstWalkAutoAssertable(det({ kind: "http-status", expected: 200 })), true);

if (failures) {
  console.error("\n" + failures + " checker check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: checker unit test green (no LLM, no browser)");
