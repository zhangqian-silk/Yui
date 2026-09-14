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
  getTask?(taskId: string): Readonly<{ status: string }> | null;
}>;

export type RoleRunDispatchIdentity = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
}>;

export type RoleRunDispatchToken =
  | Readonly<{
      kind: "pending";
      fromSequence: number;
      toSequence: number;
    }>
  | Readonly<{
      kind: "processing";
      batchId: string;
    }>;

export type RoleRunDispatchSettlement = "settled" | "absent" | "state-changed";

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
  // Archive is an admission boundary, not an acknowledgement of old input.
  // Runtime cleanup mailboxes remain usable for exact-owner recovery.
  if ((target.kind === "task" || target.kind === "role")
    && store.getTask?.(target.taskId)?.status === "archived") return mailbox;
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
 * The sole ordinary Role AgentRun wake shape. The AgentRun is durable execution
 * authority; this signal only asks the Controller to deliver that exact AgentRun.
 * Leader is deliberately excluded because its Role mailbox is reserved for
 * semantic event wakes and force-steer batches. A Leader active AgentRun is
 * selected directly from durable state by its targeted Controller pass.
 */
export function enqueueRoleRunDispatch(
  store: WorkMailboxQueueStore,
  input: RoleRunDispatchIdentity & Readonly<{
    reason: string;
    occurredAt: Date | string;
  }>
): WorkMailbox | null {
  if (input.roleName === "leader") return null;
  return enqueueWork(
    store,
    roleRunTarget(input),
    input.reason,
    input.occurredAt,
    [roleRunRef(input)],
    {
      source: "turn-dispatch",
      dedupeKey: roleRunDispatchDedupeKey(input)
    }
  );
}

/**
 * Captures only the mailbox prefix that contains one exact Role AgentRun dispatch.
 * A later signal may append while Provider delivery is in flight; its suffix
 * remains pending when this token is settled.
 */
export function captureRoleRunDispatch(
  mailbox: WorkMailbox | null,
  input: RoleRunDispatchIdentity
): RoleRunDispatchToken | null {
  if (mailbox === null
    || mailbox.target.kind !== "role"
    || mailbox.target.taskId !== input.taskId
    || mailbox.target.roleName !== input.roleName) {
    return null;
  }
  const exactRef = roleRunRef(input);
  if (mailbox.processing?.executionRef !== undefined
    && mailboxEntityRefKey(mailbox.processing.executionRef) === mailboxEntityRefKey(exactRef)) {
    return {
      kind: "processing",
      batchId: mailbox.processing.batchId
    };
  }
  // A Leader's initial planning batch may be explicitly bound to its Run.
  // Never infer a Leader dispatch from pending semantic notifications.
  if (input.roleName === "leader") return null;
  const pending = mailbox.pending;
  if (pending === null) return null;
  const dedupeKey = roleRunDispatchDedupeKey(input);
  if (mailbox.recentDedupeKeys.includes(dedupeKey)) return null;
  const keyIndex = pending.dedupeKeys.indexOf(dedupeKey);
  if (keyIndex >= 0 && pending.dedupeKeys.length === pending.requestCount) {
    const runSequence = pending.fromSequence + keyIndex;
    if (runSequence <= pending.toSequence) {
      return {
        kind: "pending",
        fromSequence: pending.fromSequence,
        toSequence: runSequence
      };
    }
  }
  return null;
}

/**
 * Settles one exact ordinary Role AgentRun dispatch. Provider acceptance is the
 * normal boundary; terminalization uses the same exact dispatch identity.
 */
export function settleRoleRunDispatch(
  store: WorkMailboxQueueStore,
  input: RoleRunDispatchIdentity,
  expected?: RoleRunDispatchToken | null
): RoleRunDispatchSettlement {
  if (expected === null) return "absent";
  const target = roleRunTarget(input);
  const mailbox = store.getWorkMailbox(target);
  const current = captureRoleRunDispatch(mailbox, input);
  if (current === null || mailbox === null) return "absent";
  if (expected !== undefined && !sameRoleRunDispatchToken(current, expected)) {
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
 * A terminal AgentRun and its processing mailbox batch are one consistency
 * boundary. Silently accepting a missing or mismatched batch would leave
 * durable work stuck in `processing` after the AgentRun has already ended.
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
 * Settles the exact AgentRun delivery boundary, including the short window before
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

function roleRunTarget(
  input: Pick<RoleRunDispatchIdentity, "taskId" | "roleName">
): Extract<MailboxTarget, { kind: "role" }> {
  return {
    kind: "role",
    taskId: input.taskId,
    roleName: input.roleName
  };
}

function roleRunRef(input: RoleRunDispatchIdentity): MailboxEntityRef {
  return {
    type: "run",
    taskId: input.taskId,
    id: input.runId
  };
}

function roleRunDispatchDedupeKey(input: RoleRunDispatchIdentity): string {
  return `role-turn:${input.taskId}:${input.roleName}:${input.runId}`;
}

function sameRoleRunDispatchToken(
  left: RoleRunDispatchToken,
  right: RoleRunDispatchToken
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
