import {
  reconciliationIntervalMilliseconds,
  resolveAgentLaunchInactivityTimeoutSeconds,
  resolveControllerTaskConcurrency,
  resolveDeliveryTimeoutSeconds,
  resolveRuntimeHealth,
  resolveTmuxBin,
  resolveTmuxHistoryLimit
} from "../config/yuiConfig.js";
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
  effectiveLaunchSnapshotsCompatibleForTaskSession,
  effectiveLaunchConfig,
  resolveEffectiveLaunch,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import {
  AgentConfigurationCatalogService,
  validateAgentLaunchConfiguration
} from "../executor/agentConfigurationCatalog.js";
import {
  isTaskOwnedWorkspace,
  managedWorkspaceIdentity,
  sameManagedWorkspaceIdentity
} from "../worktree/managedWorkspace.js";
import { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import type { TaskStore } from "../storage/taskStore.js";
import { openCurrentTaskStore } from "../storage/currentTaskStore.js";
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
  AgentHostPromptPushAdapter,
  FileTaskRuntimeIsolation,
  TmuxSessionHost,
  type ActivePromptPushPort,
  type AgentEnvironmentRefreshPort,
  type RuntimeLaunchPreparationPort,
  ProviderContinuationReconciliationService,
  type ProviderContinuationMetadataPort,
  type TaskRuntimeIsolationPort,
  type TaskRuntimeLifecycleCleanupPort,
  type SessionHostPort
} from "../runtime/index.js";
import {
  startFileTaskController,
  type ControllerRuntimeOptions,
  type RunningFileTaskController
} from "./controller.js";
import {
  AgentHostProviderTurnFenceError,
  FileSchedulerStoreAdapter
} from "./fileSchedulerStoreAdapter.js";
import { openSchedulerTelemetry } from "../telemetry/telemetryWiring.js";
import {
  createFileArtifactPort,
  createLinuxProcessPort,
  DurableJobSupervisor
} from "./jobSupervisor.js";
import { createDurableJobControl } from "./jobControl.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import { AgentRuntimeObserver } from "./agentRuntimeObserver.js";
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
import { launchBrokerForHome } from "../runtime/launchBroker.js";
import {
  classifyRuntimeProcessExit,
  validateRuntimeProcessExitObservation
} from "../runtime/processExitObservation.js";
import { replayRuntimeProcessExitOutbox } from "../runtime/processExitOutbox.js";
import { appendGlobalProcessExitObservation } from "../runtime/globalProcessExitStore.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import {
  createRuntimeObservation,
  runtimeObservationFromTaskEvent
} from "../runtime/runtimeObservation.js";
import { createTaskEvent } from "../event/taskEvent.js";

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
  catalogs?: AgentConfigurationCatalogService;
  /** Optional Adapter metadata query; never grants model/launch authority. */
  continuationMetadata?: ProviderContinuationMetadataPort;
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
  store: Pick<TaskStore, "getTurn" | "getTaskRoleSessionSet">,
  planner: Pick<FileRoleLaunchPlanner, "refreshTaskRuntimeDescriptor">,
  input: TaskRuntimeAppliedInput
): void {
  if (input.launchId === undefined) return;
  const run = input.turnId === undefined
    ? null
    : store.getTurn(input.taskId, input.turnId);
  if (input.turnId !== undefined && run === null) {
    throw new Error("Prepared Task runtime generation is not current.");
  }
  // A terminal completion has already settled this exact Turn and no later
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

/** Production composition root for the current SQLite TaskStore + tmux Controller. */
export async function startFileTaskControllerRuntime(
  home: string,
  options: FileTaskControllerFactoryOptions = {}
): Promise<RunningFileTaskControllerRuntime> {
  // The current Home always uses SQLite. The persistence worker is enabled by
  // default; YUI_STORE_WORKER=0/false keeps the same database in-process.
  const useWorker = resolveStoreWorkerEnabledForHome(
    home,
    options.environment ?? process.env
  );
  const store = options.store
    ?? (useWorker
      // The worker owns the event-processing hot path while the scheduler uses
      // the synchronous connection. Both point at the same WAL database and
      // serialize via BEGIN IMMEDIATE + busy_timeout.
      ? new SqliteTaskStore(home)
      : openCurrentTaskStore(home));
  const homeId = store.getHomeIdentity().homeId;
  const durableConfig = store.getConfig();
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
      openSchedulerTelemetry(home, store.getConfig())
    );
  const domainIdentity = options.domainIdentity
    ?? ephemeralDomainFromEnvironment(options.environment ?? process.env);
  const planner = options.planner ?? new FileRoleLaunchPlanner(home, store, {
    environment: options.environment
  });
  const tmux = options.tmux ?? new TmuxManager(
    resolveTmuxBin(durableConfig.tmuxBin),
    new NodeCommandExecutor(),
    {
      yuiHome: home,
      historyLimit: resolveTmuxHistoryLimit(durableConfig.tmuxHistoryLimit),
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
  // The runtime inbox is also the low-latency discovery source during a
  // scheduler-owned launch. Waiting only for the post-pass durable projection
  // would deadlock behind the same pass that is currently starting the host.
  const runtimeEventInbox = new FileRuntimeEventInbox(home);
  const catalogs = options.catalogs
    ?? new AgentConfigurationCatalogService(home, {
      environment: options.environment ?? process.env
    });
  const sessionHost = options.sessionHost ?? new TmuxSessionHost(planner, tmux, {
    validateLaunch: async (request) => {
      const agent = store.getConfiguredAgent(request.agentId);
      if (agent === null) return;
      const resolved = await catalogs.resolve({
        agent,
        cwd: request.workspace,
        config: effectiveLaunchConfig(request.effective)
      });
      validateAgentLaunchConfiguration(
        resolved.catalog,
        effectiveLaunchConfig(request.effective)
      );
    },
    waitForNativeSession: async (request, signal) => {
      const owner = request.owner;
      if (owner.scope !== "task") {
        throw new Error("Native session discovery requires a Task runtime owner.");
      }
      while (!signal.aborted) {
        const session = schedulerStore.getRoleSession(
          owner.taskId,
          owner.roleName,
          request.agentId
        );
        if (
          session !== null
          && session.launchId === request.launchId
          && typeof session.nativeSessionId === "string"
          && session.nativeSessionId.trim().length > 0
        ) {
          return session.nativeSessionId;
        }
        for (const event of runtimeEventInbox.list()) {
          if (
            event.type === "runtime-observation"
            && event.observation.kind === "session.started"
            && event.observation.fence.taskId === owner.taskId
            && event.observation.fence.roleName === owner.roleName
            && event.observation.fence.agentId === request.agentId
            && event.observation.fence.launchId === request.launchId
            && typeof event.observation.fence.nativeSessionId === "string"
            && event.observation.fence.nativeSessionId.trim().length > 0
          ) {
            return event.observation.fence.nativeSessionId;
          }
        }
        await abortableDelay(50, signal);
      }
      throw new Error("Native session discovery was aborted.");
    },
    inactivityTimeoutMs: resolveAgentLaunchInactivityTimeoutSeconds(
      durableConfig.agentLaunchInactivityTimeoutSeconds
    ) * 1_000,
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
    ?? new AgentHostPromptPushAdapter(home);
  const runtimeIsolation = options.runtimeIsolation
    ?? new FileTaskRuntimeIsolation({
      // A sibling of the exact control Home keeps provider data/cache/tmp out
      // of both the shared control plane and every managed Git workspace.
      runtimeRoot: `${resolve(home)}.task-runtimes`,
      controlPlane: {
        yuiHome: home,
        controllerSocketPath: controllerSocketPath(homeId),
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
  // One inventory scan per scheduler pass. When the inventory worker is active
  // the blocking /proc scan runs there; otherwise it runs on the main thread.
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
        tmuxBin: resolveTmuxBin(store.getConfig().tmuxBin),
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
          const identity = owner.turnId === undefined
            || owner.adapterId === undefined
            || (owner.nativeSessionId === undefined && owner.launchId === undefined)
            || (owner.nativeSessionId !== undefined && owner.nativeSessionId.trim().length === 0)
            || (owner.launchId !== undefined && owner.launchId.trim().length === 0)
            ? undefined
            : {
                taskId: owner.taskId,
                roleName: owner.roleName,
                turnId: owner.turnId,
                agentId: owner.agentId,
                adapterId: owner.adapterId,
                ...(owner.nativeSessionId === undefined
                  ? {}
                  : { nativeSessionId: owner.nativeSessionId }),
                ...(owner.launchId === undefined ? {} : { launchId: owner.launchId })
              };
          const changed = !active || input.turnId === undefined
            ? false
            : resourceActivity({
                taskId: input.taskId,
                roleName: input.roleName,
                turnId: input.turnId,
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
          tmuxBin: resolveTmuxBin(store.getConfig().tmuxBin),
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
  // Process-exit observations are persisted by the Agent Host before socket
  // delivery. Drain them while this Controller is still the only storage
  // writer and before it begins accepting new work after a handover.
  await replayRuntimeProcessExitOutbox(home, async (observation) => {
    await lifecycleDispatcher("runtime.process-exit-observe", observation);
  });
  // f7/rr5: This same inbox feeds the supervisor's terminal channel and the
  // runtime event processor. When a Job reaches a terminal state, the
  // supervisor enqueues a durable-job-terminal event; the processor drains it
  // on the next pass, waking the Controller immediately instead of waiting for
  // the poll interval.
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
  const continuationReconciler = options.continuationMetadata === undefined
    ? undefined
    : new ProviderContinuationReconciliationService(
        store,
        schedulerStore,
        options.continuationMetadata
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
      taskConcurrency: options.taskConcurrency
        ?? resolveControllerTaskConcurrency(durableConfig.controllerTaskConcurrency),
      deliveryRetryMs: options.deliveryRetryMs,
      deliveryRetryLimit: options.deliveryRetryLimit,
      deliveryTimeoutMs: options.deliveryTimeoutMs
        ?? resolveDeliveryTimeoutSeconds(durableConfig.deliveryTimeoutSeconds) * 1_000,
      stallWindowMs: options.stallWindowMs
        ?? resolveRuntimeHealth(durableConfig.runtimeHealth).stallWindowMs,
      diagnosticAfterMs: options.diagnosticAfterMs
        ?? resolveRuntimeHealth(durableConfig.runtimeHealth).diagnosticAfterMs,
      now: options.now,
      onError: options.onError,
      lifecycleHost,
      jobSupervisor,
      jobControl,
      ...(continuationReconciler === undefined ? {} : { continuationReconciler }),
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
      runtimeObserver: options.runtimeObserver
        ?? new AgentRuntimeObserver(store, runtimeEventInbox),
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
  let resourceClose: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    resourceClose ??= Promise.all([
      asyncStoreClient?.close() ?? Promise.resolve(),
      inventoryClient?.close() ?? Promise.resolve()
    ]).then(() => undefined);
    return resourceClose;
  };
  const closed = running.closed.then(closeResources);
  return {
    ...running,
    closed,
    close: async () => {
      try {
        await running.close();
      } finally {
        // RPC-driven Controller stops resolve `running.closed` without calling
        // this wrapper. Share one cleanup promise so both lifecycle paths
        // release the worker connections before the process can linger.
        await closeResources();
      }
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
    if (method === "runtime.observation-apply") {
      try {
        return {
          outcome: schedulerStore.observeRuntimeObservation(
            createRuntimeObservation(params as never),
            new Date()
          )
        };
      } catch (error) {
        throw applicationError(
          "INVALID_PARAMS",
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    if (method === "runtime.provider-turn-begin") {
      const value = providerTurnControlParams(params);
      try {
        schedulerStore.beginAgentHostProviderTurn({
          taskId: value.taskId,
          roleName: value.roleName,
          ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
          agentId: value.agentId,
          launchId: value.launchId,
          nativeSessionId: value.nativeSessionId,
          attemptId: value.attemptId,
          authorityEpoch: value.authorityEpoch,
          authorityOwner: value.authorityOwner,
          holderId: value.holderId,
          now: value.now
        });
      } catch (error) {
        if (error instanceof AgentHostProviderTurnFenceError) {
          throw applicationError("INVALID_PARAMS", error.message);
        }
        throw error;
      }
      return { recorded: true };
    }
    if (method === "runtime.provider-turn-submission-resolve") {
      const value = providerTurnControlParams(params);
      const status = (params as Record<string, unknown>).status;
      const reason = (params as Record<string, unknown>).reason;
      const raw = (params as Record<string, unknown>).raw;
      if ((status !== "rejected" && status !== "delivery-unknown")
        || typeof reason !== "string" || reason.trim().length === 0
        || typeof raw !== "string" || raw.trim().length === 0) {
        throw applicationError("INVALID_PARAMS", "Provider Turn resolution is invalid.");
      }
      schedulerStore.resolveAgentHostProviderTurnSubmission({
        taskId: value.taskId,
        roleName: value.roleName,
        ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
        attemptId: value.attemptId,
        status,
        reason,
        raw,
        now: value.now
      });
      return { recorded: true };
    }
    if (method === "runtime.process-exit-observe") {
      const observation = validateRuntimeProcessExitObservation(params as never);
      const run = observation.taskId === undefined || observation.turnId === undefined
        ? null
        : store.getTurn(observation.taskId, observation.turnId);
      const globalRole = observation.taskId === undefined
        ? store.getGlobalRole(observation.roleName)
        : null;
      const adapterId = run?.effective.adapterId
        ?? globalRole?.agentBindings[globalRole.activeAgentId]?.adapterId;
      const driver = adapterId === undefined
        ? null
        : builtinAgentDriverRegistry().findByAdapterId(adapterId);
      const turnTerminalObserved = observation.taskId !== undefined
        && observation.turnId !== undefined
        && store.listEvents(observation.taskId).some((event) => {
          const runtime = runtimeObservationFromTaskEvent(event);
          return runtime !== null
            && runtime.fence.turnId === observation.turnId
            && ["turn.completed", "turn.failed", "turn.cancelled"].includes(runtime.kind)
            && Date.parse(runtime.receivedAt) <= Date.parse(observation.observedAt);
        });
      const turnFailureObserved = observation.taskId !== undefined
        && observation.turnId !== undefined
        && store.listEvents(observation.taskId).some((event) => {
          const runtime = runtimeObservationFromTaskEvent(event);
          return runtime !== null
            && runtime.fence.turnId === observation.turnId
            && runtime.fence.launchId === observation.launchId
            && runtime.kind === "turn.failed"
            && Date.parse(runtime.receivedAt) <= Date.parse(observation.observedAt);
        });
      const classification = classifyRuntimeProcessExit(observation, {
        ...(driver === null
          ? {}
          : { childLifecycle: driver.capabilities.lifecycle.providerProcess }),
        turnTerminalObserved,
        turnFailureObserved
      });
      if (observation.taskId === undefined) {
        const recorded = appendGlobalProcessExitObservation(
          store.rootDirectory(),
          observation,
          classification
        );
        return { recorded, scope: "global", classification };
      }
      const recorded = store.transaction((tx) => {
        if (tx.getTask(observation.taskId!) === null) {
          throw applicationError("INVALID_PARAMS", `Task not found: ${observation.taskId}.`);
        }
        const duplicate = tx.listEvents(observation.taskId!).some((event) => (
          event.type === "runtime.process-exit-observed"
          && event.payload.observationId === observation.observationId
        ));
        if (duplicate) return false;
        tx.saveEvent(observation.taskId!, createTaskEvent(
          tx.nextEventId(observation.taskId!),
          observation.taskId!,
          "runtime.process-exit-observed",
          {
            observationId: observation.observationId,
            processKind: observation.processKind,
            roleName: observation.roleName,
            launchId: observation.launchId,
            observedAt: observation.observedAt,
            classification,
            observation: JSON.stringify(observation)
          },
          new Date(observation.observedAt)
        ));
        return true;
      });
      return { recorded, classification };
    }
    if (method === "runtime.launch-redeem") {
      if (params === null || typeof params !== "object" || Array.isArray(params)) {
        throw applicationError("INVALID_PARAMS", "Launch redemption params are invalid.");
      }
      const launchId = (params as Record<string, unknown>).launchId;
      const ticket = (params as Record<string, unknown>).ticket;
      const hostPid = (params as Record<string, unknown>).hostPid;
      if (typeof launchId !== "string" || typeof ticket !== "string"
        || !Number.isSafeInteger(hostPid) || (hostPid as number) <= 0) {
        throw applicationError("INVALID_PARAMS", "Launch redemption identity is invalid.");
      }
      // The launch payload is validated at reservation time and every member
      // of its discriminated Provider-control union is JSON serializable.
      return launchBrokerForHome(store.rootDirectory()).redeem(launchId, ticket) as unknown as JsonValue;
    }
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
    if (request.scope === "task"
      && (task?.status !== "active" || task.executionGate.state !== "enabled")) {
      throw applicationError(
        "INVALID_PARAMS",
        task === null
          ? `Task not found: ${request.taskId}.`
          : `Task execution is not enabled: ${request.taskId}.`
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
    const activeTurn = request.scope === "task"
      ? store.getActiveTurn(request.taskId, request.roleName)
      : null;
    if (request.scope === "task" && activeTurn === null) {
      throw applicationError(
        "INVALID_PARAMS",
        "Task Role runtime attachment requires an admitted active Turn; it cannot create an empty Provider Conversation."
      );
    }
    const managedWorkspace = request.scope === "task"
      ? activeTurn?.workspace
        ?? currentDesiredManagedWorkspace(store, request.taskId, request.roleName)
      : undefined;
    const sessions = request.scope === "task"
      ? store.getTaskRoleSessionSet(request.taskId, request.roleName)
      : store.getGlobalRoleSessionSet(request.roleName);
    const effective = activeTurn?.effective
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
    const session = sessions?.sessions[effective.agentId];
    // An ensure call may reattach the already-admitted Turn to its existing
    // Conversation, but it may not manufacture a fresh Conversation without a
    // pending managed Turn. Fresh replacement remains owned by Turn dispatch.
    const mode = activeTurn === null
      ? roleAgentSessionResumeMode(sessions, effective.agentId, effective)
      : session?.nativeSessionId === undefined ? activeTurn.mode : "resume";
    if (request.scope === "task" && mode === "resume"
      && (session?.nativeSessionId === undefined
        || session.nativeSessionId.trim().length === 0)) {
      throw applicationError(
        "INVALID_PARAMS",
        "Task Role runtime attachment cannot resume because its Provider Conversation identity is missing."
      );
    }
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
      ...(activeTurn === null ? {} : { turnId: activeTurn.id }),
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
  let activeTurn: ReturnType<TaskStore["getActiveTurn"]> = null;
  if (request.owner.scope === "task") {
    const task = store.getTask(request.owner.taskId);
    if (task === null
      || task.status !== "active"
      || task.executionGate.state !== "enabled") {
      throw new Error(`Task is no longer active: ${request.owner.taskId}.`);
    }
    activeTurn = store.getActiveTurn(
      request.owner.taskId,
      request.owner.roleName
    );
    if (
      request.turnId !== undefined
      && activeTurn?.id !== request.turnId
    ) {
      throw new Error(`Role Turn is no longer current: ${request.turnId}.`);
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
  const expectedEffective = request.owner.scope === "task" && request.turnId !== undefined
    ? activeTurn?.effective
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
    const expectedWorkspace = activeTurn?.workspace
      ?? currentDesiredManagedWorkspace(
        store,
        request.owner.taskId,
        request.owner.roleName
      );
    if (
      expectedWorkspace === undefined
      || !sameManagedWorkspaceIdentity(expectedWorkspace, request.managedWorkspace)
    ) {
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
      ? effectiveLaunchSnapshotsCompatibleForTaskSession(
          session.effective,
          request.effective
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
    request.managedWorkspace === undefined
      ? undefined
      : managedWorkspaceIdentity(request.managedWorkspace),
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

function providerTurnControlParams(params: JsonValue): Readonly<{
  taskId: string;
  roleName: string;
  turnId?: string;
  agentId: string;
  launchId: string;
  nativeSessionId: string;
  attemptId: string;
  authorityEpoch: number;
  authorityOwner: "controller" | "human";
  holderId: string;
  now: Date;
}> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw applicationError("INVALID_PARAMS", "Provider Turn control params are invalid.");
  }
  const value = params as Readonly<Record<string, JsonValue>>;
  const authorityEpoch = value.authorityEpoch;
  const authorityOwner = value.authorityOwner;
  const observedAt = requiredParam(value.observedAt);
  if (!Number.isSafeInteger(authorityEpoch) || (authorityEpoch as number) < 1
    || (authorityOwner !== "controller" && authorityOwner !== "human")
    || !Number.isFinite(Date.parse(observedAt))) {
    throw applicationError("INVALID_PARAMS", "Provider Turn control fence is invalid.");
  }
  return {
    taskId: requiredParam(value.taskId),
    roleName: requiredParam(value.roleName),
    ...(value.turnId === undefined ? {} : { turnId: requiredParam(value.turnId) }),
    agentId: requiredParam(value.agentId),
    launchId: requiredParam(value.launchId),
    nativeSessionId: requiredParam(value.nativeSessionId),
    attemptId: requiredParam(value.attemptId),
    authorityEpoch: authorityEpoch as number,
    authorityOwner,
    holderId: requiredParam(value.holderId),
    now: new Date(observedAt)
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Native session discovery was aborted."));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function applicationError(
  code: "INVALID_PARAMS" | "METHOD_NOT_FOUND",
  message: string
): Error {
  const error = Object.assign(new Error(message), { code });
  error.name = "CoreApplicationError";
  return error;
}
