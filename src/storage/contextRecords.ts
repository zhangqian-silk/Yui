import type Database from "better-sqlite3";

/** Read-only projections of existing tables, not a new Context index or Store. */
const FAMILIES = {
  "work-item": ["work_items", "work_item_id"],
  "candidate": ["work_items", "work_item_id"],
  "environment-preparation": ["environment_preparations", "id"],
  "managed-workspace": ["managed_workspaces", "owner_id"],
  "change-set": ["change_sets", "change_set_id"],
  "task-message": ["messages", "message_id"],
  "run": ["turns", "turn_id"],
  "review-round": ["review_rounds", "review_round_id"],
  "input-request": ["input_requests", "input_id"],
  "task-decision": ["decisions", "decision_id"],
  "task-milestone": ["milestones", "milestone_id"],
  "job": ["durable_jobs", "job_id"],
  "publication": ["publication_references", "publication_id"],
  "task-event": ["events", "event_id"]
} as const;

export type ContextRecordFamily = keyof typeof FAMILIES;
export type ContextRecordQuery = Readonly<{
  family: ContextRecordFamily;
  ids?: readonly string[];
  statuses?: readonly string[];
  excludeStatuses?: readonly string[];
  eventTypes?: readonly string[];
  afterSequence?: number;
  throughSequence?: number;
  descending?: boolean;
  limit: number;
  offset?: number;
}>;
export type ContextRecordPage = Readonly<{
  count: number;
  records: readonly Readonly<{ id: string; value: unknown }>[];
}>;

export type ContextInputScope = Readonly<{ roleName: string; workItemId?: string; reviewRoundId?: string }>;

/** Only identities cross this query: shared user intent and the exact live
 * Assignment's steers augment frozen read refs without loading other messages.
 */
export function contextInputReferences(db: Database.Database, taskId: string, scope: ContextInputScope) {
  const shared = `json_extract(m.payload, '$.kind') IN ('user','operator')
    AND json_extract(m.payload, '$.recipient') IS NULL
    AND json_extract(m.payload, '$.workItemId') IS NULL
    AND json_extract(m.payload, '$.runId') IS NULL`;
  const steer = `(COALESCE(json_extract(m.payload, '$.inputControl.action'), '') = 'steer'
    OR COALESCE(json_extract(m.payload, '$.interruptThen.reusedInput.action'), '') = 'steer')`;
  const matches = `m.task_id = @taskId AND (
    ((${shared}) AND NOT ${steer}) OR (${steer}
      AND json_extract(m.payload, '$.recipient.roleName') = @roleName
      AND json_extract(m.payload, '$.recipient.workItemId') IS @workItemId
      AND json_extract(m.payload, '$.recipient.reviewRoundId') IS @reviewRoundId))`;
  const params = { taskId, roleName: scope.roleName,
    workItemId: scope.workItemId ?? null, reviewRoundId: scope.reviewRoundId ?? null };
  const ids = `SELECT m.message_id FROM messages m WHERE ${matches}`;
  const messages = (db.prepare(ids).all(params) as { message_id: string }[]).map(row => row.message_id);
  const events = (db.prepare(`SELECT event_id FROM events
    WHERE task_id = @taskId AND type GLOB 'message.*'
      AND json_extract(payload, '$.payload.messageId') IN (${ids})`
  ).all(params) as { event_id: string }[]).map(row => row.event_id);
  return { messages, events };
}

export function queryContextRecords(
  db: Database.Database, taskId: string, query: ContextRecordQuery
): ContextRecordPage {
  const family = FAMILIES[query.family];
  if (family === undefined || !Number.isSafeInteger(query.limit) || query.limit < 0 || query.limit > 256
    || !Number.isSafeInteger(query.offset ?? 0) || (query.offset ?? 0) < 0) {
    throw new Error("Context record query exceeds its bounded contract.");
  }
  const [table, key] = family;
  const candidate = query.family === "candidate";
  const payload = candidate ? "candidate.value" : "r.payload";
  const id = candidate ? `r.${key} || '/' || json_extract(candidate.value, '$.id')` : `r.${key}`;
  const from = `${table} r${candidate ? ", json_each(r.payload, '$.candidates') candidate" : ""}`;
  const where = ["r.task_id = @taskId"];
  const params: Record<string, string | number> = { taskId };
  if (query.ids !== undefined) {
    where.push(`${id} IN (SELECT value FROM json_each(@ids))`);
    params.ids = JSON.stringify(query.ids);
  }
  for (const [label, statuses, not] of [
    ["statuses", query.statuses, ""],
    ["excludeStatuses", query.excludeStatuses, "NOT"]
  ] as const) {
    if (statuses !== undefined) {
      where.push(`json_extract(${payload}, '$.status') ${not} IN (SELECT value FROM json_each(@${label}))`);
      params[label] = JSON.stringify(statuses);
    }
  }
  const sequence = `CAST(substr(r.${key}, length(r.${key}) - length(ltrim(r.${key}, 'abcdefghijklmnopqrstuvwxyz-')) + 1) AS INTEGER)`;
  // Task-local numeric IDs are the stable historical order, not lexical 1,10,2.
  if (query.family === "task-event") {
    if (query.eventTypes !== undefined) {
      where.push("r.type IN (SELECT value FROM json_each(@types))");
      params.types = JSON.stringify(query.eventTypes);
    }
    for (const [key, value, comparison] of [
      ["after", query.afterSequence, ">"], ["through", query.throughSequence, "<="]
    ] as const) {
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid event cursor.");
        where.push(`${sequence} ${comparison} @${key}`);
        params[key] = value;
      }
    }
  }
  const condition = where.join(" AND ");
  const count = (db.prepare(`SELECT count(*) AS n FROM ${from} WHERE ${condition}`).get(params) as { n: number }).n;
  if (query.limit === 0 || count === 0) return { count, records: [] };
  const direction = query.descending ? "DESC" : "ASC";
  const order = query.family === "work-item" || candidate
    ? `r.updated_at DESC, ${sequence} ASC${candidate ? ", candidate.key DESC" : ""}`
    : query.family === "managed-workspace" ? `r.${key} ${direction}` : `${sequence} ${direction}, r.${key} ${direction}`;
  const rows = db.prepare(`SELECT ${id} AS id, ${payload} AS payload
    FROM ${from} WHERE ${condition} ORDER BY ${order} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: query.limit, offset: query.offset ?? 0 }) as { id: string; payload: string }[];
  return { count, records: rows.map(row => ({ id: row.id, value: JSON.parse(row.payload) })) };
}
