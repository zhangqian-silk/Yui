import { createHash } from "node:crypto";
import { requireIdentity, requireTimestamp } from "../domain/validation.js";

export const WORKFLOW_OUTCOME_REQUEST_TIMEOUT_MS = 30_000;

export type AgentRunControlRequest = Readonly<{
  schemaVersion: 1;
  kind: "workflow-outcome";
  requestId: string;
  state: "dispatching" | "awaiting-outcome";
  nativeTurnId: string;
  receiptId: string;
  requestedAt: string;
  deadlineAt: string;
}>;

export function createWorkflowOutcomeRequest(input: Readonly<{
  runId: string;
  nativeTurnId: string;
  now: Date;
}>): AgentRunControlRequest {
  const requestedAt = input.now.toISOString();
  return validateAgentRunControlRequest({
    schemaVersion: 1,
    kind: "workflow-outcome",
    requestId: createHash("sha256")
      .update(`${input.runId}\0${input.nativeTurnId}\0${requestedAt}`)
      .digest("hex"),
    state: "dispatching",
    nativeTurnId: input.nativeTurnId,
    receiptId: `workflow-outcome-${input.runId}-${input.nativeTurnId}`,
    requestedAt,
    deadlineAt: new Date(input.now.getTime() + WORKFLOW_OUTCOME_REQUEST_TIMEOUT_MS).toISOString()
  });
}

export function validateAgentRunControlRequest(
  value: AgentRunControlRequest
): AgentRunControlRequest {
  if (value.schemaVersion !== 1 || value.kind !== "workflow-outcome") {
    throw new Error("Agent Run control request is unsupported.");
  }
  if (value.state !== "dispatching" && value.state !== "awaiting-outcome") {
    throw new Error("Agent Run control request state is invalid.");
  }
  requireIdentity(value.requestId, "Agent Run control request id");
  requireIdentity(value.nativeTurnId, "Agent Run control native Turn id");
  requireIdentity(value.receiptId, "Agent Run control receipt id");
  requireTimestamp(value.requestedAt, "Agent Run control requestedAt");
  requireTimestamp(value.deadlineAt, "Agent Run control deadlineAt");
  if (Date.parse(value.deadlineAt) <= Date.parse(value.requestedAt)) {
    throw new Error("Agent Run control deadline must follow requestedAt.");
  }
  return value;
}

export function markWorkflowOutcomeRequestDispatched(
  value: AgentRunControlRequest
): AgentRunControlRequest {
  validateAgentRunControlRequest(value);
  return value.state === "dispatching"
    ? validateAgentRunControlRequest({ ...value, state: "awaiting-outcome" })
    : value;
}

export function serializeWorkflowOutcomeRequestEnvelope(input: Readonly<{
  taskId: string;
  runId: string;
  roleName: string;
  request: AgentRunControlRequest;
}>): string {
  validateAgentRunControlRequest(input.request);
  return [
    "Yui managed workflow-outcome request for the existing Run.",
    `task=${requireIdentity(input.taskId, "Task id")} run=${requireIdentity(input.runId, "Run id")} role=${requireIdentity(input.roleName, "Role name")}`,
    `request=${input.request.requestId} completedTurn=${input.request.nativeTurnId}`,
    "Record the required Yui workflow outcome now. Do not replay the Assignment or repeat completed work."
  ].join("\n");
}
