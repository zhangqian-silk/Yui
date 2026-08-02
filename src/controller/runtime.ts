import { reconciliationIntervalMilliseconds } from "../config/yuiConfig.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ControllerDispatcher } from "../core/controllerServer.js";
import type { JsonValue } from "../core/protocol.js";
import {
  activeRoleAgentBinding,
  type GlobalRole,
  type Role,
  type RoleAgentBinding
} from "../role/role.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import {
  AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
  nativeAgentEnvironmentNames,
  YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES
} from "../agent/launchEnvironment.js";
import {
  hasRuntimeCleanupObligation,
  runtimeLifecycleSignalKey,
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
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
  type AgentEnvironmentRefreshPort,
  type RuntimeLaunchPreparationPort,
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
import {
  RuntimeLaunchCoordinator,
  type CoordinatedRuntimeLaunchRequest
} from "./runtimeLaunchCoordinator.js";

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
  let runningRuntime: RunningFileTaskController["runtime"] | undefined;
  const signalRuntimeCleanup = (target: RuntimeLifecycleTarget) => {
    runningRuntime?.signal(runtimeLifecycleSignalKey(
      target.kind === "role-runtime"
        ? {
            scope: "task",
            taskId: target.taskId,
            roleName: target.roleName
          }
        : { scope: "global", roleName: target.roleName }
    ));
  };
  const launchCoordinator = new RuntimeLaunchCoordinator(
    schedulerStore,
    sessionHost,
    {
      ...(options.now === undefined ? {} : { now: options.now }),
      assertCurrent: (request) => {
        assertRuntimeLaunchRequestCurrent(store, request);
      },
      launchFingerprint: (request) => (
        runtimeLaunchFingerprint(store, request)
      ),
      onCleanupRequired: signalRuntimeCleanup
    }
  );
  const delivery = options.delivery ?? new ExecutorRegistry(
    planner,
    tmux,
    agentComposerReadinessProbe,
    { sessionHost, promptPush, launchCoordinator }
  );
  const workspacePreparer = options.workspacePreparer
    ?? new FileTaskWorkspacePreparer(home, store);
  const lifecycleDispatcher = createRuntimeLifecycleDispatcher(
    store,
    schedulerStore,
    sessionHost,
    options.dispatcher,
    signalRuntimeCleanup,
    launchCoordinator,
    planner
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
      lifecycleHost: sessionHost,
      workspacePreparer,
      runtimeEventProcessor: options.runtimeEventProcessor
        ?? new FileRuntimeEventProcessor(new FileRuntimeEventInbox(home), schedulerStore),
      ...(options.configuration !== undefined
        ? { configuration: options.configuration }
        : options.intervalMs === undefined
        ? {
            configuration: {
              reconciliationIntervalMs: () => reconciliationIntervalMilliseconds(
                store.getConfig().reconciliationIntervalSeconds
              )
            }
          }
        : {})
    }
  );
  runningRuntime = running.runtime;
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
  fallback?: ControllerDispatcher,
  onCleanupRequired?: (target: RuntimeLifecycleTarget) => void,
  sharedLaunchCoordinator?: RuntimeLaunchPreparationPort,
  environmentRefresher?: AgentEnvironmentRefreshPort
): ControllerDispatcher {
  const launchCoordinator = sharedLaunchCoordinator
    ?? new RuntimeLaunchCoordinator(schedulerStore, sessionHost, {
      assertCurrent: (request) => {
        assertRuntimeLaunchRequestCurrent(store, request);
      },
      launchFingerprint: (request) => (
        runtimeLaunchFingerprint(store, request)
      ),
      onCleanupRequired
    });
  const lifecycleTails = new Map<string, Promise<void>>();
  return async (method, params) => {
    if (method === "runtime.replace-agent-environment") {
      if (environmentRefresher === undefined) {
        throw applicationError("METHOD_NOT_FOUND", "Controller method was not found.");
      }
      const refresh = parseEnvironmentRefresh(params);
      validateEnvironmentRefreshSources(store, refresh);
      environmentRefresher.refreshAgentEnvironment(refresh);
      return {
        replaced: true,
        count: Object.keys(refresh.sources).length
          + Object.keys(refresh.nativeSources).length
      };
    }
    if (method !== "runtime.ensure-role-session") {
      if (fallback !== undefined) return fallback(method, params);
      throw applicationError("METHOD_NOT_FOUND", "Controller method was not found.");
    }
    const request = parseEnsureRoleSession(params);
    const lifecycleKey = request.scope === "task"
      ? `task\0${request.taskId}\0${request.roleName}`
      : `global\0${request.roleName}`;
    const previous = lifecycleTails.get(lifecycleKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    lifecycleTails.set(lifecycleKey, tail);
    await previous;
    try {
    const task = request.scope === "task"
      ? store.getTask(request.taskId)
      : null;
    if (request.scope === "task" && task?.status !== "active") {
      throw applicationError(
        "INVALID_PARAMS",
        task === null
          ? `Task not found: ${request.taskId}.`
          : `Task is not active: ${request.taskId}.`
      );
    }
    if (
      request.scope === "task"
      && hasPendingRuntimeCleanup(store, request)
    ) {
      throw new Error(
        `Runtime cleanup is still pending: ${request.taskId}/${request.roleName}.`
      );
    }
    if (
      request.scope === "global"
      && hasPendingRuntimeCleanup(store, request)
    ) {
      throw new Error(
        `Runtime cleanup is still pending: ${request.roleName}.`
      );
    }
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
    const agent = store.getConfiguredAgent(role.activeAgentId);
    if (agent === null || agent.adapterId !== binding.adapterId) {
      throw applicationError(
        "INVALID_PARAMS",
        `Configured Agent does not match Role: ${role.activeAgentId}.`
      );
    }
    validateLifecycleEnvironment(request.environment, agent);
    const fence = createLifecycleFence(role, binding, agent);
    const session = request.scope === "task"
      ? store.getRoleSession(request.taskId, request.roleName)
      : store.getGlobalRoleSessionSet(request.roleName)?.sessions[role.activeAgentId];
    const owner = request.scope === "task"
      ? { scope: "task" as const, taskId: request.taskId, roleName: request.roleName }
      : { scope: "global" as const, roleName: request.roleName };
    const common = {
      owner,
      agentId: role.activeAgentId,
      adapterId: binding.adapterId,
      workspace: role.workspace,
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment })
    };
    const assertCurrent = () => {
      const violation = lifecycleFenceViolation(store, request, fence);
      if (violation !== null) throw new Error(violation);
    };
    const runtimeBinding = await launchCoordinator.prepare(
      session?.nativeSessionId === undefined
        ? { ...common, mode: "new" }
        : {
            ...common,
            mode: "resume",
            nativeSessionId: session.nativeSessionId
          },
      "immediate",
      assertCurrent
    );
    return {
      ensured: true,
      sessionStarted: runtimeBinding.hostCreated === true,
      scope: request.scope,
      roleName: request.roleName,
      ...(request.scope === "task" ? { taskId: request.taskId } : {})
    };
    } finally {
      release();
      if (lifecycleTails.get(lifecycleKey) === tail) {
        lifecycleTails.delete(lifecycleKey);
      }
    }
  };
}

type LifecycleFence = Readonly<{
  role: Readonly<Record<string, unknown>>;
  agent: ConfiguredAgent;
}>;

function createLifecycleFence(
  role: Role | GlobalRole,
  binding: RoleAgentBinding,
  agent: ConfiguredAgent
): LifecycleFence {
  const {
    status: _status,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    agentBindings: _agentBindings,
    ...launchRole
  } = role as Role & Partial<Pick<Role, "status">>;
  return {
    role: {
      ...launchRole,
      activeBinding: binding
    },
    agent
  };
}

function lifecycleFenceViolation(
  store: TaskStore,
  request: EnsureRoleSessionRequest,
  expected: LifecycleFence
): string | null {
  if (request.scope === "task") {
    const task = store.getTask(request.taskId);
    if (task === null) return `Task no longer exists: ${request.taskId}.`;
    if (task.status !== "active") return `Task is no longer active: ${request.taskId}.`;
  }
  const role = request.scope === "task"
    ? store.getRole(request.taskId, request.roleName)
    : store.getGlobalRole(request.roleName);
  if (role === null) return `Role no longer exists: ${request.roleName}.`;
  let binding: RoleAgentBinding;
  try {
    binding = activeRoleAgentBinding(role);
  } catch {
    return `Role launch state changed: ${request.roleName}.`;
  }
  const agent = store.getConfiguredAgent(role.activeAgentId);
  if (
    agent === null
    || !isDeepStrictEqual(createLifecycleFence(role, binding, agent), expected)
  ) {
    return `Role or Agent launch state changed: ${request.roleName}.`;
  }
  return null;
}

function assertRuntimeLaunchRequestCurrent(
  store: TaskStore,
  request: CoordinatedRuntimeLaunchRequest
): void {
  let activeRun: ReturnType<TaskStore["getActiveAgentRun"]> = null;
  if (request.owner.scope === "task") {
    const task = store.getTask(request.owner.taskId);
    if (task === null || task.status !== "active") {
      throw new Error(`Task is no longer active: ${request.owner.taskId}.`);
    }
    activeRun = store.getActiveAgentRun(
      request.owner.taskId,
      request.owner.roleName
    );
    if (
      request.runId !== undefined
      && activeRun?.id !== request.runId
    ) {
      throw new Error(`Role Run is no longer current: ${request.runId}.`);
    }
  }
  const role = request.owner.scope === "task"
    ? store.getRole(request.owner.taskId, request.owner.roleName)
    : store.getGlobalRole(request.owner.roleName);
  if (role === null) {
    throw new Error(`Role no longer exists: ${request.owner.roleName}.`);
  }
  const binding = activeRoleAgentBinding(role);
  const expectedWorkspace = request.owner.scope === "task"
    && request.runId !== undefined
    ? activeRun?.workspace?.root ?? role.workspace
    : role.workspace;
  if (
    role.activeAgentId !== request.agentId
    || binding.adapterId !== request.adapterId
    || expectedWorkspace !== request.workspace
  ) {
    throw new Error(`Role launch state changed: ${request.owner.roleName}.`);
  }
  const agent = store.getConfiguredAgent(request.agentId);
  if (agent === null || agent.adapterId !== request.adapterId) {
    throw new Error(`Agent launch state changed: ${request.agentId}.`);
  }
  if (request.mode === "resume") {
    const session = request.owner.scope === "task"
      ? store.getRoleSession(request.owner.taskId, request.owner.roleName)
      : store.getGlobalRoleSessionSet(request.owner.roleName)
        ?.sessions[request.agentId];
    if (session?.nativeSessionId !== request.nativeSessionId) {
      throw new Error(`Native session changed: ${request.owner.roleName}.`);
    }
  }
}

function runtimeLaunchFingerprint(
  store: TaskStore,
  request: CoordinatedRuntimeLaunchRequest
): string {
  const role = request.owner.scope === "task"
    ? store.getRole(request.owner.taskId, request.owner.roleName)
    : store.getGlobalRole(request.owner.roleName);
  if (role === null) {
    throw new Error(`Role no longer exists: ${request.owner.roleName}.`);
  }
  const binding = activeRoleAgentBinding(role);
  const agent = store.getConfiguredAgent(role.activeAgentId);
  if (agent === null) {
    throw new Error(`Agent no longer exists: ${role.activeAgentId}.`);
  }
  return createHash("sha256").update(JSON.stringify([
    request.owner,
    createLifecycleFence(role, binding, agent)
  ])).digest("hex");
}

function hasPendingRuntimeCleanup(
  store: TaskStore,
  request: EnsureRoleSessionRequest
): boolean {
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(request));
  return hasRuntimeCleanupObligation(mailbox);
}

type EnsureRoleSessionRequest =
  | Readonly<{
      scope: "task";
      taskId: string;
      roleName: string;
      environment?: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      scope: "global";
      roleName: string;
      environment?: Readonly<Record<string, string>>;
    }>;

function parseEnsureRoleSession(params: JsonValue): EnsureRoleSessionRequest {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw applicationError("INVALID_PARAMS", "Runtime session params are invalid.");
  }
  const value = params as Readonly<Record<string, JsonValue>>;
  const roleName = requiredParam(value.roleName);
  const environment = parseLifecycleEnvironment(value.environment);
  const expectedFields = environment === undefined ? 0 : 1;
  if (value.scope === "global" && Object.keys(value).length === 2 + expectedFields) {
    return {
      scope: "global",
      roleName,
      ...(environment === undefined ? {} : { environment })
    };
  }
  if (value.scope === "task" && Object.keys(value).length === 3 + expectedFields) {
    return {
      scope: "task",
      taskId: requiredParam(value.taskId),
      roleName,
      ...(environment === undefined ? {} : { environment })
    };
  }
  throw applicationError("INVALID_PARAMS", "Runtime session params are invalid.");
}

function parseLifecycleEnvironment(
  value: JsonValue | undefined
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw applicationError("INVALID_PARAMS", "Runtime session environment is invalid.");
  }
  const entries = Object.entries(value);
  if (entries.length > 256) {
    throw applicationError("INVALID_PARAMS", "Runtime session environment is invalid.");
  }
  const environment: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof item !== "string"
      || item.includes("\0")
      || MANAGED_RUNTIME_ENVIRONMENT.has(name)
    ) {
      throw applicationError("INVALID_PARAMS", "Runtime session environment is invalid.");
    }
    environment[name] = item;
  }
  return environment;
}

function validateLifecycleEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  agent: ConfiguredAgent
): void {
  if (environment === undefined) return;
  const declared = new Map(agent.environment.map((binding) => [
    binding.sourceName,
    binding
  ]));
  const allowed = new Set<string>([
    ...declared.keys(),
    ...AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
    ...nativeAgentEnvironmentNames(agent.adapterId)
  ]);
  for (const name of Object.keys(environment)) {
    if (!allowed.has(name)) {
      throw applicationError(
        "INVALID_PARAMS",
        `Runtime session environment source is not declared: ${name}.`
      );
    }
  }
  const missing = agent.environment.find((binding) => (
    binding.required
    && !MANAGED_RUNTIME_ENVIRONMENT.has(binding.sourceName)
    && environment[binding.sourceName] === undefined
  ));
  if (missing !== undefined) {
    throw applicationError(
      "INVALID_PARAMS",
      `Required Agent environment is missing: ${missing.sourceName}.`
    );
  }
}

const MANAGED_RUNTIME_ENVIRONMENT = new Set<string>(
  YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES
);

function parseEnvironmentRefresh(
  params: JsonValue
): Readonly<{
  sources: Readonly<Record<string, string>>;
  sourceNames: readonly string[];
  nativeSources: Readonly<Record<string, string>>;
  nativeNames: readonly string[];
}> {
  if (
    typeof params !== "object"
    || params === null
    || Array.isArray(params)
    || Object.keys(params).length !== 4
  ) {
    throw applicationError(
      "INVALID_PARAMS",
      "Runtime Agent environment refresh params are invalid."
    );
  }
  const values = params as Readonly<Record<string, JsonValue>>;
  return {
    sources: parseEnvironmentValues(values.sources, "sources"),
    sourceNames: parseEnvironmentNames(values.sourceNames, "source names"),
    nativeSources: parseEnvironmentValues(values.nativeSources, "native sources"),
    nativeNames: parseEnvironmentNames(values.nativeNames, "native names")
  };
}

function parseEnvironmentValues(
  value: JsonValue | undefined,
  label: string
): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw applicationError("INVALID_PARAMS", `Runtime Agent environment ${label} are invalid.`);
  }
  const entries = Object.entries(value);
  if (entries.length > 256) {
    throw applicationError(
      "INVALID_PARAMS",
      "Runtime Agent environment refresh has too many sources."
    );
  }
  const sources: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof item !== "string"
      || item.includes("\0")
      || MANAGED_RUNTIME_ENVIRONMENT.has(name)
    ) {
      throw applicationError(
        "INVALID_PARAMS",
        `Runtime Agent environment source is invalid: ${name}.`
      );
    }
    sources[name] = item;
  }
  return sources;
}

function parseEnvironmentNames(
  value: JsonValue | undefined,
  label: string
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > 256
    || value.some((name) => (
      typeof name !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || MANAGED_RUNTIME_ENVIRONMENT.has(name)
    ))
  ) {
    throw applicationError("INVALID_PARAMS", `Runtime Agent environment ${label} are invalid.`);
  }
  return [...new Set(value as string[])];
}

function validateEnvironmentRefreshSources(
  store: TaskStore,
  refresh: Readonly<{
    sources: Readonly<Record<string, string>>;
    sourceNames: readonly string[];
    nativeSources: Readonly<Record<string, string>>;
    nativeNames: readonly string[];
  }>
): void {
  const declared = new Set(store.listConfiguredAgents().flatMap((agent) => (
    agent.environment.map((binding) => binding.sourceName)
  )));
  for (const name of Object.keys(refresh.sources)) {
    if (!declared.has(name)) {
      throw applicationError(
        "INVALID_PARAMS",
        `Runtime Agent environment source is not declared: ${name}.`
      );
    }
  }
  if (Object.keys(refresh.sources).some((name) => !refresh.sourceNames.includes(name))) {
    throw applicationError("INVALID_PARAMS", "Runtime Agent environment source scope is invalid.");
  }
  const native = new Set(store.listConfiguredAgents().flatMap((agent) => (
    nativeAgentEnvironmentNames(agent.adapterId)
  )));
  for (const name of Object.keys(refresh.nativeSources)) {
    if (!native.has(name) || !refresh.nativeNames.includes(name)) {
      throw applicationError(
        "INVALID_PARAMS",
        `Runtime native Agent environment source is not declared: ${name}.`
      );
    }
  }
  const allowedNative = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR"]);
  if (refresh.nativeNames.some((name) => !allowedNative.has(name))) {
    throw applicationError("INVALID_PARAMS", "Runtime native Agent environment scope is invalid.");
  }
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
