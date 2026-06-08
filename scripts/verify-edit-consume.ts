/**
 * M5-D — codegen CONSUMES the tuple (no browser; git + fs only).
 * Run: `npx tsx scripts/verify-edit-consume.ts`.
 *
 * The decisive check: two tuples with DIFFERENT assertions produce DIFFERENT
 * edits (output varies with input) — proving consumption, not mere rendering.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { editFromTuples } from "../src/lib/core/codegen/edit-agent";
import { editFromTuplesUserPrompt } from "../src/lib/core/codegen/prompts";
import type { GroundedFeedback } from "../src/lib/core/domain/types";

const exec = promisify(execFile);
let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

function feedback(expected: string): GroundedFeedback {
  return {
    id: "fb-" + expected,
    commentId: "c-" + expected,
    missionId: "mission-x",
    stepIndex: 0,
    commentType: "step-anchored",
    actionSequencePrefix: [
      { kind: "navigate", value: "/" },
      { kind: "click", target: { strategy: "data-testid", value: "add-button" } },
    ],
    snapshot: {
      url: "http://x/",
      domPath: "/tmp/x.html",
      domHtml: '<h1 data-testid="title">Todo</h1>',
      screenshotPath: "/tmp/x.png",
    },
    nl: "the title should say " + expected,
    assertion: {
      type: "deterministic",
      predicate: { kind: "text-equals", selector: "[data-testid=title]", expected },
      nl: "title equals " + expected,
    },
  };
}

async function titleOf(dir: string): Promise<string> {
  const page = await fs.readFile(path.join(dir, "src/app/page.tsx"), "utf8");
  const m = page.match(/data-testid="title"[^>]*>([\s\S]*?)<\//);
  return m ? m[1].trim() : "";
}
async function commitCount(dir: string): Promise<number> {
  const { stdout } = await exec("git", ["rev-list", "--count", "HEAD"], { cwd: dir });
  return Number(stdout.trim());
}

async function main(): Promise<void> {
  // (1) the prompt carries assertion + steps + DOM excerpt
  const prompt = editFromTuplesUserPrompt({
    feedback: [feedback("ZZZ")],
    currentFiles: [{ path: "src/app/page.tsx", content: "x" }],
  });
  truthy("prompt renders the machine-readable assertion", prompt.includes("SELFQA-ASSERT") && prompt.includes('expected="ZZZ"'));
  truthy("prompt renders reproduction steps", prompt.includes("Reproduction steps"));
  truthy("prompt renders the captured DOM excerpt", prompt.includes("Captured DOM excerpt"));

  // (2) output VARIES with the assertion
  const provider = new StubProvider();
  const generated = instrument(await buildApp(provider, "a todo app"));
  const id = "verify-edit-consume";
  await fs.rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);

  await editFromTuples(provider, { dir: repo.dir, feedback: [feedback("AAA-EDIT")] });
  const tA = await titleOf(repo.dir);
  truthy("tuple A -> title 'AAA-EDIT'", tA === "AAA-EDIT");

  await editFromTuples(provider, { dir: repo.dir, feedback: [feedback("BBB-EDIT")] });
  const tB = await titleOf(repo.dir);
  truthy("tuple B -> title 'BBB-EDIT' (OUTPUT VARIES WITH THE ASSERTION)", tB === "BBB-EDIT" && tA !== tB);

  // (3) a batch produces exactly ONE commit
  const before = await commitCount(repo.dir);
  await editFromTuples(provider, { dir: repo.dir, feedback: [feedback("C1"), feedback("C2")] });
  const after = await commitCount(repo.dir);
  truthy("batch of 2 tuples -> exactly ONE commit", after - before === 1);

  if (failures) {
    console.error("\n" + failures + " edit-consume check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-D codegen consumes the tuple (edit varies with the assertion)");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
