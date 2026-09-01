import type { TaskStore } from "../storage/taskStore.js";
import type { InputRequest } from "../input/inputRequest.js";
import { type Task, type TaskStatus } from "../task/task.js";
import type { WorkItem, WorkItemStatus } from "../workItem/workItem.js";
import { isRoleTurnStalled, latestTurnDurableProgressAt } from "../scheduler/roleTurnStall.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  buildTaskExecutionProjection,
  type TaskExecutionProjection
} from "../scheduler/taskExecutionProjection.js";
import { summarizeWorkItemExecutionGroup } from "../execution/workItemExecution.js";
import { currentWorkItemExecutionGroup } from "../workItem/workItem.js";
import {
  classifyRuntimeHealth,
  projectRuntimeTaskEvents,
  type RuntimeHealthLayer
} from "../runtime/runtimeProjection.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";
import { formatTurnReceiptId } from "../task/taskRecordReference.js";
import type { Turn } from "../turn/turn.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";
import {
  projectSessionTokenMetrics,
  resolveSessionTokenIdentity
} from "../runtime/sessionTokenMetrics.js";

export type WebDashboardStore = Pick<TaskStore,
  | "transaction"
  | "listTasks"
  | "getTask"
  | "getTaskBrief"
  | "getTurn"
  | "getWorkItem"
  | "listRoles"
  | "getTaskRoleSessionSet"
  | "listWorkItems"
  | "listContextSnapshots"
  | "listTurns"
  | "listReviewRounds"
  | "listInputRequests"
  | "listMessages"
  | "listDecisions"
  | "listMilestones"
  | "listProjects"
  | "listChangeSets"
  | "listIntegrationAttempts"
  | "getWorkMailbox"
  | "getPendingWakeup"
  | "getLeaderFailure"
  | "getRoleSession"
  | "getConfig"
> & Readonly<{
  listEvents?: (taskId: string) => readonly TaskEvent[];
}>;

type WorkItemCounts = Readonly<Record<WorkItemStatus, number> & {
  total: number;
}>;

type DashboardTask = Task & Readonly<{
  workItems: WorkItemCounts;
  roleCount: number;
  openInputCount: number;
  needsAttentionCount: number;
  execution: TaskExecutionProjection | null;
  /** Derived Task-first execution status, copied from the projection for the sidebar. */
  executionStatus: TaskExecutionProjection["status"] | null;
  projectNames?: readonly string[];
}>;

export type WebAttentionItem = Readonly<{
  taskId: string;
  taskTitle: string;
  request: InputRequest;
}>;

export type WebDashboardSnapshot = Readonly<{
  generatedAt: string;
  counts: Readonly<Record<TaskStatus, number> & { total: number; openInputs: number }>;
  attention: readonly WebAttentionItem[];
  tasks: readonly DashboardTask[];
}>;

export function buildWebDashboardSnapshot(
  store: WebDashboardStore,
  now: Date = new Date()
): WebDashboardSnapshot {
  return store.transaction((reader) => {
    const statusCounts: Record<TaskStatus, number> = {
      draft: 0,
      active: 0,
      completed: 0,
      retired: 0,
      archived: 0
    };
    const projectNames = new Map(reader.listProjects().map((project) => [project.id, project.name]));
    let openInputs = 0;
    const attention: WebAttentionItem[] = [];
    const tasks = reader.listTasks().map((task): DashboardTask => {
      statusCounts[task.status] += 1;
      const taskOpenInputs = reader.listInputRequests(task.id)
        .filter((request) => request.status === "open").length;
      openInputs += taskOpenInputs;
      const taskOpen = reader.listInputRequests(task.id)
        .filter((request) => request.status === "open");
      for (const request of taskOpen) {
        attention.push({ taskId: task.id, taskTitle: task.title, request });
      }
      const events = reader.listEvents?.(task.id) ?? [];
      const needsAttentionCount = reader.listTurns(task.id)
        .filter((turn) => turn.status === "active" && isRoleTurnStalled(events, turn.id))
        .length;
      const execution = buildTaskExecutionProjection(reader, task.id, task, now);
      const names = task.projectBindings.flatMap(({ projectId }) => {
        const name = projectNames.get(projectId);
        return name === undefined ? [] : [name];
      });
      return {
        ...task,
        ...(names.length === 0 ? {} : { projectNames: names }),
        workItems: countWorkItems(reader.listWorkItems(task.id)),
        roleCount: reader.listRoles(task.id).length,
        openInputCount: taskOpenInputs,
        needsAttentionCount,
        execution,
        executionStatus: execution?.status ?? null
      };
    }).sort(compareDashboardTasks);

    return {
      generatedAt: now.toISOString(),
      counts: { total: tasks.length, ...statusCounts, openInputs },
      attention: attention.sort(compareAttention),
      tasks
    };
  });
}

export function buildWebTaskDetail(
  store: WebDashboardStore,
  taskId: string,
  now: Date = new Date()
): object | null {
  return store.transaction((reader) => {
    const task = reader.getTask(taskId);
    if (task === null) return null;
    const inputs = reader.listInputRequests(taskId);
    const projectNamesById = new Map(
      reader.listProjects().map((project) => [project.id, project.name])
    );
    const projectNames = task.projectBindings.flatMap(({ projectId }) => {
      const name = projectNamesById.get(projectId);
      return name === undefined ? [] : [name];
    });
    const turns = reader.listTurns(taskId);
    const events = reader.listEvents?.(taskId) ?? [];
    const needsAttentionTurns = turns
      .filter((turn) => turn.status === "active" && isRoleTurnStalled(events, turn.id))
      .map((turn) => ({
        turnId: turn.id,
        roleName: turn.roleName,
        progressAt: latestStallProgress(events, turn.id),
        kind: latestStallField(events, turn.id, "kind") ?? "workflow-not-progressing",
        classification: latestStallField(events, turn.id, "classification") ?? "truly-stalled"
      }));
    const activeTurns = new Map(turns
      .filter((turn) => turn.status === "active")
      .map((turn) => [turn.roleName, turn]));
    const activeTurnHealth = turns
      .filter((turn) => turn.status === "active")
      .map((turn) => projectWebTurnRuntimeHealth(
        reader,
        taskId,
        turn,
        events,
        now,
        resolveRuntimeHealth(reader.getConfig().runtimeHealth)
      ));
    const roles = reader.listRoles(taskId).map((role) => {
      const activeTurn = activeTurns.get(role.name);
      const sessions = reader.getTaskRoleSessionSet(taskId, role.name);
      const activeSession = sessions?.sessions[sessions.activeAgentId];
      const effectiveLaunch = activeTurn?.effective ?? activeSession?.effective ?? null;
      return {
        ...role,
        // Presentation only: workflow activity is derived from Turn; the
        // native Session contributes lifecycle detail when no Turn is active.
        status: activeTurn === undefined ? activeSession?.status ?? "idle" : "running",
        sessionTokens: projectSessionTokenMetrics(
          events,
          resolveSessionTokenIdentity(activeSession === undefined
            ? null
            : { taskId, roleName: role.name, ...activeSession })
        ),
        effectiveLaunch,
        effectiveLaunchSource: activeTurn === undefined
          ? activeSession === undefined ? null : "session"
          : "turn",
        launchDrift: effectiveLaunch !== null
          && effectiveLaunch.sourceDesiredRevision !== role.launchRevision
      };
    });
    const execution = buildTaskExecutionProjection(reader, taskId, task, now);
    if (execution === null) return null;
    const workItemObservability = new Map(
      execution.observability.workItems.map((item) => [item.workItemId, item])
    );
    return {
      task: {
        ...task,
        ...(projectNames.length === 0 ? {} : { projectNames })
      },
      execution,
      observability: execution.observability,
      brief: reader.getTaskBrief(taskId),
      roles,
      workItems: reader.listWorkItems(taskId).map((item) => {
        const group = currentWorkItemExecutionGroup(item);
        return {
          ...item,
          observability: workItemObservability.get(item.id),
          ...(group === undefined ? {} : { currentExecution: summarizeWorkItemExecutionGroup(group) })
        };
      }),
      turns,
      runtimeHealth: { needsAttentionTurns, activeTurns: activeTurnHealth },
      reviewRounds: reader.listReviewRounds(taskId),
      openInputs: inputs.filter((request) => request.status === "open"),
      messages: reader.listMessages(taskId),
      decisions: reader.listDecisions(taskId),
      milestones: reader.listMilestones(taskId)
    };
  });
}

function latestStallProgress(events: readonly TaskEvent[], turnId: string): string | undefined {
  return latestStallField(events, turnId, "progressAt");
}

export type WebRuntimeHealthLayer = RuntimeHealthLayer | "stalled-candidate";

/**
 * Layered runtime health for one active Turn, computed from the same stored
 * observations and durable semantic fold as the CLI status projection. The
 * Web snapshot has no live tmux pane, so host state stays "unknown"; the
 * classifier still surfaces session/turn/operation/observer layers and the
 * scheduler's durable `turn.stalled` episode is surfaced as
 * `stalled-candidate`.
 */
function projectWebTurnRuntimeHealth(
  reader: WebDashboardStore,
  taskId: string,
  turn: Turn,
  events: readonly TaskEvent[],
  now: Date,
  policy: ReturnType<typeof resolveRuntimeHealth>
): Readonly<{
  turnId: string;
  roleName: string;
  layer: WebRuntimeHealthLayer;
  reason: string;
  stalled: boolean;
  lastRuntimeActivityAt?: string;
  lastSemanticProgressAt: string;
}> {
  const stalled = isRoleTurnStalled(events, turn.id);
  const sessions = reader.getTaskRoleSessionSet(taskId, turn.roleName);
  const session = sessions?.sessions[turn.effective.agentId];
  const stallReason = "the live active Turn has no durable progress in the configured stall window";
  if (session?.launchId === undefined) {
    return {
      turnId: turn.id,
      roleName: turn.roleName,
      layer: stalled ? "stalled-candidate" : "awaiting-provider-acceptance",
      reason: stalled ? stallReason : "the active Turn is awaiting a Provider Session",
      stalled,
      lastSemanticProgressAt: turn.createdAt
    };
  }
  let driverId: string;
  try {
    driverId = builtinDriverIdForAdapter(turn.effective.adapterId);
  } catch {
    return {
      turnId: turn.id,
      roleName: turn.roleName,
      layer: stalled ? "stalled-candidate" : "runtime-unobservable",
      reason: stalled ? stallReason : "the Agent Driver is not a built-in driver",
      stalled,
      lastSemanticProgressAt: turn.createdAt
    };
  }
  const providerTurn = sessions?.providerBinding?.turn;
  const fence = {
    taskId,
    roleName: turn.roleName,
    turnId: turn.id,
    agentId: turn.effective.agentId,
    driverId,
    launchId: session.launchId,
    sessionGenerationId: session.launchId,
    nativeSessionId: session.nativeSessionId,
    nativeTurnId: providerTurn?.turnId === turn.id
      ? providerTurn.nativeTurnId ?? turn.id
      : turn.id,
    receiptId: providerTurn?.turnId === turn.id
      ? providerTurn.attemptId
      : formatTurnReceiptId(taskId, turn.id)
  };
  const projection = projectRuntimeTaskEvents(fence, turn.createdAt, events);
  const view = {
    getTurn: (taskId: string, turnId: string) =>
      reader.listTurns(taskId).find((candidate) => candidate.id === turnId) ?? null,
    listEvents: () => events,
    getWorkItem: (workItemTaskId: string, workItemId: string) =>
      reader.listWorkItems(workItemTaskId).find((item) => item.id === workItemId) ?? null,
    listReviewRounds: (taskId: string) => reader.listReviewRounds(taskId),
    listChangeSets: (taskId: string) => reader.listChangeSets(taskId),
    listIntegrationAttempts: (taskId: string) => reader.listIntegrationAttempts(taskId),
    listInputRequests: (taskId: string) => reader.listInputRequests(taskId)
  };
  const semanticProgress = latestTurnDurableProgressAt(view, taskId, turn.roleName, turn.id)
    ?? { progressAt: turn.createdAt };
  const classification = classifyRuntimeHealth({
    projection,
    semanticProgressAt: semanticProgress.progressAt,
    now,
    policy
  });
  return {
    turnId: turn.id,
    roleName: turn.roleName,
    layer: stalled ? "stalled-candidate" : classification.layer,
    reason: stalled ? stallReason : classification.reason,
    stalled,
    ...(classification.lastRuntimeActivityAt === undefined
      ? {}
      : { lastRuntimeActivityAt: classification.lastRuntimeActivityAt }),
    lastSemanticProgressAt: classification.lastSemanticProgressAt
  };
}

function latestStallField(
  events: readonly TaskEvent[],
  turnId: string,
  field: string
): string | undefined {
  const stalled = events
    .filter((event) => event.type === "turn.stalled"
      && event.payload.turnId === turnId
      && event.payload.status !== "diagnostic-only")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return stalled?.payload[field];
}

function countWorkItems(items: readonly WorkItem[]): WorkItemCounts {
  const counts: WorkItemCounts = {
    total: items.length,
    pending: 0,
    running: 0,
    awaiting_acceptance: 0,
    completed: 0,
    failed: 0,
    retired: 0
  };
  const mutable = counts as Record<keyof WorkItemCounts, number>;
  for (const item of items) {
    mutable[item.status] += 1;
  }
  return counts;
}

function compareDashboardTasks(left: DashboardTask, right: DashboardTask): number {
  const statusOrder: Record<TaskStatus, number> = {
    active: 0,
    draft: 1,
    completed: 2,
    retired: 3,
    archived: 4
  };
  return statusOrder[left.status] - statusOrder[right.status]
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function compareAttention(left: WebAttentionItem, right: WebAttentionItem): number {
  return Date.parse(left.request.createdAt) - Date.parse(right.request.createdAt)
    || left.request.id.localeCompare(right.request.id);
}
