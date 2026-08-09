import { callController } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import { runtimeLifecycleSignalKey } from "../runtime/lifecycleReservation.js";
import {
  FileRuntimeEventInbox,
  MAX_RUNTIME_EVENT_FILE_BYTES
} from "./runtimeEventInbox.js";
import { resolveProviderHookRunFence } from "./providerHookRunFence.js";

type ControllerCall = (
  home: string,
  method: string,
  params: JsonValue,
  options?: Readonly<{ timeoutMs?: number }>
) => Promise<JsonValue>;

type ClaudeHookEnvelope = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "claude";
  launchId: string;
  runId: string;
  nativeSessionId: string;
  receiptId: string;
}>;

export type ClaudeStopFailureHookNotification = Omit<ClaudeHookEnvelope, "receiptId"> & Readonly<{
  type: "StopFailure";
  error: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
}>;

/**
 * Hidden CLI entrypoint used by the managed Claude lifecycle plugin. It parses
 * by hook_event_name and writes one immutable runtime-inbox event per fact:
 * SessionStart → native-session-lifecycle (carrying the source variant),
 * UserPromptSubmit → native-prompt-accepted (the exact provider-accepted fence),
 * StopFailure → claude-stop-failure. The durable write is authoritative; the
 * socket call is only a wake-up hint.
 */
export async function runClaudeLifecycleHookCommand(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  call: ControllerCall = callController
): Promise<void> {
  const home = requireIdentity(environment.YUI_HOME, "YUI_HOME");
  const inbox = new FileRuntimeEventInbox(home);
  const envelope = parseClaudeHookEnvelope(stdinJson, environment);
  if (envelope.kind === "session-start") {
    inbox.enqueueSessionLifecycle({
      scope: "task",
      taskId: envelope.taskId,
      roleName: envelope.roleName,
      agentId: envelope.agentId,
      adapterId: "claude",
      launchId: envelope.launchId,
      nativeSessionId: envelope.nativeSessionId,
      runId: envelope.runId,
      sessionSource: envelope.sessionSource
    });
  } else if (envelope.kind === "prompt-submit") {
    inbox.enqueuePromptAccepted({
      scope: "task",
      taskId: envelope.taskId,
      roleName: envelope.roleName,
      agentId: envelope.agentId,
      adapterId: "claude",
      launchId: envelope.launchId,
      nativeSessionId: envelope.nativeSessionId,
      runId: envelope.runId,
      receiptId: envelope.receiptId
    });
  } else {
    inbox.enqueueClaudeStopFailure({
      scope: "task",
      taskId: envelope.taskId,
      roleName: envelope.roleName,
      agentId: envelope.agentId,
      adapterId: "claude",
      launchId: envelope.launchId,
      nativeSessionId: envelope.nativeSessionId,
      runId: envelope.runId,
      error: envelope.error,
      ...(envelope.errorDetails === undefined
        ? {}
        : { errorDetails: envelope.errorDetails }),
      ...(envelope.lastAssistantMessage === undefined
        ? {}
        : { lastAssistantMessage: envelope.lastAssistantMessage })
    });
  }
  // The immutable event is authoritative; the socket call is only a hint.
  await call(
    home,
    "scheduler.signal",
    {
      key: runtimeLifecycleSignalKey({
        scope: "task",
        taskId: envelope.taskId,
        roleName: envelope.roleName
      })
    },
    { timeoutMs: 100 }
  ).catch(() => {});
}

type ClaudeSessionStartHookNotification = ClaudeHookEnvelope & Readonly<{
  kind: "session-start";
  sessionSource: string;
}>;
type ClaudePromptSubmitHookNotification = ClaudeHookEnvelope & Readonly<{
  kind: "prompt-submit";
  receiptId: string;
}>;
type ClaudeStopFailureEnvelope = ClaudeHookEnvelope & Readonly<{
  kind: "stop-failure";
  error: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
}>;
type ClaudeHookNotificationEnvelope =
  | ClaudeSessionStartHookNotification
  | ClaudePromptSubmitHookNotification
  | ClaudeStopFailureEnvelope;

/**
 * Parses a Claude hook payload by hook_event_name into the exact fenced
 * envelope. Every event requires the managed launch envelope (task/role/agent/
 * launch/run) and the payload session id must match YUI_NATIVE_SESSION_ID, so a
 * mismatched generation fails closed before any inbox write.
 */
export function parseClaudeHookEnvelope(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv
): ClaudeHookNotificationEnvelope {
  const payload = parseObject(stdinJson);
  if (payload.hook_event_name !== "SessionStart"
    && payload.hook_event_name !== "UserPromptSubmit"
    && payload.hook_event_name !== "StopFailure") {
    throw new Error("Managed Claude lifecycle ingestion received an unsupported hook event.");
  }
  const sessionSource = payload.hook_event_name === "SessionStart"
    ? requireIdentity(payload.source, "Claude SessionStart source")
    : undefined;
  const base = parseClaudeEnvelope(payload, environment, {
    allowPreallocatedClaudeStartup: sessionSource === "startup"
  });
  switch (payload.hook_event_name) {
    case "SessionStart":
      return {
        ...base,
        kind: "session-start",
        sessionSource: sessionSource!
      };
    case "UserPromptSubmit":
      return {
        ...base,
        kind: "prompt-submit",
        receiptId: base.receiptId
      };
    case "StopFailure":
      return {
        ...base,
        kind: "stop-failure",
        error: requireResult(payload.error, "Claude StopFailure error"),
        ...(payload.error_details === undefined
          ? {}
          : { errorDetails: requireResult(payload.error_details, "Claude StopFailure error_details") }),
        ...(payload.last_assistant_message === undefined
          ? {}
          : {
              lastAssistantMessage: requireResult(
                payload.last_assistant_message,
                "Claude StopFailure last_assistant_message"
              )
            })
      };
    default:
      throw new Error("Managed Claude lifecycle ingestion received an unsupported hook event.");
  }
}

function parseClaudeEnvelope(
  payload: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  options: Readonly<{ allowPreallocatedClaudeStartup?: boolean }>
): ClaudeHookEnvelope {
  const nativeSessionId = requireIdentity(payload.session_id, "Claude session id");
  return {
    ...resolveProviderHookRunFence(environment, "claude", nativeSessionId, options),
    adapterId: "claude"
  };
}

export function parseClaudeStopFailureHookNotification(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv
): ClaudeStopFailureHookNotification {
  const envelope = parseClaudeHookEnvelope(stdinJson, environment);
  if (envelope.kind !== "stop-failure") {
    throw new Error("Managed Claude lifecycle ingestion accepts only StopFailure.");
  }
  return {
    taskId: envelope.taskId,
    roleName: envelope.roleName,
    agentId: envelope.agentId,
    adapterId: "claude",
    launchId: envelope.launchId,
    runId: envelope.runId,
    nativeSessionId: envelope.nativeSessionId,
    type: "StopFailure",
    error: envelope.error,
    ...(envelope.errorDetails === undefined ? {} : { errorDetails: envelope.errorDetails }),
    ...(envelope.lastAssistantMessage === undefined
      ? {}
      : { lastAssistantMessage: envelope.lastAssistantMessage })
  };
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (value === undefined
    || Buffer.byteLength(value, "utf8") > MAX_RUNTIME_EVENT_FILE_BYTES) {
    throw new Error("Claude lifecycle hook stdin JSON is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isObject(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new Error("Claude lifecycle hook stdin JSON is invalid.");
  }
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireResult(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
