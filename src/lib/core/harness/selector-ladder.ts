/**
 * Selector ladder (SPEC §13.2) — resolve against the accessibility tree in
 * priority order: data-testid > role+name > text > xpath, with replay fallbacks.
 * Failures are logged LOUDLY.
 *
 * SelectorRef.value encoding per strategy:
 *   data-testid -> the testid          ("add-button")
 *   role+name   -> "role:name"          ("button:Add")  (name optional)
 *   text        -> the visible text      ("Add")
 *   xpath       -> an xpath expression   ("//button[1]")
 *
 * HOT-PATH file (SPEC §6.3): Playwright types only, NEVER a provider import.
 */
import type { Page, Locator } from "playwright";
import type { SelectorRef, SelectorStrategy } from "../domain/types";

export interface ResolveResult {
  locator: Locator;
  usedStrategy: SelectorStrategy;
  usedValue: string;
}

function toLocator(page: Page, strategy: SelectorStrategy, value: string): Locator {
  switch (strategy) {
    case "data-testid":
      return page.getByTestId(value);
    case "role+name": {
      const idx = value.indexOf(":");
      const role = (idx >= 0 ? value.slice(0, idx) : value) as Parameters<
        Page["getByRole"]
      >[0];
      const name = idx >= 0 ? value.slice(idx + 1) : undefined;
      return name ? page.getByRole(role, { name }) : page.getByRole(role);
    }
    case "text":
      return page.getByText(value);
    case "xpath":
      return page.locator(`xpath=${value}`);
    default:
      return page.locator(value);
  }
}

/** Resolve a SelectorRef, walking down the ladder; throws loudly if nothing resolves. */
export async function resolveSelector(
  page: Page,
  ref: SelectorRef,
): Promise<ResolveResult> {
  const ladder = [
    { strategy: ref.strategy, value: ref.value },
    ...(ref.fallbacks ?? []),
  ];

  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    const loc = toLocator(page, rung.strategy, rung.value);
    const count = await loc.count().catch(() => 0);
    if (count >= 1) {
      if (i > 0) {
        console.warn(
          `[selector-ladder] fell through to ${rung.strategy}=${rung.value} ` +
            `(primary ${ref.strategy}=${ref.value} missed)`,
        );
      }
      return { locator: loc.first(), usedStrategy: rung.strategy, usedValue: rung.value };
    }
  }

  console.warn(
    `[selector-ladder] LOUD MISS: no ladder rung resolved (primary ${ref.strategy}=${ref.value})`,
  );
  throw new Error(
    `selector-ladder: unresolved selector (primary ${ref.strategy}=${ref.value})`,
  );
}
