import { taskNotFound, usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  projectNextAction,
  type NextAction,
  type NextActionFacts
} from "../task/nextAction.js";
import {
  projectCompletionReadiness,
  type CompletionReadiness
} from "../task/completionReadiness.js";
import {
  projectTaskOrchestration,
  type OrchestrationAdvisory
} from "../observability/orchestrationMetrics.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import {
  buildTaskExecutionProjection,
  type TaskExecutionProjection,
  type TaskExecutionTurn
} from "../scheduler/taskExecutionProjection.js";
import {
  projectReviewDecision,
  type ReviewDecisionProjection
} from "../review/reviewDecision.js";
import type { TaskReviewCandidate } from "../review/reviewRound.js";
import {
  projectTaskRemoteDeliveryFromStore,
  renderTaskRemoteDelivery
} from "./taskRemoteDeliveryCommand.js";

type NextActionExecutionView = Readonly<Pick<
  TaskExecutionProjection,
  "status" | "owner" | "action" | "reason" | "summary" | "activeTurns"
>>;

/**
 * Issue 07 (Leader convergence): read-only `yui task next-action <task>`.
 * Folds the existing durable records into exactly one protocol-level next
 * action with exact refs, preconditions, recommended command, alternatives, and
 * the judgment that remains owned by the Leader.
 * The command never mutates state and never interprets Agent result text.
 *
 * Issue 06: when the recommended action is `complete-task`, the output also
 * carries the full `completionReadiness` blocker list so the Leader sees every
 * terminalization precondition before attempting `yui task complete`.
 */
export function runTaskNextActionCommand(
  args: string[],
  store: TaskStore,
  currentTaskReviewCandidate: TaskReviewCandidate | null = null
): { kind: "output"; output: string; data?: unknown } {
  const usage = "Task next-action usage: yui task next-action <task> [--json].";
  const positionals = args.filter((arg) => arg !== "--json");
  const asJson = args.includes("--json");
  if (positionals.length !== 1 || positionals[0]?.trim().length === 0) {
    throw usageError(usage);
  }
  const taskId = positionals[0].trim();
  const now = new Date();
  const data = store.transaction((reader) => {
    // Issue 06: the lightweight facts drive the action on every call; the
    // heavier readiness facts (full event fold, workspaces, jobs, ledger) are
    // loaded only when the action is `complete-task`, keeping the per-turn
    // read path cheap during execution.
    const facts = reader.readNextActionFacts(taskId);
    if (facts === null) throw taskNotFound(taskId);
    const execution = buildTaskExecutionProjection(reader, taskId, undefined, now);
    if (execution === null) throw taskNotFound(taskId);
    const actionFacts: NextActionFacts = {
      ...facts,
      currentTaskReviewCandidate,
      executionGroups: execution.executionGroups
    };
    const action = projectNextAction(actionFacts);
    // Issue 12: surface pending Knowledge promotion proposals for the Task's
    // bound Projects as a non-blocking advisory. The proposals are workflow
    // state, not completion blockers: an Operator reviews them separately.
    const knowledgeProposals = facts.task.projectBindings.flatMap((binding) => {
      const project = reader.getProject(binding.projectId);
      if (project === null) return [];
      return project.knowledgeProposals
        .filter((proposal) => proposal.status === "pending")
        .map((proposal) => ({
          projectId: binding.projectId,
          proposalId: proposal.id,
          title: proposal.title,
          sourceTaskId: proposal.source.taskId
        }));
    });
    let completionReadiness: CompletionReadiness | null = null;
    if (action.kind === "complete-task") {
      const readinessFacts = reader.readCompletionReadinessFacts(taskId);
      if (readinessFacts === null) throw taskNotFound(taskId);
      completionReadiness = projectCompletionReadiness(readinessFacts);
    }
    const events = reader.listEvents(taskId);
    const task = reader.getTask(taskId)!;
    const remoteDelivery = projectTaskRemoteDeliveryFromStore(
      reader,
      task,
      currentTaskReviewCandidate
    );
    const operationalTurns = operationalTaskRecords(
      reader.listTurns(taskId),
      events,
      "turn"
    );
    const reviewRounds = reader.listReviewRounds(taskId);
    const reviewDecision = projectReviewDecision({
      store: reader,
      task,
      roles: reader.listRoles(taskId),
      turns: operationalTurns,
      rounds: reviewRounds,
      reviewConfig: reader.getReviewConfig(),
      currentCandidate: currentTaskReviewCandidate
    });
    const orchestration = projectTaskOrchestration({
      task,
      turns: operationalTurns,
      roleSessionSets: reader.listRoleSessionSets(taskId),
      workItems: reader.listWorkItems(taskId),
      changeSets: reader.listChangeSets(taskId),
      reviewRounds,
      integrations: reader.listIntegrationAttempts(taskId),
      durableJobs: reader.listDurableJobs(taskId),
      publications: reader.listPublicationReferences(taskId),
      decisions: reader.listDecisions(taskId),
      events,
      managedWorkspaces: reader.listManagedWorkspaces(taskId)
    });
    return {
      taskType: facts.task.type ?? null,
      action,
      completionReadiness,
      knowledgeProposals,
      reviewDecision,
      execution: nextActionExecutionView(execution),
      orchestration,
      remoteDelivery
    };
  });
  if (asJson) {
    return {
      kind: "output" as const,
      output: `${JSON.stringify(data, null, 2)}\n`,
      data
    };
  }
  return {
    kind: "output" as const,
    output: renderNextAction(
      data.action,
      data.taskType,
      data.completionReadiness,
      data.knowledgeProposals,
      data.reviewDecision,
      data.execution,
      data.orchestration.advisories,
      data.remoteDelivery
    ),
    data
  };
}

function renderNextAction(
  action: NextAction,
  taskType: string | null,
  completionReadiness: CompletionReadiness | null,
  knowledgeProposals: readonly {
    projectId: string;
    proposalId: string;
    title: string;
    sourceTaskId: string;
  }[],
  reviewDecision: ReviewDecisionProjection,
  execution: NextActionExecutionView,
  orchestrationAdvisories: readonly OrchestrationAdvisory[],
  remoteDelivery: ReturnType<typeof projectTaskRemoteDeliveryFromStore>
): string {
  const lines = [
    `Task: ${action.taskId}`,
    `Type: ${taskType ?? "unspecified"}`,
    renderTaskRemoteDelivery(remoteDelivery).trimEnd(),
    `Next action: ${action.kind}`,
    `Reason: ${action.reason}`,
    `Execution view: ${execution.status}; owner/action=${execution.owner}/${execution.action}; reason=${execution.reason}; ${execution.summary}`,
    `Active Turns (${execution.activeTurns.length}):`,
    ...(execution.activeTurns.length === 0
      ? ["  none"]
      : execution.activeTurns.map((run) => `  ${renderActiveTurn(run)}`)),
    ...(action.refs.length === 0
      ? ["Refs: none"]
      : ["Refs:", ...action.refs.map((ref) => `  ${ref.kind}: ${ref.id}`)]),
    "Preconditions:",
    ...action.preconditions.map((precondition) => {
      const ref = precondition.ref === undefined
        ? ""
        : ` (${precondition.ref.kind} ${precondition.ref.id})`;
      return `  ${precondition.satisfied ? "[x]" : "[ ]"} ${precondition.fact}${ref}`;
    }),
    ...(action.recommendedCommand === undefined
      ? []
      : [`Recommended: ${action.recommendedCommand}`]),
    ...(action.judgmentRequired === undefined
      ? []
      : [`Judgment: ${action.judgmentRequired}`]),
    `Review state: active=${reviewDecision.activeReviews.length}; reviewers=${reviewDecision.reviewers
      .map(({ reviewerRoleName, status }) => `${reviewerRoleName}:${status}`).join(", ") || "none"}`,
    ...(reviewDecision.activeReviews.length === 0
      ? []
      : [
          "Frozen Reviews: " + reviewDecision.activeReviews.map((review) => (
            `${review.reviewRoundId}/${review.reviewerRoleName}`
              + `[${review.status}; current=${review.candidateRelation}; `
              + `${review.frozenCandidate?.projects.map(({ projectId, commit }) => (
                `${projectId}@${commit.slice(0, 12)}`
              )).join(", ") ?? "heads-unavailable"}]`
          )).join("; ")
        ]),
    `Delta support: ${reviewDecision.delta.technicalAvailability}; ${reviewDecision.delta.reason}`,
    ...(action.alternatives === undefined || action.alternatives.length === 0
      ? []
      : [
          "Alternatives:",
          ...action.alternatives.map((alternative) => {
            const command = alternative.recommendedCommand === undefined
              ? ""
              : ` — ${alternative.recommendedCommand}`;
            return `  ${alternative.kind}: ${alternative.reason}${command}`;
          })
        ]),
    ...(action.conflicts === undefined || action.conflicts.length === 0
      ? []
      : [
          "Conflicts:",
          ...action.conflicts.map((conflict) => `  ${conflict.kind}: ${conflict.id}`)
        ])
  ];
  if (completionReadiness !== null) {
    if (completionReadiness.ready) {
      lines.push("Completion readiness: ready (no blockers)");
    } else {
      lines.push(
        `Completion readiness: ${completionReadiness.blockers.length} blocker(s)`,
        ...completionReadiness.blockers.map((blocker) =>
          `  ${blocker.code} (${blocker.ref.kind} ${blocker.ref.id}): ${blocker.reason}`
          + ` — fix: ${blocker.fix}`)
      );
    }
    if (completionReadiness.advisories.length > 0) {
      lines.push(
        `Completion advisories (non-blocking): ${completionReadiness.advisories.length}`,
        ...completionReadiness.advisories.map((advisory) =>
          `  ${advisory.code} (${advisory.ref.kind} ${advisory.ref.id}): ${advisory.reason}`
          + ` — fix before archive: ${advisory.fix}`)
      );
    }
  }
  if (knowledgeProposals.length > 0) {
    lines.push(
      `Knowledge proposals (non-blocking): ${knowledgeProposals.length} pending`,
      ...knowledgeProposals.map((proposal) =>
        `  ${proposal.projectId}/${proposal.proposalId}: ${proposal.title}`
        + ` — review: yui project knowledge proposals list ${proposal.projectId}`)
    );
  }
  if (orchestrationAdvisories.length > 0) {
    lines.push(
      `Orchestration advisories (non-blocking): ${orchestrationAdvisories.length}`,
      ...orchestrationAdvisories.map((advisory) =>
        `  ${advisory.code}: ${advisory.reason}`
        + (advisory.refs.length === 0 ? "" : ` — refs ${advisory.refs.join(", ")}`))
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderActiveTurn(run: TaskExecutionTurn): string {
  const subject = run.reviewRoundId === undefined
    ? run.workItemId === undefined ? "task" : `work-item=${run.workItemId}`
    : `review-round=${run.reviewRoundId}`;
  const lane = run.executionGroupId === undefined
    ? ""
    : `; group=${run.executionGroupId}${
      run.executionLaneId === undefined ? "" : `; lane=${run.executionLaneId}`
    }`;
  return `${run.id} [${run.purpose}/${run.status}; role=${run.roleName}; ${
    `provider-${run.providerSession}`
  }; ${subject}${lane}]`;
}

function nextActionExecutionView(
  execution: TaskExecutionProjection
): NextActionExecutionView {
  return {
    status: execution.status,
    owner: execution.owner,
    action: execution.action,
    reason: execution.reason,
    summary: execution.summary,
    activeTurns: execution.activeTurns
  };
}
