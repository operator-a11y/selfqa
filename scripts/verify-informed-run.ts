/**
 * Informed re-run (SPEC §7.5) — a re-walk ACCRETES net-new missions onto the prior
 * set instead of regenerating the suite from scratch. Run: `npx tsx scripts/verify-informed-run.ts`.
 *
 * This is the REAL guard for wiring informed derivation into the run orchestrator.
 * It tests `assembleRunPlans` at the provider seam (no browser, fully deterministic
 * via the stub, which routes COLD vs INFORMED on the "MODE: informed" marker the
 * mission-deriver prompt emits). It proves:
 *   - COLD (no carryForward) derives the full suite and compiles each mission.
 *   - INFORMED (carryForward present) keeps EVERY carried mission (stable id),
 *     APPENDS only the net-new missions, and loses nothing (monotonic accretion).
 *   - carried missions REUSE their compiled actions verbatim (no recompile/drift).
 *   - net-new ids are disjoint from carried (the deriver never re-proposes a kept id).
 *   - cold derivation is idempotent (stable ids run-to-run — what the run-diff needs).
 */
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { assembleRunPlans } from "../src/lib/core/run";
import {
  STUB_COLD_MISSIONS,
  STUB_INFORMED_MISSIONS,
} from "../src/lib/core/provider/stub-missions";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function main(): Promise<void> {
  const provider = new StubProvider();
  const app = await buildApp(provider, "a tiny todo app");

  // COLD: no carryForward -> the full suite, each mission compiled.
  const cold = await assembleRunPlans(provider, { app });
  const coldIds = cold.map((p) => p.mission.id);
  truthy(
    "cold run derives the full suite",
    coldIds.length === STUB_COLD_MISSIONS.missions.length,
  );
  truthy("cold run compiled actions for each mission", cold.every((p) => Array.isArray(p.actions)));

  // INFORMED: carry the cold plans forward -> net-new appended, cold kept verbatim.
  const informed = await assembleRunPlans(provider, { app, carryForward: cold });
  const informedIds = informed.map((p) => p.mission.id);
  const netNewIds = STUB_INFORMED_MISSIONS.missions.map((m) => m.id);

  truthy(
    "informed run keeps ALL carried missions (stable ids, none dropped)",
    coldIds.every((id) => informedIds.includes(id)),
  );
  truthy(
    "informed run APPENDS the net-new missions",
    netNewIds.every((id) => informedIds.includes(id)),
  );
  truthy(
    "informed total = carried + net-new (accretion, no loss, no dup)",
    informedIds.length === coldIds.length + netNewIds.length,
  );
  truthy(
    "net-new ids are disjoint from carried (deriver never re-proposes a kept id)",
    netNewIds.every((id) => !coldIds.includes(id)),
  );

  // Carried plans are REUSED VERBATIM — the SAME plan objects (so their compiled
  // actions are not recompiled, i.e. no provider drift on a re-run).
  const reusedVerbatim = coldIds.every((id) => {
    const orig = cold.find((c) => c.mission.id === id);
    const carried = informed.find((c) => c.mission.id === id);
    return !!orig && carried === orig && carried.actions === orig.actions;
  });
  truthy("carried missions reuse their compiled actions verbatim (no recompile)", reusedVerbatim);

  // Carried come first, net-new appended after (stable order for the run-diff).
  truthy(
    "net-new are appended AFTER the carried set (stable order)",
    informedIds.slice(0, coldIds.length).join(",") === coldIds.join(","),
  );

  // Cold derivation is idempotent — the stable ids the run-to-run diff matches on.
  const cold2 = await assembleRunPlans(provider, { app });
  truthy(
    "cold derivation is idempotent (stable ids run-to-run)",
    cold2.map((p) => p.mission.id).join(",") === coldIds.join(","),
  );

  if (failures) {
    console.error("\n" + failures + " informed-run check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: informed re-run accretes net-new missions onto the carried set");
}

void main();
