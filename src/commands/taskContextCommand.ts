import { taskNotFound, usageError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { InputRequest } from "../input/inputRequest.js";
import { taskMessageAuthorLabel } from "../message/message.js";
import { formatTimestamp } from "../output/timePresentation.js";
import type { TaskStore } from "../storage/taskStore.js";
import { isRoleRunStalled, latestStallProgressAt } from "../scheduler/roleRunStall.js";
import { buildTaskExecutionProjection } from "../scheduler/taskExecutionProjection.js";
import type { WorkItemObservabilityProjection } from "../scheduler/taskObservabilityProjection.js";
import { projectNextAction } from "../task/nextAction.js";
import {
  summarizeExecutionGroup,
  type ExecutionGroup,
  type ExecutionGroupSummary
} from "../execution/executionGroup.js";
import type { ExecutionGroupHealthSummary } from "../execution/executionHealth.js";
import { currentWorkItemExecutionGroup } from "../workItem/workItem.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import { projectReviewDecision } from "../review/reviewDecision.js";
import type { TaskReviewCandidate } from "../review/reviewRound.js";

const RECENT_RECORD_LIMIT = 5;
const RELATED_RECORD_LIMIT = 5;
const SUMMARY_TEXT_LIMIT = 400;
const TERMINAL_WORK_ITEM_STATUSES = new Set([
  "completed",
  "failed",
  "retired"
]);

export function runTaskContextCommand(
  args: string[],
  store: TaskStore,
  currentTaskReviewCandidate: TaskReviewCandidate | null = null
) {
  if (args.length !== 1 || args[0]?.trim().length === 0) {
    throw usageError("Task context usage: yui task context <task>.");
  }
  const taskId = args[0].trim();
  const now = new Date();
  const data = store.transaction((reader) => {
    const task = reader.getTask(taskId);
    if (task === null) throw taskNotFound(taskId);
    const workItems = reader.listWorkItems(task.id);
    const inputRequests = reader.listInputRequests(task.id);
    const roles = reader.listRoles(task.id);
    const execution = buildTaskExecutionProjection(reader, task.id, task, now);
    if (execution === null) {
      throw new Error(`Task execution projection disappeared: ${task.id}.`);
    }
    const roleSessionSets = reader.listRoleSessionSets(task.id);
    const coordinationMailboxes = [
      reader.getWorkMailbox({ kind: "task", taskId: task.id }),
      ...roles.map((role) => reader.getWorkMailbox({
        kind: "role" as const,
        taskId: task.id,
        roleName: role.name
      }))
    ].filter((mailbox): mailbox is NonNullable<typeof mailbox> => mailbox !== null);
    const events = reader.listEvents(task.id);
    const agentRuns = chronological(operationalTaskRecords(
      reader.listAgentRuns(task.id),
      events,
      "agent-run"
    ));
    const reviewRounds = chronological(reader.listReviewRounds(task.id));
    const reviewConfig = reader.getReviewConfig();
    const changeSets = chronological(reader.listChangeSets(task.id));
    const integrations = chronological(reader.listIntegrationAttempts(task.id));
    const publications = chronological(reader.listPublicationReferences(task.id));
    const nextActionFacts = reader.readNextActionFacts(task.id);
    if (nextActionFacts === null) {
      throw new Error(`Task next-action facts disappeared: ${task.id}.`);
    }
    return {
      task,
      execution,
      reviewConfig,
      reviewDecision: projectReviewDecision({
        store: reader,
        task,
        roles,
        runs: agentRuns,
        rounds: reviewRounds,
        reviewConfig,
        currentCandidate: currentTaskReviewCandidate
      }),
      brief: reader.getTaskBrief(task.id),
      activeDecisions: reader.listDecisions(task.id)
        .filter((decision) => decision.status === "active"),
      milestones: reader.listMilestones(task.id),
      roles,
      managedWorkspaces: reader.listManagedWorkspaces(task.id),
      roleSessionSets,
      coordinationMailboxes,
      workItems,
      agentRuns,
      reviewRounds,
      changeSets,
      integrations,
      publications,
      messages: operationalTaskRecords(reader.listMessages(task.id), events, "message"),
      openInputRequests: inputRequests.filter((request) => request.status === "open"),
      resolvedInputRequests: inputRequests.filter((request) => request.status !== "open"),
      events,
      nextAction: projectNextAction({
        ...nextActionFacts,
        currentTaskReviewCandidate,
        executionGroups: execution.executionGroups
      })
    };
  });
  const {
    task,
    execution,
    reviewConfig,
    reviewDecision,
    brief,
    activeDecisions,
    milestones,
    roles,
    managedWorkspaces,
    roleSessionSets,
    coordinationMailboxes,
    workItems,
    agentRuns,
    reviewRounds,
    changeSets,
    integrations,
    publications,
    messages,
    openInputRequests,
    resolvedInputRequests,
    events,
    nextAction
  } = data;
  const timeZone = store.getConfig().timeZone;
  const displayedActiveDecisions = activeDecisions.slice(-RECENT_RECORD_LIMIT);
  const displayedWorkItems = currentAndRecentWorkItems(workItems);
  const displayedOpenInputRequests = openInputRequests.slice(-RECENT_RECORD_LIMIT);
  const displayedResolvedInputRequests = resolvedInputRequests.slice(-RECENT_RECORD_LIMIT);
  const displayedActiveRuns = execution.activeRuns;
  const executionGroupsById = new Map(execution.executionGroups.map((group) => [
    group.groupId,
    group
  ]));
  const observability = execution.observability;

  const lines = [
    `Task context: ${task.id}`,
    `Title: ${compactText(task.title)}`,
    `Status: ${task.status}`,
    "Next action:",
    `  ${nextAction.kind}: ${nextAction.reason}`,
    ...(nextAction.refs.length === 0
      ? []
      : [`  Refs: ${nextAction.refs.map(({ kind, id }) => `${kind} ${id}`).join(", ")}`]),
    ...(nextAction.recommendedCommand === undefined
      ? []
      : [`  Recommended: ${nextAction.recommendedCommand}`]),
    ...(nextAction.judgmentRequired === undefined
      ? []
      : [`  Judgment: ${nextAction.judgmentRequired}`]),
    ...(nextAction.alternatives === undefined || nextAction.alternatives.length === 0
      ? []
      : [
          "  Alternatives:",
          ...nextAction.alternatives.map((alternative) =>
            `    ${alternative.kind}: ${alternative.reason}`)
        ]),
    ...(task.description === undefined ? [] : [`Description: ${compactText(task.description)}`]),
    ...(task.priority === undefined ? [] : [`Priority: ${task.priority}`]),
    ...(task.tags === undefined ? [] : [`Tags: ${task.tags.join(", ")}`]),
    ...(task.dueAt === undefined ? [] : [`Due: ${formatTimestamp(task.dueAt, timeZone)}`]),
    ...(task.completionSummary === undefined ? [] : [`Completion summary: ${task.completionSummary}`]),
    ...(task.retirementSummary === undefined ? [] : [`Retirement summary: ${task.retirementSummary}`]),
    ...(task.replacementTaskId === undefined ? [] : [`Replacement Task: ${task.replacementTaskId}`]),
    ...(task.archiveSummary === undefined ? [] : [`Archive summary: ${task.archiveSummary}`]),
    "Execution:",
    `  Status: ${execution.status}`,
    `  Owner/action: ${execution.owner}/${execution.action}`,
    `  Monitoring: ${execution.monitoring}`,
    `  Fail-closed: ${execution.failClosed ? "yes" : "no"}`,
    `  Reason: ${execution.reason}`,
    `  Attention: ${execution.attention.length === 0
      ? "none"
      : execution.attention.map(({ kind, owner }) => `${kind}/${owner}`).join(", ")}`,
    `  Active AgentRuns (${displayedActiveRuns.length}):`,
    ...(displayedActiveRuns.length === 0
      ? ["    None."]
      : displayedActiveRuns.map((run) => (
          `    ${run.roleName}: ${run.id} [${run.status}/${run.purpose}; ${
            run.delivered ? "accepted" : "delivery-pending"
          }${run.workItemId === undefined ? "" : `; work-item=${run.workItemId}`}${
            run.reviewRoundId === undefined ? "" : `; review-round=${run.reviewRoundId}`
          }${run.executionGroupId === undefined ? "" : `; group=${run.executionGroupId}`}${
            run.executionLaneId === undefined ? "" : `; lane=${run.executionLaneId}`
          }]`
        ))),
    "Observability:",
    `  DAG: ${observability.dag.nodes.length} node(s), ${observability.dag.edges.length} edge(s); ready=${observability.dag.readyIds.join(", ") || "none"}; blocked=${observability.dag.blockedIds.join(", ") || "none"}`,
    `  Cost: tokens=${resourceUsageLabel(observability.cost.tokens, undefined, observability.cost.tokensObservable)}; tools=${resourceUsageLabel(observability.cost.toolCalls, undefined, observability.cost.toolCallsObservable)}; wall=${observability.cost.wallClockSeconds}s; lanes=${observability.cost.laneCount}; groups=${observability.cost.groupCount}; retries=${observability.cost.retryCount}; marginal-value=unavailable`,
    `  Context: snapshots=${observability.context.snapshotCount}; bytes=${observability.context.totalBytes === null ? "partial" : observability.context.totalBytes}; compression=unavailable`,
    "  Session tokens:",
    ...(observability.sessionTokens.length === 0
      ? ["    unobserved"]
      : observability.sessionTokens.map(({ roleName, agentId, metrics }) => {
          const total = metrics.cumulativeTotal.status === "observed"
            ? metrics.cumulativeTotal.totalTokens
            : "unobserved";
          const maximum = metrics.maximumRequestInput.status === "observed"
            ? metrics.maximumRequestInput.inputTokens
            : "unobserved";
          return `    ${roleName}/${agentId}: total=${total}; max-request-input=${maximum}`;
        })),
    ...(task.projectBindings.length === 0
      ? []
      : [
          "Projects:",
          ...task.projectBindings.map((binding) => (
            `- ${binding.directory}: ${binding.projectId} @ ${binding.baseRef}`
          ))
        ]),
    ...(task.cwd === undefined ? [] : [`Workspace: ${task.cwd}`]),
    `Managed Workspaces (${managedWorkspaces.length}):`,
    ...(managedWorkspaces.length === 0
      ? ["  None."]
      : managedWorkspaces.map((workspace) => (
          `  ${managedWorkspaceLabel(workspace)}: ${workspace.root} (${
            workspace.entries.filter(({ access }) => access === "write").length
          } writable / ${workspace.entries.length} Projects)`
        ))),
    `Type: ${task.type ?? "unspecified"}`,
    `Execution topology: ${workItems.length === 0
      ? "Leader-owned Task main"
      : `${workItems.length} independently owned WorkItem(s), integrated on Task main`}`,
    `Completion evidence: ${task.projectBindings.length === 0
      ? "no Project evidence required"
      : workItems.length === 0
        ? "clean committed Task main required"
        : "each delivered WorkItem requires a ChangeSet and committed Integration"}`,
    `Global review: ${reviewConfig === null
      ? "disabled"
      : `${reviewConfig.roleName} (${reviewConfig.trigger})`}`,
    "Review decision support:",
    `  Current durable heads: ${reviewDecision.currentCandidate?.projects
      .map(({ projectId, commit }) => `${projectId}@${commit.slice(0, 12)}`).join(", ")
      ?? "unavailable"}`,
    "  Active Reviews:",
    ...(reviewDecision.activeReviews.length === 0
      ? ["    - none"]
      : reviewDecision.activeReviews.map((review) => (
          `    - ${review.reviewRoundId}/${review.reviewerRoleName}/${review.mode}`
            + ` [${review.status}; current=${review.candidateRelation}]`
            + ` heads=${review.frozenCandidate?.projects.map(({ projectId, commit }) => (
              `${projectId}@${commit.slice(0, 12)}`
            )).join(", ") ?? "unavailable"}`
            + `${review.workspaceRoot === undefined
              ? ""
              : ` workspace=${review.workspaceRoot}`}`
        ))),
    `  Reviewer slots: ${reviewDecision.reviewers.length === 0
      ? "none configured"
      : reviewDecision.reviewers.map((reviewer) => (
          `${reviewer.reviewerRoleName}=${reviewer.status}`
            + `${reviewer.activeRunId === undefined ? "" : `(${reviewer.activeRunId})`}`
        )).join(", ")}`,
    `  Accepted baseline: ${reviewDecision.latestAcceptedBaseline === null
      ? "none"
      : `${reviewDecision.latestAcceptedBaseline.reviewRoundId}`
        + ` [${reviewDecision.latestAcceptedBaseline.relationToCurrent}]`}`,
    `  Delta: ${reviewDecision.delta.technicalAvailability}; ${reviewDecision.delta.reason}`,
    "",
    "Brief:",
    ...(brief === null
      ? ["  No brief."]
      : [
          `  Objective: ${compactText(brief.objective)}`,
          "  Boundaries:",
          ...(brief.boundaries.length === 0
            ? ["    None."]
            : brief.boundaries.map((boundary) => `    - ${compactText(boundary)}`)),
          `  Technical approach: ${
            brief.technicalApproach.length === 0
              ? "Not defined."
              : compactText(brief.technicalApproach)
          }`,
          `  Current focus: ${compactText(brief.currentFocus)}`,
          `  Leader summary: ${compactText(brief.leaderSummary)}`,
          `  Updated by ${brief.updatedBy} at ${formatTimestamp(brief.updatedAt, timeZone)}`
        ]),
    "",
    `Active decisions (${displayedActiveDecisions.length}${activeDecisions.length > displayedActiveDecisions.length ? ` of ${activeDecisions.length}` : ""}):`,
    ...(displayedActiveDecisions.length === 0
      ? ["  None."]
      : displayedActiveDecisions.flatMap((decision) => [
          `  ${decision.id}: ${compactText(decision.title)}`,
          `    Rationale: ${compactText(decision.rationale)}`
        ])),
    "",
    ...recentSection(
      "milestones",
      milestones,
      (milestone) => [
        `  ${milestone.id}: ${compactText(milestone.title)} (${formatTimestamp(milestone.createdAt, timeZone)})`,
        `    ${compactText(milestone.summary)}`
      ]
    ),
    "",
    `Task Roles (${roles.length}):`,
    ...(roles.length === 0
      ? ["  None."]
      : roles.flatMap((role) => {
          const binding = role.agentBindings[role.activeAgentId];
          const activeRun = agentRuns.find((run) => (
            run.roleName === role.name && run.status === "active"
          ));
          const sessions = roleSessionSets.find((set) => set.owner.roleName === role.name);
          const activeSession = sessions?.sessions[sessions.activeAgentId];
          const effective = activeRun?.effective ?? activeSession?.effective;
          const effectiveSource = activeRun === undefined ? "Session" : "Run";
          const creation = [...events].reverse().find((event) => (
            event.type === "role.added" && event.payload.role === role.name
          ));
          return [
            `  ${role.name} [${role.status}]: ${role.activeAgentId}/${binding.adapterId}`,
            `    Desired: r${role.launchRevision}; Profile intent: ${role.defaultAccess}; Model: ${binding.config.model ?? "default"}; effort: ${binding.config.effort ?? "default"}; permission: ${binding.config.permission.strategy}`,
            `    Effective: ${effective === undefined
              ? "not started"
              : `${effectiveSource} ${effective.agentId}/${effective.adapterId}; r${effective.sourceDesiredRevision}; Profile intent: ${effective.profileAccess}; permission: ${effective.permission.strategy}`}`,
            `    Desired drift: ${effective === undefined
              ? "-"
              : effective.sourceDesiredRevision === role.launchRevision
                ? "none"
                : "pending next launch"}`,
            ...(creation?.payload.runtimeSource === undefined
              ? []
              : [`    Runtime source at creation: ${creation.payload.runtimeSource}`])
          ];
        })),
    "",
    `Coordination mailboxes (${coordinationMailboxes.length}):`,
    ...(coordinationMailboxes.length === 0
      ? ["  None."]
      : coordinationMailboxes.flatMap(renderCoordinationMailbox)),
    "",
    `Current and recent work items (${displayedWorkItems.length}${workItems.length > displayedWorkItems.length ? ` of ${workItems.length}` : ""}):`,
    ...(displayedWorkItems.length === 0
      ? ["  None."]
      : displayedWorkItems.flatMap((item) => {
          const itemRuns = agentRuns.filter((run) => run.workItemId === item.id);
          const latestRun = itemRuns.at(-1);
          return [
            `  ${item.id} [${item.status}]: ${compactText(item.title)}`,
            `    Objective: ${compactText(item.objective)}`,
            `    Writable Projects: ${
              item.writeProjectIds.length === 0
                ? "none"
                : item.writeProjectIds.join(", ")
            }`,
            ...(observability.workItems.find(({ workItemId }) => workItemId === item.id) === undefined
              ? []
              : [renderWorkItemObservability(
                  observability.workItems.find(({ workItemId }) => workItemId === item.id)!
                )]),
            ...(currentWorkItemExecutionGroup(item) === undefined
              ? []
              : renderExecutionGroup(
                  currentWorkItemExecutionGroup(item)!,
                  executionGroupsById.get(currentWorkItemExecutionGroup(item)!.id)
                )),
            ...(item.acceptance.length === 0
              ? []
              : [`    Acceptance: ${item.acceptance.map(compactText).join("; ")}`]),
            ...(item.candidates.length === 0
              ? []
              : item.candidates.flatMap((candidate) => [
                  `    Candidate ${candidate.sequence}: ${candidate.id}${item.status === "awaiting_acceptance" && candidate === item.candidates.at(-1) ? " [current]" : ""} (${candidate.source.type === "run" ? candidate.source.runId : "direct"})`,
                  `      Review policy: ${candidate.reviewPolicy === undefined ? "none" : `${candidate.reviewPolicy.roleName} (${candidate.reviewPolicy.trigger})`}`,
                  `      Task-final contract: ${candidate.taskFinalReviewContract === undefined
                    ? "none"
                    : `${candidate.taskFinalReviewContract.digest} via control ${candidate.taskFinalReviewContract.controlPlaneDigest}`}`,
                  `      Frozen Git: ${candidate.gitSnapshot === undefined
                    ? "unavailable"
                    : `${candidate.gitSnapshot.reviewBaseCommit} (${candidate.gitSnapshot.projects.length} Projects)`}`,
                  `      Summary: ${compactText(candidate.summary)}`
                ])),
            ...(latestRun === undefined
              ? ["    AgentRuns: none."]
              : [
                  `    AgentRuns: ${itemRuns.length}; latest ${latestRun.id} [${latestRun.status}] ${latestRun.effective.agentId}/${latestRun.effective.adapterId} · effective r${latestRun.effective.sourceDesiredRevision}/${latestRun.effective.profileAccess}/${latestRun.effective.permission.strategy}`,
                  `      Assignment: ${latestRun.assignment.action}${latestRun.assignment.directive === undefined ? "" : ` · ${compactText(latestRun.assignment.directive)}`}`,
                  ...(latestRun.summary === undefined
                    ? []
                    : [`      Summary: ${compactText(latestRun.summary)}`])
                ]),
            ...renderReviewRounds(reviewRounds.filter(
              (round) => round.workItemId === item.id
            ), executionGroupsById)
          ];
        })),
    "",
    "Task-final reviews:",
    ...renderReviewRounds(reviewRounds.filter(
      (round) => (round.scope ?? "work-item") === "task"
    ), executionGroupsById),
    "",
    ...recentSection(
      "AgentRuns",
      agentRuns,
      (run) => [
        `  ${run.id} [${run.status}/${run.purpose}] ${run.roleName} via ${run.effective.agentId}/${run.effective.adapterId}`,
        `    Effective: r${run.effective.sourceDesiredRevision}; Profile intent: ${run.effective.profileAccess}; permission: ${run.effective.permission.strategy}; model: ${run.effective.model ?? "default"}; effort: ${run.effective.effort ?? "default"}`,
        ...(run.summary === undefined ? [] : [`    Result: ${compactText(run.summary)}`])
      ]
    ),
    "",
    "Runtime health:",
    ...(() => {
      const stalled = agentRuns.filter((run) => (
        run.status === "active" && isRoleRunStalled(events, run.id)
      ));
      return stalled.length === 0
        ? ["  No needs-attention Runs."]
        : stalled.flatMap((run) => [
            `  ${run.id} [needs-attention] ${run.roleName}`,
            `    Durable progress: ${formatTimestamp(latestStallProgressAt(events, run.id) ?? run.updatedAt, timeZone)}`,
            `    Cause: ${latestStallKind(events, run.id)} with no new semantic Run evidence in the stall window`,
            "    Next: inspect Task context/Role status; no automatic retry or Session replacement was performed."
          ]);
    })(),
    "",
    `ChangeSets (${changeSets.length}):`,
    ...(changeSets.length === 0
      ? ["  None."]
      : changeSets.slice(-RECENT_RECORD_LIMIT).map((changeSet) => (
          `  ${changeSet.id} [${changeSet.projectId}]: ${
            changeSet.baseCommit.slice(0, 12)
          }..${changeSet.headCommit.slice(0, 12)} (${
            changeSet.changedPaths.length
          } paths; WorkItem ${changeSet.workItemId})`
        ))),
    "",
    `Integration Attempts (${integrations.length}):`,
    ...(integrations.length === 0
      ? ["  None."]
      : integrations.slice(-RECENT_RECORD_LIMIT).map((integration) => (
          `  ${integration.id} [${integration.status}/${integration.projectId}] — ${
            integration.targetRef
          }; ${integration.changeSetIds.join(", ")}`
        ))),
    "",
    `Publication references (${publications.length}):`,
    ...(publications.length === 0
      ? ["  None."]
      : publications.slice(-RECENT_RECORD_LIMIT).map((reference) => [
          `  ${reference.id}: ${reference.provider}/${reference.repository}/${reference.externalId}`,
          ...(reference.title === undefined ? [] : [`    Title: ${reference.title}`]),
          ...(reference.sourceBranch === undefined && reference.targetBranch === undefined
            ? []
            : [`    Branches: ${reference.sourceBranch ?? "unknown"} -> ${reference.targetBranch ?? "unknown"}`]),
          `    ${reference.state}/${reference.verification}; ${
            reference.localCommit ?? "unknown"
          } -> ${reference.remoteCommit ?? "unknown"}`,
          ...(reference.mergedAt === undefined
            ? []
            : [`    Merged: ${formatTimestamp(reference.mergedAt, timeZone)}`]),
          ...(reference.supersedes === undefined
            ? []
            : [`    Supersedes: ${reference.supersedes}`])
        ]).flat()),
    "",
    ...recentSection(
      "messages",
      messages,
      (message) => [
        `  ${message.id} [${taskMessageAuthorLabel(message.author)}] ${formatTimestamp(message.createdAt, timeZone)}`,
        `    ${compactText(message.body)}`
      ]
    ),
    "",
    `Open input requests (${displayedOpenInputRequests.length}${openInputRequests.length > displayedOpenInputRequests.length ? ` of ${openInputRequests.length}` : ""}):`,
    ...(displayedOpenInputRequests.length === 0
      ? ["  None."]
      : displayedOpenInputRequests.flatMap((request) => renderOpenInputRequest(request, timeZone))),
    "",
    `Recent resolved input requests (${displayedResolvedInputRequests.length}${resolvedInputRequests.length > displayedResolvedInputRequests.length ? ` of ${resolvedInputRequests.length}` : ""}):`,
    ...(displayedResolvedInputRequests.length === 0
      ? ["  None."]
      : displayedResolvedInputRequests.flatMap((request) => renderResolvedInputRequest(request, timeZone))),
    "",
    ...recentSection(
      "events",
      events,
      (event) => [
        `  ${event.id} ${event.type} (${formatTimestamp(event.createdAt, timeZone)})`,
        ...(Object.keys(event.payload).length === 0
          ? []
          : [`    ${Object.entries(event.payload)
              .map(([key, value]) => `${key}=${compactText(value)}`)
              .join(", ")}`])
      ]
    )
  ];

  return {
    kind: "output" as const,
    output: `${lines.join("\n")}\n`,
    data
  };
}

function renderCoordinationMailbox(
  mailbox: ReturnType<TaskStore["getWorkMailbox"]> & object
): string[] {
  const target = mailbox.target.kind === "role"
    ? `role/${mailbox.target.roleName}`
    : mailbox.target.kind;
  const pending = [mailbox.pending.userCorrection, mailbox.pending.normal]
    .filter((batch): batch is NonNullable<typeof batch> => batch !== null);
  return [
    `  ${target}: cursor normal=${mailbox.pending.cursors.normal}, correction=${mailbox.pending.cursors.userCorrection}; next=${mailbox.nextSequence}`,
    `    Delivery: ${mailbox.inputDelivery?.status ?? "none"}; processing: ${mailbox.processing?.batchId ?? "none"}; pending batches: ${pending.length}`,
    ...pending.map((batch) => (
      `    Pending ${batch.fromSequence}-${batch.toSequence}: ${batch.reasons.join(", ")} · refs ${batch.refs.map((ref) => `${ref.type}:${ref.id}`).join(", ") || "none"}`
    ))
  ];
}

function latestStallKind(events: readonly TaskEvent[], runId: string): string {
  const event = [...events]
    .filter((candidate) => candidate.type === "run.stalled"
      && candidate.payload.runId === runId
      && candidate.payload.status !== "diagnostic-only")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return event?.payload.kind ?? "workflow-not-progressing";
}

function renderReviewRounds(
  rounds: ReturnType<TaskStore["listReviewRounds"]>,
  executionGroupsById: ReadonlyMap<string, ExecutionGroupHealthSummary> = new Map()
): string[] {
  const latest = rounds.at(-1);
  if (latest === undefined) return ["    ReviewRounds: none."];
  const target = (latest.scope ?? "work-item") === "task"
    ? "frozen Task candidate"
    : `Candidate ${latest.candidateId ?? "unavailable"}`;
  return [
    `    ReviewRounds: ${rounds.length}; latest ${latest.id} [${latest.status}] ${latest.scope === "task" ? "Task-final" : "WorkItem"} for ${target} via ${latest.reviewerRoleName} (${latest.requestedBy})`,
    `      Review base: ${latest.reviewBaseCommit}`,
    ...(latest.scope === "task"
      ? [
          `      Frozen Task heads: ${latest.taskCandidate?.projects
            .map(({ projectId, commit }) => `${projectId}@${commit}`).join(", ") ?? "unavailable"}`,
          `      Task-final contract: ${latest.taskFinalReviewContract?.digest ?? "global policy"}`,
          ...(latest.deltaRecheck === undefined
            ? [`      Review mode: full`]
            : [
                `      Review mode: delta-recheck (rechecks ${latest.deltaRecheck.previousReviewRoundId}@${latest.deltaRecheck.previousBaseCommit.slice(0, 12)})`,
                `      Delta: ${latest.deltaRecheck.changedFiles.length} file(s), +${latest.deltaRecheck.addedLines}/-${latest.deltaRecheck.deletedLines}, digest ${latest.deltaRecheck.diffDigest.slice(0, 12)}`,
                ...(latest.deltaRecheck.disposition === undefined
                  ? []
                  : [
                      `      Delta disposition: ${latest.deltaRecheck.disposition}`,
                      ...(latest.deltaRecheck.escalatedToReviewRoundId === undefined
                        ? []
                        : [`      Escalated to: ${latest.deltaRecheck.escalatedToReviewRoundId}`])
                    ])
              ])
        ]
      : []),
    `      Review workspace: ${latest.workspace === undefined
      ? "not prepared"
      : `${latest.workspace.root} (${latest.workspace.entries.length} writable Projects)`}`,
    `      Workspace disposition: ${latest.workspaceDisposition?.kind ?? "pending"}`,
    `      Diagnostic evidence: ${latest.evidenceCommit ?? "none"}`,
    `      Checks: ${latest.checks === undefined || latest.checks.length === 0
      ? "none"
      : latest.checks.map(({ name, outcome }) => `${name}=${outcome}`).join(", ")}`,
    ...(latest.summary === undefined
      ? []
      : [`      Review summary: ${compactText(latest.summary)}`]),
    ...(latest.executionGroup === undefined
      ? []
      : renderExecutionGroup(
          latest.executionGroup,
          executionGroupsById.get(latest.executionGroup.id)
        ).map((line) => `    ${line.trimStart()}`))
  ];
}

function renderResolvedInputRequest(request: InputRequest, timeZone: string | undefined): string[] {
  if (request.status === "open") return [];
  return [
    `  ${request.id} [${request.status}]`,
    `    Question: ${compactText(request.question)}`,
    ...(request.status === "answered"
      ? [
          `    Answer: ${compactText(request.resolution.answer.text)}`,
          `    Answered by ${request.resolution.answeredBy} at ${formatTimestamp(request.resolution.answeredAt, timeZone)}`
        ]
      : [
          `    Cancelled: ${compactText(request.cancellation.reason)}`,
          `    Cancelled at: ${formatTimestamp(request.cancellation.cancelledAt, timeZone)}`
        ])
  ];
}

function renderOpenInputRequest(request: InputRequest, timeZone: string | undefined): string[] {
  const choices = request.choices.slice(0, RELATED_RECORD_LIMIT);
  const blockedRefs = request.blockedRefs.slice(0, RELATED_RECORD_LIMIT);
  const recommendedChoiceKey = request.policy.kind === "recommended"
    ? request.policy.recommendedChoiceKey
    : undefined;
  const recommendedChoice = recommendedChoiceKey === undefined
    ? undefined
    : request.choices.find((choice) => choice.key === recommendedChoiceKey);
  return [
    `  ${request.id} [${request.policy.kind}]`,
    `    Question: ${compactText(request.question)}`,
    ...(request.choices.length === 0
      ? ["    Choices: none (free-text answer)."]
      : [
          `    Choices (${choices.length}${request.choices.length > choices.length ? ` of ${request.choices.length}` : ""}):`,
          ...choices.map((choice) => `      ${choice.key}: ${compactText(choice.label)}`)
        ]),
    ...(request.policy.kind === "recommended"
      ? [
          `    Recommended choice: ${request.policy.recommendedChoiceKey}: ${compactText(recommendedChoice?.label ?? request.policy.recommendedChoiceKey)}`,
          `    Timeout at: ${formatTimestamp(request.policy.timeoutAt, timeZone)}`
        ]
      : []),
    ...(request.blockedRefs.length === 0
      ? ["    Blocks: none."]
      : [
          `    Blocks (${blockedRefs.length}${request.blockedRefs.length > blockedRefs.length ? ` of ${request.blockedRefs.length}` : ""}):`,
          ...blockedRefs.map((reference) => `      ${reference.type}:${reference.id}`)
        ])
  ];
}

function recentSection<T>(
  label: string,
  records: readonly T[],
  render: (record: T) => string[]
): string[] {
  const recent = records.slice(-RECENT_RECORD_LIMIT);
  const title = `Recent ${label} (${recent.length}${records.length > recent.length ? ` of ${records.length}` : ""}):`;
  return recent.length === 0
    ? [title, "  None."]
    : [title, ...recent.flatMap(render)];
}

function currentAndRecentWorkItems<T extends { status: string }>(records: readonly T[]): T[] {
  const current = records.filter((record) => !TERMINAL_WORK_ITEM_STATUSES.has(record.status));
  if (current.length >= RECENT_RECORD_LIMIT) return current;
  const recentTerminal = records
    .filter((record) => TERMINAL_WORK_ITEM_STATUSES.has(record.status))
    .slice(-(RECENT_RECORD_LIMIT - current.length));
  const selected = new Set([...current, ...recentTerminal]);
  return records.filter((record) => selected.has(record));
}

function chronological<T extends { id: string; createdAt: string }>(
  records: readonly T[]
): T[] {
  return [...records].sort((left, right) => (
    Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.id.localeCompare(right.id)
  ));
}

function compactText(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= SUMMARY_TEXT_LIMIT
    ? oneLine
    : `${oneLine.slice(0, SUMMARY_TEXT_LIMIT - 3)}...`;
}

function managedWorkspaceLabel(
  workspace: ReturnType<TaskStore["listManagedWorkspaces"]>[number]
): string {
  switch (workspace.owner.type) {
    case "task":
      return "task";
    case "work-item":
      return `work-item ${workspace.owner.workItemId}`;
    case "review-round":
      return `review-round ${workspace.owner.reviewRoundId}`;
    case "integration-attempt":
      return `integration-attempt ${workspace.owner.integrationAttemptId}`;
    case "execution-lane":
      return `execution-lane ${workspace.owner.executionGroupId}/${workspace.owner.executionLaneId}`;
  }
}

function renderExecutionGroup(
  group: ExecutionGroup,
  projected?: ExecutionGroupHealthSummary
): string[] {
  const summary: ExecutionGroupSummary | ExecutionGroupHealthSummary = projected
    ?? summarizeExecutionGroup(group);
  const health = projected?.health;
  const resources = projected?.resources;
  return [
    `    Execution Group ${summary.groupId} [${summary.purpose}/${summary.strategy.mode}]: ${summary.activeLaneCount} active / ${summary.terminalLaneCount} terminal; ${summary.failedLaneCount} failed; ${summary.skippedLaneCount} skipped`,
    ...(health === undefined
      ? []
      : [
          `      Health: active=${health.activeLaneCount}, silent=${health.silentLaneCount}, suspected-stalled=${health.suspectedStalledLaneCount}, confirmed-dead=${health.confirmedDeadLaneCount}`,
          `      Recovery: reusable=${health.reusableLaneIds.length}, retryable=${health.retryableLaneIds.length}`
        ]),
    ...(resources === undefined
      ? []
      : [
          `      Resources: tokens=${resourceUsageLabel(resources.tokens, resources.tokensRemaining, resources.tokensObservable)}; tools=${resourceUsageLabel(resources.toolCalls, resources.toolCallsRemaining, resources.toolCallsObservable)}; wall=${resources.wallClockSeconds}s${resources.wallClockSecondsRemaining === undefined ? "" : `, remaining=${resources.wallClockSecondsRemaining}s`}`,
          `      Completion: usable=${resources.usableLaneCount}/${group.stage?.resources?.quorum ?? "legacy"}; quorum=${resources.quorumMet ? "met" : "open"}; deadline=${resources.deadlineReached ? "reached" : "open"}; budgets=${resources.exhaustedBudgets.join(",") || "open"}; queued=${resources.pendingLaneIds.length}; stragglers=${resources.stragglerLaneIds.length}`
        ]),
    ...summary.laneSummaries.flatMap((lane) => {
      const laneHealth = projected?.laneSummaries.find(({ laneId }) => laneId === lane.laneId);
      return [
        `      Lane ${lane.laneId} (#${lane.ordinal}, ${lane.roleName}${
          lane.runId === undefined ? "" : `, run ${lane.runId}`
          }) [${lane.status}${
          laneHealth?.runtimeHealth === undefined ? "" : `/${laneHealth.runtimeHealth}`
          }]${lane.summary === undefined ? "" : `: ${compactText(lane.summary)}`}`,
        ...(lane.effective === undefined
          ? []
          : [`        Config: ${lane.effective.adapterId}/${lane.effective.model ?? "default"}/${lane.effective.effort ?? "default"}; profile=${lane.effective.profileAccess}`]),
        ...(laneHealth !== undefined && laneHealth.recovery !== "none"
          ? [`        Recovery: ${laneHealth.recovery}; ${compactText(laneHealth.reason)}`]
          : []),
        ...(lane.report === undefined ? [] : [`        Report: ${compactText(lane.report)}`]),
        ...(lane.checks === undefined || lane.checks.length === 0
          ? []
          : [`        Checks: ${lane.checks.map(({ name, outcome }) => `${name}:${outcome}`).join(", ")}`]),
        ...(lane.findings === undefined || lane.findings.length === 0
          ? []
          : [`        Findings: ${lane.findings.map(({ id, severity, status }) => `${id}:${severity}/${status}`).join(", ")}`]),
        ...(lane.evidence === undefined || lane.evidence.length === 0
          ? []
          : [`        Evidence: ${lane.evidence.length} item(s)`]),
        ...(lane.evidenceCommit === undefined
          ? []
          : [`        Evidence commit: ${lane.evidenceCommit}`]),
        ...(lane.decision === undefined ? [] : [`        Decision: ${lane.decision}`])
      ];
    }),
    ...(summary.openHighPriorityFindingIds.length === 0
      ? []
      : [`      Open high findings: ${summary.openHighPriorityFindingIds.join(", ")}`]),
    ...(summary.resolution === undefined
      ? []
      : [`      Resolution: ${summary.resolution.decision} — ${compactText(summary.resolution.summary)}`])
  ];
}

function resourceUsageLabel(
  used: number,
  remaining: number | undefined,
  observable: boolean
): string {
  if (!observable) return `${used} observed (partial)`;
  return `${used}${remaining === undefined ? "" : `, remaining=${remaining}`}`;
}

function renderWorkItemObservability(
  item: WorkItemObservabilityProjection
): string {
  const stages = item.stages.map((stage) => (
    `${stage.stage ?? "single"}${stage.round === undefined ? "" : `#${stage.round}`}${stage.stageAttempt === undefined ? "" : `/a${stage.stageAttempt}`}`
  )).join(", ");
  return `    Observability: stages=${stages || "none"}; tokens=${item.cost.tokens}; tools=${item.cost.toolCalls}; wall=${item.cost.wallClockSeconds}s; retries=${item.cost.retryCount}; snapshots=${item.context.snapshotCount}; evidence=${item.evidenceCount}; open-findings=${item.openFindingCount}; compression=${item.context.compressionStatus}`;
}
