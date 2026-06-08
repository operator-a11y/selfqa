/**
 * M5-K — durable MetadataStore on node:sqlite (SPEC §5, §11.1, §14.4).
 *
 * node:sqlite's DatabaseSync ONLY — zero new dependencies (no Prisma, no
 * better-sqlite3). SelfQA's OWN metadata is deliberately separate from the
 * Prisma+SQLite a *generated* app may emit. WAL mode; ./selfqa.db is gitignored.
 *
 * The decomposition (verdict its own (mission_id, build_sha) table, heavy JSON in
 * mission_run) and the reassembly (`rebuildMissionRun`, `normalizeVerdict`) are
 * SHARED with the in-memory double via store.ts, so a round-trip through either
 * backend is identical — that equivalence is what verify-persist proves.
 *
 * Off the hot path: imports types + node:sqlite, never an LLM provider.
 */
import { DatabaseSync } from "node:sqlite";
import type {
  RunRecord,
  MissionRun,
  Mission,
  Verdict,
  GroundedFeedback,
  Action,
} from "../domain/types";
import type { RunDiff } from "../regression/diff";
import {
  type MetadataStore,
  type AppMeta,
  type RegressionTest,
  type MetricEvent,
  type MissionRunParts,
  diffFromRuns,
  normalizeVerdict,
  rebuildMissionRun,
} from "./store";
import { SCHEMA_SQL } from "./schema.sql";

/** undefined -> null (DatabaseSync binds null, not undefined). */
function n<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

export class SqliteStore implements MetadataStore {
  readonly kind = "sqlite" as const;
  private db: DatabaseSync;
  /** in-process monotonic ordering seq, re-seeded from the db at open (survives
   *  restart by reading MAX(seq), so "latest run" stays correct). */
  private seq: number;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA_SQL);
    this.seq = this.readMaxSeq();
  }

  private readMaxSeq(): number {
    const row = this.db
      .prepare(
        `SELECT MAX(s) AS m FROM (
           SELECT MAX(seq) AS s FROM app
           UNION ALL SELECT MAX(seq) FROM run
           UNION ALL SELECT MAX(seq) FROM mission_run
           UNION ALL SELECT MAX(seq) FROM comment
           UNION ALL SELECT MAX(seq) FROM regression_test
         )`,
      )
      .get() as { m: number | null } | undefined;
    return Number(row?.m ?? 0);
  }
  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // ── apps ──────────────────────────────────────────────────────────────────
  saveApp(app: AppMeta): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO app (app_id, prompt, created_sha, seq) VALUES (?,?,?,?)`)
      .run(app.appId, app.prompt, n(app.createdSha), this.nextSeq());
  }
  getApp(appId: string): AppMeta | null {
    const r = this.db.prepare(`SELECT * FROM app WHERE app_id=?`).get(appId) as
      | { app_id: string; prompt: string; created_sha: string | null }
      | undefined;
    return r ? appFromRow(r) : null;
  }
  listApps(): AppMeta[] {
    const rows = this.db.prepare(`SELECT * FROM app ORDER BY seq ASC`).all() as {
      app_id: string;
      prompt: string;
      created_sha: string | null;
    }[];
    return rows.map(appFromRow);
  }

  // ── runs ──────────────────────────────────────────────────────────────────
  saveRun(run: RunRecord, parentSha?: string): void {
    const tx = () => {
      this.db
        .prepare(`INSERT OR REPLACE INTO run (app_id, build_sha, parent_sha, seq) VALUES (?,?,?,?)`)
        .run(run.appId, run.buildSha, n(parentSha), this.nextSeq());
      for (const mr of run.missions) {
        const mid = mr.mission.id;
        this.db
          .prepare(`INSERT OR REPLACE INTO mission (mission_id, app_id, mission_json) VALUES (?,?,?)`)
          .run(mid, run.appId, JSON.stringify(mr.mission));
        this.db
          .prepare(
            `INSERT OR REPLACE INTO mission_run
             (app_id, build_sha, mission_id, trace_json, before_state_json,
              criteria_results_json, regression_promoted, retirement_reason, seq)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            run.appId,
            run.buildSha,
            mid,
            JSON.stringify(mr.trace),
            mr.beforeState ? JSON.stringify(mr.beforeState) : null,
            mr.criteriaResults ? JSON.stringify(mr.criteriaResults) : null,
            mr.regressionPromoted ? 1 : 0,
            n(mr.retirementProposed?.reason),
            this.nextSeq(),
          );
        this.upsertVerdict(mid, { ...mr.verdict, buildSha: run.buildSha });
        if (mr.trace.actions && mr.trace.actions.length) {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO mission_action_cache
               (app_id, build_sha, mission_id, actions_json) VALUES (?,?,?,?)`,
            )
            .run(run.appId, run.buildSha, mid, JSON.stringify(mr.trace.actions));
        }
      }
    };
    this.db.exec("BEGIN");
    try {
      tx();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getRun(appId: string, buildSha?: string): RunRecord | null {
    const sha = buildSha ?? this.latestSha(appId);
    if (!sha) return null;
    const hdr = this.db
      .prepare(`SELECT 1 FROM run WHERE app_id=? AND build_sha=?`)
      .get(appId, sha);
    if (!hdr) return null;
    const rows = this.db
      .prepare(`SELECT * FROM mission_run WHERE app_id=? AND build_sha=?`)
      .all(appId, sha) as unknown as MissionRunDbRow[];
    const missions: MissionRun[] = [];
    for (const row of rows) {
      const mr = this.db
        .prepare(`SELECT mission_json FROM mission WHERE app_id=? AND mission_id=?`)
        .get(appId, row.mission_id) as { mission_json: string } | undefined;
      const v = this.rawVerdict(row.mission_id, sha);
      if (!mr || !v) continue;
      const mission = JSON.parse(mr.mission_json) as Mission;
      missions.push(rebuildMissionRun(mission, v, sha, partsFromRow(row)));
    }
    const rank = (s: string): number => (s === "fail" ? 0 : s === "ambiguous" ? 1 : 2);
    missions.sort((a, b) => rank(a.verdict.status) - rank(b.verdict.status));
    return { appId, buildSha: sha, missions };
  }

  getCachedActions(appId: string, buildSha: string, missionId: string): Action[] | null {
    const r = this.db
      .prepare(
        `SELECT actions_json FROM mission_action_cache WHERE app_id=? AND build_sha=? AND mission_id=?`,
      )
      .get(appId, buildSha, missionId) as { actions_json: string } | undefined;
    return r ? (JSON.parse(r.actions_json) as Action[]) : null;
  }

  private latestSha(appId: string): string | undefined {
    const r = this.db
      .prepare(`SELECT build_sha FROM run WHERE app_id=? ORDER BY seq DESC LIMIT 1`)
      .get(appId) as { build_sha: string } | undefined;
    return r?.build_sha;
  }

  // ── verdicts ────────────────────────────────────────────────────────────────
  upsertVerdict(missionId: string, verdict: Verdict): void {
    if (!verdict.buildSha) throw new Error("upsertVerdict requires verdict.buildSha");
    this.db
      .prepare(
        `INSERT OR REPLACE INTO verdict
         (mission_id, build_sha, status, ambiguous_reason, human_approved) VALUES (?,?,?,?,?)`,
      )
      .run(
        missionId,
        verdict.buildSha,
        verdict.status,
        n(verdict.ambiguousReason),
        verdict.humanApproved ? 1 : 0,
      );
  }
  private rawVerdict(missionId: string, buildSha: string): Verdict | null {
    const r = this.db
      .prepare(`SELECT * FROM verdict WHERE mission_id=? AND build_sha=?`)
      .get(missionId, buildSha) as VerdictDbRow | undefined;
    if (!r) return null;
    return {
      status: r.status as Verdict["status"],
      ambiguousReason: r.ambiguous_reason ?? undefined,
      humanApproved: !!r.human_approved,
      buildSha,
    };
  }
  getVerdict(missionId: string, buildSha: string): Verdict | null {
    const v = this.rawVerdict(missionId, buildSha);
    return v ? normalizeVerdict(v, buildSha) : null;
  }

  // ── comments ────────────────────────────────────────────────────────────────
  saveComment(feedback: GroundedFeedback, appId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO comment (comment_id, app_id, mission_id, feedback_json, seq) VALUES (?,?,?,?,?)`,
      )
      .run(feedback.id, appId, n(feedback.missionId), JSON.stringify(feedback), this.nextSeq());
    const a = feedback.assertion;
    const predKind = a.type === "deterministic" ? a.predicate.kind : null;
    const selector = a.type === "deterministic" ? n(a.predicate.selector) : null;
    const expected =
      a.type === "deterministic" && a.predicate.expected !== undefined
        ? String(a.predicate.expected)
        : null;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO assertion (comment_id, app_id, type, predicate_kind, selector, expected, nl)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(feedback.id, appId, a.type, predKind, selector, expected, a.nl);
  }
  listComments(appId: string): GroundedFeedback[] {
    const rows = this.db
      .prepare(`SELECT feedback_json FROM comment WHERE app_id=? ORDER BY seq ASC`)
      .all(appId) as { feedback_json: string }[];
    return rows.map((r) => JSON.parse(r.feedback_json) as GroundedFeedback);
  }

  // ── regression lifecycle ─────────────────────────────────────────────────────
  promoteRegressionTest(appId: string, missionId: string): void {
    this.writeRegression(appId, missionId, true, undefined);
  }
  proposeRetirement(appId: string, missionId: string, reason: string): void {
    const existing = this.db
      .prepare(`SELECT human_approved FROM regression_test WHERE app_id=? AND mission_id=?`)
      .get(appId, missionId) as { human_approved: number } | undefined;
    this.writeRegression(appId, missionId, !!existing?.human_approved, reason);
  }
  approveRetirement(appId: string, missionId: string): void {
    this.writeRegression(appId, missionId, false, undefined);
  }
  private writeRegression(
    appId: string,
    missionId: string,
    humanApproved: boolean,
    retirementReason: string | undefined,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO regression_test
         (app_id, mission_id, human_approved, retirement_reason, seq) VALUES (?,?,?,?,?)`,
      )
      .run(appId, missionId, humanApproved ? 1 : 0, n(retirementReason), this.nextSeq());
  }
  listRegressionTests(appId: string): RegressionTest[] {
    const rows = this.db
      .prepare(`SELECT * FROM regression_test WHERE app_id=? ORDER BY seq ASC`)
      .all(appId) as unknown as RegressionDbRow[];
    return rows.map((r) => {
      const rt: RegressionTest = {
        appId: r.app_id,
        missionId: r.mission_id,
        humanApproved: !!r.human_approved,
      };
      if (r.retirement_reason !== null) rt.retirementProposed = { reason: r.retirement_reason };
      return rt;
    });
  }

  // ── metrics ──────────────────────────────────────────────────────────────────
  recordMetric(event: MetricEvent): void {
    this.db
      .prepare(`INSERT INTO metric_event (app_id, type, value, detail, build_sha) VALUES (?,?,?,?,?)`)
      .run(event.appId, event.type, event.value, n(event.detail), n(event.buildSha));
  }
  listMetrics(appId: string): MetricEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM metric_event WHERE app_id=? ORDER BY seq ASC`)
      .all(appId) as unknown as MetricDbRow[];
    return rows.map((r) => {
      const ev: MetricEvent = { appId: r.app_id, type: r.type, value: r.value };
      if (r.detail !== null) ev.detail = r.detail;
      if (r.build_sha !== null) ev.buildSha = r.build_sha;
      return ev;
    });
  }

  // ── derived ──────────────────────────────────────────────────────────────────
  diffRuns(appId: string, fromSha: string, toSha: string): RunDiff | null {
    return diffFromRuns(this, appId, fromSha, toSha);
  }

  getParallelDbVerdictsTrusted(): boolean {
    const r = this.db.prepare(`SELECT value FROM kv WHERE key=?`).get(PARALLEL_DB_KEY) as
      | { value: string }
      | undefined;
    return r?.value === "1";
  }
  setParallelDbVerdictsTrusted(trusted: boolean): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?,?)`)
      .run(PARALLEL_DB_KEY, trusted ? "1" : "0");
  }

  close(): void {
    this.db.close();
  }
}

const PARALLEL_DB_KEY = "parallel_db_verdicts_trusted";

interface MissionRunDbRow {
  app_id: string;
  build_sha: string;
  mission_id: string;
  trace_json: string;
  before_state_json: string | null;
  criteria_results_json: string | null;
  regression_promoted: number;
  retirement_reason: string | null;
}
interface VerdictDbRow {
  mission_id: string;
  build_sha: string;
  status: string;
  ambiguous_reason: Verdict["ambiguousReason"] | null;
  human_approved: number;
}
interface RegressionDbRow {
  app_id: string;
  mission_id: string;
  human_approved: number;
  retirement_reason: string | null;
}
interface MetricDbRow {
  app_id: string;
  type: string;
  value: number;
  detail: string | null;
  build_sha: string | null;
}

function appFromRow(r: { app_id: string; prompt: string; created_sha: string | null }): AppMeta {
  const a: AppMeta = { appId: r.app_id, prompt: r.prompt };
  if (r.created_sha !== null) a.createdSha = r.created_sha;
  return a;
}

function partsFromRow(row: MissionRunDbRow): MissionRunParts {
  const parts: MissionRunParts = {
    trace: JSON.parse(row.trace_json),
    regressionPromoted: !!row.regression_promoted,
  };
  if (row.before_state_json !== null) parts.beforeState = JSON.parse(row.before_state_json);
  if (row.criteria_results_json !== null) parts.criteriaResults = JSON.parse(row.criteria_results_json);
  if (row.retirement_reason !== null) parts.retirementReason = row.retirement_reason;
  return parts;
}
