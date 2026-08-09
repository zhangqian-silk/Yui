import { createHash } from "node:crypto";

import { normalizeRuntimeOwner, type RuntimeOwner } from "./runtimeOwner.js";
import { requireSafeIdentity, requireText } from "./validation.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";

export type ExactInitialPromptReceipt = Readonly<{
  receiptId: string;
  transportReceiptId: string;
  runId: string;
  launchId: string;
  workspace: string;
  nativeSessionId?: string;
}>;

export type RuntimeBinding = Readonly<{
  id: string;
  launchId: string;
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  /** Opaque reference interpreted only by the configured session host. */
  hostRef: string;
  /** True only when this lifecycle request created the external Role host. */
  hostCreated?: boolean;
  /** Exact Task Run whose first prompt was submitted by process launch. */
  initialPromptRunId?: string;
  /** Explicit transport acknowledgement for a launch-carried Task prompt. */
  initialPromptReceipt?: ExactInitialPromptReceipt;
  nativeSessionId?: string;
}>;

export function createRuntimeBinding(input: RuntimeBinding): RuntimeBinding {
  return {
    id: requireSafeIdentity(input.id, "Runtime binding id"),
    launchId: requireSafeIdentity(input.launchId, "Launch id"),
    owner: normalizeRuntimeOwner(input.owner),
    agentId: requireSafeIdentity(input.agentId, "Agent id"),
    adapterId: requireSafeIdentity(input.adapterId, "Agent adapter id"),
    hostRef: requireText(input.hostRef, "Session host reference"),
    ...(input.hostCreated === undefined
      ? {}
      : { hostCreated: requireBoolean(input.hostCreated, "Runtime host-created flag") }),
    ...(input.initialPromptRunId === undefined
      ? {}
      : { initialPromptRunId: requireSafeIdentity(input.initialPromptRunId, "Initial prompt Run id") }),
    ...(input.initialPromptReceipt === undefined
      ? {}
      : {
          initialPromptReceipt: validateExactInitialPromptReceipt(
            input.initialPromptReceipt,
            input
          )
        }),
    ...(input.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireText(input.nativeSessionId, "Native session id") })
  };
}

export function createExactInitialPromptReceipt(input: Readonly<{
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  runId: string;
  launchId: string;
  workspace: string;
  nativeSessionId?: string;
}>): ExactInitialPromptReceipt {
  const owner = normalizeRuntimeOwner(input.owner);
  if (owner.scope !== "task") {
    throw new TypeError("An initial prompt receipt requires a Task runtime owner.");
  }
  const agentId = requireSafeIdentity(input.agentId, "Agent id");
  const adapterId = requireSafeIdentity(input.adapterId, "Agent adapter id");
  const runId = requireSafeIdentity(input.runId, "Run id");
  const launchId = requireSafeIdentity(input.launchId, "Launch id");
  const workspace = requireText(input.workspace, "Session workspace");
  const nativeSessionId = input.nativeSessionId === undefined
    ? undefined
    : requireText(input.nativeSessionId, "Native session id");
  const digest = createHash("sha256").update(JSON.stringify([
    owner.taskId,
    owner.roleName,
    agentId,
    adapterId,
    runId,
    launchId,
    workspace,
    nativeSessionId ?? null
  ])).digest("hex");
  return {
    receiptId: formatAgentRunReceiptId(owner.taskId, runId),
    transportReceiptId: `initial-prompt:${digest}`,
    runId,
    launchId,
    workspace,
    ...(nativeSessionId === undefined ? {} : { nativeSessionId })
  };
}

function validateExactInitialPromptReceipt(
  receipt: ExactInitialPromptReceipt,
  binding: Pick<RuntimeBinding, "owner" | "agentId" | "adapterId" | "launchId" | "nativeSessionId">
): ExactInitialPromptReceipt {
  const expected = createExactInitialPromptReceipt({
    owner: binding.owner,
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    runId: requireSafeIdentity(receipt.runId, "Initial prompt receipt Run id"),
    launchId: binding.launchId,
    workspace: requireText(receipt.workspace, "Initial prompt receipt workspace"),
    ...(binding.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: binding.nativeSessionId })
  });
  if (
    receipt.receiptId !== expected.receiptId
    || receipt.transportReceiptId !== expected.transportReceiptId
    || receipt.launchId !== expected.launchId
    || receipt.nativeSessionId !== expected.nativeSessionId
  ) {
    throw new TypeError("Initial prompt transport receipt does not match its runtime binding.");
  }
  return expected;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}
