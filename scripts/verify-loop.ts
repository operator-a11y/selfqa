/**
 * Checkpoint D — the M1 win condition (run: `npx tsx scripts/verify-loop.ts`).
 *
 * Proves the whole loop end-to-end, deterministically (stub), no API key:
 *   build → run → (comment → spec-extractor → edit → commit) → the running app
 *   reflects the change — and the comment→verified-change is under 60s.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { startApp } from "../src/lib/core/runner/app-runner";
import { extractSpec } from "../src/lib/core/codegen/spec-extractor";
import { editApp } from "../src/lib/core/codegen/edit-agent";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollFor(
  url: string,
  needle: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const html = await (await fetch(`${url}?t=${Date.now()}`)).text();
      if (html.includes(needle)) return true;
    } catch {
      /* dev server recompiling */
    }
    await delay(500);
  }
  return false;
}

async function main(): Promise<void> {
  const provider = new StubProvider();
  const id = "verify-loop";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });

  const generated = instrument(await buildApp(provider, "a simple todo app"));
  const repo = await writeGeneratedApp(id, generated.files);
  const running = await startApp(repo.dir, { id });

  const before = await (await fetch(running.url)).text();
  const original = before.includes("Todo") && !before.includes("edited by SelfQA");
  console.log(`before edit: original title present = ${original}`);

  const comment = "the title should indicate it was edited";
  const domPath = "[data-testid=title]";

  const t0 = Date.now();
  const spec = await extractSpec(provider, { comment, url: running.url, domPath });
  console.log(`spec-extractor -> assertion ${JSON.stringify(spec.assertion)}`);
  const edit = await editApp(provider, { dir: repo.dir, comment, url: running.url, domPath });
  console.log(`edit committed ${edit.sha} (changed: ${edit.changed.join(", ")})`);

  const reflected = await pollFor(running.url, "edited by SelfQA", 30_000);
  const elapsedMs = Date.now() - t0;
  console.log(
    `change reflected in running app: ${reflected} (comment→verified in ${elapsedMs}ms)`,
  );

  await running.stop();

  if (!original) throw new Error("precondition: original title not present before edit");
  if (!reflected) throw new Error("edit was not reflected in the running app");
  if (elapsedMs > 60_000) throw new Error(`exceeded 60s budget (${elapsedMs}ms)`);
  console.log("OK: M1 loop — comment → code change → verified in running app, < 60s");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
