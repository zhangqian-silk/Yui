import { reconciliationIntervalMilliseconds } from "../config/yuiConfig.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { controllerSocketPath } from "../core/controllerEndpoint.js";
import type { ControllerDispatcher } from "../core/controllerServer.js";
import type { JsonValue } from "../core/protocol.js";
import { type GlobalRole, type Role } from "../role/role.js";
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
  agentProcessReadinessProbe,
  ExecutorRegistry
} from "../executor/executorRegistry.js";
import {
  activeLiveRoleAgentSession,
  roleAgentSessionResumeMode
} from "../executor/agentExecutor.js";
import {
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskMain,
  resolveEffectiveLaunch,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { isTaskOwnedWorkspace } from "../worktree/managedWorkspace.js";
import { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import type { TaskStore } from "../storage/taskStore.js";
import { openCompatibleFileTaskStore } from "../storage/compatibleTaskStore.js";
import { SqliteTaskStore } from "../storage/sqliteStore.js";
import {
  AsyncTaskStoreClient,
  resolveStoreWorkerEnabledForHome
} from "../storage/storeRpc.js";
import {
  FileTaskWorkspacePreparer,
  type TaskWorkspacePreparer
} from "../repository/taskWorkspacePreparer.js";
import { NodeCommandExecutor } from "../tmux/commandExecutor.js";
import { TmuxManager, yuiTmuxServerName } from "../tmux/tmuxManager.js";
import {
  FileTaskRuntimeIsolation,
  TmuxPromptPushAdapter,
  TmuxSessionHost,
  type ActivePromptPushPort,
  type AgentEnvironmentRefreshPort,
  type RuntimeLaunchPreparationPort,
  type TaskRuntimeIsolationPort,
  type TaskRuntimeLifecycleCleanupPort,
  type SessionHostPort
} from "../runtime/index.js";
import {
  startFileTaskController,
  type ControllerRuntimeOptions,
  type RunningFileTaskController
} from "./controller.js";
import { FileSchedulerStoreAdapter } from "./fileSchedulerStoreAdapter.js";
import { openSchedulerTelemetry } from "../telemetry/telemetryWiring.js";
import {
  createFileArtifactPort,
  createLinuxProcessPort,
  DurableJobSupervisor
} from "./jobSupervisor.js";
import { createDurableJobControl } from "./jobControl.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import {
  AsyncRuntimeEventProcessor,
  FileRuntimeEventProcessor,
  createAsyncRuntimeObserver,
  type TaskRuntimeAppliedInput
} from "./runtimeEventProcessor.js";
import {
  RuntimeLaunchCoordinator,
  type CoordinatedRuntimeLaunchRequest
} from "./runtimeLaunchCoordinator.js";
import {
  ephemeralDomainFromEnvironment,
  recordEphemeralTmuxTarget
} from "./domainIdentity.js";
import { createEphemeralResourceReaper } from "./ephemeralResourceReaper.js";
import { scanControllerResourceInventory } from "./resourceInventoryLinux.js";
import { ResourceInventoryClient } from "./resourceInventoryRpc.js";
import { createResourceAutoGc } from "../resources/autoResourceGc.js";
import {
  createRuntimeResourceActivityTracker,
  type RuntimePaneFact,
  type RuntimeResourceSampleIdentity
} from "./resourceInventory.js";
import { SessionOwnerReconciliation } from "./sessionOwnerReconciliation.js";

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
  runtimeIsolation?: TaskRuntimeIsolationPort & Partial<TaskRuntimeLifecycleCleanupPort>;
}>;

export type RunningFileTaskControllerRuntime = RunningFileTaskController & Readonly<{
  store: TaskStore;
  schedulerStore: FileSchedulerStoreAdapter;
  planner: FileRoleLaunchPlanner;
  tmux: TmuxManager;
  delivery: ExecutorRegistry;
  sessionHost: SessionHostPort;
  promptPush: ActivePromptPushPort;
  runtimeIsolation: TaskRuntimeIsolationPort & Partial<TaskRuntimeLifecycleCleanupPort>;
  workspacePreparer: TaskWorkspacePreparer;
}>;

/** Refreshes only the exact Task runtime generation folded by the event transaction. */
export function refreshAppliedTaskRuntimeDescriptor(
  store: Pick<TaskStore, "getAgentRun" | "getTaskRoleSessionSet">,
  planner: Pick<FileRoleLaunchPlanner, "refreshTaskRuntimeDescriptor">,
  input: TaskRuntimeAppliedInput
): void {
  if (input.launchId === undefined) return;
  const run = input.runId === undefined
    ? null
    : store.getAgentRun(input.taskId, input.runId);
  if (input.runId !== undefined && run === null) {
    throw new Error("Prepared Task runtime generation is not current.");
  }
  // A terminal completion has already settled this exact Run and no later
  // prompt can use its descriptor. Acknowledge the applied provider fact
  // without republishing a dead generation.
  if (run !== null && run.status !== "active") return;
  const session = store.getTaskRoleSessionSet(input.taskId, input.roleName)
    ?.sessions[input.agentId];
  const effective = run?.effective ?? session?.effective;
  if (
    effective === undefined
    || session === undefined
    || session.agentId !== input.agentId
    || session.adapterId !== input.adapterId
    || session.launchId !== input.launchId
    || session.nativeSessionId !== input.nativeSessionId
    || (run !== null && (
      run.roleName !== input.roleName
      || run.effective.agentId !== input.agentId
      || run.effective.adapterId !== input.adapterId
    ))
  ) {
    throw new Error("Prepared Task runtime generation is not current.");
  }
  planner.refreshTaskRuntimeDescriptor({
    ...input,
    launchId: input.launchId,
    workspace: effective.workspace.root
  });
}

/** Production composition root for the lean FileTaskStore + tmux Controller. */
export async function startFileTaskControllerRuntime(
  home: string,
  options: FileTaskControllerFactoryOptions = {}
): Promise<RunningFileTaskControllerRuntime> {
  // The Home decides the backend (Issue 01): a layout-7 Home runs SQLite with
  // the persistence worker on by default; YUI_STORE_WORKER=0/false forces the
  // in-process SQLite connection. The non-worker path opens the Home-decided
  // backend through the compatibility opener (SQLite for layout 7, file store
  // with normalization for older layouts).
  const useWorker = resolveStoreWorkerEnabledForHome(
    home,
    options.environment ?? process.env
  );
  const store = options.store
    ?? (useWorker
      // Transitional: the scheduler/planner still use a sync store. The worker
      // owns the event-processing hot path; the scheduler migration is the next
      // step (see work-item-5 remaining call sites). Both connections point at
      // the same WAL db and serialize via BEGIN IMMEDIATE + busy_timeout.
      ? new SqliteTaskStore(home)
      : openCompatibleFileTaskStore(home));
  // When the worker backend is active, the db-touching observer folds run in
  // the worker (off the main event loop). The client is closed on shutdown.
  const asyncStoreClient = useWorker
    ? new AsyncTaskStoreClient(home, {
        environment: options.environment,
        observerModule: new URL("./fileSchedulerStoreAdapter.js", import.meta.url)
      })
    : undefined;
  // When the worker backend is active, the blocking /proc inventory scan runs
  // in the inventory worker (off the main event loop); the scheduler and the
  // ephemeral reaper consume the same inventory shape through this client (§3.3).
  const inventoryClient = useWorker
    ? new ResourceInventoryClient()
    : undefined;
  const schedulerStore = options.schedulerStore
    ?? new FileSchedulerStoreAdapter(
      store,
      openSchedulerTelemetry(home, options.environment ?? process.env)
    );
  const domainIdentity = options.domainIdentity
    ?? ephemeralDomainFromEnvironment(options.environment ?? process.env);
  const planner = options.planner ?? new FileRoleLaunchPlanner(home, store, {
    environment: options.environment
  });
  const tmux = options.tmux ?? new TmuxManager(
    options.environment?.YUI_TMUX_BIN ?? process.env.YUI_TMUX_BIN ?? "tmux",
    new NodeCommandExecutor(),
    {
      yuiHome: home,
      ...(domainIdentity === undefined
        ? {}
        : {
            onRoleTargetRecorded: (target: string) => {
              if (!recordEphemeralTmuxTarget(home, domainIdentity.token, target)) {
                throw new Error(
                  `Ephemeral tmux target fence could not be recorded: ${target}.`
                );
              }
            }
          })
    }
  );
  const sessionOwners = new SessionOwnerReconciliation({
    home,
    store,
    environment: options.environment,
    tmux,
    onWarning: options.onError
  });
  const sessionHost = options.sessionHost ?? new TmuxSessionHost(planner, tmux, {
    onHostCreated: ({ binding, pane }) => {
      sessionOwners.recordHostOwner({
        owner: binding.owner,
        agentId: binding.agentId,
        adapterId: binding.adapterId,
        launchId: binding.launchId,
        ...(binding.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: binding.nativeSessionId }),
        ...(pane.pid === undefined ? {} : { panePid: pane.pid })
      });
    }
  });
  const promptPush = options.promptPush
    ?? new TmuxPromptPushAdapter(tmux, agentProcessReadinessProbe);
  const runtimeIsolation = options.runtimeIsolation
    ?? new FileTaskRuntimeIsolation({
      // A sibling of the exact control Home keeps provider data/cache/tmp out
      // of both the shared control plane and every managed Git workspace.
      runtimeRoot: `${resolve(home)}.task-runtimes`,
      controlPlane: {
        yuiHome: home,
        controllerSocketPath: controllerSocketPath(home),
        tmuxNamespace: yuiTmuxServerName(home),
        globalInstallPaths: [process.execPath]
      }
    });
  const lifecycleHost = {
    inspectOwner: (owner: Parameters<SessionHostPort["inspectOwner"]>[0]) => (
      sessionHost.inspectOwner(owner)
    ),
    ...(sessionHost.inspectOwners === undefined
      ? {}
      : {
          inspectOwners: (
            owners: Parameters<NonNullable<SessionHostPort["inspectOwners"]>>[0]
          ) => sessionHost.inspectOwners!(owners)
        }),
    stopOwner: (owner: Parameters<SessionHostPort["stopOwner"]>[0]) => {
      // Issue 03: the durable `stopped` transition is gated on physical
      // exit proof. A blocked result keeps the Session non-terminal and
      // preserves owner records for Operator recovery.
      return sessionOwners.terminateOwner(owner).then((result) => {
        if (result.outcome === "stop-blocked") {
          (options.onError ?? (() => undefined))(
            new Error(
              `Role runtime cleanup could not prove physical exit: ${
                result.remaining
                  .map(({ record, detail }) => `${record.launchId}: ${detail}`)
                  .join("; ")
              }`
            )
          );
        }
        return result.outcome === "stop-confirmed";
      });
    },
    ...(runtimeIsolation.cleanupTaskLaunch === undefined
      ? {}
      : {
          cleanupTaskLaunch: (
            input: Parameters<NonNullable<
              TaskRuntimeLifecycleCleanupPort["cleanupTaskLaunch"]
            >>[0]
          ) => runtimeIsolation.cleanupTaskLaunch!(input)
        })
  };
  const resourceActivity = createRuntimeResourceActivityTracker();
  let runningRuntime: RunningFileTaskController["runtime"] | undefined;
  let runningController: RunningFileTaskController | undefined;
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
      onCleanupRequired: signalRuntimeCleanup,
      runtimeIsolation
    }
  );
  // One inventory scan per scheduler pass. When the worker backend is active
  // the blocking /proc scan runs in the inventory worker; otherwise it runs on
  // the main thread (file backend, unchanged).
  const scanInventory = (panes: readonly RuntimePaneFact[]) => inventoryClient !== undefined
    ? inventoryClient.scan({
        currentHome: home,
        scope: "current",
        panes,
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment })
      })
    : scanControllerResourceInventory({
        currentHome: home,
        scope: "current",
        panes,
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment })
      });
  const delivery = options.delivery ?? new ExecutorRegistry(
    planner,
    tmux,
    agentProcessReadinessProbe,
    {
      sessionHost,
      promptPush,
      launchCoordinator,
      roleResourceInventory: async (panes, inputs) => {
        const inventory = await scanInventory(panes);
        return inventory.resources.flatMap((resource) => {
          if (resource.kind !== "agent-session") return [];
          const owner = resource.owner;
          if (owner.kind !== "task-role") return [];
          const active = resource.state === "running" || resource.state === "current";
          const input = inputs.find((candidate) => (
            candidate.taskId === owner.taskId
            && candidate.roleName === owner.roleName
          ));
          if (input === undefined) return [];
          const identity = owner.runId === undefined
            || owner.adapterId === undefined
            || (owner.nativeSessionId === undefined && owner.launchId === undefined)
            || (owner.nativeSessionId !== undefined && owner.nativeSessionId.trim().length === 0)
            || (owner.launchId !== undefined && owner.launchId.trim().length === 0)
            ? undefined
            : {
                taskId: owner.taskId,
                roleName: owner.roleName,
                runId: owner.runId,
                agentId: owner.agentId,
                adapterId: owner.adapterId,
                ...(owner.nativeSessionId === undefined
                  ? {}
                  : { nativeSessionId: owner.nativeSessionId }),
                ...(owner.launchId === undefined ? {} : { launchId: owner.launchId })
              };
          const changed = !active || input.runId === undefined
            ? false
            : resourceActivity({
                taskId: input.taskId,
                roleName: input.roleName,
                runId: input.runId,
                agentId: input.agentId,
                adapterId: input.adapterId,
                ...(input.nativeSessionId === undefined
                  ? {}
                  : { nativeSessionId: input.nativeSessionId }),
                ...(input.launchId === undefined ? {} : { launchId: input.launchId })
              } satisfies RuntimeResourceSampleIdentity, resource);
          return [{
            taskId: owner.taskId,
            roleName: owner.roleName,
            resource: {
              observedAt: inventory.observedAt,
              active,
              changed: active && changed,
              ...(identity === undefined ? {} : { identity }),
              ...(input.progressAt === undefined ? {} : { progressAt: input.progressAt }),
              cpuTimeMs: resource.cpuTimeMs,
              ...(resource.ioReadBytes === undefined
                ? {}
                : { ioReadBytes: resource.ioReadBytes }),
              ...(resource.ioWriteBytes === undefined
                ? {}
                : { ioWriteBytes: resource.ioWriteBytes }),
              rssBytes: resource.rssBytes
            }
          }];
        });
      }
    }
  );
  const workspacePreparer = options.workspacePreparer
    ?? new FileTaskWorkspacePreparer(home, store);
  const resourceReaper = options.resourceReaper
    ?? (domainIdentity === undefined
      ? undefined
      : createEphemeralResourceReaper({
          currentHome: home,
          // The detached Controller owns one YUI_HOME. Keep automatic
          // recovery bounded to that domain; cross-home cleanup remains an
          // explicit `controller cleanup --all` inventory operation.
          scope: "current",
          environment: options.environment,
          // When the worker backend is active, the reaper's scan runs in the
          // inventory worker too (same cadence, same inventory shape).
          ...(inventoryClient === undefined
            ? {}
            : {
                scan: () => inventoryClient.scan({
                  currentHome: home,
                  scope: "current",
                  ...(options.environment === undefined
                    ? {}
                    : { environment: options.environment })
                })
              })
        }));
  // Issue 10: automatic Resource GC. The runner self-skips unless
  // resourcesGcMode=quarantine and resourcesGcAutoQuarantine=true, so wiring
  // it unconditionally costs one config read per full pass when disabled.
  const resourceAutoGc = options.resourceAutoGc
    ?? createResourceAutoGc({
      home,
      store,
      environment: options.environment
    });
  const lifecycleDispatcher = createRuntimeLifecycleDispatcher(
    store,
    schedulerStore,
    sessionHost,
    options.dispatcher,
    signalRuntimeCleanup,
    launchCoordinator,
    planner
  );
  // f7/rr5: Share one inbox between the supervisor's terminal channel and
  // the runtime event processor. When a Job reaches a terminal state, the
  // supervisor enqueues a durable-job-terminal event; the processor drains
  // it on the next pass, waking the Controller immediately instead of
  // waiting for the poll interval.
  const runtimeEventInbox = new FileRuntimeEventInbox(home);
  const jobSupervisor = new DurableJobSupervisor({
    store: schedulerStore,
    process: createLinuxProcessPort(),
    artifacts: createFileArtifactPort(home),
    // rr6/f1: Bounded supervision wake. The supervisor signals the Controller
    // after spawning a runner (queued→running adoption) and when a runner
    // exits (terminal harvest), so a quick job converges without waiting for
    // the recovery interval. Closes over runningRuntime, which is assigned
    // once startFileTaskController resolves; a wake during shutdown is a
    // no-op. The recovery interval stays the cross-restart fallback.
    wake: (taskId) => {
      try {
        runningRuntime?.signal(`task:${taskId}`);
      } catch {
        // Controller stopped; the recovery interval remains the fallback.
      }
    },
    terminalEvents: {
      deliverTerminalEvent(notice) {
        try {
          runtimeEventInbox.enqueueDurableJobTerminal({
            scope: "task",
            taskId: notice.taskId,
            jobId: notice.jobId,
            status: notice.status as "succeeded" | "failed" | "timed-out" | "cancelled" | "unknown-needs-attention",
            outcome: notice.outcome
          });
        } catch (error) {
          // Best-effort terminal channel: the terminal transition already
          // committed. A delivery failure must not fail the reconcile pass.
          (options.onError ?? (() => undefined))(error);
        }
      }
    },
    onError: options.onError
  });
  const jobControl = createDurableJobControl(store);
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
      lifecycleHost,
      jobSupervisor,
      jobControl,
      ...(resourceReaper === undefined ? {} : { resourceReaper }),
      resourceAutoGc,
      onExpiredEphemeralDomain: (domain) => {
        if (domain.yuiHome !== home) return;
        void runningController?.close().catch(options.onError ?? (() => undefined));
      },
      workspacePreparer,
      runtimeEventProcessor: options.runtimeEventProcessor
        ?? (useWorker && asyncStoreClient !== undefined
          ? new AsyncRuntimeEventProcessor(
            runtimeEventInbox,
            createAsyncRuntimeObserver(
              (method, args) => asyncStoreClient.invokeObserver(method, args)
            ),
            {
              onTaskRuntimeApplied: (input) => {
                refreshAppliedTaskRuntimeDescriptor(store, planner, input);
              }
            }
          )
          : new FileRuntimeEventProcessor(
            runtimeEventInbox,
            schedulerStore,
            {
              onTaskRuntimeApplied: (input) => {
                refreshAppliedTaskRuntimeDescriptor(store, planner, input);
              }
            }
          )),
      domainIdentity,
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
  runningController = running;
  runningRuntime = running.runtime;
  // Issue 03: read-only startup reconciliation. Surfaces durable/physical
  // Session mismatches (including generations whose durable map was cleared)
  // without changing stop or archive behavior. Cleanup stays an explicit
  // Operator action in exact-owner-cleanup mode.
  try {
    const startupReport = sessionOwners.report();
    if (startupReport.summary.livePhysicalRoots > 0) {
      (options.onError ?? (() => undefined))(
        new Error(
          `Session reconciliation: ${startupReport.summary.livePhysicalRoots} `
            + `live physical root(s) across ${startupReport.summary.owners} owner record(s); `
            + "run `yui session reconcile --report` for details."
        )
      );
    }
  } catch (error) {
    (options.onError ?? (() => undefined))(error);
  }
  return {
    ...running,
    close: async () => {
      await running.close();
      // Release the worker's database connections when the worker backend is active.
      await asyncStoreClient?.close();
      await inventoryClient?.close();
    },
    store,
    schedulerStore,
    planner,
    tmux,
    delivery,
    sessionHost,
    promptPush,
    runtimeIsolation,
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
    if (request.scope === "task" && task !== null) {
      const taskWorkspace = store.getTaskWorkspace(task.id);
      if (!isTaskOwnedWorkspace(
        taskWorkspace,
        task.id,
        task.cwd,
        task.projectBindings.map(({ projectId, directory }) => ({ projectId, directory }))
      )) {
        throw new Error(`Task workspace is not ready: ${task.id}.`);
      }
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
    const activeRun = request.scope === "task"
      ? store.getActiveAgentRun(request.taskId, request.roleName)
      : null;
    const managedWorkspace = request.scope === "task"
      ? activeRun?.workspace
        ?? currentDesiredManagedWorkspace(store, request.taskId, request.roleName)
      : undefined;
    const sessions = request.scope === "task"
      ? store.getTaskRoleSessionSet(request.taskId, request.roleName)
      : store.getGlobalRoleSessionSet(request.roleName);
    const effective = activeRun?.effective
      ?? activeLiveRoleAgentSession(sessions)?.effective
      ?? resolveRuntimeDesiredEffective(store, request, role);
    const binding = role.agentBindings[effective.agentId];
    const agent = store.getConfiguredAgent(effective.agentId);
    if (binding === undefined || binding.adapterId !== effective.adapterId) {
      throw applicationError(
        "INVALID_PARAMS",
        `Role binding does not match effective launch: ${effective.agentId}.`
      );
    }
    if (agent === null || agent.adapterId !== binding.adapterId) {
      throw applicationError(
        "INVALID_PARAMS",
        `Configured Agent does not match Role: ${effective.agentId}.`
      );
    }
    validateLifecycleEnvironment(request.environment, agent);
    const mode = roleAgentSessionResumeMode(
      sessions,
      effective.agentId,
      effective,
      managedWorkspace
    );
    const session = sessions?.sessions[effective.agentId];
    const owner = request.scope === "task"
      ? { scope: "task" as const, taskId: request.taskId, roleName: request.roleName }
      : { scope: "global" as const, roleName: request.roleName };
    const common = {
      owner,
      agentId: effective.agentId,
      adapterId: binding.adapterId,
      effective,
      workspace: effective.workspace.root,
      ...(managedWorkspace === undefined ? {} : { managedWorkspace }),
      ...(activeRun === null ? {} : { runId: activeRun.id }),
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment })
    };
    const launchRequest = mode === "new"
      ? { ...common, mode: "new" as const }
      : {
          ...common,
          mode: "resume" as const,
          nativeSessionId: session!.nativeSessionId
        };
    const assertCurrent = () => assertRuntimeLaunchRequestCurrent(store, launchRequest);
    const runtimeBinding = await launchCoordinator.prepare(
      launchRequest,
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

function resolveRuntimeDesiredEffective(
  store: TaskStore,
  request: EnsureRoleSessionRequest,
  role: Role | GlobalRole
): EffectiveLaunchSnapshot {
  if (request.scope === "global") {
    return resolveEffectiveLaunch({
      role: role as GlobalRole,
      purpose: "execution"
    });
  }
  const taskRole = role as Role;
  const item = store.listWorkItems(request.taskId).find((candidate) => (
    candidate.assignee === request.roleName
      && !["completed", "failed", "retired"].includes(candidate.status)
  )) ?? null;
  const workspace = (item === null
    ? store.getTaskWorkspace(request.taskId)
    : store.getWorkItemWorkspace(request.taskId, item.id))
    ?? store.getTaskWorkspace(request.taskId)
    ?? undefined;
  return resolveEffectiveLaunch({
    role: taskRole,
    purpose: "execution",
    ...(workspace === undefined ? {} : { workspace }),
    ...(item === null ? {} : { workItemWriteProjectIds: item.writeProjectIds })
  });
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
  const sessions = request.owner.scope === "task"
    ? store.getTaskRoleSessionSet(request.owner.taskId, request.owner.roleName)
    : store.getGlobalRoleSessionSet(request.owner.roleName);
  const expectedEffective = request.owner.scope === "task" && request.runId !== undefined
    ? activeRun?.effective
    : activeLiveRoleAgentSession(sessions)?.effective
      ?? currentDesiredEffective(store, request, role);
  if (
    expectedEffective === undefined
    || !isDeepStrictEqual(expectedEffective, request.effective)
    || request.effective.agentId !== request.agentId
    || request.effective.adapterId !== request.adapterId
    || request.effective.workspace.root !== request.workspace
  ) {
    throw new Error(`Role launch state changed: ${request.owner.roleName}.`);
  }
  if (request.owner.scope === "task" && request.managedWorkspace !== undefined) {
    const expectedWorkspace = activeRun?.workspace
      ?? currentDesiredManagedWorkspace(
        store,
        request.owner.taskId,
        request.owner.roleName
      );
    if (!isDeepStrictEqual(expectedWorkspace, request.managedWorkspace)) {
      throw new Error(
        `Managed workspace launch state changed: ${request.owner.roleName}.`
      );
    }
  }
  const binding = role.agentBindings[request.agentId];
  if (binding === undefined || binding.adapterId !== request.adapterId) {
    throw new Error(`Role effective binding changed: ${request.owner.roleName}.`);
  }
  const agent = store.getConfiguredAgent(request.agentId);
  if (agent === null || agent.adapterId !== request.adapterId) {
    throw new Error(`Agent launch state changed: ${request.agentId}.`);
  }
  if (request.mode === "resume") {
    const session = request.owner.scope === "task"
      ? store.getTaskRoleSessionSet(request.owner.taskId, request.owner.roleName)
        ?.sessions[request.agentId]
      : store.getGlobalRoleSessionSet(request.owner.roleName)
        ?.sessions[request.agentId];
    if (session === null || session === undefined
      || session.nativeSessionId !== request.nativeSessionId) {
      throw new Error(`Native session changed: ${request.owner.roleName}.`);
    }
    const sessionEffectiveCompatible = request.owner.scope === "task"
      ? effectiveLaunchSnapshotsCompatibleForTaskMain(
          session.effective,
          request.effective,
          request.managedWorkspace
        )
      : effectiveLaunchSnapshotsCompatible(session.effective, request.effective);
    if (!sessionEffectiveCompatible) {
      throw new Error(`Native session effective launch changed: ${request.owner.roleName}.`);
    }
  }
}

function currentDesiredEffective(
  store: TaskStore,
  request: CoordinatedRuntimeLaunchRequest,
  role: Role | GlobalRole
): EffectiveLaunchSnapshot {
  if (request.owner.scope === "global") {
    return resolveEffectiveLaunch({ role: role as GlobalRole, purpose: "execution" });
  }
  const item = store.listWorkItems(request.owner.taskId).find((candidate) => (
    candidate.assignee === request.owner.roleName
      && !["completed", "failed", "retired"].includes(candidate.status)
  )) ?? null;
  const workspace = (item === null
    ? store.getTaskWorkspace(request.owner.taskId)
    : store.getWorkItemWorkspace(request.owner.taskId, item.id))
    ?? store.getTaskWorkspace(request.owner.taskId)
    ?? undefined;
  return resolveEffectiveLaunch({
    role: role as Role,
    purpose: "execution",
    ...(workspace === undefined ? {} : { workspace }),
    ...(item === null ? {} : { workItemWriteProjectIds: item.writeProjectIds })
  });
}

function runtimeLaunchFingerprint(
  store: TaskStore,
  request: CoordinatedRuntimeLaunchRequest
): string {
  const agent = store.getConfiguredAgent(request.effective.agentId);
  if (agent === null) {
    throw new Error(`Agent no longer exists: ${request.effective.agentId}.`);
  }
  return createHash("sha256").update(JSON.stringify([
    request.owner,
    request.effective,
    request.managedWorkspace,
    request.runtimePolicy,
    agent
  ])).digest("hex");
}

function currentDesiredManagedWorkspace(
  store: TaskStore,
  taskId: string,
  roleName: string
) {
  const item = store.listWorkItems(taskId).find((candidate) => (
    candidate.assignee === roleName
      && !["completed", "failed", "retired"].includes(candidate.status)
  )) ?? null;
  return (item === null
    ? store.getTaskWorkspace(taskId)
    : store.getWorkItemWorkspace(taskId, item.id))
    ?? store.getTaskWorkspace(taskId)
    ?? undefined;
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
