/**
 * M3-D — hot-path enforcement (SPEC §6.3), belt-and-suspenders to the eslint
 * no-restricted-imports rule. Asserts harness/* and walk/* import ZERO provider
 * code, so an LLM call can never sneak into the replay/settling loop.
 * Run: `npx tsx scripts/verify-hot-path.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["src/lib/core/harness", "src/lib/core/walk"];
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /from\s+["'][^"']*\/provider(\/|["'])/, why: "imports a provider module" },
  { re: /@anthropic-ai\/sdk/, why: "imports the Anthropic SDK" },
  { re: /\bgetProvider\b/, why: "references getProvider" },
  { re: /\bAnthropicProvider\b/, why: "references AnthropicProvider" },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

let violations = 0;
let scanned = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned++;
    const src = readFileSync(file, "utf8");
    for (const f of FORBIDDEN) {
      if (f.re.test(src)) {
        violations++;
        console.error(`HOT-PATH VIOLATION: ${file} ${f.why}`);
      }
    }
  }
}

// Extended (M5-I): the re-walk per-comment loop body must be provider-free (§6.3) —
// scan the marked region in rewalk/run-rewalk.ts mechanically, not by review.
{
  const f = "src/lib/core/rewalk/run-rewalk.ts";
  const src = readFileSync(f, "utf8");
  const m = src.match(/SELFQA-REWALK-LOOP-START([\s\S]*?)SELFQA-REWALK-LOOP-END/);
  if (!m) {
    violations++;
    console.error(`HOT-PATH VIOLATION: ${f} is missing the SELFQA-REWALK-LOOP sentinels`);
  } else {
    scanned++;
    const forbidden = [/\bcompileSequence\b/, /\bbatchSemanticVerdict\b/, /\bgetProvider\b/, /\bAnthropicProvider\b/, /provider\.complete/];
    for (const re of forbidden) {
      if (re.test(m[1])) {
        violations++;
        console.error(`HOT-PATH VIOLATION: re-walk loop body matches ${re}`);
      }
    }
  }
}

if (violations) {
  console.error(`\n${violations} hot-path violation(s) across ${scanned} files`);
  process.exit(1);
}
console.log(`OK: ${scanned} hot-path files/regions import zero provider code (SPEC §6.3)`);
