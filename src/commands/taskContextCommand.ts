import { taskNotFound, usageError } from "../errors/cliError.js";
import { taskMessageAuthorLabel } from "../message/message.js";
import type { TaskStore } from "../storage/taskStore.js";

const RECENT_RECORD_LIMIT = 5;
const SUMMARY_TEXT_LIMIT = 400;
const TERMINAL_WORK_ITEM_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded"
]);

export function runTaskContextCommand(args: string[], store: TaskStore) {
  if (args.length !== 1 || args[0]?.trim().length === 0) {
    throw usageError("Task context usage: taskmux task context <task>.");
  }
  const taskId = args[0].trim();
  const data = store.transaction((reader) => {
    const task = reader.getTask(taskId);
    if (task === null) throw taskNotFound(taskId);
    const workItems = reader.listWorkItems(task.id);
    const workItemIds = new Set(workItems.map((item) => item.id));
    return {
      task,
      brief: reader.getTaskBrief(task.id),
      activeDecisions: reader.listDecisions(task.id)
        .filter((decision) => decision.status === "active"),
      milestones: reader.listMilestones(task.id),
      roles: reader.listRoles(task.id),
      workItems,
      runs: reader.listAgentRuns(task.id)
        .filter((run) => run.workItemId !== undefined && workItemIds.has(run.workItemId)),
      messages: reader.listMessages(task.id),
      events: reader.listEvents(task.id)
    };
  });
  const {
    task,
    brief,
    activeDecisions,
    milestones,
    roles,
    workItems,
    runs,
    messages,
    events
  } = data;
  const displayedActiveDecisions = activeDecisions.slice(-RECENT_RECORD_LIMIT);
  const displayedWorkItems = currentAndRecentWorkItems(workItems);

  const lines = [
    `Task context: ${task.id}`,
    `Title: ${compactText(task.title)}`,
    `Status: ${task.status}`,
    ...(task.description === undefined ? [] : [`Description: ${compactText(task.description)}`]),
    ...(task.priority === undefined ? [] : [`Priority: ${task.priority}`]),
    ...(task.tags === undefined ? [] : [`Tags: ${task.tags.join(", ")}`]),
    ...(task.dueAt === undefined ? [] : [`Due: ${task.dueAt}`]),
    ...(task.completionSummary === undefined ? [] : [`Completion summary: ${task.completionSummary}`]),
    ...(task.archiveSummary === undefined ? [] : [`Archive summary: ${task.archiveSummary}`]),
    ...(task.repositoryId === undefined ? [] : [`Repository: ${task.repositoryId}`]),
    ...(task.baseRef === undefined ? [] : [`Base: ${task.baseRef}`]),
    ...(task.cwd === undefined ? [] : [`Workspace: ${task.cwd}`]),
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
          `  Current focus: ${compactText(brief.currentFocus)}`,
          `  Leader summary: ${compactText(brief.leaderSummary)}`,
          `  Updated by ${brief.updatedBy} at ${brief.updatedAt}`
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
        `  ${milestone.id}: ${compactText(milestone.title)} (${milestone.createdAt})`,
        `    ${compactText(milestone.summary)}`
      ]
    ),
    "",
    `Roles (${roles.length}):`,
    ...(roles.length === 0
      ? ["  None."]
      : roles.map((role) => (
          `  ${role.name} [${role.status}] — Agent: ${role.activeAgentId}`
        ))),
    "",
    `Current and recent work items (${displayedWorkItems.length}${workItems.length > displayedWorkItems.length ? ` of ${workItems.length}` : ""}):`,
    ...(displayedWorkItems.length === 0
      ? ["  None."]
      : displayedWorkItems.flatMap((item) => {
          const itemRuns = runs.filter((run) => run.workItemId === item.id);
          const latestRun = itemRuns.at(-1);
          return [
            `  ${item.id} [${item.status}] ${item.assignee}: ${compactText(item.title)}`,
            ...(item.outcome === undefined
              ? []
              : [`    Outcome: ${compactText(item.outcome)}`]),
            ...(latestRun === undefined
              ? ["    Runs: none."]
              : [
                  `    Runs: ${itemRuns.length}; latest ${latestRun.id} [${latestRun.status}] ${latestRun.roleName}`,
                  `      Input: ${compactText(latestRun.input)}`,
                  ...(latestRun.summary === undefined
                    ? []
                    : [`      Summary: ${compactText(latestRun.summary)}`])
                ])
          ];
        })),
    "",
    ...recentSection(
      "messages",
      messages,
      (message) => [
        `  ${message.id} [${taskMessageAuthorLabel(message.author)}] ${message.createdAt}`,
        `    ${compactText(message.body)}`
      ]
    ),
    "",
    ...recentSection(
      "events",
      events,
      (event) => [
        `  ${event.id} ${event.type} (${event.createdAt})`,
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

function compactText(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= SUMMARY_TEXT_LIMIT
    ? oneLine
    : `${oneLine.slice(0, SUMMARY_TEXT_LIMIT - 3)}...`;
}

