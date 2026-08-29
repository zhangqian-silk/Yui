import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { scanControllerResourceInventory } from "../../controller/resourceInventoryLinux.js";
import type { ControllerResourceInventory } from "../../controller/resourceInventory.js";
import { STORAGE_STATE_FILE } from "../taskStore.js";
import { SQLITE_LAYOUT_VERSION } from "../sqliteSchema.js";
import { inspectStorageSchema } from "../storageSchema.js";

type OfflineRuntimeInventory = Pick<ControllerResourceInventory, "resources" | "warnings">;

export type OfflineUpgradeBlockerReason =
  | "active-run"
  | "in-flight-run"
  | "native-session-live"
  | "native-session-unknown"
  | "pending-completion"
  | "pending-mailbox"
  | "pending-inbox";

export type OfflineUpgradeBlocker = Readonly<{
  taskId?: string;
  roleName?: string;
  runId?: string;
  nativeSessionId?: string;
  launchId?: string;
  reason: OfflineUpgradeBlockerReason;
}>;

export type OfflineUpgradeFacts = Readonly<{
  runs: readonly Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    status: string;
    nativeSessionId?: string;
    launchId?: string;
  }>[];
  sessions: readonly Readonly<{
    taskId?: string;
    roleName: string;
    nativeSessionId?: string;
    launchId?: string;
    status: string;
    processState: "live" | "stopped" | "unknown";
    history: boolean;
    /** Exact current binding within the RoleSessionSet, when known. */
    active?: boolean;
  }>[];
  inFlight: readonly Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    nativeSessionId?: string;
    launchId?: string;
  }>[];
  pendingCompletions: readonly Readonly<{
    taskId: string;
    roleName: string;
    runId?: string;
    nativeSessionId?: string;
    launchId?: string;
  }>[];
  lifecycle: readonly Readonly<{
    taskId?: string;
    roleName?: string;
    runId?: string;
    nativeSessionId?: string;
    launchId?: string;
    reason: "pending-mailbox" | "pending-inbox";
  }>[];
  /** Native runtime existence/ownership could not be disproved read-only. */
  unknownRuntime?: readonly Readonly<{
    taskId?: string;
    roleName?: string;
    nativeSessionId?: string;
    launchId?: string;
  }>[];
}>;

export type OfflineUpgradeInventory = Readonly<{
  total: number;
  blockers: readonly OfflineUpgradeBlocker[];
}>;

/** Pure blocker policy shared by synthetic tests and the real read-only scan. */
export function classifyOfflineUpgradeFacts(
  facts: OfflineUpgradeFacts
): OfflineUpgradeInventory {
  const blockers: OfflineUpgradeBlocker[] = [];
  for (const run of facts.runs) {
    if (run.status !== "active") continue;
    blockers.push(identity(run, "active-run"));
  }
  for (const session of facts.sessions) {
    if (session.processState === "live") {
      blockers.push(identity(session, "native-session-live"));
    } else if (session.processState === "unknown") {
      blockers.push(identity(session, "native-session-unknown"));
    }
  }
  for (const inFlight of facts.inFlight) {
    blockers.push(identity(inFlight, "in-flight-run"));
  }
  for (const completion of facts.pendingCompletions) {
    blockers.push(identity(completion, "pending-completion"));
  }
  for (const lifecycle of facts.lifecycle) {
    blockers.push(identity(lifecycle, lifecycle.reason));
  }
  for (const unknown of facts.unknownRuntime ?? []) {
    blockers.push(identity(unknown, "native-session-unknown"));
  }
  return { total: blockers.length, blockers };
}

/**
 * Re-read durable Run/RoleSessionSet/lifecycle facts and the native process
 * inventory without mutating, stopping, acknowledging, or quarantining them.
 */
export async function inspectOfflineUpgradeInventory(
  home: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<OfflineUpgradeInventory> {
  const inventory = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current",
    environment
  });
  const raw = readRawFacts(home, inventory);
  return classifyOfflineUpgradeFacts(raw);
}

function readRawFacts(
  home: string,
  inventory: OfflineRuntimeInventory,
  state: Record<string, unknown> = readDurableStateObject(home),
  conservativeDurableSessions = false
): OfflineUpgradeFacts {
  const runs: Array<OfflineUpgradeFacts["runs"][number]> = [];
  const sessions: Array<OfflineUpgradeFacts["sessions"][number]> = [];
  const inFlight: Array<OfflineUpgradeFacts["inFlight"][number]> = [];
  const pendingCompletions: Array<OfflineUpgradeFacts["pendingCompletions"][number]> = [];
  const lifecycle: Array<OfflineUpgradeFacts["lifecycle"][number]> = [];
  const unknownRuntime: Array<NonNullable<OfflineUpgradeFacts["unknownRuntime"]>[number]> = [];
  // Failure to enumerate processes, panes, or sockets means absence cannot be
  // proven. Ownership-load warnings are expected for an old record shape and
  // are handled by the raw durable scan plus unowned live-pane check below.
  if (inventory.warnings.some(isUndeterminableNativeInventoryWarning)) {
    unknownRuntime.push({});
  }

  for (const [taskId, aggregateValue] of Object.entries(record(state.tasks))) {
    const aggregate = record(aggregateValue);
    if (text(record(aggregate.task).status) === "retired") continue;
    for (const runValue of Object.values(record(aggregate.agentRuns))) {
      const run = record(runValue);
      const roleName = text(run.roleName);
      const runId = text(run.id);
      if (roleName === undefined || runId === undefined) continue;
      runs.push({ taskId, roleName, runId, status: text(run.status) ?? "unknown" });
    }
    for (const [roleName, setValue] of Object.entries(record(aggregate.roleSessionSets))) {
      collectSessionSet({
        taskId,
        roleName,
        set: record(setValue),
        inventory,
        conservativeDurableSessions,
        sessions,
        inFlight,
        pendingCompletions
      });
    }
  }

  for (const [roleName, setValue] of Object.entries(record(state.globalRoleSessionSets))) {
    collectSessionSet({
      roleName,
      set: record(setValue),
      inventory,
      conservativeDurableSessions,
      sessions,
      inFlight,
      pendingCompletions
    });
  }

  for (const mailboxValue of Object.values(record(state.mailboxes))) {
    const mailbox = record(mailboxValue);
    const target = record(mailbox.target);
    const kind = text(target.kind);
    if (kind !== "role-runtime" && kind !== "global-role-runtime") continue;
    if (!mailboxHasRuntimeWork(mailbox)) continue;
    lifecycle.push({
      ...(text(target.taskId) === undefined ? {} : { taskId: text(target.taskId)! }),
      ...(text(target.roleName) === undefined ? {} : { roleName: text(target.roleName)! }),
      reason: "pending-mailbox"
    });
  }

  for (let index = 0; index < countPendingInbox(home); index += 1) {
    lifecycle.push({ reason: "pending-inbox" });
  }

  // Any live native pane/process the durable session sets could not identify is
  // still a blocker: its exact owner cannot be proven stopped.
  for (const resource of inventory.resources) {
    if (
      resource.kind !== "agent-session"
      || (resource.processes.length === 0 && resource.paneDead !== false)
    ) continue;
    const owner = resource.owner;
    const known = sessions.some((session) => resourceMatchesSession(resource, session));
    if (known) continue;
    const pane = parseManagedPaneTarget(resource.target);
    sessions.push({
      ...(owner.kind === "task-role"
        ? { taskId: owner.taskId }
        : pane?.taskId === undefined ? {} : { taskId: pane.taskId }),
      roleName: owner.kind === "task-role" || owner.kind === "global-role"
        ? owner.roleName
        : pane?.roleName ?? "unknown",
      ...(owner.kind === "task-role" || owner.kind === "global-role"
        ? {
            ...(owner.nativeSessionId === undefined
              ? {}
              : { nativeSessionId: owner.nativeSessionId }),
            ...(owner.launchId === undefined ? {} : { launchId: owner.launchId })
          }
        : {}),
      status: "unknown",
      processState: "unknown",
      history: false
    });
  }

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const session = activeCurrentSession(sessions, run.taskId, run.roleName);
    if (session !== undefined) {
      runs[index] = {
        ...run,
        ...(session.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: session.nativeSessionId }),
        ...(session.launchId === undefined ? {} : { launchId: session.launchId })
      };
    }
  }

  return { runs, sessions, inFlight, pendingCompletions, lifecycle, unknownRuntime };
}

function parseManagedPaneTarget(
  target: string | undefined
): Readonly<{ taskId?: string; roleName: string }> | undefined {
  if (target === undefined) return undefined;
  const match = /^yui-[a-f0-9]{12}-(.+):([^:]+)$/u.exec(target);
  if (match === null) return undefined;
  return match[1] === "operator"
    ? { roleName: match[2] }
    : { taskId: match[1], roleName: match[2] };
}

function isUndeterminableNativeInventoryWarning(warning: string): boolean {
  return warning.startsWith("Cannot enumerate Linux processes")
    || warning.startsWith("Cannot inspect tmux")
    || warning.startsWith("Cannot inspect Unix sockets");
}

function collectSessionSet(options: Readonly<{
  taskId?: string;
  roleName: string;
  set: Record<string, unknown>;
  inventory: OfflineRuntimeInventory;
  conservativeDurableSessions: boolean;
  sessions: Array<OfflineUpgradeFacts["sessions"][number]>;
  inFlight: Array<OfflineUpgradeFacts["inFlight"][number]>;
  pendingCompletions: Array<OfflineUpgradeFacts["pendingCompletions"][number]>;
}>): void {
  const { taskId, roleName, set, inventory, conservativeDurableSessions } = options;
  const currentSessions = Object.entries(record(set.sessions));
  const activeAgentId = text(set.activeAgentId);
  const historyValue = set.history;
  const historySessions = Array.isArray(historyValue)
    ? historyValue
    : Object.values(record(historyValue));
  for (const { history, value, active } of [
    ...currentSessions.map(([agentId, session]) => ({
      history: false,
      value: session,
      active: activeAgentId !== undefined && agentId === activeAgentId
    })),
    ...historySessions.map((session) => ({ history: true, value: session, active: false }))
  ]) {
    const session = record(value);
    const nativeSessionId = text(session.nativeSessionId);
    const launchId = text(session.launchId);
    const base = {
      ...(taskId === undefined ? {} : { taskId }),
      roleName,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      ...(launchId === undefined ? {} : { launchId }),
      status: text(session.status) ?? "unknown",
      history,
      active
    };
    options.sessions.push({
      ...base,
      processState: processState(inventory, base, conservativeDurableSessions)
    });
  }

  const flight = record(set.inFlight);
  const runId = text(flight.runId);
  if (taskId !== undefined && runId !== undefined) {
    const session = activeCurrentSession(options.sessions, taskId, roleName);
    options.inFlight.push({
      taskId,
      roleName,
      runId,
      ...(session?.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: session.nativeSessionId }),
      ...(session?.launchId === undefined ? {} : { launchId: session.launchId })
    });
  }

  const completion = record(set.pendingTurnCompletion);
  const completionTask = text(completion.taskId) ?? taskId;
  if (completionTask !== undefined && Object.keys(completion).length > 0) {
    const completionRole = text(completion.roleName) ?? roleName;
    const completionNativeSessionId = text(completion.nativeSessionId);
    const completionSession = options.sessions.find((candidate) => (
      candidate.taskId === completionTask
      && candidate.roleName === completionRole
      && completionNativeSessionId !== undefined
      && candidate.nativeSessionId === completionNativeSessionId
    ));
    options.pendingCompletions.push({
      taskId: completionTask,
      roleName: completionRole,
      ...(text(completion.runId) === undefined ? {} : { runId: text(completion.runId)! }),
      ...(completionNativeSessionId === undefined
        ? {}
        : { nativeSessionId: completionNativeSessionId }),
      ...(completionSession?.launchId === undefined
        ? {}
        : { launchId: completionSession.launchId })
    });
  }
}

function activeCurrentSession(
  sessions: readonly OfflineUpgradeFacts["sessions"][number][],
  taskId: string,
  roleName: string
): OfflineUpgradeFacts["sessions"][number] | undefined {
  const current = sessions.filter((candidate) => (
    candidate.taskId === taskId
    && candidate.roleName === roleName
    && !candidate.history
  ));
  return current.find(({ active }) => active === true)
    ?? (current.length === 1 ? current[0] : undefined);
}

function processState(
  inventory: OfflineRuntimeInventory,
  session: Readonly<{
    taskId?: string;
    roleName: string;
    nativeSessionId?: string;
    launchId?: string;
    status: string;
    history: boolean;
  }>,
  conservativeDurableSessions: boolean
): "live" | "stopped" | "unknown" {
  const matching = inventory.resources.filter((resource) => (
    resource.kind === "agent-session" && resourceMatchesSession(resource, session)
  ));
  if (matching.some((resource) => resource.processes.length > 0)) return "live";
  if (matching.some((resource) => resource.paneDead === false)) return "unknown";
  // The final SQLite gate runs after BEGIN IMMEDIATE, so no older writer can
  // commit another Session record behind it. Treat every current non-terminal
  // durable Session as active even when the earlier native-process snapshot
  // did not contain it; this closes the inventory-scan -> transaction race.
  if (conservativeDurableSessions
    && !session.history
    && session.status !== "stopped"
    && session.status !== "broken") {
    return "unknown";
  }
  return "stopped";
}

function resourceMatchesSession(
  resource: ControllerResourceInventory["resources"][number],
  session: Readonly<{
    taskId?: string;
    roleName: string;
    nativeSessionId?: string;
    launchId?: string;
  }>
): boolean {
  const owner = resource.owner;
  if (owner.kind !== "task-role" && owner.kind !== "global-role") return false;
  if (session.taskId === undefined) {
    if (owner.kind !== "global-role") return false;
  } else if (owner.kind !== "task-role" || owner.taskId !== session.taskId) return false;
  if (owner.roleName !== session.roleName) return false;
  if (session.nativeSessionId !== undefined && owner.nativeSessionId !== session.nativeSessionId) {
    return false;
  }
  if (session.launchId !== undefined && owner.launchId !== session.launchId) return false;
  return true;
}

function readDurableStateObject(home: string): Record<string, unknown> {
  const databasePath = join(home, "yui.db");
  const schema = inspectStorageSchema(home);
  const sqliteIsAuthoritative = (schema.status === "current" || schema.status === "unsupported")
    && schema.currentLayoutVersion >= SQLITE_LAYOUT_VERSION;
  if (sqliteIsAuthoritative && existsSync(databasePath)) {
    return readSqliteStateObject(databasePath);
  }
  const path = join(home, STORAGE_STATE_FILE);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return record(parsed);
}

/**
 * Read only the durable runtime families needed by the offline gate. This raw
 * adapter deliberately does not open SqliteTaskStore: a valid pending schema
 * prefix is exactly the state the explicit upgrader must be able to inspect.
 */
function readSqliteStateObject(databasePath: string): Record<string, unknown> {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    return readSqliteStateObjectFromDatabase(db);
  } finally {
    db.close();
  }
}

/**
 * Re-check the authoritative SQLite runtime families on an already-open
 * connection. The in-place upgrader calls this inside its write transaction,
 * after every older writer has either committed or rolled back.
 */
export function inspectSqliteDurableUpgradeInventory(
  home: string,
  db: Database.Database
): OfflineUpgradeInventory {
  return classifyOfflineUpgradeFacts(readRawFacts(
    home,
    { resources: [], warnings: [] },
    readSqliteStateObjectFromDatabase(db),
    true
  ));
}

function readSqliteStateObjectFromDatabase(db: Database.Database): Record<string, unknown> {
  const taskRows = db.prepare(
    "SELECT task_id, status FROM tasks_catalog"
  ).all() as Array<{ task_id: string; status: string }>;
  // Explicit retirement is the only isolation boundary for anomalous
  // historical runtime state. Completed/archived/draft Tasks still fail
  // closed if they retain an active Run or unfinished lifecycle record.
  const retiredTaskIds = new Set(
    taskRows.filter(({ status }) => status === "retired").map(({ task_id }) => task_id)
  );
  const tasks: Record<string, Record<string, unknown>> = Object.fromEntries(
    taskRows
      .filter(({ task_id }) => !retiredTaskIds.has(task_id))
      .map(({ task_id, status }) => [task_id, {
        task: { status },
        agentRuns: {},
        roleSessionSets: {}
      }])
  );
  const taskAggregate = (taskId: string): Record<string, unknown> => {
    const existing = tasks[taskId];
    if (existing !== undefined) return existing;
    const created = { task: {}, agentRuns: {}, roleSessionSets: {} };
    tasks[taskId] = created;
    return created;
  };

  for (const row of db.prepare(
    "SELECT task_id, run_id, role_name, status, payload FROM agent_runs"
  ).all() as Array<{
    task_id: string;
    run_id: string;
    role_name: string;
    status: string;
    payload: string;
  }>) {
    if (retiredTaskIds.has(row.task_id)) continue;
    const aggregate = taskAggregate(row.task_id);
    record(aggregate.agentRuns)[row.run_id] = {
      ...parseJsonRecord(row.payload, "agent_runs.payload"),
      id: row.run_id,
      roleName: row.role_name,
      status: row.status
    };
  }

  for (const row of db.prepare(
    "SELECT task_id, role_name, payload FROM role_session_sets"
  ).all() as Array<{ task_id: string; role_name: string; payload: string }>) {
    if (retiredTaskIds.has(row.task_id)) continue;
    const aggregate = taskAggregate(row.task_id);
    record(aggregate.roleSessionSets)[row.role_name] = parseJsonRecord(
      row.payload,
      "role_session_sets.payload"
    );
  }

  const globalRoleSessionSets: Record<string, unknown> = {};
  for (const row of db.prepare(
    "SELECT name, payload FROM global_role_session_sets"
  ).all() as Array<{ name: string; payload: string }>) {
    globalRoleSessionSets[row.name] = parseJsonRecord(
      row.payload,
      "global_role_session_sets.payload"
    );
  }

  const mailboxColumns = new Set(
    (db.pragma("table_info(mailboxes)") as Array<{ name: string }>).map(({ name }) => name)
  );
  const hasInputDelivery = mailboxColumns.has("input_delivery");
  const mailboxes: Record<string, unknown> = {};
  for (const row of db.prepare(
    `SELECT target_key, target_kind, task_id, role_name, processing, pending${
      hasInputDelivery ? ", input_delivery" : ""
    } FROM mailboxes`
  ).all() as Array<{
    target_key: string;
    target_kind: string;
    task_id: string | null;
    role_name: string | null;
    processing: string | null;
    pending: string | null;
    input_delivery?: string | null;
  }>) {
    if (row.task_id !== null && retiredTaskIds.has(row.task_id)) continue;
    mailboxes[row.target_key] = {
      target: {
        kind: row.target_kind,
        ...(row.task_id === null ? {} : { taskId: row.task_id }),
        ...(row.role_name === null ? {} : { roleName: row.role_name })
      },
      processing: parseNullableJson(row.processing, "mailboxes.processing"),
      pending: parseNullableJson(row.pending, "mailboxes.pending"),
      inputDelivery: parseNullableJson(
        row.input_delivery ?? null,
        "mailboxes.input_delivery"
      )
    };
  }
  return { tasks, globalRoleSessionSets, mailboxes };
}

function mailboxHasRuntimeWork(mailbox: Record<string, unknown>): boolean {
  if (mailbox.processing !== null && mailbox.processing !== undefined) return true;
  if (mailbox.inputDelivery !== null && mailbox.inputDelivery !== undefined) return true;
  if (mailbox.pending === null || mailbox.pending === undefined) return false;
  const pending = record(mailbox.pending);
  if (Object.hasOwn(pending, "normal") || Object.hasOwn(pending, "userCorrection")) {
    return pending.normal !== null || pending.userCorrection !== null;
  }
  // Pre-v14 mailboxes store one pending batch directly.
  return Object.keys(pending).length > 0;
}

function parseJsonRecord(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseNullableJson(raw: string | null, label: string): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function countPendingInbox(home: string): number {
  return [join(home, "runtime", "inbox"), join(home, "runtime", "inbox-invalid")]
    .reduce((total, directory) => total + countDirectory(directory), 0);
}

function countDirectory(directory: string): number {
  try {
    return readdirSync(directory).filter((name) => (
      name.endsWith(".json") || name.includes(".tmp-") || !name.startsWith(".")
    )).length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    return 1;
  }
}

function identity(
  value: Readonly<{
    taskId?: string;
    roleName?: string;
    runId?: string;
    nativeSessionId?: string;
    launchId?: string;
  }>,
  reason: OfflineUpgradeBlockerReason
): OfflineUpgradeBlocker {
  return {
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.roleName === undefined ? {} : { roleName: value.roleName }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: value.nativeSessionId }),
    ...(value.launchId === undefined ? {} : { launchId: value.launchId }),
    reason
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
