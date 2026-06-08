/**
 * M3-E — fixtures contract + known-error convention (no API key, no browser).
 * Run: `npx tsx scripts/verify-fixtures.ts`.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { StubProvider } from "../src/lib/core/provider/stub";
import { buildApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import { writeGeneratedApp, loadFixtures, WORKSPACE_ROOT } from "../src/lib/core/workspace/repo";
import { parseFixturesManifest } from "../src/lib/core/codegen/fixtures";

let failures = 0;
function truthy(name: string, cond: boolean): void {
  if (cond) console.log("ok   " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
}

async function main(): Promise<void> {
  const generated = instrument(await buildApp(new StubProvider(), "a todo app"));

  truthy(
    "build-agent emits selfqa.fixtures.json (app + fixtures, SPEC §12)",
    generated.files.some((f) => f.path === "selfqa.fixtures.json"),
  );

  const page = generated.files.find((f) => f.path === "src/app/page.tsx");
  truthy(
    "canned app emits a known-error selector (non-vacuous verdict, SPEC §7.2)",
    !!page &&
      (page.content.includes('data-testid="error"') ||
        page.content.includes('role="alert"')),
  );

  const id = "verify-fixtures";
  await rm(path.join(WORKSPACE_ROOT, id), { recursive: true, force: true });
  const repo = await writeGeneratedApp(id, generated.files);
  const manifest = await loadFixtures(repo.dir);
  truthy(
    "fixtures manifest loads + validates",
    manifest.snapshotRestore.kind === "none" && Array.isArray(manifest.seedUsers),
  );

  let threw = false;
  try {
    parseFixturesManifest({ seedUsers: [{ id: "" }] }); // missing email/password, empty id
  } catch {
    threw = true;
  }
  truthy("malformed manifest throws (loud, never silent)", threw);

  const empty = parseFixturesManifest({});
  truthy(
    "absent/empty manifest defaults cleanly",
    empty.seedUsers.length === 0 && empty.snapshotRestore.kind === "none",
  );

  if (failures) {
    console.error("\n" + failures + " fixtures check(s) FAILED");
    process.exit(1);
  }
  console.log("\nOK: fixtures contract green");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
