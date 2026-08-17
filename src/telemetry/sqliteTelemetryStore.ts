import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { TaskEvent } from "../event/taskEvent.js";
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
 * Default sidecar implementation: `<home>/telemetry.db` in WAL mode with a
 * single serialized writer (the "WAL worker"). Writes are best-effort and
 * never block the Controller event loop: `observe` only merges into a
 * bounded in-memory queue; a background flush drains it in batches. Queue
 * overflow and database failures increment `dropped` and record a health
 * warning — the semantic lane is never affected.
 *
 * The sidecar is independent of the authoritative business store: it does
 * not require `yui.db`, does not modify `sqliteSchema.ts`, and rolls back by
 * deleting `telemetry.db` (or flipping `YUI_TELEMETRY_MODE` back to legacy).
 */

const SCHEMA = `
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

const MAX_PAGE_LIMIT = 500;

export type SqliteTelemetryStoreOptions = Readonly<{
  mode?: TelemetryMode;
  terminalKeep?: number;
  runCap?: number;
  /** Max queued observations before the sidecar starts dropping. */
  maxPending?: number;
}>;

export class SqliteTelemetryStore implements TelemetryStore {
  readonly mode: TelemetryMode;
  readonly #path: string;
  readonly #terminalKeep: number;
  readonly #runCap: number;
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
    this.mode = options.mode ?? "dual";
    this.#path = join(home, "telemetry.db");
    this.#terminalKeep = options.terminalKeep ?? DEFAULT_TERMINAL_KEEP;
    this.#runCap = options.runCap ?? DEFAULT_RUN_CAP;
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

  count(taskId?: string, runId?: string): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    if (taskId === undefined) {
      return (db.prepare("SELECT COUNT(*) AS n FROM telemetry").get() as { n: number }).n;
    }
    if (runId === undefined) {
      return (db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ?").get(taskId) as { n: number }).n;
    }
    return (db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE task_id = ? AND run_id = ?").get(taskId, runId) as { n: number }).n;
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
          "SELECT task_id, role_name, run_id, generation, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? ORDER BY received_at, progress_id LIMIT ? OFFSET ?"
        ).all(taskId, limit, offset)
      : db.prepare(
          "SELECT task_id, role_name, run_id, generation, progress_id, sequence, payload, received_at FROM telemetry WHERE task_id = ? AND run_id = ? ORDER BY received_at, progress_id LIMIT ? OFFSET ?"
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
      "SELECT task_id, role_name, run_id, generation, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? AND run_id = ?"
    ).all(taskId, runId) as AggregateRow[];
    if (rows.length === 0) return null;
    return mergeAggregates(rows);
  }

  aggregateGeneration(
    taskId: string,
    roleName: string,
    runId: string,
    generation: string
  ): TelemetryAggregate | null {
    const db = this.#ensureDb();
    if (db === null) return null;
    const row = db.prepare(
      "SELECT task_id, role_name, run_id, generation, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? AND role_name = ? AND run_id = ? AND generation = ?"
    ).get(taskId, roleName, runId, generation) as AggregateRow | undefined;
    if (row === undefined) return null;
    return {
      taskId: row.task_id,
      roleName: row.role_name,
      runId: row.run_id,
      generation: row.generation,
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
      "SELECT task_id, role_name, run_id, generation, first_at, last_at, count, max_sequence, error_count FROM telemetry_aggregate WHERE task_id = ? ORDER BY run_id, generation"
    ).all(taskId) as AggregateRow[];
    return rows.map((row) => ({
      taskId: row.task_id,
      roleName: row.role_name,
      runId: row.run_id,
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

  latestProgressEvents(taskId: string): TaskEvent[] {
    const db = this.#ensureDb();
    if (db === null) return [];
    const rows = db.prepare(
      `SELECT task_id, role_name, run_id, generation, progress_id, sequence, payload, received_at FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY run_id
           ORDER BY COALESCE(sequence, -1) DESC, received_at DESC, progress_id ASC
         ) AS rn FROM telemetry WHERE task_id = ?
       ) WHERE rn = 1`
    ).all(taskId) as TelemetryRow[];
    return rows.map((row) => {
      const entry = rowToEntry(row);
      const payload: Record<string, string> = { ...entry.payload };
      payload.runId = entry.runId;
      payload.progressId = entry.progressId;
      // The semantic progress event carries progressAt = observation time;
      // mirror that so liveness folds see the same timestamp.
      payload.progressAt = entry.receivedAt;
      return {
        schemaVersion: 2 as const,
        id: `telemetry-progress-${entry.runId}-${entry.progressId}`,
        taskId: entry.taskId,
        type: "runtime.provider-turn-progress",
        payload,
        createdAt: entry.receivedAt
      };
    });
  }

  // -- retention -----------------------------------------------------------------

  pruneGeneration(
    taskId: string,
    roleName: string,
    runId: string,
    generation: string,
    keep: number = this.#terminalKeep
  ): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    const result = db.prepare(
      `DELETE FROM telemetry
       WHERE task_id = ? AND role_name = ? AND run_id = ? AND generation = ?
         AND (task_id, role_name, run_id, generation, progress_id) NOT IN (
           SELECT task_id, role_name, run_id, generation, progress_id FROM telemetry
           WHERE task_id = ? AND role_name = ? AND run_id = ? AND generation = ?
           ORDER BY COALESCE(sequence, -1) DESC, received_at DESC, progress_id ASC
           LIMIT ?
         )`
    ).run(taskId, roleName, runId, generation, taskId, roleName, runId, generation, keep);
    return result.changes;
  }

  capRun(taskId: string, runId: string, cap: number = this.#runCap): number {
    const db = this.#ensureDb();
    if (db === null) return 0;
    const result = db.prepare(
      `DELETE FROM telemetry
       WHERE task_id = ? AND run_id = ?
         AND (task_id, role_name, run_id, generation, progress_id) NOT IN (
           SELECT task_id, role_name, run_id, generation, progress_id FROM telemetry
           WHERE task_id = ? AND run_id = ?
           ORDER BY COALESCE(sequence, -1) DESC, received_at DESC, progress_id ASC
           LIMIT ?
         )`
    ).run(taskId, runId, taskId, runId, cap);
    return result.changes;
  }

  importGeneration(entries: readonly TelemetryProgressEntry[], aggregate: TelemetryAggregate): void {
    const db = this.#ensureDb();
    if (db === null) {
      this.#dropped += entries.length;
      return;
    }
    const upsert = db.prepare(
      `INSERT INTO telemetry (task_id, role_name, run_id, generation, progress_id, sequence, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, role_name, run_id, generation, progress_id) DO UPDATE SET
         sequence = excluded.sequence,
         payload = excluded.payload,
         received_at = excluded.received_at
       WHERE COALESCE(excluded.sequence, -1) > COALESCE(telemetry.sequence, -1)
          OR (excluded.sequence IS telemetry.sequence AND excluded.received_at >= telemetry.received_at)`
    );
    const upsertAggregate = db.prepare(
      `INSERT INTO telemetry_aggregate
         (task_id, role_name, run_id, generation, first_at, last_at, count, max_sequence, error_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, role_name, run_id, generation) DO UPDATE SET
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
          entry.taskId, entry.roleName, entry.runId, entry.generation, entry.progressId,
          entry.sequence ?? null, JSON.stringify(entry.payload), entry.receivedAt
        );
      }
      upsertAggregate.run(
        aggregate.taskId, aggregate.roleName, aggregate.runId, aggregate.generation,
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
      if (!existsSync(join(this.#path, ".."))) mkdirSync(join(this.#path, ".."), { recursive: true });
      const db = new Database(this.#path);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec(SCHEMA);
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
      `INSERT INTO telemetry (task_id, role_name, run_id, generation, progress_id, sequence, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, role_name, run_id, generation, progress_id) DO UPDATE SET
         sequence = excluded.sequence,
         payload = excluded.payload,
         received_at = excluded.received_at
       WHERE COALESCE(excluded.sequence, -1) > COALESCE(telemetry.sequence, -1)
          OR (excluded.sequence IS telemetry.sequence AND excluded.received_at >= telemetry.received_at)`
    );
    try {
      db.transaction(() => {
        for (const entry of batch.values()) {
          upsert.run(
            entry.taskId, entry.roleName, entry.runId, entry.generation, entry.progressId,
            entry.sequence ?? null, JSON.stringify(entry.payload), entry.receivedAt
          );
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
  run_id: string;
  generation: string;
  progress_id: string;
  sequence: number | null;
  payload: string;
  received_at: string;
}>;

type AggregateRow = Readonly<{
  task_id: string;
  role_name: string;
  run_id: string;
  generation: string;
  first_at: string;
  last_at: string;
  count: number;
  max_sequence: number | null;
  error_count: number;
}>;

function pendingKey(entry: TelemetryProgressEntry): string {
  return `${entry.taskId}\u0000${entry.roleName}\u0000${entry.runId}\u0000${entry.generation}\u0000${entry.progressId}`;
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
    runId: row.run_id,
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
    runId: rows[0].run_id,
    generation: "*",
    firstAt,
    lastAt,
    count,
    maxSequence,
    errorCount
  };
}
