import type Database from "better-sqlite3";
import type { TelemetryProgressEntry } from "./telemetryStore.js";

/** Runs on the existing persistence worker's connection, never the ingress
 * thread. Telemetry keeps its existing idempotent keys and aggregate triggers;
 * it neither bumps Task revisions nor creates durable RPC outbox records.
 */
export function writeTelemetryBatch(
  db: Database.Database, entries: readonly TelemetryProgressEntry[], runCap: number
): void {
  if (!Number.isSafeInteger(runCap) || runCap < 1 || entries.length > 256) {
    throw new Error("Telemetry batch exceeds its bounded write contract.");
  }
  const upsert = db.prepare(
    `INSERT INTO telemetry (task_id, role_name, turn_id, progress_id, sequence, payload, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, role_name, turn_id, progress_id) DO UPDATE SET
       sequence = excluded.sequence, payload = excluded.payload, received_at = excluded.received_at
     WHERE excluded.received_at >= telemetry.received_at`
  );
  const cap = db.prepare(
    `DELETE FROM telemetry WHERE task_id = ? AND turn_id = ?
     AND (task_id, role_name, turn_id, progress_id) NOT IN (
       SELECT task_id, role_name, turn_id, progress_id FROM telemetry
       WHERE task_id = ? AND turn_id = ?
       ORDER BY received_at DESC, COALESCE(sequence, -1) DESC, progress_id ASC LIMIT ?
     )`
  );
  db.transaction(() => {
    const runs = new Map<string, TelemetryProgressEntry>();
    for (const entry of entries) {
      upsert.run(entry.taskId, entry.roleName, entry.runId, entry.progressId,
        entry.sequence ?? null, JSON.stringify(entry.payload), entry.receivedAt);
      runs.set(`${entry.taskId}\0${entry.runId}`, entry);
    }
    for (const { taskId, runId } of runs.values()) cap.run(taskId, runId, taskId, runId, runCap);
  })();
}
