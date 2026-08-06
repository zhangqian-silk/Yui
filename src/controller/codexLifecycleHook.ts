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

type CodexHookEnvelope = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  launchId: string;
  runId: string;
  nativeSessionId: string;
}>;

type CodexSessionStartEnvelope = CodexHookEnvelope & Readonly<{ kind: "session-start" }>;
type CodexPromptSubmitEnvelope = CodexHookEnvelope & Readonly<{
  kind: "prompt-submit";
  receiptId: string;
}>;
type CodexHookNotificationEnvelope = CodexSessionStartEnvelope | CodexPromptSubmitEnvelope;

/**
 * Hidden CLI entrypoint used by the managed Codex lifecycle hooks. Codex 0.145
 * fires session_start and user_prompt_submit inside run_turn(input); this parses
 * by hook_event_name and writes one immutable runtime-inbox event per fact.
 * session_start maps (via the adapter) to provider-session-started only — never
 * pre-input readiness; user_prompt_submit is the exact provider-accepted fence.
 * The durable write is authoritative; the socket call is only a wake-up hint.
 */
export async function runCodexLifecycleHookCommand(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  call: ControllerCall = callController
): Promise<void> {
  const home = requireIdentity(environment.YUI_HOME, "YUI_HOME");
  const inbox = new FileRuntimeEventInbox(home);
  const envelope = parseCodexHookEnvelope(stdinJson, environment);
  if (envelope.kind === "session-start") {
    inbox.enqueueSessionLifecycle({
      scope: "task",
      taskId: envelope.taskId,
      roleName: envelope.roleName,
      agentId: envelope.agentId,
      adapterId: "codex",
      launchId: envelope.launchId,
      nativeSessionId: envelope.nativeSessionId,
      runId: envelope.runId
      // No sessionSource: Codex session_start carries no pre-input discriminator.
    });
  } else {
    inbox.enqueuePromptAccepted({
      scope: "task",
      taskId: envelope.taskId,
      roleName: envelope.roleName,
      agentId: envelope.agentId,
      adapterId: "codex",
      launchId: envelope.launchId,
      nativeSessionId: envelope.nativeSessionId,
      runId: envelope.runId,
      receiptId: envelope.receiptId
    });
  }
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

/**
 * Parses a Codex hook payload by hook_event_name into the exact fenced envelope.
 * Every event requires the managed launch envelope, and the payload session id
 * must match YUI_NATIVE_SESSION_ID, so a mismatched generation fails closed
 * before any inbox write.
 */
export function parseCodexHookEnvelope(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv
): CodexHookNotificationEnvelope {
  const payload = parseObject(stdinJson);
  const base = parseCodexEnvelope(payload, environment);
  switch (payload.hook_event_name) {
    case "session_start":
      return { ...base, kind: "session-start" };
    case "user_prompt_submit":
      return {
        ...base,
        kind: "prompt-submit",
        receiptId: `agent-run:${base.taskId}/${base.runId}`
      };
    default:
      throw new Error("Managed Codex lifecycle ingestion received an unsupported hook event.");
  }
}

function parseCodexEnvelope(
  payload: Record<string, unknown>,
  environment: NodeJS.ProcessEnv
): CodexHookEnvelope {
  if (environment.YUI_SESSION_SCOPE !== "task") {
    throw new Error("Codex lifecycle hook requires a Task session scope.");
  }
  if (environment.YUI_ADAPTER_ID !== "codex") {
    throw new Error("Codex lifecycle hook requires the Codex adapter.");
  }
  const nativeSessionId = requireIdentity(payload.session_id, "Codex session id");
  const expectedNativeSessionId = requireIdentity(
    environment.YUI_NATIVE_SESSION_ID,
    "YUI native session id"
  );
  if (nativeSessionId !== expectedNativeSessionId) {
    throw new Error("Codex lifecycle hook native session does not match its launch envelope.");
  }
  return {
    taskId: requireIdentity(environment.YUI_TASK_ID, "Task id"),
    roleName: requireIdentity(environment.YUI_ROLE, "Role name"),
    agentId: requireIdentity(environment.YUI_AGENT_ID, "Agent id"),
    launchId: requireIdentity(environment.YUI_LAUNCH_ID, "Launch id"),
    runId: requireIdentity(environment.YUI_RUN_ID, "Run id"),
    nativeSessionId
  };
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (value === undefined
    || Buffer.byteLength(value, "utf8") > MAX_RUNTIME_EVENT_FILE_BYTES) {
    throw new Error("Codex lifecycle hook stdin JSON is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isObject(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new Error("Codex lifecycle hook stdin JSON is invalid.");
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
