import type { TaskBrief } from "../brief/taskBrief.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { usageError } from "../errors/cliError.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { LeaderFailure } from "../scheduler/leaderFailure.js";
import {
  isRoleTurnStalled,
  latestStallProgressAt
} from "../scheduler/roleTurnStall.js";
import type { Turn } from "../turn/turn.js";
import type { RoleAgentSession } from "../executor/agentExecutor.js";
import { formatTimestamp } from "../output/timePresentation.js";
import type { Task } from "../task/task.js";
import { pendingWakeupProjection, type TaskStore } from "../storage/taskStore.js";
import type { WorkItem, WorkItemStatus } from "../workItem/workItem.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  projectTaskExecutionFromFacts,
  type TaskExecutionProjection
} from "../scheduler/taskExecutionProjection.js";
import { resolveRuntimeHealth } from "../config/yuiConfig.js";
import { projectNextAction, type NextAction } from "../task/nextAction.js";
import { projectTaskRemoteDeliveryFromStore } from "./taskRemoteDeliveryCommand.js";
import type { TaskRemoteDelivery } from "../task/remoteDelivery.js";

export type TaskListOptions = Readonly<{
  all: boolean;
  verbose: boolean;
}>;

export type TaskOverviewWorkCounts = Readonly<Record<WorkItemStatus, number> & {
  total: number;
}>;

export type TaskOverviewLeader = Readonly<{
  role: "leader";
  /** Derived workflow/lifecycle presentation; never persisted on TaskRole. */
  roleStatus: RoleAgentSession["status"] | "running" | "idle" | "missing";
  summary: string | null;
  currentFocus: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  summaryStatus: "available" | "missing";
}>;

export type TaskOverviewRuntimeTurn = Readonly<{
  id: string;
  roleName: string;
  status: Turn["status"];
  runtime: "starting" | "session-active";
  createdAt: string;
  updatedAt: string;
}>;

export type TaskOverviewRuntime = Readonly<{
  activeTurns: readonly TaskOverviewRuntimeTurn[];
  activeTurnCount: number;
  pendingDeliveryCount: number;
}>;

export type TaskOverviewAttention = Readonly<{
  kind: "leader-recovery" | "leader-stalled";
  id: string;
  status: "failed" | "needs-attention";
  owner: "operator";
  summary: string;
  updatedAt: string;
  turnId?: string;
  roleName?: string;
}>;

export type TaskOverviewBlocker = Readonly<{
  kind: "work" | "input" | "attention";
  type: "work" | "input" | "attention";
  id: string;
  status: string;
  owner: string;
  action: string;
  summary: string;
  blockedRefs?: readonly Readonly<{ type: "work-item" | "turn"; taskId: string; id: string }>[];
}>;

export type TaskOverviewNext = Readonly<{
  action: string;
  owner: string;
  kind: TaskOverviewBlocker["kind"] | "execution" | "wakeup" | "summary";
  id?: string;
  summary: string;
}>;

export type TaskOverview = Task & Readonly<{
  brief: TaskBrief | null;
  leader: TaskOverviewLeader;
  leaderSummary: string | null;
  currentFocus: string | null;
  summaryUpdatedAt: string | null;
  summaryUpdatedBy: string | null;
  summaryStatus: "available" | "missing";
  work: Readonly<{
    counts: TaskOverviewWorkCounts;
    items: readonly WorkItem[];
  }>;
  input: Readonly<{
    open: readonly InputRequest[];
    openCount: number;
  }>;
  attention: readonly TaskOverviewAttention[];
  attentionCount: number;
  blockers: readonly TaskOverviewBlocker[];
  next: TaskOverviewNext | null;
  nextAction: string | null;
  nextOwner: string | null;
  runtime: TaskOverviewRuntime;
  /** One read-only Task-first fold shared with scheduler/web consumers. */
  execution: TaskExecutionProjection;
  /** Persisted-head remote delivery projection; provider verification stays explicit. */
  remoteDelivery: TaskRemoteDelivery;
}>;

export type TaskOverviewResult = Readonly<{
  tasks: readonly TaskOverview[];
}>;

export function parseTaskListOptions(args: readonly string[]): TaskListOptions {
  const allowed = new Set(["--all", "--verbose"]);
  if (
    args.some((argument) => !allowed.has(argument))
    || new Set(args).size !== args.length
  ) {
    throw usageError(
      "Task list usage: yui task list [--all] [--verbose]."
    );
  }
  return {
    all: args.includes("--all"),
    verbose: args.includes("--verbose")
  };
}

export function buildTaskOverview(
  store: TaskStore,
  options: TaskListOptions,
  now = new Date()
): TaskOverviewResult {
  const runtimeHealthPolicy = resolveRuntimeHealth(store.getConfig().runtimeHealth);
  const tasks = store.listTasks()
    .filter((task) => options.all || task.status !== "archived")
    .map((task) => buildTaskOverviewEntry(task, store, now, runtimeHealthPolicy));
  return { tasks };
}

export function renderTaskOverview(
  result: TaskOverviewResult,
  options: TaskListOptions,
  timeZone: unknown,
  width = defaultTableWidth()
): string {
  if (result.tasks.length === 0) return "No tasks found.\n";
  const title = options.all ? "Tasks (all)" : "Tasks (unarchived)";
  const output = renderTable(
    title,
    [
      { header: "Task", minWidth: 8, maxWidth: 20 },
      { header: "Title", minWidth: 10, maxWidth: 46 },
      { header: "Lifecycle", minWidth: 9, maxWidth: 14 },
      { header: "Leader", minWidth: 12, maxWidth: 48 },
      { header: "Summary updated", minWidth: 16, maxWidth: 28 },
      { header: "Work", minWidth: 8, maxWidth: 38 },
      { header: "Blockers", minWidth: 9, maxWidth: 42 },
      { header: "Execution", minWidth: 14, maxWidth: 34 },
      { header: "Delivery", minWidth: 12, maxWidth: 28 },
      { header: "Next action / owner", minWidth: 16, maxWidth: 42 }
    ],
    result.tasks.map((task) => [
      task.id,
      task.title,
      task.status,
      leaderCell(task),
      task.summaryUpdatedAt === null
        ? "missing"
        : formatTimestamp(task.summaryUpdatedAt, timeZone),
      workCell(task.work.counts),
      blockersCell(task.blockers),
      `${task.execution.status} / ${task.execution.owner}`,
      deliveryCell(task.remoteDelivery),
      nextCell(task.next)
    ]),
    width
  );
  if (!options.verbose) return `${output}\n`;
  return `${output}\n\n${renderVerboseDetails(result.tasks, timeZone)}\n`;
}

function buildTaskOverviewEntry(
  task: Task,
  store: TaskStore,
  now: Date,
  runtimeHealthPolicy: ReturnType<typeof resolveRuntimeHealth>
): TaskOverview {
  const brief = store.getTaskBrief(task.id);
  const roles = store.listRoles(task.id);
  const leaderRole = roles.find((role) => role.name === "leader") ?? null;
  const workItems = store.listWorkItems(task.id);
  const inputRequests = store.listInputRequests(task.id);
  const openInputRequests = inputRequests.filter((request) => request.status === "open");
  const turns = store.listTurns(task.id);
  const events = store.listEvents(task.id);
  const leaderFailure = store.getLeaderFailure(task.id);
  const leaderMailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" });
  const pendingWakeup = pendingWakeupProjection(leaderMailbox);
  const reviewRounds = store.listReviewRounds(task.id);
  const changeSets = store.listChangeSets(task.id);
  const integrations = store.listIntegrationAttempts(task.id);
  const roleSessions = roles.flatMap((role) => {
    const session = store.getRoleSession(task.id, role.name);
    return session === null ? [] : [{ roleName: role.name, ...session }];
  });
  const attention = collectAttention(
    task,
    turns,
    events,
    leaderFailure
  );
  const blockers = collectBlockers(workItems, openInputRequests, attention);
  const leader: TaskOverviewLeader = {
    role: "leader",
    roleStatus: leaderRole === null
      ? "missing"
      : turns.some((run) => run.roleName === "leader" && run.status === "active")
        ? "running"
        : roleSessions.find((session) => session.roleName === "leader")?.status ?? "idle",
    summary: brief?.leaderSummary ?? null,
    currentFocus: brief?.currentFocus ?? null,
    updatedAt: brief?.updatedAt ?? null,
    updatedBy: brief?.updatedBy ?? null,
    summaryStatus: brief === null ? "missing" : "available"
  };
  const counts = countWorkItems(workItems);
  const runtimeTurns = turns
    .filter((run) => run.status === "active")
    .map((run): TaskOverviewRuntimeTurn => ({
      id: run.id,
      roleName: run.roleName,
      status: run.status,
      runtime: roleSessions.some((session) => (
        session.roleName === run.roleName
        && session.agentId === run.effective.agentId
        && session.status !== "ended"
      )) ? "session-active" : "starting",
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    }));
  const runtime: TaskOverviewRuntime = {
    activeTurns: runtimeTurns,
    activeTurnCount: runtimeTurns.length,
    pendingDeliveryCount: runtimeTurns.filter((run) => run.runtime === "starting").length
  };
  // Fold the execution projection from the facts already read above instead of
  // reading the store a second time for the same unchanged revision.
  const execution = projectTaskExecutionFromFacts({
    task,
    roles,
    turns,
    workItems,
    inputRequests,
    reviewRounds,
    changeSets,
    integrations,
    events,
    brief,
    pendingWakeup,
    leaderMailbox,
    leaderFailure,
    roleSessions,
    contextSnapshots: store.listContextSnapshots(task.id),
    now,
    runtimeHealthPolicy
  });
  const nextActionFacts = store.readNextActionFacts(task.id);
  if (nextActionFacts === null) {
    throw new Error(`Task disappeared while building its overview: ${task.id}.`);
  }
  const next = overviewNextAction(
    task,
    workItems,
    execution,
    projectNextAction({
      ...nextActionFacts,
      currentTaskReviewCandidate: null,
      executionGroups: execution.executionGroups
    })
  );
  const persistedCandidate = task.status === "active" || task.status === "retired"
    ? taskRemoteDeliveryCandidate(task)
    : null;
  const remoteDelivery = projectTaskRemoteDeliveryFromStore(
    store,
    task,
    persistedCandidate
  );
  return {
    ...task,
    brief,
    leader,
    leaderSummary: leader.summary,
    currentFocus: leader.currentFocus,
    summaryUpdatedAt: leader.updatedAt,
    summaryUpdatedBy: leader.updatedBy,
    summaryStatus: leader.summaryStatus,
    work: { counts, items: workItems },
    input: { open: openInputRequests, openCount: openInputRequests.length },
    attention,
    attentionCount: attention.length,
    blockers,
    next,
    nextAction: next?.action ?? null,
    nextOwner: next?.owner ?? null,
    runtime,
    execution,
    remoteDelivery
  };
}

function collectAttention(
  task: Task,
  turns: readonly Turn[],
  events: readonly TaskEvent[],
  failure: LeaderFailure | null
): TaskOverviewAttention[] {
  const items: TaskOverviewAttention[] = [];
  if (failure !== null) {
    items.push({
      kind: "leader-recovery",
      id: `leader-recovery:${task.id}`,
      status: "failed",
      owner: "operator",
      summary: failure.message,
      updatedAt: failure.lastFailedAt
    });
  }
  for (const turn of turns) {
    if (
      turn.roleName !== "leader"
      || turn.status !== "active"
      || !isRoleTurnStalled(events, turn.id)
    ) continue;
    const progressAt = latestStallProgressAt(events, turn.id) ?? turn.updatedAt;
    items.push({
      kind: "leader-stalled",
      id: `leader-stall:${turn.id}:${progressAt}`,
      status: "needs-attention",
      owner: "operator",
      summary: `Turn ${turn.id} for ${turn.roleName} has no durable progress after ${progressAt}.`,
      updatedAt: progressAt,
      turnId: turn.id,
      roleName: turn.roleName
    });
  }
  return items.sort((left, right) => (
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
    || left.id.localeCompare(right.id)
  ));
}

function collectBlockers(
  workItems: readonly WorkItem[],
  openInputRequests: readonly InputRequest[],
  attention: readonly TaskOverviewAttention[]
): TaskOverviewBlocker[] {
  const blockers: TaskOverviewBlocker[] = [];
  const workById = new Map(workItems.map((item) => [item.id, item]));
  for (const item of workItems) {
    if (item.status === "failed") {
      blockers.push({
        kind: "work",
        type: "work",
        id: item.id,
        status: item.status,
        owner: item.assignee ?? "leader",
        action: "review-failed-work",
        summary: item.outcome ?? `Work Item ${item.id} failed.`
      });
      continue;
    }
    if (item.status === "awaiting_acceptance") {
      blockers.push({
        kind: "work",
        type: "work",
        id: item.id,
        status: item.status,
        owner: "leader",
        action: "accept-work-item",
        summary: `Work Item ${item.id} is awaiting Leader acceptance.`
      });
      continue;
    }
    if (item.status !== "pending") continue;
    const dependencies = item.dependsOn.filter((dependency) => (
      workById.get(dependency)?.status !== "completed"
    ));
    if (dependencies.length === 0) continue;
    blockers.push({
      kind: "work",
      type: "work",
      id: item.id,
      status: item.status,
      owner: item.assignee ?? "leader",
      action: "unblock-work-item",
      summary: `Work Item ${item.id} is waiting on ${dependencies.join(", ")}.`
    });
  }
  for (const request of openInputRequests) {
    blockers.push({
      kind: "input",
      type: "input",
      id: request.id,
      status: request.status,
      owner: "user",
      action: "answer-input",
      summary: request.question,
      blockedRefs: request.blockedRefs
    });
  }
  for (const item of attention) {
    blockers.push({
      kind: "attention",
      type: "attention",
      id: item.id,
      status: item.status,
      owner: item.owner,
      action: item.kind === "leader-recovery"
        ? "inspect-leader-recovery"
        : "inspect-leader-stall",
      summary: item.summary
    });
  }
  return blockers;
}

function overviewNextAction(
  task: Task,
  workItems: readonly WorkItem[],
  execution: TaskExecutionProjection,
  action: NextAction
): TaskOverviewNext | null {
  if (task.status !== "active" && task.status !== "draft") return null;
  const primary = action.refs[0];
  const workItem = action.refs
    .filter(({ kind }) => kind === "work-item")
    .map(({ id }) => workItems.find((item) => item.id === id))
    .find((item): item is WorkItem => item !== undefined);
  const kind: TaskOverviewNext["kind"] = primary?.kind === "input-request"
    ? "input"
    : primary?.kind === "work-item"
      ? "work"
      : action.kind.includes("attention") || action.kind.includes("inconsistency")
        ? "attention"
        : "execution";
  return {
    action: action.kind,
    owner: action.kind === "resolve-input"
      ? "user"
      : workItem?.assignee ?? execution.owner,
    kind,
    ...(primary === undefined ? {} : { id: primary.id }),
    summary: action.reason
  };
}

function countWorkItems(items: readonly WorkItem[]): TaskOverviewWorkCounts {
  const counts: Record<WorkItemStatus, number> & { total: number } = {
    total: items.length,
    pending: 0,
    running: 0,
    awaiting_acceptance: 0,
    completed: 0,
    failed: 0,
    retired: 0
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function leaderCell(task: TaskOverview): string {
  const status = task.leader.roleStatus;
  if (task.leader.summaryStatus === "missing") return `${status} · missing summary`;
  const values = [task.leader.summary, task.leader.currentFocus]
    .filter((value): value is string => value !== null && value.length > 0);
  return values.length === 0
    ? `${status} · summary unavailable`
    : compactText(`${status} · ${values.join(" · ")}`);
}

function workCell(counts: TaskOverviewWorkCounts): string {
  if (counts.total === 0) return "none";
  const details = (Object.keys(counts) as (keyof TaskOverviewWorkCounts)[])
    .filter((status): status is WorkItemStatus => status !== "total" && counts[status] > 0)
    .map((status) => `${status}:${counts[status]}`);
  return `${counts.total} total${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
}

function blockersCell(blockers: readonly TaskOverviewBlocker[]): string {
  if (blockers.length === 0) return "none";
  return blockers.map((blocker) => `${blocker.kind}:${blocker.id}`).join(", ");
}

function nextCell(next: TaskOverviewNext | null): string {
  return next === null ? "—" : `${next.action} / ${next.owner}`;
}

function deliveryCell(delivery: TaskRemoteDelivery): string {
  if (delivery.status === "none") return "none";
  return `${delivery.status} · ${delivery.mergedProjectCount}/${delivery.codeProjectCount} merged`
    + (delivery.allMerged
      ? ` · ${delivery.verifiedProjectCount}/${delivery.codeProjectCount} verified`
      : "");
}

function taskRemoteDeliveryCandidate(
  task: Task
): Readonly<{ projects: readonly Readonly<{ projectId: string; commit: string }>[] }> | null {
  const projects = task.projectBindings.flatMap(({ projectId, currentCommit }) => (
    currentCommit === undefined ? [] : [{ projectId, commit: currentCommit }]
  ));
  return projects.length === task.projectBindings.length
    ? { projects }
    : null;
}

function compactText(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= 240 ? oneLine : `${oneLine.slice(0, 237)}...`;
}

function renderVerboseDetails(
  tasks: readonly TaskOverview[],
  timeZone: unknown
): string {
  return [
    "Task details",
    ...tasks.flatMap((task) => [
      `${task.id}: ${task.title}`,
      `  Description: ${task.description ?? "—"}`,
      `  Current focus: ${task.currentFocus ?? "missing"}`,
      `  Leader summary: ${task.leaderSummary ?? "missing"}`,
      `  Summary updated by: ${task.summaryUpdatedBy ?? "unknown"}`,
      `  Summary updated at: ${task.summaryUpdatedAt === null
        ? "missing"
        : formatTimestamp(task.summaryUpdatedAt, timeZone)}`,
      `  Execution: ${task.execution.status} (${task.execution.owner}); ${task.execution.summary}`,
      `  Remote delivery: ${deliveryCell(task.remoteDelivery)}; source=${task.remoteDelivery.source}${task.remoteDelivery.provisional ? " (provisional)" : ""}`,
      `  Monitoring: ${task.execution.monitoring}; attention: ${task.execution.attention.length}`,
      `  DAG: ${task.execution.observability.dag.nodes.length} nodes, ${task.execution.observability.dag.edges.length} edges; ready=${task.execution.observability.dag.readyIds.join(", ") || "none"}; blocked=${task.execution.observability.dag.blockedIds.join(", ") || "none"}`,
      `  Cost: tokens=${task.execution.observability.cost.tokens}${task.execution.observability.cost.tokensObservable ? "" : " (partial)"}; tools=${task.execution.observability.cost.toolCalls}${task.execution.observability.cost.toolCallsObservable ? "" : " (partial)"}; wall=${task.execution.observability.cost.wallClockSeconds}s; retries=${task.execution.observability.cost.retryCount}`,
      `  Context: snapshots=${task.execution.observability.context.snapshotCount}; bytes=${task.execution.observability.context.totalBytes ?? "partial"}; compression=unavailable`,
      `  Session tokens: ${task.execution.observability.sessionTokens.length === 0
        ? "unobserved"
        : task.execution.observability.sessionTokens.map(({ roleName, metrics }) => {
            const total = metrics.cumulativeTotal.status === "observed"
              ? metrics.cumulativeTotal.totalTokens
              : "unobserved";
            const maximum = metrics.maximumRequestInput.status === "observed"
              ? metrics.maximumRequestInput.inputTokens
              : "unobserved";
            return `${roleName}: total=${total}, max-request-input=${maximum}`;
          }).join("; ")}`,
      `  Projects: ${task.projectBindings.length === 0
        ? "none"
        : task.projectBindings.map(({ directory, projectId, baseRef }) => (
            `${directory} (${projectId} @ ${baseRef})`
          )).join(", ")}`
    ])
  ].join("\n");
}
