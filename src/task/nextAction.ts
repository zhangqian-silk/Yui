import { createHash } from "node:crypto";

import type { InputRequest } from "../input/inputRequest.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { AgentRun } from "../run/agentRun.js";
import type { ReviewRound } from "../review/reviewRound.js";
import {
  sameTaskFinalReviewContract,
  validateTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import type { Task } from "./task.js";
import { currentWorkItemCandidate, type WorkItem } from "../workItem/workItem.js";

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
  | "resolve-review-group"
  | "resume-review"
  | "wait-for-owned-execution"
  | "resolve-input"
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
  task: Readonly<Pick<Task, "id" | "status" | "projectBindings">>;
  workItems: readonly WorkItem[];
  changeSets: readonly ChangeSet[];
  integrations: readonly IntegrationAttempt[];
  reviewRounds: readonly ReviewRound[];
  reviewConfig: ReviewConfig | null;
  openInputRequests: readonly InputRequest[];
  activeRuns: readonly AgentRun[];
  /** Recent Leader Runs (any status), newest last; consumed by the semantic budget. */
  leaderRuns: readonly AgentRun[];
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

  const activeLeader = facts.activeRuns.find((run) => run.roleName === "leader");
  if (activeLeader !== undefined) {
    return buildAction(facts, {
      kind: "wait-for-owned-execution",
      reason: `Leader Run ${activeLeader.id} is active; the protocol position is being executed.`,
      refs: [ref("agent-run", activeLeader.id)],
      preconditions: [
        { fact: "Leader Run is active", satisfied: true, ref: ref("agent-run", activeLeader.id) }
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
        reason: `Candidate ${candidate.id} is a direct Task-main delivery with base==head (no commits); reject it and re-dispatch real work.`,
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
        if (activeReview.reviewerRunId === undefined) {
          return buildAction(facts, {
            kind: "repair-protocol-inconsistency",
            reason: `ReviewRound ${activeReview.id} is running but has no Reviewer Run.`,
            refs: [reviewRef],
            conflicts: [reviewRef],
            preconditions: [
              { fact: "Running ReviewRound has an exact Reviewer Run", satisfied: false, ref: reviewRef }
            ]
          });
        }
        const reviewRun = activeReviewRoundRun(activeReview, facts.activeRuns);
        if (reviewRun === undefined) {
          const runRef = ref("agent-run", activeReview.reviewerRunId);
          return buildAction(facts, {
            kind: "repair-protocol-inconsistency",
            reason: `ReviewRound ${activeReview.id} references Reviewer Run ${activeReview.reviewerRunId}, but that Run is not active.`,
            refs: [reviewRef, runRef],
            conflicts: [reviewRef, runRef],
            preconditions: [
              { fact: "Reviewer Run is active", satisfied: false, ref: runRef }
            ]
          });
        }
        return buildAction(facts, {
          kind: "wait-for-owned-execution",
          reason: `Reviewer Run ${reviewRun.id} is evaluating Candidate ${candidateReady.id}/${candidate?.id ?? "unknown"}.`,
          refs: [reviewRef, ref("agent-run", reviewRun.id)],
          preconditions: [
            { fact: "ReviewRound is running", satisfied: true, ref: reviewRef },
            { fact: "Reviewer Run is active", satisfied: true, ref: ref("agent-run", reviewRun.id) }
          ]
        });
      }
      if (activeReview.reviewerRunId !== undefined) {
        const runRef = ref("agent-run", activeReview.reviewerRunId);
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Pending ReviewRound ${activeReview.id} already references Reviewer Run ${activeReview.reviewerRunId}.`,
          refs: [reviewRef, runRef],
          conflicts: [reviewRef, runRef],
          preconditions: [
            { fact: "Pending ReviewRound has no Reviewer Run", satisfied: false, ref: runRef }
          ]
        });
      }
      return buildAction(facts, {
        kind: "resume-review",
        reason: `ReviewRound ${activeReview.id} is pending and never launched; resume it before accepting or rejecting the Candidate.`,
        refs: [reviewRef],
        preconditions: [
          { fact: "ReviewRound is pending", satisfied: true, ref: reviewRef },
          { fact: "Reviewer Run exists", satisfied: false }
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

  const activeWorkers = facts.activeRuns.filter((run) => run.roleName !== "leader");
  if (activeWorkers.length > 0) {
    return buildAction(facts, {
      kind: "wait-for-owned-execution",
      reason: `${activeWorkers.length} delegated Run(s) are active; wait for their delivery.`,
      refs: activeWorkers.map((run) => ref("agent-run", run.id)),
      preconditions: activeWorkers.map((run) => (
        { fact: `Delegated Run ${run.id} is active`, satisfied: true, ref: ref("agent-run", run.id) }
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
    return buildAction(facts, {
      kind: "implement-current-work-item",
      reason: `Work Item ${failedWork.id} failed without a Review verdict; retry implementation.`,
      refs: [ref("work-item", failedWork.id)],
      preconditions: [
        { fact: "Work Item is failed", satisfied: true, ref: ref("work-item", failedWork.id) }
      ],
      recommendedCommand: `yui task work update ${task.id}/${failedWork.id} running`
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
          reason: "Use one native implementer subagent when one bounded implementation pass benefits from parallel attention.",
          refs
        }
      ],
      judgmentRequired:
        "Leader must choose the execution path: direct execution, a native subagent, or managed Task Role dispatch."
    });
  }

  if (facts.workItems.length === 0) {
    return buildAction(facts, {
      kind: "implement-current-work-item",
      reason: `Task ${task.id} has no Work Item; create the first unit of work.`,
      refs: [],
      preconditions: [
        { fact: "At least one Work Item exists", satisfied: false },
        { fact: "Task is active", satisfied: task.status === "active" }
      ],
      recommendedCommand: `yui task work create ${task.id} \"<objective>\"`
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

  const unintegrated = facts.changeSets
    .find((changeSet) => !hasCommittedIntegration(facts.integrations, changeSet.id));
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

  const failedFinal = latestTaskFinalReview(facts.reviewRounds);
  if (failedFinal !== undefined && failedFinal.status === "failed") {
    return buildAction(facts, {
      kind: "route-review-findings",
      reason: `Task-final Review ${failedFinal.id} failed; route its open findings into a repair wave on one frozen head.`,
      refs: [ref("review-round", failedFinal.id)],
      preconditions: [
        { fact: "Task-final Review is failed", satisfied: true, ref: ref("review-round", failedFinal.id) }
      ],
      recommendedCommand: `yui task review finding repair-wave ${task.id} --create`
    });
  }

  const activeFinal = latestTaskFinalReview(facts.reviewRounds);
  if (activeFinal !== undefined
    && (activeFinal.status === "pending" || activeFinal.status === "running")) {
    const reviewRef = ref("review-round", activeFinal.id);
    if (activeFinal.status === "running") {
      if (reviewGroupAwaitingResolution(activeFinal)) {
        return buildResolveReviewGroupAction(facts, activeFinal);
      }
      if (activeFinal.reviewerRunId === undefined) {
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Task-final ReviewRound ${activeFinal.id} is running but has no Reviewer Run.`,
          refs: [reviewRef],
          conflicts: [reviewRef],
          preconditions: [
            { fact: "Running Task-final ReviewRound has an exact Reviewer Run", satisfied: false, ref: reviewRef }
          ]
        });
      }
      const reviewRun = activeReviewRoundRun(activeFinal, facts.activeRuns);
      if (reviewRun === undefined) {
        const runRef = ref("agent-run", activeFinal.reviewerRunId);
        return buildAction(facts, {
          kind: "repair-protocol-inconsistency",
          reason: `Task-final ReviewRound ${activeFinal.id} references Reviewer Run ${activeFinal.reviewerRunId}, but that Run is not active.`,
          refs: [reviewRef, runRef],
          conflicts: [reviewRef, runRef],
          preconditions: [
            { fact: "Reviewer Run is active", satisfied: false, ref: runRef }
          ]
        });
      }
      return buildAction(facts, {
        kind: "wait-for-owned-execution",
        reason: `Reviewer Run ${reviewRun.id} is executing Task-final Review ${activeFinal.id}.`,
        refs: [reviewRef, ref("agent-run", reviewRun.id)],
        preconditions: [
          { fact: "Task-final ReviewRound is running", satisfied: true, ref: reviewRef },
          { fact: "Reviewer Run is active", satisfied: true, ref: ref("agent-run", reviewRun.id) }
        ]
      });
    }
    if (activeFinal.reviewerRunId !== undefined) {
      const runRef = ref("agent-run", activeFinal.reviewerRunId);
      return buildAction(facts, {
        kind: "repair-protocol-inconsistency",
        reason: `Pending Task-final ReviewRound ${activeFinal.id} already references Reviewer Run ${activeFinal.reviewerRunId}.`,
        refs: [reviewRef, runRef],
        conflicts: [reviewRef, runRef],
        preconditions: [
          { fact: "Pending Task-final ReviewRound has no Reviewer Run", satisfied: false, ref: runRef }
        ]
      });
    }
    return buildAction(facts, {
      kind: "resume-review",
      reason: `Task-final ReviewRound ${activeFinal.id} is pending and never launched; retry it under the same semantic Round.`,
      refs: [reviewRef],
      preconditions: [
        { fact: "Task-final ReviewRound is pending", satisfied: true, ref: reviewRef },
        { fact: "Reviewer Run exists", satisfied: false }
      ],
      recommendedCommand: `yui task review retry ${task.id}/${activeFinal.id}`
    });
  }

  const finalReviewRequired = taskFinalReviewRequired(facts);
  if (task.projectBindings.length > 0
    && finalReviewRequired
    && !hasValidFinalReview(facts)) {
    const reviewerRole = taskFinalReviewRole(facts);
    return buildAction(facts, {
      kind: "request-final-review",
      reason: "All Work Items are delivered but no valid Task-final Review attests the integrated head.",
      refs: [ref("task", task.id)],
      preconditions: [
        { fact: "All Work Items are terminal", satisfied: true },
        { fact: "Every ChangeSet is committed", satisfied: true },
        { fact: "Valid Task-final Review at the integrated head", satisfied: false }
      ],
      recommendedCommand: `yui task review request ${task.id} --role ${reviewerRole ?? "<reviewer-role>"}`
    });
  }

  const finalReviewOptional = task.projectBindings.length > 0
    && !finalReviewRequired
    && !hasValidFinalReview(facts);
  const finalReviewAlternative = finalReviewOptional && facts.reviewConfig !== null
    ? [{
        kind: "request-final-review",
        reason: "Request an independent Task-final Review when the Leader wants extra assurance before completion.",
        recommendedCommand: `yui task review request ${task.id} --role ${facts.reviewConfig.roleName}`,
        refs: [ref("task", task.id)]
      }]
    : [];
  return buildAction(facts, {
    kind: "complete-task",
    reason: "The delivery chain is complete; converge the Task instead of creating successor work.",
    refs: [ref("task", task.id)],
    preconditions: [
      { fact: "All Work Items are terminal", satisfied: true },
      ...(task.projectBindings.length === 0
        ? []
        : [
            { fact: "Every ChangeSet is committed", satisfied: true },
            {
              fact: "Valid Task-final Review at the integrated head",
              satisfied: hasValidFinalReview(facts)
            }
          ])
    ],
    ...(finalReviewAlternative.length === 0 ? {} : { alternatives: finalReviewAlternative }),
    ...(!finalReviewOptional
      ? {}
      : {
          judgmentRequired:
            "Leader must decide whether the integrated delivery is safe to complete directly or needs an optional Task-final Review."
        }),
    recommendedCommand: `yui task complete ${task.id} --summary-file -`
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
  if (round.executionGroup !== undefined) {
    for (const lane of round.executionGroup.lanes) {
      if (lane.status !== "running"
        || lane.reviewRoundId !== round.id
        || lane.runId === undefined) {
        continue;
      }
      const run = activeRuns.find((candidate) => (
        candidate.id === lane.runId && candidate.roleName === lane.roleName
      ));
      if (run !== undefined) return run;
    }
    return undefined;
  }
  if (round.reviewerRunId === undefined) return undefined;
  return activeRuns.find((run) => (
    run.id === round.reviewerRunId && run.roleName === round.reviewerRoleName
  ));
}

const TERMINAL_REVIEW_LANE_STATUSES = new Set(["yielded", "completed", "failed"]);

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
  activeRuns: readonly AgentRun[]
): Inconsistency | null {
  const reviewRef = ref("review-round", round.id);
  if (round.status === "running") {
    if (reviewGroupAwaitingResolution(round)) {
      return null;
    }
    if (round.reviewerRunId === undefined) {
      return {
        reason: `ReviewRound ${round.id} is running but has no Reviewer Run.`,
        conflicts: [reviewRef]
      };
    }
    if (activeReviewRoundRun(round, activeRuns) === undefined) {
      const runRef = ref("agent-run", round.reviewerRunId);
      return {
        reason: `ReviewRound ${round.id} references Reviewer Run ${round.reviewerRunId}, but that Run is not active.`,
        conflicts: [reviewRef, runRef]
      };
    }
  }
  if (round.status === "pending") {
    const launchedRunId = round.reviewerRunId
      ?? round.executionGroup?.lanes.find((lane) => lane.runId !== undefined)?.runId;
    if (launchedRunId !== undefined) {
      const runRef = ref("agent-run", launchedRunId);
      return {
        reason: `Pending ReviewRound ${round.id} already references Reviewer Run ${launchedRunId}.`,
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
    item.dependsOn.every((dependencyId) => byId.get(dependencyId)?.status === "completed")
  ));
  if (eligible !== undefined) return { kind: "ready", item: eligible };

  let current: WorkItem | undefined = openItems[0];
  const visited = new Set<string>();
  while (current !== undefined) {
    if (visited.has(current.id)) {
      return { kind: "blocked", itemId: current.id, blockedBy: current.id };
    }
    visited.add(current.id);
    const blockedBy = current.dependsOn
      .find((dependencyId) => byId.get(dependencyId)?.status !== "completed");
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
  const contract = facts.workItems
    .flatMap((item) => item.candidates)
    .map((candidate) => candidate.taskFinalReviewContract)
    .find((contract) => contract !== undefined);
  return contract === undefined ? undefined : validateTaskFinalReviewContract(contract);
}

function taskFinalReviewRequired(facts: NextActionFacts): boolean {
  return taskFinalReviewContract(facts) !== undefined
    || latestTaskFinalReview(facts.reviewRounds) !== undefined
    || facts.reviewConfig?.trigger === "final";
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

function latestTaskFinalReview(rounds: readonly ReviewRound[]): ReviewRound | undefined {
  return [...rounds]
    .reverse()
    .find((round) => (round.scope ?? "work-item") === "task");
}

function hasCommittedIntegration(
  integrations: readonly IntegrationAttempt[],
  changeSetId: string
): boolean {
  return integrations.some((attempt) =>
    attempt.status === "committed" && attempt.changeSetIds.includes(changeSetId));
}

function needsChangeSetCapture(facts: NextActionFacts, item: WorkItem): boolean {
  if (item.status !== "completed") return false;
  if (facts.changeSets.some((changeSet) => changeSet.workItemId === item.id)) return false;
  const candidate = item.candidates.at(-1);
  if (candidate === undefined) return false;
  // A metadata-only direct Task-main Candidate has no WorkItem Develop
  // workspace to capture; its boundary is the Task-main head itself.
  if (candidate.workspace === undefined
    && candidate.gitSnapshot === undefined
    && candidate.taskMainSnapshot !== undefined) {
    return false;
  }
  return candidate.workspace !== undefined || candidate.gitSnapshot !== undefined;
}

function hasValidFinalReview(facts: NextActionFacts): boolean {
  const final = latestTaskFinalReview(facts.reviewRounds);
  if (final === undefined || final.status !== "completed") return false;
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
  if (integratedHeads.size === 0) return false;
  for (const head of integratedHeads) {
    if (!reviewedCommits.has(head)) return false;
  }
  return true;
}

type Inconsistency = Readonly<{
  reason: string;
  conflicts: readonly NextActionRef[];
  recommendedCommand?: string;
}>;

function detectProtocolInconsistency(facts: NextActionFacts): Inconsistency | null {
  const changeSetIds = new Set(facts.changeSets.map((changeSet) => changeSet.id));
  const workItemById = new Map(facts.workItems.map((item) => [item.id, item]));

  const contractedCandidates = facts.workItems
    .flatMap((item) => item.candidates.map((candidate) => ({ item, candidate })))
    .filter(({ candidate }) => candidate.taskFinalReviewContract !== undefined);
  if (contractedCandidates.length > 1) {
    const first = validateTaskFinalReviewContract(contractedCandidates[0]!.candidate.taskFinalReviewContract!);
    const conflict = contractedCandidates.find(({ candidate }) => (
      !sameTaskFinalReviewContract(first, candidate.taskFinalReviewContract)
    ));
    if (conflict !== undefined) {
      const refs = contractedCandidates.map(({ item, candidate }) =>
        ref("candidate", `${item.id}/${candidate.id}`));
      return {
        reason: "Task-final Review contracts conflict across Candidates; the completion gate is ambiguous.",
        conflicts: refs
      };
    }
  }

  for (const round of facts.reviewRounds) {
    const reviewConflict = reviewRoundConflict(round, facts.activeRuns);
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
