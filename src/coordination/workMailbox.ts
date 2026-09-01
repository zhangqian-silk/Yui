import {
  validateTaskRecordReference,
  type TaskRecordKind
} from "../task/taskRecordReference.js";

export type MailboxTarget =
  | Readonly<{ kind: "task"; taskId: string }>
  | Readonly<{ kind: "role"; taskId: string; roleName: string }>
  | Readonly<{ kind: "role-runtime"; taskId: string; roleName: string }>
  | Readonly<{ kind: "global-role-runtime"; roleName: string }>
  | Readonly<{ kind: "operator" }>;

export type MailboxEntityType =
  | "task"
  | "turn"
  | "work-item"
  | "input"
  | "session"
  | "message"
  | "event";

export type MailboxEntityRef =
  | Readonly<{ type: "task" | "session"; id: string }>
  | Readonly<{
      type: "turn" | "work-item" | "input" | "message" | "event";
      taskId: string;
      id: string;
    }>;

/** A durable hint to reread current facts, never a Provider delivery log. */
export type WorkSignal = Readonly<{
  reason: string;
  refs: readonly MailboxEntityRef[];
  occurredAt: string;
  source?: string;
  dedupeKey?: string;
  factRevision?: number;
}>;

export type PendingBatch = Readonly<{
  fromSequence: number;
  toSequence: number;
  reasons: readonly string[];
  refs: readonly MailboxEntityRef[];
  requestCount: number;
  firstQueuedAt: string;
  lastQueuedAt: string;
  sources: readonly string[];
  dedupeKeys: readonly string[];
  highestFactRevision?: number;
}>;

/** Generic controller claim used only by atomic non-Provider work. */
export type ProcessingBatch = Readonly<{
  batchId: string;
  batch: PendingBatch;
  owner: string;
  startedAt: string;
  executionRef?: MailboxEntityRef;
}>;

export type WorkMailbox = Readonly<{
  schemaVersion: 5;
  target: MailboxTarget;
  nextSequence: number;
  processing: ProcessingBatch | null;
  pending: PendingBatch | null;
  recentDedupeKeys: readonly string[];
}>;

export type ClaimOptions = Readonly<{
  batchId: string;
  owner: string;
  startedAt: string;
}>;

const RECENT_DEDUPE_KEY_LIMIT = 256;

export function createWorkMailbox(target: MailboxTarget): WorkMailbox {
  return {
    schemaVersion: 5,
    target: copyTarget(target),
    nextSequence: 1,
    processing: null,
    pending: null,
    recentDedupeKeys: []
  };
}

export function validateWorkMailbox(value: unknown): WorkMailbox {
  const mailbox = record(value, "WorkMailbox");
  exact(
    mailbox,
    ["schemaVersion", "target", "nextSequence", "processing", "pending", "recentDedupeKeys"],
    "WorkMailbox"
  );
  if (mailbox.schemaVersion !== 5) throw new Error("WorkMailbox must use schemaVersion 5");
  const target = parseTarget(mailbox.target);
  const nextSequence = requireInteger(mailbox.nextSequence, 1, "WorkMailbox nextSequence");
  const processing = mailbox.processing === null ? null : parseProcessing(mailbox.processing);
  const pending = mailbox.pending === null ? null : parseBatch(mailbox.pending, "WorkMailbox pending");
  const recentDedupeKeys = requireStringArray(
    mailbox.recentDedupeKeys,
    "WorkMailbox recent dedupe keys"
  );
  if (recentDedupeKeys.length > RECENT_DEDUPE_KEY_LIMIT) {
    throw new Error("WorkMailbox recent dedupe keys exceed the bounded limit");
  }
  const activeKeys = new Set<string>();
  for (const batch of [processing?.batch, pending]) {
    if (batch === null || batch === undefined) continue;
    if (batch.toSequence >= nextSequence) {
      throw new Error("WorkMailbox batch sequence must be lower than nextSequence");
    }
    for (const key of batch.dedupeKeys) {
      if (activeKeys.has(key) || recentDedupeKeys.includes(key)) {
        throw new Error("WorkMailbox batches contain an already-consumed dedupe key");
      }
      activeKeys.add(key);
    }
  }
  return {
    schemaVersion: 5,
    target,
    nextSequence,
    processing,
    pending,
    recentDedupeKeys
  };
}

export function enqueueSignal(mailbox: WorkMailbox, signal: WorkSignal): WorkMailbox {
  validateWorkMailbox(mailbox);
  const reason = requireText(signal.reason, "signal reason");
  const occurredAt = requireTimestamp(signal.occurredAt, "signal occurredAt");
  const source = requireText(signal.source ?? "yui", "signal source");
  const sequence = mailbox.nextSequence;
  const dedupeKey = signal.dedupeKey === undefined
    ? `sequence:${sequence}`
    : requireText(signal.dedupeKey, "signal dedupeKey");
  if (mailboxContainsDedupeKey(mailbox, dedupeKey)) return mailbox;
  const incoming: PendingBatch = {
    fromSequence: sequence,
    toSequence: sequence,
    reasons: [reason],
    refs: appendUnique([], signal.refs.map(copyRef), mailboxEntityRefKey),
    requestCount: 1,
    firstQueuedAt: occurredAt,
    lastQueuedAt: occurredAt,
    sources: [source],
    dedupeKeys: [dedupeKey],
    ...(signal.factRevision === undefined
      ? {}
      : { highestFactRevision: requireInteger(signal.factRevision, 0, "signal factRevision") })
  };
  return validateWorkMailbox({
    ...mailbox,
    nextSequence: sequence + 1,
    pending: mailbox.pending === null ? incoming : mergeBatches(mailbox.pending, incoming)
  });
}

export function mailboxHasPending(mailbox: WorkMailbox): boolean {
  return mailbox.pending !== null;
}

export function nextPendingBatch(mailbox: WorkMailbox): PendingBatch | null {
  return mailbox.pending;
}

export function mailboxHasWork(mailbox: WorkMailbox): boolean {
  return mailbox.processing !== null || mailbox.pending !== null;
}

export function mailboxBatches(mailbox: WorkMailbox): readonly PendingBatch[] {
  return [mailbox.processing?.batch, mailbox.pending]
    .filter((batch): batch is PendingBatch => batch !== null && batch !== undefined);
}

export function claimPending(mailbox: WorkMailbox, options: ClaimOptions): WorkMailbox {
  validateWorkMailbox(mailbox);
  if (mailbox.processing !== null) throw new Error("Mailbox is already processing a batch");
  if (mailbox.pending === null) throw new Error("Mailbox has no pending work to claim");
  return validateWorkMailbox({
    ...mailbox,
    processing: {
      batchId: requireText(options.batchId, "batch id"),
      batch: mailbox.pending,
      owner: requireText(options.owner, "claim owner"),
      startedAt: requireTimestamp(options.startedAt, "claim startedAt")
    },
    pending: null
  });
}

export function bindExecution(
  mailbox: WorkMailbox,
  batchId: string,
  executionRef: MailboxEntityRef
): WorkMailbox {
  const processing = requireProcessing(mailbox, batchId);
  return validateWorkMailbox({
    ...mailbox,
    processing: { ...processing, executionRef: copyRef(executionRef) }
  });
}

export function completeProcessing(mailbox: WorkMailbox, batchId: string): WorkMailbox {
  const processing = requireProcessing(mailbox, batchId);
  return validateWorkMailbox({
    ...mailbox,
    processing: null,
    recentDedupeKeys: rememberDedupeKeys(
      mailbox.recentDedupeKeys,
      processing.batch.dedupeKeys
    )
  });
}

export function releaseProcessing(mailbox: WorkMailbox, batchId: string): WorkMailbox {
  const processing = requireProcessing(mailbox, batchId);
  return validateWorkMailbox({
    ...mailbox,
    processing: null,
    pending: mailbox.pending === null
      ? processing.batch
      : mergeBatches(processing.batch, mailbox.pending)
  });
}

/**
 * Consumes a whole wake or the exact submitted sequence prefix. Newer signals
 * merged while the Provider request was in flight remain pending.
 */
export function consumePendingBatch(
  mailbox: WorkMailbox,
  through?: Readonly<{ fromSequence: number; toSequence: number }>
): WorkMailbox {
  validateWorkMailbox(mailbox);
  if (mailbox.pending === null) throw new Error("Mailbox has no pending batch");
  const pending = mailbox.pending;
  if (through !== undefined) {
    if (through.fromSequence !== pending.fromSequence
      || !Number.isInteger(through.toSequence)
      || through.toSequence < through.fromSequence
      || through.toSequence > pending.toSequence) {
      throw new Error("Mailbox consumed sequence does not match the pending prefix");
    }
    if (through.toSequence < pending.toSequence) {
      const consumedCount = through.toSequence - through.fromSequence + 1;
      const keysAreSequenceAligned = pending.dedupeKeys.length === pending.requestCount;
      const consumedKeys = keysAreSequenceAligned
        ? pending.dedupeKeys.slice(0, consumedCount)
        : [];
      return validateWorkMailbox({
        ...mailbox,
        pending: {
          ...pending,
          fromSequence: through.toSequence + 1,
          requestCount: pending.toSequence - through.toSequence,
          dedupeKeys: keysAreSequenceAligned
            ? pending.dedupeKeys.slice(consumedCount)
            : pending.dedupeKeys
        },
        recentDedupeKeys: rememberDedupeKeys(mailbox.recentDedupeKeys, consumedKeys)
      });
    }
  }
  return validateWorkMailbox({
    ...mailbox,
    recentDedupeKeys: rememberDedupeKeys(mailbox.recentDedupeKeys, pending.dedupeKeys),
    pending: null
  });
}

export function mailboxTargetKey(target: MailboxTarget): string {
  const copied = copyTarget(target);
  switch (copied.kind) {
    case "operator": return "operator";
    case "task": return `task/${encodeURIComponent(copied.taskId)}`;
    case "role": return `role/${encodeURIComponent(copied.taskId)}/${encodeURIComponent(copied.roleName)}`;
    case "role-runtime":
      return `role-runtime/${encodeURIComponent(copied.taskId)}/${encodeURIComponent(copied.roleName)}`;
    case "global-role-runtime":
      return `global-role-runtime/${encodeURIComponent(copied.roleName)}`;
  }
}

export function mailboxEntityRefKey(ref: MailboxEntityRef): string {
  return !("taskId" in ref)
    ? `${ref.type}\u0000${ref.id}`
    : `${ref.type}\u0000${ref.taskId}\u0000${ref.id}`;
}

function mailboxContainsDedupeKey(mailbox: WorkMailbox, key: string): boolean {
  return mailbox.recentDedupeKeys.includes(key)
    || mailbox.pending?.dedupeKeys.includes(key) === true
    || mailbox.processing?.batch.dedupeKeys.includes(key) === true;
}

function rememberDedupeKeys(
  existing: readonly string[],
  dedupeKeys: readonly string[]
): readonly string[] {
  return appendUnique(existing, dedupeKeys, (value) => value)
    .slice(-RECENT_DEDUPE_KEY_LIMIT);
}

function mergeBatches(left: PendingBatch, right: PendingBatch): PendingBatch {
  return {
    fromSequence: Math.min(left.fromSequence, right.fromSequence),
    toSequence: Math.max(left.toSequence, right.toSequence),
    reasons: appendUnique(left.reasons, right.reasons, (reason) => reason),
    refs: appendUnique(left.refs, right.refs, mailboxEntityRefKey),
    requestCount: left.requestCount + right.requestCount,
    firstQueuedAt: Date.parse(left.firstQueuedAt) <= Date.parse(right.firstQueuedAt)
      ? left.firstQueuedAt
      : right.firstQueuedAt,
    lastQueuedAt: Date.parse(left.lastQueuedAt) >= Date.parse(right.lastQueuedAt)
      ? left.lastQueuedAt
      : right.lastQueuedAt,
    sources: appendUnique(left.sources, right.sources, (source) => source),
    dedupeKeys: appendUnique(left.dedupeKeys, right.dedupeKeys, (key) => key),
    ...((left.highestFactRevision ?? right.highestFactRevision) === undefined
      ? {}
      : {
          highestFactRevision: Math.max(
            left.highestFactRevision ?? 0,
            right.highestFactRevision ?? 0
          )
        })
  };
}

function parseBatch(value: unknown, label: string): PendingBatch {
  const batch = record(value, label);
  const required = [
    "fromSequence",
    "toSequence",
    "reasons",
    "refs",
    "requestCount",
    "firstQueuedAt",
    "lastQueuedAt",
    "sources",
    "dedupeKeys"
  ];
  exact(
    batch,
    batch.highestFactRevision === undefined ? required : [...required, "highestFactRevision"],
    label
  );
  const fromSequence = requireInteger(batch.fromSequence, 1, `${label} fromSequence`);
  const toSequence = requireInteger(batch.toSequence, fromSequence, `${label} toSequence`);
  const requestCount = requireInteger(batch.requestCount, 1, `${label} requestCount`);
  if (requestCount > toSequence - fromSequence + 1) {
    throw new Error(`${label} requestCount exceeds its sequence envelope`);
  }
  const reasons = requireStringArray(batch.reasons, `${label} reasons`);
  if (reasons.length === 0) throw new Error(`${label} reasons must not be empty`);
  if (!Array.isArray(batch.refs)) throw new Error(`${label} refs must be an array`);
  const refs = batch.refs.map((ref, index) => parseRef(ref, `${label} refs[${index}]`));
  if (new Set(refs.map(mailboxEntityRefKey)).size !== refs.length) {
    throw new Error(`${label} refs must not contain duplicates`);
  }
  return {
    fromSequence,
    toSequence,
    reasons,
    refs,
    requestCount,
    firstQueuedAt: requireTimestamp(batch.firstQueuedAt, `${label} firstQueuedAt`),
    lastQueuedAt: requireTimestamp(batch.lastQueuedAt, `${label} lastQueuedAt`),
    sources: requireStringArray(batch.sources, `${label} sources`),
    dedupeKeys: requireStringArray(batch.dedupeKeys, `${label} dedupeKeys`),
    ...(batch.highestFactRevision === undefined
      ? {}
      : {
          highestFactRevision: requireInteger(
            batch.highestFactRevision,
            0,
            `${label} highestFactRevision`
          )
        })
  };
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
    : {
        ...result,
        executionRef: parseRef(
          processing.executionRef,
          "WorkMailbox processing executionRef"
        )
      };
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
    case "role-runtime":
      exact(target, ["kind", "taskId", "roleName"], `WorkMailbox ${target.kind} target`);
      return {
        kind: target.kind,
        taskId: requireString(target.taskId, "WorkMailbox target taskId"),
        roleName: requireString(target.roleName, "WorkMailbox target roleName")
      };
    case "global-role-runtime":
      exact(target, ["kind", "roleName"], "WorkMailbox global role runtime target");
      return {
        kind: "global-role-runtime",
        roleName: requireString(target.roleName, "WorkMailbox target roleName")
      };
    default:
      throw new Error("WorkMailbox target kind is invalid");
  }
}

function parseRef(value: unknown, label: string): MailboxEntityRef {
  const ref = record(value, label);
  const types: readonly MailboxEntityType[] = [
    "task", "turn", "work-item", "input", "session", "message", "event"
  ];
  if (!types.includes(ref.type as MailboxEntityType)) throw new Error(`${label} type is invalid`);
  if (ref.type === "task" || ref.type === "session") {
    exact(ref, ["type", "id"], label);
    return { type: ref.type, id: requireString(ref.id, `${label} id`) };
  }
  exact(ref, ["type", "taskId", "id"], label);
  return copyRef({
    type: ref.type as "turn" | "work-item" | "input" | "message" | "event",
    taskId: requireString(ref.taskId, `${label} taskId`),
    id: requireString(ref.id, `${label} id`)
  });
}

function requireProcessing(mailbox: WorkMailbox, batchId: string): ProcessingBatch {
  validateWorkMailbox(mailbox);
  const normalizedBatchId = requireText(batchId, "batch id");
  if (mailbox.processing === null) throw new Error("Mailbox has no processing batch");
  if (mailbox.processing.batchId !== normalizedBatchId) {
    throw new Error(`Mailbox processing batch id does not match ${normalizedBatchId}`);
  }
  return mailbox.processing;
}

function copyTarget(target: MailboxTarget): MailboxTarget {
  switch (target.kind) {
    case "operator": return { kind: "operator" };
    case "task": return { kind: "task", taskId: requireText(target.taskId, "taskId") };
    case "role":
    case "role-runtime":
      return {
        kind: target.kind,
        taskId: requireText(target.taskId, "taskId"),
        roleName: requireText(target.roleName, "roleName")
      };
    case "global-role-runtime":
      return {
        kind: "global-role-runtime",
        roleName: requireText(target.roleName, "roleName")
      };
  }
}

function copyRef(ref: MailboxEntityRef): MailboxEntityRef {
  if (!("taskId" in ref)) {
    if (ref.type !== "task" && ref.type !== "session") {
      throw new Error(`entity reference taskId is required for ${ref.type}`);
    }
    return { type: ref.type, id: requireText(ref.id, "entity reference id") };
  }
  const validated = validateTaskRecordReference({
    taskId: ref.taskId,
    localId: ref.id
  }, mailboxTaskRecordKind(ref.type));
  return { type: ref.type, taskId: validated.taskId, id: validated.localId };
}

function mailboxTaskRecordKind(
  type: "turn" | "work-item" | "input" | "message" | "event"
): TaskRecordKind {
  switch (type) {
    case "turn": return "turn";
    case "work-item": return "workItem";
    case "input": return "inputRequest";
    case "message": return "message";
    case "event": return "event";
  }
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
    if (keys.has(key)) continue;
    keys.add(key);
    result.push(value);
  }
  return result;
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

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  return normalized;
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

function requireInteger(value: unknown, minimum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((item, index) => requireString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}
