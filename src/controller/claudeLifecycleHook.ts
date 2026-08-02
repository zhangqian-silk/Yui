import { callController } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import { runtimeLifecycleSignalKey } from "../runtime/lifecycleReservation.js";
import {
  FileRuntimeEventInbox,
  MAX_RUNTIME_EVENT_FILE_BYTES
} from "./runtimeEventInbox.js";

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
}>;

export type ClaudeLifecycleHookNotification =
  | (ClaudeHookEnvelope & Readonly<{
      type: "Stop";
      result: string;
    }>)
  | (ClaudeHookEnvelope & Readonly<{
      type: "StopFailure";
      error: string;
      errorDetails?: string;
      lastAssistantMessage?: string;
    }>);

/** Hidden CLI entrypoint used by managed Claude Stop lifecycle hooks. */
export async function runClaudeLifecycleHookCommand(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  call: ControllerCall = callController
): Promise<void> {
  const notification = parseClaudeLifecycleHookNotification(stdinJson, environment);
  const home = requireIdentity(environment.YUI_HOME, "YUI_HOME");
  const inbox = new FileRuntimeEventInbox(home);
  const common = {
    scope: "task" as const,
    taskId: notification.taskId,
    roleName: notification.roleName,
    agentId: notification.agentId,
    adapterId: notification.adapterId,
    launchId: notification.launchId,
    nativeSessionId: notification.nativeSessionId,
    runId: notification.runId
  };
  if (notification.type === "Stop") {
    inbox.enqueueClaudeStop({ ...common, result: notification.result });
  } else {
    inbox.enqueueClaudeStopFailure({
      ...common,
      error: notification.error,
      ...(notification.errorDetails === undefined
        ? {}
        : { errorDetails: notification.errorDetails }),
      ...(notification.lastAssistantMessage === undefined
        ? {}
        : { lastAssistantMessage: notification.lastAssistantMessage })
    });
  }
  // The immutable event is authoritative; the socket call is only a hint.
  await call(
    home,
    "scheduler.signal",
    {
      key: runtimeLifecycleSignalKey({
        scope: "task",
        taskId: notification.taskId,
        roleName: notification.roleName
      })
    },
    { timeoutMs: 100 }
  ).catch(() => {});
}

export function parseClaudeLifecycleHookNotification(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv
): ClaudeLifecycleHookNotification {
  const payload = parseObject(stdinJson);
  const type = payload.hook_event_name;
  if (type !== "Stop" && type !== "StopFailure") {
    throw new Error("Claude lifecycle hook event is invalid.");
  }
  assertHookKeys(payload, type);
  if (environment.YUI_SESSION_SCOPE !== "task") {
    throw new Error("Claude lifecycle hook requires a Task session scope.");
  }
  if (environment.YUI_ADAPTER_ID !== "claude") {
    throw new Error("Claude lifecycle hook requires the Claude adapter.");
  }
  const nativeSessionId = requireIdentity(payload.session_id, "Claude session id");
  const expectedNativeSessionId = requireIdentity(
    environment.YUI_NATIVE_SESSION_ID,
    "YUI native session id"
  );
  if (nativeSessionId !== expectedNativeSessionId) {
    throw new Error("Claude lifecycle hook native session does not match its launch envelope.");
  }
  const common: ClaudeHookEnvelope = {
    taskId: requireIdentity(environment.YUI_TASK_ID, "Task id"),
    roleName: requireIdentity(environment.YUI_ROLE, "Role name"),
    agentId: requireIdentity(environment.YUI_AGENT_ID, "Agent id"),
    adapterId: "claude",
    launchId: requireIdentity(environment.YUI_LAUNCH_ID, "Launch id"),
    runId: requireIdentity(environment.YUI_RUN_ID, "Run id"),
    nativeSessionId
  };
  if (type === "Stop") {
    return {
      ...common,
      type,
      result: requireResult(payload.last_assistant_message, "Claude last_assistant_message")
    };
  }
  return {
    ...common,
    type,
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

function assertHookKeys(
  payload: Record<string, unknown>,
  type: "Stop" | "StopFailure"
): void {
  const common = new Set([
    "hook_event_name",
    "session_id",
    "transcript_path",
    "cwd",
    "permission_mode"
  ]);
  const allowed = type === "Stop"
    ? new Set([...common, "stop_hook_active", "last_assistant_message"])
    : new Set([...common, "error", "error_details", "last_assistant_message"]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new Error(`Claude lifecycle hook stdin JSON has unexpected field: ${unexpected}.`);
  }
  for (const required of type === "Stop"
    ? ["hook_event_name", "session_id", "last_assistant_message"]
    : ["hook_event_name", "session_id", "error"]) {
    if (!Object.hasOwn(payload, required)) {
      throw new Error(`Claude lifecycle hook stdin JSON is missing ${required}.`);
    }
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
