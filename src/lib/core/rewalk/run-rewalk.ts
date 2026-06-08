/**
 * Re-walk + re-assert conductor (SPEC §3, §8.1) — headline part 2.
 *
 * walkAll (the EXISTING hot-path walker: parallel, isolated, zero LLM) replays the
 * affected missions on the edited build; then, for each comment, the assertion is
 * RE-ASSERTED through the SAME deterministic checker (via evaluateFlip) with the
 * "before" reconstructed from the genuinely-captured comment-time DOM and the
 * "after" from the re-walk's terminal DOM. needs-semantic comments are judged in
 * ONE batched off-loop call.
 *
 * Off-hot-path conductor. The per-comment evaluation between the
 * SELFQA-REWALK-LOOP sentinels is provider-free (no LLM, no compileSequence) and
 * verify-hot-path scans that region mechanically. The recompile pre-pass
 * (rewalk/plan.ts) and the single batchSemanticVerdict run OUTSIDE the loop.
 */
import type { Browser } from "playwright";
import { promises as fs } from "node:fs";
import type { LLMProvider } from "../provider/types";
import type { GroundedFeedback, ReWalkOutcome, ReWalkRecord } from "../domain/types";
import type { IsolationProvider } from "../walk/isolation";
import { walkAll, type MissionPlan } from "../walk/walker";
import { reconstructObservedFromDom } from "./observed-before";
import { evaluateFlip, type FlipResult } from "../verify/flip";
import { assignReWalkVerdict } from "../verify/rewalk-verdict";
import { batchSemanticVerdict, type SemanticItem } from "../verify/semantic";

export async function reWalk(args: {
  provider: LLMProvider;
  browser: Browser;
  iso: IsolationProvider;
  baseUrl: string;
  runId: string;
  buildSha: string;
  feedback: GroundedFeedback[];
  plans: MissionPlan[];
  recompiled: Record<string, boolean>;
}): Promise<ReWalkRecord> {
  // Hot-path: replay the affected missions (parallel, isolated, zero LLM).
  const walked = await walkAll(args.browser, args.iso, args.baseUrl, args.runId, args.plans, 4);
  const byMission = new Map(walked.map((w) => [w.trace.missionId, w]));

  const terminalDom = new Map<string, string>();
  for (const w of walked) {
    if (w.trace.reached && w.trace.steps.length) {
      const dom = await fs
        .readFile(w.trace.steps[w.trace.steps.length - 1].dom, "utf8")
        .catch(() => "");
      terminalDom.set(w.trace.missionId, dom);
    }
  }

  // ===== SELFQA-REWALK-LOOP-START (provider-free: no LLM, no recompile in here) =====
  const semanticItems: SemanticItem[] = [];
  const pending: { f: GroundedFeedback; flip: FlipResult; reached: boolean }[] = [];
  for (const f of args.feedback) {
    const w = byMission.get(f.missionId);
    const reached = !!(w && w.trace.reached && terminalDom.has(f.missionId));
    if (!reached) {
      pending.push({
        f,
        reached: false,
        flip: { status: "could-not-evaluate", detail: "mission unreached on re-walk", before: null, after: null },
      });
      continue;
    }
    const selectors =
      f.assertion.type === "deterministic" && f.assertion.predicate.selector
        ? [f.assertion.predicate.selector]
        : [];
    const before = await reconstructObservedFromDom(args.browser, f.snapshot.domHtml, selectors);
    const after = await reconstructObservedFromDom(args.browser, terminalDom.get(f.missionId)!, selectors);
    const flip = evaluateFlip(f.assertion, before, after);
    if (flip.status === "needs-semantic") {
      semanticItems.push({
        commentId: f.commentId,
        nl: f.nl,
        beforeSnapshot: f.snapshot.domHtml.slice(0, 800),
        afterSnapshot: (terminalDom.get(f.missionId) ?? "").slice(0, 800),
      });
    }
    pending.push({ f, flip, reached: true });
  }
  // ===== SELFQA-REWALK-LOOP-END =====

  // Off-loop: ONE batched semantic verdict for all needs-semantic comments.
  const sem = await batchSemanticVerdict(args.provider, semanticItems);
  const semMap = new Map(sem.map((s) => [s.commentId, s]));

  const outcomes: ReWalkOutcome[] = pending.map(({ f, flip, reached }) => {
    const v = assignReWalkVerdict({
      reached,
      buildSha: args.buildSha,
      flip,
      semantic: semMap.get(f.commentId),
    });
    return {
      commentId: f.commentId,
      missionId: f.missionId,
      assertionResult: flip.status,
      verdict: v.verdict,
      resolved: v.resolved,
      detail: flip.detail,
    };
  });

  const total = Object.keys(args.recompiled).length;
  const recompileRate = total
    ? Object.values(args.recompiled).filter(Boolean).length / total
    : 0;
  return { outcomes, recompileRate };
}
