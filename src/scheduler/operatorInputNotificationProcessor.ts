import type { InputRequest } from "../input/inputRequest.js";
import type { SchedulerStorePort, TmuxDeliveryPort } from "./ports.js";

export type OperatorInputNotificationResult = Readonly<{
  inputRequestId: string;
  taskId: string;
  status: "sent" | "already-sent" | "skipped" | "failed";
  reason?: "operator-unavailable" | "operator-not-ready" | "delivery-unsupported";
  error?: string;
}>;

export async function processOperatorInputNotifications(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort
): Promise<OperatorInputNotificationResult[]> {
  const requests = store.listOpenInputRequests();
  if (requests.length === 0) return [];
  const target = store.getOperatorDeliveryTarget();
  if (target === null || delivery.notifyOperatorInputOnce === undefined) {
    const reason = target === null ? "operator-unavailable" : "delivery-unsupported";
    return requests.map((request) => skipped(request, reason));
  }

  const results: OperatorInputNotificationResult[] = [];
  for (const [index, request] of requests.entries()) {
    try {
      const outcome = await delivery.notifyOperatorInputOnce({
        ...target,
        receiptId: `input-request:${request.id}`,
        text: renderOperatorInputNotification(request)
      });
      if (outcome === "unavailable") {
        results.push(skipped(request, "operator-unavailable"));
        results.push(...requests.slice(index + 1).map((pending) => (
          skipped(pending, "operator-unavailable")
        )));
        break;
      } else if (outcome === "not-ready") {
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
          results.push(...requests.slice(index + 1).map((pending) => (
            skipped(pending, "operator-not-ready")
          )));
          break;
        }
      }
    } catch (error) {
      results.push({
        inputRequestId: request.id,
        taskId: request.taskId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

function renderOperatorInputNotification(request: InputRequest): string {
  const recommendedChoiceKey = request.policy.kind === "recommended"
    ? request.policy.recommendedChoiceKey
    : undefined;
  const recommendedChoice = recommendedChoiceKey === undefined
    ? undefined
    : request.choices.find((choice) => choice.key === recommendedChoiceKey);
  return [
    "A Task Leader is waiting for user input. Present this question to the user; do not answer it yourself.",
    `Task: ${request.taskId}`,
    `Input: ${request.id}`,
    `Question: ${request.question}`,
    ...(request.choices.length === 0
      ? ["Answer type: free text"]
      : ["Choices:", ...request.choices.map((choice) => `  ${choice.key}: ${choice.label}`)]),
    ...(request.policy.kind === "required"
      ? ["Decision policy: user response required; there is no automatic fallback."]
      : [
          `Agent recommendation: ${recommendedChoice!.key}: ${recommendedChoice!.label}`,
          `Automatic fallback after: ${request.policy.timeoutAt}`
        ]),
    `Inspect: yui task input show ${request.id}`,
    request.choices.length === 0
      ? `After the user replies: yui task input answer ${request.id} --text "<answer>"`
      : `After the user chooses: yui task input answer ${request.id} --choice <key>`
  ].join("\n");
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
