/**
 * M5-J — convergence loop control (pure; injected fake iteration, no builds).
 * Run: `npx tsx scripts/verify-converge.ts`.
 */
import { readFileSync } from "node:fs";
import { converge } from "../src/lib/core/rewalk/loop";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function main(): Promise<void> {
  // never resolves -> loops to the mechanical cap, then unresolved
  const r1 = await converge({ commentIds: ["c1"], cap: 3, runIteration: async () => ({ resolved: [] }) });
  truthy("never-resolves loops exactly to cap", r1.iterations === 3);
  truthy("after cap -> unresolved (needs-human)", r1.unresolvedCommentIds.includes("c1"));
  truthy("attempts counted (3)", r1.attemptsByComment["c1"] === 3);

  // resolves on attempt 2
  let n = 0;
  const r2 = await converge({
    commentIds: ["c2"],
    cap: 3,
    runIteration: async () => {
      n++;
      return { resolved: n >= 2 ? ["c2"] : [] };
    },
  });
  truthy("resolves on attempt 2 (stops early)", r2.resolvedCommentIds.includes("c2") && r2.iterations === 2 && r2.attemptsByComment["c2"] === 2);

  // mixed: a resolves iter 1, b never
  const r3 = await converge({
    commentIds: ["a", "b"],
    cap: 3,
    runIteration: async (un) => ({ resolved: un.includes("a") ? ["a"] : [] }),
  });
  truthy("mixed: a resolved, b unresolved at cap", r3.resolvedCommentIds.includes("a") && r3.unresolvedCommentIds.includes("b"));
  truthy("cap is a mechanical count (a:1 attempt, b:3 attempts)", r3.attemptsByComment["a"] === 1 && r3.attemptsByComment["b"] === 3);

  // P1 guard: scope never comes from editApp.changed in loop/gate
  const loopSrc = readFileSync("src/lib/core/rewalk/loop.ts", "utf8");
  const gateSrc = readFileSync("src/lib/core/regression/gate.ts", "utf8");
  truthy("loop/gate never reference .changed (re-walk scope = diff only, P1)", !/\.changed\b/.test(loopSrc) && !/\.changed\b/.test(gateSrc));

  if (failures) {
    console.error("\n" + failures + " converge check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-J convergence loop green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
