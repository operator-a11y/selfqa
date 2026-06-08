/**
 * Action executor (SPEC §3, §13) — replays a recorded Action[] against a page,
 * waiting for the settling predicate after each step. Assumes installSettle()
 * was called on the page before its first navigation.
 *
 * HOT-PATH file (SPEC §6.3): Playwright + harness only, NEVER a provider import.
 */
import type { Page } from "playwright";
import type { Action } from "../domain/types";
import { resolveSelector } from "./selector-ladder";
import { waitForSettled } from "./settle";

export async function executeAction(page: Page, action: Action): Promise<void> {
  switch (action.kind) {
    case "navigate":
      // "load" (not "domcontentloaded") so scripts are in and React can hydrate;
      // NEVER "networkidle" — Next dev's HMR socket would hang it (SPEC §13.3).
      await page.goto(action.value ?? "/", { waitUntil: "load" });
      break;
    case "wait":
      break;
    case "click": {
      const { locator } = await needTarget(page, action);
      await locator.click();
      break;
    }
    case "type": {
      const { locator } = await needTarget(page, action);
      // Real keystrokes: Playwright's fill() does NOT reliably trigger React
      // controlled-input onChange in this stack; pressSequentially does.
      // Select-all + Delete first so the field is cleared the same (React-safe) way.
      await locator.click();
      await locator.press("ControlOrMeta+a");
      await locator.press("Delete");
      await locator.pressSequentially(action.value ?? "");
      break;
    }
    case "press": {
      const { locator } = await needTarget(page, action);
      await locator.press(action.value ?? "Enter");
      break;
    }
    case "select": {
      const { locator } = await needTarget(page, action);
      await locator.selectOption(action.value ?? "");
      break;
    }
  }
  await waitForSettled(page);
}

async function needTarget(page: Page, action: Action) {
  if (!action.target) {
    throw new Error(`executor: action '${action.kind}' requires a target selector`);
  }
  return resolveSelector(page, action.target);
}

export async function executeSequence(page: Page, actions: Action[]): Promise<void> {
  for (const action of actions) {
    await executeAction(page, action);
  }
}
