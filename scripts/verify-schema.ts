/**
 * M3-A — direct zod unit test of the SHARED schema (no LLM, no browser).
 *
 * This is the REAL guard for the spec-extractor refactor: verify-loop.ts's stub
 * path returns hardcoded JSON that always validates, so it cannot catch a schema
 * regression. This can. Run: `npx tsx scripts/verify-schema.ts`.
 */
import { AssertionSchema, MissionSchema } from "../src/lib/core/codegen/schema";
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

if (failures) {
  console.error("\n" + failures + " schema check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: shared schema unit test green");
