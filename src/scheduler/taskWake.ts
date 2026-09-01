import {
  requireIdentity,
  requirePositiveInteger,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { TASK_RECORD_ID_PREFIXES } from "../task/taskRecordReference.js";

export const CURRENT_TASK_WAKE_SCHEMA_VERSION = 1 as const;

export type TaskWakeStatus = "dispatched" | "consumed";

/**
 * One durable Leader wake dispatch (Issue 04 long-term design).
 *
 * A wake is a NOTIFICATION, not a context dump. The record captures only what
 * the Agent cannot reconstruct from durable records: that a wake happened, the
 * aggregated reason tags, and the delta window (`fromCursor` exclusive,
 * `toCursor` inclusive). The Agent reads the delta content on demand with
 * `yui task wake show`; the full projection stays in `yui task context`.
 *
 * The ledger is also the durable consumption cursor: the latest wake's
 * `toCursor` is the task's high-water mark. A task with no wake records falls
 * back to its last Leader Turn creation time, preserving pre-ledger semantics.
 */
export type TaskWake = Readonly<{
  schemaVersion: typeof CURRENT_TASK_WAKE_SCHEMA_VERSION;
  id: string;
  taskId: string;
  /** Per-Task monotonic sequence, equal to the id's numeric suffix. */
  seq: number;
  /** Canonical wake reason tags aggregated from the mailbox pending batch. */
  reasons: readonly string[];
  /** ISO timestamp; the delta window's exclusive lower bound. */
  fromCursor: string;
  /** ISO timestamp; the delta window's upper bound (dispatch time). */
  toCursor: string;
  status: TaskWakeStatus;
  /** The Leader Turn this wake dispatched. */
  turnId?: string;
  createdAt: string;
  /** Set when the dispatched Turn reaches a terminal state. */
  consumedAt?: string;
}>;

export function createTaskWake(input: Readonly<{
  id: string;
  taskId: string;
  reasons: readonly string[];
  fromCursor: string;
  toCursor: string;
  turnId: string;
  now: Date;
}>): TaskWake {
  const wake: TaskWake = {
    schemaVersion: CURRENT_TASK_WAKE_SCHEMA_VERSION,
    id: requireIdentity(input.id, "Task wake id"),
    taskId: requireIdentity(input.taskId, "Task id"),
    seq: wakeSequence(input.id),
    reasons: Object.freeze(input.reasons.map((reason) => requireText(reason, "Wake reason"))),
    fromCursor: requireTimestamp(input.fromCursor, "Wake fromCursor"),
    toCursor: requireTimestamp(input.toCursor, "Wake toCursor"),
    status: "dispatched",
    turnId: requireIdentity(input.turnId, "Wake Turn id"),
    createdAt: input.now.toISOString()
  };
  validateTaskWake(wake);
  return wake;
}

export function validateTaskWake(wake: TaskWake): void {
  if (wake.schemaVersion !== CURRENT_TASK_WAKE_SCHEMA_VERSION) {
    throw new Error(
      `Task wake ${wake.id} must use schemaVersion ${CURRENT_TASK_WAKE_SCHEMA_VERSION}.`
    );
  }
  if (wake.seq !== wakeSequence(wake.id)) {
    throw new Error(`Task wake id/seq mismatch: ${wake.id} vs ${wake.seq}.`);
  }
  if (wake.reasons.length === 0) {
    throw new Error(`Task wake ${wake.id} must carry at least one reason.`);
  }
  if (Date.parse(wake.fromCursor) > Date.parse(wake.toCursor)) {
    throw new Error(`Task wake ${wake.id} cursor window is inverted.`);
  }
  if (wake.status !== "dispatched" && wake.status !== "consumed") {
    throw new Error(`Task wake ${wake.id} has invalid status: ${String(wake.status)}.`);
  }
  if (wake.status === "consumed" && wake.consumedAt === undefined) {
    throw new Error(`Task wake ${wake.id} is consumed without consumedAt.`);
  }
  if (wake.status === "dispatched" && wake.consumedAt !== undefined) {
    throw new Error(`Task wake ${wake.id} is dispatched but carries consumedAt.`);
  }
}

export function markTaskWakeConsumed(wake: TaskWake, now: Date): TaskWake {
  if (wake.status === "consumed") return wake;
  return Object.freeze({ ...wake, status: "consumed", consumedAt: now.toISOString() });
}

/** Latest wake by sequence, or null when the ledger is empty. */
export function latestTaskWake(wakes: readonly TaskWake[]): TaskWake | null {
  let latest: TaskWake | null = null;
  for (const wake of wakes) {
    if (latest === null || wake.seq > latest.seq) latest = wake;
  }
  return latest;
}

/**
 * The delta lower bound for a Task's first wake: the last Leader Turn's
 * creation time, preserving the pre-ledger watermark semantics. When no
 * Leader Turn exists, the Task's own creation time bounds the window.
 */
export function fallbackWakeCursor(input: Readonly<{
  taskCreatedAt: string;
  leaderTurnCreatedAt?: string;
}>): string {
  return input.leaderTurnCreatedAt ?? input.taskCreatedAt;
}

function wakeSequence(id: string): number {
  const prefix = `${TASK_RECORD_ID_PREFIXES.taskWake}-`;
  if (!id.startsWith(prefix)) {
    throw new Error(`Task wake id is invalid: ${id}.`);
  }
  const seq = Number(id.slice(prefix.length));
  return requirePositiveInteger(seq, "Task wake seq");
}
