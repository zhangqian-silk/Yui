import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_TURN_CAP,
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
import { migrateSqliteSchema } from "../storage/sqliteSchema.js";
import { CURRENT_DATABASE_FILENAME as COMMITTED_DATABASE_FILENAME } from "../storage/currentTaskStore.js";

/**
 * Default sidecar implementation: the telemetry tables live inside the Home's
 * authoritative `yui.db`, so a Home has one durable database
 * has one file to manage, back up, and migrate. The store opens its own
 * connection to that file: the write path is a single serialized writer (the
 * "WAL worker") and stays isolated from the business store's connection.
 *
 * Writes are best-effort and never block the Controller event loop: `observe`
 * only merges into a bounded in-memory queue; a background flush drains it in
 * batches. Queue overflow and database failures increment `dropped` and record
 * a health warning — the semantic lane is never affected.
 *
 * The telemetry tables are maintained by the centralized schema baseline:
 * `telemetry` holds the bounded latest-per-key window and
 * `telemetry_aggregate` holds the authoritative per-Turn/generation
 * summary, maintained by triggers so it survives window pruning.
 */

const MAX_PAGE_LIMIT = 500;

export type SqliteTelemetryStoreOptions = Readonly<{
  mode?: TelemetryMode;
  terminalKeep?: number;
  turnCap?: number;
  /** Max queued observations before the sidecar starts dropping. */
  maxPending?: number;
}>;

export class SqliteTelemetryStore implements TelemetryStore {
  readonly mode: TelemetryMode;
  readonly #path: string;
  readonly #terminalKeep: number;
  readonly #turnCap: number;
  readonly #maxPending: number;
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
    this.#path = join(home, COMMITTED_DATABASE_FILENAME);
    this.#terminalKeep = options.terminalKeep ?? DEFAULT_TERMINAL_KEEP;
    this.#turnCap = options.turnCap ?? DEFAULT_TURN_CAP;
    this.#maxPending = options.maxPending ?? 10_000;
  }

  // -- TelemetrySink -------------------------------------------------------------

  observe(entry: TelemetryProgressEntry): void {
    if (this.#closed) return;
    const db = this.#ensureDb();
    if (db === null) {
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
    await this.#flushPending();
    this.#db?.close();
    this.#db = null;
  }

  // -- TelemetryReader -----------------------------------------------------------

  count(taskId?: string, turnId?: string): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    if (taskId === undefined) {
      return (db.prepare("SELECT COUNT(*) AS n FROM telemetry").get() as { n: number }).n;
    }
    if (turnId === undefined) {
      return (db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ?").get(taskId) as { n: number }).n;
    }
    return (db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ? AND turn_id = ?").get(taskId, turnId) as { n: number }).n;
  }

  list(
    taskId: string,
    turnId?: string,
    page: Readonly<{ limit: number; offset: number }> = { limit: 100, offset: 0 }
  ): TelemetryPage<TelemetryProgressEntry> {
    const db = this.#ensureDb();
    if (db === null) return { items: [], nextOffset: null };
    const limit = Math.min(Math.max(1, Math.trunc(page.limit)), MAX_PAGE_LIMIT);
    const offset = Math.max(0, Math.trunc(page.offset));
    const rows = turnId === undefined
      ? db.prepare(
          "SELECT task_id, role_name, turn_id, generation, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? ORDER BY received_at, progress_id LIMIT ? OFFSET ?"
        ).all(taskId, limit, offset)
      : db.prepare(
          "SELECT task_id, role_name, turn_id, generation, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? AND turn_id = ? ORDER BY received_at, progress_id LIMIT ? OFFSET ?"
        ).all(taskId, turnId, limit, offset);
    const items = (rows as TelemetryRow[]).map(rowToEntry);
    const total = this.count(taskId, turnId);
    const nextOffset = offset + items.length < total ? offset + items.length : null;
    return { items, nextOffset };
  }

  aggregate(taskId: string, turnId: string): TelemetryAggregate | null {
    const db = this.#ensureDb();
    if (db === null) return null;
    const rows = db.prepare(
      "SELECT task_id, role_name, turn_id, generation, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? AND turn_id = ?"
    ).all(taskId, turnId) as AggregateRow[];
    if (rows.length === 0) return null;
    return mergeAggregates(rows);
  }

  aggregateGeneration(
    taskId: string,
    roleName: string,
    turnId: string,
    generation: string
  ): TelemetryAggregate | null {
    const db = this.#ensureDb();
    if (db === null) return null;
    const row = db.prepare(
      "SELECT task_id, role_name, turn_id, generation, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? AND role_name = ? AND turn_id = ? AND generation = ?"
    ).get(taskId, roleName, turnId, generation) as AggregateRow | undefined;
    if (row === undefined) return null;
    return {
      taskId: row.task_id,
      roleName: row.role_name,
      turnId: row.turn_id,
      generation: row.generation,
      firstAt: row.first_at,
      lastAt: row.last_at,
      count: row.count,
      maxSequence: row.max_sequence,
      errorCount: row.error_count
    };
  }

  listTurnAggregates(taskId: string): TelemetryAggregate[] {
    const db = this.#ensureDb();
    if (db === null) return [];
    const rows = db.prepare(
      "SELECT task_id, role_name, turn_id, generation, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? ORDER BY turn_id, generation"
    ).all(taskId) as AggregateRow[];
    return rows.map((row) => ({
      taskId: row.task_id,
      roleName: row.role_name,
      turnId: row.turn_id,
      generation: row.generation,
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

  pruneGeneration(
    taskId: string,
    roleName: string,
    turnId: string,
    generation: string,
    keep: number = this.#terminalKeep
  ): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    const result = db.prepare(
      `DELETE FROM telemetry
       WHERE task_id = ? AND role_name = ? AND turn_id = ? AND generation = ?
         AND (task_id, role_name, turn_id, generation, progress_id) NOT IN (
           SELECT task_id, role_name, turn_id, generation, progress_id FROM telemetry
           WHERE task_id = ? AND role_name = ? AND turn_id = ? AND generation = ?
           ORDER BY COALESCE(sequence, -1) DESC, received_at DESC, progress_id ASC
           LIMIT ?
         )`
    ).run(taskId, roleName, turnId, generation, taskId, roleName, turnId, generation, keep);
    return result.changes;
  }

  capTurn(taskId: string, turnId: string, cap: number = this.#turnCap): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    const result = db.prepare(
      `DELETE FROM telemetry
       WHERE task_id = ? AND turn_id = ?
         AND (task_id, role_name, turn_id, generation, progress_id) NOT IN (
           SELECT task_id, role_name, turn_id, generation, progress_id FROM telemetry
           WHERE task_id = ? AND turn_id = ?
           ORDER BY COALESCE(sequence, -1) DESC, received_at DESC, progress_id ASC
           LIMIT ?
         )`
    ).run(taskId, turnId, taskId, turnId, cap);
    return result.changes;
  }

  importGeneration(entries: readonly TelemetryProgressEntry[], aggregate: TelemetryAggregate): void {
    const db = this.#ensureDb();
    if (db === null) {
      this.#dropped += entries.length;
      return;
    }
    const upsert = db.prepare(
      `INSERT INTO telemetry (task_id, role_name, turn_id, generation, progress_id, sequence, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, role_name, turn_id, generation, progress_id) DO UPDATE SET
         sequence = excluded.sequence,
         payload = excluded.payload,
         received_at = excluded.received_at
       WHERE COALESCE(excluded.sequence, -1) > COALESCE(telemetry.sequence, -1)
          OR (excluded.sequence IS telemetry.sequence AND excluded.received_at >= telemetry.received_at)`
    );
    const upsertAggregate = db.prepare(
      `INSERT INTO telemetry_aggregate
         (task_id, role_name, turn_id, generation, first_at, last_at, count, max_sequence, error_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, role_name, turn_id, generation) DO UPDATE SET
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
          entry.taskId, entry.roleName, entry.turnId, entry.generation, entry.progressId,
          entry.sequence ?? null, JSON.stringify(entry.payload), entry.receivedAt
        );
      }
      upsertAggregate.run(
        aggregate.taskId, aggregate.roleName, aggregate.turnId, aggregate.generation,
        aggregate.firstAt, aggregate.lastAt, aggregate.count,
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
    try {
      // The telemetry tables live in the Home's authoritative database; the
      // store never creates `yui.db` itself. Wiring fails closed on Homes
      // without a database instead of silently materializing an empty one.
      if (!existsSync(this.#path)) {
        throw new Error(`Telemetry database not found: ${this.#path}`);
      }
      const db = new Database(this.#path);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      db.pragma("wal_autocheckpoint = 1000");
      migrateSqliteSchema(db, { mode: "validate" });
      this.#db = db;
      return db;
    } catch (error) {
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

  async #flushPending(): Promise<void> {
    if (this.#pending.size === 0) return;
    const db = this.#ensureDb();
    if (db === null) {
      this.#dropped += this.#pending.size;
      this.#pending.clear();
      return;
    }
    const batch = new Map(this.#pending);
    this.#pending.clear();
    const upsert = db.prepare(
      `INSERT INTO telemetry (task_id, role_name, turn_id, generation, progress_id, sequence, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, role_name, turn_id, generation, progress_id) DO UPDATE SET
         sequence = excluded.sequence,
         payload = excluded.payload,
         received_at = excluded.received_at
       WHERE COALESCE(excluded.sequence, -1) > COALESCE(telemetry.sequence, -1)
          OR (excluded.sequence IS telemetry.sequence AND excluded.received_at >= telemetry.received_at)`
    );
    try {
      const touchedTurns = new Map<string, Readonly<{ taskId: string; turnId: string }>>();
      db.transaction(() => {
        for (const entry of batch.values()) {
          upsert.run(
            entry.taskId, entry.roleName, entry.turnId, entry.generation, entry.progressId,
            entry.sequence ?? null, JSON.stringify(entry.payload), entry.receivedAt
          );
          touchedTurns.set(`${entry.taskId}\0${entry.turnId}`, {
            taskId: entry.taskId,
            turnId: entry.turnId
          });
        }
        for (const { taskId, turnId } of touchedTurns.values()) {
          this.capTurn(taskId, turnId);
        }
      })();
      this.#applied += batch.size;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#dropped += batch.size;
    }
  }
}

type TelemetryRow = Readonly<{
  task_id: string;
  role_name: string;
  turn_id: string;
  generation: string;
  progress_id: string;
  sequence: number | null;
  payload: string;
  received_at: string;
}>;

type AggregateRow = Readonly<{
  task_id: string;
  role_name: string;
  turn_id: string;
  generation: string;
  first_at: string;
  last_at: string;
  count: number;
  max_sequence: number | null;
  error_count: number;
}>;

function pendingKey(entry: TelemetryProgressEntry): string {
  return `${entry.taskId}\u0000${entry.roleName}\u0000${entry.turnId}\u0000${entry.generation}\u0000${entry.progressId}`;
}

/** True when `candidate` should replace `current` (sequence/receivedAt only move forward). */
function isNewer(candidate: TelemetryProgressEntry, current: TelemetryProgressEntry): boolean {
  if (candidate.sequence !== undefined && current.sequence !== undefined) {
    return candidate.sequence > current.sequence;
  }
  if (candidate.sequence !== undefined) return true;
  if (current.sequence !== undefined) return false;
  return Date.parse(candidate.receivedAt) >= Date.parse(current.receivedAt);
}

function rowToEntry(row: TelemetryRow): TelemetryProgressEntry {
  return {
    taskId: row.task_id,
    roleName: row.role_name,
    turnId: row.turn_id,
    generation: row.generation,
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
    turnId: rows[0].turn_id,
    generation: "*",
    firstAt,
    lastAt,
    count,
    maxSequence,
    errorCount
  };
}
