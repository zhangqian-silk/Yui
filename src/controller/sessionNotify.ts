import { callController } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import { yuiRunIdFromInputMessages } from "../run/runIdentity.js";

export type CodexSessionNotification = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: "codex";
  nativeSessionId: string;
  turnId: string;
  runId?: string;
  lastAssistantMessage: string;
}>;

type ControllerCall = (
  home: string,
  method: string,
  params: JsonValue,
  options?: Readonly<{ timeoutMs?: number }>
) => Promise<JsonValue>;

/** Hidden CLI entrypoint used by Codex's structured notify hook. */
export async function runSessionNotifyCommand(
  payloadArgument: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  call?: ControllerCall
): Promise<void> {
  const params = parseCodexSessionNotification(payloadArgument, environment);
  const home = requireText(environment.YUI_HOME, "YUI_HOME");
  new FileRuntimeEventInbox(home).enqueueTurnCompleted({
    scope: params.scope,
    ...(params.scope === "task" ? { taskId: params.taskId } : {}),
    roleName: params.roleName,
    agentId: params.agentId,
    adapterId: params.adapterId,
    nativeSessionId: params.nativeSessionId,
    turnId: params.turnId,
    ...(params.runId === undefined ? {} : { runId: params.runId }),
    summary: params.lastAssistantMessage
  });
  // The durable write is authoritative. This short socket call is only a
  // wake-up hint and never starts or waits for a Controller process.
  await (call ?? callController)(
    home,
    "scheduler.signal",
    {
      key: params.scope === "task"
        ? `role:${encodeURIComponent(params.taskId!)}/${encodeURIComponent(params.roleName)}`
        : "operator"
    },
    { timeoutMs: 100 }
  ).catch(() => {});
}

export function parseCodexSessionNotification(
  payloadArgument: string | undefined,
  environment: NodeJS.ProcessEnv
): CodexSessionNotification {
  const payload = parseObject(payloadArgument, "Codex notify payload");
  if (payload.type !== "agent-turn-complete") {
    throw new Error("Codex notify payload type is invalid.");
  }
  const nativeSessionId = requireText(payload["thread-id"], "Codex thread-id");
  const turnId = requireText(payload["turn-id"], "Codex turn-id");
  const lastAssistantMessage = requireAssistantMessage(payload["last-assistant-message"]);
  const runId = yuiRunIdFromInputMessages(payload["input-messages"]);
  const scope = environment.YUI_SESSION_SCOPE;
  if (scope !== "task" && scope !== "global") {
    throw new Error("YUI_SESSION_SCOPE must be task or global.");
  }
  const common = {
    scope,
    roleName: requireText(environment.YUI_ROLE, "YUI_ROLE"),
    agentId: requireText(environment.YUI_AGENT_ID, "YUI_AGENT_ID"),
    adapterId: requireCodexAdapter(environment.YUI_ADAPTER_ID),
    nativeSessionId,
    turnId,
    ...(runId === undefined ? {} : { runId }),
    lastAssistantMessage
  } as const;
  return scope === "task"
    ? {
        ...common,
        taskId: requireText(environment.YUI_TASK_ID, "YUI_TASK_ID")
      }
      : common;
}

function parseObject(value: string | undefined, label: string): Record<string, unknown> {
  if (value === undefined || Buffer.byteLength(value) > 1_048_576) {
    throw new Error(`${label} is invalid.`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isObject(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

function requireCodexAdapter(value: unknown): "codex" {
  if (value !== "codex") throw new Error("Runtime session notify requires the Codex adapter.");
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > 1_024) throw new Error(`${label} is invalid.`);
  return text;
}

function requireAssistantMessage(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Codex last assistant message is required.");
  }
  const text = value.trim();
  if (text.length === 0 || Buffer.byteLength(text) > 524_288) {
    throw new Error("Codex last assistant message is invalid.");
  }
  return text;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
