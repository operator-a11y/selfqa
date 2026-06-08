/**
 * M5-C — tuple assembler (pure; StubProvider + fabricated trace/temp artifacts).
 * Run: `npx tsx scripts/verify-tuple-assemble.ts`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StubProvider } from "../src/lib/core/provider/stub";
import { assembleTuple } from "../src/lib/core/codegen/tuple";
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
  const dir = path.join(os.tmpdir(), "selfqa-assemble-" + process.pid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "step-0.html"), "<h1 data-testid=title>Todo</h1>");
  await fs.writeFile(path.join(dir, "step-0.png"), "png");

  const trace: MissionTrace = {
    missionId: "mission-x",
    reached: true,
    attempts: 1,
    entryRoute: "/",
    actions: [{ kind: "navigate", value: "http://x/" }],
    steps: [
      { index: 0, actionKind: "navigate", action: { kind: "navigate", value: "http://x/" }, url: "http://x/", screenshot: path.join(dir, "step-0.png"), dom: path.join(dir, "step-0.html") },
    ],
    terminalUrl: "http://x/",
    consoleErrors: [],
  };

  const provider = new StubProvider();
  const r = await assembleTuple(provider, { trace, stepIndex: 0, nl: "the title should indicate it was edited", commentType: "step-anchored" });
  truthy("valid coordinate -> ok:true", r.ok);
  if (r.ok) {
    const f = r.feedback;
    truthy(
      "all five legs present",
      !!f.missionId && Array.isArray(f.actionSequencePrefix) && f.actionSequencePrefix.length === 1 && !!f.snapshot.domHtml && !!f.nl && !!f.assertion,
    );
    truthy(
      "stub assertion is text-equals on [data-testid=title]",
      f.assertion.type === "deterministic" &&
        f.assertion.predicate.kind === "text-equals" &&
        f.assertion.predicate.selector === "[data-testid=title]",
    );
  }

  const empty = await assembleTuple(provider, { trace: { ...trace, steps: [] }, stepIndex: 0, nl: "x", commentType: "step-anchored" });
  truthy("unresolvable coordinate -> ok:false route needs-human", !empty.ok && empty.route === "needs-human");

  await fs.rm(dir, { recursive: true, force: true });

  if (failures) {
    console.error("\n" + failures + " tuple-assemble check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-C tuple assembler green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
