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
    env: { ...process.env, SELFQA_WORKER_PORT: "4317" },
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
    truthy("flip-result panel appears after re-walk", await ok(page.getByTestId("flip-result").waitFor({ timeout: 180000 })));
    const flipText = (await page.getByTestId("flip-result").textContent()) ?? "";
    truthy("UI shows the assertion flipped fail->pass (" + flipText.trim().slice(0, 40) + ")", /flipped/.test(flipText));

    await page.getByTestId("promote-mission").click();
    await page.waitForTimeout(2500);
    const promoteText = (await page.getByTestId("promote-mission").textContent()) ?? "";
    truthy("promote marks the mission a regression test", promoteText.includes("✓"));

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
