/**
 * Codegen prompts (used by the real AnthropicProvider path). The StubProvider
 * keys off the `build-agent` / `edit-agent` markers in these system prompts to
 * decide which canned response to return, so the prompts double as routing.
 *
 * Pure strings — safe to import anywhere.
 */

export const BUILD_SYSTEM_PROMPT = `You are SelfQA's build-agent.

You build a complete, runnable web app from a natural-language prompt in EXACTLY
this stack: Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui, with a
Prisma + SQLite data layer when persistence is needed.

Hard rules:
- Output ONLY a sequence of file blocks, nothing else (no prose, no markdown fences):
    <selfqa:file path="relative/path.ext">
    ...file content...
    </selfqa:file>
- Emit a working package.json with pinned, compatible versions and dev/build/start scripts.
- Put stable data-testid attributes on every interactive and assertable element
  (SPEC §13.2 — they are the top rung of the selector ladder).
- Keep the app small and focused: a handful of routes and real forms.
- Do not reach external services; all I/O must be local or mocked (SPEC §12/§14.3).`;

export function buildUserPrompt(appPrompt: string): string {
  return `Build this app:\n\n${appPrompt}\n\nRemember: output only <selfqa:file> blocks.`;
}

export const EDIT_SYSTEM_PROMPT = `You are SelfQA's edit-agent.

You make a SMALL, localized edit to an existing app to address one or more
grounded comments. You are a stateful editor of a persistent repo (SPEC §8.2):
change as few files as possible; do NOT regenerate the app. Keep test-ids and
seed-entity identities stable (SPEC §9.4). Output ONLY the changed files as
<selfqa:file> blocks (full file contents for each changed file).`;

export function editUserPrompt(args: {
  comment: string;
  url: string;
  domPath: string;
  currentFiles: { path: string; content: string }[];
}): string {
  const fileList = args.currentFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");
  return [
    `Grounded comment: ${args.comment}`,
    `At URL: ${args.url}`,
    `On element (DOM path): ${args.domPath}`,
    ``,
    `Current files:`,
    fileList,
    ``,
    `Return only the changed <selfqa:file> blocks.`,
  ].join("\n");
}

export const SPEC_EXTRACTOR_SYSTEM_PROMPT = `You are SelfQA's spec-extractor.

Given a human comment anchored to a specific element, turn it into a typed
assertion (SPEC §6.1):
- deterministic: a mechanically-checkable predicate (kind is one of: http-status,
  url-equals, element-visible, element-absent, text-equals,
  form-validation-blocks, console-error-absent) when the comment can be made crisp;
- semantic: when the comment is irreducibly about taste.

If the comment is vague, include exactly ONE clarifyingQuestion; otherwise null.
Respond with ONLY a JSON object, no prose:
{"assertion":{"type":"deterministic","predicate":{"kind":"...","selector":"...","expected":"..."},"nl":"..."},"clarifyingQuestion":null}
or
{"assertion":{"type":"semantic","nl":"..."},"clarifyingQuestion":null}`;

export function specExtractorUserPrompt(args: {
  comment: string;
  url: string;
  domPath: string;
}): string {
  return [
    `Comment: ${args.comment}`,
    `URL: ${args.url}`,
    `Element (DOM path): ${args.domPath}`,
    `Return only the JSON object.`,
  ].join("\n");
}
