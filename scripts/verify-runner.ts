/**
 * Checkpoint B verification (run: `npx tsx scripts/verify-runner.ts`).
 *
 * Proves: a generated app installs, serves over `next dev` on an allocated port,
 * responds with the expected UI, and is cleanly stopped. No API key.
 * NOTE: first run installs deps in the workspace (~30s) and needs network.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { writeGeneratedApp, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { startApp } from "../src/lib/core/runner/app-runner";

async function main(): Promise<void> {
  const app = await buildApp(new StubProvider(), "a simple todo app");
  const id = "verify-run";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, app.files);

  console.log("installing deps + starting next dev (first run ~30s)...");
  const running = await startApp(repo.dir, { id });
  console.log("dev server up at " + running.url + " (pid " + running.proc.pid + ")");

  const res = await fetch(running.url);
  const html = await res.text();
  const served = html.includes('data-testid="title"') || html.includes("Todo");
  console.log(
    `GET ${running.url} -> ${res.status}; html ${html.length} bytes; todo UI present: ${served}`,
  );

  await running.stop();
  console.log("stopped dev server");

  if (!served) throw new Error("served page did not contain the expected todo UI");
  console.log("OK: generated app installs, serves, and stops cleanly");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
