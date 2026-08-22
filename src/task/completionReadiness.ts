import type { DurableJob } from "../job/durableJob.js";
import type { IntegrationQueueEntry } from "../integration/integrationQueueEntry.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import { isReviewFindingBlocking, type ReviewFinding } from "../review/reviewFinding.js";
import { deltaRecheckBlocksAcceptance } from "../review/reviewRound.js";
import type { ReviewFindingLedgerMode } from "../review/reviewFindingLedger.js";
import {
  REVIEW_FINDINGS_RECONCILE_FAILED_EVENT,
  reviewFindingLedgerWriteFailedFromEvents
} from "../review/reviewFindingLedger.js";
import { blockingProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { NextActionFacts, NextActionRef } from "./nextAction.js";

/**
 * Issue 06 (Task terminalization readiness): a pure, read-only projection of
 * every blocker that prevents `yui task complete` from producing a durable
 * `task.completed` receipt.  `task next-action`, the CLI/Web presentation, and
 * the transactional `task complete` path all share this one rule set so the
 * Leader never has to discover completion preconditions by trial and error.
 *
 * The projection is deliberately pure: it derives every blocker from records
 * that already exist.  It never starts a Controller, writes a record, or
 * performs a Git inspection.  The transactional completion path re-derives
 * the same readiness while holding the store write fence, so a state change
 * between the read-only projection and the mutation fails closed with the
 * fresh blocker list.
 */

export type CompletionBlockerCode =
  | "active-task-review"
  | "open-input-request"
  | "incomplete-work-item"
  | "active-durable-job"
  | "integration-evidence-missing"
  | "unresolved-integration"
  | "unsettled-integration-queue-entry"
  | "blocking-provider-continuation"
  | "work-item-workspace-undisposed"
  | "review-workspace-undisposed"
  | "integration-workspace-undisposed"
  | "execution-lane-workspace-undisposed"
  | "active-run"
  | "open-review-finding"
  | "finding-ledger-unavailable"
  | "delta-recheck-not-accepted";

export type CompletionBlocker = Readonly<{
  /** Stable machine-readable code; callers may key on it. */
  code: CompletionBlockerCode;
  /** Exact record ID that owns the blocker. */
  ref: NextActionRef;
  /** Human-readable reason. */
  reason: string;
  /** Minimal repair action (CLI command or instruction). */
  fix: string;
}>;

export type CompletionReadiness = Readonly<{
  taskId: string;
  ready: boolean;
  /** All blockers, stably sorted by (code, ref.kind, ref.id). */
  blockers: readonly CompletionBlocker[];
}>;

/**
 * The durable records the readiness projection needs beyond the base
 * next-action facts.  Kept as a distinct type so the lightweight
 * `readNextActionFacts` path (delivery guard, context) does not pay for the
 * extra reads on every command.
 */
export type CompletionReadinessFacts = NextActionFacts & Readonly<{
  managedWorkspaces: readonly ManagedWorkspace[];
  durableJobs: readonly DurableJob[];
  integrationQueueEntries: readonly IntegrationQueueEntry[];
  reviewFindings: readonly ReviewFinding[];
  reviewFindingLedgerMode: ReviewFindingLedgerMode;
  events: readonly TaskEvent[];
}>;

const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "running",
  "unknown-needs-attention"
]);

const UNRESOLVED_INTEGRATION_STATUSES = new Set([
  "running",
  "blocked",
  "validating"
]);

const TERMINAL_REVIEW_STATUSES = new Set(["completed", "failed"]);
const TERMINAL_LANE_STATUSES = new Set(["completed", "failed", "yielded"]);

export type CompletionReadinessOptions = Readonly<{
  /**
   * Whether to enforce the Review finding ledger gate.  The completion
   * preflight runs before `prepareFinalTaskReview`, which may create the
   * Task-final Review that resolves `fixed-pending-review` findings; it passes
   * `false` and lets the transactional path enforce the gate after Review
   * preparation.  Read-only projections (next-action) pass `true` (the
   * default) so the Leader sees every blocker.
   */
  findingsGate?: boolean;
}>;

export function projectCompletionReadiness(
  facts: CompletionReadinessFacts,
  options: CompletionReadinessOptions = {}
): CompletionReadiness {
  const blockers: CompletionBlocker[] = [];
  const { task } = facts;
  const findingsGate = options.findingsGate ?? true;

  // A pending/running Task-final Review must be resumed or blocked first.
  for (const round of facts.reviewRounds) {
    if ((round.scope ?? "work-item") !== "task") continue;
    if (round.status !== "pending" && round.status !== "running") continue;
    blockers.push({
      code: "active-task-review",
      ref: ref("review-round", round.id),
      reason: `Task-final ReviewRound ${round.id} is ${round.status}.`,
      fix: round.status === "pending"
        ? `yui task review retry ${task.id}/${round.id}`
        : `wait for Reviewer Run on ${round.id} to finish`
    });
  }

  // Issue 07: a completed delta-recheck that did not accept the head keeps the
  // completion gate closed.  `requires-full-review` escalates to a full Review;
  // `finding` stays a blocker for the Leader to repair.
  for (const round of facts.reviewRounds) {
    if (!deltaRecheckBlocksAcceptance(round)) continue;
    const disposition = round.deltaRecheck!.disposition!;
    blockers.push({
      code: "delta-recheck-not-accepted",
      ref: ref("review-round", round.id),
      reason: `Delta-recheck ${round.id} disposition is ${disposition}; the head is not accepted.`,
      fix: disposition === "requires-full-review"
        ? `yui task review request ${task.id} --role <global-role>`
        : `repair the finding and request a new Task-final Review`
    });
  }

  // Open Input requests block protocol convergence.
  for (const request of facts.openInputRequests) {
    blockers.push({
      code: "open-input-request",
      ref: ref("input-request", request.id),
      reason: `Input request ${request.id} is open.`,
      fix: `yui task input answer ${task.id}/${request.id}`
    });
  }

  // Every Work Item must be terminal (completed or retired).
  for (const item of facts.workItems) {
    if (item.status === "completed" || item.status === "retired") continue;
    blockers.push({
      code: "incomplete-work-item",
      ref: ref("work-item", item.id),
      reason: `Work Item ${item.id} is ${item.status}.`,
      fix: item.status === "failed"
        ? `yui task work update ${task.id}/${item.id} running`
        : `complete or retire Work Item ${item.id}`
    });
  }

  // Active DurableJobs (integration checks, etc.) must settle.
  for (const job of facts.durableJobs) {
    if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
    if (job.status === "unknown-needs-attention" && job.acknowledgedAt !== undefined) continue;
    blockers.push({
      code: "active-durable-job",
      ref: ref("durable-job", job.id),
      reason: `DurableJob ${job.id} is ${job.status}.`,
      fix: `wait for DurableJob ${job.id} to finish, or cancel it`
    });
  }

  // requireIntegration Tasks need the full evidence chain.
  if (task.requireIntegration === true) {
    if (facts.workItems.length === 0) {
      blockers.push({
        code: "integration-evidence-missing",
        ref: ref("task", task.id),
        reason: `Task ${task.id} requires at least one WorkItem before completion.`,
        fix: `yui task work create ${task.id} "<objective>"`
      });
    }
    if (facts.changeSets.length === 0) {
      blockers.push({
        code: "integration-evidence-missing",
        ref: ref("task", task.id),
        reason: `Task ${task.id} requires at least one ChangeSet before completion.`,
        fix: `yui task work capture ${task.id}/<work-item>`
      });
    }
    if (!facts.integrations.some(({ status }) => status === "committed")) {
      blockers.push({
        code: "integration-evidence-missing",
        ref: ref("task", task.id),
        reason: `Task ${task.id} requires a committed Integration Attempt before completion.`,
        fix: `yui task integration start ${task.id} --project <project> --change-set <change-set>`
      });
    }
  }

  // Unresolved Integration Attempts must settle.
  for (const integration of facts.integrations) {
    if (!UNRESOLVED_INTEGRATION_STATUSES.has(integration.status)) continue;
    blockers.push({
      code: "unresolved-integration",
      ref: ref("integration-attempt", integration.id),
      reason: `Integration Attempt ${integration.id} is ${integration.status}.`,
      fix: `yui task integration continue ${task.id}/${integration.id}`
    });
  }

  // Unsettled integration queue entries must commit or be superseded.
  for (const entry of facts.integrationQueueEntries) {
    if (entry.status === "committed" || entry.status === "superseded") continue;
    blockers.push({
      code: "unsettled-integration-queue-entry",
      ref: ref("integration-queue-entry", entry.id),
      reason: `Integration queue entry ${entry.id} is ${entry.status}.`,
      fix: `settle integration queue entry ${entry.id} (continue or supersede)`
    });
  }

  // Provider continuations that may still write the Workspace.
  for (const continuation of blockingProviderContinuations(facts.events)) {
    const identity = continuation.identity;
    blockers.push({
      code: "blocking-provider-continuation",
      ref: ref("provider-continuation", identity.continuationId),
      reason: `Provider continuation ${identity.continuationId} (run ${continuation.runId}) `
        + "may still write the Workspace or has an identity conflict.",
      fix: `wait for or recover the Provider turn on run ${continuation.runId}`
    });
  }

  // Undisposed managed workspaces.  The Task-owned main workspace is excluded
  // (it is cleaned at archive, not at completion).
  for (const workspace of facts.managedWorkspaces) {
    const blocker = workspaceBlocker(facts, task.id, workspace);
    if (blocker !== null) blockers.push(blocker);
  }

  // Active non-Leader Runs must finish.  The Leader's own Run is terminalized
  // by the completion transaction itself, so it is not a readiness blocker.
  for (const run of facts.activeRuns) {
    if (run.roleName === "leader") continue;
    blockers.push({
      code: "active-run",
      ref: ref("agent-run", run.id),
      reason: `Role ${run.roleName} has an active Run ${run.id}.`,
      fix: `wait for Run ${run.id} to yield or fail`
    });
  }

  // Review finding ledger gate (enforce mode only).
  // The transactional completion path runs this gate after final-review
  // preparation: a pending/running Task-final Review is expected to resolve
  // `fixed-pending-review` findings, so the gate only blocks when no Review
  // is active.  Mirror that timing here so the projection never blocks a
  // completion attempt that is about to request the resolving Review.
  const activeTaskReview = facts.reviewRounds.some((round) => (
    (round.scope ?? "work-item") === "task"
    && (round.status === "pending" || round.status === "running")
  ));
  if (findingsGate && facts.reviewFindingLedgerMode === "enforce" && !activeTaskReview) {
    if (reviewFindingLedgerWriteFailedFromEvents(facts.events)) {
      blockers.push({
        code: "finding-ledger-unavailable",
        ref: ref("task", task.id),
        reason: "The Review finding ledger was unavailable while reconciling a semantic Review.",
        fix: "recover the ledger and reconcile the Round before completing the Task"
      });
    }
    for (const finding of facts.reviewFindings) {
      if (!isReviewFindingBlocking(finding)) continue;
      blockers.push({
        code: "open-review-finding",
        ref: ref("review-finding", finding.id),
        reason: `Open ${finding.severity.toUpperCase()} finding ${finding.id} is undispositioned.`,
        fix: `yui task review finding dispose ${task.id}/${finding.id}`
      });
    }
  }

  const sorted = [...blockers].sort((left, right) => {
    const codeOrder = left.code.localeCompare(right.code);
    if (codeOrder !== 0) return codeOrder;
    const kindOrder = left.ref.kind.localeCompare(right.ref.kind);
    if (kindOrder !== 0) return kindOrder;
    return left.ref.id.localeCompare(right.ref.id, undefined, { numeric: true });
  });

  return { taskId: task.id, ready: sorted.length === 0, blockers: sorted };
}

function workspaceBlocker(
  facts: CompletionReadinessFacts,
  taskId: string,
  workspace: ManagedWorkspace
): CompletionBlocker | null {
  const owner = workspace.owner;
  switch (owner.type) {
    case "task":
      // The Task main workspace is cleaned at archive, not completion.
      return null;
    case "work-item": {
      // The preflight has always blocked on WorkItem workspaces.  Project the
      // blocker regardless of the Work Item status: if the item is still open
      // the incomplete-work-item blocker fires too, and once it is terminal
      // the workspace is the exact cleanup target.
      return {
        code: "work-item-workspace-undisposed",
        ref: ref("work-item", owner.workItemId),
        reason: `Work Item ${owner.workItemId} has an isolated workspace that is not disposed.`,
        fix: `yui task work cleanup ${taskId}/${owner.workItemId} --integrated|--abandon`
      };
    }
    case "review-round": {
      const round = facts.reviewRounds.find((entry) => entry.id === owner.reviewRoundId);
      // A workspace for a still-active Review is covered by the
      // active-task-review / wait-for-owned-execution path; only project the
      // cleanup blocker once the Round is terminal.
      if (round !== undefined && !TERMINAL_REVIEW_STATUSES.has(round.status)) return null;
      return {
        code: "review-workspace-undisposed",
        ref: ref("review-round", owner.reviewRoundId),
        reason: `ReviewRound ${owner.reviewRoundId} is terminal but its workspace is not cleaned up.`,
        fix: `yui task work review cleanup ${taskId}/${owner.reviewRoundId}`
      };
    }
    case "integration-attempt": {
      const integration = facts.integrations.find(
        (entry) => entry.id === owner.integrationAttemptId
      );
      if (integration !== undefined && UNRESOLVED_INTEGRATION_STATUSES.has(integration.status)) {
        return null;
      }
      return {
        code: "integration-workspace-undisposed",
        ref: ref("integration-attempt", owner.integrationAttemptId),
        reason: `Integration Attempt ${owner.integrationAttemptId} is terminal but its workspace is not cleaned up.`,
        fix: `retry or continue Integration ${owner.integrationAttemptId} so its workspace is reclaimed`
      };
    }
    case "execution-lane": {
      const lane = findExecutionLane(facts, owner.executionGroupId, owner.executionLaneId);
      if (lane !== undefined && !TERMINAL_LANE_STATUSES.has(lane.status)) return null;
      return {
        code: "execution-lane-workspace-undisposed",
        ref: ref("execution-lane", `${owner.executionGroupId}/${owner.executionLaneId}`),
        reason: `Execution Lane ${owner.executionGroupId}/${owner.executionLaneId} `
          + "is terminal but its workspace is not cleaned up.",
        fix: `clean up Execution Lane ${owner.executionGroupId}/${owner.executionLaneId}`
      };
    }
  }
}

function findExecutionLane(
  facts: CompletionReadinessFacts,
  groupId: string,
  laneId: string
): { status: string } | undefined {
  for (const item of facts.workItems) {
    const group = item.executionGroups?.find((entry) => entry.id === groupId);
    const lane = group?.lanes.find((entry) => entry.id === laneId);
    if (lane !== undefined) return lane;
  }
  for (const round of facts.reviewRounds) {
    const group = round.executionGroup;
    if (group?.id !== groupId) continue;
    const lane = group.lanes.find((entry) => entry.id === laneId);
    if (lane !== undefined) return lane;
  }
  return undefined;
}

function ref(kind: string, id: string): NextActionRef {
  return { kind, id };
}
