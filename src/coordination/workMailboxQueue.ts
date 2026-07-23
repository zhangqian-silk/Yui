import {
  completeProcessing,
  createWorkMailbox,
  enqueueSignal,
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
    || processing.executionRef?.type !== executionRef.type
    || processing.executionRef.id !== executionRef.id
  ) {
    return false;
  }
  store.saveWorkMailbox(completeProcessing(mailbox, processing.batchId));
  return true;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
