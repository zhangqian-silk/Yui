import { requireText, requireTimestamp } from "./validation.js";
import {
  formatTurnReceiptId,
  formatInputRequestReceiptId,
  validateTaskRecordReference
} from "../task/taskRecordReference.js";

export type PromptSource = Readonly<{
  kind: "turn" | "turn-input" | "input-request";
  taskId: string;
  localId: string;
}>;

export type PromptEnvelope = Readonly<{
  id: string;
  source: PromptSource;
  text: string;
  createdAt: string;
}>;

export function createPromptEnvelope(input: Readonly<{
  id: string;
  source: PromptSource;
  text: string;
  createdAt: Date;
}>): PromptEnvelope {
  if (input.source.kind !== "turn"
    && input.source.kind !== "turn-input"
    && input.source.kind !== "input-request") {
    throw new Error("Prompt source kind is invalid.");
  }
  const source = validateTaskRecordReference({
    taskId: input.source.taskId,
    localId: input.source.localId
  }, input.source.kind === "input-request" ? "inputRequest" : "turn");
  const id = requireQualifiedReceiptId(
    input.id,
    input.source.kind,
    source.taskId,
    source.localId
  );
  return {
    id,
    source: {
      kind: input.source.kind,
      taskId: source.taskId,
      localId: source.localId
    },
    text: requireText(input.text, "Prompt text"),
    createdAt: requireTimestamp(input.createdAt, "Prompt createdAt")
  };
}

function requireQualifiedReceiptId(
  value: string,
  kind: PromptSource["kind"],
  taskId: string,
  localId: string
): string {
  const expected = kind === "turn"
    ? formatTurnReceiptId(taskId, localId)
    : kind === "input-request"
      ? formatInputRequestReceiptId(taskId, localId)
      : `turn-input:${taskId}/${localId}/`;
  if (kind === "turn-input") {
    if (!value.startsWith(expected)
      || !/^[1-9]\d*$/.test(value.slice(expected.length))) {
      throw new Error("Prompt envelope id does not match its source.");
    }
    return value;
  }
  if (value !== expected) throw new Error("Prompt envelope id does not match its source.");
  return expected;
}
