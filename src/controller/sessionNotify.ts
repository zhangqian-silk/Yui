import { callController } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import {
  yuiRunBodyFromInputMessage,
  yuiRunIdFromInputMessages
} from "../run/runIdentity.js";
import { runtimeLifecycleSignalKey } from "../runtime/lifecycleReservation.js";
import {
  setCodexThreadName,
  type CodexThreadNameRequest
} from "../execution/codexThreadNaming.js";
import { FileTaskStore } from "../storage/taskStore.js";

export type CodexSessionNotification = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: "codex";
  launchId: string;
  nativeSessionId: string;
  turnId: string;
  runId?: string;
  title?: string;
  lastAssistantMessage: string;
}>;

type ControllerCall = (
  home: string,
  method: string,
  params: JsonValue,
  options?: Readonly<{ timeoutMs?: number }>
) => Promise<JsonValue>;

type CodexThreadNameSetter = (request: CodexThreadNameRequest) => Promise<void>;

/** Hidden CLI entrypoint used by Codex's structured notify hook. */
export async function runSessionNotifyCommand(
  payloadArgument: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  call?: ControllerCall,
  setThreadName: CodexThreadNameSetter = setCodexThreadName
): Promise<void> {
  const params = parseCodexSessionNotification(payloadArgument, environment);
  const home = requireText(environment.YUI_HOME, "YUI_HOME");
  const enqueued = new FileRuntimeEventInbox(home).enqueueTurnCompleted({
    scope: params.scope,
    ...(params.scope === "task" ? { taskId: params.taskId } : {}),
    roleName: params.roleName,
    agentId: params.agentId,
    adapterId: params.adapterId,
    launchId: params.launchId,
    nativeSessionId: params.nativeSessionId,
    turnId: params.turnId,
    ...(params.runId === undefined ? {} : { runId: params.runId }),
    ...(params.title === undefined ? {} : { title: params.title }),
    summary: params.lastAssistantMessage
  });
  // The durable write is authoritative. This short socket call is only a
  // wake-up hint and never starts or waits for a Controller process.
  await (call ?? callController)(
    home,
    "scheduler.signal",
    {
      key: runtimeLifecycleSignalKey(
        params.scope === "task"
          ? {
              scope: "task",
              taskId: params.taskId!,
              roleName: params.roleName
            }
          : {
              scope: "global",
              roleName: params.roleName
            }
      )
    },
    { timeoutMs: 100 }
  ).catch(() => {});
  if (enqueued.created && shouldSetThreadName(home, params)) {
    const request = threadNameRequest(params, environment);
    if (request !== null) await setThreadName(request).catch(() => {});
  }
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
  const title = environment.YUI_SESSION_TITLE === undefined
    ? sessionTitleFromInputMessages(payload["input-messages"])
    : requireText(environment.YUI_SESSION_TITLE, "YUI_SESSION_TITLE");
  const scope = environment.YUI_SESSION_SCOPE;
  if (scope !== "task" && scope !== "global") {
    throw new Error("YUI_SESSION_SCOPE must be task or global.");
  }
  const common = {
    scope,
    roleName: requireText(environment.YUI_ROLE, "YUI_ROLE"),
    agentId: requireText(environment.YUI_AGENT_ID, "YUI_AGENT_ID"),
    adapterId: requireCodexAdapter(environment.YUI_ADAPTER_ID),
    launchId: requireText(environment.YUI_LAUNCH_ID, "YUI_LAUNCH_ID"),
    nativeSessionId,
    turnId,
    ...(runId === undefined ? {} : { runId }),
    ...(title === undefined ? {} : { title }),
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

function sessionTitleFromInputMessages(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const body = yuiRunBodyFromInputMessage(entry);
    const normalized = body.trim().replaceAll(/\s+/g, " ");
    if (normalized.length > 0) return truncateSessionText(normalized);
  }
  return undefined;
}

function shouldSetThreadName(
  home: string,
  params: CodexSessionNotification
): boolean {
  if (
    params.scope !== "task"
    || params.title === undefined
    || params.runId === undefined
  ) return false;
  try {
    const store = new FileTaskStore(home);
    return store.getAgentRun(params.taskId!, params.runId)?.mode === "new";
  } catch {
    return false;
  }
}

function threadNameRequest(
  params: CodexSessionNotification,
  environment: NodeJS.ProcessEnv
): CodexThreadNameRequest | null {
  if (params.title === undefined) return null;
  const command = environment.YUI_AGENT_COMMAND;
  const encodedBaseArgs = environment.YUI_AGENT_BASE_ARGS;
  if (command === undefined || encodedBaseArgs === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(encodedBaseArgs);
    if (
      !Array.isArray(parsed)
      || parsed.some((value) => typeof value !== "string" || value.includes("\0"))
    ) {
      return null;
    }
    return {
      command: requireText(command, "YUI_AGENT_COMMAND"),
      baseArgs: parsed,
      environment,
      threadId: params.nativeSessionId,
      name: params.title
    };
  } catch {
    return null;
  }
}

function truncateSessionText(value: string): string {
  const truncated = value.slice(0, 1_024);
  return /[\uD800-\uDBFF]$/.test(truncated)
    ? truncated.slice(0, -1)
    : truncated;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
