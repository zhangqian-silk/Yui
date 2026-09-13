import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_DATABASE_FILENAME as COMMITTED_DATABASE_FILENAME } from "../storage/currentTaskStore.js";
import { migrateSqliteSchema } from "../storage/sqliteSchema.js";
import { AsyncTaskStoreClient } from "../storage/storeRpc.js";
import {
  DEFAULT_RUN_CAP,
  DEFAULT_TERMINAL_KEEP,
  type TelemetryMode
} from "./telemetryConfig.js";
import type {
  TelemetryAggregate,
  TelemetryHealth,
  TelemetryPage,
  TelemetryProgressEntry,
  TelemetryStore
} from "./telemetryStore.js";

/**
 * Default sidecar implementation: the telemetry tables live inside the Home's
 * authoritative `yui.db`, so a Home has one durable database
 * has one file to manage, back up, and migrate. The store opens its own
 * connection for cold synchronous reads/explicit retention. Ingestion writes
 * use the existing persistence-worker RPC, shared with the Controller when
 * available; standalone consumers lazily own and close their own client.
 *
 * Writes are best-effort and never block the Controller event loop: `observe`
 * only merges into a bounded in-memory queue; a background flush drains it in
 * batches. Queue overflow and database failures increment `dropped` and record
 * a health warning — the semantic lane is never affected.
 *
 * The telemetry tables are maintained by the centralized schema baseline:
 * `telemetry` holds the bounded latest-per-key window and
 * `telemetry_aggregate` holds the authoritative per-AgentRun
 * summary, maintained by triggers so it survives window pruning.
 */

const MAX_PAGE_LIMIT = 500;

export type SqliteTelemetryStoreOptions = Readonly<{
  mode?: TelemetryMode;
  terminalKeep?: number;
  runCap?: number;
  /** Max queued observations before the sidecar starts dropping. */
  maxPending?: number;
  writer?: Pick<AsyncTaskStoreClient, "flushTelemetry">;
}>;

export class SqliteTelemetryStore implements TelemetryStore {
  readonly mode: TelemetryMode;
  readonly #path: string;
  readonly #terminalKeep: number;
  readonly #turnCap: number;
  readonly #maxPending: number;
  readonly #home: string;
  readonly #writer: Pick<AsyncTaskStoreClient, "flushTelemetry"> | undefined;
  #ownedWriter?: AsyncTaskStoreClient;
  #flushing?: Promise<void>;
  #db: Database.Database | null = null;
  #failed = false;
  #lastError: string | null = null;
  #dropped = 0;
  #coalesced = 0;
  #applied = 0;
  readonly #pending = new Map<string, TelemetryProgressEntry>();
  #flushScheduled = false;
  #closed = false;

  constructor(home: string, options: SqliteTelemetryStoreOptions = {}) {
    this.mode = options.mode ?? "on";
    this.#home = home;
    this.#writer = options.writer;
    this.#path = join(home, COMMITTED_DATABASE_FILENAME);
    this.#terminalKeep = options.terminalKeep ?? DEFAULT_TERMINAL_KEEP;
    this.#turnCap = options.runCap ?? DEFAULT_RUN_CAP;
    this.#maxPending = options.maxPending ?? 10_000;
  }

  // -- TelemetrySink -------------------------------------------------------------

  observe(entry: TelemetryProgressEntry): void {
    if (this.#closed) return;
    if (this.#failed) {
      this.#dropped++;
      return;
    }
    const key = pendingKey(entry);
    const existing = this.#pending.get(key);
    if (existing !== undefined && !isNewer(entry, existing)) {
      // Same hook replayed with an older/equal sequence: fold onto the row
      // already queued. Replays never add rows.
      this.#coalesced++;
      return;
    }
    if (existing !== undefined) this.#coalesced++;
    if (this.#pending.size >= this.#maxPending && existing === undefined) {
      this.#dropped++;
      return;
    }
    this.#pending.set(key, entry);
    this.#scheduleFlush();
  }

  health(): TelemetryHealth {
    return {
      mode: this.mode,
      available: !this.#failed && !this.#closed,
      dropped: this.#dropped,
      coalesced: this.#coalesced,
      lastError: this.#lastError,
      rows: this.#failed ? 0 : this.count()
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#flushPending();
    } finally {
      await this.#ownedWriter?.close();
      this.#db?.close();
      this.#db = null;
    }
  }

  // -- TelemetryReader -----------------------------------------------------------

  count(taskId?: string, runId?: string): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    if (taskId === undefined) {
      return (db.prepare("SELECT COUNT(*) AS n FROM telemetry").get() as { n: number }).n;
    }
    if (runId === undefined) {
      return (db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ?").get(taskId) as { n: number }).n;
    }
    return (db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ? AND turn_id = ?").get(taskId, runId) as { n: number }).n;
  }

  list(
    taskId: string,
    runId?: string,
    page: Readonly<{ limit: number; offset: number }> = { limit: 100, offset: 0 }
  ): TelemetryPage<TelemetryProgressEntry> {
    const db = this.#ensureDb();
    if (db === null) return { items: [], nextOffset: null };
    const limit = Math.min(Math.max(1, Math.trunc(page.limit)), MAX_PAGE_LIMIT);
    const offset = Math.max(0, Math.trunc(page.offset));
    const rows = runId === undefined
      ? db.prepare(
          "SELECT task_id, role_name, turn_id, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? ORDER BY received_at, progress_id LIMIT ? OFFSET ?"
        ).all(taskId, limit, offset)
      : db.prepare(
          "SELECT task_id, role_name, turn_id, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? AND turn_id = ? ORDER BY received_at, progress_id LIMIT ? OFFSET ?"
        ).all(taskId, runId, limit, offset);
    const items = (rows as TelemetryRow[]).map(rowToEntry);
    const total = this.count(taskId, runId);
    const nextOffset = offset + items.length < total ? offset + items.length : null;
    return { items, nextOffset };
  }

  aggregate(taskId: string, runId: string): TelemetryAggregate | null {
    const db = this.#ensureDb();
    if (db === null) return null;
    const rows = db.prepare(
      "SELECT task_id, role_name, turn_id, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? AND turn_id = ?"
    ).all(taskId, runId) as AggregateRow[];
    if (rows.length === 0) return null;
    return mergeAggregates(rows);
  }

  aggregateRoleRun(
    taskId: string,
    roleName: string,
    runId: string
  ): TelemetryAggregate | null {
    const db = this.#ensureDb();
    if (db === null) return null;
    const row = db.prepare(
      "SELECT task_id, role_name, turn_id, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? AND role_name = ? AND turn_id = ?"
    ).get(taskId, roleName, runId) as AggregateRow | undefined;
    if (row === undefined) return null;
    return {
      taskId: row.task_id,
      roleName: row.role_name,
      runId: row.turn_id,
      firstAt: row.first_at,
      lastAt: row.last_at,
      count: row.count,
      maxSequence: row.max_sequence,
      errorCount: row.error_count
    };
  }

  listRunAggregates(taskId: string): TelemetryAggregate[] {
    const db = this.#ensureDb();
    if (db === null) return [];
    const rows = db.prepare(
      "SELECT task_id, role_name, turn_id, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? ORDER BY turn_id"
    ).all(taskId) as AggregateRow[];
    return rows.map((row) => ({
      taskId: row.task_id,
      roleName: row.role_name,
      runId: row.turn_id,
      firstAt: row.first_at,
      lastAt: row.last_at,
      count: row.count,
      maxSequence: row.max_sequence,
      errorCount: row.error_count
    }));
  }

  revision(): number {
    return this.#applied;
  }

  // -- retention -----------------------------------------------------------------

  pruneRun(
    taskId: string,
    roleName: string,
    runId: string,
    keep: number = this.#terminalKeep
  ): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    const result = db.prepare(
      `DELETE FROM telemetry
       WHERE task_id = ? AND role_name = ? AND turn_id = ?
         AND (task_id, role_name, turn_id, progress_id) NOT IN (
           SELECT task_id, role_name, turn_id, progress_id FROM telemetry
           WHERE task_id = ? AND role_name = ? AND turn_id = ?
           ORDER BY received_at DESC, COALESCE(sequence, -1) DESC, progress_id ASC
           LIMIT ?
         )`
    ).run(taskId, roleName, runId, taskId, roleName, runId, keep);
    return result.changes;
  }

  capRun(taskId: string, runId: string, cap: number = this.#turnCap): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    const result = db.prepare(
      `DELETE FROM telemetry
       WHERE task_id = ? AND turn_id = ?
         AND (task_id, role_name, turn_id, progress_id) NOT IN (
           SELECT task_id, role_name, turn_id, progress_id FROM telemetry
           WHERE task_id = ? AND turn_id = ?
           ORDER BY received_at DESC, COALESCE(sequence, -1) DESC, progress_id ASC
           LIMIT ?
         )`
    ).run(taskId, runId, taskId, runId, cap);
    return result.changes;
  }

  importRun(entries: readonly TelemetryProgressEntry[], aggregate: TelemetryAggregate): void {
    const db = this.#ensureDb();
    if (db === null) {
      this.#dropped += entries.length;
      return;
    }
    const upsert = db.prepare(
      `INSERT INTO telemetry (task_id, role_name, turn_id, progress_id, sequence, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, role_name, turn_id, progress_id) DO UPDATE SET
         sequence = excluded.sequence,
         payload = excluded.payload,
         received_at = excluded.received_at
       WHERE excluded.received_at >= telemetry.received_at`
    );
    const upsertAggregate = db.prepare(
      `INSERT INTO telemetry_aggregate
         (task_id, role_name, turn_id, first_at, last_at, count, max_sequence, error_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, role_name, turn_id) DO UPDATE SET
         first_at = excluded.first_at,
         last_at = excluded.last_at,
         count = excluded.count,
         max_sequence = excluded.max_sequence,
         error_count = excluded.error_count,
         updated_at = excluded.updated_at`
    );
    db.transaction(() => {
      for (const entry of entries) {
        upsert.run(
          entry.taskId, entry.roleName, entry.runId, entry.progressId,
          entry.sequence ?? null, JSON.stringify(entry.payload), entry.receivedAt
        );
      }
      upsertAggregate.run(
        aggregate.taskId, aggregate.roleName, aggregate.runId, aggregate.firstAt, aggregate.lastAt, aggregate.count,
        aggregate.maxSequence, aggregate.errorCount, aggregate.lastAt
      );
    })();
    this.#applied += entries.length;
  }

  async flush(): Promise<void> {
    await this.#flushPending();
  }

  // -- internals -----------------------------------------------------------------

  #ensureDb(): Database.Database | null {
    if (this.#db !== null) return this.#db;
    if (this.#failed || this.#closed) return null;
    let opening: Database.Database | undefined;
    try {
      // The telemetry tables live in the Home's authoritative database; the
      // store never creates `yui.db` itself. Wiring fails closed on Homes
      // without a database instead of silently materializing an empty one.
      if (!existsSync(this.#path)) {
        throw new Error(`Telemetry database not found: ${this.#path}`);
      }
      const db = opening = new Database(this.#path);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      // Cold diagnostic reads/retention must not wait behind a semantic writer.
      db.pragma("busy_timeout = 0");
      db.pragma("wal_autocheckpoint = 1000");
      migrateSqliteSchema(db, { mode: "validate" });
      this.#db = db;
      return db;
    } catch (error) {
      opening?.close();
      this.#failed = true;
      this.#lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const handle = setImmediate(() => {
      this.#flushScheduled = false;
      void this.#flushPending();
    });
    handle.unref?.();
  }

  #flushPending(): Promise<void> {
    this.#flushing ??= this.#drain().finally(() => { this.#flushing = undefined; });
    return this.#flushing;
  }

  async #drain(): Promise<void> {
    while (this.#pending.size > 0) {
      const batch: TelemetryProgressEntry[] = [];
      for (const [key, entry] of this.#pending) {
        this.#pending.delete(key);
        batch.push(entry);
        if (batch.length === 256) break;
      }
      try {
        const writer = this.#writer ?? (this.#ownedWriter ??= new AsyncTaskStoreClient(
          this.#home, { readPoolSize: 1 }
        ));
        await writer.flushTelemetry(batch, this.#turnCap);
        this.#applied += batch.length;
      } catch (error) {
        this.#lastError = error instanceof Error ? error.message : String(error);
        this.#dropped += batch.length;
      }
    }
  }
}

type TelemetryRow = Readonly<{
  task_id: string;
  role_name: string;
  turn_id: string;
  progress_id: string;
  sequence: number | null;
  payload: string;
  received_at: string;
}>;

type AggregateRow = Readonly<{
  task_id: string;
  role_name: string;
  turn_id: string;
  first_at: string;
  last_at: string;
  count: number;
  max_sequence: number | null;
  error_count: number;
}>;

function pendingKey(entry: TelemetryProgressEntry): string {
  return `${entry.taskId}\u0000${entry.roleName}\u0000${entry.runId}\u0000${entry.progressId}`;
}

/** Transport counters may restart; the later recorded observation wins. */
function isNewer(candidate: TelemetryProgressEntry, current: TelemetryProgressEntry): boolean {
  return Date.parse(candidate.receivedAt) >= Date.parse(current.receivedAt);
}

function rowToEntry(row: TelemetryRow): TelemetryProgressEntry {
  return {
    taskId: row.task_id,
    roleName: row.role_name,
    runId: row.turn_id,
    progressId: row.progress_id,
    ...(row.sequence === null ? {} : { sequence: row.sequence }),
    payload: JSON.parse(row.payload) as Record<string, string>,
    receivedAt: row.received_at
  };
}

function mergeAggregates(rows: readonly AggregateRow[]): TelemetryAggregate {
  let firstAt = rows[0].first_at;
  let lastAt = rows[0].last_at;
  let count = 0;
  let errorCount = 0;
  let maxSequence: number | null = null;
  let roleName = rows[0].role_name;
  for (const row of rows) {
    if (row.first_at < firstAt) firstAt = row.first_at;
    if (row.last_at > lastAt) {
      lastAt = row.last_at;
      roleName = row.role_name;
    }
    count += row.count;
    errorCount += row.error_count;
    if (row.max_sequence !== null && (maxSequence === null || row.max_sequence > maxSequence)) {
      maxSequence = row.max_sequence;
    }
  }
  return {
    taskId: rows[0].task_id,
    roleName,
    runId: rows[0].turn_id,
    firstAt,
    lastAt,
    count,
    maxSequence,
    errorCount
  };
}
