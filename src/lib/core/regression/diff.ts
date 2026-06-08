/**
 * Run-to-run diff (SPEC §7.5, §11.1) — PURE. The reviewable artifact: verdicts at
 * SHA_n vs SHA_{n-1}, matched by STABLE mission id. A DERIVED query, never a
 * stored second source of truth.
 *
 * Every mission falls into exactly one bucket: newly-pass (prev fail/ambiguous →
 * curr pass), newly-fail (prev pass → curr fail), changed-outcome (any other
 * status change), new-surface (no prev id), retired-surface (prev id gone), or
 * unchanged. `prev` may be null (the very first run) — then everything is a new
 * surface.
 */
import type { RunRecord, MissionDiffEntry, MissionDiffKind, RunDiff } from "../domain/types";

export type { RunDiff, MissionDiffEntry } from "../domain/types";

export function computeRunDiff(prev: RunRecord | null, curr: RunRecord): RunDiff {
  const prevById = new Map((prev?.missions ?? []).map((m) => [m.mission.id, m.verdict.status]));
  const currIds = new Set(curr.missions.map((m) => m.mission.id));

  const entries: MissionDiffEntry[] = [];
  const counts: RunDiff["counts"] = {
    newlyPass: 0,
    newlyFail: 0,
    changedOutcome: 0,
    newSurface: 0,
    retiredSurface: 0,
    unchanged: 0,
  };
  const bump = (k: MissionDiffKind): void => {
    if (k === "newly-pass") counts.newlyPass++;
    else if (k === "newly-fail") counts.newlyFail++;
    else if (k === "changed-outcome") counts.changedOutcome++;
    else if (k === "new-surface") counts.newSurface++;
    else if (k === "retired-surface") counts.retiredSurface++;
    else counts.unchanged++;
  };

  for (const m of curr.missions) {
    const to = m.verdict.status;
    const from = prevById.get(m.mission.id) ?? null;
    let kind: MissionDiffKind;
    if (from === null) kind = "new-surface";
    else if (from === to) kind = "unchanged";
    else if (to === "pass") kind = "newly-pass"; // from is fail|ambiguous
    else if (from === "pass" && to === "fail") kind = "newly-fail";
    else kind = "changed-outcome";
    bump(kind);
    entries.push({ missionId: m.mission.id, from, to, kind });
  }

  for (const [id, from] of prevById) {
    if (currIds.has(id)) continue;
    bump("retired-surface");
    entries.push({ missionId: id, from, to: null, kind: "retired-surface" });
  }

  return { fromSha: prev?.buildSha ?? null, toSha: curr.buildSha, entries, counts };
}

/** Convenience: the mission ids in a diff with a given kind (UI/log helper). */
export function idsOfKind(diff: RunDiff, kind: MissionDiffKind): string[] {
  return diff.entries.filter((e) => e.kind === kind).map((e) => e.missionId);
}
