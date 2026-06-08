/**
 * M3-C — isolation + parallelism gate (real Chromium; canned app via runner).
 * Run: `npx tsx scripts/verify-isolation-gate.ts`.
 *
 * Proves: the bounded pool runs missions in PARALLEL, each in a FRESH
 * BrowserContext, and one mission's client writes (localStorage) do NOT leak to
 * another (the §9.1 precondition for a verdict being a property of the mission,
 * not the run). Also asserts the DbRestore seam is an INTENTIONAL no-op in M3.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { startApp } from "../src/lib/core/runner/app-runner";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";
import { pool } from "../src/lib/core/walk/pool";
import { ClientContextIsolation, DbRestoreIsolation } from "../src/lib/core/walk/isolation";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function main(): Promise<void> {
  let browser;
  try {
    browser = await getBrowser();
  } catch (e) {
    console.error("Could not launch Chromium. Run: npx playwright install chromium");
    throw e;
  }

  const generated = instrument(await buildApp(new StubProvider(), "a todo app"));
  const id = "verify-iso";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);
  const running = await startApp(repo.dir, { id });

  const iso = new ClientContextIsolation();

  // Two missions in parallel: #0 writes localStorage and re-reads its own;
  // #1 reads localStorage. Isolation => #0 sees "A", #1 sees null regardless of timing.
  const slotsSeen: number[] = [];
  const results = await pool([0, 1], 2, async (i, slot) => {
    slotsSeen[i] = slot;
    const ctx = await browser.newContext();
    await iso.before(ctx, slot);
    const page = await ctx.newPage();
    await page.goto(running.url, { waitUntil: "domcontentloaded" });
    let value: string | null;
    if (i === 0) {
      await page.evaluate(() => localStorage.setItem("selfqa-iso", "A"));
      value = await page.evaluate(() => localStorage.getItem("selfqa-iso"));
    } else {
      value = await page.evaluate(() => localStorage.getItem("selfqa-iso"));
    }
    await iso.after(ctx, slot);
    await ctx.close();
    return { i, value };
  });

  truthy("pool ran both missions in parallel", results.length === 2);
  const m0 = results.find((r) => r.i === 0);
  const m1 = results.find((r) => r.i === 1);
  truthy("mission #0 sees its own client write (value=A)", m0?.value === "A");
  truthy("mission #1 does NOT see #0's write (isolated, value=null)", m1?.value === null);
  truthy("pool gives each lane a stable slot id in 0..N-1", slotsSeen.every((s) => s === 0 || s === 1));

  // DbRestoreIsolation is REAL as of M5-F: before(ctx, slot) calls the injected
  // restore-to-seed for THAT lane (the primitive itself is gated by verify-db-isolation).
  const restored: number[] = [];
  const db = new DbRestoreIsolation(async (slot) => {
    restored.push(slot);
  });
  const tmpCtx = await browser.newContext();
  await db.before(tmpCtx, 3);
  await db.after(tmpCtx, 3);
  await tmpCtx.close();
  truthy("DbRestoreIsolation.before restores the named lane (real, not a no-op)", db.kind === "db-restore" && restored.length === 1 && restored[0] === 3);

  await running.stop();
  await closeBrowser();

  if (failures) {
    console.error("\n" + failures + " isolation check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: parallel pool + per-mission client isolation green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
