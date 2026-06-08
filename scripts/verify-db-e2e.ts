/**
 * M5-F-INT — the END-TO-END §9.3 isolation gate. Run: `npx tsx scripts/verify-db-e2e.ts`.
 * HEAVY (writes a real Next app, ONE shared build, N lane-bound `next start`
 * servers, parallel Chromium walk). No API key (StubProvider DB app).
 *
 * Builds the sqlite-backed stub app, runs N lane servers each with its OWN
 * DATABASE_URL (per-lane file seeded from one seed), and walks N DB-writing
 * missions IN PARALLEL through the REAL walker + DbRestoreIsolation. Each mission
 * increments once; restore-to-seed runs before each, so every mission must see
 * EXACTLY count==1 — order-independent — and NO "database is locked" may surface.
 * Passing flips the persisted `parallelDbVerdictsTrusted` flag the worker reads
 * (here: a durable temp store, to stay hermetic; in production it targets the
 * worker's ./selfqa.db).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { writeGeneratedApp, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { dbStubApp, dbCounterMission, DB_STUB_SCHEMA } from "../src/lib/core/codegen/db-stub-app";
import { startAppPool, type AppPool } from "../src/lib/core/runner/app-runner";
import { DbRestoreIsolation } from "../src/lib/core/walk/isolation";
import { walkAll, type MissionPlan } from "../src/lib/core/walk/walker";
import { getBrowser, closeBrowser } from "../src/lib/core/harness/browser";
import { effectiveConcurrency } from "../src/lib/core/run";
import { SqliteStore } from "../src/lib/core/persist/sqlite-store";

const N = 3;
let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}
function isDbLock(msg: string): boolean {
  return /database is locked/i.test(msg);
}
function laneCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  const r = db.prepare("SELECT COUNT(*) AS c FROM items").get() as { c: number };
  db.close();
  return Number(r.c);
}

async function main(): Promise<void> {
  const id = "verify-db-e2e";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, dbStubApp().files);

  const dbDir = mkdtempSync(join(tmpdir(), "selfqa-dbe2e-"));
  const seedDbPath = join(dbDir, "seed.db");
  {
    const seed = new DatabaseSync(seedDbPath); // self-contained seed (no WAL sidecars)
    seed.exec(DB_STUB_SCHEMA);
    seed.close();
  }
  const laneDbPath = (slot: number) => join(dbDir, `lane-${slot}.db`);

  let pool: AppPool | null = null;
  try {
    // safety rail: BEFORE the gate, a db-file-copy app is forced to concurrency 1.
    truthy("untrusted db-file-copy app is forced to concurrency 1 (safety rail)", effectiveConcurrency(N, "db-file-copy", false) === 1);

    console.log(`building DB stub + starting ${N} lane servers (one shared build)…`);
    pool = await startAppPool(repo.dir, { id, workers: N, seedDbPath, laneDbPath, dbEnvName: "DATABASE_URL" });
    truthy(`startAppPool ran ONE build + ${N} lane-bound servers`, pool.baseUrls.length === N && pool.slots.every((s) => !!s.url));

    const browser = await getBrowser();
    const iso = new DbRestoreIsolation(pool.restoreToSeed);
    const plans: MissionPlan[] = Array.from({ length: N }, (_x, i) => dbCounterMission(`m-${i}`));

    const walked = await walkAll(browser, iso, pool.baseUrls, "dbe2e", plans, N);

    truthy("every mission reached its terminal state", walked.every((w) => w.trace.reached));
    const counts = walked.map((w) => w.observed.q("[data-testid=count]")?.text ?? "?");
    truthy(
      `every mission sees count==1, ORDER-INDEPENDENT (restore-to-seed held): [${counts.join(",")}]`,
      counts.length === N && counts.every((c) => c === "1"),
    );
    const allConsole = walked.flatMap((w) => w.trace.consoleErrors);
    truthy("NO 'database is locked' across all lanes (per-lane DATABASE_URL routing)", !allConsole.some(isDbLock));
    truthy("each lane's own DB file ended at count==1 (real per-lane isolation)", pool.slots.every((s) => laneCount(s.dbPath) === 1));

    await closeBrowser();

    // the gate passed -> flip the persisted flag the worker reads (durable).
    const flagDbPath = join(dbDir, "flag.db");
    const store = new SqliteStore(flagDbPath);
    truthy("flag starts false (no parallel DB verdict trusted yet)", store.getParallelDbVerdictsTrusted() === false);
    store.setParallelDbVerdictsTrusted(true);
    store.close();
    const reopened = new SqliteStore(flagDbPath);
    truthy("verify-db-e2e flips parallelDbVerdictsTrusted = true, durably", reopened.getParallelDbVerdictsTrusted() === true);
    truthy("with the flag set, the db-file-copy app now parallelizes (concurrency N)", effectiveConcurrency(N, "db-file-copy", reopened.getParallelDbVerdictsTrusted()) === N);
    reopened.close();
  } finally {
    if (pool) await pool.stop();
    rmSync(dbDir, { recursive: true, force: true });
  }

  if (failures) {
    console.error("\n" + failures + " DB e2e check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-F-INT — N parallel lanes restore-to-seed into their own DB, order-independent verdicts, no locks; flag flipped");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
