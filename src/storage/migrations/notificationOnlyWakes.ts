import type Database from "better-sqlite3";

type RunLinkedWake = {
  task_id: string; wake_id: string; seq: number; turn_id: string | null; payload: string;
};

function runLinkedWakes(db: Database.Database): RunLinkedWake[] {
  return db.prepare(`SELECT task_id, wake_id, seq, turn_id, payload FROM task_wakes
    WHERE turn_id IS NOT NULL OR json_type(payload, '$.runId') IS NOT NULL
    ORDER BY task_id, seq`).all() as RunLinkedWake[];
}

/** Read only stable SQL identities, including prefixes before payload key renames. */
export function preflightNotificationOnlyWakes(db: Database.Database): void {
  assertQuiescent(db, runLinkedWakes(db));
}

/** Frozen 29→30 transform. Old execution-linked wakes become audit events;
 * accepted/pending notifications keep their exact identity and delivery state. */
export function migrateNotificationOnlyWakes(db: Database.Database): void {
  const rows = runLinkedWakes(db);
  // Check every retiring reference before changing any data. The outer
  // migration transaction also rolls back on any later failure.
  for (const row of rows) {
    const value = JSON.parse(row.payload) as { runId?: unknown };
    if (typeof value.runId !== "string" || value.runId !== row.turn_id) {
      throw new Error(`Run-linked wake identity is inconsistent: ${row.task_id}/${row.wake_id}.`);
    }
  }
  assertQuiescent(db, rows);
  const counters = new Map<string, number>();
  const readCounter = db.prepare(`SELECT max(
    coalesce((SELECT high_water FROM id_sequences WHERE task_id = ? AND kind = 'event'), 0),
    coalesce((SELECT max(CAST(substr(event_id, 7) AS INTEGER)) FROM events WHERE task_id = ?), 0)
  ) AS value`);
  const saveCounter = db.prepare(`INSERT INTO id_sequences(task_id, kind, high_water) VALUES (?, ?, ?)
    ON CONFLICT(task_id, kind) DO UPDATE SET high_water = max(high_water, excluded.high_water)`);
  const saveEvent = db.prepare("INSERT INTO events(task_id, event_id, type, occurred_at, payload) VALUES (?, ?, ?, ?, ?)");
  const removeWake = db.prepare("DELETE FROM task_wakes WHERE task_id = ? AND wake_id = ?");
  const at = new Date().toISOString();
  for (const row of rows) {
    const sequence = (counters.get(row.task_id)
      ?? (readCounter.get(row.task_id, row.task_id) as { value: number }).value) + 1;
    counters.set(row.task_id, sequence);
    const event = {
      schemaVersion: 2, id: `event-${sequence}`, taskId: row.task_id,
      type: "wake.run-link-retired", createdAt: at,
      payload: { wakeId: row.wake_id, runId: row.turn_id!,
        record: row.payload, disposition: "retired-without-replay" }
    };
    saveEvent.run(row.task_id, event.id, event.type, at, JSON.stringify(event));
    saveCounter.run(row.task_id, "event", sequence);
    saveCounter.run(row.task_id, "taskWake", row.seq);
    removeWake.run(row.task_id, row.wake_id);
  }
  db.exec(`
    ALTER TABLE task_wakes DROP COLUMN turn_id;
    UPDATE task_wakes SET payload = json_set(payload, '$.schemaVersion', 2);
    UPDATE global_role_session_sets
      SET payload = json_set(payload, '$.providerBinding', json('null'))
      WHERE json_type(payload, '$.providerBinding') IS NULL;
  `);
}

function assertQuiescent(db: Database.Database, rows: readonly RunLinkedWake[]): void {
  const activeRun = db.prepare("SELECT 1 FROM turns WHERE task_id = ? AND turn_id = ? AND status = 'active'");
  const claimedWake = db.prepare(`SELECT 1 FROM mailboxes WHERE task_id = ?
    AND json_extract(processing, '$.owner') = ? LIMIT 1`);
  const pendingInput = db.prepare(`SELECT 1 FROM role_session_sets WHERE task_id = ? AND (
    (json_extract(payload, '$.providerBinding.run.status') IN ('submitting', 'accepted', 'delivery-unknown')
      AND (json_extract(payload, '$.providerBinding.run.runId') = ?
        OR json_extract(payload, '$.providerBinding.run.input.wakeId') = ?))
    OR (json_extract(payload, '$.providerBinding.retry.status') IN ('waiting', 'in-flight')
      AND (json_extract(payload, '$.providerBinding.retry.input.runId') = ?
        OR json_extract(payload, '$.providerBinding.retry.input.wakeId') = ?))) LIMIT 1`);
  for (const row of rows) {
    if (activeRun.get(row.task_id, row.turn_id)
      || claimedWake.get(row.task_id, `leader-notification:${row.wake_id}`)
      || pendingInput.get(row.task_id, row.turn_id, row.wake_id, row.turn_id, row.wake_id)) {
      throw new Error(`Run-linked wake still owns unsettled input: ${row.task_id}/${row.wake_id}, Run ${row.turn_id}. Settle or stop that exact execution before upgrading.`);
    }
  }
}
