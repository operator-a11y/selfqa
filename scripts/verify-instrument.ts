/**
 * Checkpoint C verification (run: `npx tsx scripts/verify-instrument.ts`).
 *
 * Proves: the comment overlay is injected into a generated app, the instrumented
 * app still compiles + serves (a 200 means the injected client component
 * type-checks under the app's own strict tsc). No API key.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { startApp } from "../src/lib/core/runner/app-runner";

async function main(): Promise<void> {
  const generated = instrument(
    await buildApp(new StubProvider(), "a simple todo app"),
  );

  const overlay = generated.files.find(
    (f) => f.path === "src/components/SelfQAOverlay.tsx",
  );
  const layout = generated.files.find((f) => f.path === "src/app/layout.tsx");
  if (!overlay) throw new Error("overlay component was not injected");
  if (!layout || !layout.content.includes("SelfQAOverlay")) {
    throw new Error("layout was not instrumented to render the overlay");
  }
  console.log("instrumentation: overlay present + layout renders it");

  const id = "verify-instr";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);
  const running = await startApp(repo.dir, { id });
  const res = await fetch(running.url);
  const html = await res.text();
  console.log(`served ${res.status}, ${html.length} bytes`);
  await running.stop();

  if (res.status !== 200) {
    throw new Error(`instrumented app did not serve 200 (got ${res.status})`);
  }
  console.log("OK: instrumented app compiles and serves");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
