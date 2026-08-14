# SQLite Control-Plane Design

Status: design (work-item-2, task-21). Owner: Leader. No production code changes yet.

This document specifies the target persistence and threading architecture for the
Yui Controller:

1. A normalized SQLite WAL store, logically partitioned by `task_id`, replacing
   the single aggregate `state.json` document.
2. A persistence Worker Thread owning the database, with a bounded RPC/queue
   seam from the main thread, plus a resource-inventory Worker Thread.
3. A repeatable, verifiable, rollback-able offline migration from `state.json`,
   integrated with the existing three-axis compatibility framework.

The design preserves every existing semantic invariant: Task/Role/Run/Session/
receipt/fence CAS, mailbox ordering, exactly-once terminal state, and crash
recovery. It does not weaken fsync or terminal durability, does not reduce Agent
concurrency, and does not extend timeouts.

## 1. Goals and non-goals

Goals:

- Main thread does only socket I/O, command validation, sequential arbitration,
  and lightweight scheduling. JSON parse/stringify of record payloads, record
  schema validation, SQL execution, and resource inventory run off the main
  event loop.
- A high-frequency `runtime.provider-turn-progress` event appends/upserts one
  row in one task's telemetry table. It never rewrites global state and never
  touches another task's rows.
- Task-local reads (messages, runs, events, work items, reviews, integrations)
  are indexed lookups scoped by `task_id`, not scans of a 36 MB document.
- Cross-task coordination (Project locks, Integration queue, runtime cleanup,
  identity/CAS) stays consistent through global tables and idempotent
  transactions.
- The file `TaskStore` remains available and default during the transition;
  backend selection is explicit configuration.

Non-goals:

- Physical sharding of terminal history in the first cut. The design states the
  criteria (§7); a single WAL database is the initial target.
- Changing record schemas or domain validation rules. Records keep their
  family `schemaVersion` and existing validators.
- Rewriting the tmux/runtime ownership model.

## 2. Driver choice

The package engine floor is Node `^20.17.0 || ^22.9.0 || ^24.0.0`
(linux/x64/glibc only).

| Option | Verdict |
| --- | --- |
| `better-sqlite3` | **Chosen.** Synchronous API, full WAL support, integrity constraints, prebuilt binaries for linux/x64. A synchronous driver is correct *inside the persistence worker*: it never blocks the main event loop, and it makes multi-statement transactions trivial and fast. |
| `node:sqlite` | Unavailable on the Node 20 floor (added in 22.5/23.4). Rejected. |
| `sql.js` (WASM) | No real on-disk WAL; persistence would be manual exports. Rejected. |
| `libsql` client | Async client/server model; adds a server process. Rejected for the local single-controller deployment. |

`better-sqlite3` ships prebuilt binaries for the supported triple; `npm ci`
must verify the prebuilt path (no toolchain dependency in the normal install).

## 3. Process and thread model

```
┌─────────────────────────────── Main thread ───────────────────────────────┐
│ Unix socket server (core/controllerServer)                                │
│ Command validation · sequential arbitration · lightweight scheduling      │
│   └─ AsyncTaskStoreClient ── bounded queue ──┐                            │
│   └─ ResourceInventoryClient ── bounded queue ──┐                         │
└───────────────────────────────────────────────┼───────────────────────────┘
                                                │
┌──────────────────────── Persistence worker ───▼──────────────────────────┐
│ One writer connection (WAL, BEGIN IMMEDIATE) + read pool                  │
│ JSON parse/stringify · record validation · SQL transactions · migrations  │
└───────────────────────────────────────────────────────────────────────────┘
┌────────────────────── Resource inventory worker ─────────────────────────┐
│ /proc scanning (resourceInventoryLinux) · bounded result posts            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Bounded RPC seam

- Main thread and workers communicate over `MessageChannel` ports with a
  **bounded number of in-flight requests** (configurable, default 64) and a
  bounded queue depth. When the queue is full the main thread applies
  backpressure: control commands that require persistence await (they already
  return promises); the socket keeps accepting and draining.
- Every request carries an idempotency key (`requestId`). The worker dedupes
  in-flight and recently-committed keys, so a main-thread retry after a worker
  restart never double-applies.
- Cancellation: requests carry an `AbortSignal`; a cancelled request sends a
  cancel message. The worker checks cancellation between statements and rolls
  back an open transaction. Already-committed transactions are not undone
  (their effects are idempotent and semantically owned by the caller).
- Fault boundary: worker crash → main thread observes `exit`/`error`, restarts
  the worker, replays the durable outbox (§5.4) and any unacknowledged
  idempotent requests. SQLite WAL guarantees everything committed before the
  crash is durable; everything uncommitted is rolled back by SQLite recovery.

### 3.2 Transaction semantics

Today, `TaskStore.transaction(closure)` takes a process-wide write lock,
re-reads the document, runs the closure, and commits with a revision CAS. The
worker model preserves this:

- `transactionAsync(commands)` sends an ordered batch of store operations to
  the worker; the worker runs them inside one `BEGIN IMMEDIATE … COMMIT` on the
  single writer connection. Writes are therefore serialized exactly as today.
- Read-then-write closures (e.g. `nextMessageId` then `saveMessage`) become
  command batches executed atomically in the worker. Call sites that currently
  compose reads and writes inside one closure are refactored to explicit
  batches; the `TaskStore` interface gains an async transactional counterpart
  (`AsyncTaskStore`) rather than shipping closures across threads.
- The global `revision` CAS is retained as `home_meta.revision`, checked and
  incremented inside the same SQL transaction. A conflicting commit (e.g. a
  concurrent CLI writer) fails the transaction with `StorageConflictError`,
  same as today.
- Read-only commands use the read pool (separate connections in WAL mode do
  not block the writer) and never take the write lock.

### 3.3 Resource inventory worker

`resourceInventoryLinux` /proc scanning moves to its own worker, reusing the
same bounded-RPC primitives. It posts samples back at the current cadence; the
scheduler and ephemeral reaper consume them through the same ports as today.
Inventory work never touches the persistence worker's connection.

## 4. Logical schema

All task-partitioned tables carry a `task_id` column indexed first. Task-local
queries always constrain `task_id`; no query scans another task's history.

Record payloads are stored two ways: typed columns for fields that are queried,
filtered, or used for CAS/ordering, and a `payload` JSON column holding the
full record (including its family `schemaVersion`). Existing validators run on
parse in the worker. This keeps the record axis of the three-axis versioning
(§8) and avoids a 1:1 column explosion for rarely-queried fields.

### 4.1 Global catalog and coordination tables

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;          -- no fsync weakening (task boundary)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  axis        TEXT NOT NULL CHECK (axis IN ('layout','aggregate','record')),
  record_kind TEXT,
  applied_at  TEXT NOT NULL,
  checksum    TEXT NOT NULL
);

CREATE TABLE home_meta (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  home_identity     TEXT NOT NULL,          -- JSON: HomeIdentity
  revision          INTEGER NOT NULL,       -- global CAS, mirrors state.json revision
  layout_version    INTEGER NOT NULL,
  aggregate_version INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE configured_agents (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,                 -- full versioned record
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_profiles (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE global_roles (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE global_role_session_sets (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,                 -- RoleSessionSet record
  updated_at TEXT NOT NULL,
  FOREIGN KEY (name) REFERENCES global_roles(name)
);

-- Task catalog: the global active index and lifecycle lookup.
CREATE TABLE tasks_catalog (
  task_id     TEXT PRIMARY KEY,
  status      TEXT NOT NULL,                -- TaskStatus
  lifecycle   TEXT NOT NULL,
  is_active   INTEGER NOT NULL CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_tasks_active ON tasks_catalog(is_active) WHERE is_active = 1;

-- Session/Workspace ownership is global (workspaces outlive task activity and
-- are keyed by durable owner).
CREATE TABLE managed_workspaces (
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('task','work-item','review-round','integration-attempt')),
  owner_id    TEXT NOT NULL,
  task_id     TEXT,
  path        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);
CREATE INDEX idx_workspaces_task ON managed_workspaces(task_id);

-- Per-task record ID high-water marks (replaces StoredTask.idHighWaterMarks).
CREATE TABLE id_sequences (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- TaskRecordKind
  high_water INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind)
);

-- Cross-task coordination: Project locks and the Integration queue.
CREATE TABLE coordination_locks (
  lock_key     TEXT PRIMARY KEY,            -- e.g. 'project:<id>'
  holder_task  TEXT NOT NULL,
  holder_ref   TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT
);

CREATE TABLE integration_queue (
  queue_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  change_set   TEXT NOT NULL,
  status       TEXT NOT NULL,               -- queued/running/done/failed
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_integration_queue_status ON integration_queue(status, created_at);
```

### 4.2 Mailbox tables (ordering and exactly-once)

```sql
CREATE TABLE mailboxes (
  mailbox_id    INTEGER PRIMARY KEY,
  target_kind   TEXT NOT NULL CHECK (target_kind IN
                  ('task','role','role-runtime','global-role-runtime','operator')),
  task_id       TEXT,
  role_name     TEXT,
  next_sequence INTEGER NOT NULL,
  processing    TEXT,                       -- JSON ProcessingBatch or NULL
  pending       TEXT,                       -- JSON PendingBatch or NULL
  UNIQUE (target_kind, task_id, role_name)
);

-- Signals are the durable append log; (mailbox, sequence) is the exactly-once key.
CREATE TABLE mailbox_signals (
  mailbox_id   INTEGER NOT NULL,
  sequence     INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  ref_type     TEXT,
  ref_task_id  TEXT,
  ref_id       TEXT,
  occurred_at  TEXT NOT NULL,
  request_id   TEXT NOT NULL,               -- idempotency key
  PRIMARY KEY (mailbox_id, sequence),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(mailbox_id)
);
```

Enqueue is one transaction: insert the signal with
`sequence = (SELECT next_sequence FROM mailboxes …)` and increment
`next_sequence` on the same row. The single-writer connection serializes
concurrent enqueues, so sequences stay gapless per mailbox. Claim/settle
updates `processing`/`pending` in the same transaction as the state change
that consumes the batch, preserving today's atomicity.

### 4.3 Task-partitioned tables

```sql
CREATE TABLE task_records (
  task_id     TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,                -- Task record (versioned)
  brief       TEXT,                         -- TaskBrief JSON or NULL
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks_catalog(task_id)
);

CREATE TABLE task_roles (
  task_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name)
);

CREATE TABLE role_session_sets (
  task_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name)
);

CREATE TABLE work_items (
  task_id     TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, work_item_id)
);
CREATE INDEX idx_work_items_status ON work_items(task_id, status);

CREATE TABLE work_item_candidates (
  task_id      TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, candidate_id)
);

CREATE TABLE agent_runs (
  task_id    TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  role_name  TEXT NOT NULL,
  status     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, run_id)
);
CREATE INDEX idx_agent_runs_role_status ON agent_runs(task_id, role_name, status);

-- Active-run pointers (getActiveAgentRun / execution-lane runs).
CREATE TABLE active_runs (
  task_id    TEXT NOT NULL,
  pointer    TEXT NOT NULL,                 -- role name or lane key
  run_id     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, pointer)
);

CREATE TABLE review_rounds (
  task_id        TEXT NOT NULL,
  review_round_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  payload        TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, review_round_id)
);

CREATE TABLE change_sets (
  task_id      TEXT NOT NULL,
  change_set_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  head_sha     TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, change_set_id)
);
CREATE INDEX idx_change_sets_project ON change_sets(task_id, project_id);

CREATE TABLE integration_attempts (
  task_id        TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  payload        TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, integration_id)
);

CREATE TABLE messages (
  task_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,              -- insertion order within task
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, message_id)
);
CREATE INDEX idx_messages_seq ON messages(task_id, seq);

CREATE TABLE input_requests (
  task_id       TEXT NOT NULL,
  input_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  blocks        TEXT,                       -- JSON blocker refs
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, input_id)
);
CREATE INDEX idx_input_open ON input_requests(task_id, status) WHERE status <> 'resolved';

CREATE TABLE decisions (
  task_id     TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, decision_id)
);

CREATE TABLE milestones (
  task_id      TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, milestone_id)
);

-- Terminal/semantic events: retained individually, never pruned.
CREATE TABLE events (
  task_id    TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (task_id, event_id)
);
CREATE INDEX idx_events_type_time ON events(task_id, type, occurred_at);

-- Per-task scheduler projections (today: leaderFailure, operatorNotification).
CREATE TABLE task_projections (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('leader-failure','operator-notification')),
  payload    TEXT,                          -- NULL clears the projection
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, kind)
);
```

### 4.4 Telemetry (bounded, latest-per-key)

High-frequency `runtime.provider-turn-progress` events do **not** go to
`events`. They go to a telemetry table that keeps only the latest row per
`(task_id, role_name, run_id, generation, progress_id)` key:

```sql
CREATE TABLE telemetry (
  task_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  generation  TEXT NOT NULL,                -- launch/session generation
  progress_id TEXT NOT NULL,
  sequence    INTEGER,
  payload     TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name, run_id, generation, progress_id)
) WITHOUT ROWID;
CREATE INDEX idx_telemetry_run ON telemetry(task_id, run_id);
```

Upsert (`INSERT … ON CONFLICT DO UPDATE`) keeps the newest sequence per key.
Retention is bounded by a prune that runs in the persistence worker:

- For a finished/terminal run: keep the latest N (default 200) progress rows
  per `(task, role, run, generation)` and drop older ones.
- For an active run: keep all rows (volume is bounded by run lifetime); a hard
  cap (default 50k rows per run) trims oldest beyond it.
- Terminal and semantic events (lifecycle, receipt, fence, CAS) always go to
  `events` and are never pruned. Evidence is archived/compressed, never deleted.

The prune is a transactional `DELETE` scoped by `task_id`; it never rewrites
global rows or other tasks.

## 5. Cross-task consistency

### 5.1 Project locks

`coordination_locks` replaces any in-process lock map. Acquire/release are
conditional SQL (`INSERT … WHERE NOT EXISTS` / `DELETE … WHERE holder_ref = ?`)
inside a transaction, so cross-task lock state is durable and crash-safe.
Expired locks (`expires_at < now`) are reclaimable with a compare on the holder.

### 5.2 Integration queue

`integration_queue` is the durable outbox for cross-task integration work.
State transitions are conditional updates (`WHERE status = ?`) so two tasks (or
a task and the operator) cannot both start the same integration. The queue is
also the replay source after a controller crash.

### 5.3 Identity and CAS

- Global record IDs (`nextProjectId`, `nextTaskId`, …) come from a
  `global_sequences` counter updated atomically (`UPDATE … SET high_water =
  high_water + 1 RETURNING high_water`).
- Task record IDs use `id_sequences` (§4.1), preserving `TASK_RECORD_ID_PREFIXES`
  and per-task ordering.
- The global `revision` in `home_meta` is the cross-writer CAS, checked inside
  every write transaction. CLI writers and the controller share it exactly as
  they share `state.json` revision today.

### 5.4 Outbox and exactly-once

Every write transaction that must survive a worker crash is recorded in the
same transaction as an `outbox` row (request id, command batch, state). The
main thread's idempotency key is the outbox key. On worker restart, unacked
outbox rows are replayed; duplicate application is prevented by the
`UNIQUE(request_id)` constraint on the effects tables (or by the outbox's own
`applied` flag checked in the same transaction). This gives exactly-once
terminal semantics without a two-phase commit.

## 6. Replaceable Store interface

`TaskStore` (storage/taskStore.ts) is already the seam. The transition adds:

```ts
// New async counterpart; the worker boundary is async.
export interface AsyncTaskStore {
  transactionAsync<T>(commands: StoreCommand[]): Promise<T>;
  getConfig(): Promise<YuiConfig>;
  // ...mirrors TaskStore, all async...
}

export type StoreCommand =
  | { op: 'saveMessage'; taskId: string; message: TaskMessage }
  | { op: 'nextMessageId'; taskId: string }
  // ...one variant per mutating/reading op needed inside batches...
  ;

export type TaskStoreBackend = 'file' | 'sqlite';

export function openTaskStore(
  home: string,
  backend: TaskStoreBackend,
  options?: TaskStoreOptions
): TaskStore;                 // file: FileTaskStore; sqlite: in-process SqliteTaskStore

export function openAsyncTaskStoreClient(
  home: string,
  options?: RpcOptions
): AsyncTaskStore;            // worker-backed; used by the controller runtime
```

Phasing:

1. **SqliteTaskStore (in-process)** implements the synchronous `TaskStore`
   against `better-sqlite3`. This removes the full-document rewrite and whole
   JSON parse/stringify immediately, behind `YUI_STORE_BACKEND=sqlite`
   (default stays `file`). All existing tests run against both backends.
2. **Worker-backed AsyncTaskStoreClient** moves the connection into the
   persistence worker. Controller command handlers are already async
   (`dispatcher` returns promises); they are migrated from `TaskStore` to
   `AsyncTaskStoreStore` call site by call site. The in-process
   `SqliteTaskStore` remains for CLI tools and tests.
3. **Resource inventory worker** (§3.3) lands alongside step 2.

The file store is not removed in this task; rollback to it is a config flip.

## 7. Single database first; sharding criteria

One database (`yui.db`, WAL) per Home. Physical sharding of terminal history
is deferred until a measurement crosses a threshold, using the work-item-1
baseline and post-implementation benchmarks:

- Database size exceeds ~2 GB, or
- Write transaction p99 exceeds the control-command latency budget (target:
  p99 socket command under load ≤ 50 ms; threshold: baseline p99 not improved
  by ≥ 5×), or
- WAL checkpoint stalls appear in event-loop-delay measurements of the
  persistence worker.

When triggered, terminal `events` and `telemetry` rows for archived tasks move
to per-task shard files (`shards/<task_id>.db`), attached read-only for
historical queries. The catalog and all active-task rows stay in the primary
database. Sharding is an offline maintenance operation, not a runtime path.

## 8. Migration from state.json

### 8.1 Axis placement

The move is a **layout-axis offline migration** (layout 6 → 7): the on-disk
layout changes from `{schema.json, state.json, locks}` to
`{schema.json, state.json (retained as rollback source), yui.db, yui.db-wal,
yui.db-shm, locks}`. The aggregate document is retired as the live store but
its content is the migration source. Record-family versions are preserved
inside `payload` columns, so the record axis is unchanged at migration time.

It is declared `offline-migration` (never `compatible`): layout changes are
never compatible, and identity/reference meaning changes (document → rows).

### 8.2 Staged, repeatable, verifiable

`yui update` preflight and `yui upgrade` run the same orchestration:

1. **Snapshot**: read `state.json` once (read-only), parse, validate against
   the current aggregate version. The real Home is not modified.
2. **Stage into a sidecar**: create `yui.db.staged` in the Home, run the full
   migration in one transaction per record family (or one large transaction
   with per-family checkpoints), computing a per-family checksum
   (count + content hash) as it goes.
3. **Verify**: independently re-read `state.json` and compare per-family
   checksums and a sample of full-record hashes against the staged database.
   Any mismatch aborts; `state.json` is untouched.
4. **Commit**: atomically swap `yui.db.staged` → `yui.db` (rename under the
   storage lock), then advance `schema.json` to layout 7 in the same critical
   section as today's manifest writes. A crash before the swap leaves a valid
   layout-6 Home; a crash after the swap leaves a valid layout-7 Home (the
   next open detects the db and proceeds).
5. **Rollback**: `state.json` is retained (read-only) until the operator
   confirms the new layout (or for one release cycle). Rollback flips
   `schema.json` back to layout 6 and quarantines `yui.db`. No healthy Session
   is reset and no historical evidence is deleted: rollback only changes which
   store is live.

The migration is **repeatable**: an interrupted staged run reuses or rebuilds
`yui.db.staged` idempotently (the sidecar is disposable until the swap).

### 8.3 Classification integration

`doctor`, staged `update` preflight, ordinary store open, and `upgrade` keep
the four-state vocabulary:

- **current (USABLE)**: layout 7, db openable, migrations applied.
- **compatible-old (COMPATIBLE)**: not applicable to a layout change; the
  layout 6 → 7 step is always offline.
- **migration-required (MIGRATABLE)**: layout 6 with a healthy `state.json`;
  the migration path is registered and runnable.
- **unsupported (NEEDS_NEW_VERSION / CORRUPTED)**: unknown layout, failed
  checksum verification, or a damaged db.

The existing registry/planner/engine gains one adjacent layout step
(`6 → 7`) whose `MigrationTarget` is the SQLite writer. Per-family record
versions continue to flow through the record axis unchanged.

### 8.4 Invariants

- Migration failure never overwrites `state.json` (the writer opens it
  read-only; the swap only renames the sidecar).
- Upgrade and rollback do not reset healthy Sessions: Session ownership lives
  in `managed_workspaces`/`role_session_sets` rows migrated verbatim, and
  rollback reads them back from `state.json`.
- Evidence (events, review rounds, change sets, integration attempts) is
  migrated row-for-record and retained; terminal history is never deleted.

## 9. Semantic preservation checklist

| Existing invariant | SQLite realization |
| --- | --- |
| Process write lock | Single writer connection + `BEGIN IMMEDIATE`; `busy_timeout` for CLI contention |
| Revision CAS | `home_meta.revision` checked/incremented in-tx; conflict → `StorageConflictError` |
| Atomic durable write | WAL + `synchronous=FULL`; transaction commit = fsync |
| Mailbox per-target ordering | `mailboxes.next_sequence` + `mailbox_signals (target, sequence)` PK |
| Exactly-once terminal state | Conditional `UPDATE … WHERE status <> terminal`; unique event/request IDs |
| Crash recovery | WAL rollback of uncommitted txns; outbox replay of unacked committed effects |
| Read cache (fingerprint) | Not needed: reads are indexed SQL; read pool never blocks writer |
| Record family versioning | `payload` JSON keeps family `schemaVersion`; record axis unchanged |
| Upgrade fence (`assertHomeWritable`) | Same fence checked at the worker's write-transaction boundary |
| Evidence retention | `events`/`review_rounds`/`change_sets`/`integration_attempts` never pruned |

## 10. DDL validation

All SQL blocks in §4 were executed against SQLite (Python `sqlite3` module,
SQLite 3.x, in-memory database) on 2026-08-15 as part of Leader review:

```sh
python3 - <<'PY'
import re, sqlite3
doc = open('docs/sqlite-control-plane-design.md').read()
blocks = re.findall(r'```sql\n(.*?)```', doc, re.S)
conn = sqlite3.connect(':memory:')
for sql in blocks:
    lines = [ln for ln in sql.split('\n') if not ln.strip().startswith('--')]
    for stmt in [s.strip() for s in '\n'.join(lines).split(';') if s.strip()]:
        conn.execute(stmt)
print(sorted(r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")))
PY
```

Result: all 31 tables (`active_runs`, `agent_profiles`, `agent_runs`,
`change_sets`, `configured_agents`, `coordination_locks`, `decisions`, `events`,
`global_role_session_sets`, `global_roles`, `home_meta`, `id_sequences`,
`input_requests`, `integration_attempts`, `integration_queue`, `mailboxes`,
`mailbox_signals`, `managed_workspaces`, `messages`, `milestones`, `projects`,
`review_rounds`, `role_session_sets`, `schema_migrations`, `task_projections`,
`task_records`, `task_roles`, `tasks_catalog`, `telemetry`,
`work_item_candidates`, `work_items`) created with zero errors.

Note for implementation: `mailbox_signals.target_rowid` references
`rowid(mailboxes)`; SQLite accepts the parent-key reference, but the
implementation must verify FK enforcement (`PRAGMA foreign_keys = ON`) and
prefer an explicit `mailboxes.id INTEGER PRIMARY KEY` parent column if any
SQLite build rejects the rowid reference.

## 11. Open questions for implementation WorkItems

1. Exact `StoreCommand` variant set — derive from the closures actually used in
   `controller.ts` and the scheduler; keep the variant surface minimal.
2. Read-pool size and WAL checkpoint tuning — set from the work-item-1
   baseline and the post-implementation benchmark.
3. Telemetry retention constants (200/50k) — confirm against real run lengths
   in the baseline data.
4. Whether `state.json` rollback retention is one release cycle or
   operator-confirmed; default to operator-confirmed, never auto-deleted.
