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
  extractReviewFindings,
  planRepairWave,
  type RepairWave
} from "../task/repairWave.js";

/**
 * Issue 07 (Leader convergence): read-only `yui task next-action <task>`.
 * Folds the existing durable records into exactly one protocol-level next
 * action with exact refs, preconditions, recommended command, alternatives, and
 * the judgment that remains owned by the Leader.
 * The command never mutates state; when the action is `route-review-findings`
 * it also prints the minimal repair wave for the failing Review.
 *
 * Issue 06: when the recommended action is `complete-task`, the output also
 * carries the full `completionReadiness` blocker list so the Leader sees every
 * terminalization precondition before attempting `yui task complete`.
 */
export function runTaskNextActionCommand(
  args: string[],
  store: TaskStore
): { kind: "output"; output: string; data?: unknown } {
  const usage = "Task next-action usage: yui task next-action <task> [--json].";
  const positionals = args.filter((arg) => arg !== "--json");
  const asJson = args.includes("--json");
  if (positionals.length !== 1 || positionals[0]?.trim().length === 0) {
    throw usageError(usage);
  }
  const taskId = positionals[0].trim();
  const data = store.transaction((reader) => {
    // Issue 06: the lightweight facts drive the action on every call; the
    // heavier readiness facts (full event fold, workspaces, jobs, ledger) are
    // loaded only when the action is `complete-task`, keeping the per-turn
    // read path cheap during execution.
    const facts = reader.readNextActionFacts(taskId);
    if (facts === null) throw taskNotFound(taskId);
    const action = projectNextAction(facts);
    const repairWave = repairWaveFor(action, facts);
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
    return { action, repairWave, completionReadiness, knowledgeProposals };
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
      data.repairWave,
      data.completionReadiness,
      data.knowledgeProposals
    ),
    data
  };
}

function repairWaveFor(
  action: NextAction,
  facts: NextActionFacts
): RepairWave | null {
  if (action.kind !== "route-review-findings") return null;
  const reviewRef = action.refs.find((ref) => ref.kind === "review-round");
  if (reviewRef === undefined) return null;
  const round = facts.reviewRounds.find((candidate) => candidate.id === reviewRef.id);
  if (round === undefined) return null;
  const findings = extractReviewFindings(round);
  if (findings.length === 0) return null;
  return planRepairWave(round.id, findings);
}

function renderNextAction(
  action: NextAction,
  repairWave: RepairWave | null,
  completionReadiness: CompletionReadiness | null,
  knowledgeProposals: readonly {
    projectId: string;
    proposalId: string;
    title: string;
    sourceTaskId: string;
  }[]
): string {
  const lines = [
    `Task: ${action.taskId}`,
    `Next action: ${action.kind}`,
    `Reason: ${action.reason}`,
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
  }
  if (repairWave !== null) {
    lines.push(
      `Repair wave (${repairWave.openFindingCount} open finding(s), ${repairWave.groups.length} group(s)):`,
      ...repairWave.groups.map((group) =>
        `  ${group.id}: findings ${group.findingIds.join(", ")}`
        + ` — paths ${group.paths.length === 0 ? "none" : group.paths.join(", ")}`
        + ` — ${group.reason}`)
    );
  }
  if (knowledgeProposals.length > 0) {
    lines.push(
      `Knowledge proposals (non-blocking): ${knowledgeProposals.length} pending`,
      ...knowledgeProposals.map((proposal) =>
        `  ${proposal.projectId}/${proposal.proposalId}: ${proposal.title}`
        + ` — review: yui project knowledge proposals list ${proposal.projectId}`)
    );
  }
  return `${lines.join("\n")}\n`;
}
