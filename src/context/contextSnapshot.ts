import type { TaskBrief } from "../brief/taskBrief.js";
import type { Decision } from "../decision/decision.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { TaskMessage } from "../message/message.js";
import { taskMessageAuthorLabel } from "../message/message.js";
import type { AgentRun } from "../run/agentRun.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { Task } from "../task/task.js";
import { projectNextAction, type NextAction } from "../task/nextAction.js";
import type { WorkItem } from "../workItem/workItem.js";

/**
 * Issue 04 (context token budget): a bounded, deterministic projection of the
 * durable Task records that a Leader wake can embed directly. The snapshot is
 * the only context a resumed generation needs to decide its next action; full
 * records remain addressable through the narrow CLI commands referenced in
 * each section. It is deliberately a pure projection — no persistent
 * ContextSnapshot record exists, so there is no migration, GC, or second
 * source of truth to keep consistent with YUI_HOME.
 */

export const DEFAULT_SNAPSHOT_SOFT_BYTES = 12_000;
export const DEFAULT_SNAPSHOT_HARD_BYTES = 20_000;

const CORE_SECTION_LIMITS = Object.freeze({
  decisions: 8,
  workItems: 10,
  openInputs: 5,
  openIntegrations: 5
});

const DELTA_SECTION_LIMITS = Object.freeze({
  events: 12,
  messages: 5,
  runs: 5
});

const COMPACT_BYTES = 600;

export type ContextSnapshotBudget = Readonly<{
  softBytes: number;
  hardBytes: number;
}>;

export type ContextSnapshotRequest = Readonly<{
  taskId: string;
  /**
   * "new" generations have no native history and receive the recent-record
   * fallback delta; "resume" generations receive only records created after
   * the supplied watermark.
   */
  mode: "new" | "resume";
  /** Delta records must be created strictly after this instant. */
  afterCreatedAt?: string;
  budget?: Partial<ContextSnapshotBudget>;
  now?: Date;
}>;

export type ContextSnapshotSection = Readonly<{
  id: string;
  bytes: number;
  /** Records dropped by the budget, always paired with a parseable reference. */
  elided: number;
  reference?: string;
  lines: readonly string[];
}>;

export type ContextSnapshotState = "within-budget" | "over-soft" | "over-hard";

export type ContextSnapshot = Readonly<{
  taskId: string;
  generatedAt: string;
  budget: ContextSnapshotBudget;
  state: ContextSnapshotState;
  totalBytes: number;
  sections: readonly ContextSnapshotSection[];
  text: string;
}>;

/** Narrow read surface so the projection stays pure and trivially testable. */
export type ContextSnapshotReader = Readonly<{
  getTask(taskId: string): Task | null;
  getTaskBrief(taskId: string): TaskBrief | null;
  listDecisions(taskId: string): readonly Decision[];
  listWorkItems(taskId: string): readonly WorkItem[];
  listReviewRounds(taskId: string): readonly ReviewRound[];
  listIntegrationAttempts(taskId: string): readonly IntegrationAttempt[];
  listInputRequests(taskId: string): readonly InputRequest[];
  listMessages(taskId: string): readonly TaskMessage[];
  listAgentRuns(taskId: string): readonly AgentRun[];
  listEvents(taskId: string): readonly TaskEvent[];
  readNextActionFacts(taskId: string): Parameters<typeof projectNextAction>[0] | null;
}>;

export function buildTaskContextSnapshot(
  reader: ContextSnapshotReader,
  request: ContextSnapshotRequest
): ContextSnapshot {
  const task = reader.getTask(request.taskId);
  if (task === null) throw new Error(`Task not found: ${request.taskId}.`);
  const budget: ContextSnapshotBudget = Object.freeze({
    softBytes: positiveBudget(request.budget?.softBytes, DEFAULT_SNAPSHOT_SOFT_BYTES, "softBytes"),
    hardBytes: positiveBudget(request.budget?.hardBytes, DEFAULT_SNAPSHOT_HARD_BYTES, "hardBytes")
  });
  if (budget.softBytes >= budget.hardBytes) {
    throw new Error("Context snapshot softBytes must be smaller than hardBytes.");
  }
  const facts = reader.readNextActionFacts(task.id);
  if (facts === null) throw new Error(`Task next-action facts disappeared: ${task.id}.`);
  const nextAction = projectNextAction(facts);
  const brief = reader.getTaskBrief(task.id);
  const activeDecisions = reader.listDecisions(task.id)
    .filter((decision) => decision.status === "active");
  const workItems = reader.listWorkItems(task.id);
  const reviewRounds = chronological(reader.listReviewRounds(task.id));
  const integrations = chronological(reader.listIntegrationAttempts(task.id));
  const openInputs = reader.listInputRequests(task.id)
    .filter((candidate) => candidate.status === "open");
  const events = chronological(reader.listEvents(task.id));
  const messages = chronological(reader.listMessages(task.id));
  const runs = chronological(reader.listAgentRuns(task.id));

  const core: ContextSnapshotSection[] = [
    headSection(task, nextAction),
    goalSection(task, brief),
    decisionsSection(activeDecisions, task.id),
    workSection(workItems, reviewRounds, integrations, task.id),
    unresolvedSection(openInputs, integrations, task.id)
  ];
  const delta: ContextSnapshotSection[] = [
    eventsSection(events, request, task.id),
    messagesSection(messages, request, task.id),
    runsSection(runs, request, task.id)
  ];

  const trimmed = trimDeltaToBudget(core, delta, budget.softBytes);
  const sections = [...core, ...trimmed];
  const totalBytes = sumBytes(sections);
  const state: ContextSnapshotState = totalBytes > budget.hardBytes
    ? "over-hard"
    : totalBytes > budget.softBytes
      ? "over-soft"
      : "within-budget";
  return Object.freeze({
    taskId: task.id,
    generatedAt: (request.now ?? new Date()).toISOString(),
    budget,
    state,
    totalBytes,
    sections: Object.freeze(sections),
    text: renderSnapshotText(task.id, state, budget, sections)
  });
}

function headSection(task: Task, nextAction: NextAction): ContextSnapshotSection {
  return section("head", [
    `Task: ${task.id} [${task.status}] ${compactText(task.title)}`,
    `Next action: ${nextAction.kind} — ${compactText(nextAction.reason)}`,
    ...(nextAction.refs.length === 0
      ? []
      : [`  Refs: ${nextAction.refs.map(({ kind, id }) => `${kind} ${id}`).join(", ")}`]),
    ...(nextAction.recommendedCommand === undefined
      ? []
      : [`  Recommended: ${nextAction.recommendedCommand}`]),
    ...(nextAction.judgmentRequired === undefined
      ? []
      : [`  Judgment: ${compactText(nextAction.judgmentRequired)}`])
  ]);
}

function goalSection(task: Task, brief: TaskBrief | null): ContextSnapshotSection {
  if (brief === null) {
    return section("goal", [
      `Objective: ${compactText(task.description ?? task.title)}`,
      "  No Task Brief recorded; capture one with yui task brief set for a durable objective."
    ]);
  }
  return section("goal", [
    `Objective: ${compactText(brief.objective)}`,
    ...(brief.boundaries.length === 0
      ? []
      : [`Boundaries: ${brief.boundaries.map((entry) => compactText(entry)).join("; ")}`]),
    `Current focus: ${compactText(brief.currentFocus)}`,
    `Leader summary: ${compactText(brief.leaderSummary)}`
  ]);
}

function decisionsSection(
  activeDecisions: readonly Decision[],
  taskId: string
): ContextSnapshotSection {
  const selected = activeDecisions.slice(-CORE_SECTION_LIMITS.decisions);
  const elided = activeDecisions.length - selected.length;
  return section("decisions", [
    ...(selected.length === 0 ? ["No active Decisions."] : []),
    ...selected.flatMap((decision) => [
      `${decision.id}: ${compactText(decision.title)}`,
      `  Rationale: ${compactText(decision.rationale)}`
    ]),
    ...elisionLine(elided, `yui task decision list ${taskId} --status active`)
  ], elided);
}

function workSection(
  workItems: readonly WorkItem[],
  reviewRounds: readonly ReviewRound[],
  integrations: readonly IntegrationAttempt[],
  taskId: string
): ContextSnapshotSection {
  const active = workItems.filter((item) => !TERMINAL_WORK_ITEM_STATUSES.has(item.status));
  const selected = active.slice(-CORE_SECTION_LIMITS.workItems);
  const elided = active.length - selected.length;
  const openIntegrations = integrations
    .filter((attempt) => OPEN_INTEGRATION_STATUSES.has(attempt.status))
    .slice(-CORE_SECTION_LIMITS.openIntegrations);
  const lines: string[] = [];
  if (selected.length === 0) lines.push("No active Work Items.");
  for (const item of selected) {
    lines.push(`${item.id} [${item.status}]: ${compactText(item.title)}`);
    lines.push(`  Objective: ${compactText(item.objective)}`);
    if (item.acceptance.length > 0) {
      lines.push(`  Acceptance: ${item.acceptance.map((entry) => compactText(entry)).join("; ")}`);
    }
    const latestRound = reviewRounds
      .filter((round) => round.workItemId === item.id)
      .at(-1);
    if (latestRound !== undefined) {
      lines.push(
        `  Review: ${latestRound.id} [${latestRound.status}]`
        + " — full report persisted once; read with"
        + ` yui --json task context ${taskId}`
      );
      if (latestRound.summary !== undefined) {
        lines.push(`    Summary: ${compactText(latestRound.summary)}`);
      }
    }
  }
  lines.push(...elisionLine(elided, `yui task work list ${taskId}`));
  if (openIntegrations.length > 0) {
    lines.push(`Open Integration Attempts: ${openIntegrations
      .map((attempt) => `${attempt.id} [${attempt.status}/${attempt.projectId}]`)
      .join(", ")}`);
  }
  return section("work", lines, elided);
}

function unresolvedSection(
  openInputs: readonly InputRequest[],
  integrations: readonly IntegrationAttempt[],
  taskId: string
): ContextSnapshotSection {
  const selected = openInputs.slice(-CORE_SECTION_LIMITS.openInputs);
  const elided = openInputs.length - selected.length;
  const blockedIntegrations = integrations
    .filter((attempt) => BLOCKED_INTEGRATION_STATUSES.has(attempt.status))
    .slice(-CORE_SECTION_LIMITS.openIntegrations);
  const lines: string[] = [];
  if (selected.length === 0 && blockedIntegrations.length === 0) {
    lines.push("No unresolved Input Requests or blocked Integrations.");
  }
  for (const request of selected) {
    lines.push(`${request.id} [${request.policy.kind}]: ${compactText(request.question)}`);
    if (request.blockedRefs.length > 0) {
      lines.push(`  Blocks: ${request.blockedRefs
        .map((ref) => `${ref.type}:${ref.id}`)
        .join(", ")}`);
    }
  }
  lines.push(...elisionLine(elided, `yui task input list ${taskId}`));
  for (const attempt of blockedIntegrations) {
    lines.push(`${attempt.id} [blocked/${attempt.projectId}]`
      + ` — read with yui task integration show ${taskId}/${attempt.id}`);
  }
  return section("unresolved", lines, elided);
}

function eventsSection(
  events: readonly TaskEvent[],
  request: ContextSnapshotRequest,
  taskId: string
): ContextSnapshotSection {
  const selected = deltaRecords(events, request, DELTA_SECTION_LIMITS.events);
  const reference = `yui task event list ${taskId}`;
  return section("delta-events", [
    ...selected.records.map((event) => {
      const payload = Object.entries(event.payload)
        .map(([key, value]) => `${key}=${compactText(String(value))}`)
        .join(", ");
      return `${event.id} ${event.type}${payload.length === 0 ? "" : ` ${payload}`}`;
    }),
    ...elisionLine(selected.elided, reference)
  ], selected.elided, reference);
}

function messagesSection(
  messages: readonly TaskMessage[],
  request: ContextSnapshotRequest,
  taskId: string
): ContextSnapshotSection {
  const selected = deltaRecords(messages, request, DELTA_SECTION_LIMITS.messages);
  const reference = `yui task message list ${taskId}`;
  return section("delta-messages", [
    ...selected.records.map((message) => (
      `${message.id} [${taskMessageAuthorLabel(message.author)}]: ${compactText(message.body)}`
    )),
    ...elisionLine(selected.elided, reference)
  ], selected.elided, reference);
}

function runsSection(
  runs: readonly AgentRun[],
  request: ContextSnapshotRequest,
  taskId: string
): ContextSnapshotSection {
  const selected = deltaRecords(runs, request, DELTA_SECTION_LIMITS.runs);
  const reference = `yui task run list ${taskId}/<work-item>`;
  return section("delta-runs", [
    ...selected.records.map((run) => (
      `${run.id} [${run.status}/${run.purpose}] ${run.roleName}`
      + `${run.summary === undefined ? "" : ` — ${compactText(run.summary)}`}`
    )),
    ...elisionLine(selected.elided, reference)
  ], selected.elided, reference);
}

function deltaRecords<T extends { id: string; createdAt: string }>(
  records: readonly T[],
  request: ContextSnapshotRequest,
  limit: number
): Readonly<{ records: readonly T[]; elided: number }> {
  const candidates = request.mode === "resume" && request.afterCreatedAt !== undefined
    ? records.filter((record) => Date.parse(record.createdAt) > Date.parse(request.afterCreatedAt!))
    : records;
  const selected = candidates.slice(-limit);
  return { records: selected, elided: candidates.length - selected.length };
}

function trimDeltaToBudget(
  core: readonly ContextSnapshotSection[],
  delta: readonly ContextSnapshotSection[],
  softBytes: number
): ContextSnapshotSection[] {
  const coreBytes = sumBytes(core);
  if (coreBytes >= softBytes) {
    // Core state is never silently truncated. The hard-budget banner in the
    // rendered text carries the exact on-demand references instead.
    return delta.map((entry) => elideSection(entry, entry.lines.length));
  }
  let allowance = softBytes - coreBytes;
  const result: ContextSnapshotSection[] = [];
  for (const entry of delta) {
    if (allowance <= 0) {
      result.push(elideSection(entry, 0));
      continue;
    }
    // The trailing elision line is not a record; budget trimming counts only
    // record lines so the elided count stays exact.
    const recordLineCount = entry.lines.length - (entry.elided > 0 ? 1 : 0);
    let kept = 0;
    let used = 0;
    for (let index = 0; index < recordLineCount; index += 1) {
      const line = entry.lines[index];
      const lineBytes = byteLength(line) + 1;
      if (used + lineBytes > allowance && kept > 0) break;
      used += lineBytes;
      kept += 1;
    }
    allowance -= used;
    result.push(kept === recordLineCount
      ? entry
      : elideSection(entry, kept));
  }
  return result;
}

/** Keeps the first `keptRecordLines` record lines and re-emits one elision line. */
function elideSection(
  entry: ContextSnapshotSection,
  keptRecordLines: number
): ContextSnapshotSection {
  const recordLineCount = entry.lines.length - (entry.elided > 0 ? 1 : 0);
  const elided = entry.elided + (recordLineCount - keptRecordLines);
  if (elided === 0) return entry;
  const reference = entry.reference
    ?? (entry.id === "delta-events"
      ? "yui task event list"
      : entry.id === "delta-messages"
        ? "yui task message list"
        : "yui task context");
  const keptLines = entry.lines.slice(0, keptRecordLines);
  return section(entry.id, [
    ...keptLines,
    `… ${elided} earlier record(s) elided by the context budget — read with ${reference}`
  ], elided, reference);
}

function renderSnapshotText(
  taskId: string,
  state: ContextSnapshotState,
  budget: ContextSnapshotBudget,
  sections: readonly ContextSnapshotSection[]
): string {
  const banner = state === "over-hard"
    ? [
        `CONTEXT BUDGET EXCEEDED — core state exceeds the hard budget of ${budget.hardBytes} bytes.`,
        `Key state below is complete, but read the full authoritative projection with yui task context ${taskId} before deciding.`
      ]
    : state === "over-soft"
      ? [
          `Context budget advisory — snapshot exceeds the soft budget of ${budget.softBytes} bytes;`,
          "older delta records were elided to references. Durable Yui records remain the checkpoint."
        ]
      : [];
  const body = sections.flatMap((entry) => [
    `${sectionLabel(entry)}:`,
    ...entry.lines.map((line) => `  ${line}`)
  ]);
  return [...banner, ...body, ""].join("\n");
}

function sectionLabel(entry: ContextSnapshotSection): string {
  switch (entry.id) {
    case "head": return "Task state";
    case "goal": return "Goal";
    case "decisions": return "Active decisions";
    case "work": return "Current work";
    case "unresolved": return "Unresolved";
    case "delta-events": return "New events";
    case "delta-messages": return "New messages";
    case "delta-runs": return "New runs";
    default: return entry.id;
  }
}

function elisionLine(elided: number, reference: string): string[] {
  return elided === 0
    ? []
    : [`… ${elided} earlier record(s) — read with ${reference}`];
}

function section(
  id: string,
  lines: readonly string[],
  elided = 0,
  reference?: string
): ContextSnapshotSection {
  return Object.freeze({
    id,
    bytes: byteLength(lines.join("\n")) + (lines.length === 0 ? 0 : 1),
    elided,
    ...(reference === undefined ? {} : { reference }),
    lines: Object.freeze(lines)
  });
}

function sumBytes(sections: readonly ContextSnapshotSection[]): number {
  return sections.reduce((total, entry) => total + entry.bytes, 0);
}

function positiveBudget(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Context snapshot ${label} must be a positive safe integer.`);
  }
  return value;
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

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const TERMINAL_WORK_ITEM_STATUSES = new Set(["completed", "failed", "retired"]);
const OPEN_INTEGRATION_STATUSES = new Set(["running", "blocked", "validating"]);
const BLOCKED_INTEGRATION_STATUSES = new Set(["blocked", "failed"]);
