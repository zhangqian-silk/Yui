import { createHash } from "node:crypto";
import type { AgentRun } from "../run/agentRun.js";
import type { Task, TaskStatus } from "../task/task.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import {
  isDurableJobTerminal,
  type DurableJob
} from "../job/durableJob.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { TaskMessage } from "../message/message.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";

/**
 * Machine-derived disposition of a terminal Leader Run. The Scheduler uses it
 * (together with the observed digest) to decide whether a later scan brings
 * any new actionable fact.
 */
export type LeaderRunDisposition = "progress" | "waiting" | "blocked" | "completed";

/** Optional structured wait reference recorded on a waiting/blocked Leader Run. */
export type LeaderWaitReason = Readonly<{
  kind: string;
  ref?: string;
}>;

/**
 * One normalized actionable fact. `key` is a stable identity; `value` changes
 * only when the underlying durable fact changes. Progress/heartbeat noise is
 * deliberately excluded so repeated scans of an unchanged wait produce an
 * identical digest.
 */
export type ActionabilityFact = Readonly<{
  key: string;
  value: string;
}>;

export type ActionabilityDigestInput = Readonly<{
  taskId: string;
  taskStatus: TaskStatus;
  facts: readonly ActionabilityFact[];
}>;

/**
 * Canonical SHA-256 digest over the normalized actionable facts. Pure and
 * deterministic: the same facts always produce the same digest regardless of
 * collection order.
 */
export function computeActionabilityDigest(input: ActionabilityDigestInput): string {
  const facts = [...input.facts]
    .map((fact) => ({ key: fact.key, value: fact.value }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const canonical = JSON.stringify({
    taskId: input.taskId,
    taskStatus: input.taskStatus,
    facts
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Read-only store surface needed to fold a Task's actionable facts. Every
 * method is optional except `getTask` and `listAgentRuns`; absent families are
 * treated as empty (conservative: fewer facts means a coarser digest, and the
 * fail-open rule covers computation errors).
 */
export type ActionabilityReadStore = Readonly<{
  getTask(taskId: string): Task | null;
  listAgentRuns(taskId: string): readonly AgentRun[];
  listActiveTaskIds?(): readonly string[];
  listWorkItems?(taskId: string): readonly WorkItem[];
  listReviewRounds?(taskId: string): readonly ReviewRound[];
  listIntegrationAttempts?(taskId: string): readonly IntegrationAttempt[];
  listDurableJobs?(taskId: string): readonly DurableJob[];
  listInputRequests?(taskId: string): readonly InputRequest[];
  listMessages?(taskId: string): readonly TaskMessage[];
  listEvents?(taskId: string): readonly TaskEvent[];
}>;

const TERMINAL_WORK_ITEM_STATUSES = new Set(["completed", "retired"]);
const CONSUMED_INTEGRATION_STATUSES = new Set(["committed", "superseded"]);

/**
 * Fold a Task's durable records into the normalized actionable facts. This
 * function only reads; it never starts a Controller, queues a wake, writes a
 * Message, or mutates any record.
 *
 * Included facts (each changes only when the durable record changes):
 * - Active Runs: the ownership/liveness picture. A Run starting or ending
 *   changes the digest so a lost executor is detected.
 * - Non-terminal/failed WorkItems: pending, running, awaiting-acceptance, and
 *   failed items still need Leader or Worker action.
 * - Non-completed ReviewRounds: pending/running/failed rounds still need
 *   Leader disposition or a Reviewer.
 * - Unresolved IntegrationAttempts: running/validating/blocked/failed attempts
 *   the Leader may need to resolve.
 * - Terminal DurableJobs: new terminal results the Leader should observe.
 * - InputRequests: open and answered/cancelled requests.
 * - User directives explicitly marked `wakePolicy=leader`.
 *
 * Excluded: pure revision growth, progress/heartbeat events, repeated scans of
 * an unchanged blocker, read-only status requests, and waits already owned by
 * an active Worker/Reviewer/Job (the active-Run facts above capture ownership).
 */
export function collectTaskActionability(
  store: ActionabilityReadStore,
  taskId: string,
  now = new Date()
): ActionabilityDigestInput {
  const task = store.getTask(taskId);
  if (task === null) {
    throw new Error(`Task not found for actionability projection: ${taskId}.`);
  }
  const facts: ActionabilityFact[] = [];

  const events = store.listEvents?.(taskId) ?? [];
  for (const run of operationalTaskRecords(
    store.listAgentRuns(taskId),
    events,
    "agent-run"
  ).filter((candidate) => candidate.status === "active")) {
    facts.push({
      key: `active-run:${run.id}`,
      value: [
        run.roleName,
        run.workItemId ?? "",
        run.reviewRoundId ?? "",
        run.updatedAt
      ].join("|")
    });
  }

  const workItems = store.listWorkItems?.(taskId) ?? [];
  const reviewRounds = store.listReviewRounds?.(taskId) ?? [];
  for (const item of workItems) {
    if (TERMINAL_WORK_ITEM_STATUSES.has(item.status)) continue;
    facts.push({
      key: `work-item:${item.id}`,
      value: `${item.status}|${item.updatedAt}`
    });
    for (const group of item.executionGroups) {
      if (group.resolution !== undefined || group.stage?.resources === undefined) continue;
      facts.push({
        key: `resource-deadline:${group.id}`,
        value: now.getTime() >= Date.parse(group.stage.resources.deadlineAt)
          ? "reached"
          : "open"
      });
    }
  }

  // A Resource-Broker-queued Lane is durable but deliberately has no active
  // Run. Include the global active Lane capacity counts only for Tasks that are
  // actually queued, so capacity release changes their digest and the normal
  // orphan repair can wake the Leader without polling or a second scheduler.
  const hasQueuedResourceLane = [
    ...workItems.flatMap(({ executionGroups }) => executionGroups),
    ...reviewRounds.flatMap(({ executionGroup }) => (
      executionGroup === undefined ? [] : [executionGroup]
    ))
  ].some((group) => (
    group.resolution === undefined
    && group.lanes.some((lane) => (
      lane.status === "pending"
      && lane.effective !== undefined
      && lane.runId === undefined
    ))
  ));
  if (hasQueuedResourceLane && store.listActiveTaskIds !== undefined) {
    const activeResourceScopes = store.listActiveTaskIds().flatMap((activeTaskId) => (
      operationalTaskRecords(
        store.listAgentRuns(activeTaskId),
        store.listEvents?.(activeTaskId) ?? [],
        "agent-run"
      ).flatMap((run) => (
        run.status !== "active"
        || run.executionGroupId === undefined
        || run.executionLaneId === undefined
          ? []
          : [
              "home",
              `task:${activeTaskId}`,
              ...(run.workItemId === undefined
                ? []
                : [`work-item:${activeTaskId}/${run.workItemId}`]),
              `group:${activeTaskId}/${run.executionGroupId}`,
              `provider:${run.effective.adapterId}`,
              `agent:${run.effective.agentId}`,
              `model:${run.effective.adapterId}/${run.effective.model ?? "default"}`
            ]
      ))
    ));
    const activeResourceCounts = new Map<string, number>();
    for (const scope of activeResourceScopes) {
      activeResourceCounts.set(scope, (activeResourceCounts.get(scope) ?? 0) + 1);
    }
    facts.push({
      key: "resource-broker:active-capacity",
      value: [...activeResourceCounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([scope, count]) => `${scope}=${count}`)
        .join("|")
    });
  }

  for (const round of reviewRounds) {
    if (round.status === "completed") continue;
    facts.push({
      key: `review:${round.id}`,
      value: `${round.status}|${round.endedAt ?? round.createdAt}`
    });
  }

  for (const attempt of store.listIntegrationAttempts?.(taskId) ?? []) {
    if (CONSUMED_INTEGRATION_STATUSES.has(attempt.status)) continue;
    facts.push({
      key: `integration:${attempt.id}`,
      value: `${attempt.status}|${attempt.updatedAt}`
    });
  }

  for (const job of store.listDurableJobs?.(taskId) ?? []) {
    if (!isDurableJobTerminal(job.status)) continue;
    facts.push({
      key: `durable-job:${job.id}`,
      value: `${job.status}|${job.terminalAt ?? job.updatedAt}`
    });
  }

  for (const request of store.listInputRequests?.(taskId) ?? []) {
    facts.push({
      key: `input:${request.id}`,
      value: `${request.status}|${request.updatedAt}`
    });
  }

  for (const message of operationalTaskRecords(
    store.listMessages?.(taskId) ?? [],
    events,
    "message"
  )) {
    if (message.wakePolicy !== "leader") continue;
    facts.push({
      key: `directive:${message.id}`,
      value: message.createdAt
    });
  }

  return { taskId, taskStatus: task.status, facts };
}

/**
 * Derive the Leader Run disposition from the Task execution projection status.
 * This is machine-derived at yield time so the Scheduler does not depend on
 * free-text Leader summaries.
 */
export function deriveLeaderRunDisposition(
  projectionStatus: string,
  taskStatus: TaskStatus
): LeaderRunDisposition {
  if (taskStatus !== "active") return "completed";
  switch (projectionStatus) {
    case "blocked":
      return "blocked";
    case "waiting-on-agents":
    case "waiting-user":
      return "waiting";
    case "completed":
    case "retired":
    case "archived":
      return "completed";
    default:
      return "progress";
  }
}

/**
 * Decision for one `task-orphaned` admission check.
 *
 * - `wake`: the digest changed (or no prior observation exists); queue one wake.
 * - `suppress`: the last Leader Run observed the same digest while
 *   waiting/blocked; stay silent and write nothing.
 */
export type OrphanWakeDecision =
  | Readonly<{ kind: "wake"; digest: string }>
  | Readonly<{ kind: "suppress"; digest: string; observedDigest: string }>;

/**
 * Decide whether a `task-orphaned` scan should create a new Leader Run.
 *
 * Suppression applies only when the last Leader Run ended `waiting` or
 * `blocked` and its `observedActionabilityDigest` equals the current digest.
 * A `progress`/`completed` disposition, a missing digest, or a changed digest
 * always wakes. Computation errors fail open.
 */
export function decideOrphanWake(input: Readonly<{
  currentDigest: string;
  lastLeaderRun: Pick<AgentRun, "status" | "disposition" | "observedActionabilityDigest"> | null;
}>): OrphanWakeDecision {
  const { currentDigest, lastLeaderRun } = input;
  if (lastLeaderRun === null) return { kind: "wake", digest: currentDigest };
  if (lastLeaderRun.status === "active") return { kind: "wake", digest: currentDigest };
  const disposition = lastLeaderRun.disposition;
  if (disposition !== "waiting" && disposition !== "blocked") {
    return { kind: "wake", digest: currentDigest };
  }
  const observed = lastLeaderRun.observedActionabilityDigest;
  if (observed === undefined) return { kind: "wake", digest: currentDigest };
  if (observed === currentDigest) {
    return { kind: "suppress", digest: currentDigest, observedDigest: observed };
  }
  return { kind: "wake", digest: currentDigest };
}
