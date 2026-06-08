/**
 * M5-K — durable metadata schema (SPEC §11.1, §14.4).
 *
 * Idempotent DDL (CREATE TABLE IF NOT EXISTS) so opening an existing db is a
 * no-op and a fresh db is fully provisioned. node:sqlite ONLY — no Prisma, no
 * better-sqlite3, zero new deps (SPEC §5 locks the data layer; SelfQA's OWN
 * metadata is separate from a generated app's Prisma+SQLite).
 *
 * Design notes:
 *  - Heavy nested objects (trace, before-state, criteria results, the grounded
 *    tuple, the compiled action cache) are stored as JSON text columns. The keys
 *    the system actually QUERIES on — (mission_id, build_sha), (app_id, ...) —
 *    are real columns with primary keys, so the queryable shape is normalized
 *    while the leaves stay opaque.
 *  - `verdict` is its OWN table keyed PK(mission_id, build_sha): a verdict is a
 *    property of a (mission, build) pair (SPEC §9.1, §11.1), and that is the unit
 *    `upsertVerdict` and the run-to-run diff operate on. mission_run does NOT
 *    duplicate the verdict — getRun joins the two — so there is one source of
 *    truth per fact.
 *  - `assertion` mirrors each comment's typed assertion in queryable columns
 *    (the full tuple still lives in comment.feedback_json); a denormalized index,
 *    like verdict.
 *  - Booleans are stored as INTEGER 0/1 (SQLite has no boolean); the stores
 *    convert at the edge so both backends round-trip to identical JS booleans.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS app (
  app_id       TEXT PRIMARY KEY,
  prompt       TEXT NOT NULL,
  created_sha  TEXT,
  seq          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  app_id     TEXT NOT NULL,
  build_sha  TEXT NOT NULL,
  parent_sha TEXT,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (app_id, build_sha)
);

CREATE TABLE IF NOT EXISTS mission (
  mission_id   TEXT NOT NULL,
  app_id       TEXT NOT NULL,
  mission_json TEXT NOT NULL,
  PRIMARY KEY (app_id, mission_id)
);

CREATE TABLE IF NOT EXISTS mission_run (
  app_id               TEXT NOT NULL,
  build_sha            TEXT NOT NULL,
  mission_id           TEXT NOT NULL,
  trace_json           TEXT NOT NULL,
  before_state_json    TEXT,
  criteria_results_json TEXT,
  regression_promoted  INTEGER NOT NULL DEFAULT 0,
  retirement_reason    TEXT,
  seq                  INTEGER NOT NULL,
  PRIMARY KEY (app_id, build_sha, mission_id)
);

CREATE TABLE IF NOT EXISTS verdict (
  mission_id       TEXT NOT NULL,
  build_sha        TEXT NOT NULL,
  status           TEXT NOT NULL,
  ambiguous_reason TEXT,
  human_approved   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mission_id, build_sha)
);

CREATE TABLE IF NOT EXISTS mission_action_cache (
  app_id       TEXT NOT NULL,
  build_sha    TEXT NOT NULL,
  mission_id   TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  PRIMARY KEY (app_id, build_sha, mission_id)
);

CREATE TABLE IF NOT EXISTS comment (
  comment_id    TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,
  mission_id    TEXT,
  feedback_json TEXT NOT NULL,
  seq           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assertion (
  comment_id     TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL,
  type           TEXT NOT NULL,
  predicate_kind TEXT,
  selector       TEXT,
  expected       TEXT,
  nl             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regression_test (
  app_id            TEXT NOT NULL,
  mission_id        TEXT NOT NULL,
  human_approved    INTEGER NOT NULL DEFAULT 0,
  retirement_reason TEXT,
  seq               INTEGER NOT NULL,
  PRIMARY KEY (app_id, mission_id)
);

CREATE TABLE IF NOT EXISTS metric_event (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id    TEXT NOT NULL,
  type      TEXT NOT NULL,
  value     REAL NOT NULL,
  detail    TEXT,
  build_sha TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
