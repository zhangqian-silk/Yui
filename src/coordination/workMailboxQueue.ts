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
 * A terminal Run and its processing mailbox batch are one consistency
 * boundary. Silently accepting a missing or mismatched batch would leave
 * durable work stuck in `processing` after the Run has already ended.
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
 * Settles the exact Run delivery boundary, including the short window before
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
  const pendingKey = mailbox.pending.normal === pending ? "normal" : "userCorrection";
  if (mailbox.pending[pendingKey] !== pending) return "absent";
  store.saveWorkMailbox(consumePendingBatch(
    mailbox,
    pendingKey === "normal" ? "normal" : "user-correction"
  ));
  return "pending";
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
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
