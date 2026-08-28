import type { TaskEvent } from "../event/taskEvent.js";
import type { InputRequest } from "../input/inputRequest.js";
import {
  createOperatorBatchPresentation,
  type OperatorPresentationItem
} from "../interaction/operatorPresentation.js";
import type {
  SchedulerReconcileSelection,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";
import { mailboxHasWork, nextPendingBatch } from "../coordination/workMailbox.js";

type OperatorDeliveryOutcome = Readonly<{
  sourceKind: "input" | "event";
  sourceId: string;
  taskId: string;
  status: "sent" | "already-sent" | "skipped" | "failed";
  reason?: "operator-unavailable" | "operator-not-ready" | "delivery-unsupported";
  error?: string;
}>;

export type OperatorInputNotificationResult = OperatorDeliveryOutcome;

type PendingOperatorAttention =
  | Readonly<{ kind: "input"; request: InputRequest }>
  | Readonly<{ kind: "event"; event: TaskEvent }>;

export async function processOperatorInputNotifications(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  selection?: SchedulerReconcileSelection,
  now = new Date()
): Promise<OperatorInputNotificationResult[]> {
  if (selection !== undefined && !selection.full && !selection.operator) return [];
  const targetMailbox = { kind: "operator" } as const;
  const mailbox = store.getWorkMailbox(targetMailbox);
  if (mailbox === null || !mailboxHasWork(mailbox)) return [];
  const pending = nextPendingBatch(mailbox);
  const claim = store.claimWorkMailbox({
    target: targetMailbox,
    batchId: pending === null
      ? "operator-recovery"
      : `operator:${pending.fromSequence}-${pending.toSequence}`,
    owner: "controller",
    now
  });
  if (claim.status === "empty") return [];
  const processing = claim.processing;
  const attentions = deduplicateAttention(processing.batch.refs.flatMap(
    (ref): PendingOperatorAttention[] => {
      if (ref.type === "input") {
        const request = store.getInputRequest(ref.taskId, ref.id);
        return request !== null && request.status === "open"
          ? [{ kind: "input" as const, request }]
          : [];
      }
      if (ref.type !== "event" || store.listEvents === undefined) return [];
      const event = store.listEvents(ref.taskId).find(({ id }) => id === ref.id);
      return event === undefined ? [] : [{ kind: "event", event }];
    }
  ));
  if (attentions.length === 0) {
    store.completeWorkMailbox(targetMailbox, processing.batchId);
    return [];
  }
  const target = store.getOperatorDeliveryTarget();
  if (target === null || delivery.notifyOperatorInputOnce === undefined) {
    const reason = target === null ? "operator-unavailable" : "delivery-unsupported";
    store.releaseWorkMailbox(targetMailbox, processing.batchId);
    return attentions.map((attention) => skipped(attention, reason));
  }

  try {
    const presentation = createOperatorBatchPresentation(
      processing.batchId,
      attentions.map(toPresentationItem)
    );
    const outcome = await delivery.notifyOperatorInputOnce({
      ...target,
      receiptId: presentation.receiptId,
      text: presentation.text
    });
    if (outcome === "unavailable" || outcome === "not-ready") {
      store.releaseWorkMailbox(targetMailbox, processing.batchId);
      const reason = outcome === "unavailable" ? "operator-unavailable" : "operator-not-ready";
      return attentions.map((attention) => skipped(attention, reason));
    }
    if (outcome === "sent") store.markOperatorTurnStarted(now);
    store.completeWorkMailbox(targetMailbox, processing.batchId);
    return attentions.map((attention) => ({
      ...attentionIdentity(attention),
      status: outcome
    }));
  } catch (error) {
    store.releaseWorkMailbox(targetMailbox, processing.batchId);
    const detail = error instanceof Error ? error.message : String(error);
    return attentions.map((attention) => ({
      ...attentionIdentity(attention),
      status: "failed",
      error: detail
    }));
  }
}

function skipped(
  attention: PendingOperatorAttention,
  reason: NonNullable<OperatorInputNotificationResult["reason"]>
): OperatorInputNotificationResult {
  return {
    ...attentionIdentity(attention),
    status: "skipped",
    reason
  };
}

function attentionIdentity(attention: PendingOperatorAttention): Pick<
  OperatorInputNotificationResult,
  "sourceKind" | "sourceId" | "taskId"
> {
  return attention.kind === "input"
    ? {
        sourceKind: "input",
        sourceId: attention.request.id,
        taskId: attention.request.taskId
      }
    : {
        sourceKind: "event",
        sourceId: attention.event.id,
        taskId: attention.event.taskId
      };
}

function toPresentationItem(attention: PendingOperatorAttention): OperatorPresentationItem {
  return attention.kind === "input"
    ? { kind: "input-request", request: attention.request }
    : { kind: "task-event", event: attention.event };
}

function deduplicateAttention(
  attentions: readonly PendingOperatorAttention[]
): PendingOperatorAttention[] {
  const seen = new Set<string>();
  return attentions.filter((attention) => {
    const identity = attentionIdentity(attention);
    const key = `${identity.sourceKind}:${identity.taskId}:${identity.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
