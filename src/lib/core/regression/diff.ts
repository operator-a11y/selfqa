/**
 * Run-to-run diff (SPEC §7.5, §11.1) — PURE. The reviewable artifact: verdicts at
 * SHA_n vs SHA_{n-1}, matched by STABLE mission id. A derived query, never a
 * stored second source of truth.
 */
import type { MissionRun, VerdictStatus } from "../domain/types";

export interface RunDiff {
  newlyPass: string[];
  newlyFail: string[];
  changed: { missionId: string; from: VerdictStatus; to: VerdictStatus }[];
}

export function computeRunDiff(prior: MissionRun[], next: MissionRun[]): RunDiff {
  const before = new Map(prior.map((m) => [m.mission.id, m.verdict.status]));
  const newlyPass: string[] = [];
  const newlyFail: string[] = [];
  const changed: RunDiff["changed"] = [];
  for (const m of next) {
    const from = before.get(m.mission.id);
    if (from === undefined) continue; // a net-new mission is not a diff
    const to = m.verdict.status;
    if (from === to) continue;
    changed.push({ missionId: m.mission.id, from, to });
    if (to === "pass") newlyPass.push(m.mission.id);
    if (to === "fail") newlyFail.push(m.mission.id);
  }
  return { newlyPass, newlyFail, changed };
}
