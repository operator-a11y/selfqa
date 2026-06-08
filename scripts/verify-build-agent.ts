/**
 * Checkpoint A verification (run: `npx tsx scripts/verify-build-agent.ts`).
 *
 * Proves: StubProvider → build-agent → workspace writer produces a real,
 * git-committed app repo from a prompt — deterministically, no API key.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import {
  writeGeneratedApp,
  currentSha,
  WORKSPACE_ROOT,
} from "../src/lib/core/workspace/repo";

async function main(): Promise<void> {
  const provider = new StubProvider();

  const app = await buildApp(provider, "a simple todo app");
  console.log(`build-agent produced ${app.files.length} files:`);
  for (const f of app.files) console.log("  - " + f.path);

  const id = "verify-sample";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });

  const repo = await writeGeneratedApp(id, app.files);
  const sha = await currentSha(repo.dir);
  console.log("wrote app -> " + repo.dir);
  console.log("initial build sha = " + sha);

  const required = ["package.json", "src/app/page.tsx", "src/app/layout.tsx"];
  for (const r of required) {
    if (!app.files.some((f) => f.path === r)) {
      throw new Error("MISSING required file: " + r);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("expected a 40-char git sha, got: " + sha);
  }
  console.log("OK: required files present and committed (build = sha)");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
