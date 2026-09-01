export const RUNTIME_PROCESS_EXIT_SCHEMA_VERSION = 1 as const;

export type RuntimeProcessExitObservation = Readonly<{
  schemaVersion: typeof RUNTIME_PROCESS_EXIT_SCHEMA_VERSION;
  observationId: string;
  hostSequence: number;
  hostInstanceId: string;
  providerProcessInstanceId?: string;
  taskId?: string;
  roleName: string;
  turnId?: string;
  launchId: string;
  nativeSessionId?: string;
  processKind: "agent-host" | "provider-child";
  exitCode?: number;
  signal?: string;
  observedAt: string;
  stopReceiptId?: string;
  lastProviderEventId?: string;
  diagnosticTailRef?: string;
}>;

export function validateRuntimeProcessExitObservation(
  observation: RuntimeProcessExitObservation
): RuntimeProcessExitObservation {
  if (observation.schemaVersion !== RUNTIME_PROCESS_EXIT_SCHEMA_VERSION) {
    throw new Error("Runtime process-exit observation version is invalid.");
  }
  identity(observation.observationId, "observationId");
  identity(observation.hostInstanceId, "hostInstanceId");
  optionalIdentity(observation.providerProcessInstanceId, "providerProcessInstanceId");
  optionalIdentity(observation.taskId, "taskId");
  identity(observation.roleName, "roleName");
  optionalIdentity(observation.turnId, "turnId");
  identity(observation.launchId, "launchId");
  optionalIdentity(observation.nativeSessionId, "nativeSessionId");
  if (observation.processKind !== "agent-host" && observation.processKind !== "provider-child") {
    throw new Error("Runtime process kind is invalid.");
  }
  if (!Number.isSafeInteger(observation.hostSequence) || observation.hostSequence < 1) {
    throw new Error("Runtime host sequence is invalid.");
  }
  if (observation.exitCode !== undefined
    && (!Number.isSafeInteger(observation.exitCode) || observation.exitCode < 0)) {
    throw new Error("Runtime process exit code is invalid.");
  }
  optionalIdentity(observation.signal, "signal");
  if (!Number.isFinite(Date.parse(observation.observedAt))) {
    throw new Error("Runtime process observedAt is invalid.");
  }
  optionalIdentity(observation.stopReceiptId, "stopReceiptId");
  optionalIdentity(observation.lastProviderEventId, "lastProviderEventId");
  optionalIdentity(observation.diagnosticTailRef, "diagnosticTailRef");
  return Object.freeze({ ...observation });
}

export function classifyRuntimeProcessExit(
  observation: RuntimeProcessExitObservation,
  input: Readonly<{
    childLifecycle?: "persistent" | "per-turn";
    turnTerminalObserved?: boolean;
    turnFailureObserved?: boolean;
  }>
): "expected-per-turn-exit" | "provider-turn-failed" | "yui-requested-stop" | "host-abnormal" | "unknown" {
  validateRuntimeProcessExitObservation(observation);
  if (observation.stopReceiptId !== undefined) return "yui-requested-stop";
  if (observation.processKind === "provider-child" && input.turnFailureObserved === true) {
    return "provider-turn-failed";
  }
  if (observation.processKind === "provider-child"
    && input.childLifecycle === "per-turn"
    && observation.exitCode === 0
    && input.turnTerminalObserved === true) {
    return "expected-per-turn-exit";
  }
  if ((observation.exitCode !== undefined && observation.exitCode !== 0)
    || observation.signal !== undefined) {
    return "host-abnormal";
  }
  return "unknown";
}

function identity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Runtime process ${label} is invalid.`);
  }
}

function optionalIdentity(value: string | undefined, label: string): void {
  if (value !== undefined) identity(value, label);
}
