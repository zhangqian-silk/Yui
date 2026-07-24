import type { InputRequest } from "../input/inputRequest.js";
import type { OperatorNotification } from "../scheduler/operatorNotification.js";
import { formatTimestamp } from "../output/timePresentation.js";

type OperatorPresentationBase = Readonly<{
  taskId: string;
  receiptId: string;
  text: string;
}>;

export type OperatorAttentionPresentation = OperatorPresentationBase & Readonly<{
  category: "attention";
  source: Readonly<
    | { kind: "input-request"; id: string }
    | { kind: "leader-recovery"; id: string }
  >;
}>;

export type OperatorPresentationContext = Readonly<{
  timeZone?: unknown;
}>;

export function createInputRequestOperatorPresentation(
  request: InputRequest,
  context: OperatorPresentationContext
): OperatorAttentionPresentation {
  const policy = request.policy;
  const recommendation = policy.kind === "recommended"
    ? request.choices.find(({ key }) => key === policy.recommendedChoiceKey)
    : undefined;
  if (policy.kind === "recommended" && recommendation === undefined) {
    throw new Error(
      `Input request ${request.id} recommendation ${policy.recommendedChoiceKey} is missing.`
    );
  }

  return {
    category: "attention",
    taskId: request.taskId,
    receiptId: `input-request:${request.id}`,
    source: { kind: "input-request", id: request.id },
    text: [
      "A Task Leader is waiting for user input. Present this question in the native Operator session.",
      "Do not answer it yourself; do not answer or choose on the user's behalf.",
      `Task: ${request.taskId}`,
      `Input: ${request.id}`,
      `Question: ${request.question}`,
      ...(request.choices.length === 0
        ? ["Answer type: free text"]
        : ["Choices:", ...request.choices.map(({ key, label }) => `  ${key}: ${label}`)]),
      ...(policy.kind === "required"
        ? ["Decision policy: this requires the user's response; there is no automatic fallback."]
        : [
            `Agent recommendation: ${recommendation!.key}: ${recommendation!.label}`,
            `Automatic fallback after: ${formatTimestamp(policy.timeoutAt, context.timeZone)}`
          ]),
      `Inspect: yui task input show ${request.id}`,
      request.choices.length === 0
        ? `After the user replies: yui task input answer ${request.id} --text "<answer>"`
        : `After the user chooses: yui task input answer ${request.id} --choice <key>`
    ].join("\n")
  };
}

export function createLeaderRecoveryOperatorPresentation(
  notification: OperatorNotification
): OperatorAttentionPresentation {
  return {
    category: "attention",
    taskId: notification.taskId,
    receiptId: `leader-recovery:${notification.taskId}:${notification.createdAt}`,
    source: { kind: "leader-recovery", id: notification.taskId },
    text: [
      "A Task cannot recover its Leader automatically and needs user attention.",
      `Task: ${notification.taskId}`,
      `Failure: ${notification.message}`,
      `Inspect: yui task show ${notification.taskId}`,
      "Recovery status: yui jobs list",
      `Retry after inspection: yui jobs retry leader-recovery:${notification.taskId}`
    ].join("\n")
  };
}
