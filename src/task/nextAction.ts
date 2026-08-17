import { createHash } from "node:crypto";

import type { InputRequest } from "../input/inputRequest.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { AgentRun } from "../run/agentRun.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { Task } from "./task.js";
import { currentWorkItemCandidate, type WorkItem } from "../workItem/workItem.js";

/**
 * Issue 07 (Leader convergence): a read-only projection that folds the
 * existing durable Task records into exactly one protocol-level next action.
 *
 * This module is deliberately pure: it never starts a Controller, writes a
 * record, or performs a Git inspection. Every value is derived from records
 * that already exist, and every fallback is conservative — when the records
 * do not uniquely determine an action, the projection returns
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

export type NextAction = Readonly<{
  taskId: string;
  kind: NextActionKind;
  reason: string;
  /** Exact record IDs that prove the state or that the action operates on. */
  refs: readonly NextActionRef[];
  preconditions: readonly NextActionPrecondition[];
  /** The single recommended CLI command, when one exists. */
  recommendedCommand?: string;
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
      recommendedCommand: `yui task work accept ${task.id}/${candidateReady.id} --summary \"<decision>\"`
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
        ]
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

  const openWork = facts.workItems
    .find((item) => OPEN_WORK_ITEM_STATUSES.has(item.status));
  if (openWork !== undefined) {
    return buildAction(facts, {
      kind: "implement-current-work-item",
      reason: `Work Item ${openWork.id} is ${openWork.status}; dispatch or continue its implementation.`,
      refs: [ref("work-item", openWork.id)],
      preconditions: [
        { fact: `Work Item is ${openWork.status}`, satisfied: true, ref: ref("work-item", openWork.id) }
      ],
      recommendedCommand: `yui task work dispatch ${task.id}/${openWork.id}`
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
      recommendedCommand: task.status === "draft"
        ? `yui task activate ${task.id}`
        : `yui task work create ${task.id} \"<objective>\"`
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
      ]
    });
  }

  if (task.projectBindings.length > 0 && !hasValidFinalReview(facts)) {
    return buildAction(facts, {
      kind: "request-final-review",
      reason: "All Work Items are delivered but no valid Task-final Review attests the integrated head.",
      refs: [ref("task", task.id)],
      preconditions: [
        { fact: "All Work Items are terminal", satisfied: true },
        { fact: "Every ChangeSet is committed", satisfied: true },
        { fact: "Valid Task-final Review at the integrated head", satisfied: false }
      ],
      recommendedCommand: `yui task review request ${task.id} --role <global-reviewer>`
    });
  }

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
            { fact: "Valid Task-final Review at the integrated head", satisfied: true }
          ])
    ],
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
    ...(input.conflicts === undefined ? {} : { conflicts: input.conflicts }),
    fingerprint: createHash("sha256").update(fingerprintSource).digest("hex")
  };
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
