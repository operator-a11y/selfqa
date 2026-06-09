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
import type { Browser, Page } from "playwright";
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
    // Declared outside the try so a FAILED walk can still surface the partial
    // trace (the steps reached before the break) for human commenting (SPEC §7.3).
    const steps: StepCapture[] = [];
    let page: Page | undefined;
    try {
      await iso.before(ctx, slot);
      page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      await installSettle(page);
      const resp = await page.goto(baseUrl, { waitUntil: "load" });
      httpStatus = resp?.status();
      await waitForSettled(page);

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
      // Best-effort failure-point snapshot: append a step for WHERE it broke so the
      // human has a concrete locus to comment on (the last reached step before the
      // failing action). `actions[steps.length - 1]` is the action being attempted
      // when it threw (steps holds navigate + every action that DID complete).
      const failedAction = actions[steps.length - 1];
      if (page) {
        try {
          const capF = await captureStep(page, runId, mission.id, steps.length);
          steps.push({
            index: steps.length,
            actionKind: failedAction?.kind ?? "navigate",
            action: failedAction ?? { kind: "navigate", value: baseUrl },
            url: capF.url,
            screenshot: capF.screenshot,
            dom: capF.dom,
          });
        } catch {
          /* page too broken to snapshot — keep whatever steps we already have */
        }
      }
      const vid = page?.video();
      await ctx.close().catch(() => {});
      const video = vid ? await vid.path().catch(() => undefined) : undefined;
      // Retain the failing attempt's PARTIAL trace (the replay-failed evidence,
      // §7.3) — not an empty trace, so a failed mission stays commentable.
      last = {
        missionId: mission.id,
        reached: false,
        attempts: attempt,
        entryRoute,
        actions,
        steps: [...steps],
        video,
        terminalUrl: steps.length ? steps[steps.length - 1].url : baseUrl,
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
