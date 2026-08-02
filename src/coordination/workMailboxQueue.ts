import {
  completeProcessing,
  createWorkMailbox,
  enqueueSignal,
  mailboxEntityRefKey,
  type MailboxEntityRef,
  type MailboxTarget,
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
  refs: readonly MailboxEntityRef[] = []
): WorkMailbox {
  const mailbox = store.getWorkMailbox(target) ?? createWorkMailbox(target);
  const queued = enqueueSignal(mailbox, {
    reason,
    refs,
    occurredAt: timestamp(occurredAt)
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
