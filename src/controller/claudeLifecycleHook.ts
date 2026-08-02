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

export type ClaudeStopFailureHookNotification = ClaudeHookEnvelope & Readonly<{
  type: "StopFailure";
  error: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
}>;

/** Hidden CLI entrypoint used by the managed Claude StopFailure hook. */
export async function runClaudeLifecycleHookCommand(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  call: ControllerCall = callController
): Promise<void> {
  const notification = parseClaudeStopFailureHookNotification(stdinJson, environment);
  const home = requireIdentity(environment.YUI_HOME, "YUI_HOME");
  const inbox = new FileRuntimeEventInbox(home);
  inbox.enqueueClaudeStopFailure({
    scope: "task",
    taskId: notification.taskId,
    roleName: notification.roleName,
    agentId: notification.agentId,
    adapterId: notification.adapterId,
    launchId: notification.launchId,
    nativeSessionId: notification.nativeSessionId,
    runId: notification.runId,
    error: notification.error,
    ...(notification.errorDetails === undefined
      ? {}
      : { errorDetails: notification.errorDetails }),
    ...(notification.lastAssistantMessage === undefined
      ? {}
      : { lastAssistantMessage: notification.lastAssistantMessage })
  });
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

export function parseClaudeStopFailureHookNotification(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv
): ClaudeStopFailureHookNotification {
  const payload = parseObject(stdinJson);
  if (payload.hook_event_name !== "StopFailure") {
    throw new Error("Managed Claude lifecycle ingestion accepts only StopFailure.");
  }
  assertStopFailureHookKeys(payload);
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
  return {
    taskId: requireIdentity(environment.YUI_TASK_ID, "Task id"),
    roleName: requireIdentity(environment.YUI_ROLE, "Role name"),
    agentId: requireIdentity(environment.YUI_AGENT_ID, "Agent id"),
    adapterId: "claude",
    launchId: requireIdentity(environment.YUI_LAUNCH_ID, "Launch id"),
    runId: requireIdentity(environment.YUI_RUN_ID, "Run id"),
    nativeSessionId,
    type: "StopFailure",
    error: requireResult(payload.error, "Claude StopFailure error"),
    ...(payload.error_details === undefined
      ? {}
      : {
          errorDetails: requireResult(
            payload.error_details,
            "Claude StopFailure error_details"
          )
        }),
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

function assertStopFailureHookKeys(payload: Record<string, unknown>): void {
  const allowed = new Set([
    "hook_event_name",
    "session_id",
    "prompt_id",
    "transcript_path",
    "cwd",
    "permission_mode",
    "effort",
    "agent_id",
    "agent_type",
    "error",
    "error_details",
    "last_assistant_message"
  ]);
  const unexpected = Object.keys(payload).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new Error(`Claude lifecycle hook stdin JSON has unexpected field: ${unexpected}.`);
  }
  for (const required of ["hook_event_name", "session_id", "error"]) {
    if (!Object.hasOwn(payload, required)) {
      throw new Error(`Claude lifecycle hook stdin JSON is missing ${required}.`);
    }
  }
  assertCurrentCommonFields(payload);
  if (!CLAUDE_STOP_FAILURE_ERRORS.has(payload.error as string)) {
    invalidHookField("error");
  }
}

const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions"
]);
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_STOP_FAILURE_ERRORS = new Set([
  "rate_limit",
  "overloaded",
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "unknown"
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertCurrentCommonFields(payload: Record<string, unknown>): void {
  for (const key of ["transcript_path", "cwd", "agent_id", "agent_type"] as const) {
    if (payload[key] !== undefined) requireProviderText(payload[key], key);
  }
  if (payload.prompt_id !== undefined) {
    const promptId = requireProviderText(payload.prompt_id, "prompt_id");
    if (!UUID_PATTERN.test(promptId)) invalidHookField("prompt_id");
  }
  if (payload.permission_mode !== undefined
    && !CLAUDE_PERMISSION_MODES.has(payload.permission_mode as string)) {
    invalidHookField("permission_mode");
  }
  if (payload.effort !== undefined) {
    if (!isObject(payload.effort)
      || !hasExactKeys(payload.effort, ["level"])
      || !CLAUDE_EFFORT_LEVELS.has(payload.effort.level as string)) {
      invalidHookField("effort");
    }
  }
}

function requireProviderText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.trim().length === 0) {
    invalidHookField(field);
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function invalidHookField(field: string): never {
  throw new Error(`Claude lifecycle hook stdin JSON has invalid ${field}.`);
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
