/**
 * M5-E — touched-routes manifest (pure; no git/fs/browser).
 * Run: `npx tsx scripts/verify-manifest.ts`.
 */
import { classifyDiff, selectRewalkSet, normalizeRoute } from "../src/lib/core/verify/manifest";
import type { Mission, MissionTrace } from "../src/lib/core/domain/types";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

function trace(urls: string[]): MissionTrace {
  return {
    missionId: "m",
    reached: true,
    attempts: 1,
    entryRoute: urls[0] ?? "/",
    steps: urls.map((u, i) => ({ index: i, actionKind: "navigate", url: u, screenshot: "s", dom: "d" })),
    terminalUrl: urls[urls.length - 1] ?? "/",
    consoleErrors: [],
  };
}

// classifyDiff: provably-local-else-everything
truthy("components edit -> everything", classifyDiff(["src/components/Button.tsx"]).bucket === "everything");
truthy("lib edit -> everything", classifyDiff(["src/lib/x.ts"]).bucket === "everything");
truthy("root layout -> everything", classifyDiff(["src/app/layout.tsx"]).bucket === "everything");
truthy("globals.css -> everything", classifyDiff(["src/app/globals.css"]).bucket === "everything");
truthy("unknown top-level -> everything (safe inversion)", classifyDiff(["next.config.ts"]).bucket === "everything");
const single = classifyDiff(["src/app/cart/page.tsx"]);
truthy("single-route page -> local + /cart", single.bucket === "local" && single.routes.includes("/cart"));
const rootPage = classifyDiff(["src/app/page.tsx"]);
truthy("root page -> local + /", rootPage.bucket === "local" && rootPage.routes.includes("/"));
truthy("co-located route layout -> local", classifyDiff(["src/app/cart/layout.tsx"]).bucket === "local");
truthy("normalizeRoute strips origin + trailing + casing", normalizeRoute("http://127.0.0.1:5000/Cart/") === "/cart");

// selectRewalkSet: all-visited-routes join + smoke
const missions: Mission[] = [
  { id: "mission-home", name: "h", description: "d", intendedSteps: ["s"], acceptanceCriteria: [{ type: "semantic", nl: "x" }] },
  { id: "mission-cart", name: "c", description: "d", intendedSteps: ["s"], acceptanceCriteria: [{ type: "semantic", nl: "x" }] },
];
const traces = new Map<string, MissionTrace>([
  ["mission-home", trace(["http://x/"])],
  ["mission-cart", trace(["http://x/", "http://x/cart"])], // enters / but visits /cart
]);
const cartEdit = classifyDiff(["src/app/cart/page.tsx"]);
const set = selectRewalkSet(missions, traces, cartEdit, ["mission-home"]);
truthy("multi-route mission selected by /cart edit (ALL-visited-routes)", set.includes("mission-cart"));
truthy("smoke set always included", set.includes("mission-home"));
const all = selectRewalkSet(missions, traces, classifyDiff(["src/components/X.tsx"]));
truthy("everything bucket -> all missions", all.length === 2);

if (failures) {
  console.error("\n" + failures + " manifest check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: M5-E touched-routes manifest green");
