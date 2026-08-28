import type { TaskEvent } from "../event/taskEvent.js";
import type { TaskMessage } from "../message/message.js";
import type { AgentRun } from "../run/agentRun.js";
import type { Task } from "../task/task.js";
import { renderWakeReason } from "../scheduler/wakeReason.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";

/**
 * Issue 04 (context token budget) — long-term design:
 *
 * A Leader wake is a NOTIFICATION, not a context dump. The wake envelope
 * carries only what the Agent cannot reconstruct from durable records:
 * the wake id, the aggregated reason tags, and the delta window. The Agent
 * reads the delta content on demand with `yui task wake show <wake-id>` and
 * the full projection with `yui task context <task>`.
 *
 * The envelope is mode-agnostic: fresh generations and resumed generations
 * receive the same minimal text. The native Session is a disposable cache of
 * working context; Yui's durable Task records (including the wake ledger) are
 * the checkpoint.
 */

/** Structural guardrail: the envelope stays far below a normal model context window. */
export const WAKE_ENVELOPE_HARD_BYTES = 2_000;

/** Maximum reason tags rendered before elision to a count. */
const REASON_DISPLAY_LIMIT = 6;

export type WakeEnvelopeRequest = Readonly<{
  taskId: string;
  /** The wake record id this envelope will be persisted as. */
  wakeId: string;
  /** Canonical wake reason tags aggregated from the mailbox pending batch. */
  reasons: readonly string[];
  /** ISO timestamp; the delta window's exclusive lower bound. */
  fromCursor: string;
  now?: Date;
}>;

export type WakeEnvelope = Readonly<{
  taskId: string;
  wakeId: string;
  fromCursor: string;
  totalBytes: number;
  text: string;
}>;

/** Narrow read surface — the envelope only needs orientation + delta counts. */
export type WakeEnvelopeReader = Readonly<{
  getTask(taskId: string): Task | null;
  listEvents(taskId: string): readonly TaskEvent[];
  listMessages(taskId: string): readonly TaskMessage[];
  listAgentRuns(taskId: string): readonly AgentRun[];
}>;

export function buildTaskWakeEnvelope(
  reader: WakeEnvelopeReader,
  request: WakeEnvelopeRequest
): WakeEnvelope {
  const task = reader.getTask(request.taskId);
  if (task === null) throw new Error(`Task not found: ${request.taskId}.`);
  if (request.reasons.length === 0) {
    throw new Error(`Wake envelope ${request.wakeId} must carry at least one reason.`);
  }

  const fromTime = Date.parse(request.fromCursor);
  const events = reader.listEvents(request.taskId);
  const counts = {
    events: events
      .filter((record) => Date.parse(record.createdAt) > fromTime).length,
    messages: operationalTaskRecords(reader.listMessages(request.taskId), events, "message")
      .filter((record) => Date.parse(record.createdAt) > fromTime).length,
    runs: operationalTaskRecords(reader.listAgentRuns(request.taskId), events, "agent-run")
      .filter((record) => Date.parse(record.createdAt) > fromTime).length
  };

  const lines: string[] = [
    `Wake: ${request.wakeId} — delta since ${request.fromCursor}`,
    `  Reasons: ${renderReasons(request.reasons)}`,
    `  Changed: ${counts.events} events, ${counts.messages} messages, ${counts.runs} runs`
      + ` → yui task wake show ${request.taskId} ${request.wakeId}`,
    `Full context: yui task context ${request.taskId}`
  ];

  const body = lines.join("\n");
  const totalBytes = byteLength(body) + 1;
  if (totalBytes > WAKE_ENVELOPE_HARD_BYTES) {
    throw new Error(
      `Wake envelope ${request.wakeId} exceeds the structural hard budget of`
      + ` ${WAKE_ENVELOPE_HARD_BYTES} bytes (${totalBytes}).`
    );
  }

  return Object.freeze({
    taskId: request.taskId,
    wakeId: request.wakeId,
    fromCursor: request.fromCursor,
    totalBytes,
    text: `${body}\n`
  });
}

function renderReasons(reasons: readonly string[]): string {
  const selected = reasons.slice(0, REASON_DISPLAY_LIMIT);
  const elided = reasons.length - selected.length;
  const rendered = selected.map(renderWakeReason).join(", ");
  return elided === 0 ? rendered : `${rendered}, … (+${elided} more)`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
