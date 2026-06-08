/**
 * M7 — coverage dedup + suspicion (SPEC §17; OPTIONAL). Run: `npx tsx scripts/verify-coverage.ts`.
 * FAST (pure: no browser, no LLM).
 *
 * Proves the cheap dedup (route + structural skeleton, text/values dropped) and the
 * mechanical suspicion heuristic — the supplementary coverage surface, never the headline.
 */
import { structuralSkeleton, stateKey, dedupeBySkeleton } from "../src/lib/core/coverage/skeleton";
import { classifySuspicious, buildCoverageReport, coverageHeadline, type RawCoverageState } from "../src/lib/core/coverage/report";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

// ── skeleton drops text + values, keeps structure ──────────────────────────────
const a = `<ul><li data-testid="row">Buy milk</li><li data-testid="row">Walk dog</li></ul>`;
const b = `<ul><li data-testid="row">Pay rent</li><li data-testid="row">Call mom</li></ul>`;
const c = `<ul><li data-testid="row">Buy milk</li></ul>`; // one fewer row -> different shape
truthy("same structure, different TEXT -> identical skeleton", structuralSkeleton(a) === structuralSkeleton(b));
truthy("different structure -> different skeleton", structuralSkeleton(a) !== structuralSkeleton(c));
truthy("skeleton keeps structural attrs by name, not value", structuralSkeleton(`<div data-testid="x"></div>`) === structuralSkeleton(`<div data-testid="y"></div>`));
truthy("skeleton drops non-structural attrs (class/style)", structuralSkeleton(`<div class="a" style="x"></div>`) === structuralSkeleton(`<div></div>`));
truthy("skeleton ignores <script> bodies", structuralSkeleton(`<p>hi</p><script>var z=1</script>`) === structuralSkeleton(`<p>bye</p>`));

// ── dedup by (route, skeleton) ──────────────────────────────────────────────────
truthy("stateKey: same route + structure -> same key", stateKey("/list", a) === stateKey("/list", b));
truthy("stateKey: different route -> different key", stateKey("/list", a) !== stateKey("/other", a));
const states = [
  { route: "/list", html: a },
  { route: "/list", html: b }, // structural dup of a
  { route: "/list", html: c }, // distinct shape
  { route: "/new", html: a }, // distinct route
];
const { unique, duplicatesFolded } = dedupeBySkeleton(states);
truthy("dedupe folds the structural duplicate (4 -> 3 unique, 1 folded)", unique.length === 3 && duplicatesFolded === 1);

// ── mechanical suspicion ────────────────────────────────────────────────────────
truthy("console error -> suspicious", classifySuspicious({ consoleErrors: ["TypeError: x"], errorSelectorVisible: false }).suspicious);
truthy("http >= 400 -> suspicious", classifySuspicious({ consoleErrors: [], httpStatus: 500, errorSelectorVisible: false }).suspicious);
truthy("visible error selector -> suspicious", classifySuspicious({ consoleErrors: [], errorSelectorVisible: true }).suspicious);
truthy("clean state -> not suspicious", classifySuspicious({ consoleErrors: [], httpStatus: 200, errorSelectorVisible: false }).suspicious === false);

// ── report rolls it up ──────────────────────────────────────────────────────────
const raw: RawCoverageState[] = [
  { route: "/", url: "http://x/", html: a, consoleErrors: [], errorSelectorVisible: false, via: "nav", httpStatus: 200 },
  { route: "/", url: "http://x/?b", html: b, consoleErrors: [], errorSelectorVisible: false, via: "btn-b" }, // dup of a
  { route: "/new", url: "http://x/new", html: c, consoleErrors: ["boom"], errorSelectorVisible: false, via: "btn-new" },
];
const report = buildCoverageReport(raw);
truthy("report dedups (3 raw -> 2 distinct, 1 folded)", report.statesSeen === 2 && report.duplicatesFolded === 1);
truthy("report counts 1 suspicious (the console-error state)", report.suspicious === 1 && report.states.find((s) => s.route === "/new")?.suspicious === true);
truthy("headline frames it as supplementary-to-missions", /beyond your missions/.test(coverageHeadline(report)) && /flagged 1 as suspicious/.test(coverageHeadline(report)));

// ── a suspicious state must NEVER be folded away into a clean duplicate ──────────
const sameHtml = `<div data-testid="x"><p>hi</p></div>`;
const foldClean = buildCoverageReport([
  { route: "/", url: "u1", html: sameHtml, consoleErrors: [], errorSelectorVisible: false, via: "a" },
  { route: "/", url: "u2", html: sameHtml, consoleErrors: ["boom"], errorSelectorVisible: false, via: "b" }, // suspicious dup of u1
]);
truthy("suspicion is NOT lost when a flagged state folds into a clean one", foldClean.statesSeen === 1 && foldClean.suspicious === 1 && foldClean.states[0].suspicious === true);
const foldRev = buildCoverageReport([
  { route: "/", url: "u2", html: sameHtml, consoleErrors: ["boom"], errorSelectorVisible: false, via: "b" },
  { route: "/", url: "u1", html: sameHtml, consoleErrors: [], errorSelectorVisible: false, via: "a" },
]);
truthy("suspicion survives regardless of fold order", foldRev.statesSeen === 1 && foldRev.suspicious === 1);

// ── rawtext element bodies are stripped (textarea can't perturb the skeleton) ────
truthy("skeleton strips <textarea> rawtext body", structuralSkeleton(`<textarea><li>x</li></textarea>`) === structuralSkeleton(`<textarea>plain different text</textarea>`));

if (failures) {
  console.error("\n" + failures + " coverage check(s) FAILED");
  process.exit(1);
}
console.log("\nOK: M7 coverage — cheap dedup (route+skeleton) + mechanical suspicion, supplementary to missions");
