import type { InputRequest } from "../input/inputRequest.js";
import { createInputRequestOperatorPresentation } from "../interaction/operatorPresentation.js";
import type {
  SchedulerReconcileSelection,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "./ports.js";

export type OperatorInputNotificationResult = Readonly<{
  inputRequestId: string;
  taskId: string;
  status: "sent" | "already-sent" | "skipped" | "failed";
  reason?: "operator-unavailable" | "operator-not-ready" | "delivery-unsupported";
  error?: string;
}>;

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
  const requests = processing.batch.refs
    .filter((ref) => ref.type === "input")
    .map((ref) => store.getInputRequest(ref.id))
    .filter((request): request is InputRequest => request !== null && request.status === "open");
  if (requests.length === 0) {
    store.completeWorkMailbox(targetMailbox, processing.batchId);
    return [];
  }
  const target = store.getOperatorDeliveryTarget();
  if (target === null || delivery.notifyOperatorInputOnce === undefined) {
    const reason = target === null ? "operator-unavailable" : "delivery-unsupported";
    store.releaseWorkMailbox(targetMailbox, processing.batchId);
    return requests.map((request) => skipped(request, reason));
  }

  const results: OperatorInputNotificationResult[] = [];
  for (const [index, request] of requests.entries()) {
    try {
      const presentation = createInputRequestOperatorPresentation(request);
      const outcome = await delivery.notifyOperatorInputOnce({
        ...target,
        receiptId: presentation.receiptId,
        text: presentation.text
      });
      if (outcome === "unavailable") {
        store.releaseWorkMailbox(targetMailbox, processing.batchId);
        results.push(skipped(request, "operator-unavailable"));
        results.push(...requests.slice(index + 1).map((pending) => (
          skipped(pending, "operator-unavailable")
        )));
        break;
      } else if (outcome === "not-ready") {
        store.releaseWorkMailbox(targetMailbox, processing.batchId);
        results.push(skipped(request, "operator-not-ready"));
        results.push(...requests.slice(index + 1).map((pending) => (
          skipped(pending, "operator-not-ready")
        )));
        break;
      } else {
        results.push({
          inputRequestId: request.id,
          taskId: request.taskId,
          status: outcome
        });
        if (outcome === "sent") {
          if (index === requests.length - 1) {
            store.completeWorkMailbox(targetMailbox, processing.batchId);
          } else {
            store.releaseWorkMailbox(targetMailbox, processing.batchId);
          }
          results.push(...requests.slice(index + 1).map((pending) => (
            skipped(pending, "operator-not-ready")
          )));
          break;
        }
      }
    } catch (error) {
      store.releaseWorkMailbox(targetMailbox, processing.batchId);
      results.push({
        inputRequestId: request.id,
        taskId: request.taskId,
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
  request: InputRequest,
  reason: NonNullable<OperatorInputNotificationResult["reason"]>
): OperatorInputNotificationResult {
  return {
    inputRequestId: request.id,
    taskId: request.taskId,
    status: "skipped",
    reason
  };
}
