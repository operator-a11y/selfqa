/**
 * M4-D — SelfQA review UI, real browser end-to-end (production SelfQA + worker).
 * Run: `npx tsx scripts/verify-ui.ts`.
 *
 * Proves the UI hydrates and the review flow works: Build -> Run missions ->
 * sorted mission list with verdict badges -> select a mission -> step thumbnails.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}
async function waitReady(url: string, tries = 180): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).status < 500) return true;
    } catch {
      /* starting */
    }
    await sleep(500);
  }
  return false;
}
const ok = (p: Promise<unknown>) => p.then(() => true).catch(() => false);

async function main(): Promise<void> {
  console.log("building SelfQA (production)...");
  await exec("npm", ["run", "build"], { cwd: process.cwd(), maxBuffer: 1 << 26 });

  const worker = spawn("npx", ["tsx", "worker/index.ts"], {
    env: { ...process.env, SELFQA_WORKER_PORT: "4317", SELFQA_STORE: "memory" },
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const selfqa = spawn("npm", ["run", "start", "--", "-p", "3100"], {
    env: { ...process.env, SELFQA_WORKER_URL: "http://127.0.0.1:4317" },
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
  });

  try {
    truthy("worker up", await waitReady("http://127.0.0.1:4317/api/health"));
    truthy("SelfQA UI up", await waitReady("http://127.0.0.1:3100"));

    const browser = await getBrowser();
    const page = await (await browser.newContext()).newPage();
    await page.goto("http://127.0.0.1:3100", { waitUntil: "load" });
    await sleep(2000);

    const keys = await page.evaluate(() => {
      const el = document.querySelector("[data-testid=build-button]");
      return el ? Object.keys(el).filter((k) => k.startsWith("__react")).join(",") : "no button";
    });
    truthy("SelfQA UI hydrates (build-button has react fibers)", keys.includes("__react"));

    await page.getByTestId("build-button").click();
    truthy("run-missions appears after build", await ok(page.getByTestId("run-missions-button").waitFor({ timeout: 150000 })));

    await page.getByTestId("run-missions-button").click();
    truthy("mission rows appear after walk", await ok(page.getByTestId("mission-row").first().waitFor({ timeout: 150000 })));
    const rows = await page.getByTestId("mission-row").count();
    truthy("8+ mission rows rendered (" + rows + ")", rows >= 8);

    const badge = await page.locator('[data-testid=mission-row] span').first().textContent();
    truthy("verdict badge text present (" + JSON.stringify(badge) + ")", !!badge && /pass|fail|ambiguous/.test(badge));

    await page.getByTestId("mission-row").first().click();
    truthy("step thumbnails render", await ok(page.getByTestId("step-thumb").first().waitFor({ timeout: 20000 })));

    // The closed loop in the browser: comment on a step -> Re-walk -> flip green.
    await page.getByTestId("step-thumb").first().click();
    await page.getByTestId("comment-input").fill("the title should indicate it was edited");
    await page.getByTestId("comment-submit").click();
    // submit must give IMMEDIATE feedback (button disables + inline progress) so it
    // never looks like "nothing happened" during the ~10s re-walk (regression guard).
    truthy("submit shows inline progress while re-walking", await ok(page.getByTestId("comment-progress").waitFor({ timeout: 5000 })));
    truthy("submit button disables while in flight", await page.getByTestId("comment-submit").isDisabled().catch(() => false));
    truthy("flip-result panel appears after re-walk", await ok(page.getByTestId("flip-result").waitFor({ timeout: 180000 })));
    const flipText = (await page.getByTestId("flip-result").textContent()) ?? "";
    truthy("UI shows the assertion flipped fail->pass (" + flipText.trim().slice(0, 40) + ")", /flipped/.test(flipText));
    // the result also shows INLINE, right under the composer (not only in the sidebar).
    const inline = (await page.getByTestId("comment-result").textContent().catch(() => "")) ?? "";
    truthy("comment result shows inline by the composer (" + inline.trim().slice(0, 32) + ")", /flipped|passes/.test(inline));

    await page.getByTestId("promote-mission").click();
    await page.waitForTimeout(2500);
    const promoteText = (await page.getByTestId("promote-mission").textContent()) ?? "";
    truthy("promote marks the mission a regression test", promoteText.includes("✓"));

    // M5-L: the durable regression-memory registry surfaces in the sidebar.
    truthy("regression memory list appears after promote", await ok(page.getByTestId("regression-list").waitFor({ timeout: 10000 })));
    truthy("a frozen regression test is listed (kind · status)", (await page.getByTestId("regression-row").count()) >= 1);

    // M6-B: the Metrics tab renders the four metrics from the comment we just made.
    await page.getByTestId("tab-metrics").click();
    truthy("metrics panel renders", await ok(page.getByTestId("metrics-panel").waitFor({ timeout: 10000 })));
    truthy("det:semantic metric card shows", await ok(page.getByTestId("metric-det-semantic").waitFor({ timeout: 10000 })));
    const dsText = (await page.getByTestId("metric-det-semantic").textContent()) ?? "";
    truthy("det:semantic card reports a deterministic % (" + dsText.replace(/\s+/g, " ").trim().slice(0, 40) + ")", /deterministic/.test(dsText) && /%/.test(dsText));
    truthy("attempts histogram card shows", await ok(page.getByTestId("metric-attempts").waitFor({ timeout: 10000 })));

    // M7 (optional): the supplementary coverage crawl surfaces states beyond the missions.
    await page.getByTestId("tab-coverage").click();
    truthy("coverage panel renders", await ok(page.getByTestId("coverage-panel").waitFor({ timeout: 10000 })));
    truthy("coverage headline appears after the crawl", await ok(page.getByTestId("coverage-headline").waitFor({ timeout: 60000 })));
    const covText = (await page.getByTestId("coverage-headline").textContent()) ?? "";
    truthy("coverage is framed as beyond-missions (" + covText.trim().slice(0, 48) + ")", /beyond your missions/.test(covText));

    await closeBrowser();
  } finally {
    for (const p of [worker, selfqa]) {
      if (p.pid) {
        try {
          process.kill(-p.pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
  }

  if (failures) {
    console.error("\n" + failures + " UI check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: SelfQA review UI works end-to-end in a browser");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
