/**
 * M5-H — batched semantic verdict (pure; StubProvider, no API key).
 * Run: `npx tsx scripts/verify-semantic-verdict.ts`.
 */
import { StubProvider } from "../src/lib/core/provider/stub";
import { batchSemanticVerdict } from "../src/lib/core/verify/semantic";
import { assignReWalkVerdict } from "../src/lib/core/verify/rewalk-verdict";

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
  const v = await batchSemanticVerdict(provider, [
    { commentId: "c1", nl: "looks better", beforeSnapshot: "old", afterSnapshot: "new" },
    { commentId: "c2", nl: "still cluttered", beforeSnapshot: "same", afterSnapshot: "same" },
    { commentId: "c3", nl: "maybe", beforeSnapshot: "a", afterSnapshot: "b UNSURE" },
  ]);

  truthy("one batched call returns a verdict per item", v.length === 3);
  const c1 = v.find((x) => x.commentId === "c1");
  const c2 = v.find((x) => x.commentId === "c2");
  const c3 = v.find((x) => x.commentId === "c3");
  truthy("c1 (changed) -> satisfied true, high", c1?.satisfied === true && c1?.confidence === "high");
  truthy("c2 (unchanged) -> satisfied false", c2?.satisfied === false);
  truthy("c3 (UNSURE) -> low confidence", c3?.confidence === "low");

  truthy("empty items -> zero LLM (empty result)", (await batchSemanticVerdict(provider, [])).length === 0);

  // integration: low-confidence semantic -> ambiguous:semantic-low-confidence
  const verdict = assignReWalkVerdict({
    reached: true,
    flip: { status: "needs-semantic", detail: "", before: null, after: null },
    semantic: { satisfied: c3!.satisfied, confidence: c3!.confidence },
  });
  truthy("low confidence -> ambiguous:semantic-low-confidence", verdict.verdict.ambiguousReason === "semantic-low-confidence");

  if (failures) {
    console.error("\n" + failures + " semantic-verdict check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: M5-H batched semantic verdict green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
