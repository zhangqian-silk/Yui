import { reconciliationIntervalMilliseconds } from "../config/yuiConfig.js";
import { createHash } from "node:crypto";
import type { ControllerDispatcher } from "../core/controllerServer.js";
import type { JsonValue } from "../core/protocol.js";
import { activeRoleAgentBinding } from "../role/role.js";
import {
  agentComposerReadinessProbe,
  ExecutorRegistry
} from "../executor/executorRegistry.js";
import { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";
import {
  FileTaskWorkspacePreparer,
  type TaskWorkspacePreparer
} from "../repository/taskWorkspacePreparer.js";
import { NodeCommandExecutor } from "../tmux/commandExecutor.js";
import { TmuxManager } from "../tmux/tmuxManager.js";
import {
  TmuxPromptPushAdapter,
  TmuxSessionHost,
  type ActivePromptPushPort,
  type SessionHostPort
} from "../runtime/index.js";
import {
  startFileTaskController,
  type ControllerRuntimeOptions,
  type RunningFileTaskController
} from "./controller.js";
import { FileSchedulerStoreAdapter } from "./fileSchedulerStoreAdapter.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "./runtimeEventProcessor.js";

export type FileTaskControllerFactoryOptions = ControllerRuntimeOptions & Readonly<{
  store?: TaskStore;
  schedulerStore?: FileSchedulerStoreAdapter;
  planner?: FileRoleLaunchPlanner;
  tmux?: TmuxManager;
  delivery?: ExecutorRegistry;
  sessionHost?: SessionHostPort;
  promptPush?: ActivePromptPushPort;
  dispatcher?: ControllerDispatcher;
  environment?: NodeJS.ProcessEnv;
  workspacePreparer?: TaskWorkspacePreparer;
}>;

export type RunningFileTaskControllerRuntime = RunningFileTaskController & Readonly<{
  store: TaskStore;
  schedulerStore: FileSchedulerStoreAdapter;
  planner: FileRoleLaunchPlanner;
  tmux: TmuxManager;
  delivery: ExecutorRegistry;
  sessionHost: SessionHostPort;
  promptPush: ActivePromptPushPort;
  workspacePreparer: TaskWorkspacePreparer;
}>;

/** Production composition root for the lean FileTaskStore + tmux Controller. */
export async function startFileTaskControllerRuntime(
  home: string,
  options: FileTaskControllerFactoryOptions = {}
): Promise<RunningFileTaskControllerRuntime> {
  const store = options.store ?? new FileTaskStore(home);
  const schedulerStore = options.schedulerStore ?? new FileSchedulerStoreAdapter(store);
  const planner = options.planner ?? new FileRoleLaunchPlanner(home, store, {
    environment: options.environment
  });
  const tmux = options.tmux ?? new TmuxManager(
    options.environment?.YUI_TMUX_BIN ?? process.env.YUI_TMUX_BIN ?? "tmux",
    new NodeCommandExecutor(),
    { yuiHome: home }
  );
  const sessionHost = options.sessionHost ?? new TmuxSessionHost(planner, tmux);
  const promptPush = options.promptPush
    ?? new TmuxPromptPushAdapter(tmux, agentComposerReadinessProbe);
  const delivery = options.delivery ?? new ExecutorRegistry(
    planner,
    tmux,
    agentComposerReadinessProbe,
    { sessionHost, promptPush }
  );
  const workspacePreparer = options.workspacePreparer
    ?? new FileTaskWorkspacePreparer(home, store);
  const lifecycleDispatcher = createRuntimeLifecycleDispatcher(
    store,
    schedulerStore,
    sessionHost,
    options.dispatcher
  );
  const running = await startFileTaskController(
    home,
    schedulerStore,
    delivery,
    lifecycleDispatcher,
    {
      intervalMs: options.intervalMs
        ?? reconciliationIntervalMilliseconds(store.getConfig().reconciliationIntervalSeconds),
      signalWindowMs: options.signalWindowMs,
      deliveryRetryMs: options.deliveryRetryMs,
      deliveryRetryLimit: options.deliveryRetryLimit,
      now: options.now,
      onError: options.onError,
      workspacePreparer,
      runtimeEventProcessor: options.runtimeEventProcessor
        ?? new FileRuntimeEventProcessor(new FileRuntimeEventInbox(home), schedulerStore)
    }
  );
  return {
    ...running,
    store,
    schedulerStore,
    planner,
    tmux,
    delivery,
    sessionHost,
    promptPush,
    workspacePreparer
  };
}

export function createRuntimeLifecycleDispatcher(
  store: TaskStore,
  schedulerStore: FileSchedulerStoreAdapter,
  sessionHost: SessionHostPort,
  fallback?: ControllerDispatcher
): ControllerDispatcher {
  return async (method, params) => {
    if (method !== "runtime.ensure-role-session") {
      if (fallback !== undefined) return fallback(method, params);
      throw applicationError("METHOD_NOT_FOUND", "Controller method was not found.");
    }
    const request = parseEnsureRoleSession(params);
    const role = request.scope === "task"
      ? store.getRole(request.taskId, request.roleName)
      : store.getGlobalRole(request.roleName);
    if (role === null) {
      throw applicationError(
        "INVALID_PARAMS",
        request.scope === "task"
          ? `Role not found: ${request.taskId}/${request.roleName}.`
          : `Global Role not found: ${request.roleName}.`
      );
    }
    const binding = activeRoleAgentBinding(role);
    const session = request.scope === "task"
      ? store.getRoleSession(request.taskId, request.roleName)
      : store.getGlobalRoleSessionSet(request.roleName)?.sessions[role.activeAgentId];
    const common = {
      launchId: enterLaunchId(request),
      owner: request.scope === "task"
        ? { scope: "task" as const, taskId: request.taskId, roleName: request.roleName }
        : { scope: "global" as const, roleName: request.roleName },
      agentId: role.activeAgentId,
      adapterId: binding.adapterId,
      workspace: role.workspace
    };
    const runtimeBinding = session?.nativeSessionId === undefined
      ? await sessionHost.start({ ...common, mode: "new" })
      : await sessionHost.resume({
          ...common,
          mode: "resume",
          nativeSessionId: session.nativeSessionId
        });
    if (runtimeBinding.nativeSessionId !== undefined) {
      if (request.scope === "task") {
        schedulerStore.recordRuntimeNativeSession({
          taskId: request.taskId,
          roleName: request.roleName,
          agentId: role.activeAgentId,
          adapterId: binding.adapterId,
          nativeSessionId: runtimeBinding.nativeSessionId
        });
      } else {
        schedulerStore.recordGlobalRuntimeNativeSession({
          roleName: request.roleName,
          agentId: role.activeAgentId,
          adapterId: binding.adapterId,
          nativeSessionId: runtimeBinding.nativeSessionId
        });
      }
    }
    return {
      ensured: true,
      sessionStarted: runtimeBinding.hostCreated === true,
      scope: request.scope,
      roleName: request.roleName,
      ...(request.scope === "task" ? { taskId: request.taskId } : {})
    };
  };
}

function enterLaunchId(request: EnsureRoleSessionRequest): string {
  const identity = request.scope === "task"
    ? ["task", request.taskId, request.roleName]
    : ["global", request.roleName];
  return `enter-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

type EnsureRoleSessionRequest =
  | Readonly<{ scope: "task"; taskId: string; roleName: string }>
  | Readonly<{ scope: "global"; roleName: string }>;

function parseEnsureRoleSession(params: JsonValue): EnsureRoleSessionRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw applicationError("INVALID_PARAMS", "Runtime session params are invalid.");
  }
  const value = params as Readonly<Record<string, JsonValue>>;
  const roleName = requiredParam(value.roleName);
  if (value.scope === "global" && Object.keys(value).length === 2) {
    return { scope: "global", roleName };
  }
  if (value.scope === "task" && Object.keys(value).length === 3) {
    return {
      scope: "task",
      taskId: requiredParam(value.taskId),
      roleName
    };
  }
  throw applicationError("INVALID_PARAMS", "Runtime session params are invalid.");
}

function requiredParam(value: JsonValue | undefined): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw applicationError("INVALID_PARAMS", "Runtime session params are invalid.");
  }
  return value;
}

function applicationError(
  code: "INVALID_PARAMS" | "METHOD_NOT_FOUND",
  message: string
): Error {
  const error = Object.assign(new Error(message), { code });
  error.name = "CoreApplicationError";
  return error;
}
