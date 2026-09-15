import type { TaskStore } from "../storage/taskStore.js";
import { providerRetryProjection } from "../runtime/providerRetry.js";
import { readTaskCatalog, type TaskCatalogOptions } from "../context/taskCatalog.js";
import type { Task } from "../task/task.js";
import { isRoleRunStalled, latestRunDurableProgressAt } from "../scheduler/roleRunStall.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { retiredTaskRecordIds } from "../task/taskRecordRetirement.js";
import { buildTaskExecutionProjection } from "../scheduler/taskExecutionProjection.js";
import { projectWorkItemExecution } from "../execution/workItemExecutionProjection.js";
import {
  classifyRuntimeHealth,
  projectRuntimeTaskEvents,
  type RuntimeHealthLayer
} from "../runtime/runtimeProjection.js";
import { builtinDriverIdForAdapter } from "../runtime/builtinAgentDrivers.js";
import { formatRunReceiptId } from "../task/taskRecordReference.js";
import { runExecutionObservation, type AgentRun } from "../agentRun/agentRun.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";
import {
  projectSessionTokenMetrics,
  resolveSessionTokenIdentity
} from "../runtime/sessionTokenMetrics.js";
import {
  projectTaskRemoteDelivery,
  type TaskRemoteDelivery
} from "../task/remoteDelivery.js";

export function buildWebTaskCatalog(store: WebDashboardStore, options: TaskCatalogOptions) {
  return store.transaction(reader => readTaskCatalog(reader, options));
}

export type WebDashboardStore = Pick<TaskStore,
  | "transaction"
  | "getTask"
  | "getTaskBrief"
  | "getRun"
  | "getWorkItem"
  | "listRoles"
  | "listRoleSessionSets"
  | "getTaskRoleSessionSet"
  | "listWorkItems"
  | "listContextSnapshots"
  | "listRuns"
  | "listReviewRounds"
  | "listInputRequests"
  | "listMessages"
  | "listDecisions"
  | "listMilestones"
  | "listProjects"
  | "listChangeSets"
  | "listIntegrationAttempts"
  | "listPublicationReferences"
  | "listManagedWorkspaces"
  | "getWorkMailbox"
  | "getPendingWakeup"
  | "getLeaderFailure"
  | "getRoleSession"
  | "getConfig"
  | "listEvents"
>;

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
    const runs = reader.listRuns(taskId);
    const events = reader.listEvents(taskId);
    const retiredMessageIds = retiredTaskRecordIds(events, "message");
    const needsAttentionRuns = runs
      .filter((run) => run.status === "active" && isRoleRunStalled(events, run.id))
      .map((run) => ({
        runId: run.id,
        roleName: run.roleName,
        progressAt: latestStallProgress(events, run.id),
        kind: latestStallField(events, run.id, "kind") ?? "workflow-not-progressing",
        classification: latestStallField(events, run.id, "classification") ?? "truly-stalled"
      }));
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
      const activeSession = sessions?.sessions[activeRun?.effective.agentId ?? sessions.activeAgentId];
      const effectiveLaunch = activeRun?.effective ?? activeSession?.effective ?? null;
      const delivery = sessions?.providerBinding?.run?.status;
      const providerRetry = providerRetryProjection(sessions?.providerBinding);
      return {
        ...role,
        providerRetry,
        // An open record is not proof that its Agent is running.
        status: providerRetry?.status === "waiting" ? "waiting"
          : delivery === "accepted" ? "running"
          : delivery === "submitting" || delivery === "deferred" ? "waiting"
          : activeSession === undefined && activeRun === undefined ? "idle" : "unknown",
        sessionTokens: projectSessionTokenMetrics(
          events,
          resolveSessionTokenIdentity(activeSession === undefined
            ? null
            : { taskId, roleName: role.name, ...activeSession })
        ),
        effectiveLaunch,
        observedAt: now.toISOString(),
        runtimeSession: activeSession === undefined ? null : {
          agentId: activeSession.agentId,
          adapterId: activeSession.adapterId,
          nativeSessionId: activeSession.nativeSessionId ?? null,
          status: activeSession.status,
          endpointImplementation: activeSession.endpointImplementation ?? null
        },
        effectiveLaunchSource: activeRun === undefined
          ? activeSession === undefined ? null : "session"
          : "run",
        launchDrift: effectiveLaunch !== null
          && effectiveLaunch.sourceDesiredRevision !== role.launchRevision
      };
    });
    const execution = buildTaskExecutionProjection(reader, taskId, now);
    if (execution === null) return null;
    const remoteDelivery = webRemoteDelivery(reader, task);
    const workItems = reader.listWorkItems(taskId);
    const roleSessionSets = reader.listRoleSessionSets(taskId);
    const workItemObservability = new Map(
      execution.observability.workItems.map((item) => [item.workItemId, item])
    );
    return {
      task: {
        ...task,
        ...(projectNames.length === 0 ? {} : { projectNames })
      },
      execution,
      remoteDelivery,
      observability: execution.observability,
      brief: reader.getTaskBrief(taskId),
      roles,
      workItems: workItems.map((item) => ({
        ...item,
        observability: workItemObservability.get(item.id),
        execution: projectWorkItemExecution(item, runs, roleSessionSets, reader)
      })),
      runs: runs.map((run) => ({ ...run, execution: runExecutionObservation(run,
        reader.getTaskRoleSessionSet(taskId, run.roleName)?.providerBinding, events) })),
      runtimeHealth: { needsAttentionRuns, activeRuns: activeRunHealth },
      reviewRounds: reader.listReviewRounds(taskId),
      openInputs: inputs.filter((request) => request.status === "open"),
      messages: reader.listMessages(taskId).map((message) => ({
        ...message,
        status: retiredMessageIds.has(message.id) ? "retired" : "active"
      })),
      decisions: reader.listDecisions(taskId),
      milestones: reader.listMilestones(taskId)
    };
  });
}

function webRemoteDelivery(
  reader: WebDashboardStore,
  task: Task
): TaskRemoteDelivery {
  return projectTaskRemoteDelivery({
    task,
    events: reader.listEvents(task.id),
    publications: reader.listPublicationReferences(task.id),
    managedWorkspaces: reader.listManagedWorkspaces(task.id),
    runs: reader.listRuns(task.id),
    integrations: reader.listIntegrationAttempts(task.id),
    currentCandidate: null
  });
}

function latestStallProgress(events: readonly TaskEvent[], runId: string): string | undefined {
  return latestStallField(events, runId, "progressAt");
}

export type WebRuntimeHealthLayer = RuntimeHealthLayer | "stalled-candidate";

/**
 * Layered runtime health for one active AgentRun, computed from the same stored
 * observations and durable semantic fold as the CLI status projection. The
 * Web snapshot has no live tmux pane, so host state stays "unknown"; the
 * classifier still surfaces session/turn/operation/observer layers and the
 * scheduler's durable `turn.stalled` episode is surfaced as
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
  const stallReason = "the live active AgentRun has no durable progress in the configured stall window";
  if (session?.nativeSessionId === undefined) {
    return {
      runId: run.id,
      roleName: run.roleName,
      layer: stalled ? "stalled-candidate" : "awaiting-provider-acceptance",
      reason: stalled ? stallReason : "the active AgentRun is awaiting a Provider Session",
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
      lastSemanticProgressAt: run.createdAt
    };
  }
  const providerTurn = sessions?.providerBinding?.run;
  const fence = {
    taskId,
    roleName: run.roleName,
    runId: run.id,
    agentId: run.effective.agentId,
    driverId,
    nativeSessionId: session.nativeSessionId,
    nativeTurnId: providerTurn?.runId === run.id
      ? providerTurn.nativeTurnId ?? run.id
      : run.id,
    receiptId: providerTurn?.runId === run.id
      ? providerTurn.attemptId
      : formatRunReceiptId(taskId, run.id)
  };
  const projection = projectRuntimeTaskEvents(fence, run.createdAt, events);
  const view = {
    getRun: (taskId: string, runId: string) =>
      reader.listRuns(taskId).find((candidate) => candidate.id === runId) ?? null,
    listEvents: () => events,
    getWorkItem: (workItemTaskId: string, workItemId: string) =>
      reader.listWorkItems(workItemTaskId).find((item) => item.id === workItemId) ?? null,
    listReviewRounds: (taskId: string) => reader.listReviewRounds(taskId),
    listChangeSets: (taskId: string) => reader.listChangeSets(taskId),
    listIntegrationAttempts: (taskId: string) => reader.listIntegrationAttempts(taskId),
    listInputRequests: (taskId: string) => reader.listInputRequests(taskId)
  };
  const semanticProgress = latestRunDurableProgressAt(view, taskId, run.roleName, run.id)
    ?? { progressAt: run.createdAt };
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
    .filter((event) => event.type === "run.stalled"
      && event.payload.runId === runId
      && event.payload.status !== "diagnostic-only")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return stalled?.payload[field];
}
