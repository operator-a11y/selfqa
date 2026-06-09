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
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResult,
} from "../src/lib/core/provider/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

/**
 * A messy real model stand-in: it re-proposes an EXISTING cold id (a collision)
 * alongside one genuinely net-new id in informed mode — everything else delegates to
 * the deterministic stub. Proves the deriver DROPS the collision instead of crashing.
 */
class CollidingInformedProvider implements LLMProvider {
  readonly name = "colliding-informed";
  constructor(private base: StubProvider) {}
  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const role = (req.system ?? "").split("\n", 1)[0];
    const userText = req.messages.map((m) => m.content).join("\n");
    if (role.includes("mission-deriver") && userText.includes("MODE: informed")) {
      return {
        text: JSON.stringify({
          missions: [
            STUB_COLD_MISSIONS.missions[0], // COLLISION: re-proposes an existing id
            {
              id: "mission-brand-new",
              name: "Brand new",
              description: "a genuinely net-new mission",
              intendedSteps: ["do the new thing"],
              acceptanceCriteria: [{ type: "semantic", nl: "the new thing works" }],
            },
          ],
          reusedIds: [],
        }),
        stopReason: "end_turn",
      };
    }
    return this.base.complete(req);
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
    return !!orig && !!carried && carried.actions === orig.actions;
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

  // REAL-MODEL ROBUSTNESS: a messy model re-proposes an EXISTING id in informed mode.
  // The deriver must DROP it (tolerant), not throw and crash the whole re-run.
  const colliding = new CollidingInformedProvider(provider);
  let threw = false;
  let collidedPlans: Awaited<ReturnType<typeof assembleRunPlans>> = [];
  try {
    collidedPlans = await assembleRunPlans(colliding, { app, carryForward: cold });
  } catch {
    threw = true;
  }
  truthy("a re-proposed (colliding) id does NOT crash the re-run", !threw);
  const collidedIds = collidedPlans.map((p) => p.mission.id);
  truthy(
    "the re-proposed existing id is DROPPED (not duplicated)",
    collidedIds.filter((id) => id === STUB_COLD_MISSIONS.missions[0].id).length === 1,
  );
  truthy(
    "the genuinely net-new id survives alongside the dropped collision",
    collidedIds.includes("mission-brand-new"),
  );
  truthy(
    "all carried missions are still preserved through a collision",
    coldIds.every((id) => collidedIds.includes(id)),
  );

  // CARRY-FORWARD FOOTGUN: a carried mission with NO reusable actions (e.g. a prior
  // UNREACHED mission) must be RECOMPILED, not silently walked as a degenerate no-op.
  const target = cold.find((p) => p.mission.id === "mission-add-todo")!;
  truthy("precondition: the target mission has a non-empty compiled sequence", target.actions.length > 0);
  const recompiledPlans = await assembleRunPlans(provider, {
    app,
    carryForward: [{ mission: target.mission, actions: undefined }],
  });
  const recompiledBack = recompiledPlans.find((p) => p.mission.id === target.mission.id);
  truthy(
    "carried mission with absent actions is RECOMPILED (not left empty)",
    !!recompiledBack && recompiledBack.actions.length > 0,
  );

  if (failures) {
    console.error("\n" + failures + " informed-run check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: informed re-run accretes net-new missions onto the carried set");
}

void main();
