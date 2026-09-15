import type Database from "better-sqlite3";

/** Frozen 31→32 transform: obsolete execution-shaped diagnostics are audit
 * records, not another representation of current WorkItem state. */
export function migrateWorkItemHistory(db: Database.Database): void {
  const rows = db.prepare(`SELECT task_id, work_item_id, payload FROM work_items
    WHERE json_type(payload, '$.historicalState') IS NOT NULL
    ORDER BY task_id, work_item_id`).all() as Array<{
    task_id: string; work_item_id: string; payload: string;
  }>;
  for (const row of rows) {
    const value = JSON.parse(row.payload);
    const history = value.historicalState;
    if (value.taskId !== row.task_id || value.id !== row.work_item_id
      || history === null || typeof history !== "object" || Array.isArray(history)
      || !["pending", "running", "awaiting_acceptance", "completed", "failed", "retired"].includes(history.status)
      || (history.outcome !== undefined && !text(history.outcome))
      || (history.endedAt !== undefined
        && (!text(history.endedAt) || !Number.isFinite(Date.parse(history.endedAt))))) {
      throw new Error(`Invalid historical WorkItem execution state: ${row.task_id}/${row.work_item_id}. Preserve it for diagnosis.`);
    }
  }
  const highWater = db.prepare(`SELECT max(
    coalesce((SELECT high_water FROM id_sequences WHERE task_id = ? AND kind = 'event'), 0),
    coalesce((SELECT max(CAST(substr(event_id, 7) AS INTEGER)) FROM events WHERE task_id = ?), 0)
  ) AS value`);
  const saveEvent = db.prepare("INSERT INTO events(task_id,event_id,type,occurred_at,payload) VALUES(?,?,?,?,?)");
  const saveCounter = db.prepare(`INSERT INTO id_sequences(task_id,kind,high_water) VALUES(?,'event',?)
    ON CONFLICT(task_id,kind) DO UPDATE SET high_water=max(high_water,excluded.high_water)`);
  const removeHistoricalState = db.prepare(`UPDATE work_items SET payload=json_remove(payload,'$.historicalState')
    WHERE task_id=? AND work_item_id=?`);
  const counters = new Map<string, number>();
  const at = new Date().toISOString();
  for (const row of rows) {
    const sequence = (counters.get(row.task_id)
      ?? (highWater.get(row.task_id, row.task_id) as { value: number }).value) + 1;
    counters.set(row.task_id, sequence);
    const event = {
      schemaVersion: 2, id: `event-${sequence}`, taskId: row.task_id,
      type: "work-item.execution-state-retired", createdAt: at,
      payload: { workItemId: row.work_item_id, record: row.payload, disposition: "audit-only" }
    };
    saveEvent.run(row.task_id, event.id, event.type, at, JSON.stringify(event));
    saveCounter.run(row.task_id, sequence);
    removeHistoricalState.run(row.task_id, row.work_item_id);
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}
