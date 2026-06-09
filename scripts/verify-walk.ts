/**
 * M4-A — mission walking + per-step capture (real Chromium + canned app).
 * Run: `npx tsx scripts/verify-walk.ts`.
 *
 * Proves: derive -> compile (off hot path) -> walk each mission in a fresh
 * isolated context -> per-step screenshot+DOM + per-mission video on disk
 * (path-only metadata) + entryRoute; mission-to-mission isolation (B doesn't see
 * A's writes); an unresolved selector -> reached:false -> checkAssertion null
 * (could-not-evaluate, never a false element-absent) against REAL Playwright; and
 * the diffFiles primitive (M5 manifest foundation).
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { rm, access } from "node:fs/promises";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { deriveMissions } from "../src/lib/core/codegen/mission-deriver";
import { compileSequence } from "../src/lib/core/codegen/mission-compiler";
import {
  writeGeneratedApp,
  commitAll,
  currentSha,
  diffFiles,
  WORKSPACE_ROOT,
} from "../src/lib/core/workspace/repo";
import { startApp } from "../src/lib/core/runner/app-runner";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";
import { ClientContextIsolation } from "../src/lib/core/walk/isolation";
import { walkMission, walkAll, type MissionPlan } from "../src/lib/core/walk/walker";
import { checkAssertion } from "../src/lib/core/verify/checker";
import { resolveTuplePrefix } from "../src/lib/core/walk/comment-anchor";
import type { Action } from "../src/lib/core/domain/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
function countItems(html: string): number {
  return (html.match(/data-testid="todo-item"/g) ?? []).length;
}

async function main(): Promise<void> {
  const browser = await getBrowser();
  const provider = new StubProvider();
  const generated = instrument(await buildApp(provider, "a todo app"));
  const id = "verify-walk";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);
  const running = await startApp(repo.dir, { id });

  // derive -> compile (off the hot path)
  const { missions } = await deriveMissions(provider, { appPrompt: "a todo app", files: generated.files });
  const plans: MissionPlan[] = [];
  for (const m of missions) {
    plans.push({ mission: m, actions: await compileSequence(provider, m, generated.files) });
  }
  truthy("compiled an Action[] for every mission", plans.length === missions.length);

  const iso = new ClientContextIsolation();
  const walked = await walkAll(browser, iso, running.url, "run1", plans, 4);
  truthy("walked all missions", walked.length === missions.length);
  truthy("all missions reached terminal state", walked.every((w) => w.trace.reached));

  const addTodo = walked.find((w) => w.trace.missionId === "mission-add-todo")!;
  truthy(
    "per-step screenshot+DOM on disk (path-only metadata)",
    addTodo.trace.steps.length > 0 &&
      (await exists(addTodo.trace.steps[0].screenshot)) &&
      (await exists(addTodo.trace.steps[0].dom)),
  );
  truthy(
    "per-mission video on disk",
    !!addTodo.trace.video && (await exists(addTodo.trace.video)),
  );
  truthy("entryRoute captured", addTodo.trace.entryRoute === "/");

  // isolation: add-todo terminal has 1 item; page-loads terminal has 0 (no leak)
  const pageLoads = walked.find((w) => w.trace.missionId === "mission-page-loads")!;
  const addDom = await fs.readFile(addTodo.trace.steps[addTodo.trace.steps.length - 1].dom, "utf8");
  const loadsDom = await fs.readFile(pageLoads.trace.steps[pageLoads.trace.steps.length - 1].dom, "utf8");
  truthy("isolation: add-todo terminal shows 1 todo-item", countItems(addDom) === 1);
  truthy("isolation: page-loads terminal shows 0 todo-items (no leak from add-todo)", countItems(loadsDom) === 0);

  // unresolved selector -> reached:false -> checkAssertion null (could-not-evaluate)
  const ghostActions: Action[] = [
    { kind: "click", target: { strategy: "data-testid", value: "ghost-element" } },
  ];
  const ghost = await walkMission(browser, iso, running.url, "run-ghost", missions[0], ghostActions, { retries: 1 });
  truthy("failing replay -> reached=false after one retry (attempts=2)", ghost.trace.reached === false && ghost.trace.attempts === 2);
  const nullCheck = checkAssertion(
    { type: "deterministic", predicate: { kind: "element-absent", selector: "[data-testid=anything]" }, nl: "x" },
    ghost.observed,
  );
  truthy(
    "unreached state -> checkAssertion null (could-not-evaluate, NOT false-absent)",
    nullCheck.satisfied === null && nullCheck.detail.includes("could-not-evaluate"),
  );
  // A FAILED walk must retain its PARTIAL trace (navigate + failure-point snapshot)
  // so the mission stays commentable — NOT an empty trace -> needs-human (§7.3).
  truthy(
    "failed walk retains a partial trace (steps > 0, not discarded)",
    ghost.trace.steps.length > 0,
  );
  const ghostResolve = await resolveTuplePrefix(ghost.trace);
  truthy(
    "failed mission is commentable (resolves to a step, NOT empty-trace)",
    "actionSequencePrefix" in ghostResolve,
  );

  // diffFiles primitive (M5 manifest foundation)
  const sha1 = await currentSha(repo.dir);
  const pagePath = path.join(repo.dir, "src/app/page.tsx");
  await fs.writeFile(pagePath, (await fs.readFile(pagePath, "utf8")) + "\n// touched", "utf8");
  const sha2 = await commitAll(repo.dir, "touch page");
  const changed = await diffFiles(repo.dir, sha1, sha2);
  truthy("diffFiles reports the changed file", changed.includes("src/app/page.tsx"));

  await running.stop();
  await closeBrowser();

  if (failures) {
    console.error("\n" + failures + " walk check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M4-A walk + capture green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
