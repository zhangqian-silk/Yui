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

type CodexHookEnvelope = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  launchId: string;
  runId: string;
  nativeSessionId: string;
  receiptId: string;
}>;

type CodexSessionStartEnvelope = CodexHookEnvelope & Readonly<{ kind: "session-start" }>;
type CodexPromptSubmitEnvelope = CodexHookEnvelope & Readonly<{
  kind: "prompt-submit";
  receiptId: string;
}>;
type CodexHookNotificationEnvelope = CodexSessionStartEnvelope | CodexPromptSubmitEnvelope;

/**
 * Hidden CLI entrypoint used by the managed Codex lifecycle hooks. Codex 0.145
 * fires SessionStart and UserPromptSubmit inside run_turn(input); this parses
 * by hook_event_name and writes one immutable runtime-inbox event per fact.
 * SessionStart maps (via the adapter) to provider-session-started only — never
 * pre-input readiness; UserPromptSubmit is the exact provider-accepted fence.
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
      // Codex SessionStart arrives within the first turn, not before input.
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
  if (payload.hook_event_name !== "SessionStart"
    && payload.hook_event_name !== "UserPromptSubmit") {
    throw new Error("Managed Codex lifecycle ingestion received an unsupported hook event.");
  }
  const base = parseCodexEnvelope(payload, environment);
  switch (payload.hook_event_name) {
    case "SessionStart":
      return { ...base, kind: "session-start" };
    case "UserPromptSubmit":
      return {
        ...base,
        kind: "prompt-submit",
        receiptId: base.receiptId
      };
    default:
      throw new Error("Managed Codex lifecycle ingestion received an unsupported hook event.");
  }
}

function parseCodexEnvelope(
  payload: Record<string, unknown>,
  environment: NodeJS.ProcessEnv
): CodexHookEnvelope {
  const nativeSessionId = requireIdentity(payload.session_id, "Codex session id");
  return resolveProviderHookRunFence(environment, "codex", nativeSessionId);
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
