import {
  completeProcessing,
  consumePendingBatch,
  createWorkMailbox,
  enqueueSignal,
  mailboxBatches,
  mailboxEntityRefKey,
  type MailboxEntityRef,
  type MailboxTarget,
  type WorkSignal,
  type WorkMailbox
} from "./workMailbox.js";

export type WorkMailboxQueueStore = Readonly<{
  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
  saveWorkMailbox(mailbox: WorkMailbox): void;
}>;

export type RoleTurnDispatchIdentity = Readonly<{
  taskId: string;
  roleName: string;
  turnId: string;
}>;

export type RoleTurnDispatchToken =
  | Readonly<{
      kind: "pending";
      fromSequence: number;
      toSequence: number;
    }>
  | Readonly<{
      kind: "processing";
      batchId: string;
    }>;

export type RoleTurnDispatchSettlement = "settled" | "absent" | "state-changed";

const LEGACY_ROLE_TURN_DISPATCH_REASONS = new Set([
  "turn-dispatched",
  "turn-retried",
  "review-requested",
  "workitem-synthesis-ready",
  "review-synthesis-ready"
]);

/** Atomically useful when called inside the caller's TaskStore transaction. */
export function enqueueWork(
  store: WorkMailboxQueueStore,
  target: MailboxTarget,
  reason: string,
  occurredAt: Date | string,
  refs: readonly MailboxEntityRef[] = [],
  metadata: Omit<WorkSignal, "reason" | "refs" | "occurredAt"> = {}
): WorkMailbox {
  const mailbox = store.getWorkMailbox(target) ?? createWorkMailbox(target);
  const queued = enqueueSignal(mailbox, {
    reason,
    refs,
    occurredAt: timestamp(occurredAt),
    ...metadata
  });
  store.saveWorkMailbox(queued);
  return queued;
}

/**
 * The sole ordinary Role Turn wake shape. The Turn is durable execution
 * authority; this signal only asks the Controller to deliver that exact Turn.
 * Leader is deliberately excluded because its Role mailbox is reserved for
 * semantic event wakes and force-steer batches. A Leader active Turn is
 * selected directly from durable state by its targeted Controller pass.
 */
export function enqueueRoleTurnDispatch(
  store: WorkMailboxQueueStore,
  input: RoleTurnDispatchIdentity & Readonly<{
    reason: string;
    occurredAt: Date | string;
  }>
): WorkMailbox | null {
  if (input.roleName === "leader") return null;
  return enqueueWork(
    store,
    roleTurnTarget(input),
    input.reason,
    input.occurredAt,
    [roleTurnRef(input)],
    {
      source: "turn-dispatch",
      dedupeKey: roleTurnDispatchDedupeKey(input)
    }
  );
}

/**
 * Captures only the mailbox prefix that contains one exact Role Turn dispatch.
 * A later signal may append while Provider delivery is in flight; its suffix
 * remains pending when this token is settled.
 */
export function captureRoleTurnDispatch(
  mailbox: WorkMailbox | null,
  input: RoleTurnDispatchIdentity
): RoleTurnDispatchToken | null {
  if (input.roleName === "leader"
    || mailbox === null
    || mailbox.target.kind !== "role"
    || mailbox.target.taskId !== input.taskId
    || mailbox.target.roleName !== input.roleName) {
    return null;
  }
  const exactRef = roleTurnRef(input);
  if (mailbox.processing?.executionRef !== undefined
    && mailboxEntityRefKey(mailbox.processing.executionRef) === mailboxEntityRefKey(exactRef)) {
    return {
      kind: "processing",
      batchId: mailbox.processing.batchId
    };
  }
  const pending = mailbox.pending;
  if (pending === null) return null;
  const dedupeKey = roleTurnDispatchDedupeKey(input);
  if (mailbox.recentDedupeKeys.includes(dedupeKey)) return null;
  const keyIndex = pending.dedupeKeys.indexOf(dedupeKey);
  if (keyIndex >= 0 && pending.dedupeKeys.length === pending.requestCount) {
    const turnSequence = pending.fromSequence + keyIndex;
    if (turnSequence <= pending.toSequence) {
      return {
        kind: "pending",
        fromSequence: pending.fromSequence,
        toSequence: turnSequence
      };
    }
  }
  // Valid earlier dispatches used sequence-generated dedupe keys and could
  // include a companion WorkItem ref. Consume that complete legacy batch once
  // the exact Turn reaches an accepted or terminal boundary.
  if (pending.requestCount === 1
    && pending.sources.length === 1
    && pending.sources[0] === "yui"
    && pending.reasons.some((reason) => LEGACY_ROLE_TURN_DISPATCH_REASONS.has(reason))
    && pending.refs.some((ref) => (
      mailboxEntityRefKey(ref) === mailboxEntityRefKey(exactRef)
    ))) {
    return {
      kind: "pending",
      fromSequence: pending.fromSequence,
      toSequence: pending.toSequence
    };
  }
  return null;
}

/**
 * Settles one exact ordinary Role Turn dispatch. Provider acceptance is the
 * normal boundary; terminalization calls the same operation for conclusively
 * unaccepted and valid earlier dispatches.
 */
export function settleRoleTurnDispatch(
  store: WorkMailboxQueueStore,
  input: RoleTurnDispatchIdentity,
  expected?: RoleTurnDispatchToken | null
): RoleTurnDispatchSettlement {
  if (expected === null) return "absent";
  const target = roleTurnTarget(input);
  const mailbox = store.getWorkMailbox(target);
  const current = captureRoleTurnDispatch(mailbox, input);
  if (current === null || mailbox === null) return "absent";
  if (expected !== undefined && !sameRoleTurnDispatchToken(current, expected)) {
    return "state-changed";
  }
  const token = expected ?? current;
  if (token.kind === "processing") {
    if (mailbox.processing?.batchId !== token.batchId) return "state-changed";
    store.saveWorkMailbox(completeProcessing(mailbox, token.batchId));
    return "settled";
  }
  if (mailbox.pending === null
    || mailbox.pending.fromSequence !== token.fromSequence
    || mailbox.pending.toSequence < token.toSequence) {
    return "state-changed";
  }
  store.saveWorkMailbox(consumePendingBatch(mailbox, token));
  return "settled";
}

/** Completes only the batch owned by the matching durable execution. */
export function completeWorkExecution(
  store: WorkMailboxQueueStore,
  target: MailboxTarget,
  executionRef: MailboxEntityRef
): boolean {
  const mailbox = store.getWorkMailbox(target);
  const processing = mailbox?.processing;
  if (
    mailbox === null
    || processing === undefined
    || processing === null
    || processing.executionRef === undefined
    || mailboxEntityRefKey(processing.executionRef) !== mailboxEntityRefKey(executionRef)
  ) {
    return false;
  }
  store.saveWorkMailbox(completeProcessing(mailbox, processing.batchId));
  return true;
}

/**
 * Completes a mailbox execution or fails the surrounding transaction.
 *
 * A terminal Turn and its processing mailbox batch are one consistency
 * boundary. Silently accepting a missing or mismatched batch would leave
 * durable work stuck in `processing` after the Turn has already ended.
 */
export function requireCompleteWorkExecution(
  store: WorkMailboxQueueStore,
  target: MailboxTarget,
  executionRef: MailboxEntityRef
): void {
  const mailbox = store.getWorkMailbox(target);
  const processing = mailbox?.processing;
  if (mailbox === null || processing === null || processing === undefined) {
    throw new Error(
      `Work mailbox has no processing execution for ${targetLabel(target)}: `
      + `${executionRef.type}/${executionRef.id}.`
    );
  }
  if (processing.executionRef === undefined) {
    throw new Error(
      `Work mailbox processing batch is not bound for ${targetLabel(target)}: `
      + `${executionRef.type}/${executionRef.id}.`
    );
  }
  if (completeWorkExecution(store, target, executionRef)) return;
  throw new Error(
    `Work mailbox execution mismatch for ${targetLabel(target)}: `
    + `${executionRef.type}/${executionRef.id}.`
  );
}

/**
 * Settles the exact Turn delivery boundary, including the short window before
 * the scheduler has claimed its single pending dispatch. A merged pending
 * batch is never discarded because its signal-to-ref mapping is no longer
 * recoverable.
 */
export function settleExactWorkExecution(
  store: WorkMailboxQueueStore,
  target: MailboxTarget,
  executionRef: MailboxEntityRef
): "processing" | "pending" | "absent" {
  if (completeWorkExecution(store, target, executionRef)) return "processing";
  const mailbox = store.getWorkMailbox(target);
  if (mailbox === null) return "absent";
  const matching = mailboxBatches(mailbox).filter((batch) => batch.refs.some(
    (ref) => mailboxEntityRefKey(ref) === mailboxEntityRefKey(executionRef)
  ));
  if (matching.length === 0) return "absent";
  if (matching.length !== 1 || matching[0]!.requestCount !== 1) {
    throw new Error(
      `Cannot settle a merged pending mailbox batch for ${targetLabel(target)}: `
      + `${executionRef.type}/${executionRef.id}.`
    );
  }
  const pending = matching[0]!;
  if (mailbox.pending !== pending) return "absent";
  store.saveWorkMailbox(consumePendingBatch(mailbox));
  return "pending";
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function roleTurnTarget(
  input: Pick<RoleTurnDispatchIdentity, "taskId" | "roleName">
): Extract<MailboxTarget, { kind: "role" }> {
  return {
    kind: "role",
    taskId: input.taskId,
    roleName: input.roleName
  };
}

function roleTurnRef(input: RoleTurnDispatchIdentity): MailboxEntityRef {
  return {
    type: "turn",
    taskId: input.taskId,
    id: input.turnId
  };
}

function roleTurnDispatchDedupeKey(input: RoleTurnDispatchIdentity): string {
  return `role-turn:${input.taskId}:${input.roleName}:${input.turnId}`;
}

function sameRoleTurnDispatchToken(
  left: RoleTurnDispatchToken,
  right: RoleTurnDispatchToken
): boolean {
  return left.kind === right.kind
    && (left.kind === "pending"
      ? right.kind === "pending"
        && left.fromSequence === right.fromSequence
        && left.toSequence === right.toSequence
      : right.kind === "processing" && left.batchId === right.batchId);
}

function targetLabel(target: MailboxTarget): string {
  switch (target.kind) {
    case "operator": return "operator";
    case "task": return `task/${target.taskId}`;
    case "role": return `role/${target.taskId}/${target.roleName}`;
    case "role-runtime": return `role-runtime/${target.taskId}/${target.roleName}`;
    case "global-role-runtime": return `global-role-runtime/${target.roleName}`;
  }
}
