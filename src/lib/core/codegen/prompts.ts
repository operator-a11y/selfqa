/**
 * Codegen prompts. Every system prompt's FIRST line is a canonical role token
 * `selfqa-role: <role>` and the StubProvider routes on that EXACT token (not
 * loose substrings) — so a prompt body that mentions build/edit/spec can never
 * misroute. Pure strings (+ type-only imports) — safe to import anywhere.
 */
import type { GeneratedFile } from "./protocol";
import type { Mission, GroundedFeedback } from "../domain/types";

export const BUILD_SYSTEM_PROMPT = `selfqa-role: build-agent
You are SelfQA's build-agent.

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
- Mark every error/validation message with a known-error selector so SelfQA can
  machine-verify error states: role="alert", or data-testid="error" / data-testid
  ending in "-error", or aria-invalid="true" (SPEC §7.2).
- Keep the app small and focused: a handful of routes and real forms.
- Do not reach external services; all I/O must be local or mocked (SPEC §12/§14.3).`;

export function buildUserPrompt(appPrompt: string): string {
  return `Build this app:\n\n${appPrompt}\n\nRemember: output only <selfqa:file> blocks.`;
}

export const EDIT_SYSTEM_PROMPT = `selfqa-role: edit-agent
You are SelfQA's edit-agent.

You make a SMALL, localized edit to an existing app to address one or more
grounded comments. You are a stateful editor of a persistent repo (SPEC §8.2):
change as few files as possible; do NOT regenerate the app. Keep test-ids and
seed-entity identities stable (SPEC §9.4). Output ONLY the changed files as
<selfqa:file> blocks (full file contents for each changed file).

When given grounded feedback, each comment carries the typed assertion that will
be MECHANICALLY re-checked after your edit — make the change that flips it.`;

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

export const SPEC_EXTRACTOR_SYSTEM_PROMPT = `selfqa-role: spec-extractor
You are SelfQA's spec-extractor.

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

export const MISSION_DERIVER_SYSTEM_PROMPT = `selfqa-role: mission-deriver
You are SelfQA's mission-deriver.

From the app prompt + code, derive 8-15 named user missions. Each mission is:
{ "id": "mission-<kebab-case>", "name", "description", "intendedSteps": [NL steps], "acceptanceCriteria": [typed assertions] }

Rules:
- intendedSteps are NATURAL-LANGUAGE intent only — never selectors (P2).
- acceptanceCriteria are typed exactly like comment assertions (SPEC §6.1):
  deterministic {type,predicate:{kind,selector?,expected?},nl} or semantic {type,nl}.
- Do NOT invent fake-precise deterministic predicates; if a check needs taste, mark
  it semantic (P1). Prefer deterministic only where it is truly mechanical.
- Cover happy paths, empty/invalid input, and at least one adversarial/abuse mission.
- On an INFORMED run, propose NET-NEW missions only and list the existing ids in reusedIds.
- Output ONLY JSON: {"missions":[...],"reusedIds":[...]}. No prose, no fences.`;

export function missionDeriverUserPrompt(args: {
  appPrompt: string;
  files: GeneratedFile[];
  existingMissions?: Mission[];
  frozenRegressionTests?: Mission[];
}): string {
  const informed =
    (args.existingMissions?.length ?? 0) > 0 ||
    (args.frozenRegressionTests?.length ?? 0) > 0;
  const fileList = args.files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");
  const lines = [
    `MODE: ${informed ? "informed" : "cold"}`,
    `App prompt: ${args.appPrompt}`,
    ``,
    `Code:`,
    fileList,
  ];
  if (informed) {
    const existing = [
      ...(args.existingMissions ?? []),
      ...(args.frozenRegressionTests ?? []),
    ];
    lines.push(
      ``,
      `EXISTING MISSIONS (do NOT regenerate these; propose NET-NEW only, and put their ids in reusedIds):`,
    );
    for (const m of existing) lines.push(`- ${m.id}: ${m.name}`);
  }
  lines.push(``, `Return ONLY the JSON {"missions":[...],"reusedIds":[...]}.`);
  return lines.join("\n");
}

export const MISSION_COMPILER_SYSTEM_PROMPT = `selfqa-role: mission-compiler
You are SelfQA's mission-compiler.

Compile a mission's natural-language intendedSteps into a deterministic Action[]
the harness can replay. Each action:
{ "kind": "navigate"|"click"|"type"|"press"|"select"|"wait",
  "target"?: { "strategy": "data-testid"|"role+name"|"text"|"xpath", "value": "...", "fallbacks"?: [{ "strategy": "...", "value": "..." }] },
  "value"?: "text to type / key to press / url / option" }

Rules:
- Prefer data-testid targets (top of the selector ladder).
- For list items, emit an UNAMBIGUOUS target (indexed/scoped) — never one that
  matches many elements.
- Do NOT include the initial page load — the walker navigates first.
- Output ONLY JSON: {"actions":[...]}. No prose, no fences.`;

export function missionCompilerUserPrompt(
  mission: Mission,
  files: GeneratedFile[],
): string {
  const fileList = files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");
  return [
    `Mission id: ${mission.id}`,
    `Mission: ${mission.name} — ${mission.description}`,
    `Intended steps:`,
    ...mission.intendedSteps.map((s, i) => `  ${i + 1}. ${s}`),
    ``,
    `Code:`,
    fileList,
    ``,
    `Return ONLY {"actions":[...]}.`,
  ].join("\n");
}

/** A small anchored DOM excerpt around the assertion's selector (not the whole page). */
function domExcerpt(html: string, selector?: string): string {
  if (selector) {
    const tid = (selector.match(/data-testid=([^\]]+)/) ?? [])[1];
    if (tid) {
      const idx = html.indexOf(`data-testid="${tid}"`);
      if (idx >= 0) {
        return html
          .slice(Math.max(0, idx - 80), idx + 160)
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }
  return html.slice(0, 200).replace(/\s+/g, " ").trim();
}

/**
 * Render the full grounded-feedback tuple for the edit-agent (M5-D): per comment,
 * the NL + the MACHINE-READABLE assertion (SELFQA-ASSERT …) + the reproduction
 * steps + the captured DOM excerpt — so codegen can CONSUME the assertion, and the
 * stub can make its edit a function of it (not an unconditional flip).
 */
export function editFromTuplesUserPrompt(args: {
  feedback: GroundedFeedback[];
  currentFiles: { path: string; content: string }[];
}): string {
  const blocks = args.feedback
    .map((f, i) => {
      const a = f.assertion;
      const assertLine =
        a.type === "deterministic"
          ? `SELFQA-ASSERT selector=${a.predicate.selector ?? ""} kind=${a.predicate.kind} expected=${JSON.stringify(String(a.predicate.expected ?? ""))}\nSELFQA-ASSERT-END`
          : `SELFQA-ASSERT semantic nl=${JSON.stringify(a.nl)}\nSELFQA-ASSERT-END`;
      const steps = f.actionSequencePrefix.length
        ? f.actionSequencePrefix
            .map(
              (s, j) =>
                `    ${j + 1}. ${s.kind}${s.target ? " @" + s.target.value : ""}${s.value !== undefined ? " = " + JSON.stringify(s.value) : ""}`,
            )
            .join("\n")
        : "    (none)";
      const excerpt = domExcerpt(
        f.snapshot.domHtml,
        a.type === "deterministic" ? a.predicate.selector : undefined,
      );
      return [
        `Comment ${i + 1} — mission ${f.missionId}${typeof f.stepIndex === "number" ? ` step ${f.stepIndex}` : ""} (${f.commentType}):`,
        `  NL: ${f.nl}`,
        `  Assertion (will be MECHANICALLY re-checked after your edit):`,
        `  ${assertLine}`,
        `  Reproduction steps:`,
        steps,
        `  Captured DOM excerpt at the comment: ${excerpt}`,
      ].join("\n");
    })
    .join("\n\n");

  const files = args.currentFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  return [
    blocks,
    "",
    "Current files:",
    files,
    "SELFQA-FILES-END",
    "",
    "Return only the changed <selfqa:file> blocks.",
  ].join("\n");
}

export const SEMANTIC_VERDICT_SYSTEM_PROMPT = `selfqa-role: semantic-verdict
You are SelfQA's semantic-verdict judge (SPEC §6.1). For each comment, decide
whether its intent is satisfied by comparing the BEFORE and AFTER snapshots, with a
confidence. Output ONLY {"verdicts":[{"commentId":"...","satisfied":true|false|null,"confidence":"high"|"low"}]}.`;

export function semanticVerdictUserPrompt(
  items: { commentId: string; nl: string; beforeSnapshot: string; afterSnapshot: string }[],
): string {
  return [
    "Judge each comment's intent (satisfied true/false/null + confidence high/low).",
    "SELFQA-SEM-ITEMS-START",
    JSON.stringify(items),
    "SELFQA-SEM-ITEMS-END",
    'Return ONLY {"verdicts":[...]}.',
  ].join("\n");
}
