/**
 * Tuple assembler (SPEC §3, §10) — unify the five legs of grounded executable
 * feedback. Lives in codegen/ (drives the provider via the spec-extractor), so the
 * hot-path rule (walk/ + harness/) is preserved.
 *
 * If the coordinate is unresolvable (empty trace / out-of-range / missing
 * artifact) it routes to needs-human — a tuple is NEVER fabricated (P2; §10.2
 * "a grounded-looking tuple aimed at the wrong target is lying").
 *
 * commentType comes from the UI affordance (§10.3), never parsed from text; the
 * spec-extractor's single clarifying question is the only sanctioned reclassifier.
 */
import type { LLMProvider } from "../provider/types";
import type { CommentType, GroundedFeedback, MissionTrace } from "../domain/types";
import { resolveTuplePrefix } from "../walk/comment-anchor";
import { extractSpec } from "./spec-extractor";

export type AssembleResult =
  | { ok: true; feedback: GroundedFeedback }
  | { ok: false; route: "needs-human"; reason: string };

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return prefix + "-" + seq;
}

export async function assembleTuple(
  provider: LLMProvider,
  args: {
    trace: MissionTrace;
    stepIndex?: number;
    nl: string;
    commentType: CommentType;
    commentId?: string;
  },
): Promise<AssembleResult> {
  const resolved = await resolveTuplePrefix(args.trace, args.stepIndex);
  if ("unresolved" in resolved) {
    return { ok: false, route: "needs-human", reason: resolved.unresolved };
  }

  const spec = await extractSpec(provider, {
    comment: args.nl,
    url: resolved.snapshot.url,
    domPath: resolved.snapshot.domPath,
  });

  const feedback: GroundedFeedback = {
    id: nextId("fb"),
    commentId: args.commentId ?? nextId("comment"),
    missionId: args.trace.missionId,
    stepIndex: args.stepIndex,
    commentType: args.commentType,
    actionSequencePrefix: resolved.actionSequencePrefix,
    snapshot: resolved.snapshot,
    nl: args.nl,
    assertion: spec.assertion,
  };
  return { ok: true, feedback };
}
