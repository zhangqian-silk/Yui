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
 *   - `config`: the `YuiConfig` singleton (`home_meta` keeps identity/revision).
 *
 * Record payloads are stored two ways, per §4: typed columns for fields that are
 * queried/filtered/used-for-CAS, and a `payload` JSON column holding the full
 * current record. Record-local `schemaVersion` tags remain validation guards;
 * they are not independent Home compatibility axes. Any historical payload
 * rewrite belongs to the ordered Home migration that introduced the new shape.
 *
 * The migration runner is append-only and idempotent: it records one ordered
 * Home version in `schema_migrations`. Re-running an already-current database
 * is a no-op; a crash mid-upgrade rolls the whole migration transaction back.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  REMOVE_RUNTIME_GENERATION_SQL,
  removeRuntimeGenerationRecords
} from "./migrations/removeRuntimeGeneration.js";
import { migrateAgentRunContract } from "./migrations/agentRunContract.js";
import { migrateArtifactsToGit } from "./migrations/artifactsToGit.js";
import { migrateIntegrationContinuation } from "./migrations/integrationContinuation.js";
import { migrateNotificationOnlyWakes } from "./migrations/notificationOnlyWakes.js";
import { migrateWorkItemHistory } from "./migrations/workItemHistory.js";
import { migrateVerificationPolicy } from "./migrations/verificationPolicy.js";
import { migrateCurrentInputContract } from "./migrations/currentInputContract.js";
import {
  UNIFY_HOME_LAYOUT_SQL,
  migrateUnifyHomeLayout
} from "./migrations/unifyHomeLayout.js";
import {
  COLLAPSE_WORKTREE_LAYOUT_SQL,
  migrateCollapseWorktreeLayout
} from "./migrations/collapseWorktreeLayout.js";

import {
  CURRENT_STORAGE_VERSION,
  MIN_SUPPORTED_STORAGE_VERSION
} from "./storageVersions.js";

/** Telemetry retention bounds (§4.4). Open question 3 in §11; defaults from the design. */
export const TELEMETRY_KEEP_PER_RUN = 200;
export const TELEMETRY_RUN_CAP = 50_000;

/**
 * Version 1 migration: creates every table and index.
 *
 * `synchronous`/`foreign_keys`/`busy_timeout` are per-connection PRAGMAs set by
 * the store; `journal_mode=WAL` is a persistent database property set on open.
 * The migration itself only contains schema objects.
 *
 * This is the Yui 0.15.0 / storage-version-1 baseline. Future releases append
 * migrations after it so fresh and upgraded databases converge on the same
 * current contract.
 */
const BASELINE_CORE_SQL = `
-- Global catalog and coordination (§4.1) -------------------------------------

CREATE TABLE IF NOT EXISTS home_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  home_identity TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
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
  recent_dedupe_keys TEXT NOT NULL DEFAULT '[]',
  UNIQUE (target_kind, task_id, role_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_target_key
  ON mailboxes(target_key);
CREATE INDEX IF NOT EXISTS idx_mailboxes_ready
  ON mailboxes(target_key)
  WHERE processing IS NOT NULL OR json_type(pending) <> 'null';

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

CREATE TABLE IF NOT EXISTS turns (
  task_id    TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  role_name  TEXT NOT NULL,
  status     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_role_status ON turns(task_id, role_name, status);

-- Active-Turn pointers (getActiveTurn / execution-lane Turns).
CREATE TABLE IF NOT EXISTS active_turns (
  task_id    TEXT NOT NULL,
  pointer    TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_input_requests_open_hot
  ON input_requests(task_id, input_id)
  WHERE status = 'open';

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
  turn_id     TEXT NOT NULL,
  generation  TEXT NOT NULL,
  progress_id TEXT NOT NULL,
  sequence    INTEGER,
  payload     TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name, turn_id, generation, progress_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_telemetry_turn ON telemetry(task_id, turn_id);
`;

/** Task-scoped execution and release record families. */
const BASELINE_JOB_AND_RELEASE_SQL = `
CREATE TABLE IF NOT EXISTS durable_jobs (
  job_id           TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  idempotency_key  TEXT,
  status           TEXT NOT NULL,
  payload          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (task_id, job_id)
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

/** Durable caller-key hashes used to verify DurableJob ownership. */
const BASELINE_JOB_CALLER_SQL = `
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
 * The `telemetry` table stores the bounded latest-per-key progress window; this companion
 * table holds the authoritative per-Turn/generation summary (count, first/last,
 * max sequence, error count) so aggregates stay accurate after the window is
 * pruned. Triggers maintain it on telemetry INSERT/UPDATE; DELETE intentionally
 * leaves it untouched because pruned rows were still observed.
 */
const BASELINE_TELEMETRY_AGGREGATE_SQL = `
CREATE TABLE IF NOT EXISTS telemetry_aggregate (
  task_id      TEXT NOT NULL,
  role_name    TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  generation   TEXT NOT NULL,
  first_at     TEXT NOT NULL,
  last_at      TEXT NOT NULL,
  count        INTEGER NOT NULL,
  max_sequence INTEGER,
  error_count  INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name, turn_id, generation)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS telemetry_ai AFTER INSERT ON telemetry
BEGIN
  INSERT INTO telemetry_aggregate
    (task_id, role_name, turn_id, generation, first_at, last_at, count, max_sequence, error_count, updated_at)
  VALUES
    (NEW.task_id, NEW.role_name, NEW.turn_id, NEW.generation, NEW.received_at, NEW.received_at, 1, NEW.sequence,
     CASE WHEN json_valid(NEW.payload)
          AND (COALESCE(json_extract(NEW.payload, '$.error'), '') <> ''
               OR COALESCE(json_extract(NEW.payload, '$.errorKind'), '') <> '')
         THEN 1 ELSE 0 END,
     NEW.received_at)
  ON CONFLICT(task_id, role_name, turn_id, generation) DO UPDATE SET
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
    AND turn_id = NEW.turn_id AND generation = NEW.generation;
END;
`;

/**
 * Session owner physical identity records.
 *
 * One row per runtime generation, keyed by runtime generation id. The payload column
 * stores the full current JSON record; typed columns support the
 * reconciliation queries (task/role lookup, PID liveness).
 */
const BASELINE_SESSION_OWNER_SQL = `
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
 * Resource GC registry.
 *
 * GC-owned table for resource lifecycle records. The registry is GC's own
 * state. Records are stored as full current JSON in `payload`, with
 * typed columns for the fields GC queries (disposition, kind, task_id).
 */
const BASELINE_RESOURCE_REGISTRY_SQL = `
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
 * Content-addressed GateArtifact storage. Content-addressed gate
 * evidence records with per-step logs stored as BLOBs. The artifact key is
 * the SHA-256 of the identity tuple (Project + commit + plan digest +
 * toolchain digest + L2 boundary), so the same tuple always maps to one row.
 * Typed columns support the reuse lookup paths (exact-commit L2 search,
 * Project-level prune) without scanning payloads.
 */
const BASELINE_GATE_ARTIFACT_SQL = `
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

/** Bounded current-Session projection for runtime cleanup. */
const BASELINE_RUNTIME_SESSION_SQL = `
CREATE TABLE IF NOT EXISTS runtime_session_candidates (
  scope               TEXT NOT NULL CHECK (scope IN ('task','global')),
  task_id             TEXT NOT NULL,
  role_name           TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  adapter_id          TEXT NOT NULL,
  native_session_id   TEXT NOT NULL,
  launch_id           TEXT,
  session_updated_at  TEXT NOT NULL,
  cleanup_required    INTEGER NOT NULL CHECK (cleanup_required IN (0,1)),
  PRIMARY KEY (scope, task_id, role_name),
  CHECK (
    (scope = 'task' AND length(task_id) > 0)
    OR (scope = 'global' AND task_id = '')
  ),
  CHECK (
    cleanup_required = CASE WHEN launch_id IS NOT NULL THEN 1 ELSE 0 END
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_session_cleanup_required
  ON runtime_session_candidates(scope, task_id, role_name)
  WHERE cleanup_required = 1;
`;

/**
 * External publication evidence. Records are immutable;
 * a corrected MR/PR state appends a superseding record with the same
 * external_key, so only the unsuperseded root is globally unique.
 */
const BASELINE_PUBLICATION_REFERENCE_SQL = `
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

const BASELINE_TASK_WAKE_SQL = `
-- Durable Leader wake ledger (Issue 04 long-term design). A wake is a
-- notification envelope, not a context dump: the record holds the aggregated
-- reason tags and the delta window; the Agent reads delta content on demand.
CREATE TABLE IF NOT EXISTS task_wakes (
  task_id     TEXT NOT NULL,
  wake_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('dispatched','consumed')),
  turn_id     TEXT,
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

/** Immutable, Task-scoped ContextSnapshot records. */
const BASELINE_CONTEXT_SNAPSHOT_SQL = `
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

/**
 * The Global-owned Message store (decision-3 §9/§11). It extends the Message
 * store to a Global owner exactly as `global_role_session_sets` parallels
 * `role_session_sets`: keyed by the Global Role `name` with an FK to
 * `global_roles`, never by a fabricated `task_id`, and never a new private
 * queue. Ids are minted from the existing `global_sequences` counter, so a
 * Global input has an explicit owner and an authorizable reference without
 * reusing Task record shapes or Task permissions.
 */
const GLOBAL_ROLE_MESSAGE_SQL = `
CREATE TABLE IF NOT EXISTS global_role_messages (
  name       TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (name, message_id),
  FOREIGN KEY (name) REFERENCES global_roles(name)
);
CREATE INDEX IF NOT EXISTS idx_global_role_messages_seq ON global_role_messages(name, seq);
`;

const MIGRATION_1_SQL = [
  BASELINE_CORE_SQL,
  BASELINE_JOB_AND_RELEASE_SQL,
  BASELINE_JOB_CALLER_SQL,
  BASELINE_TELEMETRY_AGGREGATE_SQL,
  BASELINE_SESSION_OWNER_SQL,
  BASELINE_RESOURCE_REGISTRY_SQL,
  BASELINE_GATE_ARTIFACT_SQL,
  BASELINE_RUNTIME_SESSION_SQL,
  BASELINE_PUBLICATION_REFERENCE_SQL,
  BASELINE_TASK_WAKE_SQL,
  BASELINE_CONTEXT_SNAPSHOT_SQL
].join("\n");

export type StorageMigration = Readonly<{
  version: number;
  name: string;
  introducedIn: string;
  sql: string;
  /** Version-owned payload migration, executed in the same transaction as SQL. */
  migrateData?: (db: Database.Database) => void;
}>;

/** Released migrations are append-only and must never be rewritten. */
const MIGRATIONS: readonly StorageMigration[] = Object.freeze([
  {
    version: 1,
    name: "v0.15.0-baseline",
    introducedIn: "0.15.0",
    sql: MIGRATION_1_SQL
  },
  {
    version: 2,
    name: "job-operation-facts",
    introducedIn: "0.15.2",
    // Historical records never carried caller identity or external effect
    // evidence. Preserve that uncertainty rather than inventing attribution.
    // No old executable implementation or runtime dual-read is needed.
    sql: `
UPDATE durable_jobs SET payload = json_set(payload,
  '$.schemaVersion', 2,
  '$.operation', json_object(
    'requestId', json_extract(payload, '$.idempotencyKey'),
    'inputDigest', json_extract(payload, '$.idempotencyKey'),
    'actorId', 'historical:unrecorded',
    'authorityRef', 'historical:unrecorded',
    'targetId', json_extract(payload, '$.workspace'),
    'capability', 'job.start',
    'implementation', json_object('id', 'yui:job-runner', 'generation', '1'),
    'effect', 'possible',
    'receiptRefs', json('[]'),
    'partialResultRefs', json('[]')
  )
);
CREATE UNIQUE INDEX idx_durable_jobs_request
ON durable_jobs(task_id, json_extract(payload, '$.operation.actorId'),
  json_extract(payload, '$.operation.requestId'));
`
  },
  {
    version: 3,
    name: "exact-attempt-result-identity",
    introducedIn: "0.15.5",
    // Append after the released T01 migration without changing its checksum.
    // Accepted inputs/results can use an exact attempt without a native Turn id.
    // Preserve all valid historical records; never repair failed Turns or logs.
    sql: "SELECT 1; -- exact attempt identity without a fabricated native Turn id"
  },
  {
    version: 4,
    name: "session-and-process-identity",
    introducedIn: "0.15.8",
    sql: REMOVE_RUNTIME_GENERATION_SQL,
    migrateData: removeRuntimeGenerationRecords
  },
  {
    version: 5,
    name: "project-resource-artifacts",
    introducedIn: "0.15.8",
    sql: `
CREATE TABLE artifacts (
  task_id TEXT NOT NULL REFERENCES tasks_catalog(task_id),
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
);
CREATE TABLE local_resources (
  id TEXT PRIMARY KEY,
  canonical_identity TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
);
CREATE TABLE environment_preparations (
  task_id TEXT NOT NULL REFERENCES tasks_catalog(task_id),
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
);
UPDATE projects SET payload = json_set(payload,
  '$.schemaVersion', 6, '$.resourceRefs', json('[]'),
  '$.defaultCapabilityProviders', json('{}'));
`
  },
  {
    version: 6,
    name: "session-endpoint-implementation",
    introducedIn: "0.15.8",
    // Valid earlier Sessions used these two built-in protocols. Generation 1
    // retains those codecs and identities behind the new execution boundary.
    // Preserve native IDs, effective snapshots and all historical results.
    sql: `
UPDATE role_session_sets SET payload = json_set(payload, '$.sessions', json((
  SELECT json_group_object(key, json_set(value, '$.schemaVersion', 6,
    '$.endpointImplementation', json_object(
      'id', 'yui.agent-endpoint.' || json_extract(value, '$.adapterId'), 'generation', '1')))
  FROM json_each(payload, '$.sessions')
)));
UPDATE role_session_sets SET payload = json_set(payload, '$.history', json((
  SELECT json_group_array(json_set(value, '$.schemaVersion', 6,
    '$.endpointImplementation', json_object(
      'id', 'yui.agent-endpoint.' || json_extract(value, '$.adapterId'), 'generation', '1')))
  FROM json_each(payload, '$.history')
))) WHERE json_type(payload, '$.history') = 'array';
UPDATE global_role_session_sets SET payload = json_set(payload, '$.sessions', json((
  SELECT json_group_object(key, json_set(value, '$.schemaVersion', 6,
    '$.endpointImplementation', json_object(
      'id', 'yui.agent-endpoint.' || json_extract(value, '$.adapterId'), 'generation', '1')))
  FROM json_each(payload, '$.sessions')
)));
UPDATE global_role_session_sets SET payload = json_set(payload, '$.history', json((
  SELECT json_group_object(key, json_set(value, '$.schemaVersion', 6,
    '$.endpointImplementation', json_object(
      'id', 'yui.agent-endpoint.' || json_extract(value, '$.adapterId'), 'generation', '1')))
  FROM json_each(payload, '$.history')
))) WHERE json_type(payload, '$.history') = 'object';
`
  },
  {
    version: 7,
    name: "task-facts-and-explicit-acceptance",
    introducedIn: "0.15.8",
    // Retain the complete retirement metadata/events and diagnostic facts.
    // Only the public lifecycle changes; ordinary stores read one shape.
    sql: `
UPDATE task_records SET payload = json_set(payload, '$.status', 'cancelled')
WHERE json_extract(payload, '$.status') = 'retired';
UPDATE task_records SET payload = json_set(payload, '$.retirementIsolation', json('true'))
WHERE json_extract(payload, '$.retiredAt') IS NOT NULL;
UPDATE tasks_catalog SET status = 'cancelled' WHERE status = 'retired';
UPDATE tasks_catalog SET lifecycle = 'cancelled' WHERE lifecycle = 'retired';
UPDATE task_records SET brief = json_set(brief, '$.revision', 1) WHERE brief IS NOT NULL;
UPDATE work_items SET payload = json_set(payload,
  '$.historicalState', json_patch(json('{}'), json_object(
    'status', json_extract(payload, '$.status'),
    'outcome', json_extract(payload, '$.outcome'),
    'endedAt', json_extract(payload, '$.endedAt'))),
  '$.status', CASE status WHEN 'completed' THEN 'accepted' WHEN 'retired' THEN 'retired' ELSE 'open' END);
UPDATE work_items SET payload = json_remove(payload, '$.outcome', '$.endedAt')
WHERE json_extract(payload, '$.status') = 'open';
UPDATE work_items SET status = json_extract(payload, '$.status');
UPDATE work_items SET payload = json_set(payload, '$.currentCandidateId',
  json_extract(payload, '$.candidates[#-1].id'))
WHERE json_extract(payload, '$.historicalState.status') = 'awaiting_acceptance';
UPDATE work_items SET payload = json_set(payload, '$.acceptedCandidateId',
  json_extract(payload, '$.candidates[#-1].id'))
WHERE status = 'accepted' AND json_array_length(payload, '$.candidates') > 0;
`
  },
  {
    version: 8,
    name: "event-owned-edit-history",
    introducedIn: "0.15.8",
    // Move embedded histories to one immutable import event per Task.
    // Existing events stay byte-identical; imports supply otherwise missing
    // historical fields and are evidence only, never executable lifecycle input.
    // Candidates may now carry optional fixed Artifact refs; absent refs remain
    // valid for historical Candidates, so this payload addition needs no backfill.
    sql: `
CREATE TEMP TABLE migrated_edit_history AS
SELECT records.task_id,
  COALESCE(sequences.high_water, 0) + 1 AS sequence,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS imported_at,
  json_object(
    'sourceStorageVersion', '7',
    'taskOutcomes', '' || COALESCE(json_extract(records.payload, '$.outcomeHistory'), '[]'),
    'workAcceptances', '' || COALESCE((
      SELECT json_group_array(json_object(
        'workItemId', work_item_id,
        'history', json_extract(payload, '$.acceptanceHistory')))
      FROM (SELECT * FROM work_items
        WHERE task_id = records.task_id
          AND json_array_length(payload, '$.acceptanceHistory') > 0
        ORDER BY work_item_id)
    ), '[]')
  ) AS history
FROM task_records AS records
LEFT JOIN id_sequences AS sequences
  ON sequences.task_id = records.task_id AND sequences.kind = 'event'
WHERE json_array_length(records.payload, '$.outcomeHistory') > 0
  OR EXISTS (SELECT 1 FROM work_items
    WHERE task_id = records.task_id AND json_array_length(payload, '$.acceptanceHistory') > 0);

INSERT INTO events (task_id, event_id, type, occurred_at, payload)
SELECT task_id, 'event-' || sequence, 'history.imported', imported_at,
  json_object('schemaVersion', 2, 'id', 'event-' || sequence,
    'taskId', task_id, 'type', 'history.imported',
    'createdAt', imported_at, 'payload', json(history))
FROM migrated_edit_history;
INSERT INTO id_sequences (task_id, kind, high_water)
SELECT task_id, 'event', sequence FROM migrated_edit_history WHERE true
ON CONFLICT(task_id, kind) DO UPDATE SET high_water = excluded.high_water;
DROP TABLE migrated_edit_history;

UPDATE task_records SET payload = json_remove(payload, '$.outcomeHistory'),
  brief = CASE WHEN brief IS NULL THEN NULL ELSE json_remove(brief, '$.revision') END;
UPDATE work_items SET payload = json_remove(payload, '$.acceptanceHistory');
`
  },
  {
    version: 9,
    name: "adopted-agent-execution-environment",
    introducedIn: "0.15.8",
    // Optional Role selection and immutable Session/Turn effective snapshot.
    // Existing records deliberately keep their managed-workspace execution;
    // adopted preparations must never be inferred as an automatic binding.
    sql: "SELECT 1; -- explicit adopted execution environment; absent means managed workspace"
  },
  {
    version: 10,
    name: "plugin-validation-evidence",
    introducedIn: "0.15.8",
    sql: `
CREATE TABLE plugin_validations (
  task_id TEXT NOT NULL REFERENCES tasks_catalog(task_id),
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
);
`
  },
  {
    version: 11,
    name: "plugin-enable-intent",
    introducedIn: "0.15.8",
    // A v10 validation proves no enable/disable choice. Preserve it unchanged;
    // never infer desired configuration from historical reports or processes.
    sql: `
CREATE TABLE plugin_intents (
  task_id TEXT NOT NULL REFERENCES tasks_catalog(task_id),
  plugin_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, plugin_id)
);
`
  },
  {
    // Renumbered from 10 to 12 when this branch adopted upstream master: PR320
    // took 10 and 11 while this work was in review. Both are already merged, so
    // they own those numbers; this migration appends after them rather than
    // competing for a number, and no released entry is touched.
    version: 12,
    name: "draft-planning-and-deferred-activation",
    // Same unreleased release as migrations 4-11: this does not bump the version.
    introducedIn: "0.15.8",
    // One current-version migration for everything this change adds. No existing
    // record is rewritten and no payload is backfilled:
    //
    //   - the optional Task activation request: absent means activation was
    //     never explicitly requested, so a Draft is never inferred to have
    //     requested it;
    //   - its bounded settled-request history: absent means no request ever
    //     reached a terminal disposition on this Task. This is a display
    //     projection, not the authority: whether an explicitly cancelled or
    //     adopted requestId may be replayed is decided from the durable
    //     activation event ledger (never compacted), so eviction from this
    //     bounded list never resurrects a decided outcome — per-request state
    //     inside the Task that owns it, not a second scheduling or operation
    //     ledger;
    //   - the planning Turn purpose: historical Turns keep their execution or
    //     review purpose untouched.
    //
    // The partial indexes bound Draft planning selection and pending-activation
    // recovery to the few rows that qualify, so no execution phase scans Task
    // history to find them. Creating an index adds no row and rewrites no
    // payload.
    sql: `
-- explicit activation request, its bounded settled history, and planning Turn
-- purpose; absent means activation was never requested
CREATE INDEX IF NOT EXISTS idx_turns_planning_active ON turns(task_id, turn_id)
  WHERE status = 'active' AND json_extract(payload, '$.purpose') = 'planning';
CREATE INDEX IF NOT EXISTS idx_tasks_activation_pending ON task_records(task_id)
  WHERE json_extract(payload, '$.activationRequest.disposition') = 'pending';
`
  },
  {
    version: 13,
    name: "session-authority-and-execution-admission",
    introducedIn: "0.15.9",
    sql: "SELECT 1; -- AgentRun contract, notification admission and Session authority",
    migrateData: migrateAgentRunContract
  },
  {
    version: 14,
    name: "acp-session-workspace-configuration",
    introducedIn: "0.15.10",
    // ACP is a new legal adapter/configuration value, including its optional
    // additional workspace roots. The v13 baseline has no ACP bindings; existing
    // Codex/Claude configuration and Session history remain valid unchanged.
    // This widens the persistent contract without rewriting payloads or earlier
    // migration checksums. Workspace delivery is negotiated at initialize, not
    // stored as another configuration authority.
    sql: "SELECT 1; -- ACP bindings may carry additionalDirectories; history stays valid"
  },
  {
    version: 15,
    name: "agent-execution-component",
    introducedIn: "0.15.10",
    // Which product executes is now its own recorded fact, separate from the
    // connection plan that reaches it. The plan keeps its `adapterId` name and
    // its meaning; only the product identity is new.
    //
    // The backfill is a total function of the stored plan, never of a command
    // string. `codex` and `claude` each have exactly one component, so those
    // rows gain their true value. Every `acp` row becomes `unknown-acp-agent`:
    // a v14 Home cannot say which product answered, and an executable named
    // `claude-agent-acp` is not evidence that it was the Claude Agent SDK. The
    // unidentified value is the honest one and stays correctable by hand.
    //
    // Sessions keep their own recorded component, so a Session started before
    // this migration continues against exactly the implementation it began on.
    //
    // Every persisted effective snapshot must be reached, not only the ones on
    // Session sets: `validateEffectiveLaunchSnapshot` demands schemaVersion 4,
    // and the upgrade verifier replays it over Runs, WorkItem ExecutionLanes
    // and ReviewRound ExecutionLanes too. A Home holding any of those would
    // otherwise fail the upgrade and roll back. The list below is the
    // verifier's own reachable set, not a scan for fields that look similar.
    sql: `
UPDATE configured_agents SET payload = json_set(payload,
  '$.schemaVersion', 3,
  '$.component', CASE json_extract(payload, '$.adapterId')
    WHEN 'codex' THEN 'codex-cli'
    WHEN 'claude' THEN 'claude-code-cli'
    ELSE 'unknown-acp-agent' END)
WHERE json_extract(payload, '$.component') IS NULL;

UPDATE global_roles SET payload = json_set(payload, '$.agentBindings', json((
  SELECT json_group_object(key, json_set(value, '$.component',
    CASE json_extract(value, '$.adapterId')
      WHEN 'codex' THEN 'codex-cli'
      WHEN 'claude' THEN 'claude-code-cli'
      ELSE 'unknown-acp-agent' END))
  FROM json_each(payload, '$.agentBindings')
))) WHERE json_type(payload, '$.agentBindings') = 'object';

UPDATE task_roles SET payload = json_set(payload, '$.agentBindings', json((
  SELECT json_group_object(key, json_set(value, '$.component',
    CASE json_extract(value, '$.adapterId')
      WHEN 'codex' THEN 'codex-cli'
      WHEN 'claude' THEN 'claude-code-cli'
      ELSE 'unknown-acp-agent' END))
  FROM json_each(payload, '$.agentBindings')
))) WHERE json_type(payload, '$.agentBindings') = 'object';

UPDATE global_role_session_sets SET payload = json_set(payload, '$.sessions', json((
  SELECT json_group_object(key, json_set(value, '$.effective.schemaVersion', 4,
    '$.effective.component', CASE json_extract(value, '$.effective.adapterId')
      WHEN 'codex' THEN 'codex-cli'
      WHEN 'claude' THEN 'claude-code-cli'
      ELSE 'unknown-acp-agent' END))
  FROM json_each(payload, '$.sessions')
))) WHERE json_type(payload, '$.sessions') = 'object';
UPDATE global_role_session_sets SET payload = json_set(payload, '$.history', json((
  SELECT json_group_object(key, json_set(value, '$.effective.schemaVersion', 4,
    '$.effective.component', CASE json_extract(value, '$.effective.adapterId')
      WHEN 'codex' THEN 'codex-cli'
      WHEN 'claude' THEN 'claude-code-cli'
      ELSE 'unknown-acp-agent' END))
  FROM json_each(payload, '$.history')
))) WHERE json_type(payload, '$.history') = 'object';

UPDATE role_session_sets SET payload = json_set(payload, '$.sessions', json((
  SELECT json_group_object(key, json_set(value, '$.effective.schemaVersion', 4,
    '$.effective.component', CASE json_extract(value, '$.effective.adapterId')
      WHEN 'codex' THEN 'codex-cli'
      WHEN 'claude' THEN 'claude-code-cli'
      ELSE 'unknown-acp-agent' END))
  FROM json_each(payload, '$.sessions')
))) WHERE json_type(payload, '$.sessions') = 'object';
UPDATE role_session_sets SET payload = json_set(payload, '$.history', json((
  SELECT json_group_array(json_set(value, '$.effective.schemaVersion', 4,
    '$.effective.component', CASE json_extract(value, '$.effective.adapterId')
      WHEN 'codex' THEN 'codex-cli'
      WHEN 'claude' THEN 'claude-code-cli'
      ELSE 'unknown-acp-agent' END))
  FROM json_each(payload, '$.history')
))) WHERE json_type(payload, '$.history') = 'array';

-- A Turn records the launch it actually ran on, one snapshot per row.
UPDATE turns SET payload = json_set(payload,
  '$.effective.schemaVersion', 4,
  '$.effective.component', CASE json_extract(payload, '$.effective.adapterId')
    WHEN 'codex' THEN 'codex-cli'
    WHEN 'claude' THEN 'claude-code-cli'
    ELSE 'unknown-acp-agent' END)
WHERE json_type(payload, '$.effective') = 'object';

-- ExecutionLane launch facts are frozen per Lane, inside an array of Groups
-- that each hold an array of Lanes. A Lane that was never dispatched has no
-- effective at all, and must keep that absence: json_set would otherwise
-- create a partial snapshot the Lane validator rejects as incomplete.
UPDATE work_items SET payload = json_set(payload, '$.executionGroups', json((
  SELECT json_group_array(json_set(grp.value, '$.lanes', json((
    SELECT json_group_array(CASE
      WHEN json_type(lane.value, '$.effective') = 'object'
      THEN json_set(lane.value, '$.effective.schemaVersion', 4,
        '$.effective.component', CASE json_extract(lane.value, '$.effective.adapterId')
          WHEN 'codex' THEN 'codex-cli'
          WHEN 'claude' THEN 'claude-code-cli'
          ELSE 'unknown-acp-agent' END)
      ELSE lane.value END)
    FROM json_each(grp.value, '$.lanes') AS lane
  ))))
  FROM json_each(payload, '$.executionGroups') AS grp
))) WHERE json_type(payload, '$.executionGroups') = 'array';

-- A ReviewRound holds at most one Group, so only the Lane array nests here.
UPDATE review_rounds SET payload = json_set(payload, '$.executionGroup.lanes', json((
  SELECT json_group_array(CASE
    WHEN json_type(lane.value, '$.effective') = 'object'
    THEN json_set(lane.value, '$.effective.schemaVersion', 4,
      '$.effective.component', CASE json_extract(lane.value, '$.effective.adapterId')
        WHEN 'codex' THEN 'codex-cli'
        WHEN 'claude' THEN 'claude-code-cli'
        ELSE 'unknown-acp-agent' END)
    ELSE lane.value END)
  FROM json_each(payload, '$.executionGroup.lanes') AS lane
))) WHERE json_type(payload, '$.executionGroup.lanes') = 'array';
`
  },
  {
    version: 16,
    name: "acp-session-run-configuration",
    introducedIn: "0.15.10",
    // An ACP Role binding may now carry a model, a reasoning effort and a
    // permission strategy beyond `default`, because Yui's ACP client implements
    // `session/set_config_option` and pushes those values to the Session before
    // it prompts. Previously the adapter rejected all three, so no stored
    // payload can contain them.
    //
    // This widens the contract without rewriting anything, and the absence of a
    // payload update is the substantive decision rather than an omission. A v10
    // ACP binding holds `permission.strategy = "default"`, which keeps exactly
    // the meaning it always had: Yui sends no mode, so the Agent's own default
    // stands. Rewriting those rows to `bypass` — or to any newly expressible
    // value — would grant authority the user never chose, on Homes whose owner
    // did nothing but upgrade. `bypass` is reachable only by asking for it.
    //
    // Effective launch snapshots need no change either. They already carry
    // optional `model` and `effort` on the shared base, and their ACP permission
    // is the same object the adapter canonicalizes, so a historical snapshot
    // still validates unchanged at schemaVersion 4 across Sessions, Session
    // history, Turns, WorkItem ExecutionLanes and ReviewRound ExecutionLanes.
    // A frozen snapshot therefore keeps describing the launch it actually ran,
    // which is what makes replaying old history honest.
    sql: "SELECT 1; -- ACP bindings may carry model/effort and a chosen "
      + "permission mode; existing `default` bindings keep their meaning"
  },
  {
    version: 17,
    name: "session-origin-input-requests",
    introducedIn: "0.15.8",
    // Widen requester provenance: notifications originate in a current Leader
    // Session without an AgentRun. Existing schemaVersion-3 requests keep their
    // exact Run/Session origin, including frozen historical Context values.
    // No guessed native identity or history rewrite is needed.
    sql: "SELECT 1; -- InputRequest requester.runId is optional when an exact nativeSessionId is present"
  },
  {
    version: 18,
    name: "replaceable-session-process-custody",
    introducedIn: "0.15.8",
    // Existing Session/Run history remains unchanged. Runtime mailboxes may
    // now retain explicit replacement intent; OS owner records may identify
    // the dedicated execution child, independently of a disposable Host.
    sql: "SELECT 1; -- Replacement intent, independent retained native control evidence/process custody, and optional fixed TaskWake refs"
  },
  {
    version: 19,
    name: "task-artifacts-local-git",
    introducedIn: "0.16.0",
    // Retire the DB-owned immutable Artifact store: file/directory artifacts now
    // live in a per-Task local Git repository, referenced by a self-certifying
    // `commit + relativePath`. The whole rewrite is payload work that must READ
    // the `artifacts` table before it is dropped, so it runs entirely in
    // `migrateData` (which executes after this `sql`) — the table is dropped
    // there, last, once its rows have been moved. Requirement A's independent,
    // deterministic submit-intent backfill (events + id_sequences only) is the
    // final step inside that same transaction. This `sql` is intentionally a
    // no-op: dropping the table here would destroy the rows before they move.
    //
    // The 18->19 contract also DECLARES three optional `messages.payload` fields
    // added by Requirement A — `intent` (record|discuss|develop), an optional
    // client idempotency `submissionKey`, and a frozen `submissionReceipt`
    // disposition. They add no column and no table and are only ever written
    // going forward (absent `intent` reads as discuss; absent key is keyless;
    // absent receipt is a pre-19 message), so NO historical row is rewritten and
    // no key or receipt is ever fabricated for old data — declaring them here
    // satisfies "optional still requires a migration declaration".
    sql: "SELECT 1; -- artifacts move to per-Task local Git; see migrateArtifactsToGit",
    migrateData: migrateArtifactsToGit
  },
  {
    version: 20,
    name: "integration-conflict-continuation",
    introducedIn: "0.16.0",
    // Widen Integration status with conflicted; declare optional sourceProgress
    // (Git cursor/reflog action) and checkInputDigest. Exact old bound FF Job
    // receipts supply these facts; unprovable history remains unchanged.
    // Frozen Context and events are never rewritten.
    sql: "SELECT 1; -- Integration Git progress and exact check admission",
    migrateData: migrateIntegrationContinuation
  },
  {
    version: 21,
    name: "force-archive-independent-cleanup",
    introducedIn: "0.16.0",
    // Declare optional task.archived force/cleanup/warnings/retainedResources
    // audit fields and task.archive-cleanup resource/status/detail/paths events;
    // runtime.event-obsolete may retain the full originalEvent as source evidence.
    // Archived Tasks may retain exact runtime/workspace/mailbox ownership.
    // Existing archive, completion and Publication history is unchanged.
    sql: "SELECT 1; -- archive intent and cleanup evidence remain separate facts"
  },
  {
    version: 22,
    name: "controller-owned-agent-host-ingress",
    introducedIn: "0.16.0",
    // Add optional `host` source metadata to the stable Inbox v1 observation
    // envelope. Such facts contain no resolved Run: current Controller alone
    // validates ownership and commits observations, process custody and native
    // account locations. Existing Inbox facts and domain history stay intact.
    // Host status capabilities/transport diagnostics are live, not stored.
    sql: "SELECT 1; -- Controller-owned Host ingress; no historical data rewrite"
  },
  {
    version: 23,
    name: "unified-message-input-control",
    introducedIn: "0.16.1",
    // Widen the Message payload with an optional durable input action
    // (queue/steer) plus its stable requestId, and an optional interrupt-then
    // handoff claim (requestId + exact target AgentRun). Existing messages carry
    // neither field and keep their current queue semantics and delivery history;
    // no native Turn identity is synthesized and no history is rewritten. The
    // same contiguous migration adds the Global-owned Message store
    // (global_role_messages), extending the Message store to a Global owner
    // exactly as global_role_session_sets parallels role_session_sets: an
    // explicit Global owner and authorizable reference, no fabricated Task and
    // no new private global queue (decision-3 §9/§11).
    sql: `SELECT 1; -- Message input actions, exact Session delivery pins, provider receipts and interrupt-then claims; Global Session provider bindings and native interrupt evidence\n${GLOBAL_ROLE_MESSAGE_SQL}`
  },
  {
    version: 24,
    name: "unify-home-layout",
    introducedIn: "0.15.9",
    // Unify every Yui self-managed path under a single canonical YUI_HOME. The
    // managed Git worktrees move from the out-of-Home `defaultWorkspace` into
    // `<home>/workspaces/{worktree,tasks}` and the provider runtimes from the
    // `<home>.task-runtimes` sibling into `<home>/runtime/task-runtimes`. Only
    // the durable Git worktree tree is physically relocated, by COPY (never
    // rename-away): its replica is digest-verified against the source and
    // atomically published while the original is PRESERVED as the rollback
    // anchor; the regenerable task views and disposable runtimes are pointer
    // rewrites only. The copied worktrees are then repaired, and only the
    // persisted pointers the runtime trusts as live are rewritten. Frozen
    // evidence (Context snapshots, terminal Run Git evidence, candidate
    // snapshots, terminal Jobs, reports) and self-healing/self-rediscovered
    // records (Task cwd, active Role workspaces, views, resource registry) are
    // left intact; a queued/running Job bound under a relocating root is refused
    // rather than silently moved. The data/filesystem transform is the
    // substantive step; the SQL is inert.
    sql: UNIFY_HOME_LAYOUT_SQL,
    migrateData: migrateUnifyHomeLayout
  },
  {
    version: 25,
    name: "collapse-worktree-layout",
    introducedIn: "0.15.9",
    // Collapse the two-layer managed workspace layout into a single layer of real
    // Git worktrees addressed by Task/owner and Project. Each managed worktree
    // moves from its per-Project physical root
    // (`<home>/workspaces/worktree/<projectName>/<taskKey>/<roleKey>`) to the
    // location the v19 symlink view used to point at
    // (`<home>/workspaces/tasks/<taskId>/<owner>/<projectDirectory>`), so the
    // logical entry path and the physical worktree become the same directory and
    // the symlink-view indirection is gone; an integration attempt moves under a
    // new `tasks/<taskId>/integrations/<id>/` owner root, addressed by the bound
    // Project directory rather than the Project name. Only the durable Git
    // worktrees are physically relocated, by COPY (never rename-away): each
    // replica is digest-verified against the source and atomically published over
    // the regenerable view symlink while the original is PRESERVED as the
    // rollback anchor. The copied worktrees are then repaired, and only the
    // persisted pointers the runtime trusts as live are rewritten. Frozen
    // evidence and self-healing records are left intact; a queued/running Job
    // bound under a relocating worktree is refused rather than silently moved.
    // The data/filesystem transform is the substantive step; the SQL is inert.
    sql: COLLAPSE_WORKTREE_LAYOUT_SQL,
    migrateData: migrateCollapseWorktreeLayout
  },
  {
    version: 26,
    name: "publication-candidate-adoption",
    introducedIn: "0.15.12",
    // Add optional Publication.headCommit (the observed PR/MR source head) and
    // publication.candidate-adopted events binding publicationId, completionEventId,
    // projectId, acceptedCommit/localCommit, acceptedTree/candidateTree, diffDigest,
    // acceptance and by, optionally integrationId/integrationDigest. Derived
    // task.archived mergeCoverage may also be uncovered or unverified.
    // No stored delivery index and no inferred adoption or verification:
    // valid old Publication, completion and archive payloads remain byte-identical.
    sql: "SELECT 1; -- fixed acceptance-to-publication evidence; preserve all historical facts"
  },
  {
    version: 27,
    name: "bounded-provider-input-retry",
    introducedIn: "0.16.0",
    // Optional owned input/recovery records on the existing Provider binding;
    // positive Driver transient evidence on StandardAgentError. No historical
    // failures are scanned, scheduled, reclassified or replayed by upgrading.
    sql: `
-- ProviderTurn.input/retrySupported/failure; ProviderRuntimeBinding.retry/retryHistory/retryDisabled;
-- optional error retryable and retryAfterMs facts. Index existing records only.
CREATE INDEX idx_task_provider_retry ON role_session_sets(
  json_extract(payload, '$.providerBinding.retry.status')
) WHERE json_extract(payload, '$.providerBinding.retry.status') IN ('waiting', 'in-flight');
CREATE INDEX idx_global_provider_retry ON global_role_session_sets(
  json_extract(payload, '$.providerBinding.retry.status')
) WHERE json_extract(payload, '$.providerBinding.retry.status') IN ('waiting', 'in-flight');
`
  },
  {
    version: 28,
    name: "current-contract-only-dispatch",
    introducedIn: "0.16.0",
    // Freeze the one valid earlier singleton dispatch shape here, not in the
    // normal runtime. Preserve the full input batch and sequence; only replace
    // its transport dedupe identity. Merged/ambiguous batches, processing
    // claims, original Messages, results and external-effect evidence remain
    // untouched. This step does not accept, replay or complete any execution.
    sql: `
UPDATE mailboxes
SET pending = json_set(pending,
  '$.sources', json_array('turn-dispatch'),
  '$.dedupeKeys', json_array('role-turn:' || task_id || ':' || role_name || ':' ||
    (SELECT json_extract(value, '$.id') FROM json_each(mailboxes.pending, '$.refs')
     WHERE json_extract(value, '$.type') = 'run'
       AND json_extract(value, '$.taskId') = mailboxes.task_id)))
WHERE target_kind = 'role' AND role_name <> 'leader' AND pending IS NOT NULL
  AND json_extract(pending, '$.requestCount') = 1
  AND json_array_length(pending, '$.sources') = 1
  AND json_extract(pending, '$.sources[0]') = 'yui'
  AND EXISTS (SELECT 1 FROM json_each(mailboxes.pending, '$.reasons')
    WHERE value IN ('turn-dispatched', 'turn-retried', 'review-requested',
                    'workitem-synthesis-ready', 'review-synthesis-ready'))
  AND (SELECT count(*) FROM json_each(mailboxes.pending, '$.refs')
       WHERE json_extract(value, '$.type') = 'run') = 1
  AND EXISTS (SELECT 1 FROM json_each(mailboxes.pending, '$.refs')
    WHERE json_extract(value, '$.type') = 'run'
      AND json_extract(value, '$.taskId') = mailboxes.task_id);
`
  },
  {
    version: 29,
    name: "agent-ordered-atomic-integration",
    introducedIn: "0.16.0",
    // Retire the scheduler, not its user's intent. Freeze each complete queue
    // payload in ordinary Task history before dropping the active table.
    // Existing Integrations, Jobs and WorkItem delivery evidence remain exact;
    // no entry is interpreted as committed or automatically replayed.
    sql: `
CREATE TEMP TABLE retired_integration_queue AS
SELECT q.*,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS retired_at,
  max(
    coalesce((SELECT high_water FROM id_sequences
              WHERE task_id = q.task_id AND kind = 'event'), 0),
    coalesce((SELECT max(CAST(substr(event_id, 7) AS INTEGER)) FROM events
              WHERE task_id = q.task_id), 0)
  ) + row_number() OVER (
    PARTITION BY q.task_id ORDER BY q.created_at,
      CAST(substr(q.queue_id, length('integration-queue-') + 1) AS INTEGER)
  ) AS event_sequence
FROM integration_queue AS q;

INSERT INTO events(task_id, event_id, type, occurred_at, payload)
SELECT task_id, 'event-' || event_sequence, 'integration.queue-retired', retired_at,
  json_object(
    'schemaVersion', 2, 'id', 'event-' || event_sequence, 'taskId', task_id,
    'type', 'integration.queue-retired', 'createdAt', retired_at,
    'payload', json_object('queueId', queue_id, 'record', payload,
      'disposition', 'retired-without-replay')
  )
FROM retired_integration_queue;

INSERT INTO id_sequences(task_id, kind, high_water)
SELECT task_id, 'event', max(event_sequence)
FROM retired_integration_queue GROUP BY task_id
ON CONFLICT(task_id, kind) DO UPDATE SET high_water = excluded.high_water;

DROP TABLE retired_integration_queue;
DROP TABLE integration_queue;
DELETE FROM id_sequences WHERE kind = 'integrationQueue';
`
  },
  {
    version: 30,
    name: "notification-only-wakes",
    introducedIn: "0.16.0",
    sql: "SELECT 1; -- Retire Run-linked wakes as audit events; notification schema 2; explicit Global providerBinding",
    migrateData: migrateNotificationOnlyWakes
  },
  {
    version: 31,
    name: "explicit-review-scope",
    introducedIn: "0.16.0",
    sql: `
UPDATE review_rounds
SET payload = json_set(payload, '$.scope', 'work-item')
WHERE json_type(payload, '$.scope') IS NULL
   OR json_type(payload, '$.scope') = 'null';
`
  },
  {
    version: 32,
    name: "work-item-history-as-events",
    introducedIn: "0.16.0",
    sql: "SELECT 1; -- Archive original WorkItem payloads before removing historicalState",
    migrateData: migrateWorkItemHistory
  },
  {
    version: 33,
    name: "advisory-and-verification-policy",
    introducedIn: "0.16.0",
    sql: "SELECT 1; -- Retire rollout modes/shadow metrics; explicit rerun intent; verification proof v3",
    migrateData: migrateVerificationPolicy
  },
  {
    version: 34,
    name: "current-input-contract",
    introducedIn: "0.16.0",
    sql: "SELECT 1; -- Archive retired Message wake policies and activation origin gates",
    migrateData: migrateCurrentInputContract
  }
]);

for (let index = 0; index < MIGRATIONS.length; index += 1) {
  const expectedVersion = MIN_SUPPORTED_STORAGE_VERSION + index;
  if (MIGRATIONS[index]?.version !== expectedVersion) {
    throw new Error(
      `Storage migration registry must be contiguous from `
        + `${MIN_SUPPORTED_STORAGE_VERSION}; missing version ${expectedVersion}.`
    );
  }
}
if (MIGRATIONS.at(-1)?.version !== CURRENT_STORAGE_VERSION) {
  throw new Error(
    `Storage migration registry head ${String(MIGRATIONS.at(-1)?.version)} does not match `
      + `CURRENT_STORAGE_VERSION ${CURRENT_STORAGE_VERSION}.`
  );
}

/** Current hot-path indexes whose absence would invalidate a current Home. */
const REQUIRED_SCHEMA_INDEXES = [
  "idx_mailboxes_ready",
  "idx_input_requests_open_hot",
  "idx_turns_planning_active",
  "idx_tasks_activation_pending"
] as const;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * A SQLite Home is only safe to open when its migration ledger proves exactly
 * which schema definition was applied.  The ledger is durable metadata, not a
 * best-effort cache: a missing row, a changed checksum, or an unknown version
 * must stop startup before any pending schema step is applied.
 */
export class SqliteSchemaMigrationError extends Error {
  constructor(detail: string, subject = "metadata") {
    super(`SQLite schema migration ${subject} is invalid: ${detail}`);
    this.name = "SqliteSchemaMigrationError";
  }
}

const SCHEMA_MIGRATIONS_SQL = `
    CREATE TABLE schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum   TEXT NOT NULL
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
  name: unknown;
  checksum: unknown;
}>;

type AppliedMigrations = Readonly<{
  versions: ReadonlySet<number>;
  currentVersion: number;
  currentChecksum: string;
}>;

function validateMigrationLedgerColumns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name?: unknown }>)
      .flatMap(({ name }) => typeof name === "string" ? [name] : [])
  );
  if (
    columns.size === 4
    && ["version", "name", "applied_at", "checksum"].every((name) => columns.has(name))
  ) {
    return;
  }
  throw new SqliteSchemaMigrationError(
    "schema_migrations columns do not match the storage-version-1 ledger"
  );
}

/** Validate the applied linear prefix and return its current head. */
function validateAppliedMigrations(
  db: Database.Database,
  ledgerWasCreated: boolean
): AppliedMigrations {
  validateMigrationLedgerColumns(db);
  const expected = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  const rows = db.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
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
    if (applied.has(version)) {
      throw new SqliteSchemaMigrationError(`duplicate migration version ${version}`);
    }
    applied.add(version);

    if (migration === undefined) {
      if (version <= CURRENT_STORAGE_VERSION) {
        throw new SqliteSchemaMigrationError(`unknown migration version ${version}`);
      }
      if (typeof row.name !== "string" || row.name.length === 0
        || typeof row.checksum !== "string" || row.checksum.length === 0) {
        throw new SqliteSchemaMigrationError(
          `future migration ${version} metadata is invalid`
        );
      }
      continue;
    }
    if (row.name !== migration.name) {
      throw new SqliteSchemaMigrationError(
        `migration ${version} name ${String(row.name)} does not match ${migration.name}`
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
    const expectedVersion = MIN_SUPPORTED_STORAGE_VERSION + index;
    if (versions[index] !== expectedVersion) {
      throw new SqliteSchemaMigrationError(
        `migration ledger has a gap before version ${versions[index]}`
      );
    }
  }
  const currentVersion = versions.at(-1) ?? 0;
  const head = rows.at(-1);
  return {
    versions: applied,
    currentVersion,
    currentChecksum: typeof head?.checksum === "string" ? head.checksum : ""
  };
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

  const homeMetaColumns = (
    db.prepare("PRAGMA table_info(home_meta)").all() as Array<{ name?: unknown }>
  ).map(({ name }) => name);
  const expectedHomeMetaColumns = [
    "id",
    "home_identity",
    "revision",
    "created_at",
    "updated_at"
  ];
  if (
    homeMetaColumns.length !== expectedHomeMetaColumns.length
    || homeMetaColumns.some((name, index) => name !== expectedHomeMetaColumns[index])
  ) {
    throw new SqliteSchemaMigrationError(
      "home_meta columns do not match the current storage contract",
      "schema object"
    );
  }
}

export interface MigrationResult {
  /** Versions applied by this run (empty when the schema was already current). */
  readonly applied: readonly number[];
  /** The schema version after the operation. */
  readonly version: number;
}

export type SqliteSchemaMigrationState = Readonly<{
  /** Highest contiguous migration already committed. */
  currentVersion: number;
  /** Checksum of the current ledger head validated by the staged binary. */
  currentChecksum: string;
  /** Schema version required by this release. */
  targetVersion: number;
  /** Oldest storage version for which this CLI carries a complete upgrade path. */
  minimumSupportedVersion: number;
  /** Checksum expected at the target ledger head. */
  targetChecksum: string;
  /** Ordered versions that an explicit upgrade must apply. */
  pendingVersions: readonly number[];
}>;

export type StorageMigrationStep = Readonly<{
  fromVersion: number;
  toVersion: number;
  name: string;
  introducedIn: string;
}>;

/** Return the one linear upgrade path from a supported source to this release. */
export function storageMigrationPlan(
  currentVersion: number
): readonly StorageMigrationStep[] | null {
  if (
    !Number.isInteger(currentVersion)
    || currentVersion < MIN_SUPPORTED_STORAGE_VERSION
    || currentVersion > CURRENT_STORAGE_VERSION
  ) {
    return null;
  }
  return MIGRATIONS
    .filter(({ version }) => version > currentVersion)
    .map(({ version, name, introducedIn }) => ({
      fromVersion: version - 1,
      toVersion: version,
      name,
      introducedIn
    }));
}

export type SqliteSchemaMigrationMode = "apply" | "validate";

export type SqliteSchemaMigrationOptions = Readonly<{
  /**
   * `apply` is owned by initialization or an explicit upgrade boundary.
   * `validate` is the only legal ordinary open mode for an existing
   * authoritative database.
   */
  mode: SqliteSchemaMigrationMode;
  /**
   * Inclusive upper bound on the version to apply, defaulting to
   * `CURRENT_STORAGE_VERSION`. Production callers never set it, so behavior is
   * unchanged: a fresh or pending database advances to head as one commit.
   *
   * It exists ONLY to reconstruct a genuine older on-disk version from the REAL,
   * checksum-validated migration definitions (e.g. an upgrade regression that
   * must start at v18 and then drive the real upgrade to v19), rather than
   * hand-crafting the older schema. It is honored only in `apply` mode, never
   * downgrades, never skips an intermediate version, and defers head-shape
   * validation until head is actually reached. A later migration that introduces
   * a new required table is therefore not validated before it is applied.
   */
  throughVersion?: number;
}>;

/** Inspect a recognized migration prefix without changing it. */
export function inspectSqliteSchemaMigrations(
  db: Database.Database
): SqliteSchemaMigrationState {
  const ledgerWasCreated = ensureMigrationLedger(db, "validate");
  const applied = validateAppliedMigrations(db, ledgerWasCreated);
  if (applied.currentVersion > CURRENT_STORAGE_VERSION) {
    return {
      currentVersion: applied.currentVersion,
      currentChecksum: applied.currentChecksum,
      targetVersion: CURRENT_STORAGE_VERSION,
      minimumSupportedVersion: MIN_SUPPORTED_STORAGE_VERSION,
      targetChecksum: checksum(MIGRATIONS.at(-1)!.sql),
      pendingVersions: []
    };
  }
  const pendingVersions = MIGRATIONS
    .filter((migration) => !applied.versions.has(migration.version))
    .map((migration) => migration.version);
  if (pendingVersions.length === 0) validateSchemaObjects(db);
  const target = MIGRATIONS.at(-1)!;
  if (applied.currentVersion === 0) {
    throw new SqliteSchemaMigrationError("schema_migrations ledger has no current head");
  }
  return {
    currentVersion: applied.currentVersion,
    currentChecksum: applied.currentChecksum,
    targetVersion: CURRENT_STORAGE_VERSION,
    minimumSupportedVersion: MIN_SUPPORTED_STORAGE_VERSION,
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
  const migrate = (): { newlyApplied: number[]; head: number } => {
    const ledgerWasCreated = ensureMigrationLedger(db, options.mode);
    // Validate the complete ledger before touching any pending migration. This
    // prevents a manually altered or partially recorded ledger from silently
    // skipping a later schema/data step.
    const applied = validateAppliedMigrations(db, ledgerWasCreated);
    if (applied.currentVersion > CURRENT_STORAGE_VERSION) {
      throw new SqliteSchemaMigrationError(
        `storage version ${applied.currentVersion} is newer than supported `
          + `${CURRENT_STORAGE_VERSION}`,
        "admission"
      );
    }
    if (applied.currentVersion !== 0
      && applied.currentVersion < MIN_SUPPORTED_STORAGE_VERSION) {
      throw new SqliteSchemaMigrationError(
        `storage version ${applied.currentVersion} is older than the minimum supported `
          + `${MIN_SUPPORTED_STORAGE_VERSION}`,
        "admission"
      );
    }
    // Production callers omit `throughVersion`, so the effective target is head
    // and behavior is unchanged; a partial target is honored only in apply mode.
    const effectiveTarget = options.mode === "apply" && options.throughVersion !== undefined
      ? options.throughVersion
      : CURRENT_STORAGE_VERSION;
    const pending = MIGRATIONS.filter(
      (migration) => !applied.versions.has(migration.version) && migration.version <= effectiveTarget
    );
    if (!ledgerWasCreated && pending.length > 0 && options.mode === "validate") {
      throw new SqliteSchemaMigrationError(
        `Storage version ${applied.currentVersion} requires an explicit upgrade to `
          + `${CURRENT_STORAGE_VERSION}`,
        "admission"
      );
    }
    // Bound the applied steps to `throughVersion` (default and clamp: head), so a
    // migration test can stop at one step's intermediate state while production
    // always advances to head. The validate-mode guard above still fires on the
    // FULL pending set — the bound never lets an ordinary open partially migrate.
    const targetVersion = Math.min(
      options.throughVersion ?? CURRENT_STORAGE_VERSION,
      CURRENT_STORAGE_VERSION
    );
    const toApply = pending.filter((migration) => migration.version <= targetVersion);
    const newlyApplied: number[] = [];
    for (const migration of toApply) {
      db.exec(migration.sql);
      migration.migrateData?.(db);
      const appliedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO schema_migrations (version, name, applied_at, checksum)
         VALUES (?, ?, ?, ?)`
      ).run(
        migration.version,
        migration.name,
        appliedAt,
        checksum(migration.sql)
      );
      newlyApplied.push(migration.version);
    }
    // The table/index inventory describes the HEAD shape; only assert it once the
    // migration has actually advanced to head (a deliberate partial target stops
    // earlier and is validated when the real upgrade later completes it).
    if (effectiveTarget >= CURRENT_STORAGE_VERSION) validateSchemaObjects(db);
    // The true head reached: the highest already-applied version or, when this
    // run advanced the ledger, the last step it committed. Bounded runs report
    // the intermediate head; an unbounded run reports CURRENT_STORAGE_VERSION.
    const head = newlyApplied.at(-1) ?? applied.currentVersion;
    return { newlyApplied, head };
  };
  const outcome = options.mode === "apply" && !db.inTransaction
    ? db.transaction(migrate)()
    : migrate();
  return { applied: outcome.newlyApplied, version: outcome.head };
}

/** The names of every table the schema creates (for tests/introspection). */
export const SQLITE_SCHEMA_TABLES: readonly string[] = [
  "plugin_intents",
  "plugin_validations",
  "local_resources",
  "environment_preparations",
  "schema_migrations",
  "home_meta",
  "config",
  "configured_agents",
  "agent_profiles",
  "projects",
  "global_roles",
  "global_role_session_sets",
  "global_role_messages",
  "global_sequences",
  "tasks_catalog",
  "managed_workspaces",
  "id_sequences",
  "coordination_locks",
  "durable_jobs",
  "outbox",
  "mailboxes",
  "task_records",
  "task_roles",
  "role_session_sets",
  "work_items",
  "work_item_candidates",
  "context_snapshots",
  "turns",
  "active_turns",
  "review_rounds",
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
  "task_wakes",
  "session_owners",
  "runtime_session_candidates",
  "resource_registry",
  "gate_artifacts",
  "gate_artifact_logs"
] as const;
