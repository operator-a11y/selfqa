/**
 * M5-J — fix-induced regression gate + revert primitive (git + fs; no browser).
 * Run: `npx tsx scripts/verify-gate.ts`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { evaluateRegressionGate, deriveRegressionKind } from "../src/lib/core/regression/gate";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, currentSha, commitAll, resetHardTo, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function main(): Promise<void> {
  // gate routing (relationship #2 vs #3)
  const det = evaluateRegressionGate([{ testId: "r1", kind: "deterministic", wasPass: true, flippedToFail: true }]);
  truthy("deterministic frozen flip -> hard-block (blocked)", det.blocked && det.hardBlocks.includes("r1"));
  const sem = evaluateRegressionGate([{ testId: "r2", kind: "semantic", wasPass: true, flippedToFail: true }]);
  truthy("semantic frozen flip -> surfaced, NOT blocked", !sem.blocked && sem.surfaced.includes("r2"));
  const green = evaluateRegressionGate([{ testId: "r3", kind: "deterministic", wasPass: true, flippedToFail: false }]);
  truthy("still-green deterministic -> no block", !green.blocked);
  const wasFail = evaluateRegressionGate([{ testId: "r4", kind: "deterministic", wasPass: false, flippedToFail: true }]);
  truthy("a test that was not passing -> not a regression block", !wasFail.blocked);

  // kind derivation
  truthy("all-deterministic criteria -> deterministic kind", deriveRegressionKind([{ type: "deterministic", predicate: { kind: "url-equals", expected: "/" }, nl: "x" }]) === "deterministic");
  truthy("any semantic criterion -> semantic kind", deriveRegressionKind([{ type: "deterministic", predicate: { kind: "url-equals", expected: "/" }, nl: "x" }, { type: "semantic", nl: "y" }]) === "semantic");

  // revert primitive (a hard-block reverts the edit; the diff backbone never records it)
  const provider = new StubProvider();
  const generated = instrument(await buildApp(provider, "a todo app"));
  const id = "verify-gate";
  await fs.rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);
  const sha1 = await currentSha(repo.dir);
  const page = path.join(repo.dir, "src/app/page.tsx");
  await fs.writeFile(page, (await fs.readFile(page, "utf8")) + "\n// bad edit", "utf8");
  await commitAll(repo.dir, "bad edit that flips a frozen test");
  await resetHardTo(repo.dir, sha1);
  truthy("hard-block reverts to the pre-edit SHA", (await currentSha(repo.dir)) === sha1);
  truthy("reverted file no longer has the bad edit", !(await fs.readFile(page, "utf8")).includes("// bad edit"));

  if (failures) {
    console.error("\n" + failures + " gate check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-J regression gate + revert green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
