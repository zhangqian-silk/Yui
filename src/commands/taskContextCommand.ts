import { taskNotFound, usageError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { InputRequest } from "../input/inputRequest.js";
import { taskMessageAuthorLabel } from "../message/message.js";
import { formatTimestamp } from "../output/timePresentation.js";
import type { TaskStore } from "../storage/taskStore.js";
import { isRoleRunStalled, latestStallProgressAt } from "../scheduler/roleRunStall.js";
import { buildTaskExecutionProjection } from "../scheduler/taskExecutionProjection.js";
import { inspectTaskRoleSessionRecovery } from "./taskRoleRuntimeStatus.js";

const RECENT_RECORD_LIMIT = 5;
const RELATED_RECORD_LIMIT = 5;
const SUMMARY_TEXT_LIMIT = 400;
const TERMINAL_WORK_ITEM_STATUSES = new Set([
  "completed",
  "failed",
  "retired"
]);

export function runTaskContextCommand(args: string[], store: TaskStore) {
  if (args.length !== 1 || args[0]?.trim().length === 0) {
    throw usageError("Task context usage: yui task context <task>.");
  }
  const taskId = args[0].trim();
  const data = store.transaction((reader) => {
    const task = reader.getTask(taskId);
    if (task === null) throw taskNotFound(taskId);
    const workItems = reader.listWorkItems(task.id);
    const inputRequests = reader.listInputRequests(task.id);
    const roles = reader.listRoles(task.id);
    const execution = buildTaskExecutionProjection(reader, task.id, task);
    if (execution === null) {
      throw new Error(`Task execution projection disappeared: ${task.id}.`);
    }
    const roleSessionSets = reader.listRoleSessionSets(task.id);
    return {
      task,
      execution,
      reviewConfig: reader.getReviewConfig(),
      brief: reader.getTaskBrief(task.id),
      activeDecisions: reader.listDecisions(task.id)
        .filter((decision) => decision.status === "active"),
      milestones: reader.listMilestones(task.id),
      roles,
      managedWorkspaces: reader.listManagedWorkspaces(task.id),
      roleSessionSets,
      roleSessionRecoveries: roles.map((role) => (
        inspectTaskRoleSessionRecovery(task.id, role.name, reader)
      )),
      workItems,
      agentRuns: chronological(reader.listAgentRuns(task.id)),
      reviewRounds: chronological(reader.listReviewRounds(task.id)),
      changeSets: chronological(reader.listChangeSets(task.id)),
      integrations: chronological(reader.listIntegrationAttempts(task.id)),
      messages: reader.listMessages(task.id),
      openInputRequests: inputRequests.filter((request) => request.status === "open"),
      resolvedInputRequests: inputRequests.filter((request) => request.status !== "open"),
      events: reader.listEvents(task.id)
    };
  });
  const {
    task,
    execution,
    reviewConfig,
    brief,
    activeDecisions,
    milestones,
    roles,
    managedWorkspaces,
    roleSessionSets,
    roleSessionRecoveries,
    workItems,
    agentRuns,
    reviewRounds,
    changeSets,
    integrations,
    messages,
    openInputRequests,
    resolvedInputRequests,
    events
  } = data;
  const timeZone = store.getConfig().timeZone;
  const displayedActiveDecisions = activeDecisions.slice(-RECENT_RECORD_LIMIT);
  const displayedWorkItems = currentAndRecentWorkItems(workItems);
  const displayedOpenInputRequests = openInputRequests.slice(-RECENT_RECORD_LIMIT);
  const displayedResolvedInputRequests = resolvedInputRequests.slice(-RECENT_RECORD_LIMIT);
  const displayedExecutionCarriers = execution.monitoring === "active"
    ? execution.activeRuns
    : [];

  const lines = [
    `Task context: ${task.id}`,
    `Title: ${compactText(task.title)}`,
    `Status: ${task.status}`,
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
    `  Active execution carriers (${displayedExecutionCarriers.length}):`,
    ...(displayedExecutionCarriers.length === 0
      ? ["    None."]
      : displayedExecutionCarriers.map((run) => (
          `    ${run.roleName}: ${run.id} [${run.status}; ${run.delivered ? "accepted" : "delivery-pending"}]`
        ))),
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
    `Completion evidence: ${task.requireIntegration
      ? "WorkItem, ChangeSet, and committed Integration required"
      : "delivery integration not required"}`,
    `Global review: ${reviewConfig === null
      ? "disabled"
      : `${reviewConfig.roleName} (${reviewConfig.trigger})`}`,
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
          const recovery = roleSessionRecoveries.find((entry) => entry.roleName === role.name);
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
              : [`    Runtime source at creation: ${creation.payload.runtimeSource}`]),
            ...(recovery === undefined ? [] : [
              `    Runtime cleanup: ${recovery.runtimeCleanupPending ? "pending" : "none"}`,
              `    Fresh launch: ${recovery.freshLaunchAllowed ? "allowed" : "blocked"}`
            ])
          ];
        })),
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
            ...(item.acceptance.length === 0
              ? []
              : [`    Acceptance: ${item.acceptance.map(compactText).join("; ")}`]),
            ...(item.candidates.length === 0
              ? []
              : item.candidates.flatMap((candidate) => [
                  `    Candidate ${candidate.sequence}: ${candidate.id}${item.status === "awaiting_acceptance" && candidate === item.candidates.at(-1) ? " [current]" : ""} (${candidate.source.type === "run" ? candidate.source.runId : "direct"})`,
                  `      Review policy: ${candidate.reviewPolicy === undefined ? "none" : `${candidate.reviewPolicy.roleName} (${candidate.reviewPolicy.trigger})`}`,
                  `      Frozen Git: ${candidate.gitSnapshot === undefined
                    ? "unavailable"
                    : `${candidate.gitSnapshot.reviewBaseCommit} (${candidate.gitSnapshot.projects.length} Projects)`}`,
                  `      Summary: ${compactText(candidate.summary)}`
                ])),
            ...(latestRun === undefined
              ? ["    AgentRuns: none."]
              : [
                  `    AgentRuns: ${itemRuns.length}; latest ${latestRun.id} [${latestRun.status}] ${latestRun.effective.agentId}/${latestRun.effective.adapterId} · effective r${latestRun.effective.sourceDesiredRevision}/${latestRun.effective.profileAccess}/${latestRun.effective.permission.strategy}`,
                  `      Input: ${compactText(latestRun.input)}`,
                  ...(latestRun.summary === undefined
                    ? []
                    : [`      Summary: ${compactText(latestRun.summary)}`])
                ]),
            ...renderWorkItemReviews(reviewRounds.filter(
              (round) => round.workItemId === item.id
            ))
          ];
        })),
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

function latestStallKind(events: readonly TaskEvent[], runId: string): string {
  const event = [...events]
    .filter((candidate) => candidate.type === "run.stalled" && candidate.payload.runId === runId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return event?.payload.kind ?? "execution-stalled";
}

function renderWorkItemReviews(
  rounds: ReturnType<TaskStore["listReviewRounds"]>
): string[] {
  const latest = rounds.at(-1);
  if (latest === undefined) return ["    ReviewRounds: none."];
  return [
    `    ReviewRounds: ${rounds.length}; latest ${latest.id} [${latest.status}] for ${latest.candidateId} via ${latest.reviewerRoleName} (${latest.requestedBy})`,
    `      Review base: ${latest.reviewBaseCommit}`,
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
      : [`      Review summary: ${compactText(latest.summary)}`])
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
  }
}
