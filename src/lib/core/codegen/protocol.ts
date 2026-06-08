/**
 * Codegen I/O protocol (SPEC §8.2).
 *
 * The build-agent and edit-agent exchange files with the LLM as plain-text
 * blocks — robust to parse, LLM-friendly to emit, and the SAME format the
 * StubProvider produces so the stub is a true drop-in at the provider seam:
 *
 *   <selfqa:file path="relative/path.ext">
 *   ...verbatim file content...
 *   </selfqa:file>
 *
 * This module is isomorphic (pure string work) — safe to import anywhere.
 */

export interface GeneratedFile {
  /** repo-relative path, POSIX separators, no leading slash, no `..` */
  path: string;
  content: string;
}

const FILE_BLOCK = /<selfqa:file path="([^"]+)">\n([\s\S]*?)\n<\/selfqa:file>/g;

/** True if `p` is a safe repo-relative path (no absolute, no traversal). */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\")) return false;
  if (/(^|\/)\.\.(\/|$)/.test(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false; // windows drive
  return true;
}

/** Parse `<selfqa:file>` blocks out of an LLM response. Skips unsafe paths. */
export function parseFileBlocks(text: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const m of text.matchAll(FILE_BLOCK)) {
    const path = m[1].trim();
    const content = m[2];
    if (!isSafeRelativePath(path)) {
      // Loud, per SPEC §13.2 spirit: never silently drop a malformed instruction.
      console.warn(`[codegen] skipping unsafe file path: ${JSON.stringify(path)}`);
      continue;
    }
    files.push({ path, content });
  }
  return files;
}

/** Serialize files into the block format (used by StubProvider and tests). */
export function serializeFileBlocks(files: GeneratedFile[]): string {
  return files
    .map((f) => `<selfqa:file path="${f.path}">\n${f.content}\n</selfqa:file>`)
    .join("\n");
}
