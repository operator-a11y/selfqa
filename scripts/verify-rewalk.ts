/**
 * M5-I — re-walk + re-assert (the headline; real Chromium; StubProvider, no API key).
 * Run: `npx tsx scripts/verify-rewalk.ts`.
 *
 * Proves the §3 novelty end-to-end: a STEP-ANCHORED comment on a REACHED-but-non-
 * pass mission whose text-equals(title) assertion is FALSE before -> tuple ->
 * codegen consumes it (writes the expected title) -> re-walk REPLAYS + RE-ASSERTS
 * -> the deterministic assertion FLIPS fail->pass. Plus: touched -> recompile,
 * untouched -> replay (recompileRate).
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, currentSha, diffFiles, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { startApp, rebuildApp } from "../src/lib/core/runner/app-runner";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";
import { ClientContextIsolation } from "../src/lib/core/walk/isolation";
import { runMissions } from "../src/lib/core/run";
import { assembleTuple } from "../src/lib/core/codegen/tuple";
import { editFromTuples } from "../src/lib/core/codegen/edit-agent";
import { classifyDiff } from "../src/lib/core/verify/manifest";
import { planReWalk } from "../src/lib/core/rewalk/plan";
import { reWalk } from "../src/lib/core/rewalk/run-rewalk";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}
async function titleOf(dir: string): Promise<string> {
  const page = await fs.readFile(path.join(dir, "src/app/page.tsx"), "utf8");
  const m = page.match(/data-testid="title"[^>]*>([\s\S]*?)<\//);
  return m ? m[1].trim() : "";
}

async function main(): Promise<void> {
  const provider = new StubProvider();
  const generated = instrument(await buildApp(provider, "a todo app"));
  const id = "verify-rewalk";
  await fs.rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);
  const running = await startApp(repo.dir, { id });
  const browser = await getBrowser();
  const iso = new ClientContextIsolation();

  const shaBefore = await currentSha(repo.dir);
  const firstRun = await runMissions({ provider, browser, iso, baseUrl: running.url, runId: "run1", appId: id, app: generated, buildSha: shaBefore });
  const m = firstRun.missions.find((x) => x.mission.id === "mission-add-todo")!;
  truthy("mission-add-todo reached on first walk", m.trace.reached);
  truthy("mission-add-todo is NOT pass (a non-passing reached mission)", m.verdict.status !== "pass");

  // comment step-anchored on the terminal step (captured title = "Todo")
  const stepIndex = m.trace.steps.length - 1;
  const tuple = await assembleTuple(provider, { trace: m.trace, stepIndex, nl: "the title should indicate it was edited", commentType: "step-anchored" });
  truthy("tuple assembled from the coordinate", tuple.ok);
  if (!tuple.ok) throw new Error("tuple not assembled");
  const fb = tuple.feedback;

  // codegen consumes the tuple -> writes the expected title
  await editFromTuples(provider, { dir: repo.dir, feedback: [fb] });
  truthy("edit set the title to the assertion's expected value", (await titleOf(repo.dir)) === "Todo (edited by SelfQA)");

  const shaAfter = await currentSha(repo.dir);
  const changed = await diffFiles(repo.dir, shaBefore, shaAfter);
  truthy("re-walk scope derived from the git diff (page.tsx)", changed.includes("src/app/page.tsx"));
  const cls = classifyDiff(changed);

  const rebuilt = await rebuildApp(running);
  const priorTraces = new Map(firstRun.missions.map((x) => [x.mission.id, x.trace]));
  const plan = await planReWalk(provider, { app: generated, missions: [m.mission], priorTraces, cls });
  const record = await reWalk({ provider, browser, iso, baseUrl: rebuilt.url, runId: "run2", buildSha: shaAfter, feedback: [fb], plans: plan.plans, recompiled: plan.recompiled });

  const outcome = record.outcomes[0];
  truthy(
    "THE ASSERTION FLIPS fail->pass on re-walk",
    outcome.assertionResult === "flipped" && outcome.verdict.status === "pass" && outcome.resolved,
  );
  truthy("touched route -> recompiled (recompileRate > 0)", record.recompileRate > 0);

  // untouched -> replay (recompiled false)
  const planUntouched = await planReWalk(provider, { app: generated, missions: [m.mission], priorTraces, cls: classifyDiff(["src/app/other/page.tsx"]) });
  truthy("untouched route -> replay (recompiled false, zero LLM)", planUntouched.recompiled[m.mission.id] === false);

  await rebuilt.stop();
  await closeBrowser();

  if (failures) {
    console.error("\n" + failures + " re-walk check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-I re-walk + re-assert — the assertion flips fail->pass (no API key, no LLM in hot path)");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
