/**
 * Regression: commitAll must be EMPTY-SAFE. Run: `npx tsx scripts/verify-commit-safe.ts`.
 * FAST (git + fs only; no browser, no LLM).
 *
 * A comment whose edit changes nothing used to crash the loop: `git commit` exits
 * non-zero ("nothing to commit"), surfacing a raw "Command failed: git … commit"
 * error in the UI. commitAll now skips the commit and returns the unchanged SHA, so
 * a no-op edit is a normal outcome (shaAfter === shaBefore) the worker can report.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { rm } from "node:fs/promises";
import { writeGeneratedApp, commitAll, currentSha, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function main(): Promise<void> {
  const id = "verify-commit-safe";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  try {
    const repo = await writeGeneratedApp(id, [
      { path: "package.json", content: '{"name":"x"}' },
      { path: "a.txt", content: "one" },
    ]);
    const sha0 = await currentSha(repo.dir);

    // no change -> empty-safe: returns the unchanged sha, never throws (the bug).
    const shaNoop = await commitAll(repo.dir, "selfqa: edit (1) — add a duplicate task button");
    truthy("no-op commit does NOT crash and returns the unchanged sha", shaNoop === sha0);

    // a real change -> a new sha.
    await fs.writeFile(path.join(repo.dir, "a.txt"), "two", "utf8");
    const sha1 = await commitAll(repo.dir, "selfqa: edit (2)");
    truthy("a real change commits and advances the sha", sha1 !== sha0);

    // no change again, after a real commit -> still the unchanged sha.
    const shaNoop2 = await commitAll(repo.dir, "selfqa: edit (3) — no-op");
    truthy("no-op after a real commit also returns the unchanged sha", shaNoop2 === sha1);
  } finally {
    await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  }

  if (failures) {
    console.error("\n" + failures + " commit-safe check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: commitAll is empty-safe — a no-op edit never crashes the loop");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
