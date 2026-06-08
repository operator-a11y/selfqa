/**
 * Canned mission sets for StubProvider (SPEC §7.1), built against the REAL
 * testids of CANNED_TODO_APP.
 *
 * det:sem composition rule (resolves the §6.4-vs-whitelist tension): every
 * criterion COUNTED deterministic uses ONLY first-walk-verifiable kinds
 * (console-error-absent, url-equals) — so "counted deterministic" and
 * "machine-verifiable on first walk" AGREE. NO criterion uses text-equals.
 * Happy-path CONTENT checks (e.g. "count shows 1") are authored SEMANTIC, so
 * they are honestly counted semantic AND honestly ambiguous on first walk.
 */

const det = (kind: string, extra: Record<string, unknown>, nl: string) => ({
  type: "deterministic" as const,
  predicate: { kind, ...extra },
  nl,
});
const sem = (nl: string) => ({ type: "semantic" as const, nl });

const noConsoleErrors = det("console-error-absent", {}, "no console errors during the flow");
const staysOnRoot = det("url-equals", { expected: "/" }, "stays on the / route");

export const STUB_COLD_MISSIONS = {
  missions: [
    {
      id: "mission-page-loads",
      name: "Page loads cleanly",
      description: "Open the app and confirm it renders without errors.",
      intendedSteps: ["open the app at /"],
      acceptanceCriteria: [noConsoleErrors, staysOnRoot],
    },
    {
      id: "mission-add-todo",
      name: "Add a single todo",
      description: "Type a task and submit it.",
      intendedSteps: ["type 'buy milk' into the input", "click Add"],
      acceptanceCriteria: [
        noConsoleErrors,
        staysOnRoot,
        sem("the new todo appears in the list and the count shows 1 item"),
      ],
    },
    {
      id: "mission-add-empty",
      name: "Submit an empty todo",
      description: "Click Add with an empty input.",
      intendedSteps: ["leave the input empty", "click Add"],
      acceptanceCriteria: [
        noConsoleErrors,
        staysOnRoot,
        det(
          "element-visible",
          { selector: "[data-testid=error]" },
          "an error message is shown on empty submit",
        ),
      ],
    },
    {
      id: "mission-add-remove",
      name: "Add then remove a todo",
      description: "Add an item, then remove it.",
      intendedSteps: ["add 'task'", "click Remove on it"],
      acceptanceCriteria: [
        noConsoleErrors,
        staysOnRoot,
        sem("after removing, the list is empty and the count shows 0 items"),
      ],
    },
    {
      id: "mission-add-multiple",
      name: "Add several todos",
      description: "Add three separate items.",
      intendedSteps: ["add 'a'", "add 'b'", "add 'c'"],
      acceptanceCriteria: [
        noConsoleErrors,
        staysOnRoot,
        sem("three items are listed and the count shows 3 items"),
      ],
    },
    {
      id: "mission-long-input",
      name: "Submit a very long input",
      description: "A malicious user submits a 10k-character task.",
      intendedSteps: ["type a 10,000-character string", "click Add"],
      acceptanceCriteria: [noConsoleErrors, staysOnRoot],
    },
    {
      id: "mission-whitespace-input",
      name: "Submit whitespace-only input",
      description: "Submit a task that is only spaces.",
      intendedSteps: ["type '    '", "click Add"],
      acceptanceCriteria: [noConsoleErrors, staysOnRoot],
    },
    {
      id: "mission-rapid-duplicate",
      name: "Add the same text twice",
      description: "Add a task, then add an identical task.",
      intendedSteps: ["add 'dup'", "add 'dup' again"],
      acceptanceCriteria: [
        noConsoleErrors,
        staysOnRoot,
        sem("both identical items are shown as separate entries"),
      ],
    },
  ],
  reusedIds: [] as string[],
};

export const STUB_INFORMED_MISSIONS = {
  missions: [
    {
      id: "mission-submit-via-enter",
      name: "Add a todo with the Enter key",
      description: "Submit the form by pressing Enter instead of clicking Add.",
      intendedSteps: ["type 'via enter' into the input", "press Enter"],
      acceptanceCriteria: [noConsoleErrors, staysOnRoot],
    },
    {
      id: "mission-input-clears-after-add",
      name: "Input clears after adding",
      description: "After adding a todo the input should be empty for the next one.",
      intendedSteps: ["add 'first'", "observe the input"],
      acceptanceCriteria: [
        noConsoleErrors,
        staysOnRoot,
        sem("the input is cleared after a successful add"),
      ],
    },
  ],
  reusedIds: STUB_COLD_MISSIONS.missions.map((m) => m.id),
};
