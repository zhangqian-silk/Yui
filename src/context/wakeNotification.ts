import type { TaskBrief } from "../brief/taskBrief.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { TaskMessage } from "../message/message.js";
import { taskMessageAuthorLabel } from "../message/message.js";
import type { AgentRun } from "../run/agentRun.js";
import type { Task } from "../task/task.js";
import { projectNextAction, type NextAction } from "../task/nextAction.js";

/**
 * Issue 04 (context token budget) — long-term design:
 *
 * A Leader wake is a NOTIFICATION, not a context dump. The wake prompt
 * carries only what the Agent cannot reconstruct from durable records:
 * the wake delta (what changed since the last consumption point) and,
 * for fresh generations, a minimal orientation (goal + next action).
 * Everything else is read on demand through narrow CLI commands.
 *
 * The native Session is a disposable cache of working context; Yui's
 * durable Task records are the checkpoint. The session-context budget
 * (sessionContextBudget.ts) independently observes per-request input
 * peaks and retires generations that cross the hard threshold.
 */

export const DEFAULT_NOTIFICATION_SOFT_BYTES = 3_000;
export const DEFAULT_NOTIFICATION_HARD_BYTES = 6_000;

const DELTA_DISPLAY_LIMITS = Object.freeze({
  events: 8,
  messages: 3,
  runs: 3
});

/** New generations without a watermark get this many recent records for orientation. */
const NEW_GENERATION_DELTA_FALLBACK = 20;

const COMPACT_BYTES = 600;

export type WakeNotificationBudget = Readonly<{
  softBytes: number;
  hardBytes: number;
}>;

export type WakeNotificationRequest = Readonly<{
  taskId: string;
  /**
   * "new" generations have no native history and receive a minimal
   * orientation (goal + next action) plus a recent-activity fallback.
   * "resume" generations receive only the delta after the watermark.
   */
  mode: "new" | "resume";
  /** Delta records must be created strictly after this instant. */
  afterCreatedAt?: string;
  budget?: Partial<WakeNotificationBudget>;
  now?: Date;
}>;

export type WakeNotificationState = "within-budget" | "over-soft" | "over-hard";

export type WakeNotification = Readonly<{
  taskId: string;
  generatedAt: string;
  budget: WakeNotificationBudget;
  state: WakeNotificationState;
  totalBytes: number;
  text: string;
}>;

/** Narrow read surface — the notification only needs orientation + delta records. */
export type WakeNotificationReader = Readonly<{
  getTask(taskId: string): Task | null;
  getTaskBrief(taskId: string): TaskBrief | null;
  listEvents(taskId: string): readonly TaskEvent[];
  listMessages(taskId: string): readonly TaskMessage[];
  listAgentRuns(taskId: string): readonly AgentRun[];
  readNextActionFacts(taskId: string): Parameters<typeof projectNextAction>[0] | null;
}>;

export function buildTaskWakeNotification(
  reader: WakeNotificationReader,
  request: WakeNotificationRequest
): WakeNotification {
  const task = reader.getTask(request.taskId);
  if (task === null) throw new Error(`Task not found: ${request.taskId}.`);
  const budget: WakeNotificationBudget = Object.freeze({
    softBytes: positiveBudget(request.budget?.softBytes, DEFAULT_NOTIFICATION_SOFT_BYTES, "softBytes"),
    hardBytes: positiveBudget(request.budget?.hardBytes, DEFAULT_NOTIFICATION_HARD_BYTES, "hardBytes")
  });
  if (budget.softBytes >= budget.hardBytes) {
    throw new Error("Wake notification softBytes must be smaller than hardBytes.");
  }

  const facts = reader.readNextActionFacts(task.id);
  if (facts === null) throw new Error(`Task next-action facts disappeared: ${task.id}.`);
  const nextAction = projectNextAction(facts);
  const brief = reader.getTaskBrief(task.id);

  const events = chronological(reader.listEvents(task.id));
  const messages = chronological(reader.listMessages(task.id));
  const runs = chronological(reader.listAgentRuns(task.id));

  const deltaEvents = deltaRecords(events, request);
  const deltaMessages = deltaRecords(messages, request);
  const deltaRuns = deltaRecords(runs, request);

  const lines: string[] = [];

  // Orientation — fresh generations only. Resumed generations already hold
  // core state in their native history.
  if (request.mode === "new") {
    lines.push(...orientationLines(task, brief, nextAction));
  }

  // Delta notification — what changed since the last consumption point.
  const hasDelta = deltaEvents.length > 0 || deltaMessages.length > 0 || deltaRuns.length > 0;
  if (hasDelta) {
    const watermark = request.afterCreatedAt ?? "task start";
    lines.push(`New since ${watermark}:`);
    if (deltaEvents.length > 0) {
      lines.push(...eventDeltaLines(deltaEvents, task.id, request.afterCreatedAt));
    }
    if (deltaMessages.length > 0) {
      lines.push(...messageDeltaLines(deltaMessages, task.id, request.afterCreatedAt));
    }
    if (deltaRuns.length > 0) {
      lines.push(...runDeltaLines(deltaRuns, task.id));
    }
  } else if (request.mode === "resume") {
    lines.push("No new durable records since the last wake.");
  }

  // Read guidance — narrow CLI commands for on-demand context.
  lines.push(...readGuidanceLines(task.id, request));

  const body = lines.join("\n");
  const totalBytes = byteLength(body) + 1;
  const state: WakeNotificationState = totalBytes > budget.hardBytes
    ? "over-hard"
    : totalBytes > budget.softBytes
      ? "over-soft"
      : "within-budget";

  const banner = state === "over-hard"
    ? [
        `WAKE NOTIFICATION BUDGET EXCEEDED — delta exceeds the hard budget of ${budget.hardBytes} bytes.`,
        `Read the full authoritative projection with yui task context ${task.id} before deciding.`
      ]
    : state === "over-soft"
      ? [
          `Wake notification advisory — delta exceeds the soft budget of ${budget.softBytes} bytes;`,
          "older delta records were elided to references. Durable Yui records remain the checkpoint."
        ]
      : [];

  return Object.freeze({
    taskId: task.id,
    generatedAt: (request.now ?? new Date()).toISOString(),
    budget,
    state,
    totalBytes,
    text: [...banner, body, ""].join("\n")
  });
}

function orientationLines(task: Task, brief: TaskBrief | null, nextAction: NextAction): string[] {
  const objective = brief?.objective ?? task.description ?? task.title;
  return [
    `Goal: ${compactText(objective)}`,
    `Next action: ${nextAction.kind} — ${compactText(nextAction.reason)}`,
    ...(nextAction.recommendedCommand === undefined
      ? []
      : [`  Recommended: ${nextAction.recommendedCommand}`])
  ];
}

function eventDeltaLines(
  events: readonly TaskEvent[],
  taskId: string,
  afterCreatedAt: string | undefined
): string[] {
  const selected = events.slice(-DELTA_DISPLAY_LIMITS.events);
  const elided = events.length - selected.length;
  const ref = `yui task event list ${taskId}${afterCreatedAt === undefined ? "" : ` --after ${afterCreatedAt}`}`;
  return [
    `  Events (${events.length}): ${selected.map((e) => `${e.id} ${e.type}`).join(", ")}`,
    ...(elided === 0 ? [] : [`    … (+${elided} earlier — read with ${ref})`])
  ];
}

function messageDeltaLines(
  messages: readonly TaskMessage[],
  taskId: string,
  afterCreatedAt: string | undefined
): string[] {
  const selected = messages.slice(-DELTA_DISPLAY_LIMITS.messages);
  const elided = messages.length - selected.length;
  const ref = `yui task message list ${taskId}${afterCreatedAt === undefined ? "" : ` --after ${afterCreatedAt}`}`;
  return [
    `  Messages (${messages.length}): ${selected.map((m) => `${m.id} [${taskMessageAuthorLabel(m.author)}]`).join(", ")}`,
    ...(elided === 0 ? [] : [`    … (+${elided} earlier — read with ${ref})`])
  ];
}

function runDeltaLines(runs: readonly AgentRun[], taskId: string): string[] {
  const selected = runs.slice(-DELTA_DISPLAY_LIMITS.runs);
  const elided = runs.length - selected.length;
  return [
    `  Runs (${runs.length}): ${selected.map((r) => `${r.id} [${r.status}/${r.purpose}] ${r.roleName}`).join(", ")}`,
    ...(elided === 0 ? [] : [`    … (+${elided} earlier — read with yui task run list ${taskId}/<work-item>)`])
  ];
}

function readGuidanceLines(taskId: string, request: WakeNotificationRequest): string[] {
  if (request.mode === "new") {
    return [
      `Read on demand: yui task work list ${taskId}, yui task decision list ${taskId} --status active, `
      + `yui task input list ${taskId}, yui task event list ${taskId}, yui task message list ${taskId}, `
      + `or full projection: yui task context ${taskId}`
    ];
  }
  const after = request.afterCreatedAt === undefined ? "" : ` --after ${request.afterCreatedAt}`;
  return [
    `Read on demand: yui task event list ${taskId}${after}, yui task message list ${taskId}${after}, `
    + `or full projection: yui task context ${taskId}`
  ];
}

function deltaRecords<T extends { id: string; createdAt: string }>(
  records: readonly T[],
  request: WakeNotificationRequest
): readonly T[] {
  if (request.mode === "resume" && request.afterCreatedAt !== undefined) {
    return records.filter((record) => Date.parse(record.createdAt) > Date.parse(request.afterCreatedAt!));
  }
  // New generations get a recent-record fallback for orientation.
  return records.slice(-NEW_GENERATION_DELTA_FALLBACK);
}

function chronological<T extends { id: string; createdAt: string }>(
  records: readonly T[]
): readonly T[] {
  return [...records].sort((left, right) => (
    Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.id.localeCompare(right.id, undefined, { numeric: true })
  ));
}

function compactText(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (byteLength(oneLine) <= COMPACT_BYTES) return oneLine;
  const ellipsis = "...";
  let end = oneLine.length;
  while (end > 0 && byteLength(oneLine.slice(0, end)) > COMPACT_BYTES - byteLength(ellipsis)) {
    end -= 1;
  }
  return `${oneLine.slice(0, end)}${ellipsis}`;
}

function positiveBudget(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Wake notification ${label} must be a positive safe integer.`);
  }
  return value;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
