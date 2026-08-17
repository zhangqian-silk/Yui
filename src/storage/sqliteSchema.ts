/**
 * SQLite WAL control-plane schema and migration runner (task-21, work-item-3).
 *
 * This is the normalized, `task_id`-partitioned schema that replaces the single
 * aggregate `state.json` document. It implements the logical schema from
 * `docs/sqlite-control-plane-design.md` §4 (31 tables) plus the cross-task
 * coordination tables the design references in §5:
 *
 *   - `global_sequences` (§5.3): global record ID high-water marks.
 *   - `outbox` (§5.4): durable outbox with `UNIQUE(request_id)` for exactly-once.
 *   - `config`: the `YuiConfig` singleton (the design keeps `home_meta` for
 *     identity/revision/versions; config is a separate singleton).
 *
 * Record payloads are stored two ways, per §4: typed columns for fields that are
 * queried/filtered/used-for-CAS, and a `payload` JSON column holding the full
 * versioned record (including its family `schemaVersion`). The record axis of
 * the three-axis versioning is therefore unchanged.
 *
 * The migration runner is idempotent: it records applied versions in
 * `schema_migrations` and uses `CREATE TABLE IF NOT EXISTS`, so re-running on an
 * already-current database is a no-op and a crash mid-migration is rolled back
 * by SQLite (DDL is transactional) and re-applied on the next open.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** The SQLite layout version (state.json layout 6 -> SQLite layout 7, per §8.1). */
export const SQLITE_LAYOUT_VERSION = 7;
/** The aggregate version of the normalized SQLite schema. */
export const SQLITE_AGGREGATE_VERSION = 1;
/** The current schema migration version. */
export const SQLITE_SCHEMA_VERSION = 6;

/** Telemetry retention bounds (§4.4). Open question 3 in §11; defaults from the design. */
export const TELEMETRY_KEEP_PER_GENERATION = 200;
export const TELEMETRY_RUN_CAP = 50_000;

/**
 * Version 1 migration: creates every table and index.
 *
 * `synchronous`/`foreign_keys`/`busy_timeout` are per-connection PRAGMAs set by
 * the store; `journal_mode=WAL` is a persistent database property set on open.
 * The migration itself only contains schema objects.
 */
const MIGRATION_1_SQL = `
-- Global catalog and coordination (§4.1) -------------------------------------

CREATE TABLE IF NOT EXISTS home_meta (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  home_identity     TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  layout_version    INTEGER NOT NULL,
  aggregate_version INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS configured_agents (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_roles (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_role_session_sets (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (name) REFERENCES global_roles(name)
);

-- Global record ID high-water marks (§5.3).
CREATE TABLE IF NOT EXISTS global_sequences (
  name       TEXT PRIMARY KEY,
  high_water INTEGER NOT NULL
);

-- Task catalog: the global active index and lifecycle lookup.
CREATE TABLE IF NOT EXISTS tasks_catalog (
  task_id     TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  lifecycle   TEXT NOT NULL,
  is_active   INTEGER NOT NULL CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks_catalog(is_active) WHERE is_active = 1;

-- Session/Workspace ownership is global (workspaces outlive task activity).
CREATE TABLE IF NOT EXISTS managed_workspaces (
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN
                ('task','work-item','review-round','integration-attempt','execution-lane')),
  owner_id    TEXT NOT NULL,
  task_id     TEXT,
  path        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_workspaces_task ON managed_workspaces(task_id);

-- Per-task record ID high-water marks (replaces StoredTask.idHighWaterMarks).
CREATE TABLE IF NOT EXISTS id_sequences (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  high_water INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind)
);

-- Cross-task coordination: Project locks and the Integration queue.
CREATE TABLE IF NOT EXISTS coordination_locks (
  lock_key     TEXT PRIMARY KEY,
  holder_task  TEXT NOT NULL,
  holder_ref   TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT
);

CREATE TABLE IF NOT EXISTS integration_queue (
  queue_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  change_set   TEXT NOT NULL,
  status       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_queue_status ON integration_queue(status, created_at);

-- Durable outbox (§5.4): UNIQUE(request_id) makes cross-task effects exactly-once.
CREATE TABLE IF NOT EXISTS outbox (
  outbox_id  INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  command    TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state, created_at);

-- Mailboxes (§4.2): per-target ordering and exactly-once signals. -------------

CREATE TABLE IF NOT EXISTS mailboxes (
  mailbox_id    INTEGER PRIMARY KEY,
  target_kind   TEXT NOT NULL CHECK (target_kind IN
                  ('task','role','role-runtime','global-role-runtime','operator')),
  task_id       TEXT,
  role_name     TEXT,
  -- The stable mailboxTargetKey string carries the real uniqueness: the column
  -- UNIQUE below cannot, because NULL task_id/role_name (the 'operator' and
  -- 'global-role-runtime' targets) are distinct under SQL NULL semantics.
  target_key    TEXT NOT NULL,
  next_sequence INTEGER NOT NULL,
  processing    TEXT,
  pending       TEXT,
  UNIQUE (target_kind, task_id, role_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_target_key
  ON mailboxes(target_key);

-- Signals are the durable append log; (mailbox, sequence) is the exactly-once key.
CREATE TABLE IF NOT EXISTS mailbox_signals (
  mailbox_id   INTEGER NOT NULL,
  sequence     INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  ref_type     TEXT,
  ref_task_id  TEXT,
  ref_id       TEXT,
  occurred_at  TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, sequence),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(mailbox_id)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_signals_request ON mailbox_signals(request_id);

-- Task-partitioned tables (§4.3). Every task-local read constrains task_id. ----

CREATE TABLE IF NOT EXISTS task_records (
  task_id     TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  brief       TEXT,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks_catalog(task_id)
);

CREATE TABLE IF NOT EXISTS task_roles (
  task_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name)
);

CREATE TABLE IF NOT EXISTS role_session_sets (
  task_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name)
);

CREATE TABLE IF NOT EXISTS work_items (
  task_id      TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  status       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, work_item_id)
);
CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(task_id, status);

CREATE TABLE IF NOT EXISTS work_item_candidates (
  task_id      TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  task_id    TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  role_name  TEXT NOT NULL,
  status     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_role_status ON agent_runs(task_id, role_name, status);

-- Active-run pointers (getActiveAgentRun / execution-lane runs).
CREATE TABLE IF NOT EXISTS active_runs (
  task_id    TEXT NOT NULL,
  pointer    TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, pointer)
);

CREATE TABLE IF NOT EXISTS review_rounds (
  task_id         TEXT NOT NULL,
  review_round_id TEXT NOT NULL,
  status          TEXT NOT NULL,
  payload         TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (task_id, review_round_id)
);

CREATE TABLE IF NOT EXISTS change_sets (
  task_id       TEXT NOT NULL,
  change_set_id TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, change_set_id)
);
CREATE INDEX IF NOT EXISTS idx_change_sets_project ON change_sets(task_id, project_id);

CREATE TABLE IF NOT EXISTS integration_attempts (
  task_id        TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  payload        TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, integration_id)
);

CREATE TABLE IF NOT EXISTS messages (
  task_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(task_id, seq);

CREATE TABLE IF NOT EXISTS input_requests (
  task_id       TEXT NOT NULL,
  input_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  blocks        TEXT,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, input_id)
);
CREATE INDEX IF NOT EXISTS idx_input_open ON input_requests(task_id, status) WHERE status <> 'resolved';

CREATE TABLE IF NOT EXISTS decisions (
  task_id     TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, decision_id)
);

CREATE TABLE IF NOT EXISTS milestones (
  task_id      TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, milestone_id)
);

-- Terminal/semantic events: retained individually, never pruned.
CREATE TABLE IF NOT EXISTS events (
  task_id     TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (task_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(task_id, type, occurred_at);

-- Per-task scheduler projections (leaderFailure, operatorNotification).
CREATE TABLE IF NOT EXISTS task_projections (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('leader-failure','operator-notification')),
  payload    TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, kind)
);

-- Telemetry (§4.4): bounded, latest-per-key. WITHOUT ROWID, PK is the key.
CREATE TABLE IF NOT EXISTS telemetry (
  task_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  generation  TEXT NOT NULL,
  progress_id TEXT NOT NULL,
  sequence    INTEGER,
  payload     TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name, run_id, generation, progress_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_telemetry_run ON telemetry(task_id, run_id);
`;

/**
 * Migration 2: post-baseline task-scoped record families. This single
 * migration creates the DurableJob, CapabilityGrant, and ReleaseWorkflow
 * tables so a fresh database receives the complete merged schema atomically.
 */
const MIGRATION_2_SQL = `
CREATE TABLE IF NOT EXISTS durable_jobs (
  job_id           TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  idempotency_key  TEXT,
  status           TEXT NOT NULL,
  payload          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_durable_jobs_task ON durable_jobs(task_id);
CREATE INDEX IF NOT EXISTS idx_durable_jobs_status ON durable_jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_jobs_idempotency
  ON durable_jobs(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS capability_grants (
  task_id    TEXT NOT NULL,
  grant_id   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, grant_id)
);

CREATE TABLE IF NOT EXISTS release_workflows (
  task_id     TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, workflow_id)
);
`;

/**
 * Migration 3: Job caller key hashes (task-14, rr13). Durable SHA-256 hashes of
 * the caller key bound to each launched Session, used to fail-closed verify a
 * DurableJob's caller against durable Run state.
 */
const MIGRATION_3_SQL = `
CREATE TABLE IF NOT EXISTS job_caller_key_hashes (
  task_id    TEXT NOT NULL,
  role_name  TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  hash       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name, agent_id)
);
`;

/**
 * Migration 4: DurableJob IDs are Task-local.  Migration 2 accidentally made
 * job_id the global primary key, so two Tasks allocating their first `job-1`
 * could overwrite one another through the upsert path.  Rebuild the table with
 * the actual record identity `(task_id, job_id)` and restore its indexes.
 * Never edit migration 2's checksum: existing Homes reach this repair through
 * this adjacent schema migration.
 */
const MIGRATION_4_SQL = `
CREATE TABLE durable_jobs_v4 (
  job_id           TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  idempotency_key  TEXT,
  status           TEXT NOT NULL,
  payload          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (task_id, job_id)
);
INSERT INTO durable_jobs_v4
  (job_id, task_id, idempotency_key, status, payload, created_at, updated_at)
SELECT job_id, task_id, idempotency_key, status, payload, created_at, updated_at
FROM durable_jobs;
DROP TABLE durable_jobs;
ALTER TABLE durable_jobs_v4 RENAME TO durable_jobs;
CREATE INDEX idx_durable_jobs_task ON durable_jobs(task_id);
CREATE INDEX idx_durable_jobs_status ON durable_jobs(status);
CREATE UNIQUE INDEX idx_durable_jobs_idempotency
  ON durable_jobs(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

/**
 * Migration 5: telemetry aggregate (Issue 09). The `telemetry` table (migration
 * 1, §4.4) stores the bounded latest-per-key progress window; this companion
 * table holds the authoritative per-Run/generation summary (count, first/last,
 * max sequence, error count) so aggregates stay accurate after the window is
 * pruned. Triggers maintain it on telemetry INSERT/UPDATE; DELETE intentionally
 * leaves it untouched because pruned rows were still observed.
 */
const MIGRATION_5_SQL = `
CREATE TABLE IF NOT EXISTS telemetry_aggregate (
  task_id      TEXT NOT NULL,
  role_name    TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  generation   TEXT NOT NULL,
  first_at     TEXT NOT NULL,
  last_at      TEXT NOT NULL,
  count        INTEGER NOT NULL,
  max_sequence INTEGER,
  error_count  INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name, run_id, generation)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS telemetry_ai AFTER INSERT ON telemetry
BEGIN
  INSERT INTO telemetry_aggregate
    (task_id, role_name, run_id, generation, first_at, last_at, count, max_sequence, error_count, updated_at)
  VALUES
    (NEW.task_id, NEW.role_name, NEW.run_id, NEW.generation, NEW.received_at, NEW.received_at, 1, NEW.sequence,
     CASE WHEN json_valid(NEW.payload)
          AND (COALESCE(json_extract(NEW.payload, '$.error'), '') <> ''
               OR COALESCE(json_extract(NEW.payload, '$.errorKind'), '') <> '')
         THEN 1 ELSE 0 END,
     NEW.received_at)
  ON CONFLICT(task_id, role_name, run_id, generation) DO UPDATE SET
    first_at = MIN(telemetry_aggregate.first_at, excluded.first_at),
    last_at = MAX(telemetry_aggregate.last_at, excluded.last_at),
    count = telemetry_aggregate.count + 1,
    max_sequence = CASE
      WHEN excluded.max_sequence IS NOT NULL
       AND (telemetry_aggregate.max_sequence IS NULL OR excluded.max_sequence > telemetry_aggregate.max_sequence)
      THEN excluded.max_sequence ELSE telemetry_aggregate.max_sequence END,
    error_count = telemetry_aggregate.error_count + excluded.error_count,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS telemetry_au AFTER UPDATE ON telemetry
BEGIN
  UPDATE telemetry_aggregate SET
    last_at = CASE WHEN NEW.received_at > last_at THEN NEW.received_at ELSE last_at END,
    max_sequence = CASE
      WHEN NEW.sequence IS NOT NULL AND (max_sequence IS NULL OR NEW.sequence > max_sequence)
      THEN NEW.sequence ELSE max_sequence END,
    updated_at = NEW.received_at
  WHERE task_id = NEW.task_id AND role_name = NEW.role_name
    AND run_id = NEW.run_id AND generation = NEW.generation;
END;
`;

/**
 * Migration 6: Issue 06 ReviewFinding ledger. Cross-Round semantic review
 * findings with stable keys and Leader dispositions. Failed execution attempts
 * never create rows; only completed Rounds feed the ledger.
 */
const MIGRATION_6_SQL = `
CREATE TABLE IF NOT EXISTS review_findings (
  task_id     TEXT NOT NULL,
  finding_id  TEXT NOT NULL,
  stable_key  TEXT NOT NULL,
  severity    TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, finding_id)
);
CREATE INDEX IF NOT EXISTS idx_review_findings_task ON review_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_review_findings_stable_key ON review_findings(task_id, stable_key);
`;

interface Migration {
  version: number;
  axis: "layout" | "aggregate" | "record";
  recordKind?: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, axis: "layout", sql: MIGRATION_1_SQL },
  { version: 2, axis: "record", recordKind: "durableJob+capability-grant+release-workflow", sql: MIGRATION_2_SQL },
  { version: 3, axis: "record", recordKind: "jobCallerKeyHash", sql: MIGRATION_3_SQL },
  { version: 4, axis: "record", recordKind: "durableJob", sql: MIGRATION_4_SQL },
  { version: 5, axis: "record", recordKind: "telemetryAggregate", sql: MIGRATION_5_SQL }
  { version: 5, axis: "record", recordKind: "telemetryAggregate", sql: MIGRATION_5_SQL },
  { version: 6, axis: "record", recordKind: "reviewFinding", sql: MIGRATION_6_SQL }
];

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export interface MigrationResult {
  /** Versions applied by this run (empty when the schema was already current). */
  readonly applied: readonly number[];
  /** The schema version after the run. */
  readonly version: number;
}

/**
 * Apply pending migrations idempotently inside transactions.
 *
 * Each migration runs in its own transaction: the DDL and the
 * `schema_migrations` bookkeeping commit atomically, so a crash mid-migration
 * rolls back and the next open re-applies cleanly. Re-running on a current
 * database performs no work (every version is already recorded).
 */
export function migrateSqliteSchema(db: Database.Database): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      axis        TEXT NOT NULL CHECK (axis IN ('layout','aggregate','record')),
      record_kind TEXT,
      applied_at  TEXT NOT NULL,
      checksum    TEXT NOT NULL
    )
  `);
  const applied = new Set<number>(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version)
  );
  const newlyApplied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO schema_migrations (version, axis, record_kind, applied_at, checksum)
         VALUES (?, ?, ?, ?, ?)`
      ).run(migration.version, migration.axis, migration.recordKind ?? null, new Date().toISOString(), checksum(migration.sql));
    });
    apply();
    newlyApplied.push(migration.version);
  }
  const version = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
  return { applied: newlyApplied, version };
}

/** The names of every table the schema creates (for tests/introspection). */
export const SQLITE_SCHEMA_TABLES: readonly string[] = [
  "schema_migrations",
  "home_meta",
  "config",
  "configured_agents",
  "agent_profiles",
  "projects",
  "global_roles",
  "global_role_session_sets",
  "global_sequences",
  "tasks_catalog",
  "managed_workspaces",
  "id_sequences",
  "coordination_locks",
  "integration_queue",
  "durable_jobs",
  "job_caller_key_hashes",
  "outbox",
  "mailboxes",
  "mailbox_signals",
  "task_records",
  "task_roles",
  "role_session_sets",
  "work_items",
  "work_item_candidates",
  "agent_runs",
  "active_runs",
  "review_rounds",
  "review_findings",
  "change_sets",
  "integration_attempts",
  "messages",
  "input_requests",
  "decisions",
  "milestones",
  "events",
  "task_projections",
  "telemetry",
  "telemetry_aggregate",
  "capability_grants",
  "release_workflows"
] as const;
