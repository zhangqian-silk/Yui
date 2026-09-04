import type { TaskEvent } from "../event/taskEvent.js";
import type { TaskMessage } from "../message/message.js";
import type { Turn } from "../turn/turn.js";
import type { Task } from "../task/task.js";
import type { ReviewRound } from "../review/reviewRound.js";
import { renderWakeReason } from "../scheduler/wakeReason.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";

/**
 * Issue 04 (context token budget) — long-term design:
 *
 * A Leader wake is a NOTIFICATION, not a context dump. The wake envelope
 * carries only what the Agent needs for immediate orientation: the wake id,
 * aggregated reason tags, delta window, and a bounded list of active frozen
 * Task Reviews. The Agent reads delta content on demand with
 * `yui task wake show <wake-id>` and the full projection with
 * `yui task context <task>`.
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
  /** Existing Turns named by terminal events in the wake delta, in event order. */
  referencedTurnIds: readonly string[];
  totalBytes: number;
  text: string;
}>;

/** Narrow read surface — the envelope only needs orientation, active Reviews and delta counts. */
export type WakeEnvelopeReader = Readonly<{
  getTask(taskId: string): Task | null;
  listEvents(taskId: string): readonly TaskEvent[];
  listMessages(taskId: string): readonly TaskMessage[];
  listTurns(taskId: string): readonly Turn[];
  listReviewRounds(taskId: string): readonly ReviewRound[];
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
  const deltaEvents = events.filter((record) => Date.parse(record.createdAt) > fromTime);
  const turns = operationalTaskRecords(reader.listTurns(request.taskId), events, "turn");
  const referencedTurnIds = referencedWakeTurnIds(turns, events, deltaEvents);
  const changedTurnIds = new Set([
    ...turns
      .filter((record) => Date.parse(record.createdAt) > fromTime)
      .map(({ id }) => id),
    ...referencedTurnIds
  ]);
  const counts = {
    events: deltaEvents.length,
    messages: operationalTaskRecords(reader.listMessages(request.taskId), events, "message")
      .filter((record) => Date.parse(record.createdAt) > fromTime).length,
    turns: changedTurnIds.size
  };
  const activeReviews = reader.listReviewRounds(request.taskId).filter((round) => (
    (round.scope ?? "work-item") === "task"
    && (round.status === "pending" || round.status === "running")
  ));
  const renderReviewOrientation = (limit: number) => activeReviews.slice(0, limit).map((round) => {
    const projects = round.taskCandidate?.projects ?? [];
    const heads = projects.slice(0, 2).map(({ projectId, commit }) => (
      `${projectId}@${commit.slice(0, 12)}`
    )).join("+");
    return `${round.id}/${round.reviewerRoleName}`
      + `/${round.deltaRecheck === undefined ? "full" : "delta"}`
      + `[${round.status}]`
      + `@${heads || round.reviewBaseCommit.slice(0, 12)}`
      + `${projects.length > 2 ? `+${projects.length - 2}` : ""}`;
  }).join(", ");

  const render = (
    reasonLimit: number,
    resultTurnLimit: number,
    reviewLimit: number
  ): string => {
    const reviewOrientation = renderReviewOrientation(reviewLimit);
    return [
      `Wake: ${request.wakeId} — delta since ${request.fromCursor}`,
      `  Reasons: ${renderReasons(request.reasons, reasonLimit)}`,
      `  Changed: ${counts.events} events, ${counts.messages} messages, ${counts.turns} Turns`
        + ` → yui task wake show ${request.taskId} ${request.wakeId}`,
      `  Result Turns: ${renderResultTurns(
        request.taskId,
        referencedTurnIds,
        resultTurnLimit
      )}`,
      `  Active Task Reviews: ${activeReviews.length === 0
        ? "none"
        : reviewLimit === 0
          ? `${activeReviews.length} → yui task context ${request.taskId}`
          : `${reviewOrientation}${activeReviews.length > reviewLimit
            ? `, … (+${activeReviews.length - reviewLimit})`
            : ""}`}`,
      `Full context: yui task context ${request.taskId}`
    ].join("\n");
  };

  let reasonLimit = Math.min(REASON_DISPLAY_LIMIT, request.reasons.length);
  let resultTurnLimit = Math.min(4, referencedTurnIds.length);
  let reviewLimit = Math.min(3, activeReviews.length);
  let body = render(reasonLimit, resultTurnLimit, reviewLimit);
  while (byteLength(body) + 1 > WAKE_ENVELOPE_HARD_BYTES) {
    if (resultTurnLimit > 0) resultTurnLimit -= 1;
    else if (reasonLimit > 0) reasonLimit -= 1;
    else if (reviewLimit > 0) reviewLimit -= 1;
    else break;
    body = render(reasonLimit, resultTurnLimit, reviewLimit);
  }
  if (byteLength(body) + 1 > WAKE_ENVELOPE_HARD_BYTES) {
    body = fitUtf8([
      `Wake: ${request.wakeId}`,
      `Inspect: yui task wake show ${request.taskId} ${request.wakeId}`,
      `Full context: yui task context ${request.taskId}`
    ].join("\n"), WAKE_ENVELOPE_HARD_BYTES - 1);
  }
  const totalBytes = byteLength(body) + 1;

  return Object.freeze({
    taskId: request.taskId,
    wakeId: request.wakeId,
    fromCursor: request.fromCursor,
    referencedTurnIds: Object.freeze(referencedTurnIds),
    totalBytes,
    text: `${body}\n`
  });
}

export function referencedWakeTurnIds(
  turns: readonly Turn[],
  allEvents: readonly TaskEvent[],
  terminalEvents: readonly TaskEvent[]
): readonly string[] {
  const turnsById = new Map(
    operationalTaskRecords(turns, allEvents, "turn").map((turn) => [turn.id, turn])
  );
  return [...new Set(terminalEvents.flatMap((event) => {
    if (!["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) return [];
    const turnId = event.payload.turnId;
    return turnId !== undefined && turnsById.has(turnId) ? [turnId] : [];
  }))];
}

function renderReasons(reasons: readonly string[], limit: number): string {
  if (limit === 0) return `${reasons.length} reason tags`;
  const selected = reasons.slice(0, limit);
  const elided = reasons.length - selected.length;
  const rendered = selected.map(renderWakeReason).join(", ");
  return elided === 0 ? rendered : `${rendered}, … (+${elided} more)`;
}

function renderResultTurns(
  taskId: string,
  turnIds: readonly string[],
  limit: number
): string {
  if (turnIds.length === 0) return "none";
  if (limit === 0) return `${turnIds.length} → inspect the wake delta`;
  return `${turnIds.slice(0, limit)
    .map((turnId) => `${turnId} → yui task turn show ${taskId}/${turnId}`)
    .join(", ")}${turnIds.length > limit ? `, … (+${turnIds.length - limit})` : ""}`;
}

function fitUtf8(value: string, maxBytes: number): string {
  let fitted = "";
  for (const character of value) {
    if (byteLength(fitted) + byteLength(character) > maxBytes) break;
    fitted += character;
  }
  return fitted;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
