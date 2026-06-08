/**
 * M3-D — Playwright harness (real Chromium + canned app).
 * Run: `npx tsx scripts/verify-harness.ts`.
 *
 * Proves: selector ladder (resolve + loud fall-through + loud miss); the settling
 * predicate as a CONJUNCTION (mutation / RAF / fetch each block, true only when
 * all quiet) with a focused RAF check; executor replays a real Action[]; replay
 * yields replay-failed only after exactly one fresh-context retry; loopback
 * navigation is not a false timeout.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import type { Browser } from "playwright";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { startApp } from "../src/lib/core/runner/app-runner";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";
import {
  installSettle,
  waitForSettled,
  type SettleWindow,
} from "../src/lib/core/harness/settle";
import { resolveSelector } from "../src/lib/core/harness/selector-ladder";
import { executeSequence } from "../src/lib/core/harness/executor";
import { replaySequence } from "../src/lib/core/harness/replay";
import { ClientContextIsolation } from "../src/lib/core/walk/isolation";
import type { Action } from "../src/lib/core/domain/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function freshPage(browser: Browser, url: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installSettle(page);
  await page.goto(url, { waitUntil: "load" });
  await waitForSettled(page);
  return { ctx, page };
}

async function main(): Promise<void> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (e) {
    console.error("Could not launch Chromium. Run: npx playwright install chromium");
    throw e;
  }

  const generated = instrument(await buildApp(new StubProvider(), "a todo app"));
  const id = "verify-harness";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);
  const running = await startApp(repo.dir, { id });

  // loopback navigation settled (not a false timeout from the egress proxy)
  const g = await freshPage(browser, running.url);
  truthy("loopback navigation settles (not a false timeout)", true);

  // selector ladder
  const r1 = await resolveSelector(g.page, { strategy: "data-testid", value: "title" });
  truthy("ladder resolves a real testid", r1.usedStrategy === "data-testid");
  const r2 = await resolveSelector(g.page, {
    strategy: "data-testid",
    value: "does-not-exist",
    fallbacks: [{ strategy: "text", value: "Add" }],
  });
  truthy("ladder falls through to a fallback (loud)", r2.usedStrategy === "text");
  let missed = false;
  try {
    await resolveSelector(g.page, { strategy: "data-testid", value: "nope-nothing" });
  } catch {
    missed = true;
  }
  truthy("ladder loud miss throws", missed);

  // settling conjunction + focused RAF (white-box)
  const base = await g.page.evaluate(() => {
    const w = window as unknown as SettleWindow;
    return w.__selfqa_isSettled ? w.__selfqa_isSettled(500) : false;
  });
  truthy("baseline: all three quiet -> settled", base === true);

  await g.page.evaluate(() => {
    document.body.setAttribute("data-selfqa-x", String(Date.now()));
  });
  const afterMut = await g.page.evaluate(() => {
    const w = window as unknown as SettleWindow;
    return w.__selfqa_isSettled!(500);
  });
  truthy("recent mutation -> NOT settled", afterMut === false);

  // Passed as a STRING so esbuild/tsx does not inject its `__name` helper (which
  // is undefined in the page) for the self-referencing rAF loop.
  await g.page.evaluate(
    "(() => { var w = window; w.__selfqa_raf_stop = false; function tick(){ if (!w.__selfqa_raf_stop) requestAnimationFrame(tick); } requestAnimationFrame(tick); })()",
  );
  const duringRaf = await g.page.evaluate(() => {
    const w = window as unknown as SettleWindow;
    return w.__selfqa_isSettled!(0);
  });
  truthy("RAF loop running -> NOT settled (focused RAF term)", duringRaf === false);
  await g.page.evaluate(() => {
    const w = window as unknown as SettleWindow;
    w.__selfqa_raf_stop = true;
  });

  const duringFetch = await g.page.evaluate(() => {
    const w = window as unknown as SettleWindow;
    w.__selfqa_settle!.pendingFetches++;
    const r = w.__selfqa_isSettled!(0);
    w.__selfqa_settle!.pendingFetches--;
    return r;
  });
  truthy("pending fetch -> NOT settled (fetch term)", duringFetch === false);

  await new Promise((r) => setTimeout(r, 650));
  const settledAgain = await g.page.evaluate(() => {
    const w = window as unknown as SettleWindow;
    return w.__selfqa_isSettled!(500);
  });
  truthy("after quiet -> settled again (conjunction)", settledAgain === true);
  await g.ctx.close();

  // executor replays a real sequence
  const g2 = await freshPage(browser, running.url);
  const actions: Action[] = [
    { kind: "type", target: { strategy: "data-testid", value: "todo-input" }, value: "harness task" },
    { kind: "click", target: { strategy: "data-testid", value: "add-button" } },
  ];
  await executeSequence(g2.page, actions);
  const count = await g2.page.getByTestId("todo-item").count();
  truthy("executor added a todo via type+click (1 item)", count === 1);
  await g2.ctx.close();

  // replay retry-once semantics
  const iso = new ClientContextIsolation();
  const okR = await replaySequence(
    browser,
    iso,
    running.url,
    [{ kind: "click", target: { strategy: "data-testid", value: "add-button" } }],
    { retries: 1 },
  );
  truthy("replay success -> attempts=1", okR.ok && okR.attempts === 1);
  const failR = await replaySequence(
    browser,
    iso,
    running.url,
    [{ kind: "click", target: { strategy: "data-testid", value: "ghost-element" } }],
    { retries: 1 },
  );
  truthy(
    "forced miss -> replay-failed after exactly one retry (attempts=2)",
    !failR.ok && failR.attempts === 2,
  );

  await running.stop();
  await closeBrowser();

  if (failures) {
    console.error("\n" + failures + " harness check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: Playwright harness green (ladder + settling conjunction + retry)");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
