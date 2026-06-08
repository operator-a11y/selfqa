/**
 * Convergence loop (SPEC §11.3) — the loop provably terminates at a MECHANICAL
 * cap (a count, never "codegen thinks it's stuck", P1). Loop control is decoupled
 * from the heavy edit->rebuild->re-walk iteration via an injected `runIteration`
 * (the real one — diff-scoped re-walk — is wired in the worker, M6-A), so the
 * termination guarantee is testable without builds. After the cap, the remaining
 * comments are unresolved:needs-human. Records attempts-to-resolution (metric 4).
 */
export interface LoopResult {
  resolvedCommentIds: string[];
  unresolvedCommentIds: string[];
  attemptsByComment: Record<string, number>;
  iterations: number;
}

export async function converge(args: {
  commentIds: string[];
  cap?: number;
  runIteration: (unresolved: string[], iteration: number) => Promise<{ resolved: string[] }>;
}): Promise<LoopResult> {
  const cap = args.cap ?? 3;
  const resolved = new Set<string>();
  const attempts: Record<string, number> = {};
  let unresolved = [...args.commentIds];
  let iterations = 0;

  while (unresolved.length > 0 && iterations < cap) {
    iterations++;
    for (const id of unresolved) attempts[id] = (attempts[id] ?? 0) + 1;
    const r = await args.runIteration(unresolved, iterations);
    for (const id of r.resolved) resolved.add(id);
    unresolved = unresolved.filter((id) => !resolved.has(id));
  }

  return {
    resolvedCommentIds: [...resolved],
    unresolvedCommentIds: unresolved,
    attemptsByComment: attempts,
    iterations,
  };
}
