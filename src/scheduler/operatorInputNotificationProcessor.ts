import type { InputRequest } from "../input/inputRequest.js";
import {
  createInputRequestOperatorPresentation,
  createLeaderRecoveryOperatorPresentation,
  createTaskTerminalOperatorPresentation,
  type OperatorPresentation
} from "../interaction/operatorPresentation.js";
import type { OperatorNotification } from "./operatorNotification.js";
import type {
  SchedulerReconcileSelection,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";

type OperatorNotificationOutcome = Readonly<{
  taskId: string;
  status: "sent" | "already-sent" | "skipped" | "failed";
  reason?: "operator-unavailable" | "operator-not-ready" | "delivery-unsupported";
  error?: string;
}>;

export type OperatorInputNotificationResult =
  | (OperatorNotificationOutcome & Readonly<{ inputRequestId: string }>)
  | (OperatorNotificationOutcome & Readonly<{ recoveryTaskId: string }>)
  | (OperatorNotificationOutcome & Readonly<{ terminalTaskId: string }>);

type PendingOperatorAttention =
  | Readonly<{ kind: "input"; request: InputRequest }>
  | Readonly<{ kind: "notification"; notification: OperatorNotification }>;

export async function processOperatorInputNotifications(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  selection?: SchedulerReconcileSelection,
  now = new Date()
): Promise<OperatorInputNotificationResult[]> {
  if (selection !== undefined && !selection.full && !selection.operator) return [];
  const targetMailbox = { kind: "operator" } as const;
  const mailbox = store.getWorkMailbox(targetMailbox);
  if (mailbox === null || (mailbox.pending === null && mailbox.processing === null)) return [];
  const pending = mailbox.pending;
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
  const requests: PendingOperatorAttention[] = processing.batch.refs
    .flatMap((ref) => ref.type === "input"
      ? [store.getInputRequest(ref.taskId, ref.id)]
      : [])
    .filter((request): request is InputRequest => request !== null && request.status === "open")
    .map((request) => ({ kind: "input", request }));
  const notifications: PendingOperatorAttention[] = processing.batch.refs
    .filter((ref) => ref.type === "task")
    .map((ref) => store.getOperatorNotification(ref.id))
    .filter((notification): notification is OperatorNotification => notification !== null)
    .map((notification) => ({ kind: "notification", notification }));
  const attentions = deduplicateAttention([...requests, ...notifications]);
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

  const results: OperatorInputNotificationResult[] = [];
  for (const [index, attention] of attentions.entries()) {
    try {
      const presentation = createAttentionPresentation(attention, store);
      const outcome = await delivery.notifyOperatorInputOnce({
        ...target,
        receiptId: presentation.receiptId,
        text: presentation.text
      });
      if (outcome === "unavailable") {
        store.releaseWorkMailbox(targetMailbox, processing.batchId);
        results.push(skipped(attention, "operator-unavailable"));
        results.push(...attentions.slice(index + 1).map((pending) => (
          skipped(pending, "operator-unavailable")
        )));
        break;
      } else if (outcome === "not-ready") {
        store.releaseWorkMailbox(targetMailbox, processing.batchId);
        results.push(skipped(attention, "operator-not-ready"));
        results.push(...attentions.slice(index + 1).map((pending) => (
          skipped(pending, "operator-not-ready")
        )));
        break;
      } else {
        results.push({
          ...attentionIdentity(attention),
          status: outcome
        });
        if (outcome === "sent") {
          if (index === attentions.length - 1) {
            store.completeWorkMailbox(targetMailbox, processing.batchId);
          } else {
            store.releaseWorkMailbox(targetMailbox, processing.batchId);
          }
          results.push(...attentions.slice(index + 1).map((pending) => (
            skipped(pending, "operator-not-ready")
          )));
          break;
        }
      }
    } catch (error) {
      store.releaseWorkMailbox(targetMailbox, processing.batchId);
      results.push({
        ...attentionIdentity(attention),
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      break;
    }
  }
  if (results.length > 0 && results.every((result) => result.status === "already-sent")) {
    store.completeWorkMailbox(targetMailbox, processing.batchId);
  }
  return results;
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

function attentionIdentity(attention: PendingOperatorAttention):
  | Readonly<{ inputRequestId: string; taskId: string }>
  | Readonly<{ recoveryTaskId: string; taskId: string }>
  | Readonly<{ terminalTaskId: string; taskId: string }> {
  if (attention.kind === "input") {
    return { inputRequestId: attention.request.id, taskId: attention.request.taskId };
  }
  return attention.notification.type === "leader-recovery-failed"
    ? {
        recoveryTaskId: attention.notification.taskId,
        taskId: attention.notification.taskId
      }
    : {
        terminalTaskId: attention.notification.taskId,
        taskId: attention.notification.taskId
      };
}

function createAttentionPresentation(
  attention: PendingOperatorAttention,
  store: SchedulerStorePort
): OperatorPresentation {
  if (attention.kind === "input") {
    return createInputRequestOperatorPresentation(attention.request, store.getPresentationContext());
  }
  return attention.notification.type === "leader-recovery-failed"
    ? createLeaderRecoveryOperatorPresentation(attention.notification)
    : createTaskTerminalOperatorPresentation(attention.notification);
}

function deduplicateAttention(
  attentions: readonly PendingOperatorAttention[]
): PendingOperatorAttention[] {
  const seen = new Set<string>();
  return attentions.filter((attention) => {
    const key = attention.kind === "input"
      ? `input:${attention.request.taskId}/${attention.request.id}`
      : `${attention.notification.type}:${attention.notification.taskId}:${attention.notification.createdAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
