import type { ControllerDispatcher } from "../core/controllerServer.js";
import type { JsonValue } from "../core/protocol.js";
import type { FileSchedulerStoreAdapter } from "./fileSchedulerStoreAdapter.js";
import { callFileTaskController } from "./clientRuntime.js";

const SESSION_BIND_METHOD = "runtime.session.bind";

export type SessionBindParams = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: "codex";
  nativeSessionId: string;
}>;

type ControllerCall = (
  home: string,
  method: string,
  params: JsonValue
) => Promise<JsonValue>;

/** Hidden CLI entrypoint used by Codex's structured legacy notify hook. */
export async function runSessionNotifyCommand(
  payloadArgument: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  call: ControllerCall = callFileTaskController
): Promise<void> {
  const params = parseCodexSessionNotification(payloadArgument, environment);
  await call(
    requireText(environment.YUI_HOME, "YUI_HOME"),
    SESSION_BIND_METHOD,
    toJson(params)
  );
}

export function parseCodexSessionNotification(
  payloadArgument: string | undefined,
  environment: NodeJS.ProcessEnv
): SessionBindParams {
  const payload = parseObject(payloadArgument, "Codex notify payload");
  if (payload.type !== "agent-turn-complete") {
    throw new Error("Codex notify payload type is invalid.");
  }
  const nativeSessionId = requireText(payload["thread-id"], "Codex thread-id");
  const scope = environment.YUI_SESSION_SCOPE;
  if (scope !== "task" && scope !== "global") {
    throw new Error("YUI_SESSION_SCOPE must be task or global.");
  }
  const common = {
    scope,
    roleName: requireText(environment.YUI_ROLE, "YUI_ROLE"),
    agentId: requireText(environment.YUI_AGENT_ID, "YUI_AGENT_ID"),
    adapterId: requireCodexAdapter(environment.YUI_ADAPTER_ID),
    nativeSessionId
  } as const;
  return scope === "task"
    ? {
        ...common,
        taskId: requireText(environment.YUI_TASK_ID, "YUI_TASK_ID")
      }
    : common;
}

/** Controller-side handler; session identity never travels through an Agent prompt. */
export function createSessionNotifyDispatcher(
  store: FileSchedulerStoreAdapter,
  fallback?: ControllerDispatcher
): ControllerDispatcher {
  return async (method, params) => {
    if (method !== SESSION_BIND_METHOD) {
      if (fallback !== undefined) return fallback(method, params);
      throw applicationError("METHOD_NOT_FOUND", "Controller method was not found.");
    }
    const input = parseSessionBindParams(params);
    const recorded = input.scope === "task"
      ? store.recordRuntimeNativeSession({
          taskId: input.taskId!,
          roleName: input.roleName,
          agentId: input.agentId,
          adapterId: input.adapterId,
          nativeSessionId: input.nativeSessionId
        })
      : store.recordGlobalRuntimeNativeSession({
          roleName: input.roleName,
          agentId: input.agentId,
          adapterId: input.adapterId,
          nativeSessionId: input.nativeSessionId
        });
    return {
      recorded: true,
      scope: input.scope,
      roleName: input.roleName,
      nativeSessionId: recorded.nativeSessionId
    };
  };
}

function parseSessionBindParams(value: JsonValue): SessionBindParams {
  if (!isObject(value)) throw invalidParams();
  const input = value as Record<string, JsonValue>;
  const scope = input.scope;
  const expected = scope === "task"
    ? ["scope", "taskId", "roleName", "agentId", "adapterId", "nativeSessionId"]
    : ["scope", "roleName", "agentId", "adapterId", "nativeSessionId"];
  if ((scope !== "task" && scope !== "global") || !hasExactKeys(input, expected)) {
    throw invalidParams();
  }
  try {
    const common = {
      scope,
      roleName: requireText(input.roleName, "Role name"),
      agentId: requireText(input.agentId, "Agent id"),
      adapterId: requireCodexAdapter(input.adapterId),
      nativeSessionId: requireText(input.nativeSessionId, "Native session id")
    } as const;
    return scope === "task"
      ? { ...common, taskId: requireText(input.taskId, "Task id") }
      : common;
  } catch {
    throw invalidParams();
  }
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

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function invalidParams(): Error {
  return applicationError("INVALID_PARAMS", "Runtime session params are invalid.");
}

function applicationError(code: "INVALID_PARAMS" | "METHOD_NOT_FOUND", message: string): Error {
  const error = Object.assign(new Error(message), { code });
  error.name = "CoreApplicationError";
  return error;
}

function toJson(value: SessionBindParams): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
