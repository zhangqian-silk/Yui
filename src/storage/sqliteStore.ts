/**
 * SQLite WAL Store (task-21, work-item-3).
 *
 * A `TaskStore` implementation backed by a single SQLite WAL database
 * (`yui.db`), replacing the aggregate `state.json` read/parse/validate/write
 * cycle. It implements the replaceable-Store seam from the design (§6) and the
 * semantic-preservation checklist (§9):
 *
 *   - Process write lock .......... single writer connection + BEGIN IMMEDIATE;
 *                                    busy_timeout absorbs CLI contention.
 *   - Revision CAS ................ home_meta.revision checked/incremented in
 *                                    the write transaction; conflict ->
 *                                    StorageConflictError (transactionWithRevisionCas).
 *   - Atomic durable write ........ WAL + synchronous=FULL; COMMIT == fsync.
 *   - Mailbox per-target ordering . mailboxes.next_sequence + mailbox_signals
 *                                    (mailbox_id, sequence) primary key.
 *   - Exactly-once terminal state . conditional updates + UNIQUE(request_id)
 *                                    on outbox / mailbox_signals.
 *   - Crash recovery .............. WAL rollback of uncommitted transactions;
 *                                    outbox replay of committed-but-unacked effects.
 *   - Record family versioning .... full record (incl. schemaVersion) in payload.
 *   - Upgrade fence ............... assertHomeWritable at the write boundary.
 *   - Evidence retention .......... events/review_rounds/change_sets/
 *                                    integration_attempts are never pruned.
 *
 * Records are stored as full versioned JSON in `payload` columns, with typed
 * columns for the fields that are queried/filtered/used-for-CAS (§4). A
 * high-frequency `runtime.provider-turn-progress` event is a single-row
 * upsert into `telemetry` scoped by its primary key — it never rewrites global
 * state and never touches another Task's rows (§4.4).
 *
 * The in-process store is phase 1 of §6. It does not re-run the heavy record
 * validators on write (the domain layer that constructs records already does,
 * and the design places record validation in the persistence worker, phase 2);
 * it performs the same cheap structural checks the file store relies on
 * (identity presence, taskId matching, referential lookups).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import type { ConfiguredAgent } from "../agent/agent.js";
import type { TaskBrief } from "../brief/taskBrief.js";
import type { MailboxEntityRef, MailboxTarget, WorkMailbox } from "../coordination/workMailbox.js";
import { mailboxTargetKey } from "../coordination/workMailbox.js";
import type { Decision } from "../decision/decision.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { GlobalRoleSessionSet, RoleAgentSession, TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { TaskMessage } from "../message/message.js";
import type { Milestone } from "../milestone/milestone.js";
import type { AgentRun } from "../run/agentRun.js";
import type { PendingProviderRetry } from "../run/providerRetry.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { Project } from "../repository/project.js";
import { generateHomeIdentity, type HomeIdentity } from "../repository/homeIdentity.js";
import type { AgentProfile } from "../profile/agentProfile.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import {
  validateIntegrationQueueEntry,
  type IntegrationQueueEntry,
  type IntegrationQueueStatus
} from "../integration/integrationQueueEntry.js";
import {
  validDurableJobTransition,
  validateDurableJob,
  type DurableJob
} from "../job/durableJob.js";
import type { GlobalRole, TaskRole } from "../role/role.js";
import type { LeaderFailure } from "../scheduler/leaderFailure.js";
import type { OperatorNotification } from "../scheduler/operatorNotification.js";
import type { PendingWakeup } from "../scheduler/pendingWakeup.js";
import type { Task } from "../task/task.js";
import { TASK_RECORD_ID_PREFIXES, type TaskRecordKind } from "../task/taskRecordReference.js";
import type { WorkItem } from "../workItem/workItem.js";
import { managedWorkspaceKey, type ManagedWorkspace, type ManagedWorkspaceOwner } from "../worktree/managedWorkspace.js";
import { assertHomeWritable } from "./upgradeFence.js";
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_PENDING_WAKEUP_SCHEMA_VERSION,
  CURRENT_WORK_MAILBOX_SCHEMA_VERSION,
  executionLaneActiveRunKey,
  StorageConflictError,
  StorageCancelledError,
  StorageRecordError,
  FileTaskStore,
  storedCapabilityGrant,
  storedReleaseWorkflow,
  isValidCapabilityGrantTransition,
  isValidReleaseWorkflowTransition,
  type ConfiguredAgentPatch,
  type ConfiguredAgentUpdateResult,
  type TaskStore,
  type YuiConfig
} from "./taskStore.js";
import type { CapabilityGrant } from "../grant/capabilityGrant.js";
import type { ReleaseWorkflow } from "../release/releaseWorkflow.js";
import {
  migrateSqliteSchema,
  SQLITE_AGGREGATE_VERSION,
  SQLITE_LAYOUT_VERSION,
  TELEMETRY_KEEP_PER_GENERATION,
  TELEMETRY_RUN_CAP
} from "./sqliteSchema.js";
import { inspectStorageSchema } from "./storageSchema.js";

/** Options for {@link SqliteTaskStore}. */
export type SqliteTaskStoreOptions = Readonly<{
  /** Override the database filename (defaults to "yui.db"). */
  databaseFilename?: string;
  /**
   * Migration bulk-load mode. The staged state.json→SQLite migration populates
   * the sidecar database while the upgrade fence is active (the migration IS
   * the upgrade), so the per-write fence admission check is skipped. Production
   * stores never set this.
   */
  migration?: boolean;
}>;

/** Options for {@link SqliteTaskStore.transaction}. */
export type SqliteTransactionOptions = Readonly<{
  /**
   * Idempotency key. When set, an `outbox` row is written in the same
   * transaction as the state change. A duplicate `requestId` fails the
   * transaction with {@link StorageConflictError} (exactly-once).
   */
  requestId?: string;
  /** Opaque command payload recorded alongside the outbox row. */
  outboxCommand?: unknown;
}>;

/** A single telemetry progress row (§4.4). */
export type TelemetryProgress = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  generation: string;
  progressId: string;
  sequence?: number;
  payload: unknown;
  receivedAt: string;
}>;

const DEFAULT_CONFIG: YuiConfig = { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION };

function numericCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

/** True when the better-sqlite3 error is a UNIQUE/PRIMARY KEY constraint failure. */
function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    || (error as { code?: string })?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** Project a leader-role work mailbox's pending batch to a PendingWakeup (mirrors taskStore.ts). */
function pendingWakeupProjection(mailbox: WorkMailbox | null): PendingWakeup | null {
  if (mailbox === null || mailbox.target.kind !== "role" || mailbox.target.roleName !== "leader"
    || mailbox.pending === null) {
    return null;
  }
  return {
    schemaVersion: CURRENT_PENDING_WAKEUP_SCHEMA_VERSION,
    taskId: mailbox.target.taskId,
    reasons: [...mailbox.pending.reasons],
    requestCount: mailbox.pending.requestCount,
    firstRequestedAt: mailbox.pending.firstQueuedAt,
    lastRequestedAt: mailbox.pending.lastQueuedAt
  };
}

export class SqliteTaskStore implements TaskStore {
  readonly #db: Database.Database;
  readonly #rootDir: string;
  readonly #migration: boolean;
  #inTransaction = false;
  #dirty = false;

  constructor(rootDir: string, _options: SqliteTaskStoreOptions = {}) {
    this.#rootDir = rootDir;
    this.#migration = _options.migration ?? false;
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const filename = _options.databaseFilename ?? "yui.db";
    this.#db = new Database(join(rootDir, filename));
    // §4.1 / §9: WAL, no fsync weakening, FKs on, busy timeout for CLI contention.
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("busy_timeout = 5000");
    this.#db.pragma("wal_autocheckpoint = 1000");
    migrateSqliteSchema(this.#db);
    this.#seedHomeMeta();
    this.#seedConfig();
  }

  rootDirectory(): string { return this.#rootDir; }

  /** Close the underlying database connection. */
  close(): void { this.#db.close(); }

  /**
   * The underlying database connection, for read-only diagnostics
   * (`PRAGMA journal_mode`, `PRAGMA quick_check`). Callers must not mutate
   * through this handle.
   */
  databaseHandle(): Database.Database { return this.#db; }

  // -- transaction primitives -------------------------------------------------

  #seedHomeMeta(): void {
    const now = new Date().toISOString();
    const identity = generateHomeIdentity(new Date());
    this.#db.prepare(
      `INSERT OR IGNORE INTO home_meta (id, home_identity, revision, layout_version, aggregate_version, created_at, updated_at)
       VALUES (1, ?, 0, ?, ?, ?, ?)`
    ).run(JSON.stringify(identity), SQLITE_LAYOUT_VERSION, SQLITE_AGGREGATE_VERSION, now, now);
  }

  #seedConfig(): void {
    this.#db.prepare(
      `INSERT OR IGNORE INTO config (id, payload, updated_at) VALUES (1, ?, ?)`
    ).run(JSON.stringify(DEFAULT_CONFIG), new Date().toISOString());
  }

  #now(): string { return new Date().toISOString(); }
  #json(value: unknown): string { return JSON.stringify(value); }
  #parse<T>(text: string): T { return JSON.parse(text) as T; }

  #begin(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    this.#inTransaction = true;
    this.#dirty = false;
  }

  #commit(): void {
    this.#db.exec("COMMIT");
    this.#inTransaction = false;
    this.#dirty = false;
  }

  #rollback(): void {
    try { this.#db.exec("ROLLBACK"); } catch { /* already closed */ }
    this.#inTransaction = false;
    this.#dirty = false;
  }

  /** The upgrade-admission fence, honored at the single write moment (§9). */
  #prepareWrite(): void {
    // The staged migration populates the sidecar database while the upgrade
    // fence is active (the migration IS the upgrade), so it bypasses the
    // per-write admission check. Production stores never set migration mode.
    if (this.#migration) return;
    assertHomeWritable(this.#rootDir);
  }

  #bumpRevision(): void {
    this.#db.prepare("UPDATE home_meta SET revision = revision + 1, updated_at = ? WHERE id = 1").run(this.#now());
  }

  /**
   * Run a mutating closure. Inside an outer {@link transaction} it joins that
   * transaction (single revision bump at the outer commit); standalone it takes
   * the write lock, checks the fence, bumps the revision, and commits.
   */
  #mutate<T>(fn: () => T): T {
    if (this.#inTransaction) {
      const result = fn();
      this.#dirty = true;
      return result;
    }
    this.#prepareWrite();
    this.#begin();
    try {
      const result = fn();
      if (!this.#migration) {
        this.#bumpRevision();
      }
      this.#commit();
      return result;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  /**
   * The file-store's `transaction(closure)`: a single BEGIN IMMEDIATE … COMMIT.
   * Nested calls join the outer transaction. The revision is bumped once, at
   * commit, only when the closure wrote.
   */
  transaction<T>(execute: (store: SqliteTaskStore) => T, options?: SqliteTransactionOptions): T;
  transaction<T>(execute: (store: TaskStore) => T, options?: SqliteTransactionOptions): T;
  transaction<T>(
    execute: ((store: SqliteTaskStore) => T) | ((store: TaskStore) => T),
    options?: SqliteTransactionOptions
  ): T {
    const run = execute as (store: SqliteTaskStore) => T;
    if (this.#inTransaction) return run(this);
    this.#begin();
    try {
      const result = run(this);
      if (this.#dirty) {
        this.#prepareWrite();
        if (options?.requestId !== undefined) {
          this.#insertOutbox(options.requestId, options.outboxCommand ?? null);
        }
        // The staged migration sets the revision explicitly via
        // migrationSetHomeMeta; the commit must not bump it.
        if (!this.#migration) {
          this.#bumpRevision();
        }
      }
      this.#commit();
      return result;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  /** Async transaction seam used by queue operations that must inspect Git
   * before committing the durable queue state. The SQLite write transaction
   * remains open across the awaited callback, matching FileTaskStore's
   * transactionAsync semantics and preserving the single-writer boundary. */
  async transactionAsync<T>(execute: (store: TaskStore) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return execute(this);
    this.#prepareWrite();
    this.#begin();
    try {
      const result = await execute(this);
      if (this.#dirty) this.#bumpRevision();
      this.#commit();
      return result;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  /** Bounded runtime-event folds share the same SQLite write transaction. */
  withRuntimeEventTransaction<T>(execute: () => T): T {
    return this.transaction(() => execute());
  }

  /**
   * Revision CAS (§5.3): run `execute` only when the global revision is still
   * `expectedRevision`; otherwise throw {@link StorageConflictError}. The check
   * and the increment happen in the same write transaction.
   */
  transactionWithRevisionCas<T>(expectedRevision: number, execute: (store: SqliteTaskStore) => T, options?: SqliteTransactionOptions): T {
    if (this.#inTransaction) return execute(this);
    this.#begin();
    try {
      const current = this.getRevision();
      if (current !== expectedRevision) {
        throw new StorageConflictError(
          `Storage revision conflict (expected ${expectedRevision}, found ${current}).`
        );
      }
      const result = execute(this);
      if (this.#dirty) {
        this.#prepareWrite();
        if (options?.requestId !== undefined) {
          this.#insertOutbox(options.requestId, options.outboxCommand ?? null);
        }
        // The staged migration sets the revision explicitly via
        // migrationSetHomeMeta; the commit must not bump it.
        if (!this.#migration) {
          this.#bumpRevision();
        }
      }
      this.#commit();
      return result;
    } catch (error) {
      this.#rollback();
      if (error instanceof StorageConflictError) throw error;
      throw error;
    }
  }

  /** The current global revision (the cross-writer CAS token). */
  getRevision(): number {
    const row = this.#db.prepare("SELECT revision FROM home_meta WHERE id = 1").get() as { revision: number };
    return row.revision;
  }

  getStateRevision(): number { return this.getRevision(); }

  /**
   * Run an ordered command batch inside one `BEGIN IMMEDIATE … COMMIT`, yielding
   * to the event loop between commands so a cancellation signal can interrupt
   * the batch (§3.1). The persistence worker uses this for `transactionAsync`:
   * a cancelled batch rolls back (the db is unchanged); already-committed
   * batches are not undone (their effects are idempotent and caller-owned).
   *
   * Each command is `{op, args}` where `op` is a `TaskStore` method name. The
   * batch runs on the single writer connection, so writes are serialized exactly
   * as the synchronous {@link transaction} (§3.2). The revision is bumped once
   * at commit when the batch wrote; an optional `requestId` records the effect
   * in the durable outbox for exactly-once replay (§5.4).
   */
  async transactionAsyncBatch(
    commands: ReadonlyArray<{ op: string; args: readonly unknown[] }>,
    options: SqliteTransactionOptions & {
      shouldCancel?: () => boolean;
      expectedRevision?: number;
    } = {}
  ): Promise<unknown[]> {
    if (this.#inTransaction) {
      // Nested inside a synchronous transaction: run without yielding (the
      // caller already holds the write lock).
      return commands.map((command) => this.#executeCommand(command.op, command.args));
    }
    this.#begin();
    try {
      // Revision CAS (§5.3): the check and the increment happen in the same
      // write transaction, exactly as transactionWithRevisionCas.
      if (options.expectedRevision !== undefined) {
        const current = this.getRevision();
        if (current !== options.expectedRevision) {
          throw new StorageConflictError(
            `Storage revision conflict (expected ${options.expectedRevision}, found ${current}).`
          );
        }
      }
      const results: unknown[] = [];
      for (const command of commands) {
        if (options.shouldCancel?.() === true) {
          throw new StorageCancelledError(
            `Storage command batch cancelled before op '${command.op}'.`
          );
        }
        results.push(this.#executeCommand(command.op, command.args));
        // Yield so the worker's message loop can observe a cancel signal
        // between statements (§3.1). A single-command batch still yields once
        // so a cancel that raced the batch start is honoured before commit.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (options.shouldCancel?.() === true) {
        throw new StorageCancelledError("Storage command batch cancelled before commit.");
      }
      if (this.#dirty) {
        this.#prepareWrite();
        if (options.requestId !== undefined) {
          this.#insertOutbox(options.requestId, options.outboxCommand ?? commands);
        }
        if (!this.#migration) {
          this.#bumpRevision();
        }
      }
      this.#commit();
      return results;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  /** Invoke a TaskStore method by name (used by the worker's command batches). */
  #executeCommand(op: string, args: readonly unknown[]): unknown {
    const method = (this as unknown as Record<string, (...callArgs: unknown[]) => unknown>)[op];
    if (typeof method !== "function") {
      throw new StorageRecordError(`Unknown store command: ${op}`);
    }
    return method.apply(this, args as unknown[]);
  }

  // -- outbox (§5.4) ----------------------------------------------------------

  #insertOutbox(requestId: string, command: unknown): void {
    try {
      this.#db.prepare(
        `INSERT INTO outbox (request_id, command, state, created_at) VALUES (?, ?, 'pending', ?)`
      ).run(requestId, this.#json(command), this.#now());
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new StorageConflictError(`Outbox request already applied: ${requestId}`);
      }
      throw error;
    }
  }

  /**
   * Enqueue an outbox row idempotently. Returns true when a new row was
   * inserted, false when `requestId` was already present (exactly-once).
   */
  enqueueOutbox(requestId: string, command: unknown): boolean {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        `INSERT OR IGNORE INTO outbox (request_id, command, state, created_at) VALUES (?, ?, 'pending', ?)`
      ).run(requestId, this.#json(command), this.#now());
      return result.changes > 0;
    });
  }

  /** Outbox rows still awaiting acknowledgement (the replay source after a crash). */
  listPendingOutbox(): ReadonlyArray<{ requestId: string; command: unknown; createdAt: string }> {
    const rows = this.#db.prepare(
      "SELECT request_id, command, created_at FROM outbox WHERE state = 'pending' ORDER BY outbox_id"
    ).all() as Array<{ request_id: string; command: string; created_at: string }>;
    return rows.map((row) => ({
      requestId: row.request_id,
      command: this.#parse(row.command),
      createdAt: row.created_at
    }));
  }

  /**
   * True when an outbox row already exists for `requestId` (the effect committed).
   * The persistence worker consults this before re-executing a retried write so a
   * main-thread retry after a worker restart never double-applies (§3.1, §5.4).
   */
  hasOutboxEntry(requestId: string): boolean {
    const row = this.#db.prepare(
      "SELECT 1 FROM outbox WHERE request_id = ?"
    ).get(requestId);
    return row !== undefined;
  }

  /** Mark an outbox row as applied (idempotent). */
  markOutboxApplied(requestId: string): void {
    this.#mutate(() => {
      this.#db.prepare(
        "UPDATE outbox SET state = 'applied', applied_at = ? WHERE request_id = ?"
      ).run(this.#now(), requestId);
    });
  }

  // -- ID allocation ----------------------------------------------------------

  /**
   * Global IDs (`task-<n>`, `project-<n>`) from `global_sequences` (§5.3). The
   * file store computes these by scanning existing IDs (a read); the counter is
   * the design's replacement and is allocated without bumping the revision.
   */
  #nextGlobalId(name: string): string {
    const allocate = this.#db.transaction((): string => {
      const row = this.#db.prepare(
        `INSERT INTO global_sequences (name, high_water) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET high_water = high_water + 1
         RETURNING high_water`
      ).get(name) as { high_water: number };
      return `${name}-${row.high_water}`;
    });
    return allocate();
  }

  /**
   * Task-record IDs from `id_sequences` (replaces StoredTask.idHighWaterMarks).
   * Allocating a high-water mark is a durable write, so it bumps the revision
   * exactly as the file store does.
   */
  #nextTaskRecordId(taskId: string, kind: TaskRecordKind): string {
    this.#requireTask(taskId);
    return this.#mutate(() => {
      const row = this.#db.prepare(
        `INSERT INTO id_sequences (task_id, kind, high_water) VALUES (?, ?, 1)
         ON CONFLICT(task_id, kind) DO UPDATE SET high_water = high_water + 1
         RETURNING high_water`
      ).get(taskId, kind) as { high_water: number };
      return `${TASK_RECORD_ID_PREFIXES[kind]}-${row.high_water}`;
    });
  }

  #peekTaskRecordId(taskId: string, kind: TaskRecordKind): string {
    this.#requireTask(taskId);
    const row = this.#db.prepare(
      "SELECT high_water FROM id_sequences WHERE task_id = ? AND kind = ?"
    ).get(taskId, kind) as { high_water: number } | undefined;
    return `${TASK_RECORD_ID_PREFIXES[kind]}-${(row?.high_water ?? 0) + 1}`;
  }

  #requireTask(taskId: string): void {
    const row = this.#db.prepare("SELECT 1 FROM task_records WHERE task_id = ?").get(taskId);
    if (row === undefined) throw new StorageRecordError(`Task not found: ${taskId}`);
  }

  // -- migration bulk-load helpers (state.json -> SQLite, task-21 §8) ----------
  // These are used only by the staged offline migration, which runs with the
  // `migration` option (fence bypass). They seed infrastructure tables that the
  // document owns (home identity/revision, global and per-task ID high-water
  // marks) so the opened store continues from the same counters.

  /** Preserve the document's Home identity and revision in `home_meta`. */
  migrationSetHomeMeta(identity: HomeIdentity, revision: number): void {
    this.#mutate(() => {
      this.#db.prepare(
        `UPDATE home_meta SET home_identity = ?, revision = ?, updated_at = ? WHERE id = 1`
      ).run(this.#json(identity), revision, this.#now());
    });
  }

  /** Seed a global ID high-water mark (task/project) at least `highWater`. */
  migrationSeedGlobalSequence(name: string, highWater: number): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO global_sequences (name, high_water) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET high_water = MAX(high_water, ?)`
      ).run(name, highWater, highWater);
    });
  }

  /** Seed a per-task ID high-water mark at least `highWater`. */
  migrationSeedIdSequence(taskId: string, kind: string, highWater: number): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO id_sequences (task_id, kind, high_water) VALUES (?, ?, ?)
         ON CONFLICT(task_id, kind) DO UPDATE SET high_water = MAX(high_water, ?)`
      ).run(taskId, kind, highWater, highWater);
    });
  }

  // -- generic payload helpers ------------------------------------------------

  #getPayload<T>(table: string, where: string, params: readonly unknown[]): T | null {
    const row = this.#db.prepare(`SELECT payload FROM ${table} WHERE ${where}`).get(...params) as { payload: string } | undefined;
    return row === undefined ? null : this.#parse<T>(row.payload);
  }

  #listPayload<T>(table: string, where: string, params: readonly unknown[]): T[] {
    const rows = this.#db.prepare(`SELECT payload FROM ${table} WHERE ${where}`).all(...params) as Array<{ payload: string }>;
    return rows.map((row) => this.#parse<T>(row.payload));
  }

  #sortById<T>(rows: T[], idOf: (row: T) => string): T[] {
    return [...rows].sort((left, right) => numericCompare(idOf(left), idOf(right)));
  }

  // -- config / identity ------------------------------------------------------

  getConfig(): YuiConfig {
    const row = this.#db.prepare("SELECT payload FROM config WHERE id = 1").get() as { payload: string };
    return this.#parse<YuiConfig>(row.payload);
  }

  saveConfig(config: YuiConfig): void {
    this.#mutate(() => {
      this.#db.prepare(
        "UPDATE config SET payload = ?, updated_at = ? WHERE id = 1"
      ).run(this.#json(config), this.#now());
    });
  }

  getHomeIdentity(): HomeIdentity {
    const row = this.#db.prepare("SELECT home_identity FROM home_meta WHERE id = 1").get() as { home_identity: string };
    return this.#parse<HomeIdentity>(row.home_identity);
  }

  getReviewConfig(): ReviewConfig | null {
    return this.getConfig().review ?? null;
  }

  // -- configured agents ------------------------------------------------------

  saveConfiguredAgent(agent: ConfiguredAgent): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO configured_agents (id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(agent.id, this.#json(agent), this.#now());
    });
  }

  createConfiguredAgentIfAbsent(agent: ConfiguredAgent): ConfiguredAgent | null {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        "INSERT OR IGNORE INTO configured_agents (id, payload, updated_at) VALUES (?, ?, ?)"
      ).run(agent.id, this.#json(agent), this.#now());
      return result.changes > 0 ? agent : null;
    });
  }

  updateConfiguredAgent(id: string, patch: ConfiguredAgentPatch, now: Date): ConfiguredAgentUpdateResult | null {
    return this.transaction((store) => {
      const existing = store.getConfiguredAgent(id);
      if (existing === null) return null;
      const candidate: ConfiguredAgent = { ...existing, ...patch, updatedAt: now.toISOString() };
      const unchanged = isDeepStrictEqual({ ...existing, updatedAt: candidate.updatedAt }, candidate);
      if (unchanged) return { status: "unchanged", agent: existing };
      store.saveConfiguredAgent(candidate);
      return { status: "updated", agent: candidate };
    });
  }

  listConfiguredAgents(): ConfiguredAgent[] {
    return this.#sortById(this.#listPayload<ConfiguredAgent>("configured_agents", "1=1", []), (agent) => agent.id);
  }

  getConfiguredAgent(id: string): ConfiguredAgent | null {
    return this.#getPayload<ConfiguredAgent>("configured_agents", "id = ?", [id]);
  }

  removeConfiguredAgent(id: string): boolean {
    return this.#mutate(() => {
      const result = this.#db.prepare("DELETE FROM configured_agents WHERE id = ?").run(id);
      return result.changes > 0;
    });
  }

  // -- projects ---------------------------------------------------------------

  nextProjectId(): string { return this.#nextGlobalId("project"); }

  saveProject(project: Project): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO projects (id, name, path, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(project.id, project.name, project.path, this.#json(project), project.createdAt, project.updatedAt);
    });
  }

  createProjectIfAbsent(project: Project): Project | null {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        "INSERT OR IGNORE INTO projects (id, name, path, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(project.id, project.name, project.path, this.#json(project), project.createdAt, project.updatedAt);
      return result.changes > 0 ? project : null;
    });
  }

  listProjects(): Project[] {
    return this.#sortById(this.#listPayload<Project>("projects", "1=1", []), (project) => project.id);
  }

  getProject(id: string): Project | null {
    return this.#getPayload<Project>("projects", "id = ?", [id]);
  }

  removeProject(id: string): boolean {
    return this.#mutate(() => this.#db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0);
  }

  // -- agent profiles ---------------------------------------------------------

  saveAgentProfile(profile: AgentProfile): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO agent_profiles (id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(profile.id, this.#json(profile), this.#now());
    });
  }

  createAgentProfileIfAbsent(profile: AgentProfile): AgentProfile | null {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        "INSERT OR IGNORE INTO agent_profiles (id, payload, updated_at) VALUES (?, ?, ?)"
      ).run(profile.id, this.#json(profile), this.#now());
      return result.changes > 0 ? profile : null;
    });
  }

  listAgentProfiles(): AgentProfile[] {
    return this.#sortById(this.#listPayload<AgentProfile>("agent_profiles", "1=1", []), (profile) => profile.id);
  }

  getAgentProfile(id: string): AgentProfile | null {
    return this.#getPayload<AgentProfile>("agent_profiles", "id = ?", [id]);
  }

  removeAgentProfile(id: string): boolean {
    return this.#mutate(() => this.#db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(id).changes > 0);
  }

  // -- global roles -----------------------------------------------------------

  saveGlobalRole(role: GlobalRole): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO global_roles (name, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(role.name, this.#json(role), this.#now());
    });
  }

  saveGlobalRoleWithSessionSet(role: GlobalRole, sessions: GlobalRoleSessionSet | null): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO global_roles (name, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(role.name, this.#json(role), this.#now());
      if (sessions !== null) {
        this.#db.prepare(
          `INSERT INTO global_role_session_sets (name, payload, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
        ).run(role.name, this.#json(sessions), this.#now());
      }
    });
  }

  createGlobalRoleIfAbsent(role: GlobalRole): GlobalRole | null {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        "INSERT OR IGNORE INTO global_roles (name, payload, updated_at) VALUES (?, ?, ?)"
      ).run(role.name, this.#json(role), this.#now());
      return result.changes > 0 ? role : null;
    });
  }

  listGlobalRoles(): GlobalRole[] {
    return this.#sortById(this.#listPayload<GlobalRole>("global_roles", "1=1", []), (role) => role.name);
  }

  getGlobalRole(name: string): GlobalRole | null {
    return this.#getPayload<GlobalRole>("global_roles", "name = ?", [name]);
  }

  removeGlobalRole(name: string): boolean {
    return this.#mutate(() => this.#db.prepare("DELETE FROM global_roles WHERE name = ?").run(name).changes > 0);
  }

  getGlobalRoleSessionSet(name: string): GlobalRoleSessionSet | null {
    return this.#getPayload<GlobalRoleSessionSet>("global_role_session_sets", "name = ?", [name]);
  }

  listGlobalRoleSessionSets(): GlobalRoleSessionSet[] {
    const rows = this.#listPayload<GlobalRoleSessionSet>("global_role_session_sets", "1=1", []);
    return [...rows].sort((left, right) => numericCompare(left.owner.roleName, right.owner.roleName));
  }

  saveGlobalRoleSessionSet(sessions: GlobalRoleSessionSet): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO global_role_session_sets (name, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(sessions.owner.roleName, this.#json(sessions), this.#now());
    });
  }

  // -- tasks ------------------------------------------------------------------

  nextTaskId(): string { return this.#nextGlobalId("task"); }

  saveTask(task: Task): void {
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new StorageRecordError("Task id is required.");
    }
    this.#mutate(() => {
      for (const binding of task.projectBindings) {
        const found = this.#db.prepare("SELECT 1 FROM projects WHERE id = ?").get(binding.projectId);
        if (found === undefined) throw new StorageRecordError(`Task Project not found: ${binding.projectId}`);
      }
      const isActive = task.status === "active" ? 1 : 0;
      // The catalog projection is inserted first because task_records FKs it.
      this.#db.prepare(
        `INSERT INTO tasks_catalog (task_id, status, lifecycle, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, lifecycle = excluded.lifecycle,
           is_active = excluded.is_active, updated_at = excluded.updated_at`
      ).run(task.id, task.status, task.status, isActive, task.createdAt, task.updatedAt);
      this.#db.prepare(
        `INSERT INTO task_records (task_id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(task.id, this.#json(task), this.#now());
    });
  }

  listTasks(): Task[] {
    const tasks = this.#listPayload<Task>("task_records", "1=1", []);
    return this.#sortById(tasks, (task) => task.id);
  }

  getTask(id: string): Task | null {
    return this.#getPayload<Task>("task_records", "task_id = ?", [id]);
  }

  /** Task ids flagged active in the catalog projection (the global active index). */
  listActiveTaskIds(): string[] {
    const rows = this.#db.prepare(
      "SELECT task_id FROM tasks_catalog WHERE is_active = 1 ORDER BY task_id"
    ).all() as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  getTaskBrief(taskId: string): TaskBrief | null {
    const row = this.#db.prepare("SELECT brief FROM task_records WHERE task_id = ?").get(taskId) as { brief: string | null } | undefined;
    if (row === undefined || row.brief === null) return null;
    return this.#parse<TaskBrief>(row.brief);
  }

  saveTaskBrief(taskId: string, brief: TaskBrief): void {
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare("UPDATE task_records SET brief = ?, updated_at = ? WHERE task_id = ?")
        .run(this.#json(brief), this.#now(), taskId);
    });
  }

  clearTaskBrief(taskId: string): void {
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare("UPDATE task_records SET brief = NULL, updated_at = ? WHERE task_id = ?").run(this.#now(), taskId);
    });
  }

  // -- change sets ------------------------------------------------------------

  nextChangeSetId(taskId: string): string { return this.#nextTaskRecordId(taskId, "changeSet"); }

  saveChangeSet(taskId: string, changeSet: ChangeSet): void {
    if (changeSet.taskId !== taskId) throw new StorageRecordError(`Change set belongs to another Task: ${changeSet.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO change_sets (task_id, change_set_id, project_id, head_sha, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, change_set_id) DO UPDATE SET project_id = excluded.project_id,
           head_sha = excluded.head_sha, payload = excluded.payload`
      ).run(taskId, changeSet.id, changeSet.projectId, changeSet.headCommit, this.#json(changeSet), changeSet.createdAt);
    });
  }

  listChangeSets(taskId: string): ChangeSet[] {
    return this.#sortById(
      this.#listPayload<ChangeSet>("change_sets", "task_id = ?", [taskId]),
      (changeSet) => changeSet.id
    );
  }

  getChangeSet(taskId: string, changeSetId: string): ChangeSet | null {
    return this.#getPayload<ChangeSet>("change_sets", "task_id = ? AND change_set_id = ?", [taskId, changeSetId]);
  }

  // -- integration attempts ---------------------------------------------------

  nextIntegrationAttemptId(taskId: string): string { return this.#nextTaskRecordId(taskId, "integrationAttempt"); }

  saveIntegrationAttempt(taskId: string, attempt: IntegrationAttempt): void {
    if (attempt.taskId !== taskId) throw new StorageRecordError(`Integration attempt belongs to another Task: ${attempt.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO integration_attempts (task_id, integration_id, status, payload, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, integration_id) DO UPDATE SET status = excluded.status,
           payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, attempt.id, attempt.status, this.#json(attempt), this.#now());
    });
  }

  listIntegrationAttempts(taskId: string): IntegrationAttempt[] {
    return this.#sortById(
      this.#listPayload<IntegrationAttempt>("integration_attempts", "task_id = ?", [taskId]),
      (attempt) => attempt.id
    );
  }

  getIntegrationAttempt(taskId: string, integrationId: string): IntegrationAttempt | null {
    return this.#getPayload<IntegrationAttempt>("integration_attempts", "task_id = ? AND integration_id = ?", [taskId, integrationId]);
  }

  // -- integration queue -----------------------------------------------------

  nextIntegrationQueueEntryId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "integrationQueue");
  }

  saveIntegrationQueueEntry(taskId: string, entry: IntegrationQueueEntry): void {
    if (entry.taskId !== taskId) {
      throw new StorageRecordError(`Integration queue entry belongs to another Task: ${entry.taskId}`);
    }
    validateIntegrationQueueEntry(entry);
    this.#requireTask(taskId);
    const changeSet = this.getChangeSet(taskId, entry.changeSetId);
    if (changeSet === null) {
      throw new StorageRecordError(`Integration queue ChangeSet not found: ${entry.changeSetId}`);
    }
    if (changeSet.projectId !== entry.projectId) {
      throw new StorageRecordError(`Integration queue ChangeSet belongs to another Project: ${entry.changeSetId}`);
    }
    const existing = this.getIntegrationQueueEntry(taskId, entry.id);
    if (existing !== null) {
      if (Date.parse(entry.updatedAt) < Date.parse(existing.updatedAt)) {
        throw new StorageRecordError(`Integration queue entry updatedAt cannot move backwards: ${entry.id}`);
      }
      if (!validIntegrationQueueTransition(existing, entry)) {
        throw new StorageRecordError(`Integration queue entry transition is invalid: ${entry.id}`);
      }
    }
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO integration_queue (queue_id, task_id, project_id, change_set, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(queue_id) DO UPDATE SET task_id = excluded.task_id,
           project_id = excluded.project_id, change_set = excluded.change_set,
           status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(
        entry.id,
        taskId,
        entry.projectId,
        entry.changeSetId,
        entry.status,
        this.#json(entry),
        entry.createdAt,
        entry.updatedAt
      );
    });
  }

  listIntegrationQueueEntries(taskId: string): IntegrationQueueEntry[] {
    return this.#sortById(
      this.#listPayload<IntegrationQueueEntry>("integration_queue", "task_id = ?", [taskId]),
      (entry) => entry.id
    );
  }

  getIntegrationQueueEntry(taskId: string, entryId: string): IntegrationQueueEntry | null {
    return this.#getPayload<IntegrationQueueEntry>(
      "integration_queue",
      "task_id = ? AND queue_id = ?",
      [taskId, entryId]
    );
  }

  // -- durable jobs -----------------------------------------------------------

  nextDurableJobId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "durableJob");
  }

  saveDurableJob(taskId: string, job: DurableJob): void {
    if (job.taskId !== taskId) {
      throw new StorageRecordError(`DurableJob belongs to another Task: ${job.taskId}`);
    }
    validateDurableJob(job);
    this.#requireTask(taskId);
    const existing = this.getDurableJob(taskId, job.id);
    if (existing !== null) {
      if (Date.parse(job.updatedAt) < Date.parse(existing.updatedAt)) {
        throw new StorageRecordError(`DurableJob updatedAt cannot move backwards: ${job.id}`);
      }
      if (!validDurableJobTransition(existing, job)) {
        throw new StorageRecordError(`DurableJob transition is invalid: ${job.id}`);
      }
    }
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO durable_jobs (job_id, task_id, idempotency_key, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, job_id) DO UPDATE SET idempotency_key = excluded.idempotency_key,
           status = excluded.status,
           payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(
        job.id,
        taskId,
        job.idempotencyKey ?? null,
        job.status,
        this.#json(job),
        job.createdAt,
        job.updatedAt
      );
    });
  }

  listDurableJobs(taskId: string): DurableJob[] {
    return this.#sortById(
      this.#listPayload<DurableJob>("durable_jobs", "task_id = ?", [taskId]),
      (job) => job.id
    );
  }

  getDurableJob(taskId: string, jobId: string): DurableJob | null {
    return this.#getPayload<DurableJob>(
      "durable_jobs",
      "task_id = ? AND job_id = ?",
      [taskId, jobId]
    );
  }

  findDurableJobByIdempotencyKey(taskId: string, key: string): DurableJob | null {
    return this.#getPayload<DurableJob>(
      "durable_jobs",
      "task_id = ? AND idempotency_key = ?",
      [taskId, key]
    );
  }

  listAllDurableJobs(): DurableJob[] {
    return this.#listPayload<DurableJob>("durable_jobs", "1 = 1", []);
  }

  hasActiveDurableJobs(): boolean {
    const row = this.#db.prepare(
      "SELECT 1 FROM durable_jobs WHERE status IN ('queued', 'running') LIMIT 1"
    ).get() as { 1: number } | undefined;
    return row !== undefined;
  }

  // -- job caller key hashes (rr13) -------------------------------------------

  getJobCallerKeyHash(taskId: string, roleName: string, agentId: string): string | null {
    const row = this.#db.prepare(
      "SELECT hash FROM job_caller_key_hashes WHERE task_id = ? AND role_name = ? AND agent_id = ?"
    ).get(taskId, roleName, agentId) as { hash: string } | undefined;
    return row === undefined ? null : row.hash;
  }

  setJobCallerKeyHash(taskId: string, roleName: string, agentId: string, hash: string): void {
    this.#requireTask(taskId);
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new StorageRecordError(`Job caller key hash is invalid: ${taskId}/${roleName}.`);
    }
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO job_caller_key_hashes (task_id, role_name, agent_id, hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, role_name, agent_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at`
      ).run(taskId, roleName, agentId, hash, this.#now());
    });
  }

  // -- task roles -------------------------------------------------------------

  saveRole(taskId: string, role: TaskRole): void {
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO task_roles (task_id, role_name, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, role_name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, role.name, this.#json(role), this.#now());
    });
  }

  listRoles(taskId: string): TaskRole[] {
    return this.#sortById(
      this.#listPayload<TaskRole>("task_roles", "task_id = ?", [taskId]),
      (role) => role.name
    );
  }

  getRole(taskId: string, name: string): TaskRole | null {
    return this.#getPayload<TaskRole>("task_roles", "task_id = ? AND role_name = ?", [taskId, name]);
  }

  saveTaskRoleWithSessionSet(role: TaskRole, sessions: TaskRoleSessionSet): void {
    this.#requireTask(role.name ? role.taskId : sessions.owner.taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO task_roles (task_id, role_name, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, role_name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(sessions.owner.taskId, role.name, this.#json(role), this.#now());
      this.#db.prepare(
        `INSERT INTO role_session_sets (task_id, role_name, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, role_name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(sessions.owner.taskId, sessions.owner.roleName, this.#json(sessions), this.#now());
    });
  }

  removeTaskRole(taskId: string, name: string): boolean {
    return this.#mutate(() => {
      const result = this.#db.prepare("DELETE FROM task_roles WHERE task_id = ? AND role_name = ?").run(taskId, name);
      return result.changes > 0;
    });
  }

  // -- managed workspaces -----------------------------------------------------

  saveManagedWorkspace(workspace: ManagedWorkspace): void {
    const taskId = workspace.owner.taskId;
    this.#requireTask(taskId);
    this.#mutate(() => {
      const ownerId = managedWorkspaceKey(workspace.owner);
      this.#db.prepare(
        `INSERT INTO managed_workspaces (owner_kind, owner_id, task_id, path, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_kind, owner_id) DO UPDATE SET task_id = excluded.task_id, path = excluded.path,
           payload = excluded.payload, status = excluded.status, updated_at = excluded.updated_at`
      ).run(workspace.owner.type, ownerId, taskId, workspace.root, this.#json(workspace), "active", workspace.createdAt, workspace.updatedAt);
    });
  }

  listManagedWorkspaces(taskId: string): ManagedWorkspace[] {
    return this.#sortById(
      this.#listPayload<ManagedWorkspace>("managed_workspaces", "task_id = ?", [taskId]),
      (workspace) => managedWorkspaceKey(workspace.owner)
    );
  }

  listManagedWorkspace(taskId: string): ManagedWorkspace[] {
    return this.listManagedWorkspaces(taskId);
  }

  getManagedWorkspace(owner: ManagedWorkspaceOwner): ManagedWorkspace | null {
    return this.#getPayload<ManagedWorkspace>(
      "managed_workspaces",
      "owner_kind = ? AND owner_id = ?",
      [owner.type, managedWorkspaceKey(owner)]
    );
  }

  getTaskWorkspace(taskId: string): ManagedWorkspace | null {
    return this.getManagedWorkspace({ type: "task", taskId });
  }

  getWorkItemWorkspace(taskId: string, workItemId: string): ManagedWorkspace | null {
    return this.getManagedWorkspace({ type: "work-item", taskId, workItemId });
  }

  getReviewRoundWorkspace(taskId: string, reviewRoundId: string): ManagedWorkspace | null {
    return this.getManagedWorkspace({ type: "review-round", taskId, reviewRoundId });
  }

  getIntegrationWorkspace(taskId: string, integrationAttemptId: string): ManagedWorkspace | null {
    return this.getManagedWorkspace({ type: "integration-attempt", taskId, integrationAttemptId });
  }

  removeManagedWorkspace(owner: ManagedWorkspaceOwner): boolean {
    this.#requireTask(owner.taskId);
    return this.#mutate(() => {
      const result = this.#db.prepare(
        "DELETE FROM managed_workspaces WHERE owner_kind = ? AND owner_id = ?"
      ).run(owner.type, managedWorkspaceKey(owner));
      return result.changes > 0;
    });
  }

  // -- role session sets ------------------------------------------------------

  getRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null {
    return this.#getPayload<TaskRoleSessionSet>("role_session_sets", "task_id = ? AND role_name = ?", [taskId, roleName]);
  }

  getTaskRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null {
    return this.getRoleSessionSet(taskId, roleName);
  }

  listRoleSessionSets(taskId: string): TaskRoleSessionSet[] {
    return this.#sortById(
      this.#listPayload<TaskRoleSessionSet>("role_session_sets", "task_id = ?", [taskId]),
      (set) => set.owner.roleName
    );
  }

  saveRoleSessionSet(sessions: TaskRoleSessionSet): void {
    const taskId = sessions.owner.taskId;
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO role_session_sets (task_id, role_name, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, role_name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, sessions.owner.roleName, this.#json(sessions), this.#now());
    });
  }

  saveTaskRoleSessionSet(sessions: TaskRoleSessionSet): void {
    this.saveRoleSessionSet(sessions);
  }

  getRoleSession(taskId: string, roleName: string): RoleAgentSession | null {
    const set = this.getRoleSessionSet(taskId, roleName);
    if (set === null) return null;
    const session = set.sessions[set.activeAgentId];
    return session === undefined ? null : session;
  }

  // -- work items -------------------------------------------------------------

  nextWorkItemId(taskId: string): string { return this.#nextTaskRecordId(taskId, "workItem"); }

  getWorkItem(taskId: string, workItemId: string): WorkItem | null {
    return this.#getPayload<WorkItem>("work_items", "task_id = ? AND work_item_id = ?", [taskId, workItemId]);
  }

  listWorkItems(taskId: string): WorkItem[] {
    return this.#sortById(
      this.#listPayload<WorkItem>("work_items", "task_id = ?", [taskId]),
      (item) => item.id
    );
  }

  saveWorkItem(taskId: string, item: WorkItem): void {
    if (item.taskId !== taskId) throw new StorageRecordError(`Work item belongs to another Task: ${item.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO work_items (task_id, work_item_id, status, payload, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, work_item_id) DO UPDATE SET status = excluded.status,
           payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, item.id, item.status, this.#json(item), this.#now());
    });
  }

  // -- capability grants ------------------------------------------------------

  nextCapabilityGrantId(taskId: string): string { return this.#nextTaskRecordId(taskId, "capabilityGrant"); }

  saveCapabilityGrant(taskId: string, grant: CapabilityGrant): void {
    const stored = storedCapabilityGrant(grant);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Capability grant belongs to another Task: ${stored.taskId}`);
    }
    this.#requireTask(taskId);
    this.#mutate(() => {
      const existing = this.#getPayload<CapabilityGrant>(
        "capability_grants", "task_id = ? AND grant_id = ?", [taskId, stored.id]
      );
      if (existing === null) {
        if (stored.revokedAt !== undefined) {
          throw new StorageRecordError(`Capability grant must start unrevoked: ${stored.id}`);
        }
        if (stored.usesUsed !== 0) {
          throw new StorageRecordError(`Capability grant must start unused: ${stored.id}`);
        }
      } else if (!isValidCapabilityGrantTransition(existing, stored)) {
        throw new StorageRecordError(`Capability grant cannot be overwritten: ${taskId}/${stored.id}`);
      }
      this.#db.prepare(
        `INSERT INTO capability_grants (task_id, grant_id, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, grant_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, stored.id, this.#json(stored), this.#now());
    });
  }

  listCapabilityGrants(taskId: string): CapabilityGrant[] {
    return this.#sortById(
      this.#listPayload<CapabilityGrant>("capability_grants", "task_id = ?", [taskId]),
      (grant) => grant.id
    );
  }

  getCapabilityGrant(taskId: string, grantId: string): CapabilityGrant | null {
    return this.#getPayload<CapabilityGrant>("capability_grants", "task_id = ? AND grant_id = ?", [taskId, grantId]);
  }

  // -- release workflows ------------------------------------------------------

  nextReleaseWorkflowId(taskId: string): string { return this.#nextTaskRecordId(taskId, "releaseWorkflow"); }

  saveReleaseWorkflow(taskId: string, workflow: ReleaseWorkflow): void {
    const stored = storedReleaseWorkflow(workflow);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Release workflow belongs to another Task: ${stored.taskId}`);
    }
    this.#requireTask(taskId);
    this.#mutate(() => {
      const existing = this.#getPayload<ReleaseWorkflow>(
        "release_workflows", "task_id = ? AND workflow_id = ?", [taskId, stored.id]
      );
      if (existing !== null && !isValidReleaseWorkflowTransition(existing, stored)) {
        throw new StorageRecordError(`Release workflow cannot be overwritten: ${taskId}/${stored.id}`);
      }
      this.#db.prepare(
        `INSERT INTO release_workflows (task_id, workflow_id, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, workflow_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, stored.id, this.#json(stored), this.#now());
    });
  }

  listReleaseWorkflows(taskId: string): ReleaseWorkflow[] {
    return this.#sortById(
      this.#listPayload<ReleaseWorkflow>("release_workflows", "task_id = ?", [taskId]),
      (workflow) => workflow.id
    );
  }

  getReleaseWorkflow(taskId: string, workflowId: string): ReleaseWorkflow | null {
    return this.#getPayload<ReleaseWorkflow>("release_workflows", "task_id = ? AND workflow_id = ?", [taskId, workflowId]);
  }

  // -- agent runs -------------------------------------------------------------

  nextAgentRunId(taskId: string): string { return this.#nextTaskRecordId(taskId, "agentRun"); }
  peekNextAgentRunId(taskId: string): string { return this.#peekTaskRecordId(taskId, "agentRun"); }

  getAgentRun(taskId: string, runId: string): AgentRun | null {
    return this.#getPayload<AgentRun>("agent_runs", "task_id = ? AND run_id = ?", [taskId, runId]);
  }

  listAgentRuns(taskId: string): AgentRun[] {
    return this.#sortById(
      this.#listPayload<AgentRun>("agent_runs", "task_id = ?", [taskId]),
      (run) => run.id
    );
  }

  saveAgentRun(run: AgentRun): void {
    if (run.taskId !== undefined) this.#requireTask(run.taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO agent_runs (task_id, run_id, role_name, status, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, run_id) DO UPDATE SET role_name = excluded.role_name, status = excluded.status,
           payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(run.taskId, run.id, run.roleName, run.status, this.#json(run), this.#now());
    });
  }

  /**
   * Issue 04: SQLite-native pending retry query.  A single indexed scan
   * replaces the adapter's per-Task in-memory sweep, so Controller deadline
   * arming no longer materializes every Task and Run in JavaScript.
   */
  listPendingProviderRetries(): ReadonlyArray<PendingProviderRetry> {
    const rows = this.#db.prepare(
      `SELECT ar.task_id AS taskId, ar.run_id AS runId, ar.role_name AS roleName,
              json_extract(ar.payload, '$.providerRetry.nextAttemptAt') AS nextAttemptAt
       FROM agent_runs ar
       JOIN tasks_catalog tc ON tc.task_id = ar.task_id
       WHERE ar.status = 'active'
         AND tc.is_active = 1
         AND json_extract(ar.payload, '$.providerRetry.nextAttemptAt') IS NOT NULL`
    ).all() as Array<{ taskId: string; runId: string; roleName: string; nextAttemptAt: string }>;
    return rows;
  }

  // -- review rounds ----------------------------------------------------------

  nextReviewRoundId(taskId: string): string { return this.#nextTaskRecordId(taskId, "reviewRound"); }

  getReviewRound(taskId: string, reviewRoundId: string): ReviewRound | null {
    return this.#getPayload<ReviewRound>("review_rounds", "task_id = ? AND review_round_id = ?", [taskId, reviewRoundId]);
  }

  listReviewRounds(taskId: string): ReviewRound[] {
    return this.#sortById(
      this.#listPayload<ReviewRound>("review_rounds", "task_id = ?", [taskId]),
      (round) => round.id
    );
  }

  saveReviewRound(taskId: string, round: ReviewRound): void {
    if (round.taskId !== taskId) throw new StorageRecordError(`Review round belongs to another Task: ${round.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO review_rounds (task_id, review_round_id, status, payload, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, review_round_id) DO UPDATE SET status = excluded.status,
           payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, round.id, round.status, this.#json(round), this.#now());
    });
  }

  // -- active runs ------------------------------------------------------------

  #saveActiveRun(taskId: string, pointer: string, runId: string): void {
    this.#mutate(() => {
      const payload = this.#json({ schemaVersion: 3, runId });
      this.#db.prepare(
        `INSERT INTO active_runs (task_id, pointer, run_id, payload, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, pointer) DO UPDATE SET run_id = excluded.run_id, payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, pointer, runId, payload, this.#now());
    });
  }

  #getActiveRun(taskId: string, pointer: string): AgentRun | null {
    const row = this.#db.prepare(
      "SELECT run_id FROM active_runs WHERE task_id = ? AND pointer = ?"
    ).get(taskId, pointer) as { run_id: string } | undefined;
    if (row === undefined) return null;
    return this.getAgentRun(taskId, row.run_id);
  }

  #clearActiveRun(taskId: string, pointer: string): void {
    this.#mutate(() => {
      this.#db.prepare("DELETE FROM active_runs WHERE task_id = ? AND pointer = ?").run(taskId, pointer);
    });
  }

  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null {
    return this.#getActiveRun(taskId, roleName);
  }

  saveActiveAgentRun(run: AgentRun): void {
    this.#saveActiveRun(run.taskId, run.roleName, run.id);
  }

  clearActiveAgentRun(taskId: string, roleName: string): void {
    this.#clearActiveRun(taskId, roleName);
  }

  getActiveExecutionLaneRun(taskId: string, executionGroupId: string, executionLaneId: string): AgentRun | null {
    return this.#getActiveRun(taskId, executionLaneActiveRunKey(executionGroupId, executionLaneId));
  }

  saveActiveExecutionLaneRun(run: AgentRun): void {
    if (run.executionGroupId === undefined || run.executionLaneId === undefined) {
      throw new StorageRecordError(`Active execution-lane run requires group and lane ids: ${run.id}`);
    }
    this.#saveActiveRun(run.taskId, executionLaneActiveRunKey(run.executionGroupId, run.executionLaneId), run.id);
  }

  clearActiveExecutionLaneRun(taskId: string, executionGroupId: string, executionLaneId: string): void {
    this.#clearActiveRun(taskId, executionLaneActiveRunKey(executionGroupId, executionLaneId));
  }

  // -- messages ----------------------------------------------------------------

  nextMessageId(taskId: string): string { return this.#nextTaskRecordId(taskId, "message"); }

  saveMessage(taskId: string, message: TaskMessage): void {
    if (message.taskId !== taskId) throw new StorageRecordError(`Message belongs to another Task: ${message.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      const seq = this.#idSequence(message.id, "message");
      this.#db.prepare(
        `INSERT INTO messages (task_id, message_id, seq, payload, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(taskId, message.id, seq, this.#json(message), message.createdAt);
      this.#observeHighWater(taskId, "message", seq);
    });
  }

  listMessages(taskId: string): TaskMessage[] {
    return this.#sortById(
      this.#listPayload<TaskMessage>("messages", "task_id = ?", [taskId]),
      (message) => message.id
    );
  }

  // -- input requests ----------------------------------------------------------

  nextInputRequestId(taskId: string): string { return this.#nextTaskRecordId(taskId, "inputRequest"); }

  saveInputRequest(taskId: string, request: InputRequest): void {
    if (request.taskId !== taskId) throw new StorageRecordError(`Input request belongs to another Task: ${request.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO input_requests (task_id, input_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, input_id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, request.id, request.status, this.#json(request), request.createdAt, this.#now());
    });
  }

  getInputRequest(taskId: string, requestId: string): InputRequest | null {
    return this.#getPayload<InputRequest>("input_requests", "task_id = ? AND input_id = ?", [taskId, requestId]);
  }

  listInputRequests(taskId: string): InputRequest[] {
    return this.#sortById(
      this.#listPayload<InputRequest>("input_requests", "task_id = ?", [taskId]),
      (request) => request.id
    );
  }

  listAllInputRequests(): InputRequest[] {
    return this.#sortById(
      this.#listPayload<InputRequest>("input_requests", "1=1", []),
      (request) => `${request.taskId}/${request.id}`
    );
  }

  // -- decisions ----------------------------------------------------------------

  nextDecisionId(taskId: string): string { return this.#nextTaskRecordId(taskId, "decision"); }

  saveDecision(taskId: string, decision: Decision): void {
    if (decision.taskId !== taskId) throw new StorageRecordError(`Decision belongs to another Task: ${decision.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO decisions (task_id, decision_id, payload, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, decision_id) DO UPDATE SET payload = excluded.payload`
      ).run(taskId, decision.id, this.#json(decision), decision.createdAt);
    });
  }

  listDecisions(taskId: string): Decision[] {
    return this.#sortById(
      this.#listPayload<Decision>("decisions", "task_id = ?", [taskId]),
      (decision) => decision.id
    );
  }

  getDecision(taskId: string, decisionId: string): Decision | null {
    return this.#getPayload<Decision>("decisions", "task_id = ? AND decision_id = ?", [taskId, decisionId]);
  }

  // -- milestones ----------------------------------------------------------------

  nextMilestoneId(taskId: string): string { return this.#nextTaskRecordId(taskId, "milestone"); }

  saveMilestone(taskId: string, milestone: Milestone): void {
    if (milestone.taskId !== taskId) throw new StorageRecordError(`Milestone belongs to another Task: ${milestone.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO milestones (task_id, milestone_id, payload, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, milestone_id) DO UPDATE SET payload = excluded.payload`
      ).run(taskId, milestone.id, this.#json(milestone), milestone.createdAt);
    });
  }

  listMilestones(taskId: string): Milestone[] {
    return this.#sortById(
      this.#listPayload<Milestone>("milestones", "task_id = ?", [taskId]),
      (milestone) => milestone.id
    );
  }

  getMilestone(taskId: string, milestoneId: string): Milestone | null {
    return this.#getPayload<Milestone>("milestones", "task_id = ? AND milestone_id = ?", [taskId, milestoneId]);
  }

  // -- events -------------------------------------------------------------------

  nextEventId(taskId: string): string { return this.#nextTaskRecordId(taskId, "event"); }

  saveEvent(taskId: string, event: TaskEvent): void {
    if (event.taskId !== taskId) throw new StorageRecordError(`Task event belongs to another Task: ${event.taskId}`);
    this.#requireTask(taskId);
    this.#mutate(() => {
      const seq = this.#idSequence(event.id, "event");
      // Events are terminal/semantic: retained individually, never pruned (§9).
      this.#db.prepare(
        `INSERT INTO events (task_id, event_id, type, occurred_at, payload) VALUES (?, ?, ?, ?, ?)`
      ).run(taskId, event.id, event.type, event.createdAt, this.#json(event));
      this.#observeHighWater(taskId, "event", seq);
    });
  }

  listEvents(taskId: string): TaskEvent[] {
    return this.#sortById(
      this.#listPayload<TaskEvent>("events", "task_id = ?", [taskId]),
      (event) => event.id
    );
  }

  // -- high-water maintenance ---------------------------------------------------

  /** Extract the numeric suffix of a `<prefix>-<n>` record id. */
  #idSequence(id: string, kind: TaskRecordKind): number {
    const match = new RegExp(`^${TASK_RECORD_ID_PREFIXES[kind]}-(\\d+)$`).exec(id);
    if (match === null) throw new StorageRecordError(`Task-local ${kind} id is invalid: ${id}.`);
    return Number.parseInt(match[1]!, 10);
  }

  /** Advance the per-task high-water mark to at least `seq` (mirrors observeTaskRecordId). */
  #observeHighWater(taskId: string, kind: TaskRecordKind, seq: number): void {
    this.#db.prepare(
      `INSERT INTO id_sequences (task_id, kind, high_water) VALUES (?, ?, ?)
       ON CONFLICT(task_id, kind) DO UPDATE SET high_water = MAX(high_water, ?)`
    ).run(taskId, kind, seq, seq);
  }

  // -- work mailboxes ------------------------------------------------------------

  #mailboxCols(target: MailboxTarget): { targetKind: string; taskId: string | null; roleName: string | null; targetKey: string } {
    return {
      targetKind: target.kind,
      taskId: "taskId" in target ? target.taskId : null,
      roleName: "roleName" in target ? target.roleName : null,
      targetKey: mailboxTargetKey(target)
    };
  }

  #rowToMailbox(row: { target_kind: string; task_id: string | null; role_name: string | null; next_sequence: number; processing: string | null; pending: string | null }): WorkMailbox {
    const target = this.#targetFromCols(row.target_kind, row.task_id, row.role_name);
    return {
      schemaVersion: 1,
      target,
      nextSequence: row.next_sequence,
      processing: row.processing === null ? null : this.#parse(row.processing),
      pending: row.pending === null ? null : this.#parse(row.pending)
    };
  }

  #targetFromCols(kind: string, taskId: string | null, roleName: string | null): MailboxTarget {
    switch (kind) {
      case "operator": return { kind: "operator" };
      case "task": return { kind: "task", taskId: taskId! };
      case "role": return { kind: "role", taskId: taskId!, roleName: roleName! };
      case "role-runtime": return { kind: "role-runtime", taskId: taskId!, roleName: roleName! };
      case "global-role-runtime": return { kind: "global-role-runtime", roleName: roleName! };
      default: throw new StorageRecordError(`Unknown mailbox target kind: ${kind}`);
    }
  }

  getWorkMailbox(target: MailboxTarget): WorkMailbox | null {
    const cols = this.#mailboxCols(target);
    const row = this.#db.prepare(
      "SELECT target_kind, task_id, role_name, next_sequence, processing, pending FROM mailboxes WHERE target_key = ?"
    ).get(cols.targetKey) as { target_kind: string; task_id: string | null; role_name: string | null; next_sequence: number; processing: string | null; pending: string | null } | undefined;
    return row === undefined ? null : this.#rowToMailbox(row);
  }

  listWorkMailboxes(): WorkMailbox[] {
    const rows = this.#db.prepare(
      "SELECT target_kind, task_id, role_name, next_sequence, processing, pending FROM mailboxes ORDER BY target_key"
    ).all() as Array<{ target_kind: string; task_id: string | null; role_name: string | null; next_sequence: number; processing: string | null; pending: string | null }>;
    return rows.map((row) => this.#rowToMailbox(row));
  }

  saveWorkMailbox(mailbox: WorkMailbox): void {
    const cols = this.#mailboxCols(mailbox.target);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO mailboxes (target_kind, task_id, role_name, target_key, next_sequence, processing, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_key) DO UPDATE SET next_sequence = excluded.next_sequence,
           processing = excluded.processing, pending = excluded.pending`
      ).run(
        cols.targetKind, cols.taskId, cols.roleName, cols.targetKey,
        mailbox.nextSequence,
        mailbox.processing === null ? null : this.#json(mailbox.processing),
        mailbox.pending === null ? null : this.#json(mailbox.pending)
      );
    });
  }

  removeWorkMailbox(target: MailboxTarget): boolean {
    const cols = this.#mailboxCols(target);
    return this.#mutate(() => {
      const result = this.#db.prepare("DELETE FROM mailboxes WHERE target_key = ?").run(cols.targetKey);
      return result.changes > 0;
    });
  }

  /**
   * Append a mailbox signal (§4.2). One transaction: insert the signal at the
   * mailbox's next sequence and advance `next_sequence` on the same row. The
   * single writer connection serializes enqueues, so sequences stay gapless per
   * mailbox. `(mailbox_id, sequence)` is the exactly-once key.
   */
  enqueueMailboxSignal(target: MailboxTarget, input: { reason: string; ref?: MailboxEntityRef; requestId: string }): number {
    return this.#mutate(() => {
      const cols = this.#mailboxCols(target);
      let mailboxId: number;
      let sequence: number;
      const existing = this.#db.prepare(
        "SELECT mailbox_id, next_sequence FROM mailboxes WHERE target_key = ?"
      ).get(cols.targetKey) as { mailbox_id: number; next_sequence: number } | undefined;
      if (existing === undefined) {
        const result = this.#db.prepare(
          `INSERT INTO mailboxes (target_kind, task_id, role_name, target_key, next_sequence, processing, pending)
           VALUES (?, ?, ?, ?, 1, NULL, NULL)`
        ).run(cols.targetKind, cols.taskId, cols.roleName, cols.targetKey);
        mailboxId = Number(result.lastInsertRowid);
        sequence = 1;
      } else {
        mailboxId = existing.mailbox_id;
        sequence = existing.next_sequence;
      }
      this.#db.prepare(
        `INSERT INTO mailbox_signals (mailbox_id, sequence, reason, ref_type, ref_task_id, ref_id, occurred_at, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        mailboxId, sequence, input.reason,
        input.ref?.type ?? null,
        input.ref && "taskId" in input.ref ? input.ref.taskId : null,
        input.ref?.id ?? null,
        this.#now(), input.requestId
      );
      this.#db.prepare("UPDATE mailboxes SET next_sequence = ? WHERE mailbox_id = ?").run(sequence + 1, mailboxId);
      return sequence;
    });
  }

  // -- scheduler projections -----------------------------------------------------

  #getProjection<T>(taskId: string, kind: "leader-failure" | "operator-notification"): T | null {
    const row = this.#db.prepare(
      "SELECT payload FROM task_projections WHERE task_id = ? AND kind = ?"
    ).get(taskId, kind) as { payload: string | null } | undefined;
    if (row === undefined || row.payload === null) return null;
    return this.#parse<T>(row.payload);
  }

  #saveProjection(taskId: string, kind: "leader-failure" | "operator-notification", value: object): void {
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO task_projections (task_id, kind, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, kind, this.#json(value), this.#now());
    });
  }

  #clearProjection(taskId: string, kind: "leader-failure" | "operator-notification"): void {
    this.#mutate(() => {
      this.#db.prepare("UPDATE task_projections SET payload = NULL, updated_at = ? WHERE task_id = ? AND kind = ?")
        .run(this.#now(), taskId, kind);
    });
  }

  getLeaderFailure(taskId: string): LeaderFailure | null {
    return this.#getProjection<LeaderFailure>(taskId, "leader-failure");
  }

  saveLeaderFailure(failure: LeaderFailure): void {
    this.#saveProjection(failure.taskId, "leader-failure", failure);
  }

  clearLeaderFailure(taskId: string): void {
    this.#clearProjection(taskId, "leader-failure");
  }

  getOperatorNotification(taskId: string): OperatorNotification | null {
    return this.#getProjection<OperatorNotification>(taskId, "operator-notification");
  }

  saveOperatorNotification(notification: OperatorNotification): void {
    this.#saveProjection(notification.taskId, "operator-notification", notification);
  }

  clearOperatorNotification(taskId: string): void {
    this.#clearProjection(taskId, "operator-notification");
  }

  // -- pending wakeups (leader-role work-mailbox projection, mirrors taskStore.ts) --

  getPendingWakeup(taskId: string): PendingWakeup | null {
    return pendingWakeupProjection(this.getWorkMailbox({ kind: "role", taskId, roleName: "leader" }));
  }

  listPendingWakeups(): PendingWakeup[] {
    return this.listWorkMailboxes()
      .flatMap((mailbox) => {
        const wakeup = pendingWakeupProjection(mailbox);
        return wakeup === null ? [] : [wakeup];
      })
      .sort((a, b) => numericCompare(a.taskId, b.taskId));
  }

  savePendingWakeup(value: PendingWakeup): void {
    const target: MailboxTarget = { kind: "role", taskId: value.taskId, roleName: "leader" };
    this.transaction((store) => {
      const existing = store.getWorkMailbox(target);
      if (existing !== null && existing.pending !== null
        && value.requestCount <= existing.pending.requestCount) {
        throw new StorageRecordError(`Pending wakeup is stale: ${value.taskId}`);
      }
      const fromSequence = existing?.pending?.fromSequence ?? existing?.nextSequence ?? 1;
      const toSequence = fromSequence + value.requestCount - 1;
      store.saveWorkMailbox({
        schemaVersion: CURRENT_WORK_MAILBOX_SCHEMA_VERSION,
        target,
        nextSequence: Math.max(existing?.nextSequence ?? 1, toSequence + 1),
        processing: existing?.processing ?? null,
        pending: {
          ...existing?.pending,
          fromSequence,
          toSequence,
          reasons: [...value.reasons],
          refs: existing?.pending?.refs ?? [],
          requestCount: value.requestCount,
          firstQueuedAt: value.firstRequestedAt,
          lastQueuedAt: value.lastRequestedAt
        }
      });
    });
  }

  clearPendingWakeup(taskId: string): void {
    this.removeWorkMailbox({ kind: "role", taskId, roleName: "leader" });
  }

  // -- telemetry (§4.4) -----------------------------------------------------------

  /**
   * Upsert one progress row. The PK is (task_id, role_name, run_id, generation,
   * progress_id): a repeated progress id updates in place, so a high-frequency
   * `runtime.provider-turn-progress` event is a single-row write that never
   * rewrites global state or another Task's rows.
   */
  upsertTelemetryProgress(entry: TelemetryProgress): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO telemetry (task_id, role_name, run_id, generation, progress_id, sequence, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, role_name, run_id, generation, progress_id)
         DO UPDATE SET sequence = excluded.sequence, payload = excluded.payload, received_at = excluded.received_at`
      ).run(
        entry.taskId, entry.roleName, entry.runId, entry.generation, entry.progressId,
        entry.sequence ?? null, this.#json(entry.payload), entry.receivedAt
      );
    });
  }

  listTelemetry(taskId: string, runId?: string): TelemetryProgress[] {
    const rows = runId === undefined
      ? this.#db.prepare(
          "SELECT task_id, role_name, run_id, generation, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? ORDER BY received_at"
        ).all(taskId)
      : this.#db.prepare(
          "SELECT task_id, role_name, run_id, generation, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? AND run_id = ? ORDER BY received_at"
        ).all(taskId, runId);
    return (rows as Array<{ task_id: string; role_name: string; run_id: string; generation: string; progress_id: string; sequence: number | null; payload: string; received_at: string }>)
      .map((row) => ({
        taskId: row.task_id,
        roleName: row.role_name,
        runId: row.run_id,
        generation: row.generation,
        progressId: row.progress_id,
        sequence: row.sequence ?? undefined,
        payload: this.#parse(row.payload),
        receivedAt: row.received_at
      }));
  }

  countTelemetry(taskId: string, runId?: string): number {
    const row = runId === undefined
      ? this.#db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ?").get(taskId)
      : this.#db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ? AND run_id = ?").get(taskId, runId);
    return (row as { n: number }).n;
  }

  /**
   * Bounded retention (§4.4): keep the newest `keep` rows per
   * (task, role, run, generation) and delete older ones. The DELETE is scoped
   * by task_id; it never rewrites global rows or other Tasks. Returns the number
   * of rows deleted. Terminal/semantic events go to `events` and are never pruned.
   */
  pruneTelemetry(taskId: string, roleName: string, runId: string, generation: string, keep: number = TELEMETRY_KEEP_PER_GENERATION): number {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        `DELETE FROM telemetry
         WHERE task_id = ? AND role_name = ? AND run_id = ? AND generation = ?
           AND (task_id, role_name, run_id, generation, progress_id) NOT IN (
             SELECT task_id, role_name, run_id, generation, progress_id
             FROM telemetry
             WHERE task_id = ? AND role_name = ? AND run_id = ? AND generation = ?
             ORDER BY COALESCE(sequence, -1) DESC, received_at DESC, progress_id ASC
             LIMIT ?
           )`
      ).run(taskId, roleName, runId, generation, taskId, roleName, runId, generation, keep);
      return result.changes;
    });
  }

  /**
   * Hard cap for an active run (§4.4): trim oldest rows across the run beyond
   * `cap` (default 50k). Returns the number of rows deleted.
   */
  capTelemetryRun(taskId: string, runId: string, cap: number = TELEMETRY_RUN_CAP): number {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        `DELETE FROM telemetry
         WHERE task_id = ? AND run_id = ?
           AND (task_id, role_name, run_id, generation, progress_id) NOT IN (
             SELECT task_id, role_name, run_id, generation, progress_id
             FROM telemetry
             WHERE task_id = ? AND run_id = ?
             ORDER BY COALESCE(sequence, -1) DESC, received_at DESC, progress_id ASC
             LIMIT ?
           )`
      ).run(taskId, runId, taskId, runId, cap);
      return result.changes;
    });
  }
}

function validIntegrationQueueTransition(
  before: IntegrationQueueEntry,
  after: IntegrationQueueEntry
): boolean {
  if (
    before.id !== after.id
    || before.taskId !== after.taskId
    || before.projectId !== after.projectId
    || before.changeSetId !== after.changeSetId
    || before.targetRef !== after.targetRef
    || !isDeepStrictEqual(before.checkCommands, after.checkCommands)
    || !isDeepStrictEqual(before.evidenceRefs, after.evidenceRefs)
    || before.createdAt !== after.createdAt
  ) return false;
  const allowed: Readonly<Record<IntegrationQueueStatus, readonly IntegrationQueueStatus[]>> = {
    queued: ["queued", "running", "validated", "superseded"],
    running: ["running", "conflicted", "committed"],
    conflicted: ["conflicted", "running", "committed", "queued", "superseded"],
    validated: ["validated", "running", "queued", "superseded"],
    committed: ["committed"],
    superseded: ["superseded"]
  };
  return allowed[before.status].includes(after.status);
}


// -- §6 replaceable-Store seam ----------------------------------------------

/** The selectable storage backends (design §6). */
export type TaskStoreBackend = "file" | "sqlite";

/** Options for {@link openTaskStore}. */
export type TaskStoreOptions = SqliteTaskStoreOptions;

/**
 * Open a {@link TaskStore} for the given backend. `file` returns the existing
 * {@link FileTaskStore}; `sqlite` returns the in-process {@link SqliteTaskStore}.
 * Backend selection is explicit (design §6); the environment switch lives in
 * {@link resolveTaskStoreBackend}. The file store is not removed — rollback is
 * a config flip.
 */
export function openTaskStore(
  home: string,
  backend: TaskStoreBackend,
  options?: TaskStoreOptions
): TaskStore {
  if (backend === "sqlite") {
    return new SqliteTaskStore(home, options);
  }
  return new FileTaskStore(home);
}

/**
 * Resolve the storage backend from `YUI_STORE_BACKEND` (default `file`,
 * design §6). Only the exact value `sqlite` selects the SQLite store; any
 * other value (including unset) keeps the file store.
 */
export function resolveTaskStoreBackend(env: NodeJS.ProcessEnv = process.env): TaskStoreBackend {
  return env.YUI_STORE_BACKEND?.toLowerCase() === "sqlite" ? "sqlite" : "file";
}

/**
 * Resolve the storage backend from the Home's verified manifest (Issue 01).
 *
 * The Home decides: a layout-7 Home's authoritative backend is SQLite WAL, so
 * ordinary CLI/Controller startup opens SQLite without requiring
 * `YUI_STORE_BACKEND=sqlite`. An explicit `YUI_STORE_BACKEND` env value still
 * wins — it is reserved for tests and explicit recovery commands — and any
 * other value (including unset) defers to the Home. A Home whose manifest
 * cannot be read falls back to the file store; the classifier/doctor surfaces
 * the manifest problem separately.
 */
export function resolveTaskStoreBackendForHome(
  home: string,
  env: NodeJS.ProcessEnv = process.env
): TaskStoreBackend {
  const explicit = env.YUI_STORE_BACKEND?.toLowerCase();
  if (explicit === "sqlite" || explicit === "file") return explicit;
  const schema = inspectStorageSchema(home);
  const layout = schema.status === "current" || schema.status === "unsupported"
    ? schema.currentLayoutVersion
    : 0;
  if (layout < 7) return "file";
  // Issue 01: a layout-7 Home's authoritative backend is SQLite WAL, but only
  // when yui.db actually exists. A pseudo-layout-7 Home (manifest 7, no
  // yui.db) is classified NEEDS_STORAGE_REPAIR; until repair runs, the file
  // store remains the readable fallback. This keeps the Controller's backend
  // resolution consistent with openCompatibleFileTaskStore's physical check.
  // Uses the literal "yui.db" (not COMMITTED_DATABASE_FILENAME) to avoid a
  // circular import: sqliteStateMigration.ts imports SqliteTaskStore from here.
  return existsSync(join(home, "yui.db")) ? "sqlite" : "file";
}

/**
 * Convenience: open the store for the backend resolved from the environment
 * and the Home's verified manifest (see {@link resolveTaskStoreBackendForHome}).
 * CLI/controller entry points call this instead of {@link openTaskStore}
 * directly so a layout-7 Home opens SQLite without an env opt-in.
 */
export function openConfiguredTaskStore(
  home: string,
  options?: TaskStoreOptions,
  env: NodeJS.ProcessEnv = process.env
): TaskStore {
  return openTaskStore(home, resolveTaskStoreBackendForHome(home, env), options);
}
