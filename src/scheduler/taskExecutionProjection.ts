import type { TaskEvent } from "../event/taskEvent.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { AgentRun } from "../agentRun/agentRun.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";
import type { ProviderTurnStatus } from "../runtime/providerRuntimeIdentity.js";
import type { Role } from "../role/role.js";
import { taskOwnsManagedWorkspace, type Task, type TaskStatus } from "../task/task.js";
import type { TaskBrief } from "../brief/taskBrief.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import type { LeaderFailure } from "./leaderFailure.js";
import {
  currentWorkItemExecutionGroup,
  type WorkItem
} from "../workItem/workItem.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { ChangeSet } from "../integration/changeSet.js";
import { mailboxBatches, type WorkMailbox } from "../coordination/workMailbox.js";
import type { ExecutionGroup } from "../execution/workItemExecution.js";
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
  | "stopped"
  | "needs-leader-action"
  | "waiting-on-agents"
  | "waiting-user"
  | "recovering"
  | "attention"
  | "progressing-with-attention"
  | "blocked"
  | "working"
  | "completed"
  | "cancelled"
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
  | "resolve-integration-conflicts"
  | "start-execution"
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
  providerSession: "active" | "starting";
  status: AgentRun["status"];
  delivery: ProviderTurnStatus | "unobserved";
  workItemId?: string;
  reviewRoundId?: string;
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
  listRuns?(taskId: string): readonly AgentRun[];
  listWorkItems?(taskId: string): readonly WorkItem[];
  listInputRequests?(taskId: string): readonly InputRequest[];
  listReviewRounds?(taskId: string): readonly ReviewRound[];
  listChangeSets?(taskId: string): readonly ChangeSet[];
  listIntegrationAttempts?(taskId: string): readonly IntegrationAttempt[];
  listEvents?(taskId: string): readonly TaskEvent[];
  getWorkMailbox?(target: WorkMailbox["target"]): WorkMailbox | null;
  getPendingWakeup?(taskId: string): PendingWakeup | null;
  getLeaderFailure?(taskId: string): LeaderFailure | null;
  getRoleSession?(taskId: string, roleName: string, agentId?: string): Readonly<{
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    status?: string;
  }> | null;
  getTaskRoleSessionSet?(taskId: string, roleName: string): import("../executor/agentExecutor.js").TaskRoleSessionSet | null;
  getConfig?(): Readonly<{ runtimeHealth?: unknown }>;
  listContextSnapshots?(taskId: string): readonly ContextSnapshot[];
}>;

type TaskExecutionTask = Readonly<Pick<
  Task,
  "id" | "title" | "status" | "executionGate" | "projectBindings" | "cwd"
  | "createdAt" | "completedAt" | "retiredAt"
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
  /** Lifetime usage includes obsolete runs; scheduling still uses current runs. */
  usageRuns?: readonly AgentRun[];
  runDelivery?: Readonly<Record<string, ProviderTurnStatus | "unobserved">>;
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
  executionGroups?: readonly ExecutionGroup[];
  roleSessions?: readonly Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
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
  const usageRuns = store.listRuns?.(taskId) ?? [];
  const runs = operationalTaskRecords(
    usageRuns,
    events,
    "run"
  );
  const leaderMailbox = store.getWorkMailbox?.({
    kind: "role",
    taskId,
    roleName: "leader"
  }) ?? null;
  const roleSessions = roles.flatMap((role) => {
    const session = store.getRoleSession?.(taskId, role.name);
    return session === null || session === undefined
      ? []
      : [{ roleName: role.name, ...session }];
  });
  return projectTaskExecution({
    task,
    roles,
    runs,
    usageRuns,
    runDelivery: Object.fromEntries(runs.map((run) => {
      const observed = store.getTaskRoleSessionSet?.(taskId, run.roleName)?.providerBinding?.run;
      return [run.id, observed?.runId === run.id ? observed.status : "unobserved"];
    })),
    executionGroups: store.listWorkItems === undefined && store.listReviewRounds === undefined
      ? []
      : collectExecutionGroups(
          store.listWorkItems?.(taskId) ?? [],
          store.listReviewRounds?.(taskId) ?? [],
          runs
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
  const runs = operationalTaskRecords(facts.runs, facts.events ?? [], "run");
  const executionGroups = facts.executionGroups
    ?? collectExecutionGroups(facts.workItems ?? [], facts.reviewRounds ?? [], runs);
  return projectTaskExecution({
    ...facts,
    runs,
    usageRuns: facts.usageRuns ?? facts.runs,
    executionGroups
  });
}

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
    roleSessions = [],
    executionGroups = []
  } = facts;
  const now = facts.now ?? new Date();
  const groupSummaries = executionGroups.map((group) => {
    return summarizeExecutionGroupHealth({
      group,
      runs,
      sessions: roleSessions,
      events,
      now,
      ...(facts.runtimeHealthPolicy === undefined
        ? {}
        : { policy: facts.runtimeHealthPolicy })
    });
  });
  const observabilityGroups = uniqueExecutionGroups(executionGroups);
  const sessionTokens = roleSessions.map((session) => {
    const identity = resolveSessionTokenIdentity({ taskId: task.id, ...session });
    return Object.freeze({
      roleName: session.roleName,
      agentId: session.agentId,
      metrics: projectSessionTokenMetrics(events, identity)
    });
  });
  const observability = buildTaskObservabilityProjection({
    task,
    workItems,
    executionGroups: observabilityGroups,
    runs: facts.usageRuns ?? runs,
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
  const deliveryOf = (run: AgentRun): ProviderTurnStatus | "unobserved" => {
    const known = facts.runDelivery?.[run.id];
    if (known !== undefined && known !== "unobserved") return known;
    const observed = events.map(runtimeObservationFromTaskEvent).filter((event) =>
      event?.fence.runId === run.id && event.authority !== "transport"
      && ["turn.accepted", "turn.completed", "turn.failed", "turn.cancelled"].includes(event.kind)).at(-1);
    return observed === undefined || observed === null ? "unobserved"
      : observed.kind.slice("run.".length) as ProviderTurnStatus;
  };
  const runHasSession = (run: AgentRun): boolean => roleSessions.some((session) => (
    session.roleName === run.roleName
    && session.agentId === run.effective.agentId
    && session.status !== "ended"
  ));
  const activeRunViews: readonly TaskExecutionRun[] = activeRuns.map((run) => ({
    id: run.id,
    roleName: run.roleName,
    purpose: run.purpose,
    providerSession: runHasSession(run) ? "active" : "starting",
    status: run.status,
    delivery: deliveryOf(run),
    ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId }),
    ...(run.reviewRoundId === undefined ? {} : { reviewRoundId: run.reviewRoundId }),
    ...(run.executionGroupId === undefined ? {} : { executionGroupId: run.executionGroupId }),
    ...(run.executionLaneId === undefined ? {} : { executionLaneId: run.executionLaneId })
  }));
  const monitoring = task.executionGate.state === "stopped"
    || task.status === "completed"
    || task.status === "cancelled"
    || task.status === "archived"
    ? "stopped"
    : "active";
  if (monitoring === "stopped") {
    if (task.executionGate.state === "stopped" && task.status === "active") {
      return render({
        task,
        status: "stopped",
        owner: "operator",
        action: "start-execution",
        summary: `Task ${task.id} execution is stopped; durable progress is preserved.`,
        reason: "execution-stopped",
        monitoring,
        failClosed: false,
        activeRuns: activeRunViews,
        attention: [],
        blockers: [],
        pendingWakeup
      });
    }
    const stoppedStatus = task.status as Extract<TaskStatus, "completed" | "cancelled" | "archived">;
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
    roleSessions,
    inputRequests
  });
  const openInputs = inputRequests.filter((request) => request.status === "open");
  const blockers = collectBlockers(workItems, reviewRounds, integrations, openInputs, task);
  const activeExecutionRuns = activeRuns.filter((run) => run.purpose === "execution");
  const activeReviewRuns = activeRuns.filter((run) => run.purpose === "review");
  const activeDelegatedExecutions = activeExecutionRuns.filter((run) => (
    run.roleName !== "leader"
  ));
  const healthyActiveRuns = activeRuns.filter((run) => (
    deliveryOf(run) === "accepted"
    && !attention.some((item) => item.runId === run.id)
  ));
  const activeLeader = activeRuns.find((run) => run.roleName === "leader");
  const pendingDeliveryRuns = activeRuns.filter((run) => deliveryOf(run) !== "accepted");
  const hasPendingLeaderWork = pendingWakeup !== null
    || leaderMailbox?.pending !== null;
  const recoveryPending = isRecoveryPending(
    pendingWakeup,
    leaderMailbox,
    leaderFailure
  );
  const failedWork = workItems.some((item) => item.status === "open"
    && runs.filter((run) => run.workItemId === item.id).at(-1)?.status === "failed");
  const candidateReady = workItems.some((item) => (item.status === "open" && item.currentCandidateId !== undefined));
  const blockedIntegration = integrations.some((attempt) => attempt.status === "blocked");
  const conflictedIntegration = integrations.find((attempt) => attempt.status === "conflicted");
  const unresolvedIntegration = integrations.some((attempt) => (
    attempt.status === "running"
    || attempt.status === "validating"
    || attempt.status === "blocked"
    || attempt.status === "conflicted"
  ));
  const hasLeaderMismatch = attention.some((item) => item.kind === "identity-mismatch");

  const renderAttention = (): TaskExecutionProjection => {
    const first = attention[0];
    if (first === undefined) throw new Error("Task execution attention disappeared.");
    const progressingWithAttention = first.kind === "checkpoint-overdue"
      && healthyActiveRuns.length > 0;
    return render({
      task,
      status: progressingWithAttention ? "progressing-with-attention" : "attention",
      owner: first.owner,
      action: "inspect-attention",
      summary: progressingWithAttention
        ? `${healthyActiveRuns.length} healthy active AgentRun(s) remain while ${first.summary}`
        : first.summary,
      reason: progressingWithAttention ? "progressing-with-attention" : first.kind,
      monitoring,
      failClosed: hasLeaderMismatch || attention.some((item) => item.failClosed === true),
      activeRuns: activeRunViews,
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
        + (laneRecovery.runId === undefined ? "." : ` for exact AgentRun ${laneRecovery.runId}.`),
      reason: `execution-lane-${laneRecovery.recovery}`,
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (attention.length > 0) {
    return renderAttention();
  }
  if (conflictedIntegration !== undefined) {
    return render({
      task, status: "needs-leader-action", owner: "leader",
      action: "resolve-integration-conflicts",
      summary: `Integration ${conflictedIntegration.id} has Git conflicts; resolve its workspace and continue.`,
      reason: "integration-conflicted", monitoring, failClosed: false,
      activeRuns: activeRunViews, attention, blockers, pendingWakeup
    });
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
      attention,
      blockers,
      pendingWakeup
    });
  }
  const leaderDeliveryPending = pendingDeliveryRuns.some((run) => run.roleName === "leader");
  if (leaderDeliveryPending) {
    return render({
      task,
      status: "waiting-on-agents",
      owner: "leader",
      action: "recover-leader",
      summary: `Leader execution record is open; admission is ${activeLeader === undefined ? "unobserved" : deliveryOf(activeLeader)}. This is not proof of Agent progress.`,
      reason: "delivery-pending",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (activeLeader !== undefined) {
    const concurrentExecutionCount = activeDelegatedExecutions.length;
    const concurrentReviewCount = activeReviewRuns.length;
    const concurrentSummary = [
      concurrentExecutionCount === 0
        ? null
        : `${concurrentExecutionCount} delegated execution AgentRun(s)`,
      concurrentReviewCount === 0
        ? null
        : `${concurrentReviewCount} Review AgentRun(s)`
    ].filter((value): value is string => value !== null).join(" and ");
    return render({
      task,
      status: "working",
      owner: "leader",
      action: "advance-task",
      summary: concurrentSummary.length === 0
        ? "Leader execution was accepted; its result and Task progress remain separate facts."
        : `Leader execution was accepted alongside ${concurrentSummary}; Task progress remains a separate fact.`,
      reason: concurrentSummary.length === 0 ? "leader-turn-active" : "leader-and-agents-active",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (hasPendingLeaderWork) {
    return render({
      task,
      status: "needs-leader-action",
      owner: "leader",
      action: "advance-task",
      summary: "A durable Leader wake is pending; concurrent AgentRuns remain visible but do not suppress it.",
      reason: "leader-wake-pending",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (pendingDeliveryRuns.length > 0) {
    return render({
      task,
      status: "recovering",
      owner: "leader",
      action: "recover-execution",
      summary: `${pendingDeliveryRuns.length} active delegated AgentRun(s) are awaiting provider acceptance; delivery remains fail-closed.`,
      reason: "delivery-pending",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (activeDelegatedExecutions.length > 0) {
    const reviewSuffix = activeReviewRuns.length === 0
      ? ""
      : `; ${activeReviewRuns.length} Review AgentRun(s) are also active`;
    return render({
      task,
      status: "waiting-on-agents",
      owner: roleOwner(activeDelegatedExecutions[0].roleName),
      action: "wait-for-agents",
      summary: `${activeDelegatedExecutions.length} delegated execution AgentRun(s) are active${reviewSuffix}.`,
      reason: "delegated-work-active",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (activeReviewRuns.length > 0) {
    return render({
      task,
      status: "waiting-on-agents",
      owner: "reviewer",
      action: "wait-for-agents",
      summary: `${activeReviewRuns.length} Review AgentRun(s) are evaluating frozen candidates; newer facts can still wake the Leader.`,
      reason: "review-active",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
      attention,
      blockers,
      pendingWakeup
    });
  }
  if (candidateReady || unresolvedIntegration) {
    return render({
      task,
      status: "needs-leader-action",
      owner: "leader",
      action: "advance-task",
      summary: candidateReady
        ? "A WorkItem Candidate is awaiting Leader action."
        : "An Integration or validation record needs Leader action.",
      reason: candidateReady
        ? "candidate-ready"
        : "integration-pending",
      monitoring,
      failClosed: false,
      activeRuns: activeRunViews,
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
  reviewRounds: readonly ReviewRound[],
  _turns: readonly AgentRun[]
): ExecutionGroup[] {
  const groups: ExecutionGroup[] = [
    ...workItems.flatMap((item) => {
      const group = item.status === "retired"
        ? undefined
        : currentWorkItemExecutionGroup(item);
      return group === undefined ? [] : [group];
    }),
    ...reviewRounds.flatMap((round) => (
      (round.status === "pending" || round.status === "running")
        && round.executionGroup !== undefined
        ? [round.executionGroup]
        : []
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
  roleSessions: readonly Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>[];
  inputRequests: readonly InputRequest[];
}>): TaskExecutionAttention[] {
  const result: TaskExecutionAttention[] = [];
  const { task, activeRuns, events, leaderFailure } = input;
  if (leaderFailure !== null) {
    result.push({
      kind: "leader-recovery",
      id: `leader-recovery:${task.id}`,
      owner: "operator",
      summary: leaderFailure.message,
      failClosed: true
    });
  }
  for (const run of activeRuns) {
    const session = input.roleSessions.find((candidate) => candidate.roleName === run.roleName);
    // Current Role selection is desired configuration, not the identity fence
    // of a AgentRun already assigned. Only actual execution evidence can mismatch.
    if (
      session !== undefined
      && (session.agentId !== run.effective?.agentId || session.adapterId !== run.effective?.adapterId)
    ) {
      result.push({
        kind: "identity-mismatch",
        id: `session:${run.id}`,
        owner: "leader",
        summary: `AgentRun ${run.id} has a provider/session identity mismatch; monitoring fails closed.`,
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
          summary: `Leader AgentRun ${run.id} has an unresolved no-progress attention.`,
          runId: run.id,
          roleName: run.roleName
        });
      } else {
        result.push({
          kind: "checkpoint-overdue",
          id: `checkpoint-overdue:${run.id}`,
          owner: "leader",
          summary: `Delegated AgentRun ${run.id} has an unresolved checkpoint-overdue signal.`,
          runId: run.id,
          roleName: run.roleName
        });
      }
    }
  }
  for (const request of input.inputRequests.filter(({ status }) => status === "open")) {
    const requester = request.requester;
    // Origin is durable provenance, not a live execution lease. Questions
    // remain answerable after their originating Run ends or Session changes.
    if (
      requester === undefined || requester.taskId !== task.id || requester.roleName !== "leader"
    ) {
      result.push({
        kind: "identity-mismatch",
        id: `input:${request.id}`,
        owner: "leader",
        summary: `InputRequest ${request.id} has an invalid Task/Leader origin; it is held fail-closed.`,
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
    if (item.status === "open" && item.currentCandidateId !== undefined) {
      blockers.push({
        kind: "work",
        id: item.id,
        owner: "leader",
        summary: item.outcome ?? `WorkItem ${item.id} is ${item.status}.`
      });
    }
    if (item.status === "open" && (item.dependsOn ?? []).some((id) => {
      const status = byId.get(id)?.status;
      return status !== "accepted";
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
      summary: round.failure?.message ?? `ReviewRound ${round.id} failed.`
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
  // A Task activated with an empty environment plan owns no workspace and no
  // cwd by design; only a Task that should own one is blocked by its absence.
  if (task.status === "active"
    && taskOwnsManagedWorkspace(task)
    && task.cwd === undefined) {
    blockers.push({
      kind: "identity",
      id: `workspace:${task.id}`,
      owner: "leader",
      summary: "Project-backed Task workspace is not ready."
    });
  }
  return blockers;
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
  failure: LeaderFailure | null
): boolean {
  if (failure !== null) return false;
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
