import { requireSafeIdentity, requireText, requireTimestamp } from "./validation.js";

export type PromptSource = Readonly<{
  kind: "agent-run" | "input-request";
  id: string;
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
  if (input.source.kind !== "agent-run" && input.source.kind !== "input-request") {
    throw new Error("Prompt source kind is invalid.");
  }
  return {
    id: requireSafeIdentity(input.id, "Prompt envelope id"),
    source: {
      kind: input.source.kind,
      id: requireSafeIdentity(input.source.id, "Prompt source id")
    },
    text: requireText(input.text, "Prompt text"),
    createdAt: requireTimestamp(input.createdAt, "Prompt createdAt")
  };
}
