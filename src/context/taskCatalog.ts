import { usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import { contextContentDigest } from "./contextSnapshot.js";
import { materialize, resolveContextReader } from "./taskContext.js";
import {
  CATALOG_ATTENTION, type CatalogAttentionKind, type CatalogPosition,
  type TaskCatalogQuery
} from "../storage/taskCatalog.js";
import type { TaskStatus } from "../task/task.js";

const TASK_STATUSES = ["draft", "active", "completed", "cancelled", "archived"] as const satisfies readonly TaskStatus[];
const PAGE_BYTES = 32 * 1024;
const SUMMARY_BYTES = 512;
const MAX_LIMIT = 100;
export type TaskCatalogOptions = Omit<TaskCatalogQuery, "taskId" | "after" | "through"> & { cursor?: string };
type CatalogRef = ReturnType<typeof materialize>["ref"] & { taskId: string };
type Cursor = { version: 1; scope: string; after: CatalogPosition; through: CatalogPosition };

export function parseTaskCatalogOptions(args: readonly string[]): TaskCatalogOptions {
  const values = new Map<string, string>();
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--all" && !all) { all = true; continue; }
    if (!["--view", "--limit", "--cursor", "--status", "--project", "--search", "--attention"].includes(key)
      || values.has(key) || args[i + 1] === undefined || args[i + 1]!.startsWith("--")) {
      throw usageError("Compact Task list expects --view compact [--all] [--status <status>] [--project <id>] [--search <text>] [--attention <category>] [--limit <1..100>] [--cursor <cursor>].");
    }
    values.set(key, args[++i]!);
  }
  if (values.get("--view") !== "compact") throw usageError("Task list view must be compact.");
  const status = values.get("--status");
  if (status !== undefined && !TASK_STATUSES.includes(status as typeof TASK_STATUSES[number])) {
    throw usageError("Unknown Task catalog status.");
  }
  const attention = values.get("--attention");
  if (attention !== undefined && !CATALOG_ATTENTION.includes(attention as CatalogAttentionKind)) {
    throw usageError(`Task catalog attention must be one of: ${CATALOG_ATTENTION.join(", ")}.`);
  }
  const limit = values.has("--limit") ? Number(values.get("--limit")) : 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw usageError("Task catalog limit must be between 1 and 100.");
  const search = values.get("--search")?.trim();
  const project = values.get("--project")?.trim();
  if ((search?.length ?? 0) > 256 || (project?.length ?? 0) > 256 || project === "") {
    throw usageError("Task catalog filters exceed their text limit.");
  }
  return {
    all: all || status === "archived", limit,
    ...(status === undefined ? {} : { status: status as typeof TASK_STATUSES[number] }),
    ...(attention === undefined ? {} : { attention: attention as CatalogAttentionKind }),
    ...(search ? { search } : {}),
    ...(project === undefined ? {} : { project }),
    ...(values.has("--cursor") ? { cursor: values.get("--cursor")! } : {})
  };
}

/** Task-local Leaders discover only their Task. Assignment Roles use their
 * existing Context pack: whole-Task counts would leak unrelated assignments. */
export function taskCatalogScope(store: TaskStore, environment: NodeJS.ProcessEnv) {
  const caller = resolveContextReader(store, environment);
  if (caller !== undefined && caller.roleName !== "leader") {
    throw usageError("Task discovery is unavailable to an Assignment-scoped Role; use its authorized Run Context.");
  }
  return caller?.taskId;
}

export function readTaskCatalog(
  store: TaskStore, options: TaskCatalogOptions, environment: NodeJS.ProcessEnv = {}
) {
  return store.transaction(reader => {
    const taskId = taskCatalogScope(reader, environment);
    const { cursor: rawCursor, ...filters } = options;
    if (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > MAX_LIMIT) {
      throw usageError("Task catalog limit must be between 1 and 100.");
    }
    const scope = contextContentDigest({ taskId: taskId ?? null, ...filters });
    const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, scope);
    const facts = reader.queryTaskCatalog({
      ...filters, ...(taskId === undefined ? {} : { taskId }),
      ...(cursor === undefined ? {} : { after: cursor.after, through: cursor.through }),
      limit: options.limit + 1
    });
    const refs = new Map<string, CatalogRef>();
    const getRef = (id: string) => {
      let ref = refs.get(id);
      if (ref === undefined) {
        const task = reader.getTask(id);
        if (task === null) throw usageError("Task catalog changed during the read; retry.");
        ref = { taskId: id, ...materialize("task", id, task).ref };
        refs.set(id, ref);
      }
      return ref;
    };
    const attention = Object.fromEntries(CATALOG_ATTENTION.map(kind => {
      const source = facts.attention[kind];
      const selected: CatalogRef[] = [];
      for (const id of source.taskIds) {
        const ref = getRef(id);
        if (bytes([...selected, ref]) <= 2048) selected.push(ref);
      }
      return [kind, {
        count: source.count,
        unit: kind === "executionSignals" ? "signals" : "records",
        refs: selected,
        // Samples identify affected Tasks, not individual records. Count and
        // sample size therefore must never be subtracted from one another.
        taskCount: source.taskCount,
        omittedTaskRefs: source.taskCount - selected.length,
        query: { view: "compact", all: options.all, attention: kind }
      }];
    })) as Record<CatalogAttentionKind, {
      count: number; unit: string; refs: CatalogRef[]; taskCount: number; omittedTaskRefs: number;
      query: { view: string; all: boolean; attention: CatalogAttentionKind };
    }>;
    const response = {
      view: "compact" as const,
      scope: { taskId: taskId ?? null, archived: options.all ? "included" : "excluded",
        attention: "authorized-catalog-before-filters", executionSignals: "raw-inspection-candidates-not-execution-status" },
      filters, total: facts.total, counts: facts.counts, attention,
      tasks: [] as Array<{
        id: string; title: string; status: typeof TASK_STATUSES[number]; createdAt: string; updatedAt: string;
        summary: string | null; summaryStatus: string; omitted: { title: boolean; summary: boolean };
        counts: { workItems: number; activeRuns: number };
        attention: Record<CatalogAttentionKind, number>; ref: CatalogRef;
      }>,
      nextCursor: null as string | null,
      consistency: "current-per-page; refresh for membership changes; new creation keys after the upper bound excluded",
      limits: { pageBytes: PAGE_BYTES, summaryBytes: SUMMARY_BYTES, maxTasks: options.limit, attentionTaskRefsPerCategory: 4 }
    };
    const through = cursor?.through ?? facts.through;
    const continuation = (after: CatalogPosition) => through === null ? null
      : Buffer.from(JSON.stringify({ version: 1, scope, after, through } satisfies Cursor)).toString("base64url");
    for (const row of facts.rows.slice(0, options.limit)) {
      const ref = getRef(row.id);
      const summary = row.summary === null ? null : truncateUtf8(row.summary, SUMMARY_BYTES);
      const title = truncateUtf8(row.title, 256);
      // SQL already limits these fields. Compare against the selected original
      // only when necessary; length-at-limit is conservatively marked omitted.
      const item = {
        id: row.id, title, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
        summary, summaryStatus: row.summaryPresent ? "available" : "missing",
        omitted: { title: row.title.length >= 256 || title !== row.title,
          summary: row.summary !== null && (row.summary.length >= 512 || summary !== row.summary) },
        counts: { workItems: row.workItems, activeRuns: row.activeRuns },
        attention: Object.fromEntries(CATALOG_ATTENTION.map(kind => [kind, row[kind]])) as Record<CatalogAttentionKind, number>,
        ref
      };
      const next = continuation({ id: row.id, createdAt: row.createdAt });
      if (bytes({ ok: true, data: { ...response, tasks: [...response.tasks, item], nextCursor: next } }) + 1 > PAGE_BYTES) break;
      response.tasks.push(item);
    }
    if (response.tasks.length < facts.rows.length) {
      const last = response.tasks.at(-1);
      if (last === undefined) throw usageError("Task catalog identity/attention metadata exceeds the page byte budget.");
      response.nextCursor = continuation({ id: last.id, createdAt: last.createdAt });
    }
    if (bytes({ ok: true, data: response }) + 1 > PAGE_BYTES) throw usageError("Task catalog metadata exceeds the page byte budget.");
    return response;
  });
}

export function renderTaskCatalog(result: ReturnType<typeof readTaskCatalog>): string {
  return [
    `Tasks (compact): ${result.tasks.length} shown; ${result.total} matching`,
    ...result.tasks.map(task => `${task.id}\t${task.status}\t${task.title}\n  ${task.summary ?? "(summary missing)"}`),
    `Attention across catalog: ${CATALOG_ATTENTION.map(kind => `${kind}=${result.attention[kind].count}`).join(", ")}`,
    "Expand: yui task context <task-id>; inspect the Task ref for original requirements.",
    ...(result.nextCursor === null ? [] : [`Next cursor: ${result.nextCursor}`])
  ].join("\n") + "\n";
}

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function truncateUtf8(value: string, max: number): string {
  let result = ""; let size = 0;
  for (const point of value) {
    size += Buffer.byteLength(point);
    if (size > max) break;
    result += point;
  }
  return result;
}
function decodeCursor(raw: string, scope: string): Cursor {
  try {
    if (raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    const validKey = (key: CatalogPosition) => key && typeof key.id === "string" && key.id.length > 0
      && typeof key.createdAt === "string" && Number.isFinite(Date.parse(key.createdAt));
    if (parsed.version !== 1 || parsed.scope !== scope || !validKey(parsed.after) || !validKey(parsed.through)
      || parsed.after.createdAt > parsed.through.createdAt
      || (parsed.after.createdAt === parsed.through.createdAt
        && Buffer.compare(Buffer.from(parsed.after.id), Buffer.from(parsed.through.id)) > 0)) throw new Error();
    return parsed;
  } catch { throw usageError("Invalid Task catalog cursor or cursor belongs to another scope/filter."); }
}
