/**
 * M3-A — direct zod unit test of the SHARED schema (no LLM, no browser).
 *
 * This is the REAL guard for the spec-extractor refactor: verify-loop.ts's stub
 * path returns hardcoded JSON that always validates, so it cannot catch a schema
 * regression. This can. Run: `npx tsx scripts/verify-schema.ts`.
 */
import { AssertionSchema, MissionSchema, coerceAssertion } from "../src/lib/core/codegen/schema";
import type { ZodTypeAny } from "zod";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log("ok   " + name);
  } catch (e) {
    failures++;
    console.error("FAIL " + name + ": " + (e instanceof Error ? e.message : String(e)));
  }
}
function good(name: string, schema: ZodTypeAny, val: unknown): void {
  check(name, () => {
    schema.parse(val);
  });
}
function bad(name: string, schema: ZodTypeAny, val: unknown): void {
  check(name, () => {
    let threw = false;
    try {
      schema.parse(val);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected parse to throw, but it succeeded");
  });
}

good("assertion: deterministic + predicate", AssertionSchema, {
  type: "deterministic",
  predicate: { kind: "url-equals", expected: "/login" },
  nl: "should land on /login",
});
good("assertion: semantic", AssertionSchema, {
  type: "semantic",
  nl: "this feels cluttered",
});
good("assertion: deterministic text-equals", AssertionSchema, {
  type: "deterministic",
  predicate: { kind: "text-equals", selector: "[data-testid=title]", expected: "Todo" },
  nl: "title should say Todo",
});
bad("assertion: missing type", AssertionSchema, {
  predicate: { kind: "url-equals" },
  nl: "x",
});
bad("assertion: bad predicate kind", AssertionSchema, {
  type: "deterministic",
  predicate: { kind: "frobnicate" },
  nl: "x",
});
bad("assertion: deterministic missing predicate", AssertionSchema, {
  type: "deterministic",
  nl: "x",
});

good("mission: valid", MissionSchema, {
  id: "mission-signup-valid",
  name: "Sign up with a valid email",
  description: "Fill the form and submit",
  intendedSteps: ["go to /signup", "enter a valid email", "submit"],
  acceptanceCriteria: [{ type: "semantic", nl: "lands on dashboard" }],
});
bad("mission: bad id", MissionSchema, {
  id: "Mission_1",
  name: "n",
  description: "d",
  intendedSteps: ["s"],
  acceptanceCriteria: [{ type: "semantic", nl: "x" }],
});
bad("mission: empty intendedSteps", MissionSchema, {
  id: "mission-x",
  name: "n",
  description: "d",
  intendedSteps: [],
  acceptanceCriteria: [{ type: "semantic", nl: "x" }],
});
bad("mission: empty acceptanceCriteria", MissionSchema, {
  id: "mission-x",
  name: "n",
  description: "d",
  intendedSteps: ["s"],
  acceptanceCriteria: [],
});

// coerceAssertion — robustness to a real model's creative output (never throws).
function eq(name: string, a: unknown, b: unknown): void {
  check(name, () => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  });
}
// a valid deterministic assertion passes through unchanged.
eq("coerce: valid deterministic passes through", coerceAssertion({ type: "deterministic", predicate: { kind: "text-equals", selector: "#t", expected: "x" }, nl: "n" }), { type: "deterministic", predicate: { kind: "text-equals", selector: "#t", expected: "x" }, nl: "n" });
// an INVALID kind (the real-model bug) degrades to semantic, never throws.
eq("coerce: invalid kind -> semantic", coerceAssertion({ type: "deterministic", predicate: { kind: "element-contains", selector: "#t", expected: "x" }, nl: "should contain x" }), { type: "semantic", nl: "should contain x" });
// a boolean `expected` on a kind that needs none -> drop it, stay deterministic.
eq("coerce: boolean expected on element-visible -> drop, stay deterministic", coerceAssertion({ type: "deterministic", predicate: { kind: "element-visible", selector: "#b", expected: true }, nl: "button visible" }), { type: "deterministic", predicate: { kind: "element-visible", selector: "#b" }, nl: "button visible" });
// a boolean `expected` on a kind that REQUIRES one (text-equals) -> semantic.
eq("coerce: boolean expected on text-equals -> semantic", coerceAssertion({ type: "deterministic", predicate: { kind: "text-equals", selector: "#t", expected: true }, nl: "title edited" }), { type: "semantic", nl: "title edited" });
// a valid semantic passes through.
eq("coerce: semantic passes through", coerceAssertion({ type: "semantic", nl: "looks nice" }), { type: "semantic", nl: "looks nice" });
// total garbage -> a safe semantic (never throws).
check("coerce: garbage -> safe semantic (no throw)", () => {
  const c = coerceAssertion({ wat: 1 });
  if (c.type !== "semantic" || !c.nl) throw new Error("expected a semantic fallback with nl");
});

if (failures) {
  console.error("\n" + failures + " schema check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: shared schema unit test green");
