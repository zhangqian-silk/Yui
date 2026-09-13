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
 *   - Mailbox per-target ordering . WorkMailbox v2 sequence/cursors in one row.
 *   - Exactly-once terminal state . conditional updates + UNIQUE(request_id)
 *                                    on the durable outbox.
 *   - Crash recovery .............. WAL rollback of uncommitted transactions;
 *                                    outbox replay of committed-but-unacked effects.
 *   - Record validation ........... current record (incl. local schemaVersion)
 *                                    in payload.
 *   - Evidence retention .......... events/review_rounds/change_sets/
 *                                    integration_attempts are never pruned.
 *
 * Records are stored as full current JSON in `payload` columns, with typed
 * columns for the fields that are queried/filtered/used-for-CAS (§4). A
 * high-frequency runtime telemetry observation is a single-row upsert into
 * `telemetry` scoped by its primary key — it never rewrites global
 * state and never touches another Task's rows (§4.4).
 *
 * The in-process store is phase 1 of §6. It does not re-run the heavy record
 * validators on write (the domain layer that constructs records already does,
 * and the design places record validation in the persistence worker, phase 2);
 * it performs the same cheap structural checks the file store relies on
 * (identity presence, taskId matching, referential lookups).
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateConfiguredAgent, type ConfiguredAgent } from "../agent/agent.js";
import { runPurposeAdmitsTaskState, type AgentRun } from "../agentRun/agentRun.js";
import { validateTaskBrief, type TaskBrief } from "../brief/taskBrief.js";
import {
  validateContextSnapshot,
  type ContextSnapshot
} from "../context/contextSnapshot.js";
import type { MailboxTarget, WorkMailbox } from "../coordination/workMailbox.js";
import {
  consumePendingBatch,
  mailboxTargetKey,
  validateWorkMailbox
} from "../coordination/workMailbox.js";
import type { Decision } from "../decision/decision.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { GlobalRoleSessionSet, RoleAgentSession, TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { CapabilityGrant } from "../grant/capabilityGrant.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import {
  validateIntegrationQueueEntry,
  type IntegrationQueueEntry,
  type IntegrationQueueStatus
} from "../integration/integrationQueueEntry.js";
import {
  validateDurableJob,
  validDurableJobTransition,
  type DurableJob
} from "../job/durableJob.js";
import type { TaskMessage } from "../message/message.js";
import { validateGlobalRoleMessage, type GlobalRoleMessage } from "../message/message.js";
import type { Milestone } from "../milestone/milestone.js";
import {
  validatePluginIntent,
  validatePluginIntentFailure,
  type PluginIntent,
  type PluginIntentFailure
} from "../plugins/pluginIntent.js";
import { validatePluginValidation, type PluginValidation } from "../plugins/pluginPackage.js";
import type { AgentProfile } from "../profile/agentProfile.js";
import type { ReleaseWorkflow } from "../release/releaseWorkflow.js";
import {
  generateHomeIdentity,
  validateHomeIdentity,
  type HomeIdentity
} from "../repository/homeIdentity.js";
import { validateProject, type Project, type ProjectReferenceSummary } from "../repository/project.js";
import {
  validateEnvironmentPreparation,
  validateLocalResource,
  type EnvironmentPreparation,
  type LocalResource
} from "../resources/projectResource.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import { validateReviewRound, type ReviewRound } from "../review/reviewRound.js";
import { validateGlobalRole, validateTaskRole, type GlobalRole, type TaskRole } from "../role/role.js";
import type { RuntimeOwner } from "../runtime/runtimeOwner.js";
import {
  compareRuntimeSessionCandidates,
  projectRuntimeSessionCandidate,
  type RuntimeSessionCandidate,
  type RuntimeSessionCandidateQuery
} from "../runtime/runtimeSessionCandidate.js";
import { sessionOwnerProcessKey, type SessionOwnerIdentity } from "../runtime/sessionOwnerIdentity.js";
import type { LeaderFailure } from "../scheduler/leaderFailure.js";
import type { PendingWakeup } from "../scheduler/pendingWakeup.js";
import { validateTaskWake, type TaskWake } from "../scheduler/taskWake.js";
import { pendingCompletionMessages, type CompletionReadinessFacts } from "../task/completionReadiness.js";
import type { NextActionFacts } from "../task/nextAction.js";
import type { PublicationReference } from "../task/publicationReference.js";
import { publicationExternalKey } from "../task/publicationReference.js";
import { validateTask, type Task } from "../task/task.js";
import { TASK_RECORD_ID_PREFIXES, type TaskRecordKind } from "../task/taskRecordReference.js";
import {
  operationalTaskRecords,
  TASK_RECORD_RETIRED_EVENT
} from "../task/taskRecordRetirement.js";
import { writeTelemetryBatch } from "../telemetry/sqliteTelemetryBatch.js";
import type { TelemetryProgressEntry } from "../telemetry/telemetryStore.js";
import {
  gateArtifactKey,
  validateGateArtifact,
  type GateArtifact,
  type GateArtifactIdentity,
  type GateArtifactPruneOptions,
  type GateArtifactPruneResult
} from "../verification/gateArtifact.js";
import { validateWorkItem, type WorkItem } from "../workItem/workItem.js";
import {
  managedWorkspaceKey,
  type ManagedWorkspace,
  type ManagedWorkspaceOwner
} from "../worktree/managedWorkspace.js";
import {
  contextInputReferences,
  queryContextRecords,
  type ContextInputScope,
  type ContextRecordQuery
} from "./contextRecords.js";
import {
  inspectSqliteSchemaMigrations,
  migrateSqliteSchema,
  SqliteSchemaMigrationError,
  TELEMETRY_KEEP_PER_RUN,
  TELEMETRY_RUN_CAP
} from "./sqliteSchema.js";
import { StorageSchemaError } from "./storageSchema.js";
import { queryTaskCatalog, type TaskCatalogQuery } from "./taskCatalog.js";
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_WORK_MAILBOX_SCHEMA_VERSION,
  executionLaneActiveRunKey,
  executionLaneActiveRunKeyParts,
  isValidCapabilityGrantTransition,
  isValidReleaseWorkflowTransition,
  pendingWakeupProjection,
  StorageCancelledError,
  StorageConflictError,
  StorageRecordError,
  storedCapabilityGrant,
  storedPublicationReference,
  storedReleaseWorkflow,
  validateYuiConfig,
  type ConfiguredAgentPatch,
  type ConfiguredAgentUpdateResult,
  type TaskStore,
  type YuiConfig
} from "./taskStore.js";

/** Options for {@link SqliteTaskStore}. */
export type SqliteTaskStoreOptions = Readonly<{
  /** Override the database filename (defaults to "yui.db"). */
  databaseFilename?: string;
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

/** Read the immutable Home identity without opening a writable Store connection. */
export function readSqliteHomeIdentity(
  rootDir: string,
  databaseFilename = "yui.db"
): HomeIdentity {
  const database = new Database(join(rootDir, databaseFilename), {
    readonly: true,
    fileMustExist: true
  });
  try {
    const row = database.prepare(
      "SELECT home_identity FROM home_meta WHERE id = 1"
    ).get() as { home_identity?: unknown } | undefined;
    if (typeof row?.home_identity !== "string") {
      throw new StorageRecordError("SQLite Home identity is missing.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.home_identity) as unknown;
    } catch {
      throw new StorageRecordError("SQLite Home identity is invalid JSON.");
    }
    return validateHomeIdentity(parsed as HomeIdentity);
  } finally {
    database.close();
  }
}

/** A single telemetry progress row (§4.4). */
export type TelemetryProgress = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  progressId: string;
  sequence?: number;
  payload: unknown;
  receivedAt: string;
}>;

const DEFAULT_CONFIG: YuiConfig = { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION };

function numericCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function latestSqlitePublicationReference(
  references: readonly PublicationReference[]
): PublicationReference {
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const superseded = new Set(
    references
      .map((reference) => reference.supersedes)
      .filter((id): id is string => id !== undefined)
  );
  const roots = references.filter((reference) => !superseded.has(reference.id));
  const latest = roots.length === 1
    ? roots[0]!
    : [...references].sort((left, right) => numericCompare(right.id, left.id))[0]!;
  let current = latest;
  const seen = new Set<string>();
  while (current.supersedes !== undefined) {
    if (seen.has(current.id)) {
      throw new StorageRecordError(`Publication supersession cycle at ${current.id}.`);
    }
    seen.add(current.id);
    const previous = byId.get(current.supersedes);
    if (previous === undefined) {
      throw new StorageRecordError(
        `Publication supersession target not found: ${current.id}/${current.supersedes}.`
      );
    }
    current = previous;
  }
  return latest;
}

/** True when the better-sqlite3 error is a UNIQUE/PRIMARY KEY constraint failure. */
function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    || (error as { code?: string })?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** One admission rule for every active-Turn write path in this store. */
function assertRunAdmission(task: Task | null, run: AgentRun): void {
  if (task === null || !runPurposeAdmitsTaskState(run.purpose, task)) {
    throw new StorageRecordError(`Task execution is not enabled: ${run.taskId}.`);
  }
}

export class SqliteTaskStore implements TaskStore {
  readonly #db: Database.Database;
  readonly #rootDir: string;
  readonly #openedSchemaHead: Readonly<{ version: number; checksum: string }>;
  #inTransaction = false;
  #dirty = false;

  constructor(rootDir: string, _options: SqliteTaskStoreOptions = {}) {
    this.#rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const filename = _options.databaseFilename ?? "yui.db";
    const databasePath = join(rootDir, filename);
    // Remember whether the database file existed before this connection opened
    // it. A store that creates the file is bootstrapping a fresh database and
    // may seed its singleton rows; a store that opens an existing file missing
    // those rows has found corruption, not a bootstrap opportunity.
    const databaseExisted = existsSync(databasePath);
    this.#db = new Database(databasePath);
    try {
      // §4.1 / §9: WAL, no fsync weakening, FKs on, busy timeout for CLI contention.
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("synchronous = FULL");
      this.#db.pragma("foreign_keys = ON");
      this.#db.pragma("busy_timeout = 5000");
      this.#db.pragma("wal_autocheckpoint = 1000");
      migrateSqliteSchema(this.#db, {
        mode: !databaseExisted ? "apply" : "validate"
      });
      const schema = inspectSqliteSchemaMigrations(this.#db);
      this.#openedSchemaHead = {
        version: schema.currentVersion,
        checksum: schema.currentChecksum
      };
      this.#ensureSeedRows(databaseExisted);
    } catch (error) {
      this.#db.close();
      throw error;
    }
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

  /**
   * Guarantee the `home_meta` and `config` singleton rows exist.
   *
   * A fresh database created by this connection is bootstrapped with defaults.
   * An existing database that is missing either row is corrupt —
   * truncated, partially migrated, or hand-edited — and must fail closed
   * instead of silently masking the damage with fresh defaults (Issue 01
   * cross-issue handoff: INSERT OR IGNORE could hide migration corruption).
   */
  #ensureSeedRows(databaseExisted: boolean): void {
    const hasHomeMeta = this.#db.prepare("SELECT 1 FROM home_meta WHERE id = 1").get() !== undefined;
    const hasConfig = this.#db.prepare("SELECT 1 FROM config WHERE id = 1").get() !== undefined;
    if (hasHomeMeta && hasConfig) return;
    if (databaseExisted) {
      const missing = [
        !hasHomeMeta ? "home_meta" : null,
        !hasConfig ? "config" : null
      ].filter((value): value is string => value !== null).join(", ");
      throw new StorageSchemaError(
        "STORAGE_SCHEMA_INVALID",
        `SQLite database is corrupt: required singleton row(s) missing (${missing}). `
        + "The database may be truncated or partially migrated. Restore yui.db from a "
        + "backup, or preserve this Home for diagnosis and initialize a new Home."
      );
    }
    if (!hasHomeMeta) this.#seedHomeMeta();
    if (!hasConfig) this.#seedConfig();
  }

  #seedHomeMeta(): void {
    const now = new Date().toISOString();
    const identity = generateHomeIdentity(new Date());
    this.#db.prepare(
      `INSERT OR IGNORE INTO home_meta
       (id, home_identity, revision, created_at, updated_at)
       VALUES (1, ?, 0, ?, ?)`
    ).run(JSON.stringify(identity), now, now);
  }

  #seedConfig(): void {
    this.#db.prepare(
      `INSERT OR IGNORE INTO config (id, payload, updated_at) VALUES (1, ?, ?)`
    ).run(JSON.stringify(DEFAULT_CONFIG), new Date().toISOString());
  }

  #now(): string { return new Date().toISOString(); }
  #json(value: unknown): string { return JSON.stringify(value); }
  #parse<T>(text: string): T { return JSON.parse(text) as T; }

  queryContextRecords(taskId: string, query: ContextRecordQuery) {
    return queryContextRecords(this.#db, taskId, query);
  }

  contextInputReferences(taskId: string, scope: ContextInputScope) {
    return contextInputReferences(this.#db, taskId, scope);
  }

  listActiveRuns(taskId: string): AgentRun[] {
    return this.#sortById(this.#listPayload<AgentRun>("turns", "task_id = ? AND status = 'active'", [taskId]), run => run.id);
  }

  latestEventSequence(taskId: string): number {
    return (this.#db.prepare(
      "SELECT COALESCE(MAX(CAST(substr(event_id, 7) AS INTEGER)), 0) AS seq FROM events WHERE task_id = ?"
    ).get(taskId) as { seq: number }).seq;
  }

  listEventsByType(taskId: string, types: readonly string[]): TaskEvent[] {
    return this.#sortById(this.#listPayload<TaskEvent>(
      "events", "task_id = ? AND type IN (SELECT value FROM json_each(?))",
      [taskId, JSON.stringify(types)]
    ), event => event.id);
  }

  /** Delivery needs original workspace bases, never complete Run reports. */
  listTaskRunWorkspaceBases(taskId: string): Pick<AgentRun, "id" | "createdAt" | "workspace">[] {
    return (this.#db.prepare(`SELECT json_object(
      'id', turn_id, 'createdAt', json_extract(payload, '$.createdAt'),
      'workspace', json_extract(payload, '$.workspace')) AS payload
      FROM turns WHERE task_id = ? AND json_extract(payload, '$.workspace.owner.type') = 'task'`
    ).all(taskId) as { payload: string }[]).map(row => JSON.parse(row.payload));
  }

  /** A pinned read snapshot never reserves the database's single writer slot.
   * Nested reads share an existing transaction; standalone reads also prohibit
   * accidental writes at SQLite's boundary.
   */
  readTransaction<T>(execute: (store: TaskStore) => T): T {
    if (this.#inTransaction) return execute(this);
    const previous = this.#db.pragma("query_only", { simple: true });
    this.#db.pragma("query_only = ON");
    this.#db.exec("BEGIN");
    this.#inTransaction = true;
    try {
      this.#prepareWrite();
      const result = execute(this);
      this.#commit();
      return result;
    } catch (error) {
      this.#rollback();
      throw error;
    } finally {
      this.#db.pragma(`query_only = ${previous === 1 ? "ON" : "OFF"}`);
    }
  }

  /** Diagnostic worker write; deliberately outside Task revision/outbox state. */
  flushTelemetry(entries: readonly TelemetryProgressEntry[], runCap: number): void {
    this.#prepareWrite();
    writeTelemetryBatch(this.#db, entries, runCap);
  }

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

  /** Verify the SQLite schema head at the single write boundary. */
  #prepareWrite(): void {
    const current = this.#db.prepare(
      "SELECT version, checksum FROM schema_migrations ORDER BY version DESC LIMIT 1"
    ).get() as { version?: unknown; checksum?: unknown } | undefined;
    if (
      current?.version !== this.#openedSchemaHead.version
      || current.checksum !== this.#openedSchemaHead.checksum
    ) {
      throw new SqliteSchemaMigrationError(
        `open Store schema head ${this.#openedSchemaHead.version}/${this.#openedSchemaHead.checksum} `
          + `changed to ${String(current?.version)}/${String(current?.checksum)}; `
          + "reopen the Store with the active Yui version before writing",
        "admission"
      );
    }
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
    this.#begin();
    try {
      this.#prepareWrite();
      const result = fn();
      this.#bumpRevision();
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
      // Pin the Store's validated schema generation before user code runs.
      // This prevents a long-lived Store from executing SQL after the database
      // schema head has changed underneath it.
      this.#prepareWrite();
      const result = run(this);
      if (this.#dirty) {
        if (options?.requestId !== undefined) {
          this.#insertOutbox(options.requestId, options.outboxCommand ?? null);
        }
        this.#bumpRevision();
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
   * remains open across the awaited callback, preserving the single-writer
   * boundary. */
  async transactionAsync<T>(execute: (store: TaskStore) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return execute(this);
    this.#begin();
    try {
      this.#prepareWrite();
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
    if (this.#inTransaction) {
      const current = this.getRevision();
      if (current !== expectedRevision) {
        throw new StorageConflictError(
          `Storage revision conflict (expected ${expectedRevision}, found ${current}).`, current
        );
      }
      return execute(this);
    }
    this.#begin();
    try {
      const current = this.getRevision();
      if (current !== expectedRevision) {
        throw new StorageConflictError(
          `Storage revision conflict (expected ${expectedRevision}, found ${current}).`,
          current
        );
      }
      const result = execute(this);
      if (this.#dirty) {
        this.#prepareWrite();
        if (options?.requestId !== undefined) {
          this.#insertOutbox(options.requestId, options.outboxCommand ?? null);
        }
        this.#bumpRevision();
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
      if (options.expectedRevision !== undefined && this.getRevision() !== options.expectedRevision) {
        throw new StorageConflictError("Storage revision conflict.", this.getRevision());
      }
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
            `Storage revision conflict (expected ${options.expectedRevision}, found ${current}).`,
            current
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
        this.#bumpRevision();
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

  // -- generic payload helpers ------------------------------------------------

  #getPayload<T>(table: string, where: string, params: readonly unknown[]): T | null {
    const row = this.#db.prepare(`SELECT payload FROM ${table} WHERE ${where}`).get(...params) as { payload: string } | undefined;
    return row === undefined ? null : this.#validateTaskPayload<T>(table, row.payload);
  }

  #listPayload<T>(table: string, where: string, params: readonly unknown[]): T[] {
    const rows = this.#db.prepare(`SELECT payload FROM ${table} WHERE ${where}`).all(...params) as Array<{ payload: string }>;
    return rows.map((row) => this.#validateTaskPayload<T>(table, row.payload));
  }

  #validateTaskPayload<T>(table: string, payload: string): T {
    const record = this.#parse<T>(payload);
    if (table === "task_records") validateTask(record as Task);
    if (table === "work_items") validateWorkItem(record as WorkItem);
    // Agents and Roles carry the execution component, and their validators
    // refuse a record that lost it. Reading them unchecked defeated that: a
    // component-less row reached display and rendered `undefined` as if it
    // were a product, and reached launch as a binding nothing had vetted.
    if (table === "configured_agents") validateConfiguredAgent(record as ConfiguredAgent);
    if (table === "task_roles") validateTaskRole(record as TaskRole);
    if (table === "global_roles") validateGlobalRole(record as GlobalRole);
    if (table === "global_role_messages") validateGlobalRoleMessage(record as GlobalRoleMessage);
    return record;
  }

  #sortById<T>(rows: T[], idOf: (row: T) => string): T[] {
    return [...rows].sort((left, right) => numericCompare(idOf(left), idOf(right)));
  }

  // -- config / identity ------------------------------------------------------

  getConfig(): YuiConfig {
    const row = this.#db.prepare("SELECT payload FROM config WHERE id = 1").get() as { payload: string };
    const config = this.#parse<YuiConfig>(row.payload);
    // Fail closed on malformed durable config, matching the File store:
    // GC mode and other settings must never silently fall back to defaults.
    validateYuiConfig(config);
    return config;
  }

  saveConfig(config: YuiConfig): void {
    validateYuiConfig(config);
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

  savePluginValidation(validation: PluginValidation): void {
    validatePluginValidation(validation);
    this.#mutate(() => {
      const previous = this.getPluginValidation(validation.taskId, validation.id);
      if (previous !== null) {
        if (!isDeepStrictEqual(previous, validation)) throw new StorageRecordError("Plugin validation is immutable.");
        return;
      }
      this.#db.prepare("INSERT INTO plugin_validations (task_id, id, payload) VALUES (?, ?, ?)")
        .run(validation.taskId, validation.id, this.#json(validation));
    });
  }

  savePluginIntent(intent: PluginIntent): void {
    validatePluginIntent(intent);
    this.#mutate(() => {
      const previous = this.getPluginIntent(intent.taskId, intent.pluginId);
      if (intent.revision !== (previous?.revision ?? 0) + 1 || intent.lastFailure !== undefined) {
        throw new StorageRecordError("Plugin intent must be a new explicit choice without historical failure.");
      }
      if (intent.validationId !== undefined) {
        const validation = this.getPluginValidation(intent.taskId, intent.validationId);
        if (validation?.package.manifest.id !== intent.pluginId) throw new StorageRecordError("Plugin validation is outside this intent.");
      }
      this.#db.prepare(`INSERT INTO plugin_intents (task_id, plugin_id, payload) VALUES (?, ?, ?)
        ON CONFLICT(task_id, plugin_id) DO UPDATE SET payload = excluded.payload`)
        .run(intent.taskId, intent.pluginId, this.#json(intent));
    });
  }

  getPluginIntent(taskId: string, pluginId: string): PluginIntent | null {
    const value = this.#getPayload<PluginIntent>("plugin_intents", "task_id = ? AND plugin_id = ?", [taskId, pluginId]);
    return value === null ? null : validatePluginIntent(value);
  }

  listPluginIntents(taskId: string): PluginIntent[] {
    return this.#listPayload<PluginIntent>("plugin_intents", "task_id = ?", [taskId]).map(validatePluginIntent);
  }

  recordPluginIntentFailure(taskId: string, pluginId: string, revision: number, failure: PluginIntentFailure): boolean {
    validatePluginIntentFailure(failure);
    return this.transaction(() => {
      const current = this.getPluginIntent(taskId, pluginId);
      if (current === null || current.revision !== revision) return false;
      this.#mutate(() => {
        this.#db.prepare("UPDATE plugin_intents SET payload = ? WHERE task_id = ? AND plugin_id = ?")
          .run(this.#json({ ...current, lastFailure: failure }), taskId, pluginId);
      });
      return true;
    });
  }

  getPluginValidation(taskId: string, id: string): PluginValidation | null {
    const value = this.#getPayload<PluginValidation>("plugin_validations", "task_id = ? AND id = ?", [taskId, id]);
    return value === null ? null : validatePluginValidation(value);
  }

  saveLocalResource(resource: LocalResource): void {
    validateLocalResource(resource);
    this.#mutate(() => {
      const previous = this.getLocalResource(resource.id);
      if (previous !== null) {
        if (!isDeepStrictEqual(previous, resource)) throw new StorageRecordError("Resource identity is immutable.");
        return;
      }
      this.#db.prepare("INSERT INTO local_resources (id, canonical_identity, payload) VALUES (?, ?, ?)")
        .run(resource.id, `${resource.device}:${resource.inode}`, this.#json(resource));
    });
  }

  getLocalResource(resourceId: string): LocalResource | null {
    const resource = this.#getPayload<LocalResource>("local_resources", "id = ?", [resourceId]);
    return resource === null ? null : validateLocalResource(resource);
  }

  listLocalResources(): LocalResource[] {
    return this.#listPayload<LocalResource>("local_resources", "1=1", []).map(validateLocalResource);
  }

  saveEnvironmentPreparation(preparation: EnvironmentPreparation): void {
    validateEnvironmentPreparation(preparation);
    this.#mutate(() => {
      const previous = this.getEnvironmentPreparation(preparation.taskId, preparation.id);
      if (previous) {
        const { disposition: before, updatedAt: _beforeTime, releaseEvidence: _beforeEvidence, ...identity } = previous;
        const { disposition: after, updatedAt: _afterTime, releaseEvidence: _afterEvidence, ...nextIdentity } = preparation;
        if (!isDeepStrictEqual(identity, nextIdentity)
          || (before === "released" && !isDeepStrictEqual(previous, preparation))
          || (before === "adopted" && after === "prepared")) {
          throw new StorageRecordError("Preparation ownership/identity cannot be rewritten.");
        }
      } else if (preparation.disposition !== "prepared") {
        throw new StorageRecordError("Environment must be prepared before adoption.");
      }
      this.#db.prepare(`INSERT INTO environment_preparations (task_id, id, payload) VALUES (?, ?, ?)
        ON CONFLICT(task_id, id) DO UPDATE SET payload = excluded.payload`)
        .run(preparation.taskId, preparation.id, this.#json(preparation));
    });
  }

  getEnvironmentPreparation(taskId: string, preparationId: string): EnvironmentPreparation | null {
    const preparation = this.#getPayload<EnvironmentPreparation>("environment_preparations",
      "task_id = ? AND id = ?", [taskId, preparationId]);
    return preparation === null ? null : validateEnvironmentPreparation(preparation);
  }

  listEnvironmentPreparations(taskId: string): EnvironmentPreparation[] {
    return this.#listPayload<EnvironmentPreparation>("environment_preparations", "task_id = ?", [taskId])
      .map(validateEnvironmentPreparation);
  }

  nextProjectId(): string { return this.#nextGlobalId("project"); }

  saveProject(project: Project): void {
    validateProject(project);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO projects (id, name, path, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(project.id, project.name, project.path, this.#json(project), project.createdAt, project.updatedAt);
    });
  }

  createProjectIfAbsent(project: Project): Project | null {
    validateProject(project);
    return this.#mutate(() => {
      const result = this.#db.prepare(
        "INSERT OR IGNORE INTO projects (id, name, path, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(project.id, project.name, project.path, this.#json(project), project.createdAt, project.updatedAt);
      return result.changes > 0 ? project : null;
    });
  }

  listProjects(): Project[] {
    return this.#sortById(this.#listPayload<Project>("projects", "1=1", []).map(validateProject), (project) => project.id);
  }

  getProject(id: string): Project | null {
    const project = this.#getPayload<Project>("projects", "id = ?", [id]);
    return project === null ? null : validateProject(project);
  }

  removeProject(id: string): boolean {
    return this.#mutate(() => {
      if (this.listTasks().some((task) => task.projectBindings.some(
        (binding) => binding.projectId === id
      ))) {
        throw new StorageRecordError(`Project is still used by a Task: ${id}`);
      }
      return this.#db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
    });
  }

  summarizeProjectReferences(projectId: string): ProjectReferenceSummary {
    const boundTasks = this.listTasks().filter((task) =>
      task.projectBindings.some((binding) => binding.projectId === projectId)
    );
    const activeTasks = boundTasks.filter((task) => task.status === "active");
    const unresolvedWorkItemRefs: string[] = [];
    const activeRunRefs: string[] = [];
    const unresolvedIntegrationRefs: string[] = [];
    for (const task of activeTasks) {
      for (const workItem of this.listWorkItems(task.id)) {
        if (workItem.status !== "accepted" && workItem.status !== "retired") {
          unresolvedWorkItemRefs.push(`${task.id}/${workItem.id}`);
        }
      }
      for (const run of this.listRuns(task.id)) {
        if (run.status === "active") activeRunRefs.push(`${task.id}/${run.id}`);
      }
      for (const attempt of this.listIntegrationAttempts(task.id)) {
        if (["running", "blocked", "conflicted", "validating"].includes(attempt.status)) {
          unresolvedIntegrationRefs.push(`${task.id}/${attempt.id}`);
        }
      }
    }
    return {
      projectId,
      boundTaskIds: boundTasks.map(({ id }) => id),
      activeTaskIds: activeTasks.map(({ id }) => id),
      unresolvedWorkItemRefs,
      activeRunRefs,
      unresolvedIntegrationRefs
    };
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
        this.#saveRuntimeSessionCandidate(sessions);
      } else {
        this.#db.prepare(
          "DELETE FROM global_role_session_sets WHERE name = ?"
        ).run(role.name);
        this.#deleteRuntimeSessionCandidate({ scope: "global", roleName: role.name });
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
    return this.#mutate(() => {
      this.#deleteRuntimeSessionCandidate({ scope: "global", roleName: name });
      this.#db.prepare("DELETE FROM global_role_session_sets WHERE name = ?").run(name);
      return this.#db.prepare("DELETE FROM global_roles WHERE name = ?").run(name).changes > 0;
    });
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
      this.#saveRuntimeSessionCandidate(sessions);
    });
  }

  // -- global role messages ---------------------------------------------------

  nextGlobalRoleMessageId(): string { return this.#nextGlobalId("global-message"); }

  saveGlobalRoleMessage(message: GlobalRoleMessage): void {
    validateGlobalRoleMessage(message);
    this.#requireGlobalRole(message.roleName);
    this.#mutate(() => {
      const seq = this.#globalMessageSequence(message.id);
      this.#db.prepare(
        `INSERT INTO global_role_messages (name, message_id, seq, payload, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(message.roleName, message.id, seq, this.#json(message), message.createdAt);
    });
  }

  listGlobalRoleMessages(roleName: string): GlobalRoleMessage[] {
    return this.#sortById(
      this.#listPayload<GlobalRoleMessage>("global_role_messages", "name = ?", [roleName]),
      (message) => message.id
    );
  }

  updateGlobalRoleMessage(message: GlobalRoleMessage): void {
    validateGlobalRoleMessage(message);
    this.#requireGlobalRole(message.roleName);
    this.#mutate(() => {
      const seq = this.#globalMessageSequence(message.id);
      const result = this.#db.prepare(
        `UPDATE global_role_messages SET seq = ?, payload = ? WHERE name = ? AND message_id = ?`
      ).run(seq, this.#json(message), message.roleName, message.id);
      if (result.changes === 0) {
        throw new StorageRecordError(`Global message not found: ${message.roleName}/${message.id}`);
      }
    });
  }

  #requireGlobalRole(name: string): void {
    const row = this.#db.prepare("SELECT 1 FROM global_roles WHERE name = ?").get(name);
    if (row === undefined) throw new StorageRecordError(`Global Role not found: ${name}`);
  }

  /** A Global message id is `global-message-<n>`; its numeric tail is its seq. */
  #globalMessageSequence(id: string): number {
    const match = /^global-message-([1-9]\d*)$/.exec(id);
    if (match === null) throw new StorageRecordError(`Global message id is invalid: ${id}`);
    return Number(match[1]);
  }

  // -- tasks ------------------------------------------------------------------

  nextTaskId(): string { return this.#nextGlobalId("task"); }

  saveTask(task: Task): void {
    validateTask(task);
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new StorageRecordError("Task id is required.");
    }
    this.#mutate(() => {
      for (const binding of task.projectBindings) {
        const found = this.#db.prepare("SELECT 1 FROM projects WHERE id = ?").get(binding.projectId);
        if (found === undefined) throw new StorageRecordError(`Task Project not found: ${binding.projectId}`);
      }
      const isActive = task.status === "active" && task.executionGate.state === "enabled" ? 1 : 0;
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

  queryTaskCatalog(query: TaskCatalogQuery) {
    return queryTaskCatalog(this.#db, query);
  }

  listTaskChoices(): Pick<Task, "id" | "title" | "status">[] {
    const rows = this.#db.prepare(`SELECT c.task_id AS id, c.status,
      json_extract(r.payload, '$.title') AS title
      FROM tasks_catalog c JOIN task_records r ON r.task_id = c.task_id`).all() as Pick<Task, "id" | "title" | "status">[];
    return this.#sortById(rows, task => task.id);
  }

  getTask(id: string): Task | null {
    return this.#getPayload<Task>("task_records", "task_id = ?", [id]);
  }

  readNextActionFacts(taskId: string): NextActionFacts | null {
    const task = this.#getPayload<Task>("task_records", "task_id = ?", [taskId]);
    if (task === null) return null;
    // One indexed query (idx_turns_role_status) covers both the active
    // AgentRuns the projection waits on and the Leader AgentRuns the budget consumes.
    const events = this.#sortById(
      this.#listPayload<TaskEvent>(
        "events",
        "task_id = ? AND type IN (?, ?)",
        [
          taskId,
          TASK_RECORD_RETIRED_EVENT,
          "review.completed"
        ]
      ),
      (event) => event.id
    );
    const runs = operationalTaskRecords(this.#sortById(
      this.#listPayload<AgentRun>(
        "turns",
        "task_id = ? AND (status = 'active' OR role_name = 'leader')",
        [taskId]
      ),
      (run) => run.id
    ), events, "run");
    return {
      task: {
        id: task.id,
        status: task.status,
        executionGate: task.executionGate,
        projectBindings: task.projectBindings,
        type: task.type
      },
      workItems: this.#sortById(
        this.#listPayload<WorkItem>("work_items", "task_id = ?", [taskId]),
        (item) => item.id
      ),
      changeSets: this.#sortById(
        this.#listPayload<ChangeSet>("change_sets", "task_id = ?", [taskId]),
        (changeSet) => changeSet.id
      ),
      integrations: this.#sortById(
        this.#listPayload<IntegrationAttempt>("integration_attempts", "task_id = ?", [taskId]),
        (attempt) => attempt.id
      ),
      integrationJobs: this.listDurableJobs(taskId)
        .filter(job => job.owner.kind === "integration-attempt")
        .map(job => ({ id: job.id, status: job.status })),
      integrationQueueEntries: this.#sortById(
        this.#listPayload<IntegrationQueueEntry>(
          "integration_queue",
          "task_id = ?",
          [taskId]
        ),
        (entry) => entry.id
      ),
      reviewRounds: this.#sortById(
        this.#listPayload<ReviewRound>("review_rounds", "task_id = ?", [taskId]),
        (round) => round.id
      ),
      reviewConfig: this.getReviewConfig(),
      openInputRequests: this.#sortById(
        this.#listPayload<InputRequest>(
          "input_requests",
          "task_id = ? AND status = 'open'",
          [taskId]
        ),
        (request) => request.id
      ),
      activeRuns: runs.filter((run) => run.status === "active"),
      leaderRuns: runs.filter((run) => run.roleName === "leader"),
      reviewOutcomeEvidence: {
        runs: this.#sortById(
          this.#listPayload<AgentRun>(
            "turns",
            "task_id = ?",
            [taskId]
          ).filter((run) => run.purpose === "review"),
          (run) => run.id
        )
      }
    };
  }

  readCompletionReadinessFacts(taskId: string): CompletionReadinessFacts | null {
    const base = this.readNextActionFacts(taskId);
    if (base === null) return null;
    return {
      ...base,
      pendingUserMessages: pendingCompletionMessages(this, taskId),
      managedWorkspaces: this.#sortById(
        this.#listPayload<ManagedWorkspace>("managed_workspaces", "task_id = ?", [taskId]),
        (workspace) => managedWorkspaceKey(workspace.owner)
      ),
      durableJobs: this.#sortById(
        this.#listPayload<DurableJob>("durable_jobs", "task_id = ?", [taskId]),
        (job) => job.id
      ),
      integrationQueueEntries: this.#sortById(
        this.#listPayload<IntegrationQueueEntry>(
          "integration_queue",
          "task_id = ?",
          [taskId]
        ),
        (entry) => entry.id
      ),
    };
  }

  /** Task ids flagged active in the catalog projection (the global active index). */
  listActiveTaskIds(): string[] {
    const rows = this.#db.prepare(
      "SELECT task_id FROM tasks_catalog WHERE is_active = 1 ORDER BY task_id"
    ).all() as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  /**
   * Draft Task ids that carry an active planning Turn.
   *
   * Bounded by the active-Turn pointers rather than Task history: a Draft
   * appears only while one of its Roles actually holds an admitted planning
   * Turn, so an ordinary Draft is never selected for execution phases.
   */
  listPlanningDraftTaskIds(): string[] {
    const rows = this.#db.prepare(
      `SELECT DISTINCT catalog.task_id AS task_id
         FROM tasks_catalog AS catalog
         JOIN active_turns AS pointers ON pointers.task_id = catalog.task_id
         JOIN turns ON turns.task_id = pointers.task_id AND turns.turn_id = pointers.turn_id
        WHERE catalog.status = 'draft'
          AND turns.status = 'active'
          AND json_extract(turns.payload, '$.purpose') = 'planning'
        ORDER BY catalog.task_id`
    ).all() as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  listPendingActivationRequestTaskIds(): string[] {
    const rows = this.#db.prepare(
      `SELECT records.task_id AS task_id
         FROM task_records AS records
         JOIN tasks_catalog AS catalog ON catalog.task_id = records.task_id
        WHERE catalog.status = 'draft'
          AND json_extract(records.payload, '$.activationRequest.disposition') = 'pending'
        ORDER BY records.task_id`
    ).all() as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  getTaskBrief(taskId: string): TaskBrief | null {
    const row = this.#db.prepare("SELECT brief FROM task_records WHERE task_id = ?").get(taskId) as { brief: string | null } | undefined;
    if (row === undefined || row.brief === null) return null;
    return validateTaskBrief(this.#parse<TaskBrief>(row.brief));
  }

  saveTaskBrief(taskId: string, brief: TaskBrief): void {
    validateTaskBrief(brief);
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

  listActiveDurableJobs(): DurableJob[] {
    return this.#sortById(
      this.#listPayload<DurableJob>(
        "durable_jobs",
        "status IN ('queued', 'running')",
        []
      ),
      (job) => `${job.taskId}/${job.id}`
    );
  }

  hasActiveDurableJobs(): boolean {
    const row = this.#db.prepare(
      "SELECT 1 FROM durable_jobs WHERE status IN ('queued', 'running') LIMIT 1"
    ).get() as { 1: number } | undefined;
    return row !== undefined;
  }

  // -- session owners (Issue 03) ----------------------------------------------

  saveSessionOwner(identity: SessionOwnerIdentity): void {
    const owner = identity.owner;
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO session_owners
           (process_key, scope, task_id, role_name, agent_id, native_session_id,
            provider_root_pid, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(process_key) DO UPDATE SET
           scope = excluded.scope, task_id = excluded.task_id,
           role_name = excluded.role_name, agent_id = excluded.agent_id,
           native_session_id = excluded.native_session_id,
           provider_root_pid = excluded.provider_root_pid,
           payload = excluded.payload, recorded_at = excluded.recorded_at`
      ).run(
        sessionOwnerProcessKey(identity),
        owner.scope,
        owner.scope === "task" ? owner.taskId : null,
        owner.roleName,
        identity.agentId,
        identity.nativeSessionId ?? null,
        identity.providerRoot.pid,
        this.#json(identity),
        identity.recordedAt
      );
    });
  }

  getSessionOwner(processKey: string): SessionOwnerIdentity | null {
    const row = this.#db.prepare(
      "SELECT payload FROM session_owners WHERE process_key = ?"
    ).get(processKey) as { payload: string } | undefined;
    return row === undefined ? null : this.#parse<SessionOwnerIdentity>(row.payload);
  }

  listSessionOwners(): SessionOwnerIdentity[] {
    return this.#listPayload<SessionOwnerIdentity>(
      "session_owners", "1=1", []
    ).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  }

  listSessionOwnersForOwner(owner: RuntimeOwner): SessionOwnerIdentity[] {
    if (owner.scope === "global") {
      return this.#listPayload<SessionOwnerIdentity>(
        "session_owners", "scope = 'global' AND role_name = ?", [owner.roleName]
      );
    }
    return this.#listPayload<SessionOwnerIdentity>(
      "session_owners", "scope = 'task' AND task_id = ? AND role_name = ?",
      [owner.taskId, owner.roleName]
    );
  }

  removeSessionOwner(processKey: string): void {
    this.#mutate(() => {
      this.#db.prepare("DELETE FROM session_owners WHERE process_key = ?").run(processKey);
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
      this.#saveRuntimeSessionCandidate(sessions);
    });
  }

  removeTaskRole(taskId: string, name: string): boolean {
    return this.#mutate(() => {
      this.#deleteRuntimeSessionCandidate({
        scope: "task",
        taskId,
        roleName: name
      });
      this.#db.prepare(
        "DELETE FROM role_session_sets WHERE task_id = ? AND role_name = ?"
      ).run(taskId, name);
      this.#db.prepare(
        "DELETE FROM pending_runtime_turn_completions WHERE task_id = ? AND role_name = ?"
      ).run(taskId, name);
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

  listProviderRetrySessions(): (TaskRoleSessionSet | GlobalRoleSessionSet)[] {
    const pending = "json_extract(payload, '$.providerBinding.retry.status') IN ('waiting', 'in-flight')";
    return [
      ...this.#listPayload<TaskRoleSessionSet>("role_session_sets", pending, []),
      ...this.#listPayload<GlobalRoleSessionSet>("global_role_session_sets", pending, [])
    ];
  }

  listRuntimeSessionCandidates(query: RuntimeSessionCandidateQuery = {}): RuntimeSessionCandidate[] {
    const taskIds = query.taskIds === undefined
      ? undefined
      : [...new Set(query.taskIds)].sort(numericCompare);
    if (taskIds?.length === 0 || (taskIds !== undefined && query.scope === "global")) {
      return [];
    }
    const predicates: string[] = [];
    const parameters: string[] = [];
    if (taskIds !== undefined) {
      predicates.push("scope = 'task'");
      predicates.push(`task_id IN (${taskIds.map(() => "?").join(", ")})`);
      parameters.push(...taskIds);
    } else if (query.scope !== undefined) {
      predicates.push("scope = ?");
      parameters.push(query.scope);
    }
    const where = predicates.length === 0
      ? ""
      : ` WHERE ${predicates.join(" AND ")}`;
    const rows = this.#db.prepare(
      `SELECT scope, task_id, role_name, agent_id, adapter_id,
              native_session_id, session_updated_at
       FROM runtime_session_candidates${where}`
    ).all(...parameters) as Array<{
      scope: "task" | "global";
      task_id: string;
      role_name: string;
      agent_id: string;
      adapter_id: string;
      native_session_id: string;
      session_updated_at: string;
    }>;
    const candidates = rows.map((row): RuntimeSessionCandidate => ({
      owner: row.scope === "task"
        ? { scope: "task", taskId: row.task_id, roleName: row.role_name }
        : { scope: "global", roleName: row.role_name },
      agentId: row.agent_id,
      adapterId: row.adapter_id,
      nativeSessionId: row.native_session_id,
      sessionUpdatedAt: row.session_updated_at
    })).sort(compareRuntimeSessionCandidates);
    for (const candidate of candidates) {
      if (!this.#runtimeSessionCandidateMatchesSource(candidate)) {
        throw new StorageRecordError(
          `Runtime Session projection is inconsistent: ${
            candidate.owner.scope === "task"
              ? `${candidate.owner.taskId}/${candidate.owner.roleName}`
              : `global/${candidate.owner.roleName}`
          }.`
        );
      }
    }
    return candidates;
  }

  /**
   * Compare the hot projection with the authoritative current Session without
   * parsing or validating the RoleSessionSet aggregate.  In particular, the
   * historical `history` field must never enter this cleanup discovery path:
   * JSON1 reads only the active Agent object selected by `activeAgentId`.
   */
  #runtimeSessionCandidateMatchesSource(candidate: RuntimeSessionCandidate): boolean {
    const source = candidate.owner.scope === "task"
      ? {
          table: "role_session_sets",
          where: "task_id = ? AND role_name = ?",
          parameters: [candidate.owner.taskId, candidate.owner.roleName]
        }
      : {
          table: "global_role_session_sets",
          where: "name = ?",
          parameters: [candidate.owner.roleName]
        };
    type SourceRow = {
      owner_scope: string | null;
      owner_task_id: string | null;
      owner_role_name: string | null;
      active_agent_id: string | null;
      agent_id: string | null;
      adapter_id: string | null;
      native_session_id: string | null;
      is_active: 0 | 1 | null;
      session_updated_at: string | null;
    };
    let row: SourceRow | undefined;
    try {
      row = this.#db.prepare(
        `WITH source AS (
           SELECT payload,
                  json_extract(payload, '$.activeAgentId') AS active_agent_id
           FROM ${source.table}
           WHERE ${source.where}
         ), active AS (
           SELECT payload,
                  active_agent_id,
                  json_extract(
                    payload,
                    '$.sessions.' || json_quote(active_agent_id)
                  ) AS active_session
           FROM source
         )
         SELECT
           json_extract(payload, '$.owner.scope') AS owner_scope,
           json_extract(payload, '$.owner.taskId') AS owner_task_id,
           json_extract(payload, '$.owner.roleName') AS owner_role_name,
           active_agent_id,
           json_extract(active_session, '$.agentId') AS agent_id,
           json_extract(active_session, '$.adapterId') AS adapter_id,
           json_extract(active_session, '$.nativeSessionId') AS native_session_id,
           CASE
             WHEN json_extract(active_session, '$.status') = 'active'
             THEN 1 ELSE 0
           END AS is_active,
           json_extract(active_session, '$.updatedAt') AS session_updated_at
         FROM active`
      ).get(...source.parameters) as SourceRow | undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new StorageRecordError(
        `Runtime Session projection source is invalid for ${
          candidate.owner.scope === "task"
            ? `${candidate.owner.taskId}/${candidate.owner.roleName}`
            : `global/${candidate.owner.roleName}`
        }: ${detail}`
      );
    }
    if (row === undefined) return false;
    return row.owner_scope === candidate.owner.scope && row.owner_task_id === (
        candidate.owner.scope === "task" ? candidate.owner.taskId : null
      ) && row.owner_role_name === candidate.owner.roleName && row.active_agent_id === candidate.agentId && row.agent_id === candidate.agentId && row.adapter_id === candidate.adapterId && row.native_session_id === candidate.nativeSessionId && row.is_active === 1 && row.session_updated_at === candidate.sessionUpdatedAt;
  }


  saveRoleSessionSet(sessions: TaskRoleSessionSet): void {
    const taskId = sessions.owner.taskId;
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO role_session_sets (task_id, role_name, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, role_name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, sessions.owner.roleName, this.#json(sessions), this.#now());
      this.#saveRuntimeSessionCandidate(sessions);
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

  #saveRuntimeSessionCandidate(
    sessions: TaskRoleSessionSet | GlobalRoleSessionSet
  ): void {
    const candidate = projectRuntimeSessionCandidate(sessions);
    if (candidate === null) {
      this.#deleteRuntimeSessionCandidate(sessions.owner);
      return;
    }
    const taskId = candidate.owner.scope === "task" ? candidate.owner.taskId : "";
    this.#db.prepare(
      `INSERT INTO runtime_session_candidates (
         scope, task_id, role_name, agent_id, adapter_id, native_session_id,
         session_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, task_id, role_name) DO UPDATE SET
         agent_id = excluded.agent_id,
         adapter_id = excluded.adapter_id,
         native_session_id = excluded.native_session_id,
         session_updated_at = excluded.session_updated_at`
    ).run(
      candidate.owner.scope,
      taskId,
      candidate.owner.roleName,
      candidate.agentId,
      candidate.adapterId,
      candidate.nativeSessionId,
      candidate.sessionUpdatedAt
    );
  }

  #deleteRuntimeSessionCandidate(owner: RuntimeOwner): void {
    this.#db.prepare(
      `DELETE FROM runtime_session_candidates
       WHERE scope = ? AND task_id = ? AND role_name = ?`
    ).run(
      owner.scope,
      owner.scope === "task" ? owner.taskId : "",
      owner.roleName
    );
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
    validateWorkItem(item);
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

  // -- publication references -------------------------------------------------

  nextPublicationReferenceId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "publicationReference");
  }

  savePublicationReference(taskId: string, reference: PublicationReference): void {
    const stored = storedPublicationReference(reference);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Publication reference belongs to another Task: ${stored.taskId}`);
    }
    this.#requireTask(taskId);
    this.#mutate(() => {
      const key = publicationExternalKey(stored);
      const existing = this.#getPayload<PublicationReference>(
        "publication_references",
        "task_id = ? AND publication_id = ?",
        [taskId, stored.id]
      );
      if (existing !== null && !isDeepStrictEqual(existing, stored)) {
        throw new StorageRecordError(
          `Publication reference cannot be overwritten: ${taskId}/${stored.id}`
        );
      }
      if (existing === null) {
        const sameExternal = this.#listPayload<PublicationReference>(
          "publication_references",
          "external_key = ?",
          [key]
        );
        const otherTask = sameExternal.find((candidate) => candidate.taskId !== taskId);
        if (otherTask !== undefined) {
          throw new StorageRecordError(
            `Publication external identity already belongs to Task ${otherTask.taskId}: ${key}.`
          );
        }
        if (sameExternal.length > 0) {
          const latest = latestSqlitePublicationReference(sameExternal);
          if (stored.supersedes !== latest.id) {
            throw new StorageRecordError(
              `Publication external identity conflicts with current record ${latest.id}: ${key}.`
            );
          }
        } else if (stored.supersedes !== undefined) {
          throw new StorageRecordError(
            `Publication supersedes target has a different external identity: ${stored.supersedes}.`
          );
        }
      }
      this.#db.prepare(
        `INSERT INTO publication_references
           (task_id, publication_id, project_id, provider, repository, external_kind,
            external_id, external_key, state, verification, external_url, local_commit,
            remote_commit, supersedes, payload, merged_at, created_at,
            title, source_branch, target_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, publication_id) DO UPDATE SET payload = excluded.payload`
      ).run(
        taskId,
        stored.id,
        stored.projectId,
        stored.provider,
        stored.repository,
        stored.externalKind,
        stored.externalId,
        key,
        stored.state,
        stored.verification,
        stored.externalUrl ?? null,
        stored.localCommit ?? null,
        stored.remoteCommit ?? null,
        stored.supersedes ?? null,
        this.#json(stored),
        stored.mergedAt ?? null,
        this.#now(),
        stored.title ?? null,
        stored.sourceBranch ?? null,
        stored.targetBranch ?? null
      );
    });
  }

  listPublicationReferences(taskId: string): PublicationReference[] {
    return this.#sortById(
      this.#listPayload<PublicationReference>("publication_references", "task_id = ?", [taskId]),
      (reference) => reference.id
    );
  }

  getPublicationReference(taskId: string, referenceId: string): PublicationReference | null {
    return this.#getPayload<PublicationReference>(
      "publication_references",
      "task_id = ? AND publication_id = ?",
      [taskId, referenceId]
    );
  }

  findPublicationReferenceByExternalKey(externalKey: string): PublicationReference | null {
    const matches = this.#listPayload<PublicationReference>(
      "publication_references",
      "external_key = ?",
      [externalKey]
    );
    return matches.length === 0 ? null : latestSqlitePublicationReference(matches);
  }

  // -- gate artifacts (Issue 08) ----------------------------------------------

  saveGateArtifact(artifact: GateArtifact, logs: ReadonlyMap<string, Buffer>): void {
    validateGateArtifact(artifact);
    this.#mutate(() => {
      const targetRef = artifact.boundary?.targetRef ?? null;
      const completedAt = artifact.completedAt ?? null;
      this.#db.prepare(
        `INSERT INTO gate_artifacts
           (key, project_id, level, commit_sha, plan_digest, toolchain_digest,
            target_ref, status, outcome, payload, created_at, completed_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           project_id = excluded.project_id,
           level = excluded.level,
           commit_sha = excluded.commit_sha,
           plan_digest = excluded.plan_digest,
           toolchain_digest = excluded.toolchain_digest,
           target_ref = excluded.target_ref,
           status = excluded.status,
           outcome = excluded.outcome,
           payload = excluded.payload,
           completed_at = excluded.completed_at,
           last_used_at = excluded.last_used_at`
      ).run(
        artifact.key,
        artifact.projectId,
        artifact.level,
        artifact.commit,
        artifact.planDigest,
        artifact.toolchainDigest,
        targetRef,
        artifact.status,
        artifact.outcome,
        this.#json(artifact),
        artifact.createdAt,
        completedAt,
        artifact.lastUsedAt
      );
      // Replace all logs for this artifact in the same transaction.
      this.#db.prepare("DELETE FROM gate_artifact_logs WHERE artifact_key = ?").run(artifact.key);
      const insertLog = this.#db.prepare(
        `INSERT INTO gate_artifact_logs (artifact_key, step_name, log_content, log_digest, log_bytes)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const [stepName, content] of logs) {
        const step = artifact.steps.find((s) => s.name === stepName);
        if (step === undefined) {
          throw new StorageRecordError(
            `Gate artifact log has no matching step: ${artifact.key}/${stepName}`
          );
        }
        insertLog.run(artifact.key, stepName, content, step.logDigest, step.logBytes);
      }
    });
  }

  touchGateArtifact(artifact: GateArtifact): void {
    validateGateArtifact(artifact);
    this.#mutate(() => {
      const result = this.#db.prepare(
        `UPDATE gate_artifacts SET payload = ?, last_used_at = ? WHERE key = ?`
      ).run(
        this.#json(artifact),
        artifact.lastUsedAt,
        artifact.key
      );
      if (result.changes === 0) {
        throw new StorageRecordError(`Gate artifact not found for touch: ${artifact.key}`);
      }
    });
  }

  getGateArtifact(projectId: string, key: string): GateArtifact | null {
    const artifact = this.#getPayload<GateArtifact>(
      "gate_artifacts",
      "project_id = ? AND key = ?",
      [projectId, key]
    );
    return artifact === null ? null : validateGateArtifact(artifact);
  }

  findGateArtifactByIdentity(identity: GateArtifactIdentity): GateArtifact | null {
    return this.getGateArtifact(identity.projectId, gateArtifactKey(identity));
  }

  findL2GateArtifactsForCommit(query: Readonly<{
    projectId: string;
    commit: string;
    planDigest: string;
    toolchainDigest: string;
    targetRef: string;
  }>): GateArtifact[] {
    const rows = this.#listPayload<GateArtifact>(
      "gate_artifacts",
      `project_id = ? AND commit_sha = ? AND level = 'L2'
       AND plan_digest = ? AND toolchain_digest = ? AND target_ref = ?
       AND status = 'complete' AND outcome = 'succeeded'`,
      [query.projectId, query.commit, query.planDigest, query.toolchainDigest, query.targetRef]
    );
    const valid: GateArtifact[] = [];
    for (const row of rows) {
      try {
        valid.push(validateGateArtifact(row));
      } catch {
        // Skip corrupt rows; a direct lookup fails closed.
      }
    }
    return valid;
  }

  getGateArtifactLogs(artifactKey: string): ReadonlyMap<string, Buffer> {
    const rows = this.#db.prepare(
      "SELECT step_name, log_content FROM gate_artifact_logs WHERE artifact_key = ?"
    ).all(artifactKey) as ReadonlyArray<{ step_name: string; log_content: Buffer }>;
    const logs = new Map<string, Buffer>();
    for (const row of rows) {
      logs.set(row.step_name, Buffer.from(row.log_content));
    }
    return logs;
  }

  pruneGateArtifacts(projectId: string, options: GateArtifactPruneOptions): GateArtifactPruneResult {
    // Snapshot candidates outside the write transaction so the isReferenced
    // callback never holds the SQLite write lock.
    const rows = this.#db.prepare(
      "SELECT key, payload, last_used_at FROM gate_artifacts WHERE project_id = ?"
    ).all(projectId) as ReadonlyArray<{ key: string; payload: string; last_used_at: string }>;
    const toDelete: string[] = [];
    let retained = 0;
    for (const row of rows) {
      let artifact: GateArtifact;
      try {
        artifact = validateGateArtifact(JSON.parse(row.payload) as GateArtifact);
      } catch {
        retained += 1;
        continue;
      }
      const age = options.now.getTime() - Date.parse(artifact.lastUsedAt);
      if (options.isReferenced(artifact.key) || age < options.ttlMs) {
        retained += 1;
        continue;
      }
      toDelete.push(artifact.key);
    }
    if (toDelete.length === 0) {
      return Object.freeze({ retained, deleted: 0 });
    }
    return this.#mutate(() => {
      const deleteArtifact = this.#db.prepare("DELETE FROM gate_artifacts WHERE key = ?");
      for (const key of toDelete) {
        deleteArtifact.run(key);
      }
      return Object.freeze({ retained, deleted: toDelete.length });
    });
  }

  // -- context snapshots ------------------------------------------------------

  nextContextSnapshotId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "contextSnapshot");
  }

  getContextSnapshot(taskId: string, snapshotId: string): ContextSnapshot | null {
    return this.#getPayload<ContextSnapshot>(
      "context_snapshots",
      "task_id = ? AND snapshot_id = ?",
      [taskId, snapshotId]
    );
  }

  listContextSnapshots(taskId: string): ContextSnapshot[] {
    return this.#sortById(
      this.#listPayload<ContextSnapshot>("context_snapshots", "task_id = ?", [taskId]),
      (snapshot) => snapshot.id
    );
  }

  saveContextSnapshot(snapshot: ContextSnapshot): void {
    const stored = validateContextSnapshot(snapshot);
    this.#requireTask(stored.taskId);
    const existing = this.getContextSnapshot(stored.taskId, stored.id);
    if (existing !== null) {
      if (!isDeepStrictEqual(existing, stored)) {
        throw new StorageRecordError(`Context Snapshot is immutable: ${stored.id}.`);
      }
      return;
    }
    const duplicate = this.#db.prepare(
      `SELECT snapshot_id FROM context_snapshots
       WHERE task_id = ? AND scope = ? AND COALESCE(scope_ref, '') = COALESCE(?, '') AND sequence = ?`
    ).get(stored.taskId, stored.scope, stored.scopeRef ?? null, stored.sequence);
    if (duplicate !== undefined) {
      throw new StorageRecordError(
        `Context Snapshot sequence already exists: ${stored.taskId}/${stored.scope}/${stored.sequence}.`
      );
    }
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO context_snapshots
          (task_id, snapshot_id, scope, scope_ref, sequence, digest, payload, frozen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        stored.taskId,
        stored.id,
        stored.scope,
        stored.scopeRef ?? null,
        stored.sequence,
        stored.digest,
        this.#json(stored),
        stored.frozenAt
      );
    });
  }

  // -- turns -----------------------------------------------------------------

  nextRunId(taskId: string): string { return this.#nextTaskRecordId(taskId, "run"); }
  peekNextRunId(taskId: string): string { return this.#peekTaskRecordId(taskId, "run"); }

  getRun(taskId: string, runId: string): AgentRun | null {
    return this.#getPayload<AgentRun>("turns", "task_id = ? AND turn_id = ?", [taskId, runId]);
  }

  listRuns(taskId: string): AgentRun[] {
    return this.#sortById(
      this.#listPayload<AgentRun>("turns", "task_id = ?", [taskId]),
      (run) => run.id
    );
  }

  saveRun(run: AgentRun): void {
    if (run.taskId !== undefined) this.#requireTask(run.taskId);
    if (run.reviewRoundId !== undefined) {
      const round = this.getReviewRound(run.taskId, run.reviewRoundId);
      if (round === null) {
        throw new StorageRecordError(`AgentRun ReviewRound not found: ${run.reviewRoundId}.`);
      }
      const roundWorkItemId = round.workItemId;
      const laneRole = round.executionGroup?.lanes
        .find(({ id }) => id === run.executionLaneId)?.roleName;
      if (roundWorkItemId !== run.workItemId
        || (round.reviewerRoleName !== run.roleName && laneRole !== run.roleName)) {
        throw new StorageRecordError(`AgentRun does not match ReviewRound: ${run.id}.`);
      }
    }
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO turns (task_id, turn_id, role_name, status, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, turn_id) DO UPDATE SET role_name = excluded.role_name, status = excluded.status,
           payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(run.taskId, run.id, run.roleName, run.status, this.#json(run), this.#now());
    });
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
    validateReviewRound(round);
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

  // -- active turns ----------------------------------------------------------

  #saveActiveRun(taskId: string, pointer: string, runId: string): void {
    this.#mutate(() => {
      const payload = this.#json({ schemaVersion: 3, runId });
      this.#db.prepare(
        `INSERT INTO active_turns (task_id, pointer, turn_id, payload, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, pointer) DO UPDATE SET turn_id = excluded.turn_id, payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, pointer, runId, payload, this.#now());
    });
  }

  #readActiveRunPointer(taskId: string, pointer: string): {
    runId: string;
    run: AgentRun | null;
  } | null {
    const row = this.#db.prepare(
      "SELECT turn_id FROM active_turns WHERE task_id = ? AND pointer = ?"
    ).get(taskId, pointer) as { turn_id: string } | undefined;
    if (row === undefined) return null;
    return {
      runId: row.turn_id,
      run: this.getRun(taskId, row.turn_id)
    };
  }

  #assertActiveRunForWrite(
    run: AgentRun,
    lane?: Readonly<{ executionGroupId: string; executionLaneId: string }>
  ): void {
    if (run.status !== "active") {
      throw new StorageRecordError(`Active AgentRun must have active status: ${run.id}`);
    }
    const hasGroup = run.executionGroupId !== undefined;
    const hasLane = run.executionLaneId !== undefined;
    if (hasGroup !== hasLane) {
      throw new StorageRecordError(`AgentRun execution lineage is incomplete: ${run.id}.`);
    }
    if (lane !== undefined
      && (run.executionGroupId !== lane.executionGroupId
        || run.executionLaneId !== lane.executionLaneId)) {
      throw new StorageRecordError(
        `Active AgentRun execution lineage does not match its Lane: ${run.id}`
      );
    }
  }

  #getActiveRoleRun(taskId: string, roleName: string): AgentRun | null {
    const pointer = this.#readActiveRunPointer(taskId, roleName);
    if (pointer === null) return null;
    const task = this.getTask(taskId);
    if (task === null) {
      throw new StorageRecordError(`Active AgentRun Task is missing: ${taskId}/${roleName}`);
    }
    if (pointer.run === null) {
      // Retired Tasks are an explicit historical isolation boundary. Their
      // retained pointer rows may intentionally reference a missing AgentRun.
      if (task.status === "cancelled" && task.retirementIsolation === true) return null;
      throw new StorageRecordError(`Active AgentRun pointer is dangling: ${taskId}/${roleName}`);
    }
    const run = pointer.run;
    if (task.status === "cancelled" && task.retirementIsolation === true) return run;
    if (run.id !== pointer.runId
      || run.taskId !== taskId
      || run.roleName !== roleName
      || run.status !== "active"
      || (run.executionGroupId === undefined) !== (run.executionLaneId === undefined)) {
      throw new StorageRecordError(`Active AgentRun pointer is invalid: ${taskId}/${roleName}`);
    }
    return run;
  }

  #getActiveLaneRun(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): AgentRun | null {
    const pointerKey = executionLaneActiveRunKey(executionGroupId, executionLaneId);
    const pointer = this.#readActiveRunPointer(taskId, pointerKey);
    if (pointer === null) return null;
    const task = this.getTask(taskId);
    if (task === null) {
      throw new StorageRecordError(`Active AgentRun Task is missing: ${taskId}/${pointerKey}`);
    }
    if (pointer.run === null) {
      if (task.status === "cancelled" && task.retirementIsolation === true) return null;
      throw new StorageRecordError(`Active AgentRun pointer is dangling: ${taskId}/${pointerKey}`);
    }
    const run = pointer.run;
    if (task.status === "cancelled" && task.retirementIsolation === true) return run;
    if (run.id !== pointer.runId
      || run.taskId !== taskId
      || run.status !== "active"
      || run.executionGroupId !== executionGroupId
      || run.executionLaneId !== executionLaneId) {
      throw new StorageRecordError(`Active AgentRun pointer is invalid: ${taskId}/${pointerKey}`);
    }
    return run;
  }

  #clearActiveRun(taskId: string, pointer: string): void {
    this.#mutate(() => {
      this.#db.prepare("DELETE FROM active_turns WHERE task_id = ? AND pointer = ?").run(taskId, pointer);
    });
  }

  getActiveRun(taskId: string, roleName: string): AgentRun | null {
    return this.#getActiveRoleRun(taskId, roleName);
  }

  saveActiveRun(run: AgentRun): void {
    if (run.executionGroupId !== undefined || run.executionLaneId !== undefined) {
      this.saveActiveExecutionLaneRun(run);
      return;
    }
    this.transaction((store) => {
      const task = store.getTask(run.taskId);
      assertRunAdmission(task, run);
      this.#assertActiveRunForWrite(run);
      const current = store.getActiveRun(run.taskId, run.roleName);
      if (current !== null && current.id !== run.id) {
        throw new StorageRecordError(`Role already has an active AgentRun: ${run.taskId}/${run.roleName}`);
      }
      // Keep the AgentRun row and its active pointer in the same transaction. The
      // adapter may have already written the row; this upsert remains
      // intentionally idempotent for that backend-neutral path.
      store.saveRun(run);
      this.#saveActiveRun(run.taskId, run.roleName, run.id);
    });
  }

  clearActiveRun(taskId: string, roleName: string): void {
    // A Role key can point at a lane-backed AgentRun. Remove the matching lane
    // pointer too while preserving every other lane for the same Role.
    this.transaction(() => {
      const rolePointer = this.#readActiveRunPointer(taskId, roleName);
      this.#clearActiveRun(taskId, roleName);
      if (rolePointer === null) return;
      const laneRows = this.#db.prepare(
        "SELECT pointer, turn_id FROM active_turns WHERE task_id = ?"
      ).all(taskId) as Array<{ pointer: string; turn_id: string }>;
      for (const row of laneRows) {
        if (executionLaneActiveRunKeyParts(row.pointer) !== null
          && row.turn_id === rolePointer.runId) {
          this.#clearActiveRun(taskId, row.pointer);
        }
      }
    });
  }

  getActiveExecutionLaneRun(taskId: string, executionGroupId: string, executionLaneId: string): AgentRun | null {
    return this.#getActiveLaneRun(taskId, executionGroupId, executionLaneId);
  }

  saveActiveExecutionLaneRun(run: AgentRun): void {
    if (run.executionGroupId === undefined || run.executionLaneId === undefined) {
      throw new StorageRecordError(`Active execution-lane AgentRun requires group and lane ids: ${run.id}`);
    }
    this.transaction((store) => {
      const task = store.getTask(run.taskId);
      if (task === null || task.status !== "active" || task.executionGate.state !== "enabled") {
        throw new StorageRecordError(`Task execution is not enabled: ${run.taskId}.`);
      }
      const key = executionLaneActiveRunKey(run.executionGroupId!, run.executionLaneId!);
      this.#assertActiveRunForWrite(run, {
        executionGroupId: run.executionGroupId!,
        executionLaneId: run.executionLaneId!
      });
      const current = store.getActiveExecutionLaneRun(
        run.taskId,
        run.executionGroupId!,
        run.executionLaneId!
      );
      if (current !== null && current.id !== run.id) {
        throw new StorageRecordError(`Execution Lane already has an active AgentRun: ${run.taskId}/${key}`);
      }
      const rolePointer = this.#readActiveRunPointer(run.taskId, run.roleName);
      store.saveRun(run);
      this.#saveActiveRun(run.taskId, key, run.id);
      // Keep the Role pointer for the single-lane delivery path, but never
      // replace it when another Lane already owns that Role.
      if (rolePointer === null) {
        this.#saveActiveRun(run.taskId, run.roleName, run.id);
      }
    });
  }

  clearActiveExecutionLaneRun(taskId: string, executionGroupId: string, executionLaneId: string): void {
    this.transaction(() => {
      const key = executionLaneActiveRunKey(executionGroupId, executionLaneId);
      const lanePointer = this.#readActiveRunPointer(taskId, key);
      this.#clearActiveRun(taskId, key);
      if (lanePointer === null) return;
      const roleRows = this.#db.prepare(
        "SELECT pointer, turn_id FROM active_turns WHERE task_id = ?"
      ).all(taskId) as Array<{ pointer: string; turn_id: string }>;
      for (const row of roleRows) {
        if (executionLaneActiveRunKeyParts(row.pointer) === null
          && row.turn_id === lanePointer.runId) {
          this.#clearActiveRun(taskId, row.pointer);
        }
      }
    });
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

  updateMessage(taskId: string, message: TaskMessage): void {
    if (message.taskId !== taskId) {
      throw new StorageRecordError(`Message belongs to another Task: ${message.taskId}`);
    }
    this.#requireTask(taskId);
    this.#mutate(() => {
      const result = this.#db.prepare(
        `UPDATE messages SET payload = ? WHERE task_id = ? AND message_id = ?`
      ).run(this.#json(message), taskId, message.id);
      if (result.changes !== 1) {
        throw new StorageRecordError(`Message does not exist: ${taskId}/${message.id}`);
      }
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

  listOpenInputRequests(taskIds?: readonly string[]): InputRequest[] {
    const selectedTaskIds = taskIds === undefined
      ? undefined
      : [...new Set(taskIds)].sort(numericCompare);
    if (selectedTaskIds?.length === 0) return [];
    const where = selectedTaskIds === undefined
      ? "status = 'open'"
      : `status = 'open' AND task_id IN (${selectedTaskIds.map(() => "?").join(", ")})`;
    return this.#sortById(
      this.#listPayload<InputRequest>(
        "input_requests",
        where,
        selectedTaskIds ?? []
      ),
      (request) => `${request.taskId}/${request.id}`
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

  removeEvents(taskId: string, eventIds: readonly string[]): number {
    if (eventIds.length === 0) return 0;
    this.#requireTask(taskId);
    return this.#mutate(() => {
      const deleteEvent = this.#db.prepare("DELETE FROM events WHERE task_id = ? AND event_id = ?");
      let removed = 0;
      for (const eventId of eventIds) {
        removed += deleteEvent.run(taskId, eventId).changes;
      }
      return removed;
    });
  }

  nextTaskWakeId(taskId: string): string { return this.#nextTaskRecordId(taskId, "taskWake"); }
  peekNextTaskWakeId(taskId: string): string { return this.#peekTaskRecordId(taskId, "taskWake"); }

  saveTaskWake(taskId: string, wake: TaskWake): void {
    if (wake.taskId !== taskId) {
      throw new StorageRecordError(`Task wake belongs to another Task: ${wake.taskId}`);
    }
    validateTaskWake(wake);
    this.#requireTask(taskId);
    this.#mutate(() => {
      const seq = this.#idSequence(wake.id, "taskWake");
      this.#db.prepare(
        `INSERT INTO task_wakes
          (task_id, wake_id, seq, status, turn_id, from_cursor, to_cursor, reasons, payload, created_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
       + ` ON CONFLICT(task_id, wake_id) DO UPDATE SET
           status = excluded.status,
           turn_id = excluded.turn_id,
           reasons = excluded.reasons,
           payload = excluded.payload,
           consumed_at = excluded.consumed_at`
      ).run(
        taskId,
        wake.id,
        wake.seq,
        wake.status,
        wake.runId ?? null,
        wake.fromCursor,
        wake.toCursor,
        this.#json([...wake.reasons]),
        this.#json(wake),
        wake.createdAt,
        wake.consumedAt ?? null
      );
      this.#observeHighWater(taskId, "taskWake", seq);
    });
  }

  getTaskWake(taskId: string, wakeId: string): TaskWake | null {
    const row = this.#db.prepare(
      "SELECT payload FROM task_wakes WHERE task_id = ? AND wake_id = ?"
    ).get(taskId, wakeId) as { payload: string } | undefined;
    if (row === undefined) return null;
    const wake = this.#parse<TaskWake>(row.payload);
    validateTaskWake(wake);
    return wake;
  }

  listTaskWakes(taskId: string): TaskWake[] {
    return this.#sortById(
      this.#listPayload<TaskWake>("task_wakes", "task_id = ?", [taskId]),
      (wake) => wake.id
    );
  }

  // -- high-water maintenance ---------------------------------------------------

  /** Extract the numeric suffix of a `<prefix>-<n>` record id. */
  #idSequence(id: string, kind: TaskRecordKind): number {
    const prefix = kind === "run" ? "(?:run|turn)" : TASK_RECORD_ID_PREFIXES[kind];
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
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

  #rowToMailbox(row: { target_kind: string; task_id: string | null; role_name: string | null; next_sequence: number; processing: string | null; pending: string; recent_dedupe_keys: string }): WorkMailbox {
    const target = this.#targetFromCols(row.target_kind, row.task_id, row.role_name);
    return validateWorkMailbox({
      schemaVersion: CURRENT_WORK_MAILBOX_SCHEMA_VERSION,
      target,
      nextSequence: row.next_sequence,
      processing: row.processing === null ? null : this.#parse(row.processing),
      pending: this.#parse(row.pending),
      recentDedupeKeys: this.#parse(row.recent_dedupe_keys)
    });
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
      "SELECT target_kind, task_id, role_name, next_sequence, processing, pending, recent_dedupe_keys FROM mailboxes WHERE target_key = ?"
    ).get(cols.targetKey) as { target_kind: string; task_id: string | null; role_name: string | null; next_sequence: number; processing: string | null; pending: string; recent_dedupe_keys: string } | undefined;
    return row === undefined ? null : this.#rowToMailbox(row);
  }

  listWorkMailboxes(): WorkMailbox[] {
    const rows = this.#db.prepare(
      "SELECT target_kind, task_id, role_name, next_sequence, processing, pending, recent_dedupe_keys FROM mailboxes ORDER BY target_key"
    ).all() as Array<{ target_kind: string; task_id: string | null; role_name: string | null; next_sequence: number; processing: string | null; pending: string; recent_dedupe_keys: string }>;
    return rows.map((row) => this.#rowToMailbox(row));
  }

  listReadyWorkMailboxes(): WorkMailbox[] {
    const rows = this.#db.prepare(
      `SELECT target_kind, task_id, role_name, next_sequence, processing, pending, recent_dedupe_keys
       FROM mailboxes
       WHERE processing IS NOT NULL
          OR json_type(pending) <> 'null'
       ORDER BY target_key`
    ).all() as Array<{ target_kind: string; task_id: string | null; role_name: string | null; next_sequence: number; processing: string | null; pending: string; recent_dedupe_keys: string }>;
    return rows.map((row) => this.#rowToMailbox(row));
  }

  saveWorkMailbox(mailbox: WorkMailbox): void {
    let validated: WorkMailbox;
    try {
      validated = validateWorkMailbox(mailbox);
    } catch (error) {
      throw new StorageRecordError(error instanceof Error ? error.message : String(error));
    }
    const cols = this.#mailboxCols(validated.target);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO mailboxes (target_kind, task_id, role_name, target_key, next_sequence, processing, pending, recent_dedupe_keys)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_key) DO UPDATE SET next_sequence = excluded.next_sequence,
           processing = excluded.processing, pending = excluded.pending,
           recent_dedupe_keys = excluded.recent_dedupe_keys`
      ).run(
        cols.targetKind, cols.taskId, cols.roleName, cols.targetKey,
        validated.nextSequence,
        validated.processing === null ? null : this.#json(validated.processing),
        this.#json(validated.pending),
        this.#json(validated.recentDedupeKeys)
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
  // -- scheduler projections -----------------------------------------------------

  #getProjection<T>(taskId: string, kind: "leader-failure"): T | null {
    const row = this.#db.prepare(
      "SELECT payload FROM task_projections WHERE task_id = ? AND kind = ?"
    ).get(taskId, kind) as { payload: string | null } | undefined;
    if (row === undefined || row.payload === null) return null;
    return this.#parse<T>(row.payload);
  }

  #saveProjection(taskId: string, kind: "leader-failure", value: object): void {
    this.#requireTask(taskId);
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO task_projections (task_id, kind, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(taskId, kind, this.#json(value), this.#now());
    });
  }

  #clearProjection(taskId: string, kind: "leader-failure"): void {
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

  // -- pending wakeups (leader-role work-mailbox projection, mirrors taskStore.ts) --

  getPendingWakeup(taskId: string): PendingWakeup | null {
    return pendingWakeupProjection(this.getWorkMailbox({ kind: "role", taskId, roleName: "leader" }));
  }

  listPendingWakeups(): PendingWakeup[] {
    return this.listReadyWorkMailboxes()
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
      const existingPending = existing?.pending ?? null;
      if (existingPending !== null
        && value.requestCount <= existingPending.requestCount) {
        throw new StorageRecordError(`Pending wakeup is stale: ${value.taskId}`);
      }
      const fromSequence = existingPending?.fromSequence ?? existing?.nextSequence ?? 1;
      const toSequence = fromSequence + value.requestCount - 1;
      store.saveWorkMailbox({
        schemaVersion: CURRENT_WORK_MAILBOX_SCHEMA_VERSION,
        target,
        nextSequence: Math.max(existing?.nextSequence ?? 1, toSequence + 1),
        processing: existing?.processing ?? null,
        pending: {
          fromSequence,
          toSequence,
          reasons: [...value.reasons],
          refs: existingPending?.refs ?? [],
          requestCount: value.requestCount,
          firstQueuedAt: value.firstRequestedAt,
          lastQueuedAt: value.lastRequestedAt,
          sources: existingPending?.sources ?? ["pending-wakeup-projection"],
          dedupeKeys: existingPending?.dedupeKeys ?? [
            `pending-wakeup:${value.taskId}:${fromSequence}-${toSequence}`
          ]
        },
        recentDedupeKeys: existing?.recentDedupeKeys ?? []
      });
    });
  }

  clearPendingWakeup(taskId: string): void {
    const target = { kind: "role" as const, taskId, roleName: "leader" };
    const mailbox = this.getWorkMailbox(target);
    if (mailbox === null || mailbox.pending === null) return;
    this.saveWorkMailbox(consumePendingBatch(mailbox));
  }

  // -- telemetry (§4.4) -----------------------------------------------------------

  /**
   * Upsert one progress row. The PK is (task_id, role_name, turn_id,
   * progress_id): a repeated progress id updates in place, so a high-frequency
   * runtime telemetry observation is a single-row write that never
   * rewrites global state or another Task's rows.
   */
  upsertTelemetryProgress(entry: TelemetryProgress): void {
    this.#mutate(() => {
      this.#db.prepare(
        `INSERT INTO telemetry (task_id, role_name, turn_id, progress_id, sequence, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, role_name, turn_id, progress_id)
         DO UPDATE SET sequence = excluded.sequence, payload = excluded.payload, received_at = excluded.received_at`
      ).run(
        entry.taskId, entry.roleName, entry.runId, entry.progressId,
        entry.sequence ?? null, this.#json(entry.payload), entry.receivedAt
      );
    });
  }

  listTelemetry(taskId: string, runId?: string): TelemetryProgress[] {
    const rows = runId === undefined
      ? this.#db.prepare(
          "SELECT task_id, role_name, turn_id, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? ORDER BY received_at"
        ).all(taskId)
      : this.#db.prepare(
          "SELECT task_id, role_name, turn_id, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? AND turn_id = ? ORDER BY received_at"
        ).all(taskId, runId);
    return (rows as Array<{ task_id: string; role_name: string; turn_id: string; progress_id: string; sequence: number | null; payload: string; received_at: string }>)
      .map((row) => ({
        taskId: row.task_id,
        roleName: row.role_name,
        runId: row.turn_id,
        progressId: row.progress_id,
        sequence: row.sequence ?? undefined,
        payload: this.#parse(row.payload),
        receivedAt: row.received_at
      }));
  }

  countTelemetry(taskId: string, runId?: string): number {
    const row = runId === undefined
      ? this.#db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ?").get(taskId)
      : this.#db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ? AND turn_id = ?").get(taskId, runId);
    return (row as { n: number }).n;
  }

  /**
   * Bounded retention (§4.4): keep the newest `keep` rows per
   * (task, role, AgentRun) and delete older ones. The DELETE is scoped
   * by task_id; it never rewrites global rows or other Tasks. Returns the number
   * of rows deleted. Terminal/semantic events go to `events` and are never pruned.
   */
  pruneTelemetry(taskId: string, roleName: string, runId: string, keep: number = TELEMETRY_KEEP_PER_RUN): number {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        `DELETE FROM telemetry
         WHERE task_id = ? AND role_name = ? AND turn_id = ?
           AND (task_id, role_name, turn_id, progress_id) NOT IN (
             SELECT task_id, role_name, turn_id, progress_id
             FROM telemetry
             WHERE task_id = ? AND role_name = ? AND turn_id = ?
             ORDER BY received_at DESC, COALESCE(sequence, -1) DESC, progress_id ASC
             LIMIT ?
           )`
      ).run(taskId, roleName, runId, taskId, roleName, runId, keep);
      return result.changes;
    });
  }

  /**
   * Hard cap for an active AgentRun (§4.4): trim oldest rows across the AgentRun beyond
   * `cap` (default 50k). Returns the number of rows deleted.
   */
  capTelemetryRun(taskId: string, runId: string, cap: number = TELEMETRY_RUN_CAP): number {
    return this.#mutate(() => {
      const result = this.#db.prepare(
        `DELETE FROM telemetry
         WHERE task_id = ? AND turn_id = ?
           AND (task_id, role_name, turn_id, progress_id) NOT IN (
             SELECT task_id, role_name, turn_id, progress_id
             FROM telemetry
             WHERE task_id = ? AND turn_id = ?
             ORDER BY received_at DESC, COALESCE(sequence, -1) DESC, progress_id ASC
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
    queued: ["queued", "running", "superseded"],
    running: ["running", "conflicted", "committed"],
    conflicted: ["conflicted", "running", "committed", "queued", "superseded"],
    committed: ["committed"],
    superseded: ["superseded"]
  };
  return allowed[before.status].includes(after.status);
}


// -- current Store composition ----------------------------------------------

/** The product has one storage backend. */
export type TaskStoreBackend = "sqlite";

/** Options for the current SQLite Task store. */
export type TaskStoreOptions = SqliteTaskStoreOptions;

/** The product storage backend is one current SQLite contract. */
export function resolveTaskStoreBackendForHome(
  _home: string,
  _env: NodeJS.ProcessEnv = process.env
): TaskStoreBackend {
  return "sqlite";
}

/**
 * Convenience for seams which cannot receive an already-open current store.
 */
export function openConfiguredTaskStore(
  home: string,
  options?: TaskStoreOptions
): SqliteTaskStore {
  return new SqliteTaskStore(home, options);
}
