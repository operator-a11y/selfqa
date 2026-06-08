/**
 * Mission walker (SPEC §7, §9). Walks each mission in a FRESH isolated
 * BrowserContext (per-mission isolation), captures per-step screenshot+DOM and a
 * per-mission video, and assembles the terminal ObservedState for the verdict
 * engine (M4-B). Retry-once: a fresh context + restore before replay; a final
 * failure yields a `reached: false` trace -> ambiguous:replay-failed downstream.
 *
 * HOT-PATH file (SPEC §6.3): Playwright + harness/walk only, NEVER a provider import.
 */
import path from "node:path";
import type { Browser } from "playwright";
import type { Action, Mission, MissionTrace, StepCapture } from "../domain/types";
import type { ObservedState } from "../verify/checker";
import type { IsolationProvider } from "./isolation";
import { pool } from "./pool";
import { installSettle, waitForSettled } from "../harness/settle";
import { executeAction } from "../harness/executor";
import {
  ARTIFACTS_ROOT,
  captureStep,
  buildObservedState,
  unreachableState,
} from "./capture";

export interface WalkedMission {
  trace: MissionTrace;
  observed: ObservedState;
}

export interface MissionPlan {
  mission: Mission;
  actions: Action[];
}

function criteriaSelectors(mission: Mission): string[] {
  const out: string[] = [];
  for (const c of mission.acceptanceCriteria) {
    if (c.type === "deterministic" && c.predicate.selector) {
      out.push(c.predicate.selector);
    }
  }
  return out;
}

function entryRouteOf(actions: Action[]): string {
  return actions.find((a) => a.kind === "navigate")?.value ?? "/";
}

export async function walkMission(
  browser: Browser,
  iso: IsolationProvider,
  baseUrl: string,
  runId: string,
  mission: Mission,
  actions: Action[],
  opts: { retries?: number; slotId?: number } = {},
): Promise<WalkedMission> {
  const maxAttempts = (opts.retries ?? 1) + 1;
  const slot = opts.slotId ?? 0;
  const entryRoute = entryRouteOf(actions);
  let last: MissionTrace | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const videoDir = path.join(ARTIFACTS_ROOT, runId, mission.id, `attempt-${attempt}`);
    const ctx = await browser.newContext({ recordVideo: { dir: videoDir } });
    const consoleErrors: string[] = [];
    let httpStatus: number | undefined;
    try {
      await iso.before(ctx, slot);
      const page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      await installSettle(page);
      const resp = await page.goto(baseUrl, { waitUntil: "load" });
      httpStatus = resp?.status();
      await waitForSettled(page);

      const steps: StepCapture[] = [];
      const cap0 = await captureStep(page, runId, mission.id, 0);
      steps.push({
        index: 0,
        actionKind: "navigate",
        action: { kind: "navigate", value: baseUrl },
        url: cap0.url,
        screenshot: cap0.screenshot,
        dom: cap0.dom,
      });

      for (let i = 0; i < actions.length; i++) {
        await executeAction(page, actions[i]);
        const cap = await captureStep(page, runId, mission.id, i + 1);
        steps.push({
          index: i + 1,
          actionKind: actions[i].kind,
          action: actions[i],
          url: cap.url,
          screenshot: cap.screenshot,
          dom: cap.dom,
        });
      }

      const observed = await buildObservedState(page, {
        httpStatus,
        consoleErrors,
        selectors: criteriaSelectors(mission),
      });
      await iso.after(ctx, slot);
      const vid = page.video();
      await ctx.close();
      const video = vid ? await vid.path().catch(() => undefined) : undefined;

      const trace: MissionTrace = {
        missionId: mission.id,
        reached: true,
        attempts: attempt,
        entryRoute,
        actions,
        steps,
        video,
        terminalUrl: observed.url,
        httpStatus,
        consoleErrors,
      };
      return { trace, observed };
    } catch (err) {
      if (process.env.SELFQA_WALK_DEBUG) console.error(`[walk fail] ${mission.id} attempt ${attempt}:`, err instanceof Error ? err.message : err);
      const vid = ctx.pages()[0]?.video();
      await ctx.close().catch(() => {});
      const video = vid ? await vid.path().catch(() => undefined) : undefined;
      // Retain the failing attempt's trace (the replay-failed evidence, §7.3).
      last = {
        missionId: mission.id,
        reached: false,
        attempts: attempt,
        entryRoute,
        actions,
        steps: [],
        video,
        terminalUrl: baseUrl,
        httpStatus,
        consoleErrors,
      };
    }
  }

  return { trace: last as MissionTrace, observed: unreachableState(baseUrl) };
}

export async function walkAll(
  browser: Browser,
  iso: IsolationProvider,
  /** a single shared server (kind 'none') OR one base url per lane (db-file-copy). */
  baseUrl: string | string[],
  runId: string,
  plans: MissionPlan[],
  concurrency = 4,
): Promise<WalkedMission[]> {
  const urlForSlot = (slot: number): string =>
    Array.isArray(baseUrl) ? baseUrl[slot] ?? baseUrl[0] : baseUrl;
  return pool(plans, concurrency, (p, slot) =>
    walkMission(browser, iso, urlForSlot(slot), runId, p.mission, p.actions, { slotId: slot }),
  );
}
