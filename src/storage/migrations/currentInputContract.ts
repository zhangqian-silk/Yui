import type Database from "better-sqlite3";

/** Frozen 33→34 boundary. An old immediate request without origin was not
 * auto-adoptable. Its owner must activate or cancel it with the old release;
 * an upgrade cannot make that choice, even while execution is stopped. */
export function preflightCurrentInputContract(db: Database.Database): void {
  const blocked = db.prepare(`SELECT task_id FROM task_records
    WHERE json_extract(payload,'$.status')='draft'
      AND json_type(payload,'$.retiredAt') IS NULL
      AND json_extract(payload,'$.activationRequest.startMode')='immediate'
      AND json_extract(payload,'$.activationRequest.disposition')='pending'
      AND json_type(payload,'$.activationRequest.origin') IS NULL LIMIT 1`)
    .get() as { task_id: string } | undefined;
  if (blocked !== undefined) {
    throw new Error(`Input contract cutover requires explicit activation or cancellation of the origin-less pending request: ${blocked.task_id}. Preserve the request and resolve it with the old release before upgrading.`);
  }
}

/** Preserve original representations as audit Events, not runtime alternatives.
 * All interpretation of wakePolicy/origin ends at this migration. */
export function migrateCurrentInputContract(db: Database.Database): void {
  preflightCurrentInputContract(db);
  const highWater = db.prepare(`SELECT max(
    coalesce((SELECT high_water FROM id_sequences WHERE task_id=? AND kind='event'),0),
    coalesce((SELECT max(CAST(substr(event_id,7) AS INTEGER)) FROM events WHERE task_id=?),0)
  ) AS value`);
  const saveEvent = db.prepare("INSERT INTO events(task_id,event_id,type,occurred_at,payload) VALUES(?,?,?,?,?)");
  const saveCounter = db.prepare(`INSERT INTO id_sequences(task_id,kind,high_water) VALUES(?,'event',?)
    ON CONFLICT(task_id,kind) DO UPDATE SET high_water=max(high_water,excluded.high_water)`);
  const at = new Date().toISOString();
  const archive = (taskId: string, type: string, record: string) => {
    const seq = (highWater.get(taskId, taskId) as { value: number }).value + 1;
    const event = { schemaVersion: 2, id: `event-${seq}`, taskId, type, createdAt: at,
      payload: { record, disposition: "audit-only" } };
    saveEvent.run(taskId, event.id, type, at, JSON.stringify(event));
    saveCounter.run(taskId, seq);
  };
  const messages = db.prepare("SELECT task_id,message_id,payload FROM messages ORDER BY task_id,seq")
    .all() as Array<{ task_id: string; message_id: string; payload: string }>;
  const saveMessage = db.prepare("UPDATE messages SET payload=? WHERE task_id=? AND message_id=?");
  for (const row of messages) {
    const message = JSON.parse(row.payload);
    const user = message.kind === "user" || message.kind === "operator";
    const hasPolicy = Object.hasOwn(message, "wakePolicy");
    if (message.schemaVersion !== 3 || message.id !== row.message_id || message.taskId !== row.task_id
      || (hasPolicy && (!user || !["leader", "none"].includes(message.wakePolicy)))
      || (message.intent !== undefined && (!user || !["record", "discuss", "develop"].includes(message.intent)))
      || (hasPolicy && message.intent !== undefined
        && (message.wakePolicy === "none") !== (message.intent === "record"))) {
      throw new Error(`Invalid historical Message input: ${row.task_id}/${row.message_id}. Preserve it for diagnosis.`);
    }
    if (!hasPolicy && (!user || message.intent !== undefined)) continue;
    archive(row.task_id, "message.input-contract-retired", row.payload);
    if (user && message.intent === undefined) {
      message.intent = message.wakePolicy === "none" ? "record" : "discuss";
    }
    delete message.wakePolicy;
    saveMessage.run(JSON.stringify(message), row.task_id, row.message_id);
  }
  const tasks = db.prepare("SELECT task_id,payload FROM task_records ORDER BY task_id")
    .all() as Array<{ task_id: string; payload: string }>;
  const saveTask = db.prepare("UPDATE task_records SET payload=? WHERE task_id=?");
  for (const row of tasks) {
    const task = JSON.parse(row.payload);
    const requests = [
      ...(task.activationRequest === undefined ? [] : [task.activationRequest]),
      ...(task.settledActivationRequests ?? [])
    ];
    let changed = false;
    for (const request of requests) {
      if (request === null || typeof request !== "object" || request.schemaVersion !== 1
        || request.operation?.targetId !== row.task_id
        || !["immediate", "after-planning-turn"].includes(request.startMode)
        || !["pending", "failed", "cancelled", "adopted"].includes(request.disposition)
        || (Object.hasOwn(request, "origin") && !["explicit", "submit-develop"].includes(request.origin))) {
        throw new Error(`Invalid historical activation request: ${row.task_id}. Preserve it for diagnosis.`);
      }
      if (Object.hasOwn(request, "origin")) {
        changed = true;
        delete request.origin;
      }
    }
    if (changed) {
      archive(row.task_id, "task.activation-origin-retired", row.payload);
      saveTask.run(JSON.stringify(task), row.task_id);
    }
  }
}
