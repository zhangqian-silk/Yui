import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { scanControllerResourceInventory } from "../../controller/resourceInventoryLinux.js";
import type { ControllerResourceInventory } from "../../controller/resourceInventory.js";
import { STORAGE_STATE_FILE } from "../taskStore.js";

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
  inventory: ControllerResourceInventory
): OfflineUpgradeFacts {
  const runs: Array<OfflineUpgradeFacts["runs"][number]> = [];
  const sessions: Array<OfflineUpgradeFacts["sessions"][number]> = [];
  const inFlight: Array<OfflineUpgradeFacts["inFlight"][number]> = [];
  const pendingCompletions: Array<OfflineUpgradeFacts["pendingCompletions"][number]> = [];
  const lifecycle: Array<OfflineUpgradeFacts["lifecycle"][number]> = [];
  const unknownRuntime: Array<NonNullable<OfflineUpgradeFacts["unknownRuntime"]>[number]> = [];
  const state = readStateObject(home);

  // Failure to enumerate processes, panes, or sockets means absence cannot be
  // proven. Ownership-load warnings are expected for an old record shape and
  // are handled by the raw durable scan plus unowned live-pane check below.
  if (inventory.warnings.some(isUndeterminableNativeInventoryWarning)) {
    unknownRuntime.push({});
  }

  for (const [taskId, aggregateValue] of Object.entries(record(state.tasks))) {
    const aggregate = record(aggregateValue);
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
    if (mailbox.pending === null && mailbox.processing === null) continue;
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
  inventory: ControllerResourceInventory;
  sessions: Array<OfflineUpgradeFacts["sessions"][number]>;
  inFlight: Array<OfflineUpgradeFacts["inFlight"][number]>;
  pendingCompletions: Array<OfflineUpgradeFacts["pendingCompletions"][number]>;
}>): void {
  const { taskId, roleName, set, inventory } = options;
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
      processState: processState(inventory, base)
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
  inventory: ControllerResourceInventory,
  session: Readonly<{
    taskId?: string;
    roleName: string;
    nativeSessionId?: string;
    launchId?: string;
  }>
): "live" | "stopped" | "unknown" {
  const matching = inventory.resources.filter((resource) => (
    resource.kind === "agent-session" && resourceMatchesSession(resource, session)
  ));
  if (matching.some((resource) => resource.processes.length > 0)) return "live";
  if (matching.some((resource) => resource.paneDead === false)) return "unknown";
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

function readStateObject(home: string): Record<string, unknown> {
  const path = join(home, STORAGE_STATE_FILE);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return record(parsed);
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
