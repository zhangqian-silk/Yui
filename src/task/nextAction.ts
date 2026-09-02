import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { InputRequest } from "../input/inputRequest.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { IntegrationQueueEntry } from "../integration/integrationQueueEntry.js";
import {
  changeSetDeliverySettled,
  governingChangeSets
} from "../integration/deliveryObligation.js";
import type { Turn } from "../turn/turn.js";
import type { ReviewRound, TaskReviewCandidate } from "../review/reviewRound.js";
import { isAcceptedTaskReviewBaselineFromEvidence } from "../review/reviewAcceptance.js";
import {
  classifyReviewRoundOutcome,
  isSemanticReviewRound,
  type ReviewOutcomeEvidenceStore
} from "../review/reviewOutcomeClassifier.js";
import type { ReviewFinding } from "../review/reviewFinding.js";
import {
  actionableExecutionLaneRecoveries,
  type ActionableExecutionLaneRecovery,
  type ExecutionGroupHealthSummary
} from "../execution/executionHealth.js";
import {
  candidateConvergenceDisagreement,
  candidateConvergenceEvidenceSufficient,
  candidateConvergenceStageResultsValid
} from "../execution/candidateConvergence.js";
import {
  executionStageSpendClosed,
  routeExecutionStage
} from "../execution/resourceBroker.js";
import {
  sameTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import {
  resolveRecordedTaskFinalReviewContract,
  type TaskFinalReviewContractResolution
} from "../review/taskFinalReviewContractResolution.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import type { Task } from "./task.js";
import {
  currentWorkItemCandidate,
  currentWorkItemExecutionGroup,
  governingWorkItemCandidate,
  type WorkItem
} from "../workItem/workItem.js";

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
  | "implement-current-work-item"
  | "accept-or-reject-candidate"
  | "capture-change-set"
  | "integrate-change-set"
  | "request-final-review"
  | "route-review-findings"
  | "resolve-execution-stage"
  | "resolve-review-group"
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
  integrationQueueEntries: readonly IntegrationQueueEntry[];
  reviewRounds: readonly ReviewRound[];
  reviewConfig: ReviewConfig | null;
  openInputRequests: readonly InputRequest[];
  activeTurns: readonly Turn[];
  /** Recent Leader Turns (any status), newest last; consumed by the semantic budget. */
  leaderTurns: readonly Turn[];
  /** Bounded corroboration for terminal Review outcome classification. */
  reviewOutcomeEvidence?: Readonly<{
    turns: readonly Turn[];
    reviewFindings: readonly ReviewFinding[];
    events: readonly TaskEvent[];
  }>;
  /** Current unresolved Lane health supplied by canonical Task read surfaces. */
  executionGroups?: readonly ExecutionGroupHealthSummary[];
  /** CLI-verified physical Task heads; null means no durable candidate is currently available. */
  currentTaskReviewCandidate?: TaskReviewCandidate | null;
}>;

const OPEN_WORK_ITEM_STATUSES = new Set(["pending", "running", "awaiting_acceptance"]);

export function projectNextAction(facts: NextActionFacts): NextAction {
  const { task } = facts;
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
    .find(hasExactTurn);
  if (laneRecovery !== undefined) {
    return buildExecutionLaneRecoveryAction(facts, laneRecovery);
  }

  const activeLeader = facts.activeTurns.find((run) => run.roleName === "leader");
  if (activeLeader !== undefined) {
    return buildAction(facts, {
      kind: "wait-for-owned-execution",
      reason: `Leader Turn ${activeLeader.id} is active; the protocol position is being executed.`,
      refs: [ref("turn", activeLeader.id)],
      preconditions: [
        { fact: "Leader Turn is active", satisfied: true, ref: ref("turn", activeLeader.id) }
      ]
    });
  }

  if (task.status === "draft") {
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

  const candidateReady = facts.workItems
    .find((item) => item.status === "awaiting_acceptance");
  if (candidateReady !== undefined) {
    const candidate = currentWorkItemCandidate(candidateReady);
    if (candidate !== undefined && isEmptyDirectCandidate(candidate)) {
      const candidateRef = ref("candidate", `${candidateReady.id}/${candidate.id}`);
      return buildAction(facts, {
        kind: "repair-protocol-inconsistency",
        reason: `Candidate ${candidate.id} is a Task-main delivery with base==head (no commits); reject it and re-dispatch real work.`,
        refs: [ref("work-item", candidateReady.id), candidateRef],
        conflicts: [candidateRef],
        preconditions: [
          { fact: "Direct Candidate contains at least one commit", satisfied: false, ref: candidateRef }
        ],
        recommendedCommand:
          `yui task work reject ${task.id}/${candidateReady.id} --summary \"empty base==head candidate\"`
      });
    }
    const activeReview = latestActiveWorkItemReview(facts.reviewRounds, candidateReady, candidate);
    if (activeReview !== undefined) {
      const reviewRef = ref("review-round", activeReview.id);
      if (activeReview.status === "running") {
        if (reviewGroupAwaitingResolution(activeReview)) {
          return buildResolveReviewGroupAction(facts, activeReview);
        }
        if (activeReview.reviewerTurnId === undefined) {
          return buildAction(facts, {
            kind: "repair-protocol-inconsistency",
            reason: `ReviewRound ${activeReview.id} is running but has no Reviewer Turn.`,
            refs: [reviewRef],
            conflicts: [reviewRef],
            preconditions: [
              { fact: "Running ReviewRound has an exact Reviewer Turn", satisfied: false, ref: reviewRef }
            ]
          });
        }
        const reviewRun = activeReviewRoundRun(activeReview, facts.activeTurns);
        if (reviewRun === undefined) {
          if (reviewGroupHasResourceQueue(activeReview)) {
            return buildAction(facts, {
              kind: "resume-review",
              reason: `ReviewRound ${activeReview.id} has Reviewer Lanes waiting for Resource Broker capacity.`,
              refs: [reviewRef],
              preconditions: [
                { fact: "A Reviewer Lane is durably queued", satisfied: true, ref: reviewRef },
                { fact: "Resource capacity is available", satisfied: false }
              ],
              recommendedCommand: `yui task work review ${task.id}/${candidateReady.id}`
            });
          }
  const runRef = ref("turn", activeReview.reviewerTurnId);
          return buildAction(facts, {
            kind: "repair-protocol-inconsistency",
            reason: `ReviewRound ${activeReview.id} references Reviewer Turn ${activeReview.reviewerTurnId}, but that Turn is not active.`,
            refs: [reviewRef, runRef],
            conflicts: [reviewRef, runRef],
            preconditions: [
              { fact: "Reviewer Turn is active", satisfied: false, ref: runRef }
            ]
          });
        }
        return buildAction(facts, {
          kind: "wait-for-owned-execution",
          reason: `Reviewer Turn ${reviewRun.id} is evaluating Candidate ${candidateReady.id}/${candidate?.id ?? "unknown"}.`,
          refs: [reviewRef, ref("turn", reviewRun.id)],
          preconditions: [
            { fact: "ReviewRound is running", satisfied: true, ref: reviewRef },
            { fact: "Reviewer Turn is active", satisfied: true, ref: ref("turn", reviewRun.id) }
          ]
        });
      }
      if (activeReview.reviewerTurnId !== undefined) {
        const runRef = ref("turn", activeReview.reviewerTurnId);
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Pending ReviewRound ${activeReview.id} already references Reviewer Turn ${activeReview.reviewerTurnId}.`,
          refs: [reviewRef, runRef],
          conflicts: [reviewRef, runRef],
          preconditions: [
            { fact: "Pending ReviewRound has no Reviewer Turn", satisfied: false, ref: runRef }
          ]
        });
      }
      return buildAction(facts, {
        kind: "resume-review",
        reason: `ReviewRound ${activeReview.id} is pending and never launched; resume it before accepting or rejecting the Candidate.`,
        refs: [reviewRef],
        preconditions: [
          { fact: "ReviewRound is pending", satisfied: true, ref: reviewRef },
          { fact: "Reviewer Turn exists", satisfied: false }
        ],
        recommendedCommand: `yui task work review ${task.id}/${candidateReady.id}`
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

  // Turn purpose owns routing. Review Turns remain attached to their exact
  // ReviewRound branches below instead of being mistaken for Worker delivery.
  const activeDelegatedExecutions = facts.activeTurns.filter((run) => (
    run.purpose === "execution" && run.roleName !== "leader"
  ));
  if (activeDelegatedExecutions.length > 0) {
    return buildAction(facts, {
      kind: "wait-for-owned-execution",
      reason: `${activeDelegatedExecutions.length} delegated execution Turn(s) are active; wait for their completion.`,
      refs: activeDelegatedExecutions.map((run) => ref("turn", run.id)),
      preconditions: activeDelegatedExecutions.map((run) => (
        { fact: `Execution Turn ${run.id} is active`, satisfied: true, ref: ref("turn", run.id) }
      ))
    });
  }

  const failedWork = facts.workItems.find((item) => item.status === "failed");
  if (failedWork !== undefined) {
    const failedReview = latestFailedReviewFor(facts.reviewRounds, failedWork.id);
    if (failedReview !== undefined) {
      return buildAction(facts, {
        kind: "route-review-findings",
        reason: `Work Item ${failedWork.id} failed with Review ${failedReview.id}; route its open findings into a repair wave.`,
        refs: [ref("work-item", failedWork.id), ref("review-round", failedReview.id)],
        preconditions: [
          { fact: "Work Item is failed", satisfied: true, ref: ref("work-item", failedWork.id) },
          { fact: "Review Round is failed", satisfied: true, ref: ref("review-round", failedReview.id) }
        ],
        recommendedCommand: `yui task review finding repair-wave ${task.id} --create`
      });
    }
    const explorationStop = exhaustedExplorationReason(failedWork, facts.executionGroups);
    if (explorationStop !== undefined) {
      return buildAction(facts, {
        kind: "implement-current-work-item",
        reason: explorationStop,
        refs: [ref("work-item", failedWork.id)],
        preconditions: [
          { fact: "Work Item exploration cannot continue", satisfied: true, ref: ref("work-item", failedWork.id) }
        ],
        recommendedCommand: `yui task work retire ${task.id}/${failedWork.id} --summary \"<reason>\"`
      });
    }
    return buildAction(facts, {
      kind: "implement-current-work-item",
      reason: `Work Item ${failedWork.id} failed without a Review verdict; retry implementation.`,
      refs: [ref("work-item", failedWork.id)],
      preconditions: [
        { fact: "Work Item is failed", satisfied: true, ref: ref("work-item", failedWork.id) }
      ],
      recommendedCommand: failedWork.assignee === undefined
        ? `yui task work update ${task.id}/${failedWork.id} running`
        : `yui task work dispatch ${task.id}/${failedWork.id}`
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
    const stageAction = buildExecutionStageAction(facts, item);
    if (stageAction !== null) return stageAction;
    const refs = [ref("work-item", item.id)];
    return buildAction(facts, {
      kind: "implement-current-work-item",
      reason: `Work Item ${item.id} is ${item.status}; dispatch or continue its implementation.`,
      refs,
      preconditions: [
        { fact: `Work Item is ${item.status}`, satisfied: true, ref: refs[0] }
      ],
      recommendedCommand: `yui task work dispatch ${task.id}/${item.id}`,
      alternatives: [
        {
          kind: "execute-directly",
          reason: "Execute the bounded Work Item directly when the Leader's current context and authority are sufficient.",
          refs
        },
        {
          kind: "native-subagent",
          reason: "Use native implementer subagents when bounded work benefits from specialist attention or parallel fan-out inside the Leader Session.",
          refs
        }
      ],
      judgmentRequired:
        "Leader must choose the execution path: direct execution, a native subagent, or managed Task Role dispatch."
    });
  }

  if (facts.workItems.length === 0
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
      kind: "complete-task",
      reason: task.type === "bugfix"
        ? `Task ${task.id} is a Leader-owned bugfix; implement and verify it on Task main without manufacturing a WorkItem.`
        : task.type === "feature"
          ? `Feature ${task.id} has no independent delivery units; the Leader may implement it on Task main or create WorkItems only if separate ownership is genuinely useful.`
          : `Task ${task.id} has no independent delivery units; the Leader decides whether to own it on Task main or create WorkItems only if separate ownership is genuinely useful.`,
      refs: [ref("task", task.id)],
      preconditions: [
        { fact: "Task is active", satisfied: task.status === "active", ref: ref("task", task.id) },
        { fact: "Task main is clean, committed, and verified", satisfied: false }
      ],
      recommendedCommand: `yui task complete ${task.id} --summary-file -`,
      ...(reviewAlternative.length === 0 ? {} : { alternatives: reviewAlternative }),
      judgmentRequired: task.type === "bugfix"
        ? "Leader must judge whether the bugfix risk warrants one optional final Review."
        : task.type === "feature"
          ? "Leader must judge whether this feature is small enough to own directly or needs independently owned WorkItems, and whether the final result warrants Review."
          : "Leader must choose the smallest useful topology from the Project-defined Task intent, then decide whether the frozen result warrants Review."
    });
  }

  const uncaptured = facts.workItems.find((item) => needsChangeSetCapture(facts, item));
  if (uncaptured !== undefined) {
    return buildAction(facts, {
      kind: "capture-change-set",
      reason: `Work Item ${uncaptured.id} is completed but has no ChangeSet; capture its delivery boundary.`,
      refs: [ref("work-item", uncaptured.id)],
      preconditions: [
        { fact: "Work Item is completed", satisfied: true, ref: ref("work-item", uncaptured.id) },
        { fact: "ChangeSet exists for the Work Item", satisfied: false }
      ],
      recommendedCommand: `yui task work capture ${task.id}/${uncaptured.id}`
    });
  }

  const unintegrated = governingChangeSets(facts.workItems, facts.changeSets)
    .find((changeSet) => !changeSetDeliverySettled(
      changeSet,
      facts.integrations,
      facts.integrationQueueEntries
    ));
  if (unintegrated !== undefined) {
    return buildAction(facts, {
      kind: "integrate-change-set",
      reason: `ChangeSet ${unintegrated.id} has no committed Integration.`,
      refs: [ref("change-set", unintegrated.id)],
      preconditions: [
        { fact: "ChangeSet exists", satisfied: true, ref: ref("change-set", unintegrated.id) },
        { fact: "Committed Integration references the ChangeSet", satisfied: false }
      ],
      recommendedCommand:
        `yui task integration start ${task.id} --project ${unintegrated.projectId} --change-set ${unintegrated.id}`
    });
  }

  const finalReviewRequired = taskFinalReviewRequired(facts);
  const finalReviewContract = taskFinalReviewContract(facts);
  const failedFinal = latestTaskFinalReview(facts.reviewRounds, finalReviewContract);
  const failedFinalOutcome = failedFinal === undefined
    ? null
    : classifyReviewRoundOutcome(failedFinal, nextActionReviewOutcomeEvidence(facts));
  if (finalReviewRequired
    && failedFinal !== undefined && failedFinalOutcome?.kind === "non-semantic") {
    return buildAction(facts, {
      kind: "resume-review",
      reason: `Task-final Review ${failedFinal.id} ended before a semantic review was proven.`,
      refs: [ref("review-round", failedFinal.id)],
      preconditions: [
        { fact: "Task-final Review has semantic evidence", satisfied: false, ref: ref("review-round", failedFinal.id) }
      ],
      recommendedCommand: `yui task review force-fresh ${task.id}/${failedFinal.id}`
    });
  }
  if (finalReviewRequired
    && failedFinal !== undefined && failedFinalOutcome?.kind === "ambiguous") {
    return buildAction(facts, {
      kind: "repair-protocol-inconsistency",
      reason: `Task-final Review ${failedFinal.id} has ambiguous semantic and infrastructure evidence: ${failedFinalOutcome.reason}`,
      refs: [ref("review-round", failedFinal.id)],
      conflicts: [ref("review-round", failedFinal.id)],
      preconditions: [
        { fact: "Review outcome is unambiguously semantic or non-semantic", satisfied: false, ref: ref("review-round", failedFinal.id) }
      ]
    });
  }
  if (finalReviewRequired
    && failedFinal !== undefined
    && failedFinalOutcome?.kind === "semantic"
    && failedFinal.deltaRecheck?.disposition === "requires-full-review") {
    return buildAction(facts, {
      kind: "request-final-review",
      reason: `Delta Recheck ${failedFinal.id} could not establish equivalence; Yui recorded the result and left the next Review action to the Leader.`,
      refs: [ref("review-round", failedFinal.id)],
      preconditions: [
        { fact: "Current frozen head has accepting final Review evidence", satisfied: false }
      ],
      alternatives: [
        {
          kind: "request-full-review",
          reason: "Request a full Review when independent evidence is still required.",
          recommendedCommand:
            `yui task review request ${task.id} --role ${failedFinal.reviewerRoleName}`,
          refs: [ref("review-round", failedFinal.id)]
        },
        {
          kind: "continue-leader-work",
          reason: "Inspect directly, change the candidate, or choose another Reviewer as Task risk requires.",
          refs: [ref("review-round", failedFinal.id)]
        }
      ],
      judgmentRequired:
        "Leader must choose full Review, another Reviewer, direct inspection, or more development; Core will not auto-escalate."
    });
  }
  if (finalReviewRequired
    && failedFinal !== undefined
    && failedFinalOutcome?.kind === "semantic"
    && ((failedFinal.checks ?? []).some(({ outcome }) => outcome === "failed")
      || failedFinal.deltaRecheck?.disposition === "finding")) {
    return buildAction(facts, {
      kind: "route-review-findings",
      reason: `Task-final Review ${failedFinal.id} delivered semantic negative evidence; route its open findings into a repair wave on one frozen head.`,
      refs: [ref("review-round", failedFinal.id)],
      preconditions: [
        { fact: "Task-final Review is failed", satisfied: true, ref: ref("review-round", failedFinal.id) }
      ],
      recommendedCommand: `yui task review finding repair-wave ${task.id} --create`
    });
  }

  const activeFinal = latestTaskFinalReview(facts.reviewRounds, finalReviewContract);
  if (activeFinal !== undefined
    && (activeFinal.status === "pending" || activeFinal.status === "running")) {
    const reviewRef = ref("review-round", activeFinal.id);
    if (activeFinal.status === "running") {
      if (reviewGroupAwaitingResolution(activeFinal)) {
        return buildResolveReviewGroupAction(facts, activeFinal);
      }
      if (activeFinal.reviewerTurnId === undefined) {
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Task-final ReviewRound ${activeFinal.id} is running but has no Reviewer Turn.`,
          refs: [reviewRef],
          conflicts: [reviewRef],
          preconditions: [
            { fact: "Running Task-final ReviewRound has an exact Reviewer Turn", satisfied: false, ref: reviewRef }
          ]
        });
      }
      const reviewRun = activeReviewRoundRun(activeFinal, facts.activeTurns);
      if (reviewRun === undefined) {
        if (reviewGroupHasResourceQueue(activeFinal)) {
          return buildAction(facts, {
            kind: "resume-review",
            reason: `Task-final ReviewRound ${activeFinal.id} has Reviewer Lanes waiting for Resource Broker capacity.`,
            refs: [reviewRef],
            preconditions: [
              { fact: "A Reviewer Lane is durably queued", satisfied: true, ref: reviewRef },
              { fact: "Resource capacity is available", satisfied: false }
            ],
            recommendedCommand:
              `yui task review request ${task.id} --role ${activeFinal.reviewerRoleName}`
          });
        }
        const runRef = ref("turn", activeFinal.reviewerTurnId);
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Task-final ReviewRound ${activeFinal.id} references Reviewer Turn ${activeFinal.reviewerTurnId}, but that Turn is not active.`,
          refs: [reviewRef, runRef],
          conflicts: [reviewRef, runRef],
          preconditions: [
            { fact: "Reviewer Turn is active", satisfied: false, ref: runRef }
          ]
        });
      }
      return buildAction(facts, {
        kind: "wait-for-owned-execution",
        reason: `Reviewer Turn ${reviewRun.id} is executing frozen Task-final Review ${activeFinal.id}; this Review does not globally pause Leader decisions on newer facts.`,
        refs: [reviewRef, ref("turn", reviewRun.id)],
        preconditions: [
          { fact: "Task-final ReviewRound is running", satisfied: true, ref: reviewRef },
          { fact: "Reviewer Turn is active", satisfied: true, ref: ref("turn", reviewRun.id) }
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
    if (activeFinal.reviewerTurnId !== undefined) {
      const runRef = ref("turn", activeFinal.reviewerTurnId);
      return buildAction(facts, {
        kind: "repair-protocol-inconsistency",
        reason: `Pending Task-final ReviewRound ${activeFinal.id} already references Reviewer Turn ${activeFinal.reviewerTurnId}.`,
        refs: [reviewRef, runRef],
        conflicts: [reviewRef, runRef],
        preconditions: [
          { fact: "Pending Task-final ReviewRound has no Reviewer Turn", satisfied: false, ref: runRef }
        ]
      });
    }
    return buildAction(facts, {
      kind: "resume-review",
      reason: `Task-final ReviewRound ${activeFinal.id} is pending and never launched; retry it under the same semantic Round.`,
      refs: [reviewRef],
      preconditions: [
        { fact: "Task-final ReviewRound is pending", satisfied: true, ref: reviewRef },
        { fact: "Reviewer Turn exists", satisfied: false }
      ],
      recommendedCommand: `yui task review retry ${task.id}/${activeFinal.id}`
    });
  }

  if (task.projectBindings.length > 0
    && finalReviewRequired
    && !hasValidFinalReview(facts)) {
    const reviewerRole = taskFinalReviewRole(facts);
    return buildAction(facts, {
      kind: "request-final-review",
      reason: facts.workItems.length === 0
        ? "This Task already owns a final-Review obligation; completion must prepare or resume a Review of its frozen Task head."
        : "All WorkItems are integrated but no valid Task-final Review attests the frozen Task result.",
      refs: [ref("task", task.id)],
      preconditions: facts.workItems.length === 0
        ? [{ fact: "Valid established Task-final Review at the direct head", satisfied: false }]
        : [
            { fact: "All Work Items are terminal", satisfied: true },
            { fact: "Every governing ChangeSet is settled", satisfied: true },
            { fact: "Valid Task-final Review at the integrated head", satisfied: false }
          ],
      recommendedCommand: facts.workItems.length === 0
        ? `yui task complete ${task.id} --summary-file -`
        : `yui task review request ${task.id} --role ${reviewerRole ?? "<reviewer-role>"}`
    });
  }

  const finalReviewOptional = !finalReviewRequired
    && !hasValidFinalReview(facts);
  const unresolvedDelta = failedFinal?.deltaRecheck?.disposition === "requires-full-review";
  const optionalReviewer = facts.reviewConfig?.roleName
    ?? (unresolvedDelta ? failedFinal?.reviewerRoleName : undefined);
  const finalReviewAlternative = finalReviewOptional && optionalReviewer !== undefined
    ? [{
        kind: "request-final-review",
        reason: unresolvedDelta
          ? `Delta Recheck ${failedFinal!.id} returned requires-full-review; request full independent evidence when the Leader judges it necessary.`
          : "Request an independent Task-final Review when the Leader wants extra assurance before completion.",
        recommendedCommand: `yui task review request ${task.id} --role ${optionalReviewer}`,
        refs: [ref("task", task.id)]
      }]
    : [];
  return buildAction(facts, {
    kind: "complete-task",
    reason: facts.workItems.length === 0
      ? "The Leader-owned Task result and its established obligations are ready; complete it without creating successor work."
      : "Every independent delivery unit is integrated; complete the Task instead of creating successor work.",
    refs: [ref("task", task.id)],
    preconditions: [
      { fact: "All Work Items are terminal", satisfied: true },
      ...(task.projectBindings.length === 0
        ? []
        : facts.workItems.length === 0
          ? [{ fact: "Task main is clean, committed, and verified", satisfied: false }]
          : [
            { fact: "Every governing ChangeSet is settled", satisfied: true },
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
            unresolvedDelta
              ? "Leader must route the non-accepting Delta result: full Review, another Reviewer, direct inspection, more development, or completion when policy permits."
              : "Leader must decide whether the frozen Task result is safe to complete or needs one optional Task-final Review."
        }),
    recommendedCommand: `yui task complete ${task.id} --summary-file -`
  });
}

type NextActionLaneRecovery = ActionableExecutionLaneRecovery & Readonly<{ turnId: string }>;

function hasExactTurn(
  lane: ActionableExecutionLaneRecovery
): lane is NextActionLaneRecovery {
  return lane.turnId !== undefined;
}

function buildExecutionLaneRecoveryAction(
  facts: NextActionFacts,
  lane: NextActionLaneRecovery
): NextAction {
  const refs = [
    ref("execution-group", lane.groupId),
    ref("execution-lane", lane.laneId),
    ref("turn", lane.turnId)
  ];
  return buildAction(facts, {
    kind: "retry-execution-lane",
    reason: `Execution Lane ${lane.laneId} is durably failed; retry only exact Turn ${lane.turnId} and retain sibling results.`,
    refs,
    preconditions: [
      { fact: "Execution Lane is failed and unresolved", satisfied: true, ref: refs[1] },
      { fact: "Exact failed Turn is retained", satisfied: true, ref: refs[2] }
    ],
    recommendedCommand: `yui task turn retry ${facts.task.id}/${lane.turnId}`
  });
}

function exhaustedExplorationReason(
  item: WorkItem,
  executionGroups: readonly ExecutionGroupHealthSummary[] | undefined
): string | undefined {
  const group = currentWorkItemExecutionGroup(item);
  if (group?.stage === undefined || group.resolution === undefined) return undefined;
  if (group.resolution.decision === "reject") {
    return `Work Item ${item.id} exploration was rejected and has no legal continuation; retire it explicitly.`;
  }
  if (group.resolution.decision === "retry"
    && group.stage.stage === "resolve"
    && group.stage.round >= group.stage.maxRounds) {
    return `Work Item ${item.id} exhausted its exploration round budget; retire it explicitly.`;
  }
  const resources = executionGroups?.find(({ groupId }) => groupId === group.id)?.resources;
  if ((group.resolution.decision === "retry" || group.resolution.decision === "blocked")
    && resources !== undefined
    && executionStageSpendClosed(resources)) {
    return `Work Item ${item.id} cannot retry its frozen exploration resource budget; retire it explicitly or replace it with a newly authorized delivery boundary.`;
  }
  if ((group.resolution.decision === "retry" || group.resolution.decision === "blocked")
    && group.stage.stageAttempt >= group.stage.budget.maxAttempts) {
    return `Work Item ${item.id} exhausted its ${group.stage.stage} stage attempt budget; retire it explicitly.`;
  }
  return undefined;
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

function buildExecutionStageAction(
  facts: NextActionFacts,
  item: WorkItem
): NextAction | null {
  const group = currentWorkItemExecutionGroup(item);
  if (group?.stage?.resources === undefined || group.resolution !== undefined) return null;
  const projected = facts.executionGroups?.find(({ groupId }) => groupId === group.id);
  const resources = projected?.resources;
  if (resources === undefined) return null;
  const usableLaneIds = group.lanes.filter(({ status }) => status === "completed").map(({ id }) => id);
  const stageResultsValid = candidateConvergenceStageResultsValid(group);
  const disagreement = candidateConvergenceDisagreement(group);
  const routing = routeExecutionStage({
    group,
    resources,
    evidenceSufficient: candidateConvergenceEvidenceSufficient(
      item,
      group,
      usableLaneIds
    ),
    disagreement
  });
  const refs = [ref("work-item", item.id), ref("execution-group", group.id)];
  const resolveCommand = (decision: "accept" | "retry" | "blocked", suffix = "") => (
    `yui task work group resolve ${facts.task.id}/${item.id}`
    + ` --decision ${decision} --summary \"<stage decision>\"${suffix}`
  );
  if (routing.action === "blocked") {
    return buildAction(facts, {
      kind: "resolve-execution-stage",
      reason: `${routing.reason}; dispatch would preserve the same pending Lanes without starting them.`,
      refs,
      preconditions: [
        { fact: "Execution stage is unresolved", satisfied: true, ref: refs[1] },
        {
          fact: "Stage deadline or hard budget is exhausted",
          satisfied: executionStageSpendClosed(resources),
          ref: refs[1]
        },
        { fact: "Acceptance-level evidence is sufficient", satisfied: false, ref: refs[1] }
      ],
      recommendedCommand: resolveCommand("blocked"),
      judgmentRequired:
        "Leader must record the resource-blocked stage, then retire or replace the delivery boundary; the frozen budget cannot be reopened by redispatch."
    });
  }
  if (routing.action === "expand-parallel") {
    return buildAction(facts, {
      kind: "resolve-execution-stage",
      reason: routing.reason,
      refs,
      preconditions: [
        {
          fact: "Stage quorum is open or structured results show material disagreement",
          satisfied: !resources.quorumMet || disagreement === "high",
          ref: refs[1]
        },
        {
          fact: "Adaptive Lane capacity remains",
          satisfied: group.strategy.mode === "adaptive"
            && group.lanes.length < group.strategy.max,
          ref: refs[1]
        }
      ],
      recommendedCommand:
        `yui task work dispatch ${facts.task.id}/${item.id} --lane-role <independent-role>`,
      ...(resources.quorumMet
        ? {
            alternatives: [{
              kind: "deepen-sequential",
              reason: "Resolve the current evidence and deepen sequentially when another independent Lane has lower value.",
              recommendedCommand: resolveCommand("accept"),
              refs
            }]
          }
        : {}),
      judgmentRequired: resources.quorumMet
        ? "Leader must choose an unused compatible Task Role for expansion or deliberately select the sequential alternative."
        : "Leader must choose an unused compatible Task Role so the frozen stage can satisfy quorum."
    });
  }
  if (routing.action === "deepen-sequential") {
    const resolveRequestsNextRound = group.stage.stage === "resolve";
    const decision = usableLaneIds.length === 0
      || !stageResultsValid
      || !resources.quorumMet
      || resolveRequestsNextRound
      ? "retry"
      : "accept";
    return buildAction(facts, {
      kind: "resolve-execution-stage",
      reason: resolveRequestsNextRound
        ? "Resolve evidence does not establish a Candidate; begin another bounded exploration round."
        : !resources.quorumMet
          ? "The stage exhausted its Lane capacity before quorum; resolve it as a bounded retry."
          : decision === "retry"
            ? "The stage has no structurally usable output; resolve it as a bounded retry before redispatch."
            : routing.reason,
      refs,
      preconditions: [
        { fact: "No stage Lane remains active or queued", satisfied: true, ref: refs[1] },
        { fact: "Current stage has structurally usable output", satisfied: stageResultsValid, ref: refs[1] },
        { fact: "Stage quorum is met", satisfied: resources.quorumMet, ref: refs[1] }
      ],
      recommendedCommand: resolveCommand(decision),
      judgmentRequired: resolveRequestsNextRound
        ? "Leader must judge whether the frozen round budget permits another exploration round or the WorkItem should be retired."
        : decision === "retry"
          ? "Leader must judge whether the frozen attempt budget permits one retry or the WorkItem should be retired."
          : "Leader must select the usable stage evidence before advancing to the next bounded stage."
    });
  }
  if (routing.action === "resolve") {
    const earlyStop = routing.cancelPendingLaneIds.length === 0
      ? ""
      : " --early-stop <observed-marginal-value>";
    return buildAction(facts, {
      kind: "resolve-execution-stage",
      reason: routing.reason,
      refs,
      preconditions: [
        { fact: "Stage quorum is met", satisfied: resources.quorumMet, ref: refs[1] },
        { fact: "Acceptance-level evidence is sufficient", satisfied: true, ref: refs[1] }
      ],
      recommendedCommand: resolveCommand("accept", earlyStop),
      judgmentRequired: routing.cancelPendingLaneIds.length === 0
        ? "Leader must select and accept the evidence that satisfies the stage contract."
        : "Leader must record the observed marginal value before skipping never-started pending Lanes."
    });
  }
  if (resources.pendingLaneIds.length > 0 && resources.activeLaneIds.length === 0) {
    return buildAction(facts, {
      kind: "implement-current-work-item",
      reason: `ExecutionGroup ${group.id} has queued Lanes and an open resource budget; retry Broker admission after the capacity wake.`,
      refs,
      preconditions: [
        { fact: "At least one Lane is durably queued", satisfied: true, ref: refs[1] },
        {
          fact: "Stage deadline and hard budgets remain open",
          satisfied: !executionStageSpendClosed(resources),
          ref: refs[1]
        }
      ],
      recommendedCommand: `yui task work dispatch ${facts.task.id}/${item.id}`
    });
  }
  if (resources.activeLaneIds.length > 0) {
    return buildAction(facts, {
      kind: "repair-protocol-inconsistency",
      reason: `ExecutionGroup ${group.id} retains active Lanes but no delegated Turn is active.`,
      refs,
      conflicts: refs,
      preconditions: [
        { fact: "Every active Lane has an active exact Turn", satisfied: false, ref: refs[1] }
      ]
    });
  }
  return null;
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

function activeReviewRoundRun(round: ReviewRound, activeTurns: readonly Turn[]): Turn | undefined {
  if (round.executionGroup !== undefined) {
    for (const lane of round.executionGroup.lanes) {
      if (lane.status !== "running"
        || lane.reviewRoundId !== round.id
        || lane.turnId === undefined) {
        continue;
      }
      const run = activeTurns.find((candidate) => (
        candidate.id === lane.turnId && candidate.roleName === lane.roleName
      ));
      if (run !== undefined) return run;
    }
    return undefined;
  }
  if (round.reviewerTurnId === undefined) return undefined;
  return activeTurns.find((run) => (
    run.id === round.reviewerTurnId && run.roleName === round.reviewerRoleName
  ));
}

const TERMINAL_REVIEW_LANE_STATUSES = new Set(["completed", "failed"]);

function isPanelReviewRound(round: ReviewRound): boolean {
  return round.executionGroup !== undefined
    && (round.executionGroup.lanes.length > 1
      || round.executionGroup.strategy.mode === "adaptive");
}

function reviewGroupAwaitingResolution(round: ReviewRound): boolean {
  return round.status === "running"
    && round.executionGroup !== undefined
    && round.executionGroup.resolution === undefined
    && isPanelReviewRound(round)
    && round.executionGroup.lanes.every((lane) =>
      TERMINAL_REVIEW_LANE_STATUSES.has(lane.status));
}

function reviewGroupHasResourceQueue(round: ReviewRound): boolean {
  return round.executionGroup !== undefined
    && round.executionGroup.resolution === undefined
    && round.executionGroup.lanes.some((lane) => (
      lane.status === "pending"
      && lane.turnId === undefined
    ));
}

function buildResolveReviewGroupAction(
  facts: NextActionFacts,
  round: ReviewRound
): NextAction {
  const group = round.executionGroup!;
  const refs = [
    ref("review-round", round.id),
    ref("execution-group", group.id)
  ];
  const resolveCommand = (decision: string) =>
    `yui task review group resolve ${facts.task.id}/${round.id}`
    + ` --decision ${decision} --summary \"<decision>\"`;
  return buildAction(facts, {
    kind: "resolve-review-group",
    reason: `Reviewer panel ${group.id} has finished every Lane; the Leader must resolve ReviewRound ${round.id}.`,
    refs,
    preconditions: [
      { fact: "ReviewRound is running", satisfied: true, ref: refs[0] },
      { fact: "Every Reviewer Lane is terminal", satisfied: true, ref: refs[1] },
      { fact: "Leader has resolved the Review ExecutionGroup", satisfied: false, ref: refs[1] }
    ],
    recommendedCommand: resolveCommand("<accept|reject|blocked>"),
    alternatives: [
      {
        kind: "accept-review-group",
        reason: "Accept the usable Lane outputs when their evidence satisfies the Task objective.",
        recommendedCommand: resolveCommand("accept"),
        refs
      },
      {
        kind: "reject-review-group",
        reason: "Reject the panel evidence when it does not support the delivery.",
        recommendedCommand: resolveCommand("reject"),
        refs
      },
      {
        kind: "block-review-group",
        reason: "Block the Review when a material dependency or external fact prevents a sound decision.",
        recommendedCommand: resolveCommand("blocked"),
        refs
      }
    ],
    judgmentRequired:
      `Leader must judge Review panel ${group.id} against the Task objective, acceptance criteria, and delivery risk.`
  });
}

function reviewRoundConflict(
  round: ReviewRound,
  activeTurns: readonly Turn[]
): Inconsistency | null {
  const reviewRef = ref("review-round", round.id);
  if (round.status === "running") {
    if (reviewGroupAwaitingResolution(round)) {
      return null;
    }
    if (round.reviewerTurnId === undefined) {
      return {
        reason: `ReviewRound ${round.id} is running but has no Reviewer Turn.`,
        conflicts: [reviewRef]
      };
    }
    if (activeReviewRoundRun(round, activeTurns) === undefined) {
      if (reviewGroupHasResourceQueue(round)) return null;
      const runRef = ref("turn", round.reviewerTurnId);
      return {
        reason: `ReviewRound ${round.id} references Reviewer Turn ${round.reviewerTurnId}, but that Turn is not active.`,
        conflicts: [reviewRef, runRef]
      };
    }
  }
  if (round.status === "pending") {
    const launchedTurnId = round.reviewerTurnId
      ?? round.executionGroup?.lanes.find((lane) => lane.turnId !== undefined)?.turnId;
    if (launchedTurnId !== undefined) {
      const runRef = ref("turn", launchedTurnId);
      return {
        reason: `Pending ReviewRound ${round.id} already references Reviewer Turn ${launchedTurnId}.`,
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
      return status === "completed";
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
      return status !== "completed";
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

function isEmptyDirectCandidate(candidate: WorkItem["candidates"][number]): boolean {
  const snapshot = candidate.taskMainSnapshot;
  if (snapshot === undefined) return false;
  return snapshot.projects.every((project) => project.baseCommit === project.headCommit);
}

function latestFailedReviewFor(
  rounds: readonly ReviewRound[],
  workItemId: string
): ReviewRound | undefined {
  return [...rounds]
    .reverse()
    .find((round) => round.workItemId === workItemId && round.status === "failed");
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

function needsChangeSetCapture(facts: NextActionFacts, item: WorkItem): boolean {
  if (item.status !== "completed") return false;
  if (governingChangeSets([item], facts.changeSets).length > 0) return false;
  const candidate = item.candidates.at(-1);
  if (candidate === undefined) return false;
  // A metadata-only Task-main Candidate has no WorkItem Develop
  // workspace to capture; its boundary is the Task-main head itself.
  if (candidate.workspace === undefined
    && candidate.gitSnapshot === undefined
    && candidate.taskMainSnapshot !== undefined) {
    return false;
  }
  return candidate.workspace !== undefined || candidate.gitSnapshot !== undefined;
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
  if (final === undefined || !isAcceptedTaskReviewBaselineFromEvidence(
    final,
    nextActionReviewOutcomeEvidence(facts)
  )) return false;
  if (facts.currentTaskReviewCandidate !== undefined) {
    return facts.currentTaskReviewCandidate !== null
      && isDeepStrictEqual(final.taskCandidate, facts.currentTaskReviewCandidate);
  }
  const reviewedCommits = new Set(
    (final.taskCandidate?.projects ?? []).map((project) => project.commit)
  );
  if (reviewedCommits.size === 0) return false;
  const integratedHeads = new Set(
    facts.integrations
      .filter((attempt) => attempt.status === "committed")
      .flatMap((attempt) =>
        facts.changeSets
          .filter((changeSet) => attempt.changeSetIds.includes(changeSet.id))
          .map((changeSet) => changeSet.headCommit))
  );
  if (integratedHeads.size === 0) return facts.workItems.length === 0;
  for (const head of integratedHeads) {
    if (!reviewedCommits.has(head)) return false;
  }
  return true;
}

/** Adapts the serializable next-action evidence bundle to the shared classifier. */
export function nextActionReviewOutcomeEvidence(
  facts: NextActionFacts
): ReviewOutcomeEvidenceStore | undefined {
  const evidence = facts.reviewOutcomeEvidence;
  if (evidence === undefined) return undefined;
  return {
    listTurns: () => evidence.turns,
    listReviewFindings: () => evidence.reviewFindings,
    listEvents: () => evidence.events
  };
}

type Inconsistency = Readonly<{
  reason: string;
  conflicts: readonly NextActionRef[];
  recommendedCommand?: string;
}>;

function detectProtocolInconsistency(facts: NextActionFacts): Inconsistency | null {
  const changeSetIds = new Set(facts.changeSets.map((changeSet) => changeSet.id));
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
    const reviewConflict = reviewRoundConflict(round, facts.activeTurns);
    if (reviewConflict !== null) return reviewConflict;
  }

  for (const attempt of facts.integrations) {
    if (attempt.status !== "committed") continue;
    const dangling = attempt.changeSetIds
      .filter((id) => !changeSetIds.has(id));
    if (dangling.length > 0) {
      return {
        reason: `Committed Integration ${attempt.id} references missing ChangeSet(s): ${dangling.join(", ")}.`,
        conflicts: [
          ref("integration-attempt", attempt.id),
          ...dangling.map((id) => ref("change-set", id))
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

  for (const item of facts.workItems) {
    if (item.status !== "awaiting_acceptance") continue;
    if (item.candidates.length === 0) {
      return {
        reason: `Work Item ${item.id} is awaiting acceptance but has no Candidate record.`,
        conflicts: [ref("work-item", item.id)]
      };
    }
  }

  return null;
}
