import { isDeepStrictEqual } from "node:util";

import type { RoleAgentSession } from "../executor/agentExecutor.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import { agentRunDeliveryReceiptId, type AgentRun } from "../run/agentRun.js";
import type { TaskRole } from "../role/role.js";
import {
  hasRuntimeCleanupObligation,
  hasRuntimeLifecycleWork,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxRolePaneState } from "../tmux/tmuxManager.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import {
  isRoleRunStalled,
  latestStallProgressAt
} from "../scheduler/roleRunStall.js";
import {
  createRuntimeObservation,
  runtimeObservationFromTaskEvent,
  type RuntimeObservation,
  type RuntimeUsageSnapshot
} from "../runtime/runtimeObservation.js";
import {
  classifyRuntimeHealth,
  projectRuntimeMailbox,
  projectRuntimeObservation,
  projectRuntimeTaskEvents,
  runtimeDisplayStatus,
  type RuntimeHealthLayer,
  type RuntimeDisplayStatus
} from "../runtime/runtimeProjection.js";
import { latestRunDurableProgressAt } from "../scheduler/roleRunStall.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";

export type TaskRoleHealth =
  | "idle"
  | "starting"
  | "awaiting-provider-acceptance"
  | "running"
  | "ready"
  | "waiting"
  | "blocked-input"
  | "needs-attention"
  | "failed";

export type TaskRoleTmuxStatus = Readonly<{
  state: "missing" | "running" | "exited";
  target?: string;
  dead?: boolean;
  pid?: number;
  currentCommand?: string;
}>;

export type TaskRoleWorkspaceStatus =
  | Readonly<{ managed: false; path: string }>
  | Readonly<{ managed: true } & ManagedWorkspace>;

export type TaskRoleSessionRecoveryStatus = Readonly<{
  taskId: string;
  roleName: string;
  runtimeCleanupPending: boolean;
  freshLaunchAllowed: boolean;
}>;

export type TaskRoleRuntimeStatus = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  desiredRevision: number;
  effectiveLaunch: EffectiveLaunchSnapshot | null;
  launchDrift: boolean;
  runSessionDrift: boolean;
  health: TaskRoleHealth;
  healthReason: string;
  openInputRequestCount: number;
  role: TaskRole;
  activeRun: AgentRun | null;
  /**
   * Issue 09: the most recently updated Run for this Role, regardless of
   * status. Lets the status display both axes — the last Run outcome and the
   * current/last Session lifecycle — so a Session that stops after a Run
   * yielded is never read back as a Run failure.
   */
  lastRun: AgentRun | null;
  activeWork: WorkItem | null;
  nativeSession: RoleAgentSession | null;
  runtimeCleanupPending: boolean;
  freshLaunchAllowed: boolean;
  tmux: TaskRoleTmuxStatus;
  workspace: TaskRoleWorkspaceStatus;
  runtime: Readonly<{
    driverId: string;
    status: RuntimeDisplayStatus;
    healthLayer: RuntimeHealthLayer;
    healthReason: string;
    lastActivityAt?: string;
    lastSemanticProgressAt: string;
    activeOperations: readonly string[];
    waitingReason?: "user" | "permission" | "external";
    usage?: RuntimeUsageSnapshot;
    observerStatus?: "healthy" | "degraded" | "unavailable";
    observerDetail?: string;
  }> | null;
  stall: Readonly<{
    active: boolean;
    progressAt?: string;
    kind?: "delivery-stalled" | "workflow-not-progressing";
  }>;
}>;

export function inspectTaskRoleRuntimeStatuses(
  taskId: string,
  roles: readonly TaskRole[],
  store: TaskStore,
  panes: readonly TmuxRolePaneState[],
  now = new Date()
): TaskRoleRuntimeStatus[] {
  const taskOpenInputRequestCount = store.listInputRequests(taskId)
    .filter((request) => request.status === "open").length;
  const panesByRole = new Map<string, TmuxRolePaneState>();
  for (const pane of panes) {
    const current = panesByRole.get(pane.roleName);
    if (current === undefined || current.dead && !pane.dead) panesByRole.set(pane.roleName, pane);
  }
  return roles.map((role) => inspectTaskRoleRuntimeStatus(
    taskId,
    role,
    store,
    panesByRole.get(role.name),
    role.name === "leader" ? taskOpenInputRequestCount : 0,
    now
  ));
}

export function renderTaskRoleRuntimeStatus(status: TaskRoleRuntimeStatus): string {
  const activeRun = status.activeRun === null
    ? "-"
    : `${status.activeRun.id} (${activeRunDeliveryLabel(status.activeRun)})`;
  const lastRun = status.activeRun !== null || status.lastRun === null
    ? undefined
    : `${status.lastRun.id} (${status.lastRun.status}${
      status.lastRun.endedAt === undefined ? "" : ` at ${status.lastRun.endedAt}`
    })`;
  const activeWork = status.activeWork === null
    ? "-"
    : `${status.activeWork.id} (${status.activeWork.status}) ${status.activeWork.title}`;
  const nativeSession = status.nativeSession === null
    ? "not recorded"
    : `${status.nativeSession.nativeSessionId} (${status.nativeSession.status}, ${status.nativeSession.adapterId}, effective r${status.nativeSession.effective.sourceDesiredRevision})`;
  const effectiveLaunch = status.effectiveLaunch === null
    ? "not started"
    : `${status.effectiveLaunch.agentId}/${status.effectiveLaunch.adapterId}; r${status.effectiveLaunch.sourceDesiredRevision}; Profile intent=${status.effectiveLaunch.profileAccess}; permission=${status.effectiveLaunch.permission.strategy}`;
  const tmux = status.tmux.state === "missing"
    ? "missing"
    : [
        status.tmux.state,
        status.tmux.currentCommand === undefined ? undefined : `command=${status.tmux.currentCommand}`,
        status.tmux.pid === undefined ? undefined : `pid=${status.tmux.pid}`,
        status.tmux.target
      ].filter((value): value is string => value !== undefined).join(", ");
  const workspaceDetails = status.workspace.managed
    ? status.workspace.entries.map((entry) => (
        `  Project          ${entry.directory} (${entry.access}) ${entry.branch} @ ${
          entry.baseCommit
        }`
      ))
    : [];
  const runtime = status.runtime === null
    ? "not observable"
    : [
        `${status.runtime.driverId}: ${status.runtime.status}`,
        `health=${status.runtime.healthLayer}`,
        `health reason=${status.runtime.healthReason}`,
        status.runtime.lastActivityAt === undefined
          ? undefined
          : `last activity=${status.runtime.lastActivityAt}`,
        `last semantic progress=${status.runtime.lastSemanticProgressAt}`,
        status.runtime.activeOperations.length === 0
          ? undefined
          : `operations=${status.runtime.activeOperations.join(",")}`,
        status.runtime.observerStatus === undefined
          ? undefined
          : `observer=${status.runtime.observerStatus}${
              status.runtime.observerDetail === undefined
                ? ""
                : ` (${status.runtime.observerDetail})`
            }`
      ].filter((value): value is string => value !== undefined).join("; ");
  return [
    `Task Role status: ${status.taskId}/${status.roleName}`,
    "",
    `  Health           ${status.health}`,
    `  Reason           ${status.healthReason}`,
    `  Open inputs      ${status.openInputRequestCount}`,
    `  Agent            ${status.agentId}`,
    `  Desired launch   r${status.desiredRevision}; Profile intent=${status.role.defaultAccess}`,
    `  Effective launch ${effectiveLaunch}`,
    `  Desired drift    ${status.effectiveLaunch === null
      ? "-"
      : status.launchDrift ? "pending next launch" : "none"}`,
    `  Run/session      ${status.runSessionDrift ? "snapshot mismatch" : "snapshot consistent"}`,
    `  Role state       ${status.role.status}`,
    `  Active work      ${activeWork}`,
    `  Active run       ${activeRun}`,
    ...(lastRun === undefined ? [] : [`  Last run         ${lastRun}`]),
    `  Run attention    ${status.stall.active
      ? `needs-attention (${status.stall.kind ?? "workflow-not-progressing"}; no workflow progress since ${status.stall.progressAt ?? "unknown"})`
      : "none"}`,
    `  Native session   ${nativeSession}`,
    `  Agent runtime    ${runtime}`,
    `  Runtime cleanup  ${status.runtimeCleanupPending ? "pending" : "none"}`,
    `  Fresh launch     ${status.freshLaunchAllowed ? "allowed" : "blocked"}`,
    `  tmux pane        ${tmux}`,
    `  Workspace        ${
      status.workspace.managed ? status.workspace.root : status.workspace.path
    }`,
    ...workspaceDetails
  ].join("\n").concat("\n");
}

export function taskRoleActiveWorkLabel(status: TaskRoleRuntimeStatus): string {
  if (status.activeWork !== null) return `${status.activeWork.id}: ${status.activeWork.title}`;
  return status.activeRun === null ? "-" : status.activeRun.id;
}

/** Issue 09: compact last-Run outcome label for the Role list table. */
export function taskRoleLastRunLabel(status: TaskRoleRuntimeStatus): string {
  if (status.activeRun !== null) return `${status.activeRun.id} ${status.activeRun.status}`;
  if (status.lastRun === null) return "-";
  return `${status.lastRun.id} ${status.lastRun.status}`;
}

export function taskRoleNativeSessionLabel(status: TaskRoleRuntimeStatus): string {
  if (status.runtimeCleanupPending && status.nativeSession === null) return "reset (cleanup-pending)";
  return status.nativeSession?.status ?? "unbound";
}

export function inspectTaskRoleSessionRecovery(
  taskId: string,
  roleName: string,
  store: TaskStore
): TaskRoleSessionRecoveryStatus {
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  const target = runtimeLifecycleTarget({ scope: "task", taskId, roleName });
  const runtimeMailbox = store.getWorkMailbox(target);
  return {
    taskId,
    roleName,
    runtimeCleanupPending: hasRuntimeCleanupObligation(runtimeMailbox),
    freshLaunchAllowed: (
      sessions === null
      || sessions.sessions[sessions.activeAgentId] === undefined
    ) && !hasRuntimeLifecycleWork(runtimeMailbox)
  };
}

export function taskRoleOpenInputLabel(status: TaskRoleRuntimeStatus): string {
  return status.roleName === "leader" && status.openInputRequestCount > 0
    ? String(status.openInputRequestCount)
    : "-";
}

export function taskRoleTmuxLabel(status: TaskRoleRuntimeStatus): string {
  if (status.tmux.state !== "running") return status.tmux.state;
  return status.tmux.currentCommand === undefined
    ? "running"
    : `running (${status.tmux.currentCommand})`;
}

function inspectTaskRoleRuntimeStatus(
  taskId: string,
  role: TaskRole,
  store: TaskStore,
  pane: TmuxRolePaneState | undefined,
  openInputRequestCount: number,
  now: Date
): TaskRoleRuntimeStatus {
  const activeRun = store.getActiveAgentRun(taskId, role.name);
  // Issue 09: the last Run outcome is a separate axis from the Session
  // lifecycle. A Session that stops after its Run yielded must not retroactively
  // turn that Run into a failure; the status display keeps both visible.
  const lastRun = store.listAgentRuns(taskId)
    .filter((candidate) => candidate.roleName === role.name)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
    ?? null;
  const activeWork = activeRun?.workItemId === undefined
    ? null
    : store.getWorkItem(taskId, activeRun.workItemId);
  const sessions = store.getTaskRoleSessionSet(taskId, role.name);
  const effectiveAgentId = activeRun?.effective.agentId ?? sessions?.activeAgentId;
  const nativeSession = effectiveAgentId === undefined
    ? null
    : sessions?.sessions[effectiveAgentId] ?? null;
  const effectiveLaunch = activeRun?.effective ?? nativeSession?.effective ?? null;
  const runSessionDrift = activeRun !== null
    && nativeSession !== null
    && !isDeepStrictEqual(activeRun.effective, nativeSession.effective);
  const recovery = inspectTaskRoleSessionRecovery(taskId, role.name, store);
  const tmux: TaskRoleTmuxStatus = pane === undefined
    ? { state: "missing" }
    : {
        state: pane.dead ? "exited" : "running",
        target: pane.target,
        dead: pane.dead,
        ...(pane.pid === undefined ? {} : { pid: pane.pid }),
        currentCommand: pane.currentCommand
      };
  // The active Run snapshot is authoritative for the live Role session.  It
  // may point at a ReviewRound-owned workspace, which is intentionally
  // distinct from the WorkItem Develop workspace.
  const managedWorkspace = activeRun?.workspace
    ?? (activeRun?.workItemId === undefined
      ? store.getTaskWorkspace(taskId)
      : store.getWorkItemWorkspace(taskId, activeRun.workItemId));
  const workspace: TaskRoleWorkspaceStatus = managedWorkspace === null
    ? { managed: false, path: role.workspace }
    : { ...managedWorkspace, managed: true };
  const events = store.listEvents(taskId);
  const runtime = projectTaskRoleRuntime(
    activeRun,
    nativeSession,
    tmux,
    events,
    store.getWorkMailbox({ kind: "role", taskId, roleName: role.name }),
    store,
    taskId,
    role.name,
    now
  );
  const stalled = activeRun !== null && isRoleRunStalled(events, activeRun.id);
  const stallProgressAt = activeRun === null
    ? undefined
    : latestStallProgressAt(events, activeRun.id);
  const stallKind = activeRun === null
    ? undefined
    : latestStallKind(events, activeRun.id);
  const health = calculateHealth(
    role,
    activeRun,
    lastRun,
    nativeSession,
    recovery.runtimeCleanupPending,
    tmux,
    openInputRequestCount,
    stalled,
    runtime
  );
  const stall = activeRun === null
    ? { active: false }
    : {
        active: stalled,
        ...(stallProgressAt === undefined
          ? {}
          : { progressAt: stallProgressAt }),
        ...(stallKind === undefined ? {} : { kind: stallKind })
      };
  return {
    ...recovery,
    agentId: effectiveLaunch?.agentId ?? role.activeAgentId,
    desiredRevision: role.launchRevision,
    effectiveLaunch,
    launchDrift: effectiveLaunch !== null
      && effectiveLaunch.sourceDesiredRevision !== role.launchRevision,
    runSessionDrift,
    ...health,
    openInputRequestCount,
    role,
    activeRun,
    lastRun,
    activeWork,
    nativeSession,
    tmux,
    workspace,
    runtime,
    stall
  };
}

function latestStallKind(
  events: ReturnType<TaskStore["listEvents"]>,
  runId: string
): "delivery-stalled" | "workflow-not-progressing" | undefined {
  const event = [...events]
    .filter((candidate) => candidate.type === "run.stalled" && candidate.payload.runId === runId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return event?.payload.kind === "delivery-stalled" || event?.payload.kind === "workflow-not-progressing"
    ? event.payload.kind
    : undefined;
}

function calculateHealth(
  role: TaskRole,
  activeRun: AgentRun | null,
  lastRun: AgentRun | null,
  nativeSession: RoleAgentSession | null,
  runtimeCleanupPending: boolean,
  tmux: TaskRoleTmuxStatus,
  openInputRequestCount: number,
  stalled: boolean,
  runtime: TaskRoleRuntimeStatus["runtime"]
): Pick<TaskRoleRuntimeStatus, "health" | "healthReason"> {
  if (runtimeCleanupPending && nativeSession === null) {
    return {
      health: "needs-attention",
      healthReason: "the native Session was reset; verified runtime cleanup is pending"
    };
  }
  if (role.status === "failed" || role.status === "exited") {
    return { health: "failed", healthReason: `persisted Role state is ${role.status}` };
  }
  if (nativeSession?.status === "broken") {
    // Issue 09: a broken Session only fails a live Run. When the last Run
    // already yielded, the Session death is a lifecycle event, not a Run
    // failure — surface it as attention with the persisted Run outcome.
    if (activeRun !== null) {
      return { health: "failed", healthReason: "the active native session is broken" };
    }
    return {
      health: "needs-attention",
      healthReason: lastRun === null
        ? "the native session is broken"
        : `the native session is broken; last run ${lastRun.id} ${lastRun.status}`
    };
  }
  const awaitingProviderAcceptance = activeRun?.pushedAt !== undefined
    && activeRun.deliveredAt === undefined;
  if (
    awaitingProviderAcceptance
    && tmux.state !== "running"
  ) {
    return {
      health: "needs-attention",
      healthReason: "the pushed active Run is awaiting provider acceptance and has no live tmux pane"
    };
  }
  if (tmux.state === "exited") {
    return {
      health: "needs-attention",
      healthReason: "the tmux pane exited; Provider Conversation/continuation state is unobservable"
    };
  }
  if (activeRun !== null) {
    if (role.status !== "running") {
      return {
        health: "needs-attention",
        healthReason: `the active Run conflicts with persisted Role state ${role.status}`
      };
    }
    if (activeRun.deliveredAt !== undefined && tmux.state !== "running") {
      return { health: "needs-attention", healthReason: "the delivered active Run has no live tmux pane" };
    }
    if (stalled) {
      return {
        health: "needs-attention",
        healthReason: "the live active Run has no durable progress in the configured stall window"
      };
    }
    if (activeRun.deliveredAt !== undefined) {
      if (runtime === null) {
        return {
          health: "needs-attention",
          healthReason: "the delivered Run has no authoritative Agent Driver state"
        };
      }
      switch (runtime.healthLayer) {
        case "broken":
          return { health: "failed", healthReason: runtime.healthReason };
        case "stopped":
        case "diagnostic-needed":
        case "ready":
        case "awaiting-provider-acceptance":
        case "runtime-unobservable":
        case "starting":
          return { health: "needs-attention", healthReason: runtime.healthReason };
        case "waiting-user":
          return { health: "blocked-input", healthReason: runtime.healthReason };
        case "waiting-permission":
        case "waiting-external":
          return { health: "waiting", healthReason: runtime.healthReason };
        case "quiet":
        case "active-quiet":
        case "model-active":
        case "tool-active":
        case "subagent-active":
        default:
          // Short silence is a hint, not a failure. Only deterministic
          // dead/broken evidence or the durable stall window escalates.
          return { health: "running", healthReason: runtime.healthReason };
      }
    }
  }
  if (activeRun === null && role.status === "running") {
    return { health: "needs-attention", healthReason: "the Role is running without an active Run" };
  }
  if (nativeSession?.status === "running" && tmux.state !== "running") {
    return { health: "needs-attention", healthReason: "the native session is running without a live tmux pane" };
  }
  if (nativeSession?.status === "stopped" && tmux.state === "running") {
    return { health: "needs-attention", healthReason: "a stopped native session has a live tmux pane" };
  }
  if (role.name === "leader" && openInputRequestCount > 0) {
    return {
      health: "blocked-input",
      healthReason: `${openInputRequestCount} open InputRequest${openInputRequestCount === 1 ? "" : "s"} require user input`
    };
  }
  if (activeRun !== null) {
    if (activeRun.deliveredAt !== undefined) return {
      health: "needs-attention",
      healthReason: "the delivered Run has no authoritative Agent Driver state"
    };
    if (activeRun.pushedAt !== undefined) {
      return {
        health: "awaiting-provider-acceptance",
        healthReason: "the pushed active Run is awaiting provider acceptance"
      };
    }
    return { health: "starting", healthReason: "the active Run is awaiting tmux delivery" };
  }
  return tmux.state === "running"
    ? { health: "ready", healthReason: "the native Agent pane is ready without active work" }
    : { health: "idle", healthReason: "there is no active work or live tmux pane" };
}

function projectTaskRoleRuntime(
  run: AgentRun | null,
  session: RoleAgentSession | null,
  tmux: TaskRoleTmuxStatus,
  events: ReturnType<TaskStore["listEvents"]>,
  mailbox: ReturnType<TaskStore["getWorkMailbox"]>,
  store: TaskStore,
  taskId: string,
  roleName: string,
  now: Date
): TaskRoleRuntimeStatus["runtime"] {
  if (run === null || session?.launchId === undefined) return null;
  let driverId: string;
  try {
    driverId = builtinDriverIdForAdapter(run.effective.adapterId);
  } catch {
    return null;
  }
  const fence = {
    taskId: run.taskId,
    roleName: run.roleName,
    runId: run.id,
    agentId: run.effective.agentId,
    driverId,
    launchId: session.launchId,
    sessionGenerationId: session.launchId,
    nativeSessionId: session.nativeSessionId,
    nativeTurnId: runtimeNativeTurnId(
      events,
      {
        taskId: run.taskId,
        roleName: run.roleName,
        runId: run.id,
        agentId: run.effective.agentId,
        driverId,
        launchId: session.launchId,
        nativeSessionId: session.nativeSessionId,
        receiptId: agentRunDeliveryReceiptId(run)
      }
    ) ?? run.id,
    receiptId: agentRunDeliveryReceiptId(run)
  };
  let projection = projectRuntimeTaskEvents(fence, run.createdAt, events);
  projection = projectRuntimeMailbox(projection, mailbox);
  projection = projectRuntimeObservation(projection, createRuntimeObservation({
    schemaVersion: 2,
    eventId: `runtime-host-${run.id}`,
    semanticKey: `runtime-host-${run.id}`,
    kind: "host.observed",
    authority: "host",
    receivedAt: run.updatedAt,
    fence,
    payload: { alive: tmux.state === "running" }
  }));
  // The semantic progress fence is the same durable fold the scheduler stall
  // pass consumes, so CLI/Web/scheduler share one progress clock.
  const semanticProgress = run.deliveredAt === undefined
    ? { progressAt: run.createdAt }
    : latestRunDurableProgressAt(store, taskId, roleName, run.id)
      ?? { progressAt: run.deliveredAt };
  const classification = classifyRuntimeHealth({
    projection,
    semanticProgressAt: semanticProgress.progressAt,
    now,
    policy: resolveRuntimeHealth(store.getConfig().runtimeHealth)
  });
  return {
    driverId,
    status: runtimeDisplayStatus(projection),
    healthLayer: classification.layer,
    healthReason: classification.reason,
    lastSemanticProgressAt: classification.lastSemanticProgressAt,
    ...(classification.lastRuntimeActivityAt === undefined
      ? {}
      : { lastActivityAt: classification.lastRuntimeActivityAt }),
    activeOperations: classification.activeOperations,
    ...(projection.waitingReason === undefined
      ? {}
      : { waitingReason: projection.waitingReason }),
    ...(projection.usage === undefined ? {} : { usage: projection.usage }),
    ...(projection.observer.status === "unknown"
      ? {}
      : {
          observerStatus: projection.observer.status,
          ...(projection.observer.detail === undefined
            ? {}
            : { observerDetail: projection.observer.detail })
        })
  };
}

function runtimeNativeTurnId(
  events: ReturnType<TaskStore["listEvents"]>,
  expected: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
    driverId: string;
    launchId: string;
    nativeSessionId: string;
    receiptId: string;
  }>
): string | undefined {
  const observations = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => observation !== null
      && observation.fence.taskId === expected.taskId
      && observation.fence.roleName === expected.roleName
      && observation.fence.runId === expected.runId
      && observation.fence.agentId === expected.agentId
      && observation.fence.driverId === expected.driverId
      && observation.fence.launchId === expected.launchId
      && observation.fence.nativeSessionId === expected.nativeSessionId
      && observation.fence.receiptId === expected.receiptId
      && observation.fence.nativeTurnId !== undefined)
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  return observations.filter(({ kind }) => kind === "turn.accepted").at(-1)
    ?.fence.nativeTurnId
    ?? observations.at(-1)?.fence.nativeTurnId;
}

function activeRunDeliveryLabel(run: AgentRun): string {
  if (run.deliveredAt !== undefined) return "delivered";
  if (run.pushedAt !== undefined) return "pushed (awaiting provider acceptance)";
  return "queued";
}
