import type { TaskEvent } from "../event/taskEvent.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { AgentRun } from "../run/agentRun.js";
import type { Role } from "../role/role.js";
import type { Task, TaskStatus } from "../task/task.js";
import type { TaskBrief } from "../brief/taskBrief.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import type { LeaderFailure } from "./leaderFailure.js";
import type { OperatorNotification } from "./operatorNotification.js";
import { currentWorkItemExecutionGroup, type WorkItem } from "../workItem/workItem.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { ChangeSet } from "../integration/changeSet.js";
import { mailboxBatches, type WorkMailbox } from "../coordination/workMailbox.js";
import {
  type ExecutionGroup
} from "../execution/executionGroup.js";
import {
  actionableExecutionLaneRecoveries,
  summarizeExecutionGroupHealth,
  type ExecutionGroupHealthSummary
} from "../execution/executionHealth.js";
import {
  buildTaskObservabilityProjection,
  type TaskObservabilityProjection
} from "./taskObservabilityProjection.js";
import type { ContextSnapshot } from "../context/contextSnapshot.js";
import { isRoleRunStalled, latestStallProgressAt } from "./roleRunStall.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";
import type { RuntimeHealthPolicy } from "../runtime/runtimeHealthPolicy.js";
import {
  projectSessionTokenMetrics,
  resolveSessionTokenIdentity
} from "../runtime/sessionTokenMetrics.js";

/**
 * Task-first status is a read-model vocabulary. It is deliberately not a new
 * persisted lifecycle state: every value is derived from the current Task
 * aggregate and its existing execution records.
 */
export type TaskExecutionStatus =
  | "needs-leader-action"
  | "waiting-on-agents"
  | "waiting-user"
  | "recovering"
  | "attention"
  | "progressing-with-attention"
  | "blocked"
  | "working"
  | "completed"
  | "retired"
  | "archived";

export type TaskExecutionOwner =
  | "leader"
  | "worker"
  | "reviewer"
  | "tester"
  | "operator"
  | "user"
  | "none";

export type TaskExecutionAction =
  | "advance-task"
  | "wait-for-agents"
  | "recover-execution"
  | "answer-input"
  | "inspect-attention"
  | "recover-leader"
  | "resolve-blocker"
  | "complete-task"
  | "none";

export type TaskExecutionAttentionKind =
  | "leader-recovery"
  | "leader-stalled"
  | "checkpoint-overdue"
  | "identity-mismatch"
  | "delivery-uncertain";

export type TaskExecutionAttention = Readonly<{
  kind: TaskExecutionAttentionKind;
  id: string;
  owner: "leader" | "operator";
  summary: string;
  runId?: string;
  roleName?: string;
  failClosed?: boolean;
}>;

export type TaskExecutionBlocker = Readonly<{
  kind: "work" | "review" | "integration" | "input" | "identity";
  id: string;
  owner: TaskExecutionOwner;
  summary: string;
}>;

export type TaskExecutionRun = Readonly<{
  id: string;
  roleName: string;
  purpose: AgentRun["purpose"];
  delivered: boolean;
  status: AgentRun["status"];
  executionGroupId?: string;
  executionLaneId?: string;
}>;

export type TaskExecutionProjection = Readonly<{
  taskId: string;
  taskStatus: TaskStatus;
  /** Derived status; never written back to the Task aggregate. */
  status: TaskExecutionStatus;
  owner: TaskExecutionOwner;
  action: TaskExecutionAction;
  summary: string;
  reason: string;
  monitoring: "active" | "stopped";
  failClosed: boolean;
  activeExecutorCount: number;
  activeRuns: readonly TaskExecutionRun[];
  /** Read-only Leader aggregation for every unified execution Group. */
  executionGroups: readonly ExecutionGroupHealthSummary[];
  /** Shared DAG, cost, context, and stage projection for CLI/Web consumers. */
  observability: TaskObservabilityProjection;
  attention: readonly TaskExecutionAttention[];
  blockers: readonly TaskExecutionBlocker[];
  /** Existing durable wake facts, included for idempotent reconciliation. */
  pendingWakeup: PendingWakeup | null;
  /** The projection's semantic next owner/action in one stable shape. */
  next: Readonly<{
    owner: TaskExecutionOwner;
    action: TaskExecutionAction;
  }>;
}>;

/** The small read-only source needed to fold a Task projection. */
export type TaskExecutionReadStore = Readonly<{
  getTask?(taskId: string): Task | null;
  getTaskBrief?(taskId: string): TaskBrief | null;
  listRoles?(taskId: string): readonly Role[];
  listAgentRuns?(taskId: string): readonly AgentRun[];
  listWorkItems?(taskId: string): readonly WorkItem[];
  listInputRequests?(taskId: string): readonly InputRequest[];
  listReviewRounds?(taskId: string): readonly ReviewRound[];
  listChangeSets?(taskId: string): readonly ChangeSet[];
  listIntegrationAttempts?(taskId: string): readonly IntegrationAttempt[];
  listEvents?(taskId: string): readonly TaskEvent[];
  getWorkMailbox?(target: WorkMailbox["target"]): WorkMailbox | null;
  getPendingWakeup?(taskId: string): PendingWakeup | null;
  getLeaderFailure?(taskId: string): LeaderFailure | null;
  getOperatorNotification?(taskId: string): OperatorNotification | null;
  getRoleSession?(taskId: string, roleName: string, agentId?: string): Readonly<{
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    launchId?: string;
    status?: string;
  }> | null;
  getConfig?(): Readonly<{ runtimeHealth?: unknown }>;
  listContextSnapshots?(taskId: string): readonly ContextSnapshot[];
}>;

type TaskExecutionTask = Readonly<Pick<
  Task,
  "id" | "title" | "status" | "projectBindings" | "cwd"
>>;

export type TaskExecutionFacts = Readonly<{
  task: TaskExecutionTask;
  roles: readonly Readonly<{
    name: string;
    activeAgentId?: string;
    adapterId?: string;
    status?: string;
  }>[];
  runs: readonly AgentRun[];
  workItems?: readonly WorkItem[];
  inputRequests?: readonly InputRequest[];
  reviewRounds?: readonly ReviewRound[];
  changeSets?: readonly ChangeSet[];
  integrations?: readonly IntegrationAttempt[];
  events?: readonly TaskEvent[];
  brief?: TaskBrief | null;
  pendingWakeup?: PendingWakeup | null;
  leaderMailbox?: WorkMailbox | null;
  leaderFailure?: LeaderFailure | null;
  operatorNotification?: OperatorNotification | null;
  executionGroups?: readonly ExecutionGroup[];
  roleSessions?: readonly Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    launchId?: string;
    status?: string;
  }>[];
  contextSnapshots?: readonly ContextSnapshot[];
  now?: Date;
  runtimeHealthPolicy?: RuntimeHealthPolicy;
}>;

/**
 * Build one consistent Task-first projection from the existing durable
 * aggregate. This function only reads; it never starts a Controller, queues a
 * wake, writes a Message, or mutates any record.
 */
export function buildTaskExecutionProjection(
  store: TaskExecutionReadStore,
  taskId: string,
  taskOverride?: TaskExecutionTask,
  now = new Date()
): TaskExecutionProjection | null {
  const task = store.getTask?.(taskId) ?? taskOverride ?? null;
  if (task === null) return null;
  const roles = store.listRoles?.(taskId) ?? [];
  const events = store.listEvents?.(taskId) ?? [];
  const runs = operationalTaskRecords(
    store.listAgentRuns?.(taskId) ?? [],
    events,
    "agent-run"
  );
  const leaderMailbox = store.getWorkMailbox?.({
    kind: "role",
    taskId,
    roleName: "leader"
  }) ?? null;
  const roleSessions = roles.flatMap((role) => {
    const session = store.getRoleSession?.(taskId, role.name, role.activeAgentId);
    return session === null || session === undefined
      ? []
      : [{ roleName: role.name, ...session }];
  });
  return projectTaskExecution({
    task,
    roles,
    runs,
    executionGroups: store.listWorkItems === undefined && store.listReviewRounds === undefined
      ? []
      : collectExecutionGroups(
          store.listWorkItems?.(taskId) ?? [],
          store.listReviewRounds?.(taskId) ?? []
        ),
    workItems: store.listWorkItems?.(taskId) ?? [],
    ...(store.listContextSnapshots === undefined
      ? {}
      : { contextSnapshots: store.listContextSnapshots(taskId) }),
    inputRequests: store.listInputRequests?.(taskId) ?? [],
    ...(store.listReviewRounds === undefined
      ? {}
      : { reviewRounds: store.listReviewRounds(taskId) }),
    ...(store.listChangeSets === undefined
      ? {}
      : { changeSets: store.listChangeSets(taskId) }),
    ...(store.listIntegrationAttempts === undefined
      ? {}
      : { integrations: store.listIntegrationAttempts(taskId) }),
    ...(store.listEvents === undefined ? {} : { events }),
    ...(store.getTaskBrief === undefined ? {} : { brief: store.getTaskBrief(taskId) }),
    pendingWakeup: store.getPendingWakeup?.(taskId) ?? null,
    leaderMailbox,
    leaderFailure: store.getLeaderFailure?.(taskId) ?? null,
    operatorNotification: store.getOperatorNotification?.(taskId) ?? null,
    roleSessions,
    now,
    runtimeHealthPolicy: resolveRuntimeHealth(store.getConfig?.().runtimeHealth)
  });
}

/**
 * Fold a Task projection from already-read facts. The Task overview reads each
 * per-Task fact once and reuses it here, instead of letting
 * buildTaskExecutionProjection read the store a second time for the same
 * unchanged revision.
 */
export function projectTaskExecutionFromFacts(
  facts: TaskExecutionFacts
): TaskExecutionProjection {
  const executionGroups = facts.executionGroups
    ?? collectExecutionGroups(facts.workItems ?? [], facts.reviewRounds ?? []);
  return projectTaskExecution({
    ...facts,
    runs: operationalTaskRecords(facts.runs, facts.events ?? [], "agent-run"),
    executionGroups
  });
}

/** Alias kept intentionally small for scheduler callers and external read models. */
export const deriveTaskExecutionProjection = projectTaskExecution;

export function projectTaskExecution(
  facts: TaskExecutionFacts
): TaskExecutionProjection {
  const {
    task,
    roles,
    runs,
    workItems = [],
    inputRequests = [],
    reviewRounds = [],
    integrations = [],
    events = [],
    pendingWakeup = null,
    leaderMailbox = null,
    leaderFailure = null,
    operatorNotification = null,
    roleSessions = [],
    executionGroups = []
  } = facts;
  const now = facts.now ?? new Date();
  const groupSummaries = executionGroups.map((group) => {
    const stageGroups = workItems.find((item) => (
      item.executionGroups.some(({ id }) => id === group.id)
    ))?.executionGroups;
    return summarizeExecutionGroupHealth({
      group,
      ...(stageGroups === undefined ? {} : { stageGroups }),
      runs,
      sessions: roleSessions,
      events,
      now,
      policy: facts.runtimeHealthPolicy
    });
  });
  const observabilityGroups = uniqueExecutionGroups([
    ...executionGroups,
    ...workItems.flatMap((item) => item.executionGroups)
  ]);
  const sessionTokens = roleSessions.map((session) => {
    const identity = resolveSessionTokenIdentity({ taskId: task.id, ...session });
    return Object.freeze({
      roleName: session.roleName,
      agentId: session.agentId,
      metrics: projectSessionTokenMetrics(events, identity)
    });
  });
  const observability = buildTaskObservabilityProjection({
    workItems,
    executionGroups: observabilityGroups,
    groupSummaries,
    runs,
    events,
    contextSnapshots: facts.contextSnapshots,
    sessionTokens,
    now
  });
  const laneRecovery = actionableExecutionLaneRecoveries(groupSummaries)[0];
  const render = (input: ProjectionInput): TaskExecutionProjection => projection({
    ...input,
    executionGroups: groupSummaries,
    observability
  });
  const activeRuns = runs.filter((run) => run.status === "active");
  const activeRunViews = activeRuns.map((run) => ({
    id: run.id,
    roleName: run.roleName,
    purpose: run.purpose,
    delivered: run.deliveredAt !== undefined,
    status: run.status,
    ...(run.executionGroupId === undefined ? {} : { executionGroupId: run.executionGroupId }),
    ...(run.executionLaneId === undefined ? {} : { executionLaneId: run.executionLaneId })
  }));
  const monitoring = task.status === "completed"
    || task.status === "retired"
    || task.status === "archived"
    ? "stopped"
    : "active";
  if (monitoring === "stopped") {
    const stoppedStatus = task.status as Extract<TaskStatus, "completed" | "retired" | "archived">;
    return render({
      task,
      status: stoppedStatus,
      owner: "none",
      action: "none",
      summary: `Task ${task.id} is ${task.status}; execution monitoring is stopped.`,
      reason: "task-terminal",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      activeExecutorCount: 0,
      attention: [],
      blockers: [],
      pendingWakeup
    });
  }

  const attention = collectAttention({
    task,
    roles,
    activeRuns,
    events,
    leaderFailure,
    operatorNotification,
    roleSessions,
    inputRequests
  });
  const openInputs = inputRequests.filter((request) => request.status === "open");
  const blockers = collectBlockers(workItems, reviewRounds, integrations, openInputs, task);
  const activeExecutors = activeRuns.filter((run) => isExecutionCarrier(run));
  const activeWorkers = activeExecutors.filter((run) => run.roleName !== "leader");
  const healthyExecutionCarriers = activeWorkers.filter((run) => (
    run.deliveredAt !== undefined
    && !attention.some((item) => item.runId === run.id)
  ));
  const activeLeader = activeRuns.find((run) => run.roleName === "leader");
  const pendingDelivery = activeRuns.some((run) => run.deliveredAt === undefined);
  const hasPendingLeaderWork = pendingWakeup !== null
    || leaderMailbox?.pending !== null && leaderMailbox?.pending !== undefined;
  const recoveryPending = isRecoveryPending(
    pendingWakeup,
    leaderMailbox,
    leaderFailure,
    operatorNotification
  );
  const failedWork = workItems.some((item) => item.status === "failed");
  const candidateReady = workItems.some((item) => item.status === "awaiting_acceptance");
  const blockedIntegration = integrations.some((attempt) => attempt.status === "blocked");
  const unresolvedIntegration = integrations.some((attempt) => (
    attempt.status === "running"
    || attempt.status === "validating"
    || attempt.status === "blocked"
  ));
  const hasLeaderMismatch = attention.some((item) => item.kind === "identity-mismatch");

  const renderAttention = (): TaskExecutionProjection => {
    const first = attention[0];
    if (first === undefined) throw new Error("Task execution attention disappeared.");
    const progressingWithAttention = first.kind === "checkpoint-overdue"
      && healthyExecutionCarriers.length > 0;
    return render({
      task,
      status: progressingWithAttention ? "progressing-with-attention" : "attention",
      owner: first.owner,
      action: "inspect-attention",
      summary: progressingWithAttention
        ? `${healthyExecutionCarriers.length} healthy execution carrier(s) remain while ${first.summary}`
        : first.summary,
      reason: progressingWithAttention ? "progressing-with-attention" : first.kind,
      monitoring,
      failClosed: hasLeaderMismatch || attention.some((item) => item.failClosed === true),
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  };
  if (attention.length > 0 && hasLeaderMismatch) {
    return renderAttention();
  }
  if (openInputs.length > 0) {
    return render({
      task,
      status: "waiting-user",
      owner: "user",
      action: "answer-input",
      summary: openInputs[0].question,
      reason: "open-input-request",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (laneRecovery !== undefined) {
    return render({
      task,
      status: laneRecovery.runtimeHealth === "confirmed-dead"
        ? "attention"
        : "needs-leader-action",
      owner: "leader",
      action: "recover-execution",
      summary: `Execution Lane ${laneRecovery.laneId} in ${laneRecovery.groupId}`
        + ` requires ${laneRecovery.recovery}`
        + (laneRecovery.runId === undefined ? "." : ` for exact Run ${laneRecovery.runId}.`),
      reason: `execution-lane-${laneRecovery.recovery}`,
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (attention.length > 0) {
    return renderAttention();
  }
  if (blockedIntegration || failedWork || hasLeaderMismatch) {
    return render({
      task,
      status: "blocked",
      owner: "leader",
      action: "resolve-blocker",
      summary: blockers[0]?.summary ?? `Task ${task.id} has a blocked durable record.`,
      reason: blockedIntegration ? "integration-blocked" : failedWork ? "work-failed" : "identity-mismatch",
      monitoring,
      failClosed: hasLeaderMismatch,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (recoveryPending) {
    return render({
      task,
      status: "recovering",
      owner: leaderFailure !== null ? "operator" : "leader",
      action: leaderFailure !== null ? "inspect-attention" : "recover-leader",
      summary: leaderFailure?.message
        ?? `Task ${task.id} has a durable recovery wake pending.`,
      reason: leaderFailure === null ? "recovery-pending" : "leader-recovery-failed",
      monitoring,
      failClosed: leaderFailure !== null,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (pendingDelivery) {
    return render({
      task,
      status: "recovering",
      owner: "leader",
      action: "recover-leader",
      summary: "An active Run is awaiting provider acceptance; delivery remains fail-closed.",
      reason: "delivery-pending",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (activeWorkers.length > 0 && activeLeader === undefined) {
    return render({
      task,
      status: "waiting-on-agents",
      owner: roleOwner(activeWorkers[0].roleName),
      action: "wait-for-agents",
      summary: `${activeWorkers.length} delegated execution Run(s) are active; Leader is waiting for their result.`,
      reason: "delegated-work-active",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (activeLeader !== undefined) {
    return render({
      task,
      status: activeWorkers.length > 0 ? "waiting-on-agents" : "working",
      owner: "leader",
      action: activeWorkers.length > 0 ? "wait-for-agents" : "advance-task",
      summary: activeWorkers.length > 0
        ? `Leader Run is active while ${activeWorkers.length} delegated Run(s) continue.`
        : "Leader Run is actively advancing the Task.",
      reason: activeWorkers.length > 0 ? "leader-and-delegates-active" : "leader-run-active",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (activeExecutors.length > 0) {
    return render({
      task,
      status: "waiting-on-agents",
      owner: roleOwner(activeExecutors[0].roleName),
      action: "wait-for-agents",
      summary: `${activeExecutors.length} delegated execution Run(s) are active.`,
      reason: "delegated-work-active",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (candidateReady || unresolvedIntegration || hasPendingLeaderWork) {
    return render({
      task,
      status: "needs-leader-action",
      owner: "leader",
      action: "advance-task",
      summary: candidateReady
        ? "A WorkItem Candidate is awaiting Leader action."
        : unresolvedIntegration
          ? "An Integration or validation record needs Leader action."
          : "A durable Leader wake is pending.",
      reason: candidateReady
        ? "candidate-ready"
        : unresolvedIntegration ? "integration-pending" : "leader-wake-pending",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      activeExecutorCount: activeExecutors.length,
      attention,
      blockers,
      pendingWakeup
    });
  }
    return render({
    task,
    status: "needs-leader-action",
    owner: "leader",
    action: "advance-task",
    summary: `Active Task ${task.id} has no current executor or open input.`,
    reason: "no-executor",
    monitoring,
    failClosed: false,
    activeRuns: activeRunViews,
    activeExecutorCount: activeExecutors.length,
    attention,
    blockers,
    pendingWakeup
  });
}

type ProjectionInput = Omit<
  TaskExecutionProjection,
  "next" | "taskId" | "taskStatus" | "executionGroups" | "observability"
> & Readonly<{
  task: Readonly<Pick<Task, "id" | "status">>;
  executionGroups?: readonly ExecutionGroupHealthSummary[];
}>;

function projection(
  input: ProjectionInput & Readonly<{ observability: TaskObservabilityProjection }>
): TaskExecutionProjection {
  return {
    taskId: input.task.id,
    taskStatus: input.task.status,
    status: input.status,
    owner: input.owner,
    action: input.action,
    summary: input.summary,
    reason: input.reason,
    monitoring: input.monitoring,
    failClosed: input.failClosed,
    activeExecutorCount: input.activeExecutorCount,
    activeRuns: input.activeRuns,
    executionGroups: input.executionGroups ?? [],
    observability: input.observability,
    attention: input.attention,
    blockers: input.blockers,
    pendingWakeup: input.pendingWakeup,
    next: { owner: input.owner, action: input.action }
  };
}

function uniqueExecutionGroups(groups: readonly ExecutionGroup[]): ExecutionGroup[] {
  const seen = new Set<string>();
  return groups.filter((group) => {
    if (seen.has(group.id)) return false;
    seen.add(group.id);
    return true;
  });
}

function collectExecutionGroups(
  workItems: readonly WorkItem[],
  reviewRounds: readonly ReviewRound[]
): ExecutionGroup[] {
  const workItemsById = new Map(workItems.map((item) => [item.id, item]));
  const orderedRounds = [...reviewRounds].sort((left, right) => (
    left.id.localeCompare(right.id, undefined, { numeric: true })
  ));
  const latestTaskRound = orderedRounds
    .filter((round) => (round.scope ?? "work-item") === "task")
    .at(-1);
  const latestWorkItemRounds = new Map<string, ReviewRound>();
  for (const round of orderedRounds) {
    if ((round.scope ?? "work-item") === "task"
      || round.workItemId === undefined
      || round.candidateId === undefined) continue;
    const item = workItemsById.get(round.workItemId);
    if (item === undefined
      || item.status === "retired"
      || item.candidates.at(-1)?.id !== round.candidateId) continue;
    latestWorkItemRounds.set(`${round.workItemId}\0${round.candidateId}`, round);
  }
  const operationalReviewRoundIds = new Set([
    ...(latestTaskRound === undefined ? [] : [latestTaskRound.id]),
    ...[...latestWorkItemRounds.values()].map(({ id }) => id)
  ]);
  const groups = [
    ...workItems.filter(({ status }) => status !== "retired").flatMap((item) => {
      const group = currentWorkItemExecutionGroup(item);
      return group === undefined ? [] : [group];
    }),
    ...reviewRounds.flatMap((round) => (
      !operationalReviewRoundIds.has(round.id) || round.executionGroup === undefined
        ? []
        : [round.executionGroup]
    ))
  ];
  const seen = new Set<string>();
  return groups.filter((group) => {
    if (seen.has(group.id)) return false;
    seen.add(group.id);
    return true;
  });
}

function collectAttention(input: Readonly<{
  task: TaskExecutionTask;
  roles: readonly Readonly<{ name: string; activeAgentId?: string; adapterId?: string }>[];
  activeRuns: readonly AgentRun[];
  events: readonly TaskEvent[];
  leaderFailure: LeaderFailure | null;
  operatorNotification: OperatorNotification | null;
  roleSessions: readonly Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>[];
  inputRequests: readonly InputRequest[];
}>): TaskExecutionAttention[] {
  const result: TaskExecutionAttention[] = [];
  const { task, activeRuns, events, leaderFailure, operatorNotification } = input;
  if (leaderFailure !== null || operatorNotification?.type === "leader-recovery-failed") {
    result.push({
      kind: "leader-recovery",
      id: `leader-recovery:${task.id}`,
      owner: "operator",
      summary: leaderFailure?.message
        ?? (operatorNotification?.type === "leader-recovery-failed"
          ? operatorNotification.message
          : "Leader recovery failed."),
      ...(leaderFailure === null ? {} : { failClosed: true })
    });
  }
  if (operatorNotification?.type === "leader-stalled") {
    result.push({
      kind: "leader-stalled",
      id: `leader-stall:${operatorNotification.runId}:${operatorNotification.progressAt}`,
      owner: "operator",
      summary: operatorNotification.message,
      runId: operatorNotification.runId,
      roleName: "leader"
    });
  }
  for (const run of activeRuns) {
    const role = input.roles.find((candidate) => candidate.name === run.roleName);
    const session = input.roleSessions.find((candidate) => candidate.roleName === run.roleName);
    if (
      role !== undefined
      && ((role.activeAgentId !== undefined && role.activeAgentId !== run.effective?.agentId)
        || (role.adapterId !== undefined && role.adapterId !== run.effective?.adapterId))
    ) {
      result.push({
        kind: "identity-mismatch",
        id: `identity:${run.id}`,
        owner: "leader",
        summary: `Run ${run.id} does not match the current ${run.roleName} Agent/adapter fence.`,
        runId: run.id,
        roleName: run.roleName,
        failClosed: true
      });
    }
    if (
      session !== undefined
      && (session.agentId !== run.effective?.agentId || session.adapterId !== run.effective?.adapterId)
    ) {
      result.push({
        kind: "identity-mismatch",
        id: `session:${run.id}`,
        owner: "leader",
        summary: `Run ${run.id} has a provider/session identity mismatch; monitoring fails closed.`,
        runId: run.id,
        roleName: run.roleName,
        failClosed: true
      });
    }
    if (isRoleRunStalled(events, run.id)) {
      if (run.roleName === "leader") {
        const progressAt = latestStallProgressAt(events, run.id) ?? "unknown";
        result.push({
          kind: "leader-stalled",
          id: `leader-stall:${run.id}:${progressAt}`,
          owner: "operator",
          summary: `Leader Run ${run.id} has an unresolved no-progress attention.`,
          runId: run.id,
          roleName: run.roleName
        });
      } else {
        result.push({
          kind: "checkpoint-overdue",
          id: `checkpoint-overdue:${run.id}`,
          owner: "leader",
          summary: `Delegated Run ${run.id} has an unresolved checkpoint-overdue signal.`,
          runId: run.id,
          roleName: run.roleName
        });
      }
    }
  }
  for (const request of input.inputRequests.filter(({ status }) => status === "open")) {
    const requester = request.requester;
    const run = requester === undefined
      ? undefined
      : activeRuns.find(({ id }) => id === requester.runId);
    const role = requester === undefined
      ? undefined
      : input.roles.find(({ name }) => name === requester.roleName);
    const session = requester === undefined
      ? undefined
      : input.roleSessions.find(({ roleName }) => roleName === requester.roleName);
    if (
      run === undefined
      || run.roleName !== "leader"
      || requester === undefined
      || run.effective?.agentId !== requester.agentId
      || (role?.adapterId !== undefined && role.adapterId !== run.effective?.adapterId)
      || (requester.nativeSessionId !== undefined
        && session?.nativeSessionId !== requester.nativeSessionId)
    ) {
      result.push({
        kind: "identity-mismatch",
        id: `input:${request.id}`,
        owner: "leader",
        summary: `InputRequest ${request.id} does not match the active Leader Run/session; it is held fail-closed.`,
        ...(requester?.runId === undefined ? {} : { runId: requester.runId }),
        roleName: "leader",
        failClosed: true
      });
    }
  }
  return uniqueAttention(result);
}

function collectBlockers(
  workItems: readonly WorkItem[],
  reviewRounds: readonly ReviewRound[],
  integrations: readonly IntegrationAttempt[],
  openInputs: readonly InputRequest[],
  task: TaskExecutionTask
): TaskExecutionBlocker[] {
  const blockers: TaskExecutionBlocker[] = [];
  const byId = new Map(workItems.map((item) => [item.id, item]));
  for (const item of workItems) {
    if (item.status === "failed" || item.status === "awaiting_acceptance") {
      blockers.push({
        kind: "work",
        id: item.id,
        owner: "leader",
        summary: item.outcome ?? `WorkItem ${item.id} is ${item.status}.`
      });
    }
    if (item.status === "pending" && (item.dependsOn ?? []).some((id) => {
      const status = byId.get(id)?.status;
      return status !== "completed" && status !== "retired";
    })) {
      blockers.push({
        kind: "work",
        id: item.id,
        owner: "leader",
        summary: `WorkItem ${item.id} is waiting on a dependency.`
      });
    }
  }
  for (const round of reviewRounds.filter(({ status }) => status === "failed")) {
    blockers.push({
      kind: "review",
      id: round.id,
      owner: "leader",
      summary: round.summary ?? `ReviewRound ${round.id} failed.`
    });
  }
  for (const attempt of integrations.filter(({ status }) => status === "blocked" || status === "failed")) {
    blockers.push({
      kind: "integration",
      id: attempt.id,
      owner: "leader",
      summary: attempt.conflict?.summary ?? `Integration ${attempt.id} is ${attempt.status}.`
    });
  }
  for (const request of openInputs) {
    blockers.push({
      kind: "input",
      id: request.id,
      owner: "user",
      summary: request.question
    });
  }
  if (task.status === "active" && task.cwd === undefined) {
    blockers.push({
      kind: "identity",
      id: `workspace:${task.id}`,
      owner: "leader",
      summary: "Project-backed Task workspace is not ready."
    });
  }
  return blockers;
}

function isExecutionCarrier(run: AgentRun): boolean {
  return run.purpose === "review"
    || run.roleName === "leader"
    // A scheduler-only projection may not have the WorkItem fold available
    // (for example during a recovery read). An active non-Leader Role is still
    // an execution carrier; omitting it would falsely wake the Leader.
    || run.workItemId !== undefined
    || run.roleName !== "leader";
}

function roleOwner(roleName: string): TaskExecutionOwner {
  const normalized = roleName.toLowerCase();
  if (normalized === "leader") return "leader";
  if (normalized.includes("review")) return "reviewer";
  if (normalized.includes("test")) return "tester";
  return "worker";
}

function isRecoveryPending(
  wakeup: PendingWakeup | null,
  mailbox: WorkMailbox | null,
  failure: LeaderFailure | null,
  notification: OperatorNotification | null
): boolean {
  if (failure !== null || notification?.type === "leader-recovery-failed") return false;
  const reasons = [
    ...(wakeup?.reasons ?? []),
    ...(mailbox === null ? [] : mailboxBatches(mailbox).flatMap((batch) => batch.reasons))
  ];
  return reasons.some((reason) => /(?:recover|stalled|failed|uncertain|orphan)/iu.test(reason));
}

function uniqueAttention(items: readonly TaskExecutionAttention[]): TaskExecutionAttention[] {
  const result: TaskExecutionAttention[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
