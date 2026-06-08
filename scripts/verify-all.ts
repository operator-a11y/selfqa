/**
 * One-command verification gate (M5-0). Runs typecheck + lint + every verify
 * script; exits non-zero on the first failure. `--fast` (or SELFQA_VERIFY_FAST=1)
 * runs only the no-browser scripts for quick per-checkpoint gating; the full run
 * additionally drives Chromium + builds (slow) and is the M6-D end-to-end gate.
 *
 * Add each NEW verify script to FAST or HEAVY as it is created.
 */
import { execFileSync } from "node:child_process";

const FAST = [
  "verify-schema",
  "verify-checker",
  "verify-mission-deriver",
  "verify-first-walk",
  "verify-fixtures",
  "verify-hot-path",
  "verify-build-agent",
  "verify-tuple-anchor",
  "verify-tuple-assemble",
  "verify-edit-consume",
  "verify-manifest",
  "verify-flip",
  "verify-semantic-verdict",
  "verify-gate",
  "verify-converge",
  "verify-persist",
  "verify-metrics",
];
const HEAVY = [
  "verify-action-capture",
  "verify-rewalk",
  "verify-runner",
  "verify-instrument",
  "verify-loop",
  "verify-isolation-gate",
  "verify-harness",
  "verify-walk",
  "verify-endpoints",
  "verify-ui",
  "verify-loop-e2e",
];

const onlyFast =
  process.env.SELFQA_VERIFY_FAST === "1" || process.argv.includes("--fast");
const scripts = onlyFast ? FAST : [...FAST, ...HEAVY];

const failed: string[] = [];
function run(label: string, cmd: string, args: string[]): void {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
  } catch {
    failed.push(label);
  }
}

run("typecheck", "npm", ["run", "typecheck"]);
run("lint", "npm", ["run", "lint"]);
for (const s of scripts) run(s, "npx", ["tsx", `scripts/${s}.ts`]);

if (failed.length) {
  console.error(`\n${failed.length} check(s) FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(
  `\nOK: verify:all green — ${scripts.length} script(s)${onlyFast ? " [fast]" : ""} + typecheck + lint`,
);
