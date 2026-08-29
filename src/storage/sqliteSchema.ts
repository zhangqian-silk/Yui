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
export const SQLITE_SCHEMA_VERSION = 17;

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

-- Per-task scheduler projections. operator-notification is a retired legacy
-- kind retained only so old layout-7 Homes can be read by the upgrade path.
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

/**
 * Version 5 migration: session owner physical identity records (Issue 03).
 *
 * One row per runtime generation, keyed by launch id. The payload column
 * stores the full versioned JSON record; typed columns support the
 * reconciliation queries (task/role lookup, PID liveness).
 */
const MIGRATION_7_SQL = `
CREATE TABLE IF NOT EXISTS session_owners (
  launch_id          TEXT PRIMARY KEY,
  scope              TEXT NOT NULL CHECK (scope IN ('task','global')),
  task_id            TEXT,
  role_name          TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  native_session_id  TEXT,
  provider_root_pid  INTEGER,
  payload            TEXT NOT NULL,
  recorded_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_owners_task
  ON session_owners(task_id, role_name);
`;

/**
 * Migration 8: Resource GC registry (Issue 10).
 *
 * GC-owned table for resource lifecycle records.  The registry is GC's own
 * state — it is not part of the aggregate and never participates in aggregate
 * versioning.  Records are stored as full versioned JSON in `payload`, with
 * typed columns for the fields GC queries (disposition, kind, task_id).
 */
const MIGRATION_8_SQL = `
CREATE TABLE IF NOT EXISTS resource_registry (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  disposition TEXT NOT NULL,
  task_id     TEXT,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resource_registry_disposition
  ON resource_registry(disposition);
CREATE INDEX IF NOT EXISTS idx_resource_registry_task
  ON resource_registry(task_id);
`;

/**
 * Migration 9: GateArtifact storage (Issue 08). Content-addressed gate
 * evidence records with per-step logs stored as BLOBs. The artifact key is
 * the SHA-256 of the identity tuple (Project + commit + plan digest +
 * toolchain digest + L2 boundary), so the same tuple always maps to one row.
 * Typed columns support the reuse lookup paths (exact-commit L2 search,
 * Project-level prune) without scanning payloads.
 */
const MIGRATION_9_SQL = `
CREATE TABLE IF NOT EXISTS gate_artifacts (
  key               TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('L1','L2')),
  commit_sha        TEXT NOT NULL,
  plan_digest       TEXT NOT NULL,
  toolchain_digest  TEXT NOT NULL,
  target_ref        TEXT,
  status            TEXT NOT NULL CHECK (status IN ('incomplete','complete')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('unknown','succeeded','failed')),
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  last_used_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_artifacts_project_commit
  ON gate_artifacts(project_id, commit_sha);

CREATE INDEX IF NOT EXISTS idx_gate_artifacts_project_last_used
  ON gate_artifacts(project_id, last_used_at);

CREATE TABLE IF NOT EXISTS gate_artifact_logs (
  artifact_key  TEXT NOT NULL,
  step_name     TEXT NOT NULL,
  log_content   BLOB NOT NULL,
  log_digest    TEXT NOT NULL,
  log_bytes     INTEGER NOT NULL,
  PRIMARY KEY (artifact_key, step_name),
  FOREIGN KEY (artifact_key) REFERENCES gate_artifacts(key) ON DELETE CASCADE
);
`;

/**
 * Migration 10: bounded ready-mailbox lookup for the Controller hot path.
 *
 * Historical empty mailboxes remain durable, but only mailboxes with a
 * processing or pending batch require scheduling.  The partial index contains
 * exactly that unsettled set in target-key order, so the Controller's recovery
 * query is O(log H + ready) instead of scanning every historical mailbox.
 */
const MIGRATION_10_SQL = `
CREATE INDEX IF NOT EXISTS idx_mailboxes_ready
  ON mailboxes(target_key)
  WHERE processing IS NOT NULL OR pending IS NOT NULL;
`;

/**
 * Migration 11: bounded current-Session projection for runtime cleanup.
 *
 * RoleSessionSet payloads remain authoritative. This table contains only the
 * current active Agent Session while it is non-stopped, so terminal Session
 * history cannot enlarge Controller cleanup discovery. Runtime writes maintain
 * it in the same transaction as the source payload; this migration performs
 * the one-time deterministic backfill for existing layout-7 Homes.
 */
const MIGRATION_11_SQL = `
CREATE TABLE IF NOT EXISTS runtime_session_candidates (
  scope               TEXT NOT NULL CHECK (scope IN ('task','global')),
  task_id             TEXT NOT NULL,
  role_name           TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  adapter_id          TEXT NOT NULL,
  native_session_id   TEXT NOT NULL,
  launch_id           TEXT,
  status              TEXT NOT NULL CHECK (status IN ('reserved','ready','running','broken')),
  session_updated_at  TEXT NOT NULL,
  cleanup_required    INTEGER NOT NULL CHECK (cleanup_required IN (0,1)),
  PRIMARY KEY (scope, task_id, role_name),
  CHECK (
    (scope = 'task' AND length(task_id) > 0)
    OR (scope = 'global' AND task_id = '')
  ),
  CHECK (
    cleanup_required = CASE
      WHEN status NOT IN ('stopped','broken')
        AND (status = 'running' OR launch_id IS NOT NULL)
      THEN 1 ELSE 0
    END
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_session_cleanup_required
  ON runtime_session_candidates(scope, task_id, role_name)
  WHERE cleanup_required = 1;

INSERT INTO runtime_session_candidates (
  scope, task_id, role_name, agent_id, adapter_id, native_session_id,
  launch_id, status, session_updated_at, cleanup_required
)
SELECT
  'task', source.task_id, source.role_name,
  json_extract(active.value, '$.agentId'),
  json_extract(active.value, '$.adapterId'),
  json_extract(active.value, '$.nativeSessionId'),
  json_extract(active.value, '$.launchId'),
  json_extract(active.value, '$.status'),
  json_extract(active.value, '$.updatedAt'),
  CASE
    WHEN json_extract(active.value, '$.status') NOT IN ('stopped','broken')
      AND (
        json_extract(active.value, '$.status') = 'running'
        OR json_type(active.value, '$.launchId') = 'text'
      )
    THEN 1 ELSE 0
  END
FROM role_session_sets AS source
JOIN json_each(source.payload, '$.sessions') AS active
  ON active.key = json_extract(source.payload, '$.activeAgentId')
WHERE json_extract(active.value, '$.status') <> 'stopped';

INSERT INTO runtime_session_candidates (
  scope, task_id, role_name, agent_id, adapter_id, native_session_id,
  launch_id, status, session_updated_at, cleanup_required
)
SELECT
  'global', '', source.name,
  json_extract(active.value, '$.agentId'),
  json_extract(active.value, '$.adapterId'),
  json_extract(active.value, '$.nativeSessionId'),
  json_extract(active.value, '$.launchId'),
  json_extract(active.value, '$.status'),
  json_extract(active.value, '$.updatedAt'),
  CASE
    WHEN json_extract(active.value, '$.status') NOT IN ('stopped','broken')
      AND (
        json_extract(active.value, '$.status') = 'running'
        OR json_type(active.value, '$.launchId') = 'text'
      )
    THEN 1 ELSE 0
  END
FROM global_role_session_sets AS source
JOIN json_each(source.payload, '$.sessions') AS active
  ON active.key = json_extract(source.payload, '$.activeAgentId')
WHERE json_extract(active.value, '$.status') <> 'stopped';
`;

/**
 * Migration 12: bounded open-InputRequest lookup for Controller deadlines.
 *
 * The baseline index's historical predicate predates the current
 * open/answered/cancelled status contract and retains terminal rows. This
 * partial index contains only the live InputRequest set, so deadline arming and
 * targeted auto-resolution never scan terminal request history.
 */
const MIGRATION_12_SQL = `
CREATE INDEX IF NOT EXISTS idx_input_requests_open_hot
  ON input_requests(task_id, input_id)
  WHERE status = 'open';
`;

/**
 * Migration 13: durable pending native Turn-completion hot projection.
 *
 * A Task Role may have an unsettled Turn completion after the native Session
 * has ended.  That completion is independent lifecycle state, so it cannot be
 * discovered through the current-Session projection (which intentionally
 * removes stopped Sessions).  Keep one typed row per Task Role and maintain it
 * in the same transaction as `role_session_sets`; deadline discovery can then
 * read this table without parsing a RoleSessionSet or its historical Sessions.
 */
const MIGRATION_13_SQL = `
CREATE TABLE IF NOT EXISTS pending_runtime_turn_completions (
  task_id           TEXT NOT NULL,
  role_name         TEXT NOT NULL,
  schema_version    INTEGER NOT NULL CHECK (schema_version = 1),
  agent_id          TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  summary           TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  due_at            TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name),
  CHECK (due_at >= observed_at),
  FOREIGN KEY (task_id, role_name)
    REFERENCES role_session_sets(task_id, role_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_runtime_turn_completions_due
  ON pending_runtime_turn_completions(task_id, due_at, role_name);

INSERT INTO pending_runtime_turn_completions (
  task_id, role_name, schema_version, agent_id, native_session_id,
  turn_id, run_id, summary, observed_at, due_at
)
SELECT
  source.task_id,
  source.role_name,
  json_extract(source.payload, '$.pendingTurnCompletion.schemaVersion'),
  json_extract(source.payload, '$.pendingTurnCompletion.agentId'),
  json_extract(source.payload, '$.pendingTurnCompletion.nativeSessionId'),
  json_extract(source.payload, '$.pendingTurnCompletion.turnId'),
  json_extract(source.payload, '$.pendingTurnCompletion.runId'),
  json_extract(source.payload, '$.pendingTurnCompletion.summary'),
  json_extract(source.payload, '$.pendingTurnCompletion.observedAt'),
  json_extract(source.payload, '$.pendingTurnCompletion.dueAt')
FROM role_session_sets AS source
WHERE json_type(source.payload, '$.pendingTurnCompletion') = 'object';
`;

/** Migration 14: WorkMailbox v2 lanes and the single durable model-input delivery. */
const MIGRATION_14_SQL = `
ALTER TABLE mailboxes ADD COLUMN input_delivery TEXT;

UPDATE mailboxes
SET processing = CASE
  WHEN processing IS NULL THEN NULL
  ELSE json_set(
    processing,
    '$.lane', 'normal',
    '$.batch.sources', json_array('migration-v1'),
    '$.batch.dedupeKeys', json_array(
      'mailbox-v1:' || target_key || ':'
      || json_extract(processing, '$.batch.fromSequence') || '-'
      || json_extract(processing, '$.batch.toSequence')
    ),
    '$.batch.deliveryModes', json_array('followup')
  )
END;

UPDATE mailboxes
SET input_delivery = json_object(
  'attemptId', json_extract(processing, '$.batchId'),
  'lane', 'normal',
  'mode', 'followup',
  'batch', json(json_extract(processing, '$.batch')),
  'owner', json_extract(processing, '$.owner'),
  'status', 'delivery-unknown',
  'startedAt', json_extract(processing, '$.startedAt'),
  'pushedAt', json_extract(processing, '$.startedAt'),
  'unknownReason', 'migrated-unconfirmed-provider-acceptance',
  'executionRef', json(json_extract(processing, '$.executionRef')),
  'providerFence', json_object(
    'conversationId', (
      SELECT json_extract(
        json_extract(role_session_sets.payload, '$.sessions'),
        '$.' || json_quote(json_extract(role_session_sets.payload, '$.activeAgentId'))
          || '.nativeSessionId'
      )
      FROM role_session_sets
      WHERE role_session_sets.task_id = mailboxes.task_id
        AND role_session_sets.role_name = mailboxes.role_name
    ),
    'activationId', COALESCE((
      SELECT json_extract(
        json_extract(role_session_sets.payload, '$.sessions'),
        '$.' || json_quote(json_extract(role_session_sets.payload, '$.activeAgentId'))
          || '.launchId'
      )
      FROM role_session_sets
      WHERE role_session_sets.task_id = mailboxes.task_id
        AND role_session_sets.role_name = mailboxes.role_name
    ), (
      SELECT json_extract(role_session_sets.payload, '$.inFlight.receiptId')
      FROM role_session_sets
      WHERE role_session_sets.task_id = mailboxes.task_id
        AND role_session_sets.role_name = mailboxes.role_name
    ))
  )
)
WHERE target_kind = 'role'
  AND json_extract(processing, '$.batchId') LIKE 'agent-input:%';

UPDATE mailboxes
SET processing = NULL
WHERE input_delivery IS NOT NULL;

UPDATE mailboxes
SET pending = json_object(
  'normal', CASE
    WHEN pending IS NULL THEN json('null')
    ELSE json(json_set(
      pending,
      '$.sources', json_array('migration-v1'),
      '$.dedupeKeys', json_array(
        'mailbox-v1:' || target_key || ':'
        || json_extract(pending, '$.fromSequence') || '-'
        || json_extract(pending, '$.toSequence')
      ),
      '$.deliveryModes', json_array('followup')
    ))
  END,
  'userCorrection', json('null'),
  'cursors', json_object('normal', 0, 'userCorrection', 0),
  'recentDedupeKeys', json_array()
);

DROP INDEX idx_mailboxes_ready;
CREATE INDEX idx_mailboxes_ready
  ON mailboxes(target_key)
  WHERE processing IS NOT NULL
     OR input_delivery IS NOT NULL
     OR json_type(pending, '$.normal') <> 'null'
     OR json_type(pending, '$.userCorrection') <> 'null';

DROP TABLE pending_runtime_turn_completions;
DROP TABLE IF EXISTS mailbox_signals;
`;

/**
 * Migration 15: Issue 11 external publication evidence. Records are immutable;
 * a corrected MR/PR state appends a superseding record with the same
 * external_key, so only the unsuperseded root is globally unique.
 */
const MIGRATION_15_SQL = `
CREATE TABLE IF NOT EXISTS publication_references (
  task_id         TEXT NOT NULL,
  publication_id  TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  repository      TEXT NOT NULL,
  external_kind   TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  external_key    TEXT NOT NULL,
  state           TEXT NOT NULL,
  verification    TEXT NOT NULL,
  external_url    TEXT,
  title           TEXT,
  source_branch   TEXT,
  target_branch   TEXT,
  local_commit    TEXT,
  remote_commit   TEXT,
  supersedes      TEXT,
  payload         TEXT NOT NULL,
  merged_at       TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (task_id, publication_id)
);
CREATE INDEX IF NOT EXISTS idx_publication_references_task
  ON publication_references(task_id);
CREATE INDEX IF NOT EXISTS idx_publication_references_external
  ON publication_references(external_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_references_external_root
  ON publication_references(external_key) WHERE supersedes IS NULL;
`;

const MIGRATION_16_SQL = `
-- Durable Leader wake ledger (Issue 04 long-term design). A wake is a
-- notification envelope, not a context dump: the record holds the aggregated
-- reason tags and the delta window; the Agent reads delta content on demand.
CREATE TABLE IF NOT EXISTS task_wakes (
  task_id     TEXT NOT NULL,
  wake_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('dispatched','consumed')),
  run_id      TEXT,
  from_cursor TEXT NOT NULL,
  to_cursor   TEXT NOT NULL,
  reasons     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (task_id, wake_id)
);
CREATE INDEX IF NOT EXISTS idx_task_wakes_seq ON task_wakes(task_id, seq);
`;

/** Migration 17: immutable, Task-scoped ContextSnapshot records. */
const MIGRATION_17_SQL = `
CREATE TABLE IF NOT EXISTS context_snapshots (
  task_id     TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('task','workitem','stage')),
  scope_ref   TEXT,
  sequence    INTEGER NOT NULL CHECK (sequence > 0),
  digest      TEXT NOT NULL CHECK (length(digest) = 64),
  payload     TEXT NOT NULL,
  frozen_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, snapshot_id),
  FOREIGN KEY (task_id) REFERENCES tasks_catalog(task_id) ON DELETE CASCADE,
  CHECK ((scope = 'task' AND scope_ref IS NULL) OR (scope <> 'task' AND scope_ref IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_snapshots_scope_sequence
  ON context_snapshots(task_id, scope, COALESCE(scope_ref, ''), sequence);
`;

interface Migration {
  version: number;
  axis: "layout" | "aggregate" | "record";
  recordKind?: string;
  sql: string;
}

/**
 * The single forward migration history for current SQLite Homes. New durable
 * layout, aggregate, and record changes belong here and must be expressible as
 * one atomic in-place transaction. The separate logical migration registry is
 * only the bridge from valid pre-SQLite Homes and is allowed to rebuild them.
 */
const MIGRATIONS: readonly Migration[] = [
  { version: 1, axis: "layout", sql: MIGRATION_1_SQL },
  { version: 2, axis: "record", recordKind: "durableJob+capability-grant+release-workflow", sql: MIGRATION_2_SQL },
  { version: 3, axis: "record", recordKind: "jobCallerKeyHash", sql: MIGRATION_3_SQL },
  { version: 4, axis: "record", recordKind: "durableJob", sql: MIGRATION_4_SQL },
  { version: 5, axis: "record", recordKind: "telemetryAggregate", sql: MIGRATION_5_SQL },
  { version: 6, axis: "record", recordKind: "reviewFinding", sql: MIGRATION_6_SQL },
  { version: 7, axis: "record", recordKind: "sessionOwner", sql: MIGRATION_7_SQL },
  { version: 8, axis: "record", recordKind: "resource-registry", sql: MIGRATION_8_SQL },
  { version: 9, axis: "record", recordKind: "gateArtifact", sql: MIGRATION_9_SQL },
  { version: 10, axis: "layout", sql: MIGRATION_10_SQL },
  { version: 11, axis: "layout", sql: MIGRATION_11_SQL },
  { version: 12, axis: "layout", sql: MIGRATION_12_SQL },
  { version: 13, axis: "layout", sql: MIGRATION_13_SQL },
  { version: 14, axis: "record", recordKind: "workMailbox", sql: MIGRATION_14_SQL },
  { version: 15, axis: "record", recordKind: "publicationReference", sql: MIGRATION_15_SQL },
  { version: 16, axis: "record", recordKind: "taskWake", sql: MIGRATION_16_SQL },
  { version: 17, axis: "record", recordKind: "contextSnapshot", sql: MIGRATION_17_SQL }
];

/** Current hot-path indexes whose absence would invalidate a current Home. */
const REQUIRED_SCHEMA_INDEXES = [
  "idx_mailboxes_ready",
  "idx_runtime_session_cleanup_required",
  "idx_input_requests_open_hot"
] as const;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * A SQLite Home is only safe to open when its migration ledger proves exactly
 * which schema definition was applied.  The ledger is durable metadata, not a
 * best-effort cache: a missing row, a changed checksum, or an unknown version
 * must stop startup before any pending migration is run.
 */
export class SqliteSchemaMigrationError extends Error {
  constructor(detail: string, subject = "metadata") {
    super(`SQLite schema migration ${subject} is invalid: ${detail}`);
    this.name = "SqliteSchemaMigrationError";
  }
}

const SCHEMA_MIGRATIONS_SQL = `
    CREATE TABLE schema_migrations (
      version     INTEGER PRIMARY KEY,
      axis        TEXT NOT NULL CHECK (axis IN ('layout','aggregate','record')),
      record_kind TEXT,
      applied_at  TEXT NOT NULL,
      checksum    TEXT NOT NULL
    )
  `;

/**
 * Admit the migration ledger only for a genuinely empty SQLite database.
 * Recreating an absent ledger on top of existing Yui tables would make the
 * migration runner mistake a live Home for a fresh one and replay destructive
 * layout migrations.  A database with any sqlite_master object is therefore
 * diagnosed as corrupt/partially initialized and left untouched.
 */
function ensureMigrationLedger(
  db: Database.Database,
  mode: SqliteSchemaMigrationMode
): boolean {
  const objects = db.prepare(
    "SELECT type, name FROM sqlite_master WHERE name IS NOT NULL"
  ).all() as Array<{ type: unknown; name: unknown }>;
  const ledger = objects.find(({ name }) => name === "schema_migrations");
  if (ledger === undefined) {
    if (mode === "validate") {
      throw new SqliteSchemaMigrationError(
        "schema_migrations ledger is missing from an existing database"
      );
    }
    if (objects.length !== 0) {
      throw new SqliteSchemaMigrationError(
        "schema_migrations ledger is missing from a non-empty database"
      );
    }
    db.exec(SCHEMA_MIGRATIONS_SQL);
    return true;
  }
  if (ledger.type !== "table") {
    throw new SqliteSchemaMigrationError(
      `schema_migrations has type ${String(ledger.type)} instead of table`
    );
  }
  return false;
}

type AppliedMigrationRow = Readonly<{
  version: unknown;
  axis: unknown;
  record_kind: unknown;
  checksum: unknown;
}>;

/** Validate the applied prefix and return its versions for the migration loop. */
function validateAppliedMigrations(
  db: Database.Database,
  ledgerWasCreated: boolean
): Set<number> {
  const expected = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  const rows = db.prepare(
    "SELECT version, axis, record_kind, checksum FROM schema_migrations ORDER BY version"
  ).all() as AppliedMigrationRow[];
  if (rows.length === 0 && !ledgerWasCreated) {
    throw new SqliteSchemaMigrationError(
      "schema_migrations ledger is empty in an existing database"
    );
  }
  const applied = new Set<number>();

  for (const row of rows) {
    if (!Number.isInteger(row.version) || (row.version as number) < 1) {
      throw new SqliteSchemaMigrationError(`invalid migration version ${String(row.version)}`);
    }
    const version = row.version as number;
    const migration = expected.get(version);
    if (migration === undefined) {
      throw new SqliteSchemaMigrationError(`unknown migration version ${version}`);
    }
    if (applied.has(version)) {
      throw new SqliteSchemaMigrationError(`duplicate migration version ${version}`);
    }
    applied.add(version);

    const expectedRecordKind = migration.recordKind ?? null;
    if (row.axis !== migration.axis) {
      throw new SqliteSchemaMigrationError(
        `migration ${version} axis ${String(row.axis)} does not match ${migration.axis}`
      );
    }
    if (row.record_kind !== expectedRecordKind) {
      throw new SqliteSchemaMigrationError(
        `migration ${version} record_kind ${String(row.record_kind)} does not match ${String(expectedRecordKind)}`
      );
    }
    const expectedChecksum = checksum(migration.sql);
    if (row.checksum !== expectedChecksum) {
      throw new SqliteSchemaMigrationError(
        `migration ${version} checksum ${String(row.checksum)} does not match current definition`
      );
    }
  }

  const versions = [...applied].sort((left, right) => left - right);
  for (let index = 0; index < versions.length; index += 1) {
    const expectedVersion = index + 1;
    if (versions[index] !== expectedVersion) {
      throw new SqliteSchemaMigrationError(
        `migration ledger has a gap before version ${versions[index]}`
      );
    }
  }
  return applied;
}

/**
 * Validate the physical objects promised by the migration ledger.  Ledger
 * rows can be forged independently of SQLite's schema, so a complete and
 * checksummed ledger is not enough to authorize startup when an object was
 * manually removed or replaced.
 */
function validateSchemaObjects(db: Database.Database): void {
  const objects = new Map<string, string>(
    (db.prepare("SELECT type, name FROM sqlite_master WHERE name IS NOT NULL").all() as Array<{
      type: unknown;
      name: unknown;
    }>).flatMap(({ type, name }) => (
      typeof type === "string" && typeof name === "string" ? [[name, type]] : []
    ))
  );

  for (const table of SQLITE_SCHEMA_TABLES) {
    if (objects.get(table) !== "table") {
      throw new SqliteSchemaMigrationError(
        `required table '${table}' is missing or has the wrong type`,
        "schema object"
      );
    }
  }

  for (const index of REQUIRED_SCHEMA_INDEXES) {
    if (objects.get(index) !== "index") {
      throw new SqliteSchemaMigrationError(
        `required index '${index}' is missing or has the wrong type`,
        "schema object"
      );
    }
  }
}

/** Validate migration 13's source invariant before creating its hot table. */
function validatePendingProjectionBackfillSources(db: Database.Database): void {
  const existing = db.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE name IN (
       'pending_runtime_turn_completions',
       'idx_pending_runtime_turn_completions_due'
     )
     LIMIT 1`
  ).get() as { name: string } | undefined;
  if (existing !== undefined) {
    throw new SqliteSchemaMigrationError(
      `schema object '${existing.name}' exists before migration 13 is recorded`,
      "backfill"
    );
  }
  const mismatch = db.prepare(
    `SELECT task_id, role_name
     FROM role_session_sets
     WHERE COALESCE(json_type(payload, '$.pendingTurnCompletion'), 'missing')
             NOT IN ('null', 'object')
        OR (
          json_type(payload, '$.pendingTurnCompletion') = 'object'
          AND (
            json_extract(payload, '$.owner.scope') <> 'task'
            OR json_extract(payload, '$.owner.taskId') IS NULL
            OR json_extract(payload, '$.owner.taskId') <> task_id
            OR json_extract(payload, '$.owner.roleName') IS NULL
            OR json_extract(payload, '$.owner.roleName') <> role_name
            OR json_extract(payload, '$.pendingTurnCompletion.taskId') IS NULL
            OR json_extract(payload, '$.pendingTurnCompletion.taskId') <> task_id
            OR json_extract(payload, '$.pendingTurnCompletion.roleName') IS NULL
            OR json_extract(payload, '$.pendingTurnCompletion.roleName') <> role_name
            OR json_extract(payload, '$.pendingTurnCompletion.schemaVersion') IS NOT 1
            OR COALESCE(json_type(payload, '$.pendingTurnCompletion.agentId'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.pendingTurnCompletion.nativeSessionId'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.pendingTurnCompletion.turnId'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.pendingTurnCompletion.runId'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.pendingTurnCompletion.summary'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.pendingTurnCompletion.observedAt'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.pendingTurnCompletion.dueAt'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.inFlight'), 'missing') <> 'object'
            OR COALESCE(json_type(payload, '$.activeAgentId'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.inFlight.agentId'), 'missing') <> 'text'
            OR COALESCE(json_type(payload, '$.inFlight.runId'), 'missing') <> 'text'
            OR json_extract(payload, '$.activeAgentId')
                 <> json_extract(payload, '$.pendingTurnCompletion.agentId')
            OR json_extract(payload, '$.inFlight.agentId')
                 <> json_extract(payload, '$.pendingTurnCompletion.agentId')
            OR json_extract(payload, '$.inFlight.runId')
                 <> json_extract(payload, '$.pendingTurnCompletion.runId')
            OR COALESCE(json_type(payload, '$.inFlight.pushedAt'), 'missing') <> 'text'
            OR COALESCE(
                 json_type(
                   payload,
                   '$.sessions.' || json_quote(
                     json_extract(payload, '$.pendingTurnCompletion.agentId')
                   ) || '.nativeSessionId'
                 ),
                 'missing'
               ) <> 'text'
            OR json_extract(
                 payload,
                 '$.sessions.' || json_quote(
                   json_extract(payload, '$.pendingTurnCompletion.agentId')
                 ) || '.nativeSessionId'
               ) <> json_extract(payload, '$.pendingTurnCompletion.nativeSessionId')
            OR json_extract(payload, '$.pendingTurnCompletion.dueAt')
                 < json_extract(payload, '$.pendingTurnCompletion.observedAt')
          )
        )
     LIMIT 1`
  ).get() as { task_id: string; role_name: string } | undefined;
  if (mismatch !== undefined) {
    throw new SqliteSchemaMigrationError(
      `pending Turn completion source is invalid for ${mismatch.task_id}/${mismatch.role_name}`,
      "backfill"
    );
  }
}

export interface MigrationResult {
  /** Versions applied by this run (empty when the schema was already current). */
  readonly applied: readonly number[];
  /** The schema version after the run. */
  readonly version: number;
}

export type SqliteSchemaMigrationState = Readonly<{
  /** Highest contiguous migration already committed. */
  currentVersion: number;
  /** Checksum of the current ledger head validated by the staged binary. */
  currentChecksum: string;
  /** Schema version required by this release. */
  targetVersion: number;
  /** Checksum expected at the target ledger head. */
  targetChecksum: string;
  /** Ordered versions that an explicit upgrade must apply. */
  pendingVersions: readonly number[];
}>;

export type SqliteSchemaMigrationMode = "apply" | "validate";

export type SqliteSchemaMigrationOptions = Readonly<{
  /**
   * `apply` is owned by initialization or an explicit upgrade boundary.
   * `validate` is the only legal ordinary open mode for an existing
   * authoritative database.
   */
  mode: SqliteSchemaMigrationMode;
}>;

/**
 * Inspect a database's checksummed migration prefix without changing it.
 * Pending versions are a supported upgrade state; malformed, gapped, changed,
 * or future ledger entries remain explicit integrity failures.
 */
export function inspectSqliteSchemaMigrations(
  db: Database.Database
): SqliteSchemaMigrationState {
  const ledgerWasCreated = ensureMigrationLedger(db, "validate");
  const applied = validateAppliedMigrations(db, ledgerWasCreated);
  const pendingVersions = MIGRATIONS
    .filter((migration) => !applied.has(migration.version))
    .map((migration) => migration.version);
  if (pendingVersions.length === 0) validateSchemaObjects(db);
  const current = MIGRATIONS[applied.size - 1];
  const target = MIGRATIONS.at(-1)!;
  if (current === undefined) {
    throw new SqliteSchemaMigrationError("schema_migrations ledger has no current head");
  }
  return {
    currentVersion: applied.size,
    currentChecksum: checksum(current.sql),
    targetVersion: SQLITE_SCHEMA_VERSION,
    targetChecksum: checksum(target.sql),
    pendingVersions
  };
}

/**
 * Apply or validate schema migrations without letting an ordinary open mutate
 * an existing authoritative database.
 *
 * In `apply` mode every pending DDL/data step and every ledger row runs in one
 * outer transaction. The database therefore advances to the release version
 * as one commit or remains entirely at its previous version. `validate` mode
 * rejects a pending version before executing any migration.
 */
export function migrateSqliteSchema(
  db: Database.Database,
  options: SqliteSchemaMigrationOptions
): MigrationResult {
  const migrate = (): number[] => {
    const ledgerWasCreated = ensureMigrationLedger(db, options.mode);
    // Validate the complete ledger before touching any pending migration. This
    // prevents a manually altered or partially recorded ledger from silently
    // skipping a later schema/data step.
    const applied = validateAppliedMigrations(db, ledgerWasCreated);
    const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));
    if (options.mode === "validate" && pending.length > 0) {
      throw new SqliteSchemaMigrationError(
        `pending SQLite schema migration ${pending[0]!.version}; `
          + "run the explicit storage upgrade before opening this database",
        "admission"
      );
    }
    const newlyApplied: number[] = [];
    for (const migration of pending) {
      if (migration.version === 13) validatePendingProjectionBackfillSources(db);
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO schema_migrations (version, axis, record_kind, applied_at, checksum)
         VALUES (?, ?, ?, ?, ?)`
      ).run(migration.version, migration.axis, migration.recordKind ?? null, new Date().toISOString(), checksum(migration.sql));
      newlyApplied.push(migration.version);
    }
    validateSchemaObjects(db);
    return newlyApplied;
  };
  const newlyApplied = options.mode === "apply" && !db.inTransaction
    ? db.transaction(migrate)()
    : migrate();
  return { applied: newlyApplied, version: SQLITE_SCHEMA_VERSION };
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
  "task_records",
  "task_roles",
  "role_session_sets",
  "work_items",
  "work_item_candidates",
  "context_snapshots",
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
  "release_workflows",
  "publication_references",
  "session_owners",
  "runtime_session_candidates",
  "resource_registry",
  "gate_artifacts",
  "gate_artifact_logs"
] as const;
