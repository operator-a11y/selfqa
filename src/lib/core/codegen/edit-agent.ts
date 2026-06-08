/**
 * Edit-agent (SPEC §8.2) — a SMALL, localized edit to fix a grounded comment.
 *
 * It is a stateful editor of the persistent repo: it reads the current source,
 * asks the provider for the changed files only, writes them, and commits
 * (build = new SHA, SPEC §11.1). It does NOT regenerate the app.
 *
 * Server-only (node:fs + git via the workspace writer).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LLMProvider } from "../provider/types";
import { parseFileBlocks, isSafeRelativePath } from "./protocol";
import { EDIT_SYSTEM_PROMPT, editUserPrompt, editFromTuplesUserPrompt } from "./prompts";
import { listTrackedFiles, readFiles, commitAll } from "../workspace/repo";
import type { GroundedFeedback } from "../domain/types";

export interface EditResult {
  sha: string;
  changed: string[];
}

const SOURCE_RE = /\.(tsx?|jsx?|css|mjs|cjs|json)$/;

export async function editApp(
  provider: LLMProvider,
  args: { dir: string; comment: string; url: string; domPath: string },
): Promise<EditResult> {
  const tracked = await listTrackedFiles(args.dir);
  const sources = tracked.filter((p) => SOURCE_RE.test(p));
  const currentFiles = await readFiles(args.dir, sources);

  const res = await provider.complete({
    system: EDIT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: editUserPrompt({
          comment: args.comment,
          url: args.url,
          domPath: args.domPath,
          currentFiles,
        }),
      },
    ],
    maxTokens: 16384,
    temperature: 0,
  });

  const changed = parseFileBlocks(res.text);
  if (changed.length === 0) {
    throw new Error("edit-agent: provider returned no <selfqa:file> blocks");
  }

  for (const f of changed) {
    if (!isSafeRelativePath(f.path)) {
      throw new Error(`edit-agent: unsafe path ${JSON.stringify(f.path)}`);
    }
    const dest = path.join(args.dir, f.path);
    if (dest !== args.dir && !dest.startsWith(args.dir + path.sep)) {
      throw new Error(`edit-agent: path escapes app dir: ${f.path}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, "utf8");
  }

  const sha = await commitAll(
    args.dir,
    "selfqa: edit — " + args.comment.slice(0, 72),
  );
  return { sha, changed: changed.map((f) => f.path) };
}

/**
 * Tuple-consuming edit (M5-D, SPEC §3/§11.2): the edit-agent receives the FULL
 * grounded-feedback batch (assertion + prefix + captured DOM), makes the change
 * that flips each assertion, and produces ONE commit. Per-comment attribution is
 * free because each comment carries its own assertion (re-checked on re-walk).
 */
export async function editFromTuples(
  provider: LLMProvider,
  args: { dir: string; feedback: GroundedFeedback[] },
): Promise<EditResult> {
  if (args.feedback.length === 0) {
    throw new Error("editFromTuples: empty feedback batch");
  }

  // Pre-edit scoping from the TUPLE (not a not-yet-existing diff): prefer source
  // files containing any assertion's selector testid; fall back to all source.
  const tracked = await listTrackedFiles(args.dir);
  const all = await readFiles(args.dir, tracked.filter((p) => SOURCE_RE.test(p)));
  const testids = args.feedback
    .flatMap((f) =>
      f.assertion.type === "deterministic" && f.assertion.predicate.selector
        ? [(f.assertion.predicate.selector.match(/data-testid=([^\]]+)/) ?? [])[1]]
        : [],
    )
    .filter((t): t is string => !!t);
  const scoped = testids.length
    ? all.filter((f) => testids.some((t) => f.content.includes(`data-testid="${t}"`)))
    : [];
  const currentFiles = scoped.length ? scoped : all;

  const res = await provider.complete({
    system: EDIT_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: editFromTuplesUserPrompt({ feedback: args.feedback, currentFiles }) },
    ],
    maxTokens: 16384,
    temperature: 0,
  });

  const changed = parseFileBlocks(res.text);
  if (changed.length === 0) {
    throw new Error("editFromTuples: provider returned no <selfqa:file> blocks");
  }
  for (const f of changed) {
    if (!isSafeRelativePath(f.path)) {
      throw new Error(`editFromTuples: unsafe path ${JSON.stringify(f.path)}`);
    }
    const dest = path.join(args.dir, f.path);
    if (dest !== args.dir && !dest.startsWith(args.dir + path.sep)) {
      throw new Error(`editFromTuples: path escapes app dir: ${f.path}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, "utf8");
  }

  const sha = await commitAll(
    args.dir,
    "selfqa: edit (" + args.feedback.length + ") — " + args.feedback.map((f) => f.nl).join("; ").slice(0, 60),
  );
  return { sha, changed: changed.map((f) => f.path) };
}
