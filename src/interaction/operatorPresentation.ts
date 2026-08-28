import type { TaskEvent } from "../event/taskEvent.js";
import type { InputRequest } from "../input/inputRequest.js";

export type OperatorPresentationItem =
  | Readonly<{ kind: "input-request"; request: InputRequest }>
  | Readonly<{ kind: "task-event"; event: TaskEvent }>;

export type OperatorPresentation = Readonly<{
  receiptId: string;
  text: string;
}>;

/**
 * One mailbox batch becomes one short synthetic user message. The durable
 * records remain the context authority; this wake text carries only stable
 * identities and exact CLI reads, never copied Task or Provider narrative.
 */
export function createOperatorBatchPresentation(
  batchId: string,
  items: readonly OperatorPresentationItem[]
): OperatorPresentation {
  if (items.length === 0) throw new Error("Operator presentation requires at least one item.");
  return {
    receiptId: `operator-batch:${batchId}`,
    text: [
      "[Yui updates]",
      "Yui recorded the following durable updates. Inspect the referenced records and present only information that changes the user's understanding, authorization, or next action.",
      ...items.flatMap(renderItem)
    ].join("\n")
  };
}

function renderItem(item: OperatorPresentationItem): string[] {
  if (item.kind === "input-request") {
    const { request } = item;
    return [
      `- User input requested: ${request.taskId}/${request.id}`,
      `  Inspect: yui task input show ${request.taskId}/${request.id}`
    ];
  }
  const { event } = item;
  return [
    `- ${eventLabel(event)}: ${event.taskId}/${event.id}`,
    `  Inspect: yui task event show ${event.taskId} ${event.id}`
  ];
}

function eventLabel(event: TaskEvent): string {
  switch (event.type) {
    case "task.completed": return "Task completed";
    case "task.retired": return "Task retired";
    case "leader.attention-required": return "Task Leader needs attention";
    case "run.stalled": return "Task Leader stalled";
    default: return `Task event ${event.type}`;
  }
}
