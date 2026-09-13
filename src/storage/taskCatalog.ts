import type Database from "better-sqlite3";
import type { TaskStatus } from "../task/task.js";

/** Current facts, not another persisted projection or execution status. */
export const CATALOG_ATTENTION = [
  "openInputs", "pendingOperations", "unknownOperations", "executionSignals"
] as const;
export type CatalogAttentionKind = typeof CATALOG_ATTENTION[number];
export type CatalogPosition = Readonly<{ createdAt: string; id: string }>;
export type TaskCatalogQuery = Readonly<{
  taskId?: string;
  all: boolean;
  status?: TaskStatus;
  project?: string;
  search?: string;
  attention?: CatalogAttentionKind;
  after?: CatalogPosition;
  through?: CatalogPosition;
  limit: number;
}>;
export type CatalogRow = CatalogPosition & Readonly<{
  status: TaskStatus;
  updatedAt: string;
  title: string;
  summary: string | null;
  summaryPresent: boolean;
  workItems: number;
  activeRuns: number;
  openInputs: number;
  pendingOperations: number;
  unknownOperations: number;
  executionSignals: number;
}>;
export type TaskCatalogFacts = Readonly<{
  rows: readonly CatalogRow[];
  total: number;
  through: CatalogPosition | null;
  counts: Readonly<Record<TaskStatus, number> & { total: number }>;
  attention: Readonly<Record<CatalogAttentionKind, Readonly<{ count: number; taskCount: number; taskIds: readonly string[] }>>>;
}>;

/**
 * All filtering/counting stays in SQLite. Only page-sized rows and fixed
 * attention samples cross into JS; no Task/Run/Message/Event body is decoded.
 * The existing catalog and record tables remain the only stored authorities.
 */
export function queryTaskCatalog(db: Database.Database, query: TaskCatalogQuery): TaskCatalogFacts {
  const scope: string[] = ["1=1"];
  const params: Record<string, string | number> = { limit: query.limit };
  if (query.taskId !== undefined) { scope.push("c.task_id = @taskId"); params.taskId = query.taskId; }
  if (!query.all) scope.push("c.status <> 'archived'");
  const match: string[] = ["1=1"];
  if (query.status !== undefined) { match.push("status = @status"); params.status = query.status; }
  if (query.project !== undefined) {
    match.push(`EXISTS (SELECT 1 FROM task_records r, json_each(r.payload, '$.projectBindings') p
      WHERE r.task_id = facts.id AND json_extract(p.value, '$.projectId') = @project)`);
    params.project = query.project;
  }
  if (query.search) {
    match.push(`EXISTS (SELECT 1 FROM task_records r WHERE r.task_id = facts.id AND
      (instr(lower(json_extract(r.payload, '$.title')), lower(@search)) > 0
       OR instr(lower(r.task_id), lower(@search)) > 0
       OR EXISTS (SELECT 1 FROM json_each(r.payload, '$.tags') tag
          WHERE instr(lower(tag.value), lower(@search)) > 0)
       OR EXISTS (SELECT 1 FROM json_each(r.payload, '$.projectBindings') b
          JOIN projects p ON p.id = json_extract(b.value, '$.projectId')
          WHERE instr(lower(json_extract(p.payload, '$.name')), lower(@search)) > 0)))`);
    params.search = query.search;
  }
  if (query.attention !== undefined) match.push(`${query.attention} > 0`);
  const position = (name: "after" | "through", op: string) => {
    const value = query[name];
    if (value === undefined) return;
    params[`${name}Date`] = value.createdAt;
    params[`${name}Id`] = value.id;
    match.push(`(createdAt, id) ${op} (@${name}Date, @${name}Id)`);
  };
  position("through", "<=");
  // A fixed upper key excludes newly-created Tasks on later pages. Updates
  // to mutable filters are current reads, not a snapshot/session protocol.
  const after: string[] = [];
  if (query.after !== undefined) {
    params.afterDate = query.after.createdAt;
    params.afterId = query.after.id;
    after.push("(createdAt, id) > (@afterDate, @afterId)");
  }
  const count = (table: string, condition: string) =>
    `(SELECT count(*) FROM ${table} x WHERE x.task_id = c.task_id AND (${condition}))`;
  // Execution signals deliberately preserve raw inspectable conditions:
  // live runs (including unknown admission/identity/stall), unresolved work,
  // integrations, and pending Leader recovery. They are NOT a second
  // classifier for working/blocked/success; precise execution stays in detail.
  // Including all live runs is conservative: an off-page runtime attention
  // cannot disappear just because a lightweight read did not fold its history.
  const cte = `WITH facts AS MATERIALIZED (
    SELECT c.task_id AS id, c.created_at AS createdAt, c.updated_at AS updatedAt, c.status,
      ${count("work_items", "1=1")} AS workItems,
      ${count("turns", "status = 'active'")} AS activeRuns,
      ${count("input_requests", "status = 'open'")} AS openInputs,
      ${count("durable_jobs", "status IN ('queued','running')")} AS pendingOperations,
      ${count("durable_jobs", "status = 'unknown-needs-attention'")} AS unknownOperations,
      CASE WHEN c.status IN ('active','draft') THEN
        ${count("turns", "status = 'active'")} +
        ${count("work_items", "status = 'open' OR (status = 'accepted' AND json_extract(payload, '$.currentExecutionGroupId') IS NOT NULL)")} +
        ${count("integration_attempts", "status IN ('running','validating','blocked','conflicted','failed')")} +
        ${count("review_rounds", "status IN ('pending','running','failed')")} +
        ${count("task_projections", "kind = 'leader-failure' AND payload IS NOT NULL AND payload <> 'null'")} +
        ${count("mailboxes", "role_name = 'leader' AND (json_type(pending) = 'object' OR json_type(processing) = 'object')")}
      ELSE 0 END AS executionSignals
    FROM tasks_catalog c WHERE ${scope.join(" AND ")}
  ), matching AS MATERIALIZED (SELECT * FROM facts WHERE ${match.join(" AND ")})
  SELECT
    (SELECT json_group_array(json_object('status',status,'count',n))
      FROM (SELECT status,count(*) n FROM facts GROUP BY status)) AS counts,
    (SELECT count(*) FROM matching) AS total,
    (SELECT json_object('id',id,'createdAt',createdAt) FROM matching
      ORDER BY createdAt DESC,id DESC LIMIT 1) AS upper,
    ${CATALOG_ATTENTION.map(kind => `
      (SELECT sum(${kind}) FROM facts) AS ${kind}Count,
      (SELECT count(*) FROM facts WHERE ${kind} > 0) AS ${kind}Tasks,
      (SELECT json_group_array(id) FROM (SELECT id FROM facts WHERE ${kind} > 0
        ORDER BY createdAt,id LIMIT 4)) AS ${kind}Ids`).join(",")},
    (SELECT json_group_array(json_object(
      'id',page.id,'createdAt',page.createdAt,'updatedAt',page.updatedAt,'status',page.status,
      'title',substr(json_extract(r.payload,'$.title'),1,256),
      'summary',substr(json_extract(r.brief,'$.leaderSummary'),1,512),
      'summaryPresent',json(CASE WHEN r.brief IS NULL THEN 'false' ELSE 'true' END),
      'workItems',page.workItems,'activeRuns',page.activeRuns,
      'openInputs',page.openInputs,'pendingOperations',page.pendingOperations,
      'unknownOperations',page.unknownOperations,'executionSignals',page.executionSignals)
      ORDER BY page.createdAt,page.id)
      FROM (SELECT * FROM matching ${after.length ? `WHERE ${after.join(" AND ")}` : ""}
        ORDER BY createdAt,id LIMIT @limit) page
      JOIN task_records r ON r.task_id = page.id) AS rows`;
  const result = db.prepare(cte).get(params) as Record<string, string | number | null>;
  const counts = { draft: 0, active: 0, completed: 0, cancelled: 0, archived: 0, total: 0 };
  for (const entry of JSON.parse(result.counts as string) as { status: TaskStatus; count: number }[]) {
    counts[entry.status] = entry.count;
    counts.total += entry.count;
  }
  return {
    rows: JSON.parse(result.rows as string),
    total: result.total as number,
    through: result.upper === null ? null : JSON.parse(result.upper as string),
    counts,
    attention: Object.fromEntries(CATALOG_ATTENTION.map(kind => [kind, {
      count: Number(result[`${kind}Count`] ?? 0),
      taskCount: Number(result[`${kind}Tasks`] ?? 0),
      taskIds: JSON.parse(result[`${kind}Ids`] as string)
    }])) as TaskCatalogFacts["attention"]
  };
}
