export type MailboxTarget =
  | Readonly<{ kind: "task"; taskId: string }>
  | Readonly<{ kind: "role"; taskId: string; roleName: string }>
  | Readonly<{ kind: "operator" }>;

export type MailboxEntityType =
  | "task"
  | "run"
  | "work-item"
  | "input"
  | "session"
  | "message";

export type MailboxEntityRef = Readonly<{
  type: MailboxEntityType;
  id: string;
}>;

export type WorkSignal = Readonly<{
  reason: string;
  refs: readonly MailboxEntityRef[];
  occurredAt: string;
}>;

export type PendingBatch = Readonly<{
  fromSequence: number;
  toSequence: number;
  reasons: readonly string[];
  refs: readonly MailboxEntityRef[];
  requestCount: number;
  firstQueuedAt: string;
  lastQueuedAt: string;
  availableAt?: string;
}>;

export type ProcessingBatch = Readonly<{
  batchId: string;
  batch: PendingBatch;
  owner: string;
  startedAt: string;
  executionRef?: MailboxEntityRef;
}>;

export type WorkMailbox = Readonly<{
  schemaVersion: 1;
  target: MailboxTarget;
  nextSequence: number;
  processing: ProcessingBatch | null;
  pending: PendingBatch | null;
}>;

export type ClaimOptions = Readonly<{
  batchId: string;
  owner: string;
  startedAt: string;
}>;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function requireInteger(value: unknown, minimum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown field: ${unknown}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new Error(`${label} is missing field: ${missing}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return requireText(value, label);
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be a timestamp`);
  return timestamp;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((item, index) => requireString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}

function copyTarget(target: MailboxTarget): MailboxTarget {
  switch (target.kind) {
    case "task":
      return { kind: "task", taskId: requireText(target.taskId, "taskId") };
    case "role":
      return {
        kind: "role",
        taskId: requireText(target.taskId, "taskId"),
        roleName: requireText(target.roleName, "roleName")
      };
    case "operator":
      return { kind: "operator" };
  }
}

export function mailboxTargetKey(target: MailboxTarget): string {
  const copied = copyTarget(target);
  switch (copied.kind) {
    case "operator": return "operator";
    case "task": return `task/${encodeURIComponent(copied.taskId)}`;
    case "role": return `role/${encodeURIComponent(copied.taskId)}/${encodeURIComponent(copied.roleName)}`;
  }
}

function copyRef(ref: MailboxEntityRef): MailboxEntityRef {
  return {
    type: ref.type,
    id: requireText(ref.id, "entity reference id")
  };
}

function appendUnique<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (value: T) => string
): T[] {
  const result = [...existing];
  const keys = new Set(existing.map(keyOf));
  for (const value of incoming) {
    const key = keyOf(value);
    if (!keys.has(key)) {
      keys.add(key);
      result.push(value);
    }
  }
  return result;
}

function mergeBatches(earlier: PendingBatch, later: PendingBatch): PendingBatch {
  const merged: PendingBatch = {
    fromSequence: earlier.fromSequence,
    toSequence: later.toSequence,
    reasons: appendUnique(earlier.reasons, later.reasons, (reason) => reason),
    refs: appendUnique(
      earlier.refs,
      later.refs,
      (ref) => `${ref.type}\u0000${ref.id}`
    ),
    requestCount: earlier.requestCount + later.requestCount,
    firstQueuedAt: earlier.firstQueuedAt,
    lastQueuedAt: later.lastQueuedAt
  };
  if (later.availableAt !== undefined) {
    return { ...merged, availableAt: later.availableAt };
  }
  if (earlier.availableAt !== undefined) {
    return { ...merged, availableAt: earlier.availableAt };
  }
  return merged;
}

function requireProcessing(mailbox: WorkMailbox, batchId: string): ProcessingBatch {
  const normalizedBatchId = requireText(batchId, "batch id");
  if (mailbox.processing === null) {
    throw new Error("Mailbox has no processing batch");
  }
  if (mailbox.processing.batchId !== normalizedBatchId) {
    throw new Error(
      `Mailbox processing batch id does not match ${normalizedBatchId}`
    );
  }
  return mailbox.processing;
}

export function createWorkMailbox(target: MailboxTarget): WorkMailbox {
  return {
    schemaVersion: 1,
    target: copyTarget(target),
    nextSequence: 1,
    processing: null,
    pending: null
  };
}

export function validateWorkMailbox(value: unknown): WorkMailbox {
  const mailbox = record(value, "WorkMailbox");
  exact(mailbox, ["schemaVersion", "target", "nextSequence", "processing", "pending"], "WorkMailbox");
  if (mailbox.schemaVersion !== 1) throw new Error("WorkMailbox must use schemaVersion 1");
  const target = parseTarget(mailbox.target);
  const nextSequence = requireInteger(mailbox.nextSequence, 1, "WorkMailbox nextSequence");
  const processing = mailbox.processing === null ? null : parseProcessing(mailbox.processing);
  const pending = mailbox.pending === null ? null : parseBatch(mailbox.pending, "WorkMailbox pending");
  const batches = [processing?.batch, pending].filter(
    (batch): batch is PendingBatch => batch !== null && batch !== undefined
  );
  for (const batch of batches) {
    if (batch.toSequence >= nextSequence) {
      throw new Error("WorkMailbox batch sequence must be lower than nextSequence");
    }
  }
  if (processing !== null && pending !== null && processing.batch.toSequence >= pending.fromSequence) {
    throw new Error("WorkMailbox processing and pending sequences overlap");
  }
  return { schemaVersion: 1, target, nextSequence, processing, pending };
}

function parseTarget(value: unknown): MailboxTarget {
  const target = record(value, "WorkMailbox target");
  switch (target.kind) {
    case "operator":
      exact(target, ["kind"], "WorkMailbox operator target");
      return { kind: "operator" };
    case "task":
      exact(target, ["kind", "taskId"], "WorkMailbox task target");
      return { kind: "task", taskId: requireString(target.taskId, "WorkMailbox target taskId") };
    case "role":
      exact(target, ["kind", "taskId", "roleName"], "WorkMailbox role target");
      return {
        kind: "role",
        taskId: requireString(target.taskId, "WorkMailbox target taskId"),
        roleName: requireString(target.roleName, "WorkMailbox target roleName")
      };
    default:
      throw new Error("WorkMailbox target kind is invalid");
  }
}

function parseRef(value: unknown, label: string): MailboxEntityRef {
  const ref = record(value, label);
  exact(ref, ["type", "id"], label);
  const types: readonly MailboxEntityType[] = ["task", "run", "work-item", "input", "session", "message"];
  if (!types.includes(ref.type as MailboxEntityType)) throw new Error(`${label} type is invalid`);
  return { type: ref.type as MailboxEntityType, id: requireString(ref.id, `${label} id`) };
}

function parseBatch(value: unknown, label: string): PendingBatch {
  const batch = record(value, label);
  const required = ["fromSequence", "toSequence", "reasons", "refs", "requestCount", "firstQueuedAt", "lastQueuedAt"];
  exact(batch, batch.availableAt === undefined ? required : [...required, "availableAt"], label);
  const fromSequence = requireInteger(batch.fromSequence, 1, `${label} fromSequence`);
  const toSequence = requireInteger(batch.toSequence, fromSequence, `${label} toSequence`);
  const requestCount = requireInteger(batch.requestCount, 1, `${label} requestCount`);
  if (requestCount !== toSequence - fromSequence + 1) {
    throw new Error(`${label} requestCount does not match its sequence range`);
  }
  const reasons = requireStringArray(batch.reasons, `${label} reasons`);
  if (reasons.length === 0) throw new Error(`${label} reasons must not be empty`);
  if (!Array.isArray(batch.refs)) throw new Error(`${label} refs must be an array`);
  const refs = batch.refs.map((ref, index) => parseRef(ref, `${label} refs[${index}]`));
  const refKeys = refs.map((ref) => `${ref.type}\u0000${ref.id}`);
  if (new Set(refKeys).size !== refKeys.length) throw new Error(`${label} refs must not contain duplicates`);
  const result: PendingBatch = {
    fromSequence,
    toSequence,
    reasons,
    refs,
    requestCount,
    firstQueuedAt: requireTimestamp(batch.firstQueuedAt, `${label} firstQueuedAt`),
    lastQueuedAt: requireTimestamp(batch.lastQueuedAt, `${label} lastQueuedAt`)
  };
  return batch.availableAt === undefined
    ? result
    : { ...result, availableAt: requireTimestamp(batch.availableAt, `${label} availableAt`) };
}

function parseProcessing(value: unknown): ProcessingBatch {
  const processing = record(value, "WorkMailbox processing");
  const required = ["batchId", "batch", "owner", "startedAt"];
  exact(
    processing,
    processing.executionRef === undefined ? required : [...required, "executionRef"],
    "WorkMailbox processing"
  );
  const result: ProcessingBatch = {
    batchId: requireString(processing.batchId, "WorkMailbox processing batchId"),
    batch: parseBatch(processing.batch, "WorkMailbox processing batch"),
    owner: requireString(processing.owner, "WorkMailbox processing owner"),
    startedAt: requireTimestamp(processing.startedAt, "WorkMailbox processing startedAt")
  };
  return processing.executionRef === undefined
    ? result
    : { ...result, executionRef: parseRef(processing.executionRef, "WorkMailbox processing executionRef") };
}

export function enqueueSignal(
  mailbox: WorkMailbox,
  signal: WorkSignal
): WorkMailbox {
  const reason = requireText(signal.reason, "signal reason");
  const occurredAt = requireText(signal.occurredAt, "signal occurredAt");
  const refs = signal.refs.map(copyRef);
  const sequence = mailbox.nextSequence;
  const incoming: PendingBatch = {
    fromSequence: sequence,
    toSequence: sequence,
    reasons: [reason],
    refs: appendUnique([], refs, (ref) => `${ref.type}\u0000${ref.id}`),
    requestCount: 1,
    firstQueuedAt: occurredAt,
    lastQueuedAt: occurredAt
  };

  return {
    ...mailbox,
    nextSequence: sequence + 1,
    pending: mailbox.pending === null
      ? incoming
      : mergeBatches(mailbox.pending, incoming)
  };
}

export function claimPending(
  mailbox: WorkMailbox,
  options: ClaimOptions
): WorkMailbox {
  if (mailbox.processing !== null) {
    throw new Error("Mailbox is already processing a batch");
  }
  if (mailbox.pending === null) {
    throw new Error("Mailbox has no pending work to claim");
  }

  const processing: ProcessingBatch = {
    batchId: requireText(options.batchId, "batch id"),
    batch: mailbox.pending,
    owner: requireText(options.owner, "claim owner"),
    startedAt: requireText(options.startedAt, "claim startedAt")
  };
  return { ...mailbox, processing, pending: null };
}

export function bindExecution(
  mailbox: WorkMailbox,
  batchId: string,
  executionRef: MailboxEntityRef
): WorkMailbox {
  const processing = requireProcessing(mailbox, batchId);
  return {
    ...mailbox,
    processing: { ...processing, executionRef: copyRef(executionRef) }
  };
}

export function completeProcessing(
  mailbox: WorkMailbox,
  batchId: string
): WorkMailbox {
  requireProcessing(mailbox, batchId);
  return { ...mailbox, processing: null };
}

export function releaseProcessing(
  mailbox: WorkMailbox,
  batchId: string,
  availableAt?: string
): WorkMailbox {
  const processing = requireProcessing(mailbox, batchId);
  let released = mailbox.pending === null
    ? processing.batch
    : mergeBatches(processing.batch, mailbox.pending);
  if (availableAt !== undefined) {
    released = {
      ...released,
      availableAt: requireText(availableAt, "release availableAt")
    };
  }
  return { ...mailbox, processing: null, pending: released };
}
