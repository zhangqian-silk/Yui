import type { InputRequest } from "../input/inputRequest.js";
import {
  taskMessageAuthorLabel,
  type TaskMessage
} from "../message/message.js";

export type OperatorPresentationCategory = "attention" | "terminal" | "progress";

type OperatorPresentationBase = Readonly<{
  taskId: string;
  receiptId: string;
  text: string;
}>;

export type OperatorAttentionPresentation = OperatorPresentationBase & Readonly<{
  category: "attention";
  source: Readonly<{ kind: "input-request"; id: string }>;
}>;

export type OperatorTerminalPresentation = OperatorPresentationBase & Readonly<{
  category: "terminal";
  source: Readonly<{ kind: "task-terminal"; id: string }>;
}>;

export type OperatorProgressPresentation = OperatorPresentationBase & Readonly<{
  category: "progress";
  source: Readonly<{ kind: "task-message"; id: string }>;
}>;

export type OperatorPresentation =
  | OperatorAttentionPresentation
  | OperatorTerminalPresentation
  | OperatorProgressPresentation;

export function createInputRequestOperatorPresentation(
  request: InputRequest
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
            `Automatic fallback after: ${policy.timeoutAt}`
          ]),
      `Inspect: yui task input show ${request.id}`,
      request.choices.length === 0
        ? `After the user replies: yui task input answer ${request.id} --text "<answer>"`
        : `After the user chooses: yui task input answer ${request.id} --choice <key>`
    ].join("\n")
  };
}

export function createTaskMessageOperatorPresentation(
  taskId: string,
  message: TaskMessage
): OperatorProgressPresentation {
  return {
    category: "progress",
    taskId,
    receiptId: `task-message:${taskId}:${message.id}`,
    source: { kind: "task-message", id: message.id },
    text: [
      "A Task has a progress update. Present it to the user when useful.",
      "Treat this as progress only; do not describe the Task as complete.",
      `Task: ${taskId}`,
      `Message: ${message.id}`,
      `From: ${taskMessageAuthorLabel(message.author)}`,
      `Update: ${message.body}`
    ].join("\n")
  };
}

export function createTaskTerminalOperatorPresentation(
  input: Readonly<{
    taskId: string;
    eventId: string;
    status: "completed" | "failed";
    summary?: string;
  }>
): OperatorTerminalPresentation {
  return {
    category: "terminal",
    taskId: input.taskId,
    receiptId: `task-terminal:${input.taskId}:${input.eventId}`,
    source: { kind: "task-terminal", id: input.eventId },
    text: [
      "A Task reached a terminal state. Present this outcome to the user.",
      `Task: ${input.taskId}`,
      `Task status: ${input.status}`,
      ...(input.summary === undefined ? [] : [`Summary: ${input.summary}`])
    ].join("\n")
  };
}
