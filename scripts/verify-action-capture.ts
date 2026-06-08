/**
 * M5-A — action-on-step + serializable before-state (real Chromium walk).
 * Run: `npx tsx scripts/verify-action-capture.ts`.
 *
 * Pure: the serde round-trip is lossless for the checker (incl. null = could-not-
 * evaluate). Real: a run yields per-step Actions, trace.actions, and REACHED
 * before-states whose rebuildObservedState reproduces criteriaResults byte-for-byte;
 * an unreached mission yields reached:false (so run.ts persists no before-state).
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, currentSha, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { startApp } from "../src/lib/core/runner/app-runner";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";
import { ClientContextIsolation } from "../src/lib/core/walk/isolation";
import { walkMission } from "../src/lib/core/walk/walker";
import { runMissions } from "../src/lib/core/run";
import { checkAssertion, type ObservedState } from "../src/lib/core/verify/checker";
import {
  serializeObservedState,
  rebuildObservedState,
} from "../src/lib/core/verify/observed-serde";
import type { Action, Assertion } from "../src/lib/core/domain/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function main(): Promise<void> {
  // ── pure serde round-trip ───────────────────────────────────────────────────
  const obs: ObservedState = {
    url: "http://x/",
    consoleErrors: [],
    q: (s) =>
      s === "[data-testid=error]"
        ? { present: true, visible: true, text: "oops" }
        : s === "[data-testid=cne]"
          ? null
          : { present: false, visible: false, text: "" },
  };
  const rebuilt0 = rebuildObservedState(
    serializeObservedState(obs, ["[data-testid=error]", "[data-testid=cne]"]),
  );
  const vis: Assertion = { type: "deterministic", predicate: { kind: "element-visible", selector: "[data-testid=error]" }, nl: "x" };
  const cne: Assertion = { type: "deterministic", predicate: { kind: "element-visible", selector: "[data-testid=cne]" }, nl: "x" };
  const a1 = checkAssertion(vis, obs), b1 = checkAssertion(vis, rebuilt0);
  truthy("serde lossless (visible element)", a1.satisfied === b1.satisfied && a1.detail === b1.detail);
  const a2 = checkAssertion(cne, obs), b2 = checkAssertion(cne, rebuilt0);
  truthy("serde lossless (null = could-not-evaluate)", a2.satisfied === b2.satisfied && a2.detail === b2.detail);

  // ── real walk ───────────────────────────────────────────────────────────────
  const provider = new StubProvider();
  const generated = instrument(await buildApp(provider, "a todo app"));
  const id = "verify-action-capture";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);
  const running = await startApp(repo.dir, { id });
  const browser = await getBrowser();
  const run = await runMissions({
    provider,
    browser,
    iso: new ClientContextIsolation(),
    baseUrl: running.url,
    runId: "run1",
    appId: id,
    app: generated,
    buildSha: await currentSha(repo.dir),
  });

  truthy("every step carries an action", run.missions.every((m) => m.trace.steps.every((s) => !!s.action)));
  truthy("every trace carries its compiled actions[]", run.missions.every((m) => Array.isArray(m.trace.actions)));
  const reached = run.missions.filter((m) => m.trace.reached);
  truthy("reached missions have beforeState + criteriaResults", reached.length > 0 && reached.every((m) => !!m.beforeState && !!m.criteriaResults));

  const sample = reached[0];
  const reproduced = sample.mission.acceptanceCriteria.map((c, ci) => ({
    criterionIndex: ci,
    check: checkAssertion(c, rebuildObservedState(sample.beforeState!)),
  }));
  truthy(
    "rebuild(beforeState) reproduces criteriaResults byte-for-byte",
    JSON.stringify(reproduced) === JSON.stringify(sample.criteriaResults),
  );

  const ghostActions: Action[] = [{ kind: "click", target: { strategy: "data-testid", value: "ghost-element" } }];
  const ghost = await walkMission(browser, new ClientContextIsolation(), running.url, "run-ghost", run.missions[0].mission, ghostActions, { retries: 1 });
  truthy("unreached trace reached=false (run.ts persists no beforeState)", ghost.trace.reached === false);

  await running.stop();
  await closeBrowser();

  if (failures) {
    console.error("\n" + failures + " action-capture check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-A action-on-step + serializable before-state green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
