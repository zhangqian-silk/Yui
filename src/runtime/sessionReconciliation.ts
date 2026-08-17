import type { SessionReconcileMode } from "../config/yuiConfig.js";
export type { SessionReconcileMode as SessionReconciliationMode };
import type { SessionOwnerIdentity } from "./sessionOwnerIdentity.js";

/** Durable projection of one Role session generation, read by reconciliation. */
export type DurableSessionFact = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  launchId?: string;
  nativeSessionId?: string;
  status: "reserved" | "ready" | "running" | "stopped" | "broken";
  inHistory: boolean;
}>;

export type SessionPhysicalObservation = Readonly<{
  alive: boolean;
  /** True when the PID exists but its start identity changed (PID reuse). */
  identityConflict: boolean;
  pid: number;
  startIdentity: string;
  rssBytes: number;
  ageMs: number;
  childCount: number;
}>;

export type SessionReconciliationMismatch =
  | "durable-terminal-physical-live"
  | "durable-live-physical-absent"
  | "identity-conflict";

export type SessionReconciliationEntry = Readonly<{
  owner: Readonly<{ scope: "task" | "global"; taskId?: string; roleName: string }>;
  agentId: string;
  adapterId: string;
  launchId: string;
  nativeSessionId?: string;
  taskStatus?: "draft" | "active" | "completed" | "retired" | "archived";
  durableStatus: "reserved" | "ready" | "running" | "stopped" | "broken" | "absent";
  tmuxPane?: Readonly<{ target: string; dead: boolean }>;
  physical?: SessionPhysicalObservation;
  lastStopOutcome?: string;
  mismatch?: SessionReconciliationMismatch;
  archiveBlocked: boolean;
  verificationGap?: string;
}>;

export type SessionReconciliationReport = Readonly<{
  schemaVersion: 1;
  mode: SessionReconcileMode;
  observedAt: string;
  entries: readonly SessionReconciliationEntry[];
  summary: Readonly<{
    owners: number;
    livePhysicalRoots: number;
    archiveBlockers: number;
    verificationGaps: number;
  }>;
}>;

export type SessionReconciliationInput = Readonly<{
  mode: SessionReconcileMode;
  records: readonly SessionOwnerIdentity[];
  durable: readonly DurableSessionFact[];
  taskStatus: (taskId: string) => "draft" | "active" | "completed" | "retired" | "archived" | undefined;
  observe: (record: SessionOwnerIdentity) => SessionPhysicalObservation | undefined;
  inspectPane: (
    taskId: string | undefined,
    roleName: string
  ) => Readonly<{ target: string; dead: boolean }> | undefined;
  lastStopOutcome: (
    taskId: string | undefined,
    roleName: string,
    launchId: string
  ) => string | undefined;
  now: Date;
}>;

/**
 * Bidirectional durable <-> physical reconciliation for Session generations.
 *
 * Durable -> physical: every owner record's Provider root must be absent once
 * its durable Session is terminal; a live root with a terminal durable state
 * is the exact leak the audit found. Physical -> durable: the owner registry
 * stays enumerable after the durable Session map or history is cleared, so a
 * live generation can always be re-attributed and reported.
 *
 * Pure: all I/O is injected. Unknown owners are reported, never cleaned. In
 * `report` mode no entry is ever archive-blocking; the archive gate exists
 * only in `exact-owner-cleanup` mode and only for terminal/archived Tasks.
 */
export function reconcileSessionOwners(
  input: SessionReconciliationInput
): SessionReconciliationReport {
  const entries = input.records.map((record) => reconcileOne(record, input));
  const summary = {
    owners: entries.length,
    livePhysicalRoots: entries.filter(
      (entry) => entry.physical?.alive === true
    ).length,
    archiveBlockers: entries.filter((entry) => entry.archiveBlocked).length,
    verificationGaps: entries.filter(
      (entry) => entry.verificationGap !== undefined
    ).length
  };
  return {
    schemaVersion: 1,
    mode: input.mode,
    observedAt: input.now.toISOString(),
    entries,
    summary
  };
}

function reconcileOne(
  record: SessionOwnerIdentity,
  input: SessionReconciliationInput
): SessionReconciliationEntry {
  const durable = matchDurable(record, input.durable);
  const physical = input.observe(record);
  const owner = record.owner;
  const taskStatus = owner.scope === "task" && owner.taskId !== undefined
    ? input.taskStatus(owner.taskId)
    : undefined;
  const tmuxPane = input.inspectPane(owner.taskId, owner.roleName);
  const lastStopOutcome = input.lastStopOutcome(
    owner.taskId,
    owner.roleName,
    record.launchId
  );

  let mismatch: SessionReconciliationMismatch | undefined;
  let verificationGap: string | undefined;
  if (physical?.identityConflict === true) {
    mismatch = "identity-conflict";
  } else if (physical?.alive === true) {
    if (durable === undefined || durable.status === "stopped" || durable.status === "broken") {
      mismatch = "durable-terminal-physical-live";
    }
  } else if (physical === undefined) {
    verificationGap = "/proc identity unavailable";
  } else if (durable !== undefined && durable.status === "running") {
    mismatch = "durable-live-physical-absent";
  }

  const terminalTask = taskStatus === "completed"
    || taskStatus === "retired"
    || taskStatus === "archived";
  const archiveBlocked = input.mode === "exact-owner-cleanup"
    && mismatch === "durable-terminal-physical-live"
    && terminalTask;

  return {
    owner: {
      scope: owner.scope,
      ...(owner.taskId === undefined ? {} : { taskId: owner.taskId }),
      roleName: owner.roleName
    },
    agentId: record.agentId,
    adapterId: record.adapterId,
    launchId: record.launchId,
    ...(record.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: record.nativeSessionId }),
    ...(taskStatus === undefined ? {} : { taskStatus }),
    durableStatus: durable?.status ?? "absent",
    ...(tmuxPane === undefined ? {} : { tmuxPane }),
    ...(physical === undefined ? {} : { physical }),
    ...(lastStopOutcome === undefined ? {} : { lastStopOutcome }),
    ...(mismatch === undefined ? {} : { mismatch }),
    archiveBlocked,
    ...(verificationGap === undefined ? {} : { verificationGap })
  };
}

function matchDurable(
  record: SessionOwnerIdentity,
  durable: readonly DurableSessionFact[]
): DurableSessionFact | undefined {
  const candidates = durable.filter((fact) => (
    fact.scope === record.owner.scope
    && fact.roleName === record.owner.roleName
    && (record.owner.scope === "global" || fact.taskId === record.owner.taskId)
    && fact.agentId === record.agentId
  ));
  const byLaunch = candidates.find(
    (fact) => fact.launchId !== undefined && fact.launchId === record.launchId
  );
  if (byLaunch !== undefined) return byLaunch;
  const byNative = candidates.find(
    (fact) => fact.nativeSessionId !== undefined
      && record.nativeSessionId !== undefined
      && fact.nativeSessionId === record.nativeSessionId
  );
  return byNative;
}
