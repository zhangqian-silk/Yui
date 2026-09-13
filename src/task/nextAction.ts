import { createHash } from "node:crypto";

import type { AgentRun } from "../agentRun/agentRun.js";
import {
  actionableExecutionLaneRecoveries,
  type ActionableExecutionLaneRecovery,
  type ExecutionGroupHealthSummary
} from "../execution/executionHealth.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { ChangeSet } from "../integration/changeSet.js";
import {
  governingWorkItemDeliveries,
  workItemDeliverySettled
} from "../integration/deliveryObligation.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { IntegrationQueueEntry } from "../integration/integrationQueueEntry.js";
import type { DurableJob } from "../job/durableJob.js";
import { isCompletedTaskReviewEvidenceFromRuns } from "../review/reviewAcceptance.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import type { ReviewRound, TaskReviewCandidate } from "../review/reviewRound.js";
import {
  sameTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import {
  resolveRecordedTaskFinalReviewContract,
  type TaskFinalReviewContractResolution
} from "../review/taskFinalReviewContractResolution.js";
import {
  currentWorkItemCandidate,
  currentWorkItemExecutionGroup,
  governingWorkItemCandidate,
  type WorkItem
} from "../workItem/workItem.js";
import { draftWorkItemDependencyIssue } from "./draftPlan.js";
import type { Task } from "./task.js";

/**
 * Issue 07 (Leader convergence): a read-only decision-support projection for
 * the Task Leader. It folds durable Task records into one recommended action,
 * while preserving legitimate alternatives and the points that require Leader
 * judgment instead of pretending that storage state alone owns the decision.
 *
 * This module is deliberately pure: it never starts a Controller, writes a
 * record, or performs a Git inspection. Every value is derived from records
 * that already exist. Hard protocol conflicts remain conservative — when the
 * records do not support safe execution, the projection returns
 * `repair-protocol-inconsistency` with the conflicting records instead of
 * guessing.
 */

export type NextActionKind =
  | "resolve-integration-conflicts"
  | "advance-task"
  | "implement-current-work-item"
  | "accept-or-reject-candidate"
  | "integrate-work-item"
  | "request-final-review"
  | "resolve-execution-stage"
  | "resume-review"
  | "retry-execution-lane"
  | "wait-for-owned-execution"
  | "resolve-input"
  | "start-task-execution"
  | "complete-task"
  | "repair-protocol-inconsistency";

export type NextActionRef = Readonly<{ kind: string; id: string }>;

export type NextActionPrecondition = Readonly<{
  fact: string;
  satisfied: boolean;
  ref?: NextActionRef;
}>;

export type NextActionAlternative = Readonly<{
  kind: string;
  reason: string;
  recommendedCommand?: string;
  refs?: readonly NextActionRef[];
}>;

export type NextAction = Readonly<{
  taskId: string;
  kind: NextActionKind;
  reason: string;
  /** Exact record IDs that prove the state or that the action operates on. */
  refs: readonly NextActionRef[];
  preconditions: readonly NextActionPrecondition[];
  /** The single recommended CLI command, when one exists. */
  recommendedCommand?: string;
  /** Other legitimate actions the Leader may choose after reading the evidence. */
  alternatives?: readonly NextActionAlternative[];
  /** Present when the recommended action cannot be selected from records alone. */
  judgmentRequired?: string;
  /** Conflicting records, present only for `repair-protocol-inconsistency`. */
  conflicts?: readonly NextActionRef[];
  /**
   * Stable hash of the action kind and its exact refs. Two projections with
   * the same fingerprint describe the same protocol position.
   */
  fingerprint: string;
}>;

export type NextActionFacts = Readonly<{
  task: Readonly<Pick<Task, "id" | "status" | "executionGate" | "projectBindings" | "type">>;
  workItems: readonly WorkItem[];
  changeSets: readonly ChangeSet[];
  integrations: readonly IntegrationAttempt[];
  /** Current check-job state, not a second Integration lifecycle. */
  integrationJobs?: readonly Pick<DurableJob, "id" | "status">[];
  integrationQueueEntries: readonly IntegrationQueueEntry[];
  reviewRounds: readonly ReviewRound[];
  reviewConfig: ReviewConfig | null;
  openInputRequests: readonly InputRequest[];
  activeRuns: readonly AgentRun[];
  /** Recent Leader AgentRuns (any status), newest last; consumed by the semantic budget. */
  leaderRuns: readonly AgentRun[];
  /** Exact Review AgentRuns needed to validate structural Review completion. */
  reviewOutcomeEvidence?: Readonly<{
    runs: readonly AgentRun[];
  }>;
  /** Current unresolved Lane health supplied by canonical Task read surfaces. */
  executionGroups?: readonly ExecutionGroupHealthSummary[];
  /** CLI-verified physical Task heads; null means no durable candidate is currently available. */
  currentTaskReviewCandidate?: TaskReviewCandidate | null;
}>;

const OPEN_WORK_ITEM_STATUSES = new Set(["open"]);

export function projectNextAction(facts: NextActionFacts): NextAction {
  const { task } = facts;
  const deliveryWorkItems = facts.workItems.filter(({ status }) => status !== "retired");
  if (task.status !== "active" && task.status !== "draft") {
    return buildAction(facts, {
      kind: "complete-task",
      reason: `Task ${task.id} is ${task.status}; no further protocol action is available.`,
      refs: [ref("task", task.id)],
      preconditions: [
        { fact: `Task status is ${task.status}`, satisfied: true, ref: ref("task", task.id) }
      ]
    });
  }

  if (task.status === "active" && task.executionGate.state === "stopped") {
    return buildAction(facts, {
      kind: "start-task-execution",
      reason: `Task ${task.id} execution is stopped; durable progress is preserved.`,
      refs: [ref("task", task.id)],
      preconditions: [
        { fact: "Task execution is stopped", satisfied: true, ref: ref("task", task.id) }
      ],
      recommendedCommand: `yui task execution start ${task.id}`
    });
  }

  const openInput = facts.openInputRequests[0];
  if (openInput !== undefined) {
    return buildAction(facts, {
      kind: "resolve-input",
      reason: `Input ${openInput.id} is open and blocks protocol convergence.`,
      refs: [ref("input-request", openInput.id)],
      preconditions: [
        { fact: "Input request is open", satisfied: true, ref: ref("input-request", openInput.id) }
      ],
      recommendedCommand: `yui task input answer ${task.id}/${openInput.id}`
    });
  }

  const inconsistency = detectProtocolInconsistency(facts);
  if (inconsistency !== null) {
    return buildAction(facts, {
      kind: "repair-protocol-inconsistency",
      reason: inconsistency.reason,
      refs: inconsistency.conflicts,
      conflicts: inconsistency.conflicts,
      preconditions: inconsistency.conflicts.map((entry) => (
        { fact: `Conflicting record ${entry.kind} ${entry.id}`, satisfied: false, ref: entry }
      )),
      recommendedCommand: inconsistency.recommendedCommand
    });
  }

  const laneRecovery = actionableExecutionLaneRecoveries(facts.executionGroups ?? [])
    .find(hasExactRun);
  if (laneRecovery !== undefined) {
    return buildExecutionLaneRecoveryAction(facts, laneRecovery);
  }

  const activeLeader = facts.activeRuns.find((run) => run.roleName === "leader");
  if (activeLeader !== undefined) {
    return buildAction(facts, {
      kind: "wait-for-owned-execution",
      reason: `Leader AgentRun ${activeLeader.id} is active; the protocol position is being executed.`,
      refs: [ref("run", activeLeader.id)],
      preconditions: [
        { fact: "Leader AgentRun is active", satisfied: true, ref: ref("run", activeLeader.id) }
      ]
    });
  }

  if (task.status === "draft") {
    const dependencyIssue = draftWorkItemDependencyIssue(facts.workItems);
    if (dependencyIssue !== undefined) {
      const refs = [
        ref("work-item", dependencyIssue.workItemId),
        ref("work-item", dependencyIssue.dependencyId)
      ];
      return buildAction(facts, {
        kind: "repair-protocol-inconsistency",
        reason: dependencyIssue.kind === "cycle"
          ? `Draft Work Item dependency cycle includes ${dependencyIssue.workItemId}/${dependencyIssue.dependencyId}. Edit the Draft before activation.`
          : `Draft Work Item ${dependencyIssue.workItemId} depends on ${dependencyIssue.dependencyId}, which is missing or retired. Edit the Draft before activation.`,
        refs,
        conflicts: refs,
        preconditions: [
          {
            fact: `Draft dependency ${dependencyIssue.dependencyId} is valid`,
            satisfied: false,
            ref: refs[1]
          }
        ],
        recommendedCommand:
          `yui task work edit ${task.id}/${dependencyIssue.workItemId} --clear-dependencies`
      });
    }
    const draftWork = selectOpenWorkItem(facts.workItems);
    if (draftWork.kind === "blocked") {
      const refs = [
        ref("work-item", draftWork.itemId),
        ref("work-item", draftWork.blockedBy)
      ];
      return buildAction(facts, {
        kind: "repair-protocol-inconsistency",
        reason: `Draft Work Item ${draftWork.itemId} depends on ${draftWork.blockedBy}, which is missing, retired, or not completed. Edit the Draft before activation.`,
        refs,
        conflicts: refs,
        preconditions: [
          { fact: `Draft dependency ${draftWork.blockedBy} is valid`, satisfied: false, ref: refs[1] }
        ],
        recommendedCommand:
          `yui task work edit ${task.id}/${draftWork.itemId} --clear-dependencies`
      });
    }
    return buildAction(facts, {
      kind: "implement-current-work-item",
      reason: `Task ${task.id} is still a Draft; activate it before dispatching, integrating, reviewing, or completing work.`,
      refs: [ref("task", task.id)],
      preconditions: [
        { fact: "Task is active", satisfied: false, ref: ref("task", task.id) }
      ],
      recommendedCommand: `yui task activate ${task.id}`
    });
  }

  const conflictedIntegration = facts.integrations.find(attempt => attempt.status === "conflicted");
  if (conflictedIntegration !== undefined) {
    return buildAction(facts, {
      kind: "resolve-integration-conflicts",
      reason: `Integration ${conflictedIntegration.id} has Git conflicts; the Leader resolves its workspace and continues without prior resolve or user approval.`,
      refs: [ref("integration", conflictedIntegration.id)],
      preconditions: [{ fact: "Git conflict resolution belongs to the Leader", satisfied: true }],
      recommendedCommand: `yui task integration continue ${task.id}/${conflictedIntegration.id}`
    });
  }
  const checkingIntegration = facts.integrations.find(attempt =>
    attempt.status === "running" && attempt.jobId !== undefined);
  if (checkingIntegration !== undefined) {
    const job = facts.integrationJobs?.find(job => job.id === checkingIntegration.jobId);
    const refs = [ref("integration", checkingIntegration.id), ref("job", checkingIntegration.jobId!)];
    if (job?.status === "queued" || job?.status === "running") {
      return buildAction(facts, {
        kind: "wait-for-owned-execution",
        reason: `Integration ${checkingIntegration.id} check Job ${job.id} is ${job.status}.`,
        refs,
        preconditions: [{ fact: "Check Job is still executing", satisfied: true, ref: refs[1] }],
        alternatives: [{
          kind: "continue-integration",
          reason: "When the check Job settles, continue this exact Integration to consume its result.",
          recommendedCommand: `yui task integration continue ${task.id}/${checkingIntegration.id}`
        }]
      });
    }
    return buildAction(facts, {
      kind: "integrate-work-item",
      reason: `Integration ${checkingIntegration.id} awaits check-result consumption (${job?.status ?? "read current Job"}); an empty integration queue does not finalize this direct attempt.`,
      refs,
      preconditions: [{ fact: "The Integration retains its exact check Job", satisfied: true, ref: refs[0] }],
      recommendedCommand: `yui task integration continue ${task.id}/${checkingIntegration.id}`
    });
  }

  const unfinishedIntegration = facts.integrations.find(attempt =>
    attempt.status === "running" || attempt.status === "validating");
  if (unfinishedIntegration !== undefined) {
    return buildAction(facts, {
      kind: "integrate-work-item",
      reason: `Integration ${unfinishedIntegration.id} is unfinished. ${unfinishedIntegration.summary ?? "Continue from its persisted source and check evidence."}`,
      refs: [ref("integration", unfinishedIntegration.id)],
      preconditions: [{ fact: "Inspect exact Integration evidence before any retry", satisfied: true }],
      recommendedCommand: `yui task integration continue ${task.id}/${unfinishedIntegration.id}`,
      alternatives: [{
        kind: "inspect-integration",
        reason: "If completion cannot be proved, preserve evidence and choose formal abort and an authorized alternative.",
        recommendedCommand: `yui task integration show ${task.id}/${unfinishedIntegration.id}`
      }]
    });
  }
  const candidateReady = facts.workItems
    .find((item) => (item.status === "open" && item.currentCandidateId !== undefined));
  if (candidateReady !== undefined) {
    const candidate = currentWorkItemCandidate(candidateReady);
    const activeReview = latestActiveWorkItemReview(facts.reviewRounds, candidateReady, candidate);
    if (activeReview !== undefined) {
      const reviewRef = ref("review-round", activeReview.id);
      if (activeReview.status === "running") {
        if (activeReview.reviewerRunId === undefined
          && activeReview.executionGroup === undefined) {
          return buildAction(facts, {
            kind: "repair-protocol-inconsistency",
            reason: `ReviewRound ${activeReview.id} is running but has no Reviewer AgentRun.`,
            refs: [reviewRef],
            conflicts: [reviewRef],
            preconditions: [
              { fact: "Running ReviewRound has an exact Reviewer AgentRun", satisfied: false, ref: reviewRef }
            ]
          });
        }
        const reviewRun = activeReviewRoundRun(activeReview, facts.activeRuns);
        if (reviewRun === undefined) {
          if (activeReview.executionGroup !== undefined && activeReview.reviewerRunId === undefined
            && !reviewGroupNeedsDispatch(activeReview, facts.activeRuns)) {
            return synthesisSelectionAction(facts, "review", activeReview.id);
          }
          if (reviewGroupNeedsDispatch(activeReview, facts.activeRuns)) {
            return buildAction(facts, {
              kind: "resume-review",
              reason: `ReviewRound ${activeReview.id} has Review Producer Lanes ready for dispatch or retry.`,
              refs: [reviewRef],
              preconditions: [
                { fact: "A Review Producer Lane is open", satisfied: true, ref: reviewRef }
              ],
              recommendedCommand:
                `yui task work review ${task.id}/${candidateReady.id}`
                + reviewLaneRoleOptions(activeReview)
            });
          }
          const runRef = activeReview.reviewerRunId === undefined
            ? reviewRef
            : ref("run", activeReview.reviewerRunId);
          return buildAction(facts, {
            kind: "repair-protocol-inconsistency",
            reason: `ReviewRound ${activeReview.id} has no active Producer or main Reviewer AgentRun.`,
            refs: [reviewRef, runRef],
            conflicts: [reviewRef, runRef],
            preconditions: [
              { fact: "Review execution is active or ready to dispatch", satisfied: false, ref: runRef }
            ]
          });
        }
        return buildAction(facts, {
          kind: "wait-for-owned-execution",
          reason: `Reviewer AgentRun ${reviewRun.id} is evaluating Candidate ${candidateReady.id}/${candidate?.id ?? "unknown"}.`,
          refs: [reviewRef, ref("run", reviewRun.id)],
          preconditions: [
            { fact: "ReviewRound is running", satisfied: true, ref: reviewRef },
            { fact: "Reviewer AgentRun is active", satisfied: true, ref: ref("run", reviewRun.id) }
          ]
        });
      }
      if (activeReview.reviewerRunId !== undefined) {
        const runRef = ref("run", activeReview.reviewerRunId);
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Pending ReviewRound ${activeReview.id} already references Reviewer AgentRun ${activeReview.reviewerRunId}.`,
          refs: [reviewRef, runRef],
          conflicts: [reviewRef, runRef],
          preconditions: [
            { fact: "Pending ReviewRound has no Reviewer AgentRun", satisfied: false, ref: runRef }
          ]
        });
      }
      return buildAction(facts, {
        kind: "resume-review",
        reason: `ReviewRound ${activeReview.id} is pending and never launched; resume it before accepting or rejecting the Candidate.`,
        refs: [reviewRef],
        preconditions: [
          { fact: "ReviewRound is pending", satisfied: true, ref: reviewRef },
          { fact: "Reviewer AgentRun exists", satisfied: false }
        ],
        recommendedCommand:
          `yui task work review ${task.id}/${candidateReady.id}`
          + reviewLaneRoleOptions(activeReview)
      });
    }
    const unintegrated = governingWorkItemDeliveries([candidateReady])
      .find((delivery) => !workItemDeliverySettled(delivery, facts.integrations));
    if (unintegrated !== undefined) {
      return buildAction(facts, {
        kind: "integrate-work-item",
        reason: `Work Item ${candidateReady.id} result for Project ${
          unintegrated.projectId
        } has not passed a Leader-owned Integration.`,
        refs: [ref("work-item", candidateReady.id)],
        preconditions: [
          {
            fact: "Committed Integration records the exact WorkItem result",
            satisfied: false,
            ref: ref("work-item", candidateReady.id)
          }
        ],
        recommendedCommand:
          `yui task integration start ${task.id} --work-item ${candidateReady.id} `
          + `--project ${unintegrated.projectId} --strategy cherry-pick`,
        judgmentRequired:
          "Leader must choose fast-forward, cherry-pick, merge, manual application, or an explicit no-op result."
      });
    }
    const refs = [
      ref("work-item", candidateReady.id),
      ...(candidate === undefined ? [] : [ref("candidate", `${candidateReady.id}/${candidate.id}`)])
    ];
    return buildAction(facts, {
      kind: "accept-or-reject-candidate",
      reason: `Work Item ${candidateReady.id} has a Candidate awaiting Leader disposition.`,
      refs,
      preconditions: [
        { fact: "Work Item is awaiting acceptance", satisfied: true, ref: refs[0] },
        ...(candidate === undefined
          ? [{ fact: "Candidate record exists", satisfied: false }]
          : [{ fact: "Candidate record exists", satisfied: true, ref: refs[1]! }])
      ],
      recommendedCommand: `yui task work accept ${task.id}/${candidateReady.id} --summary \"<decision>\"`,
      alternatives: [
        {
          kind: "reject-candidate",
          reason: "Reject when the Candidate does not satisfy the Task objective or acceptance criteria.",
          recommendedCommand: `yui task work reject ${task.id}/${candidateReady.id} --summary \"<reason>\"`,
          refs
        },
        ...(candidate?.reviewPolicy === undefined
          || candidate.reviewPolicy.trigger === "final"
          ? []
          : [{
              kind: "re-review-candidate",
              reason: "Request another WorkItem Review when the Leader needs independent evidence before disposition.",
              recommendedCommand: `yui task work review ${task.id}/${candidateReady.id}`,
              refs
            }])
      ],
      judgmentRequired:
        `Leader must judge Candidate ${candidateReady.id}/${candidate?.id ?? "unknown"} against the Task objective, acceptance criteria, and delivery risk.`
    });
  }

  // AgentRun purpose owns routing. Review AgentRuns remain attached to their exact
  // ReviewRound branches below instead of being mistaken for Worker delivery.
  const activeDelegatedExecutions = facts.activeRuns.filter((run) => (
    run.purpose === "execution" && run.roleName !== "leader"
  ));
  if (activeDelegatedExecutions.length > 0) {
    return buildAction(facts, {
      kind: "wait-for-owned-execution",
      reason: `${activeDelegatedExecutions.length} delegated execution AgentRun(s) are active; wait for their completion.`,
      refs: activeDelegatedExecutions.map((run) => ref("run", run.id)),
      preconditions: activeDelegatedExecutions.map((run) => (
        { fact: `Execution AgentRun ${run.id} is active`, satisfied: true, ref: ref("run", run.id) }
      ))
    });
  }

  const openWork = selectOpenWorkItem(facts.workItems);
  if (openWork?.kind === "blocked") {
    const refs = [
      ref("work-item", openWork.itemId),
      ref("work-item", openWork.blockedBy)
    ];
    return buildAction(facts, {
      kind: "repair-protocol-inconsistency",
      reason: `Work Item ${openWork.itemId} depends on ${openWork.blockedBy}, which is not completed or available.`,
      refs,
      conflicts: refs,
      preconditions: [
        { fact: `Dependency ${openWork.blockedBy} is completed`, satisfied: false, ref: refs[1] }
      ]
    });
  }
  if (openWork?.kind === "ready") {
    const item = openWork.item;
    const group = currentWorkItemExecutionGroup(item);
    if (item.status === "open" && group !== undefined
      && !facts.activeRuns.some((run) => run.sourceExecutionGroupId === group.id)) {
      return synthesisSelectionAction(facts, "work", item.id);
    }
    const refs = [ref("work-item", item.id)];
    const direct = item.assignee === undefined;
    return buildAction(facts, {
      kind: "implement-current-work-item",
      reason: direct
        ? `Work Item ${item.id} has no managed assignee; the Leader can execute it directly.`
        : `Work Item ${item.id} is assigned to ${item.assignee}; dispatch or continue that assignment.`,
      refs,
      preconditions: [
        { fact: `Work Item is ${item.status}`, satisfied: true, ref: refs[0] }
      ],
      recommendedCommand: direct
        ? `yui task work update ${task.id}/${item.id} running`
        : `yui task work dispatch ${task.id}/${item.id}`,
      alternatives: direct ? [
        ...(item.writeProjectIds.length === 0 ? [] : [{
          kind: "isolate-work-item",
          reason: "Prepare and inspect the WorkItem-owned code workspace before direct implementation.",
          recommendedCommand: `yui task work isolate ${task.id}/${item.id}`,
          refs
        }]),
        {
          kind: "native-subagent",
          reason: "Use a bounded native child only when authorized and useful within the Leader's current scope.",
          refs
        }
      ] : [],
      judgmentRequired: direct
        ? "Honor explicit execution preferences. For code, use the WorkItem-owned workspace and integrate its Candidate before acceptance; no self-dispatch is needed."
        : "Preserve the current managed Assignment and original results; do not switch ownership merely to follow a different default."
    });
  }

  if (deliveryWorkItems.length === 0
    && !taskFinalReviewRequired(facts)
    && !facts.reviewRounds.some((round) => (
      (round.scope ?? "work-item") === "task"
      && (round.status === "pending" || round.status === "running")
    ))) {
    const reviewAlternative = facts.reviewConfig === null
      ? []
      : [{
          kind: "request-final-review",
          reason: "Request one independent Review of the frozen Task result when risk warrants it.",
          recommendedCommand:
            `yui task review request ${task.id} --role ${facts.reviewConfig.roleName}`,
          refs: [ref("task", task.id)]
        }];
    return buildAction(facts, {
      kind: "advance-task",
      reason: `Task ${task.id} has no recorded WorkItems. This does not determine its required topology or prove completion; advance the user's persisted requirements and Brief.`,
      refs: [ref("task", task.id)],
      preconditions: [
        { fact: "Task is active", satisfied: task.status === "active", ref: ref("task", task.id) },
        { fact: "Task main is clean, committed, and verified", satisfied: false }
      ],
      recommendedCommand: `yui task context ${task.id} --json`,
      alternatives: [...reviewAlternative, {
        kind: "complete-task",
        reason: "Complete only after every requested outcome, delegation and Review requirement is satisfied and verified; record counts and a clean commit alone do not prove that.",
        recommendedCommand: `yui task complete ${task.id} --summary-file -`
      }],
      judgmentRequired: "Honor explicit user/Project requirements first. Otherwise choose direct work or independently owned WorkItems and proportionate Review. This projection does not authorize weakening the Task Contract."
    });
  }

  const unintegrated = governingWorkItemDeliveries(facts.workItems)
    .find((delivery) => !workItemDeliverySettled(delivery, facts.integrations));
  if (unintegrated !== undefined) {
    return buildAction(facts, {
      kind: "integrate-work-item",
      reason: `Work Item ${unintegrated.workItemId} result for Project ${
        unintegrated.projectId
      } has no committed Integration.`,
      refs: [ref("work-item", unintegrated.workItemId)],
      preconditions: [
        {
          fact: "Committed Integration records the exact WorkItem result",
          satisfied: false,
          ref: ref("work-item", unintegrated.workItemId)
        }
      ],
      recommendedCommand:
        `yui task integration start ${task.id} --work-item ${unintegrated.workItemId} `
        + `--project ${unintegrated.projectId} --strategy cherry-pick`,
      judgmentRequired:
        "Leader must choose fast-forward, cherry-pick, merge, manual application, or an explicit no-op result."
    });
  }

  const finalReviewRequired = taskFinalReviewRequired(facts);
  const finalReviewContract = taskFinalReviewContract(facts);
  const failedFinal = latestTaskFinalReview(facts.reviewRounds, finalReviewContract);
  if (finalReviewRequired
    && failedFinal?.status === "failed") {
    const reviewerRun = failedFinal.reviewerRunId === undefined
      ? undefined
      : facts.reviewOutcomeEvidence?.runs.find(
          ({ id }) => id === failedFinal.reviewerRunId
        );
    const sameRoundCommand = failedFinal.reviewerRunId === undefined
      ? `yui task review retry ${task.id}/${failedFinal.id}`
      : reviewerRun?.status === "failed"
        ? `yui task run retry ${task.id}/${reviewerRun.id}`
        : undefined;
    return buildAction(facts, {
      kind: "resume-review",
      reason: `Task-final Review ${failedFinal.id} failed during execution: ${
        failedFinal.failure?.message ?? "unknown Core failure"
      }.`,
      refs: [
        ref("review-round", failedFinal.id),
        ...(reviewerRun?.status === "failed" ? [ref("run", reviewerRun.id)] : [])
      ],
      preconditions: [
        {
          fact: "Task-final Review has one exact completed Reviewer AgentRun",
          satisfied: false,
          ref: ref("review-round", failedFinal.id)
        }
      ],
      ...(sameRoundCommand === undefined ? {} : { recommendedCommand: sameRoundCommand })
    });
  }
  if (finalReviewRequired
    && failedFinal?.status === "completed"
    && !isCompletedTaskReviewEvidenceFromRuns(
      failedFinal,
      facts.reviewOutcomeEvidence?.runs ?? []
    )) {
    return buildAction(facts, {
      kind: "repair-protocol-inconsistency",
      reason:
        `Task-final Review ${failedFinal.id} is completed without one exact completed main Reviewer AgentRun.`,
      refs: [ref("review-round", failedFinal.id)],
      conflicts: [ref("review-round", failedFinal.id)],
      preconditions: [
        {
          fact: "ReviewRound and exact main Reviewer AgentRun agree",
          satisfied: false,
          ref: ref("review-round", failedFinal.id)
        }
      ]
    });
  }
  const activeFinal = latestTaskFinalReview(facts.reviewRounds, finalReviewContract);
  if (activeFinal !== undefined
    && (activeFinal.status === "pending" || activeFinal.status === "running")) {
    const reviewRef = ref("review-round", activeFinal.id);
    if (activeFinal.status === "running") {
      if (activeFinal.reviewerRunId === undefined
        && activeFinal.executionGroup === undefined) {
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Task-final ReviewRound ${activeFinal.id} is running but has no Reviewer AgentRun.`,
          refs: [reviewRef],
          conflicts: [reviewRef],
          preconditions: [
            { fact: "Running Task-final ReviewRound has an exact Reviewer AgentRun", satisfied: false, ref: reviewRef }
          ]
        });
      }
      const reviewRun = activeReviewRoundRun(activeFinal, facts.activeRuns);
      if (reviewRun === undefined) {
        if (activeFinal.executionGroup !== undefined && activeFinal.reviewerRunId === undefined
          && !reviewGroupNeedsDispatch(activeFinal, facts.activeRuns)) {
          return synthesisSelectionAction(facts, "review", activeFinal.id);
        }
        if (reviewGroupNeedsDispatch(activeFinal, facts.activeRuns)) {
          return buildAction(facts, {
            kind: "resume-review",
            reason: `Task-final ReviewRound ${activeFinal.id} has Review Producer Lanes ready for dispatch or retry.`,
            refs: [reviewRef],
            preconditions: [
              { fact: "A Review Producer Lane is open", satisfied: true, ref: reviewRef }
            ],
            recommendedCommand:
              `yui task review request ${task.id} --role ${activeFinal.reviewerRoleName}`
              + reviewLaneRoleOptions(activeFinal)
          });
        }
        const runRef = activeFinal.reviewerRunId === undefined
          ? reviewRef
          : ref("run", activeFinal.reviewerRunId);
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Task-final ReviewRound ${activeFinal.id} has no active Producer or main Reviewer AgentRun.`,
          refs: [reviewRef, runRef],
          conflicts: [reviewRef, runRef],
          preconditions: [
            { fact: "Review execution is active or ready to dispatch", satisfied: false, ref: runRef }
          ]
        });
      }
      return buildAction(facts, {
        kind: "wait-for-owned-execution",
        reason: `Reviewer AgentRun ${reviewRun.id} is executing frozen Task-final Review ${activeFinal.id}; this Review does not globally pause Leader decisions on newer facts.`,
        refs: [reviewRef, ref("run", reviewRun.id)],
        preconditions: [
          { fact: "Task-final ReviewRound is running", satisfied: true, ref: reviewRef },
          { fact: "Reviewer AgentRun is active", satisfied: true, ref: ref("run", reviewRun.id) }
        ],
        alternatives: [
          {
            kind: "continue-leader-work",
            reason: "Process new user input or advance a later candidate while preserving this frozen Review.",
            refs: [reviewRef]
          },
          {
            kind: "request-another-reviewer",
            reason: "Use another available Reviewer slot when an independent view adds value.",
            recommendedCommand: `yui task review request ${task.id} --role <other-reviewer-role>`,
            refs: [reviewRef]
          }
        ],
        judgmentRequired:
          "Leader decides whether the current facts justify waiting, continuing development, direct review, or another Reviewer."
      });
    }
    if (activeFinal.reviewerRunId !== undefined) {
      const runRef = ref("run", activeFinal.reviewerRunId);
      return buildAction(facts, {
        kind: "repair-protocol-inconsistency",
        reason: `Pending Task-final ReviewRound ${activeFinal.id} already references Reviewer AgentRun ${activeFinal.reviewerRunId}.`,
        refs: [reviewRef, runRef],
        conflicts: [reviewRef, runRef],
        preconditions: [
          { fact: "Pending Task-final ReviewRound has no Reviewer AgentRun", satisfied: false, ref: runRef }
        ]
      });
    }
    return buildAction(facts, {
      kind: "resume-review",
      reason: `Task-final ReviewRound ${activeFinal.id} is pending and never launched; retry it under the same semantic Round.`,
      refs: [reviewRef],
      preconditions: [
        { fact: "Task-final ReviewRound is pending", satisfied: true, ref: reviewRef },
        { fact: "Reviewer AgentRun exists", satisfied: false }
      ],
      recommendedCommand:
        `yui task review request ${task.id} --role ${activeFinal.reviewerRoleName}`
        + reviewLaneRoleOptions(activeFinal)
    });
  }

  if (task.projectBindings.length > 0
    && finalReviewRequired
    && !hasValidFinalReview(facts)) {
    const reviewerRole = taskFinalReviewRole(facts);
    return buildAction(facts, {
      kind: "request-final-review",
      reason: deliveryWorkItems.length === 0
        ? "This Task already owns a final-Review obligation; completion must prepare or resume a Review of its frozen Task head."
        : "All WorkItems are integrated but no valid Task-final Review attests the frozen Task result.",
      refs: [ref("task", task.id)],
      preconditions: deliveryWorkItems.length === 0
        ? [{ fact: "Valid established Task-final Review at the direct head", satisfied: false }]
        : [
            { fact: "All Work Items are terminal", satisfied: true },
            { fact: "Every governing WorkItem result is integrated", satisfied: true },
            { fact: "Valid Task-final Review at the integrated head", satisfied: false }
          ],
      recommendedCommand: deliveryWorkItems.length === 0
        ? `yui task complete ${task.id} --summary-file -`
        : `yui task review request ${task.id} --role ${reviewerRole ?? "<reviewer-role>"}`
    });
  }

  const finalReviewOptional = !finalReviewRequired
    && !hasValidFinalReview(facts);
  const optionalReviewer = facts.reviewConfig?.roleName
    ?? failedFinal?.reviewerRoleName;
  const finalReviewAlternative = finalReviewOptional && optionalReviewer !== undefined
    ? [{
        kind: "request-final-review",
        reason: "Request an independent Task-final Review when the Leader wants extra assurance before completion.",
        recommendedCommand: `yui task review request ${task.id} --role ${optionalReviewer}`,
        refs: [ref("task", task.id)]
      }]
    : [];
  return buildAction(facts, {
    kind: "complete-task",
    reason: deliveryWorkItems.length === 0
      ? "The Leader-owned Task result and its established obligations are ready; complete it without creating successor work."
      : "Every independent delivery unit is integrated; complete the Task instead of creating successor work.",
    refs: [ref("task", task.id)],
    preconditions: [
      { fact: "All Work Items are terminal", satisfied: true },
      ...(task.projectBindings.length === 0
        ? []
        : deliveryWorkItems.length === 0
          ? [{ fact: "Task main is clean, committed, and verified", satisfied: false }]
          : [
            { fact: "Every governing WorkItem result is integrated", satisfied: true },
            ...(finalReviewRequired
              ? [{
                  fact: "Valid Task-final Review at the integrated head",
                  satisfied: hasValidFinalReview(facts)
                }]
              : [])
          ])
    ],
    ...(finalReviewAlternative.length === 0 ? {} : { alternatives: finalReviewAlternative }),
    ...(!finalReviewOptional
      ? {}
      : {
          judgmentRequired:
            "Leader must decide whether the frozen Task result is safe to complete or needs one optional Task-final Review."
        }),
    recommendedCommand: `yui task complete ${task.id} --summary-file -`
  });
}

function synthesisSelectionAction(
  facts: NextActionFacts,
  subject: "work" | "review",
  id: string
): NextAction {
  return buildAction(facts, {
    kind: "resolve-execution-stage",
    reason: `Replicated ${subject} ${id} needs Leader judgment over original results and synthesis.`,
    refs: [ref(subject === "work" ? "work-item" : "review-round", id)],
    preconditions: [],
    recommendedCommand: subject === "work"
      ? `yui task work show ${facts.task.id}/${id}`
      : `yui task review synthesize ${facts.task.id}/${id} --source-run <task>/<run>`,
    judgmentRequired: "Inspect original results and any existing main AgentRun. Retry a failed main AgentRun or explicitly select synthesis sources; Core does not enforce a success count or voting rule."
  });
}

type NextActionLaneRecovery = ActionableExecutionLaneRecovery & Readonly<{ runId: string }>;

function hasExactRun(
  lane: ActionableExecutionLaneRecovery
): lane is NextActionLaneRecovery {
  return lane.runId !== undefined;
}

function buildExecutionLaneRecoveryAction(
  facts: NextActionFacts,
  lane: NextActionLaneRecovery
): NextAction {
  const refs = [
    ref("execution-group", lane.groupId),
    ref("execution-lane", lane.laneId),
    ref("run", lane.runId)
  ];
  return buildAction(facts, {
    kind: "retry-execution-lane",
    reason: `Execution Lane ${lane.laneId} is durably failed; retry only exact AgentRun ${lane.runId} and retain sibling results.`,
    refs,
    preconditions: [
      { fact: "Execution Lane is failed and unresolved", satisfied: true, ref: refs[1] },
      { fact: "Exact failed AgentRun is retained", satisfied: true, ref: refs[2] }
    ],
    recommendedCommand: `yui task run retry ${facts.task.id}/${lane.runId}`
  });
}

/**
 * Stable fingerprint of the durable delivery position. It changes exactly
 * when a delivery record changes, so the semantic-progress budget can compare
 * positions across Leader turns without persisting anything new.
 */
export function durableStateFingerprint(facts: NextActionFacts): string {
  const parts = [
    `task:${facts.task.status}`,
    ...facts.workItems.map((item) =>
      `work:${item.id}:${item.status}:${item.revision}:${item.updatedAt}`),
    ...facts.changeSets.map((changeSet) =>
      `change-set:${changeSet.id}:${changeSet.headCommit}`),
    ...facts.integrations.map((attempt) =>
      `integration:${attempt.id}:${attempt.status}:${attempt.updatedAt}`),
    ...facts.integrationQueueEntries.map((entry) =>
      `integration-queue:${entry.id}:${entry.status}:${entry.updatedAt}`),
    ...facts.reviewRounds.map((round) =>
      `review:${round.id}:${round.status}:${round.endedAt ?? ""}`)
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function buildAction(
  facts: NextActionFacts,
  input: Readonly<{
    kind: NextActionKind;
    reason: string;
    refs: readonly NextActionRef[];
    preconditions: readonly NextActionPrecondition[];
    recommendedCommand?: string;
    alternatives?: readonly NextActionAlternative[];
    judgmentRequired?: string;
    conflicts?: readonly NextActionRef[];
  }>
): NextAction {
  const fingerprintSource = [
    input.kind,
    ...input.refs.map((entry) => `${entry.kind}:${entry.id}`)
  ].join("|");
  return {
    taskId: facts.task.id,
    kind: input.kind,
    reason: input.reason,
    refs: input.refs,
    preconditions: input.preconditions,
    ...(input.recommendedCommand === undefined
      ? {}
      : { recommendedCommand: input.recommendedCommand }),
    ...(input.alternatives === undefined || input.alternatives.length === 0
      ? {}
      : { alternatives: input.alternatives }),
    ...(input.judgmentRequired === undefined
      ? {}
      : { judgmentRequired: input.judgmentRequired }),
    ...(input.conflicts === undefined ? {} : { conflicts: input.conflicts }),
    fingerprint: createHash("sha256").update(fingerprintSource).digest("hex")
  };
}

function latestActiveWorkItemReview(
  rounds: readonly ReviewRound[],
  item: WorkItem,
  candidate: WorkItem["candidates"][number] | undefined
): ReviewRound | undefined {
  if (candidate === undefined) return undefined;
  return [...rounds]
    .reverse()
    .find((round) => (
      round.workItemId === item.id
      && round.candidateId === candidate.id
      && (round.status === "pending" || round.status === "running")
    ));
}

function activeReviewRoundRun(round: ReviewRound, activeRuns: readonly AgentRun[]): AgentRun | undefined {
  if (round.reviewerRunId !== undefined) {
    const main = activeRuns.find((run) => (
      run.id === round.reviewerRunId && run.roleName === round.reviewerRoleName
    ));
    if (main !== undefined) return main;
  }
  for (const lane of round.executionGroup?.lanes ?? []) {
    if (lane.disposition !== "open" || lane.currentRunId === undefined) continue;
    const run = activeRuns.find((candidate) => (
      candidate.id === lane.currentRunId && candidate.roleName === lane.roleName
    ));
    if (run !== undefined) return run;
  }
  return undefined;
}

function reviewLaneRoleOptions(round: ReviewRound): string {
  return round.executionGroup?.lanes
    .map(({ roleName }) => ` --lane-role ${roleName}`)
    .join("") ?? "";
}

function reviewGroupNeedsDispatch(
  round: ReviewRound,
  runs: readonly AgentRun[]
): boolean {
  return round.executionGroup?.lanes.some((lane) => (
    lane.disposition === "open"
    && (lane.currentRunId === undefined
      || runs.find(({ id }) => id === lane.currentRunId)?.status === "failed")
  )) === true;
}

function reviewRoundConflict(
  round: ReviewRound,
  activeRuns: readonly AgentRun[]
): Inconsistency | null {
  const reviewRef = ref("review-round", round.id);
  if (round.status === "running") {
    if (round.reviewerRunId === undefined && round.executionGroup === undefined) {
      return {
        reason: `ReviewRound ${round.id} is running but has no execution unit.`,
        conflicts: [reviewRef]
      };
    }
    if (activeReviewRoundRun(round, activeRuns) === undefined) {
      if (round.reviewerRunId === undefined && round.executionGroup !== undefined) return null;
      const runRef = ref("run", round.reviewerRunId!);
      return {
        reason: `ReviewRound ${round.id} references Reviewer AgentRun ${round.reviewerRunId}, but that AgentRun is not active.`,
        conflicts: [reviewRef, runRef]
      };
    }
  }
  if (round.status === "pending") {
    const launchedRunId = round.reviewerRunId
      ?? round.executionGroup?.lanes.find(
        (lane) => lane.currentRunId !== undefined
      )?.currentRunId;
    if (launchedRunId !== undefined) {
      const runRef = ref("run", launchedRunId);
      return {
        reason: `Pending ReviewRound ${round.id} already references Reviewer AgentRun ${launchedRunId}.`,
        conflicts: [reviewRef, runRef]
      };
    }
  }
  return null;
}

type OpenWorkItemSelection =
  | { kind: "ready"; item: WorkItem }
  | { kind: "blocked"; itemId: string; blockedBy: string }
  | { kind: "none" };

function selectOpenWorkItem(workItems: readonly WorkItem[]): OpenWorkItemSelection {
  const byId = new Map(workItems.map((item) => [item.id, item]));
  const openItems = workItems.filter((item) => OPEN_WORK_ITEM_STATUSES.has(item.status));
  if (openItems.length === 0) return { kind: "none" };
  const eligible = openItems.find((item) => (
    item.dependsOn.every((dependencyId) => {
      const status = byId.get(dependencyId)?.status;
      return status === "accepted";
    })
  ));
  if (eligible !== undefined) return { kind: "ready", item: eligible };

  let current: WorkItem | undefined = openItems[0];
  const visited = new Set<string>();
  while (current !== undefined) {
    if (visited.has(current.id)) {
      return { kind: "blocked", itemId: current.id, blockedBy: current.id };
    }
    visited.add(current.id);
    const blockedBy = current.dependsOn.find((dependencyId) => {
      const status = byId.get(dependencyId)?.status;
      return status !== "accepted";
    });
    if (blockedBy === undefined) return { kind: "ready", item: current };
    const dependency = byId.get(blockedBy);
    if (dependency === undefined || !OPEN_WORK_ITEM_STATUSES.has(dependency.status)) {
      return { kind: "blocked", itemId: current.id, blockedBy };
    }
    current = dependency;
  }
  return { kind: "none" };
}

function taskFinalReviewContract(facts: NextActionFacts): TaskFinalReviewContract | undefined {
  return taskFinalReviewContractResolution(facts)?.effective;
}

function taskFinalReviewContractResolution(
  facts: NextActionFacts
): TaskFinalReviewContractResolution | undefined {
  return resolveRecordedTaskFinalReviewContract(
    facts.task.id,
    facts.workItems,
    facts.reviewRounds
  );
}

function taskFinalReviewRequired(facts: NextActionFacts): boolean {
  return taskFinalReviewContract(facts) !== undefined;
}

function taskFinalReviewRole(facts: NextActionFacts): string | undefined {
  return taskFinalReviewContract(facts)?.reviewerRoleName
    ?? latestTaskFinalReview(facts.reviewRounds)?.reviewerRoleName
    ?? (facts.reviewConfig?.trigger === "final" ? facts.reviewConfig.roleName : undefined);
}

function ref(kind: string, id: string): NextActionRef {
  return { kind, id };
}


function latestTaskFinalReview(
  rounds: readonly ReviewRound[],
  contract?: TaskFinalReviewContract
): ReviewRound | undefined {
  return [...rounds]
    .reverse()
    .find((round) => (
      (round.scope ?? "work-item") === "task"
      && (contract === undefined || sameTaskFinalReviewContract(
        round.taskFinalReviewContract,
        contract
      ))
    ));
}

function hasValidFinalReview(facts: NextActionFacts): boolean {
  const contract = taskFinalReviewContract(facts);
  const final = [...facts.reviewRounds]
    .reverse()
    .find((round) => (
      (round.scope ?? "work-item") === "task"
      && (contract === undefined || sameTaskFinalReviewContract(
        round.taskFinalReviewContract,
        contract
      ))
    ));
  if (final === undefined || !isCompletedTaskReviewEvidenceFromRuns(
    final,
    facts.reviewOutcomeEvidence?.runs ?? []
  )) return false;
  return final.taskCandidate !== undefined;
}

type Inconsistency = Readonly<{
  reason: string;
  conflicts: readonly NextActionRef[];
  recommendedCommand?: string;
}>;

function detectProtocolInconsistency(facts: NextActionFacts): Inconsistency | null {
  const workItemById = new Map(facts.workItems.map((item) => [item.id, item]));

  try {
    taskFinalReviewContractResolution(facts);
  } catch (error) {
    const candidateRefs = facts.workItems.flatMap((item) => {
      const candidate = governingWorkItemCandidate(item);
      return candidate?.taskFinalReviewContract === undefined
        ? []
        : [ref("candidate", `${item.id}/${candidate.id}`)];
    });
    const reviewRefs = facts.reviewRounds
      .filter((round) => (
        (round.scope ?? "work-item") === "task"
        && round.taskFinalReviewContract !== undefined
      ))
      .map((round) => ref("review-round", round.id));
    return {
      reason: "Task-final Review contract is inconsistent: "
        + (error instanceof Error ? error.message : String(error)),
      conflicts: [...candidateRefs, ...reviewRefs]
    };
  }

  for (const round of facts.reviewRounds) {
    const reviewConflict = reviewRoundConflict(round, facts.activeRuns);
    if (reviewConflict !== null) return reviewConflict;
  }

  for (const attempt of facts.integrations) {
    if (attempt.status !== "committed") continue;
    if (attempt.source.kind === "work-item"
      && !workItemById.has(attempt.source.workItemId)) {
      return {
        reason: `Committed Integration ${attempt.id} references missing WorkItem ${attempt.source.workItemId}.`,
        conflicts: [
          ref("integration-attempt", attempt.id),
          ref("work-item", attempt.source.workItemId)
        ]
      };
    }
  }

  for (const round of facts.reviewRounds) {
    if (round.status !== "pending" && round.status !== "running") continue;
    if (round.workItemId === undefined) continue;
    const item = workItemById.get(round.workItemId);
    if (item !== undefined && item.status === "retired") {
      return {
        reason: `Review ${round.id} is still ${round.status} but its Work Item ${item.id} is retired.`,
        conflicts: [ref("review-round", round.id), ref("work-item", item.id)]
      };
    }
  }

  return null;
}
