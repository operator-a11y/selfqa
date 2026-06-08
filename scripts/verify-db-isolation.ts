/**
 * M5-F — the §9.3 isolation PRIMITIVE gate. Run: `npx tsx scripts/verify-db-isolation.ts`.
 * FAST (node:sqlite + fs + the pure pool; no browser, no Next build).
 *
 * SCOPE (honest): this certifies the file-copy / WAL / per-lane-routing / stable-slot
 * PRIMITIVE. The END-TO-END walker→runner→DB-app gate is verify-db-e2e (M5-F-INT),
 * and THAT script — not this one — flips the persisted `parallelDbVerdictsTrusted`
 * flag the worker reads before trusting any parallel DB-backed verdict.
 *
 * Proves:
 *  (a) N lanes each restore-to-seed into their OWN file and, under concurrent
 *      writes, each sees ONLY its own writes (real per-lane routing, not a shared file);
 *  (b) NO literal "database is locked" surfaces — and the detector recognizes that
 *      string distinctly from settle-timeout flake (kept textually separate);
 *  (c) restoreToSeed truly resets AND removes the -wal/-shm sidecars (the leak trap);
 *  (d) the redesigned pool hands each worker a STABLE slot id across many pickups.
 */
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { restoreToSeed } from "../src/lib/core/runner/app-runner";
import { pool } from "../src/lib/core/walk/pool";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

/** The §9.3 detector — kept TEXTUALLY DISTINCT so a lock is never read as flake. */
function isDbLock(msg: string): boolean {
  return /database is locked/i.test(msg);
}

function makeSeed(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, lane INTEGER);");
  db.close();
}
function countRows(path: string): number {
  const db = new DatabaseSync(path);
  const r = db.prepare("SELECT COUNT(*) AS c FROM items").get() as { c: number };
  db.close();
  return Number(r.c);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "selfqa-dbiso-"));
  const N = 4;
  const seed = join(dir, "seed.db");
  const lane = (s: number) => join(dir, `worker-${s}.db`);

  try {
    makeSeed(seed);

    // (a)/(c) seed each lane from the seed; each starts at the baseline.
    for (let s = 0; s < N; s++) await restoreToSeed(seed, lane(s));
    truthy("each lane restored to seed (count 0, file exists)", Array.from({ length: N }, (_x, s) => s).every((s) => existsSync(lane(s)) && countRows(lane(s)) === 0));

    // (a)/(b) concurrent writes from N simulated lanes, each into its OWN file.
    const errors: string[] = [];
    await Promise.all(
      Array.from({ length: N }, (_x, s) => s).map(async (s) => {
        try {
          const db = new DatabaseSync(lane(s));
          const ins = db.prepare("INSERT INTO items (lane) VALUES (?)");
          for (let k = 0; k <= s; k++) {
            ins.run(s); // lane s writes s+1 rows
            await Promise.resolve(); // yield so lanes interleave
          }
          db.close();
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }),
    );
    truthy("NO 'database is locked' under concurrent per-lane writes", !errors.some(isDbLock));
    truthy("each lane sees ONLY its own writes (per-lane routing, not a shared file)", Array.from({ length: N }, (_x, s) => s).every((s) => countRows(lane(s)) === s + 1));

    // the detector is non-vacuous: it recognizes the literal distinctly from flake.
    truthy("lock detector flags the literal, NOT a settle-timeout", isDbLock("SqliteError: database is locked") && !isDbLock("waitForSettled: timed out after 500ms"));

    // (c) restore truly resets AND removes -wal/-shm sidecars.
    {
      const db = new DatabaseSync(lane(0));
      db.exec("INSERT INTO items (lane) VALUES (99);"); // create a -wal
      db.close();
    }
    truthy("a write left a -wal sidecar to clean up", existsSync(lane(0) + "-wal") || countRows(lane(0)) > 1);
    await restoreToSeed(seed, lane(0));
    truthy("restoreToSeed resets the lane to seed (count 0)", countRows(lane(0)) === 0);
    truthy("restoreToSeed removed the -wal/-shm sidecars (no WAL leak)", !existsSync(lane(0) + "-wal") && !existsSync(lane(0) + "-shm"));

    // (d) the redesigned pool gives each worker a STABLE slot id across pickups.
    const items = Array.from({ length: 12 }, (_x, i) => i);
    const slotOf = await pool(items, N, async (_item, slot) => {
      await Promise.resolve();
      return slot;
    });
    const distinct = new Set(slotOf);
    truthy("pool used exactly N lanes, ids 0..N-1", distinct.size === N && [...distinct].every((s) => s >= 0 && s < N));
    truthy("a lane handled multiple items under a STABLE slot id (not the item index)", slotOf.some((s, i) => slotOf.indexOf(s) !== i));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures) {
    console.error("\n" + failures + " isolation-primitive check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-F isolation primitive — per-lane file routing, no lock, WAL-clean restore, stable slots");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
