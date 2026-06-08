/**
 * M3-B — mission derivation (no API key). Run: `npx tsx scripts/verify-mission-deriver.ts`.
 *
 * Reaching a successful cold parse ALSO proves the marker is collision-proof: had
 * the deriver prompt (which mentions build/edit/spec in its body) misrouted to the
 * build/edit/spec stub branch, the response would be file blocks or a spec JSON and
 * DerivedMissionsSchema.parse would throw.
 */
import { StubProvider } from "../src/lib/core/provider/stub";
import { deriveMissions } from "../src/lib/core/codegen/mission-deriver";
import { isFirstWalkAutoAssertable } from "../src/lib/core/verify/checker";
import type { GeneratedFile } from "../src/lib/core/codegen/protocol";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

const files: GeneratedFile[] = [
  { path: "src/app/page.tsx", content: "// canned todo app" },
];

async function main(): Promise<void> {
  const provider = new StubProvider();

  const cold = await deriveMissions(provider, { appPrompt: "a todo app", files });
  truthy(
    "cold: 8-15 missions (" + cold.missions.length + ")",
    cold.missions.length >= 8 && cold.missions.length <= 15,
  );
  truthy(
    "cold: all ids match /^mission-[a-z0-9-]+$/",
    cold.missions.every((m) => /^mission-[a-z0-9-]+$/.test(m.id)),
  );
  truthy(
    "cold: ids unique",
    new Set(cold.missions.map((m) => m.id)).size === cold.missions.length,
  );
  truthy("cold: reusedIds empty", cold.reusedIds.length === 0);

  let det = 0;
  let sem = 0;
  let disagree = 0;
  let textEquals = 0;
  for (const m of cold.missions) {
    for (const c of m.acceptanceCriteria) {
      if (c.type === "deterministic") {
        det++;
        if (!isFirstWalkAutoAssertable(c)) disagree++;
        if (c.predicate.kind === "text-equals") textEquals++;
      } else {
        sem++;
      }
    }
  }
  const ratio = det / (det + sem);
  truthy("cold: det:sem ratio >= 0.70 (" + ratio.toFixed(2) + ")", ratio >= 0.7);
  truthy(
    "cold: every deterministic criterion is first-walk-verifiable (no metric/whitelist disagreement)",
    disagree === 0,
  );
  truthy("cold: no text-equals criterion", textEquals === 0);

  const informed = await deriveMissions(provider, {
    appPrompt: "a todo app",
    files,
    existingMissions: cold.missions,
  });
  const coldIds = new Set(cold.missions.map((m) => m.id));
  truthy("informed: returns net-new missions", informed.missions.length > 0);
  truthy(
    "informed: net-new ids disjoint from existing",
    informed.missions.every((m) => !coldIds.has(m.id)),
  );
  truthy("informed: reusedIds populated", informed.reusedIds.length > 0);

  truthy("deriver routed correctly (did not misroute to build/edit/spec)", true);

  if (failures) {
    console.error("\n" + failures + " mission-deriver check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: mission-deriver green (no API key)");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
