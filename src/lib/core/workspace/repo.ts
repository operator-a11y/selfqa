/**
 * Workspace writer (SPEC §11.1, §14.2, §14.5).
 *
 * Each generated app is its own git repo under /workspace. The initial build is
 * the first commit; `build = commit SHA` (SPEC §11.1). SERVER-ONLY: uses
 * node:fs and git.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GeneratedFile } from "../codegen/protocol";
import { isSafeRelativePath } from "../codegen/protocol";
import {
  FIXTURES_FILENAME,
  parseFixturesManifest,
  type FixturesManifest,
} from "../codegen/fixtures";

const exec = promisify(execFile);

/** Root for all generated-app repos + their workspaces. Gitignored. */
export const WORKSPACE_ROOT = path.resolve(process.cwd(), "workspace");

export interface AppRepo {
  id: string;
  dir: string;
}

/** Write a generated app's files to /workspace/<id> and make the initial commit. */
export async function writeGeneratedApp(
  id: string,
  files: GeneratedFile[],
): Promise<AppRepo> {
  const dir = path.join(WORKSPACE_ROOT, id);
  await fs.mkdir(dir, { recursive: true });

  for (const f of files) {
    if (!isSafeRelativePath(f.path)) {
      throw new Error(`writeGeneratedApp: unsafe path ${JSON.stringify(f.path)}`);
    }
    const dest = path.join(dir, f.path);
    // Defense in depth: resolved path must stay within the app dir.
    if (dest !== dir && !dest.startsWith(dir + path.sep)) {
      throw new Error(`writeGeneratedApp: path escapes app dir: ${f.path}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, "utf8");
  }

  await gitInitialCommit(dir, "selfqa: initial build");
  return { id, dir };
}

async function gitInitialCommit(dir: string, message: string): Promise<void> {
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["add", "-A"], { cwd: dir });
  // The generated app's internal history uses a local identity — it is NOT
  // SelfQA's own repo, so this never affects SelfQA's commit authorship.
  await exec(
    "git",
    [
      "-c",
      "user.name=SelfQA",
      "-c",
      "user.email=selfqa@localhost",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: dir },
  );
}

/** Stage all changes and commit; returns the new SHA (used by the edit-agent). */
export async function commitAll(dir: string, message: string): Promise<string> {
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec(
    "git",
    [
      "-c",
      "user.name=SelfQA",
      "-c",
      "user.email=selfqa@localhost",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: dir },
  );
  return currentSha(dir);
}

export async function currentSha(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/** Read selected files back from a generated app (for the edit-agent context). */
export async function readFiles(
  dir: string,
  relPaths: string[],
): Promise<GeneratedFile[]> {
  const out: GeneratedFile[] = [];
  for (const rel of relPaths) {
    if (!isSafeRelativePath(rel)) continue;
    try {
      const content = await fs.readFile(path.join(dir, rel), "utf8");
      out.push({ path: rel, content });
    } catch {
      // missing file is not fatal here; the caller decides
    }
  }
  return out;
}

/** Git-tracked files in a generated app (excludes node_modules/.next via .gitignore). */
export async function listTrackedFiles(dir: string): Promise<string[]> {
  const { stdout } = await exec("git", ["ls-files"], { cwd: dir });
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Load + validate the app's fixtures manifest (SPEC §12). Absent file -> default
 * empty manifest; present-but-malformed -> loud throw (never a silent bad fixture).
 */
export async function loadFixtures(dir: string): Promise<FixturesManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, FIXTURES_FILENAME), "utf8");
  } catch {
    return parseFixturesManifest({});
  }
  return parseFixturesManifest(JSON.parse(raw));
}
