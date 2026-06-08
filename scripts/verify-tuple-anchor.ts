/**
 * M5-B — tuple legs off the trace (pure; fabricated trace + temp artifacts).
 * Run: `npx tsx scripts/verify-tuple-anchor.ts`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTuplePrefix } from "../src/lib/core/walk/comment-anchor";
import type { MissionTrace } from "../src/lib/core/domain/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function main(): Promise<void> {
  const dir = path.join(os.tmpdir(), "selfqa-tuple-" + process.pid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "step-0.html"), "<html><body><h1 data-testid=title>Todo</h1></body></html>");
  await fs.writeFile(path.join(dir, "step-0.png"), "png0");
  await fs.writeFile(path.join(dir, "step-1.html"), "<html><body>after</body></html>");
  await fs.writeFile(path.join(dir, "step-1.png"), "png1");

  const trace: MissionTrace = {
    missionId: "mission-x",
    reached: true,
    attempts: 1,
    entryRoute: "/",
    actions: [
      { kind: "navigate", value: "http://x/" },
      { kind: "click", target: { strategy: "data-testid", value: "add-button" } },
    ],
    steps: [
      { index: 0, actionKind: "navigate", action: { kind: "navigate", value: "http://x/" }, url: "http://x/", screenshot: path.join(dir, "step-0.png"), dom: path.join(dir, "step-0.html") },
      { index: 1, actionKind: "click", action: { kind: "click", target: { strategy: "data-testid", value: "add-button" } }, url: "http://x/?a", screenshot: path.join(dir, "step-1.png"), dom: path.join(dir, "step-1.html") },
    ],
    terminalUrl: "http://x/?a",
    consoleErrors: [],
  };

  const r1 = await resolveTuplePrefix(trace, 1);
  truthy("step-anchored prefix = steps 0..1 (2 actions)", "actionSequencePrefix" in r1 && r1.actionSequencePrefix.length === 2);
  truthy("snapshot domHtml read off disk", "snapshot" in r1 && r1.snapshot.domHtml.includes("after"));

  const r0 = await resolveTuplePrefix(trace, 0);
  truthy("step-0 snapshot is the captured Todo DOM", "snapshot" in r0 && r0.snapshot.domHtml.includes("Todo"));

  const rM = await resolveTuplePrefix(trace);
  truthy("mission-level uses terminal step", "snapshot" in rM && rM.snapshot.url === "http://x/?a");

  const empty = await resolveTuplePrefix({ ...trace, steps: [] });
  truthy("empty trace -> unresolved:empty-trace", "unresolved" in empty && empty.unresolved === "empty-trace");

  const oor = await resolveTuplePrefix(trace, 5);
  truthy("out-of-range -> unresolved:step-out-of-range", "unresolved" in oor && oor.unresolved === "step-out-of-range");

  const missingTrace: MissionTrace = { ...trace, steps: [{ ...trace.steps[0], dom: path.join(dir, "gone.html") }] };
  const miss = await resolveTuplePrefix(missingTrace, 0);
  truthy("missing artifact -> unresolved:missing-artifact (never fabricated)", "unresolved" in miss && miss.unresolved === "missing-artifact");

  await fs.rm(dir, { recursive: true, force: true });

  if (failures) {
    console.error("\n" + failures + " tuple-anchor check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-B tuple legs off the trace green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
