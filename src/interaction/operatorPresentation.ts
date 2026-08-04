import type { InputRequest } from "../input/inputRequest.js";
import type {
  LeaderRecoveryOperatorNotification,
  TaskTerminalOperatorNotification
} from "../scheduler/operatorNotification.js";
import { formatTimestamp } from "../output/timePresentation.js";
import {
  formatInputRequestReceiptId,
  formatTaskRecordReference
} from "../task/taskRecordReference.js";

type OperatorPresentationBase = Readonly<{
  taskId: string;
  receiptId: string;
  text: string;
}>;

export type OperatorPresentation = OperatorPresentationBase & Readonly<{
  category: "attention" | "information";
  source: Readonly<
    | { kind: "input-request"; taskId: string; localId: string }
    | { kind: "leader-recovery"; id: string }
    | { kind: "task-terminal"; id: string }
  >;
}>;

export type OperatorAttentionPresentation = OperatorPresentation & Readonly<{
  category: "attention";
}>;

export type OperatorInformationPresentation = OperatorPresentation & Readonly<{
  category: "information";
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
    receiptId: formatInputRequestReceiptId(request.taskId, request.id),
    source: { kind: "input-request", taskId: request.taskId, localId: request.id },
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
      `Inspect: yui task input show ${formatTaskRecordReference(
        request.taskId, request.id, "inputRequest"
      )}`,
      request.choices.length === 0
        ? `After the user replies: yui task input answer ${formatTaskRecordReference(
            request.taskId, request.id, "inputRequest"
          )} --text "<answer>"`
        : `After the user chooses: yui task input answer ${formatTaskRecordReference(
            request.taskId, request.id, "inputRequest"
          )} --choice <key>`
    ].join("\n")
  };
}

export function createLeaderRecoveryOperatorPresentation(
  notification: LeaderRecoveryOperatorNotification
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

export function createTaskTerminalOperatorPresentation(
  notification: TaskTerminalOperatorNotification
): OperatorInformationPresentation {
  const action = notification.status === "completed" ? "completed" : "retired";
  const actor = notification.by === "leader"
    ? "its Leader"
    : notification.by === "operator"
      ? "the Operator"
      : "the user";
  return {
    category: "information",
    taskId: notification.taskId,
    receiptId: `task-terminal:${notification.taskId}:${notification.status}:${notification.createdAt}`,
    source: { kind: "task-terminal", id: notification.taskId },
    text: [
      `Task ${notification.taskId} was ${action} by ${actor}.`,
      `Summary: ${notification.summary}`,
      `Inspect: yui task show ${notification.taskId}`
    ].join("\n")
  };
}
