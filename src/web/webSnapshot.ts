import type { TaskStore } from "../storage/taskStore.js";
import type { InputRequest } from "../input/inputRequest.js";
import { type Task, type TaskStatus } from "../task/task.js";
import type { WorkItem, WorkItemStatus } from "../workItem/workItem.js";
import { isRoleRunStalled, latestRunDurableProgressAt } from "../scheduler/roleRunStall.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  buildTaskExecutionProjection,
  type TaskExecutionProjection
} from "../scheduler/taskExecutionProjection.js";
import { summarizeExecutionGroup } from "../execution/executionGroup.js";
import { currentWorkItemExecutionGroup } from "../workItem/workItem.js";
import {
  projectRunRecovery,
  readRunRecoveryFacts
} from "../run/recoveryProjection.js";
import {
  classifyRuntimeHealth,
  projectRuntimeTaskEvents,
  type RuntimeHealthLayer
} from "../runtime/runtimeProjection.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import type { AgentRun } from "../run/agentRun.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";

export type WebDashboardStore = Pick<TaskStore,
  | "transaction"
  | "listTasks"
  | "getTask"
  | "getTaskBrief"
  | "getAgentRun"
  | "getWorkItem"
  | "listRoles"
  | "getTaskRoleSessionSet"
  | "listWorkItems"
  | "listAgentRuns"
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
  | "getOperatorNotification"
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
      const needsAttentionCount = reader.listAgentRuns(task.id)
        .filter((run) => run.status === "active" && isRoleRunStalled(events, run.id))
        .length;
      const execution = buildTaskExecutionProjection(reader, task.id);
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
    const runs = reader.listAgentRuns(taskId);
    const events = reader.listEvents?.(taskId) ?? [];
    const needsAttentionRuns = runs
      .filter((run) => run.status === "active" && isRoleRunStalled(events, run.id))
      .map((run) => {
        const facts = readRunRecoveryFacts(reader, taskId, run.id);
        return {
          runId: run.id,
          roleName: run.roleName,
          progressAt: latestStallProgress(events, run.id),
          kind: latestStallField(events, run.id, "kind") ?? "workflow-not-progressing",
          classification: latestStallField(events, run.id, "classification") ?? "truly-stalled",
          // Issue 08: the same canonical recovery projection the CLI exposes.
          ...(facts === null ? {} : { recovery: projectRunRecovery(facts) })
        };
      });
    const activeRuns = new Map(runs
      .filter((run) => run.status === "active")
      .map((run) => [run.roleName, run]));
    const activeRunHealth = runs
      .filter((run) => run.status === "active")
      .map((run) => projectWebRunRuntimeHealth(
        reader,
        taskId,
        run,
        events,
        now,
        resolveRuntimeHealth(reader.getConfig().runtimeHealth)
      ));
    const roles = reader.listRoles(taskId).map((role) => {
      const activeRun = activeRuns.get(role.name);
      const sessions = reader.getTaskRoleSessionSet(taskId, role.name);
      const activeSession = sessions?.sessions[sessions.activeAgentId];
      const effectiveLaunch = activeRun?.effective ?? activeSession?.effective ?? null;
      return {
        ...role,
        effectiveLaunch,
        effectiveLaunchSource: activeRun === undefined
          ? activeSession === undefined ? null : "session"
          : "run",
        launchDrift: effectiveLaunch !== null
          && effectiveLaunch.sourceDesiredRevision !== role.launchRevision
      };
    });
    return {
      task: {
        ...task,
        ...(projectNames.length === 0 ? {} : { projectNames })
      },
      execution: buildTaskExecutionProjection(reader, taskId),
      brief: reader.getTaskBrief(taskId),
      roles,
      workItems: reader.listWorkItems(taskId).map((item) => {
        const group = currentWorkItemExecutionGroup(item);
        return {
          ...item,
          ...(group === undefined ? {} : { currentExecution: summarizeExecutionGroup(group) })
        };
      }),
      runs,
      runtimeHealth: { needsAttentionRuns, activeRuns: activeRunHealth },
      reviewRounds: reader.listReviewRounds(taskId),
      openInputs: inputs.filter((request) => request.status === "open"),
      messages: reader.listMessages(taskId),
      decisions: reader.listDecisions(taskId),
      milestones: reader.listMilestones(taskId)
    };
  });
}

function latestStallProgress(events: readonly TaskEvent[], runId: string): string | undefined {
  return latestStallField(events, runId, "progressAt");
}

export type WebRuntimeHealthLayer = RuntimeHealthLayer | "stalled-candidate";

/**
 * Layered runtime health for one active Run, computed from the same stored
 * observations and durable semantic fold as the CLI status projection. The
 * Web snapshot has no live tmux pane, so host state stays "unknown"; the
 * classifier still surfaces session/turn/operation/observer layers and the
 * scheduler's durable `run.stalled` episode is surfaced as
 * `stalled-candidate`.
 */
function projectWebRunRuntimeHealth(
  reader: WebDashboardStore,
  taskId: string,
  run: AgentRun,
  events: readonly TaskEvent[],
  now: Date,
  policy: ReturnType<typeof resolveRuntimeHealth>
): Readonly<{
  runId: string;
  roleName: string;
  layer: WebRuntimeHealthLayer;
  reason: string;
  stalled: boolean;
  lastRuntimeActivityAt?: string;
  lastSemanticProgressAt: string;
}> {
  const stalled = isRoleRunStalled(events, run.id);
  const sessions = reader.getTaskRoleSessionSet(taskId, run.roleName);
  const session = sessions?.sessions[run.effective.agentId];
  const stallReason = "the live active Run has no durable progress in the configured stall window";
  if (run.deliveredAt === undefined || session?.launchId === undefined) {
    return {
      runId: run.id,
      roleName: run.roleName,
      layer: stalled ? "stalled-candidate" : "awaiting-provider-acceptance",
      reason: stalled ? stallReason : "the pushed active Run is awaiting provider acceptance",
      stalled,
      lastSemanticProgressAt: run.createdAt
    };
  }
  let driverId: string;
  try {
    driverId = builtinDriverIdForAdapter(run.effective.adapterId);
  } catch {
    return {
      runId: run.id,
      roleName: run.roleName,
      layer: stalled ? "stalled-candidate" : "runtime-unobservable",
      reason: stalled ? stallReason : "the Agent Driver is not a built-in driver",
      stalled,
      lastSemanticProgressAt: run.deliveredAt
    };
  }
  const fence = {
    taskId,
    roleName: run.roleName,
    runId: run.id,
    agentId: run.effective.agentId,
    driverId,
    launchId: session.launchId,
    sessionGenerationId: session.launchId,
    nativeSessionId: session.nativeSessionId,
    nativeTurnId: run.id,
    receiptId: formatAgentRunReceiptId(taskId, run.id)
  };
  const projection = projectRuntimeTaskEvents(fence, run.createdAt, events);
  const view = {
    getAgentRun: (taskId: string, runId: string) =>
      reader.listAgentRuns(taskId).find((candidate) => candidate.id === runId) ?? null,
    listEvents: () => events,
    getWorkItem: (workItemTaskId: string, workItemId: string) =>
      reader.listWorkItems(workItemTaskId).find((item) => item.id === workItemId) ?? null,
    listReviewRounds: (taskId: string) => reader.listReviewRounds(taskId),
    listChangeSets: (taskId: string) => reader.listChangeSets(taskId),
    listIntegrationAttempts: (taskId: string) => reader.listIntegrationAttempts(taskId),
    listInputRequests: (taskId: string) => reader.listInputRequests(taskId)
  };
  const semanticProgress = latestRunDurableProgressAt(view, taskId, run.roleName, run.id)
    ?? { progressAt: run.deliveredAt };
  const classification = classifyRuntimeHealth({
    projection,
    semanticProgressAt: semanticProgress.progressAt,
    now,
    policy
  });
  return {
    runId: run.id,
    roleName: run.roleName,
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
  runId: string,
  field: string
): string | undefined {
  const stalled = events
    .filter((event) => event.type === "run.stalled" && event.payload.runId === runId)
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
