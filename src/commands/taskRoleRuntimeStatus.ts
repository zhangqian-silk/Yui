import { isDeepStrictEqual } from "node:util";

import type { RoleAgentSession } from "../executor/agentExecutor.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { Turn } from "../turn/turn.js";
import type { TaskRole } from "../role/role.js";
import {
  hasRuntimeCleanupObligation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxRolePaneState } from "../tmux/tmuxManager.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import {
  isRoleTurnStalled,
  latestStallProgressAt
} from "../scheduler/roleTurnStall.js";
import {
  createRuntimeObservation,
  runtimeObservationFromTaskEvent,
  type RuntimeObservation,
  type RuntimeUsageSnapshot
} from "../runtime/runtimeObservation.js";
import {
  classifyRuntimeHealth,
  projectRuntimeObservation,
  projectRuntimeTaskEvents,
  runtimeDisplayStatus,
  type RuntimeHealthLayer,
  type RuntimeDisplayStatus
} from "../runtime/runtimeProjection.js";
import { latestTurnDurableProgressAt } from "../scheduler/roleTurnStall.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";
import { formatTurnReceiptId } from "../task/taskRecordReference.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import {
  projectSessionTokenMetrics,
  resolveSessionTokenIdentity,
  type SessionTokenMetrics
} from "../runtime/sessionTokenMetrics.js";

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
}>;

export type TaskRoleRuntimeStatus = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  desiredRevision: number;
  effectiveLaunch: EffectiveLaunchSnapshot | null;
  launchDrift: boolean;
  turnSessionDrift: boolean;
  health: TaskRoleHealth;
  healthReason: string;
  openInputRequestCount: number;
  role: TaskRole;
  activeTurn: Turn | null;
  /**
   * Issue 09: the most recently updated Turn for this Role, regardless of
   * status. Lets the status display both axes — the last Turn outcome and the
   * current/last Session lifecycle — so a Session that stops after a Turn
   * completed is never read back as a Turn failure.
   */
  lastTurn: Turn | null;
  activeWork: WorkItem | null;
  nativeSession: RoleAgentSession | null;
  runtimeCleanupPending: boolean;
  tmux: TaskRoleTmuxStatus;
  workspace: TaskRoleWorkspaceStatus;
  sessionTokens: SessionTokenMetrics;
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
  const activeTurn = status.activeTurn === null
    ? "-"
    : `${status.activeTurn.id} (${activeTurnDeliveryLabel(status.activeTurn)})`;
  const lastTurn = status.activeTurn !== null || status.lastTurn === null
    ? undefined
    : `${status.lastTurn.id} (${status.lastTurn.status}${
      status.lastTurn.result === undefined ? "" : ` at ${status.lastTurn.result.completedAt}`
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
  const sessionTokens = [
    `total=${sessionCumulativeTokenLabel(status.sessionTokens)}`,
    `max-request-input=${status.sessionTokens.maximumRequestInput.status === "observed"
      ? status.sessionTokens.maximumRequestInput.inputTokens
      : "unobserved"}`
  ].join("; ");
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
    `  Turn/session     ${status.turnSessionDrift ? "snapshot mismatch" : "snapshot consistent"}`,
    `  Active work      ${activeWork}`,
    `  Active run       ${activeTurn}`,
    ...(lastTurn === undefined ? [] : [`  Last turn        ${lastTurn}`]),
    `  Turn attention   ${status.stall.active
      ? `needs-attention (${status.stall.kind ?? "workflow-not-progressing"}; no workflow progress since ${status.stall.progressAt ?? "unknown"})`
      : "none"}`,
    `  Native session   ${nativeSession}`,
    `  AgentRuntime    ${runtime}`,
    `  Session tokens   ${sessionTokens}`,
    `  Runtime cleanup  ${status.runtimeCleanupPending ? "pending" : "none"}`,
    `  tmux pane        ${tmux}`,
    `  Workspace        ${
      status.workspace.managed ? status.workspace.root : status.workspace.path
    }`,
    ...workspaceDetails
  ].join("\n").concat("\n");
}

export function taskRoleActiveWorkLabel(status: TaskRoleRuntimeStatus): string {
  if (status.activeWork !== null) return `${status.activeWork.id}: ${status.activeWork.title}`;
  return status.activeTurn === null ? "-" : status.activeTurn.id;
}

/** Issue 09: compact last-Turn outcome label for the Role list table. */
export function taskRoleLastTurnLabel(status: TaskRoleRuntimeStatus): string {
  if (status.activeTurn !== null) return `${status.activeTurn.id} ${status.activeTurn.status}`;
  if (status.lastTurn === null) return "-";
  return `${status.lastTurn.id} ${status.lastTurn.status}`;
}

export function taskRoleNativeSessionLabel(status: TaskRoleRuntimeStatus): string {
  if (status.runtimeCleanupPending && status.nativeSession === null) return "unbound (cleanup-pending)";
  return status.nativeSession?.status ?? "unbound";
}

export function inspectTaskRoleSessionRecovery(
  taskId: string,
  roleName: string,
  store: TaskStore
): TaskRoleSessionRecoveryStatus {
  const target = runtimeLifecycleTarget({ scope: "task", taskId, roleName });
  const runtimeMailbox = store.getWorkMailbox(target);
  return {
    taskId,
    roleName,
    runtimeCleanupPending: hasRuntimeCleanupObligation(runtimeMailbox)
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
  const activeTurn = store.getActiveTurn(taskId, role.name);
  // The last Turn outcome is a separate axis from the Session lifecycle. A
  // Session that stops after its Turn completed must not retroactively turn
  // that Turn into a failure; the status display keeps both visible.
  const lastTurn = operationalTaskRecords(
    store.listTurns(taskId),
    store.listEvents(taskId),
    "turn"
  )
    .filter((candidate) => candidate.roleName === role.name)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
    ?? null;
  const activeWork = activeTurn?.workItemId === undefined
    ? null
    : store.getWorkItem(taskId, activeTurn.workItemId);
  const sessions = store.getTaskRoleSessionSet(taskId, role.name);
  const effectiveAgentId = activeTurn?.effective.agentId ?? sessions?.activeAgentId;
  const nativeSession = effectiveAgentId === undefined
    ? null
    : sessions?.sessions[effectiveAgentId] ?? null;
  const effectiveLaunch = activeTurn?.effective ?? nativeSession?.effective ?? null;
  const turnSessionDrift = activeTurn !== null
    && nativeSession !== null
    && !isDeepStrictEqual(activeTurn.effective, nativeSession.effective);
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
  // The active Turn snapshot is authoritative for the live Role session. It
  // may point at a ReviewRound-owned workspace, which is intentionally
  // distinct from the WorkItem Develop workspace.
  const managedWorkspace = activeTurn?.workspace
    ?? (activeTurn?.workItemId === undefined
      ? store.getTaskWorkspace(taskId)
      : store.getWorkItemWorkspace(taskId, activeTurn.workItemId));
  const workspace: TaskRoleWorkspaceStatus = managedWorkspace === null
    ? { managed: false, path: role.workspace }
    : { ...managedWorkspace, managed: true };
  const events = store.listEvents(taskId);
  const sessionTokens = projectSessionTokenMetrics(
    events,
    resolveSessionTokenIdentity(nativeSession === null
      ? null
      : { taskId, roleName: role.name, ...nativeSession })
  );
  const runtime = projectTaskRoleRuntime(
    activeTurn,
    nativeSession,
    tmux,
    events,
    store.getWorkMailbox({ kind: "role", taskId, roleName: role.name }),
    store,
    taskId,
    role.name,
    now
  );
  const stalled = activeTurn !== null && isRoleTurnStalled(events, activeTurn.id);
  const stallProgressAt = activeTurn === null
    ? undefined
    : latestStallProgressAt(events, activeTurn.id);
  const stallKind = activeTurn === null
    ? undefined
    : latestStallKind(events, activeTurn.id);
  const health = calculateHealth(
    role,
    activeTurn,
    lastTurn,
    nativeSession,
    recovery.runtimeCleanupPending,
    tmux,
    openInputRequestCount,
    stalled,
    runtime
  );
  const stall = activeTurn === null
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
    turnSessionDrift,
    ...health,
    openInputRequestCount,
    role,
    activeTurn,
    lastTurn,
    activeWork,
    nativeSession,
    tmux,
    workspace,
    sessionTokens,
    runtime,
    stall
  };
}

function sessionCumulativeTokenLabel(metrics: SessionTokenMetrics): string {
  const total = metrics.cumulativeTotal;
  if (total.status === "unobserved") return "unobserved";
  const breakdown = [
    `input=${total.inputTokens}`,
    `output=${total.outputTokens}`,
    ...(total.cachedInputTokens === undefined ? [] : [`cached-input=${total.cachedInputTokens}`]),
    ...(total.reasoningTokens === undefined ? [] : [`reasoning=${total.reasoningTokens}`])
  ];
  return `${total.totalTokens} (${breakdown.join(", ")})`;
}

function latestStallKind(
  events: ReturnType<TaskStore["listEvents"]>,
  turnId: string
): "delivery-stalled" | "workflow-not-progressing" | undefined {
  const event = [...events]
    .filter((candidate) => candidate.type === "turn.stalled"
      && candidate.payload.turnId === turnId
      && candidate.payload.status !== "diagnostic-only")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return event?.payload.kind === "delivery-stalled" || event?.payload.kind === "workflow-not-progressing"
    ? event.payload.kind
    : undefined;
}

function calculateHealth(
  role: TaskRole,
  activeTurn: Turn | null,
  lastTurn: Turn | null,
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
      healthReason: "the native Session is unbound; verified runtime cleanup is pending"
    };
  }
  if (nativeSession?.status === "ended" && nativeSession.endReason === "failed") {
    // A broken Session only fails a live Turn. When the last Turn already
    // completed, the Session death is a lifecycle event, not a Turn failure —
    // surface it as attention with the persisted Turn outcome.
    if (activeTurn !== null) {
      return { health: "failed", healthReason: "the active native session is broken" };
    }
    return {
      health: "needs-attention",
      healthReason: lastTurn === null
        ? "the native session is broken"
        : `the native session is broken; last Turn ${lastTurn.id} ${lastTurn.status}`
    };
  }
  if (tmux.state === "exited") {
    return {
      health: "needs-attention",
      healthReason: "the tmux pane exited; Provider Conversation/continuation state is unobservable"
    };
  }
  if (activeTurn !== null) {
    if (tmux.state !== "running") {
      return { health: "needs-attention", healthReason: "the active Turn has no live tmux pane" };
    }
    if (stalled) {
      return {
        health: "needs-attention",
        healthReason: "the live active Turn has no durable progress in the configured stall window"
      };
    }
    if (runtime !== null) {
      switch (runtime.healthLayer) {
        case "broken":
          return { health: "failed", healthReason: runtime.healthReason };
        case "stopped":
        case "ready":
        case "awaiting-provider-acceptance":
        case "runtime-unobservable":
        case "starting":
          return { health: "needs-attention", healthReason: runtime.healthReason };
        case "diagnostic-needed":
          return runtime.observerStatus === "degraded" || runtime.observerStatus === "unavailable"
            ? { health: "needs-attention", healthReason: runtime.healthReason }
            : { health: "running", healthReason: runtime.healthReason };
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
    return {
      health: "starting",
      healthReason: "the active Turn is awaiting Provider runtime observations"
    };
  }
  if (nativeSession?.status === "active" && tmux.state !== "running") {
    return { health: "needs-attention", healthReason: "the native session is running without a live tmux pane" };
  }
  if (nativeSession?.status === "ended" && tmux.state === "running") {
    return { health: "needs-attention", healthReason: "a stopped native session has a live tmux pane" };
  }
  if (role.name === "leader" && openInputRequestCount > 0) {
    return {
      health: "blocked-input",
      healthReason: `${openInputRequestCount} open InputRequest${openInputRequestCount === 1 ? "" : "s"} require user input`
    };
  }
  return tmux.state === "running"
    ? { health: "ready", healthReason: "the native Agent pane is ready without active work" }
    : { health: "idle", healthReason: "there is no active work or live tmux pane" };
}

function projectTaskRoleRuntime(
  run: Turn | null,
  session: RoleAgentSession | null,
  tmux: TaskRoleTmuxStatus,
  events: ReturnType<TaskStore["listEvents"]>,
  _mailbox: ReturnType<TaskStore["getWorkMailbox"]>,
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
    turnId: run.id,
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
        turnId: run.id,
        agentId: run.effective.agentId,
        driverId,
        launchId: session.launchId,
        nativeSessionId: session.nativeSessionId,
        receiptId: store.getTaskRoleSessionSet(taskId, roleName)?.providerBinding?.turn?.attemptId
          ?? formatTurnReceiptId(run.taskId, run.id)
      }
    ) ?? run.id,
    receiptId: store.getTaskRoleSessionSet(taskId, roleName)?.providerBinding?.turn?.attemptId
      ?? formatTurnReceiptId(run.taskId, run.id)
  };
  let projection = projectRuntimeTaskEvents(fence, run.createdAt, events);
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
  const semanticProgress = latestTurnDurableProgressAt(store, taskId, roleName, run.id)
    ?? { progressAt: run.createdAt };
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
    turnId: string;
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
      && observation.fence.turnId === expected.turnId
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

function activeTurnDeliveryLabel(run: Turn): string {
  return run.status === "active" ? "active" : run.status;
}
