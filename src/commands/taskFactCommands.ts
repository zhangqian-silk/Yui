import { createTaskBrief, updateTaskBrief } from "../brief/taskBrief.js";
import {
  enqueueWork
} from "../coordination/workMailboxQueue.js";
import { createDecision, supersedeDecision } from "../decision/decision.js";
import {
  dataError,
  usageError
} from "../errors/cliError.js";
import { createMilestone } from "../milestone/milestone.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  assertTaskOpen,
  clock,
  exactPositionals,
  leaderActionEventPayload,
  leaderMailbox,
  notifyMailbox,
  optionalNonEmptyOption,
  output,
  parseMultiValueTail,
  parseTail,
  presentTime,
  recordTaskEvent,
  requiredOption,
  requiredText,
  requireTask,
  taskActor,
  taskMailbox,
  taskRef
} from "./taskCommandSupport.js";
import type { TaskCommandExecution, TaskCommandOptions, TaskWorkflowStore } from "./taskCommandTypes.js";
export function taskBriefCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "show") {
    exactPositionals(rest, 1, "Task brief show usage: yui task brief show <task>.");
    const task = requireTask(store, rest[0]);
    const brief = store.getTaskBrief(task.id);
    if (brief === null) {
      return output(`Task ${task.id} has no brief.\n`, { taskId: task.id, brief: null });
    }
    const timeZone = store.getConfig().timeZone;
    return output([
      `Task: ${task.id}`,
      `Objective: ${brief.objective}`,
      `Boundaries:`,
      ...(brief.boundaries.length === 0 ? ["  (none)"] : brief.boundaries.map((b) => `  - ${b}`)),
      `Technical approach: ${brief.technicalApproach || "(not defined)"}`,
      `Current focus: ${brief.currentFocus}`,
      `Leader summary: ${brief.leaderSummary}`,
      `Updated by: ${brief.updatedBy}`,
      `Updated at: ${presentTime(brief.updatedAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, brief });
  }
  if (command === "update") {
    const usage = "Task brief update usage: yui task brief update <task> [--objective <text>] [--boundary <text> ...] [--approach <text>] [--focus <text>] [--leader-summary <text>].";
    const parsed = parseMultiValueTail(
      rest,
      new Set(["--objective", "--approach", "--focus", "--leader-summary"]),
      new Set(["--boundary"]),
      usage
    );
    exactPositionals(parsed.positionals, 1, usage);
    const hasObjective = parsed.options.has("--objective");
    const hasApproach = parsed.options.has("--approach");
    const hasFocus = parsed.options.has("--focus");
    const hasSummary = parsed.options.has("--leader-summary");
    const boundaries = parsed.multiOptions.get("--boundary") ?? [];
    if (!hasObjective && !hasApproach && !hasFocus && !hasSummary && boundaries.length === 0) {
      throw usageError("At least one brief field is required.", usage);
    }
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const existing = tx.getTaskBrief(task.id);
      const updatedBy = taskActor(tx, options, task.id);
      const brief = existing === null
        ? createTaskBrief({
            objective: requiredText(parsed.options.get("--objective"), "--objective"),
            boundaries,
            ...(hasApproach
              ? { technicalApproach: requiredText(
                  parsed.options.get("--approach"),
                  "--approach"
                ) }
              : {}),
            currentFocus: requiredText(parsed.options.get("--focus"), "--focus"),
            leaderSummary: requiredText(parsed.options.get("--leader-summary"), "--leader-summary"),
            updatedBy
          }, now)
        : updateTaskBrief(existing, {
            ...(hasObjective ? { objective: parsed.options.get("--objective") } : {}),
            ...(boundaries.length > 0 ? { boundaries } : {}),
            ...(hasApproach
              ? { technicalApproach: parsed.options.get("--approach") }
              : {}),
            ...(hasFocus ? { currentFocus: parsed.options.get("--focus") } : {}),
            ...(hasSummary ? { leaderSummary: parsed.options.get("--leader-summary") } : {})
          }, updatedBy, now);
      tx.saveTaskBrief(task.id, brief);
      recordTaskEvent(tx, task.id, "brief.updated", {
        updatedBy,
        previous: JSON.stringify(existing), current: JSON.stringify(brief)
      }, now);
      enqueueWork(tx, taskMailbox(task.id), "brief-updated", now, [taskRef(task.id)]);
      if (task.status === "active" && updatedBy !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "brief-updated", now, [taskRef(task.id)]);
      }
      return { task, brief };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") {
      notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    }
    return output(`Updated brief for ${result.task.id}\n`, { taskId: result.task.id, brief: result.brief });
  }
  throw usageError(command === undefined
    ? "Task brief command is required."
    : `Unknown command: task brief ${command}`);
}


export function taskDecisionCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "record") {
    const usage = "Task decision record usage: yui task decision record <task> --title <text> --rationale <text>.";
    const parsed = parseTail(rest, new Set(["--title", "--rationale"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const title = requiredOption(parsed.options, "--title");
    const rationale = requiredOption(parsed.options, "--rationale");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(tx, options, task.id);
      const decision = createDecision(tx.nextDecisionId(task.id), task.id, title, rationale, now);
      tx.saveDecision(task.id, decision);
      recordTaskEvent(tx, task.id, "decision.recorded", {
        decisionId: decision.id,
        title,
        ...leaderActionEventPayload(tx, task.id, options)
      }, now);
      enqueueWork(tx, taskMailbox(task.id), "decision-recorded", now, [taskRef(task.id)]);
      if (task.status === "active" && actor !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "decision-recorded", now, [taskRef(task.id)]);
      }
      return { task, decision };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    return output(`Recorded decision ${result.decision.id} for ${result.task.id}\n`);
  }
  if (command === "list") {
    const usage = "Task decision list usage: yui task decision list <task> [--status active|superseded].";
    const parsed = parseTail(rest, new Set(["--status"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const task = requireTask(store, parsed.positionals[0]);
    let decisions = store.listDecisions(task.id);
    const status = parsed.options.get("--status");
    if (status !== undefined) {
      if (status !== "active" && status !== "superseded") {
        throw usageError("--status must be active or superseded.", usage);
      }
      decisions = decisions.filter((d) => d.status === status);
    }
    if (decisions.length === 0) {
      return output(`No decisions found for ${task.id}.\n`, { taskId: task.id, decisions: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Decisions: ${task.id}`,
      [
        { header: "Decision", minWidth: 8, maxWidth: 18 },
        { header: "Status", minWidth: 6, maxWidth: 12 },
        { header: "Title", minWidth: 8, maxWidth: 64 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      decisions.map((d) => [d.id, d.status, d.title, presentTime(d.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, decisions });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task decision show usage: yui task decision show <task> <decision>.");
    const task = requireTask(store, rest[0]);
    const decision = store.getDecision(task.id, rest[1]);
    if (decision === null) throw dataError(`Decision not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Decision: ${decision.id}`,
      `Task: ${task.id}`,
      `Title: ${decision.title}`,
      `Rationale: ${decision.rationale}`,
      `Status: ${decision.status}`,
      ...(decision.supersededReason === undefined ? [] : [`Superseded reason: ${decision.supersededReason}`]),
      ...(decision.supersededAt === undefined ? [] : [`Superseded at: ${presentTime(decision.supersededAt, timeZone)}`]),
      `Created: ${presentTime(decision.createdAt, timeZone)}`,
      `Updated: ${presentTime(decision.updatedAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, decision });
  }
  if (command === "supersede") {
    const usage = "Task decision supersede usage: yui task decision supersede <task> <decision> --reason <text>.";
    const parsed = parseTail(rest, new Set(["--reason"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const reason = requiredOption(parsed.options, "--reason");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(tx, options, task.id);
      const existing = tx.getDecision(task.id, parsed.positionals[1]);
      if (existing === null) throw dataError(`Decision not found: ${parsed.positionals[1]}.`);
      const decision = supersedeDecision(existing, reason, now);
      tx.saveDecision(task.id, decision);
      recordTaskEvent(tx, task.id, "decision.superseded", {
        decisionId: decision.id,
        reason,
        ...leaderActionEventPayload(tx, task.id, options)
      }, now);
      enqueueWork(tx, taskMailbox(task.id), "decision-superseded", now, [taskRef(task.id)]);
      if (task.status === "active" && actor !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "decision-superseded", now, [taskRef(task.id)]);
      }
      return { task, decision };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    return output(`Superseded decision ${result.decision.id} for ${result.task.id}\n`);
  }
  throw usageError(command === undefined
    ? "Task decision command is required."
    : `Unknown command: task decision ${command}`);
}


export function taskMilestoneCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "add") {
    const usage = "Task milestone add usage: yui task milestone add <task> --title <text> --summary <text>.";
    const parsed = parseTail(rest, new Set(["--title", "--summary"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const title = requiredOption(parsed.options, "--title");
    const summary = requiredOption(parsed.options, "--summary");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(tx, options, task.id);
      const milestone = createMilestone(
        tx.nextMilestoneId(task.id),
        task.id,
        title,
        summary,
        actor,
        now
      );
      tx.saveMilestone(task.id, milestone);
      recordTaskEvent(tx, task.id, "milestone.added", {
        milestoneId: milestone.id,
        title,
        ...leaderActionEventPayload(tx, task.id, options)
      }, now);
      enqueueWork(tx, taskMailbox(task.id), "milestone-added", now, [taskRef(task.id)]);
      return { task, milestone };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    return output(`Added milestone ${result.milestone.id} for ${result.task.id}\n`);
  }
  if (command === "list") {
    exactPositionals(rest, 1, "Task milestone list usage: yui task milestone list <task>.");
    const task = requireTask(store, rest[0]);
    const milestones = store.listMilestones(task.id);
    if (milestones.length === 0) {
      return output(`No milestones found for ${task.id}.\n`, { taskId: task.id, milestones: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Milestones: ${task.id}`,
      [
        { header: "Milestone", minWidth: 9, maxWidth: 18 },
        { header: "Title", minWidth: 8, maxWidth: 64 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      milestones.map((m) => [m.id, m.title, presentTime(m.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, milestones });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task milestone show usage: yui task milestone show <task> <milestone>.");
    const task = requireTask(store, rest[0]);
    const milestone = store.getMilestone(task.id, rest[1]);
    if (milestone === null) throw dataError(`Milestone not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Milestone: ${milestone.id}`,
      `Task: ${task.id}`,
      `Title: ${milestone.title}`,
      `Summary: ${milestone.summary}`,
      `Created by: ${milestone.createdBy}`,
      `Created: ${presentTime(milestone.createdAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, milestone });
  }
  throw usageError(command === undefined
    ? "Task milestone command is required."
    : `Unknown command: task milestone ${command}`);
}


export function taskEventCommand(
  args: string[],
  store: TaskWorkflowStore
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") {
    const eventListUsage = "Task event list usage: yui task event list <task> [--after <timestamp>] [--limit <n>].";
    const parsed = parseTail(rest, new Set(["--after", "--limit"]), eventListUsage);
    exactPositionals(parsed.positionals, 1, eventListUsage);
    const task = requireTask(store, parsed.positionals[0]);
    let events = store.listEvents(task.id);
    const after = optionalNonEmptyOption(parsed.options, "--after");
    if (after !== undefined) {
      const afterMs = Date.parse(after);
      if (!Number.isFinite(afterMs)) throw usageError("--after must be a valid timestamp.", eventListUsage);
      events = events.filter((e) => Date.parse(e.createdAt) > afterMs);
    }
    const limit = optionalNonEmptyOption(parsed.options, "--limit");
    if (limit !== undefined) {
      const n = Number(limit);
      if (!Number.isSafeInteger(n) || n <= 0) throw usageError("--limit must be a positive integer.", eventListUsage);
      events = events.slice(-n);
    }
    if (events.length === 0) {
      return output(`No events found for ${task.id}.\n`, { taskId: task.id, events: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Events: ${task.id}`,
      [
        { header: "Event", minWidth: 8, maxWidth: 18 },
        { header: "Type", minWidth: 8, maxWidth: 28 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      events.map((e) => [e.id, e.type, presentTime(e.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, events });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task event show usage: yui task event show <task> <event>.");
    const task = requireTask(store, rest[0]);
    const events = store.listEvents(task.id);
    const event = events.find((e) => e.id === rest[1]) ?? null;
    if (event === null) throw dataError(`Event not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Event: ${event.id}`,
      `Task: ${task.id}`,
      `Type: ${event.type}`,
      `Created: ${presentTime(event.createdAt, timeZone)}`,
      `Payload:`,
      ...(Object.keys(event.payload).length === 0
        ? ["  (none)"]
        : Object.entries(event.payload).map(([k, v]) => `  ${k}: ${v}`))
    ].join("\n").concat("\n"), { taskId: task.id, event });
  }
  throw usageError(command === undefined
    ? "Task event command is required."
    : `Unknown command: task event ${command}`);
}
