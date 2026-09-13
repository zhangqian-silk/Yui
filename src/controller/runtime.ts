import {
  reconciliationIntervalMilliseconds,
  resolveAgentLaunchInactivityTimeoutSeconds,
  resolveControllerTaskConcurrency,
  resolveDeliveryTimeoutSeconds,
  resolveRuntimeHealth,
  resolveTmuxBin,
  resolveTmuxHistoryLimit
} from "../config/yuiConfig.js";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { controllerSocketPath } from "../core/controllerEndpoint.js";
import type { ControllerDispatcher } from "../core/controllerServer.js";
import type { JsonValue } from "../core/protocol.js";
import { type GlobalRole, type Role } from "../role/role.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import {
  AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
  NATIVE_AGENT_ENVIRONMENT_NAMES,
  nativeAgentEnvironmentNames,
  YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES
} from "../agent/launchEnvironment.js";
import {
  hasRuntimeCleanupObligation,
  runtimeLifecycleTarget
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
  roleSessionMayContinue,
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
  sameManagedWorkspaceIdentity
} from "../worktree/managedWorkspace.js";
import { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import type { TaskStore } from "../storage/taskStore.js";
import { openCurrentTaskStore } from "../storage/currentTaskStore.js";
import { managedRuntimeRoot } from "../storage/homeLayout.js";
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
  type SessionHostPort
} from "../runtime/index.js";
import {
  startFileTaskController,
  type ControllerRuntimeOptions,
  type RunningFileTaskController
} from "./controller.js";
import {
  AgentHostProviderTurnFenceError,
  AgentHostProviderSessionBusyError,
  FileSchedulerStoreAdapter
} from "./fileSchedulerStoreAdapter.js";
import { openSchedulerTelemetry } from "../telemetry/telemetryWiring.js";
import {
  createFileArtifactPort,
  createLinuxProcessPort,
  DurableJobSupervisor
} from "./jobSupervisor.js";
import { authorizeJobStart } from "./jobControl.js";
import { createKernelPorts } from "../kernel/kernelPorts.js";
import { createCapabilityDispatcher } from "./capabilityBridge.js";
import { createControllerWeb } from "../web/controllerWeb.js";
import { createWebTaskSurface } from "../web/webTaskSurface.js";
import { SurfaceContributions } from "../surface/surfaceContributions.js";
import { TmuxWebTerminalService } from "../web/tmuxWebTerminal.js";
import { FileTaskWorkflowRuntime } from "./clientRuntime.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import { AgentRuntimeObserver } from "./agentRuntimeObserver.js";
import {
  AsyncRuntimeEventProcessor,
  FileRuntimeEventProcessor,
  createAsyncRuntimeObserver
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
import { assertExecutionEnvironmentCurrent } from "../runtime/executionEnvironment.js";
import {
  classifyRuntimeProcessExit,
  validateRuntimeProcessExitObservation
} from "../runtime/processExitObservation.js";
import { replayRuntimeProcessExitOutbox } from "../runtime/processExitOutbox.js";
import { appendGlobalProcessExitObservation } from "../runtime/globalProcessExitStore.js";
import { deliverGlobalInputs } from "./globalInputDelivery.js";
import { providerRetryPrompt } from "../runtime/providerRetry.js";
import { createProviderRetryHooks } from "./providerRetryDelivery.js";
import { createGlobalRoleMessage } from "../message/message.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import {
  createRuntimeObservation,
  runtimeObservationFromTaskEvent
} from "../runtime/runtimeObservation.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { runPurposeAdmitsTaskState } from "../agentRun/agentRun.js";
import { taskOwnsManagedWorkspace } from "../task/task.js";

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
  runtimeIsolation?: TaskRuntimeIsolationPort;
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
  runtimeIsolation: TaskRuntimeIsolationPort;
  workspacePreparer: TaskWorkspacePreparer;
  kernel: ReturnType<typeof createKernelPorts>;
}>;

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
  const ownedStore = options.store === undefined
    ? (useWorker
      // The worker owns the event-processing hot path while the scheduler uses
      // the synchronous connection. Both point at the same WAL database and
      // serialize via BEGIN IMMEDIATE + busy_timeout.
      ? new SqliteTaskStore(home)
      : openCurrentTaskStore(home))
    : undefined;
  const store = options.store ?? ownedStore!;
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
  let closeKernel = async (): Promise<void> => {};
  let closeWeb = async (): Promise<void> => {};
  try {
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
      nativeConnection: (taskId, roleName) => planner.planNativeControl(taskId, roleName),
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
            session !== null && session.status === "active"
            && session.adapterId === request.adapterId
            && typeof session.nativeSessionId === "string" && session.nativeSessionId.trim().length > 0
          ) {
            return session.nativeSessionId;
          }
          for (const event of runtimeEventInbox.list()) {
            if (
              event.type === "runtime-observation" && event.observation.kind === "session.started"
              && event.observation.fence.taskId === owner.taskId
              && event.observation.fence.roleName === owner.roleName
              && event.observation.fence.agentId === request.agentId
              && event.observation.fence.runId === request.runId
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
        // Provider data/cache/tmp live in a dedicated Home partition. The
        // control boundary permits runtime roots to overlap only this exact
        // subtree, keeping them out of the database, managed Git workspaces and
        // every other part of the control plane.
        runtimeRoot: managedRuntimeRoot(home),
        controlPlane: {
          yuiHome: home,
          managedRuntimeRoot: managedRuntimeRoot(home),
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
                    .map(({ record, detail }) => `PID ${record.providerRoot.pid}: ${detail}`)
                    .join("; ")
                }`
              )
            );
          }
          return result.outcome === "stop-confirmed";
        });
      },
    };
    const resourceActivity = createRuntimeResourceActivityTracker();
    let runningRuntime: RunningFileTaskController["runtime"] | undefined;
    let runningController: RunningFileTaskController | undefined;
    const launchCoordinator = new RuntimeLaunchCoordinator(
      schedulerStore,
      sessionHost,
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        assertCurrent: (request) => {
          assertRuntimeLaunchRequestCurrent(store, request);
        },
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
        notifyOperatorInputOnce: async (input) => {
          // The original attention mailbox remains pending until this one
          // Global Message has an actual Provider receipt. Never inject keys
          // into a busy Host console and mistake that for accepted attention.
          const message = store.transaction(tx => {
            const requestId = `operator-notice:${encodeURIComponent(input.receiptId)}`;
            const previous = tx.listGlobalRoleMessages("operator").find(entry =>
              (entry.inputControl ?? entry.interruptThen?.reusedInput)?.requestId === requestId);
            if (previous !== undefined) return previous;
            const sessions = tx.getGlobalRoleSessionSet("operator");
            const session = sessions?.sessions[sessions.activeAgentId];
            if (session?.status !== "active" || sessions?.providerBinding == null) return null;
            const created = { ...createGlobalRoleMessage(tx.nextGlobalRoleMessageId(), "operator", input.text,
              "system", { type: "system" }, new Date(), { inputControl: { action: "queue", requestId } }),
              deliveryTarget: { agentId: session.agentId, nativeSessionId: session.nativeSessionId } };
            tx.saveGlobalRoleMessage(created);
            return created;
          });
          if (message === null) return "unavailable";
          if (message.delivery?.via === "provider") return "already-sent";
          runningRuntime?.signal("global-role:operator");
          return "not-ready";
        },
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
            const identity = owner.runId === undefined || owner.adapterId === undefined || (owner.nativeSessionId === undefined) || (owner.nativeSessionId !== undefined && owner.nativeSessionId.trim().length === 0)
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
    const kernel = createKernelPorts(store, createLinuxProcessPort(), (taskId) => {
      runningRuntime?.signal(`task:${taskId}`);
    });
    closeKernel = () => kernel.close();
    const webWorkflow = new FileTaskWorkflowRuntime(home, store, schedulerStore, planner, tmux, workspacePreparer, {
      environment: options.environment ?? process.env, onError: options.onError
    });
    const webSurface = createWebTaskSurface(store, { runtime: {
      notifyStateChanged: (taskId) => runningRuntime?.signal(`task:${taskId}`),
      notifyMailboxChanged: (target) => {
        if (target.kind === "role") runningRuntime?.signal(`role:${target.taskId}/${target.roleName}`);
        else if (target.kind === "task") runningRuntime?.signal(`task:${target.taskId}`);
      },
      reconcileTask: (taskId) => runningRuntime?.signal(`task:${taskId}`)
    }, yuiHome: home });
    const surfaces = new SurfaceContributions(kernel.capabilities.registry);
    const web = createControllerWeb(store, {
      surface: webSurface,
      answerInput: async ({ taskId, inputId, answer }) => webSurface.answer(taskId, inputId, answer),
      panels: {
        list: (taskId) => surfaces.listPanels(kernel.capabilities.authenticateWebQuery(taskId)),
        read: (taskId, ref, input) => surfaces.readPanel(kernel.capabilities.authenticateWebQuery(taskId), ref, input)
      },
      terminal: new TmuxWebTerminalService({
        yuiHome: home, tmuxBin: resolveTmuxBin(store.getConfig().tmuxBin), tmux,
        prepareGlobalRole: (roleName) => webWorkflow.prepareGlobalRoleEnter(roleName),
        environment: options.environment ?? process.env, onError: options.onError
      })
    });
    closeWeb = () => web.close();
    const jobSupervisor = new DurableJobSupervisor({
      store: schedulerStore,
      process: kernel.runner,
      artifacts: createFileArtifactPort(home),
      authorizeStart: (job) => authorizeJobStart(store, job),
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
    const jobControl = kernel.jobs;
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
      (method, params) => method === "web.start" || method === "web.stop" || method === "web.status"
        ? web.dispatch(method, params) : lifecycleDispatcher(method, params),
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
        providerRetry: createProviderRetryHooks(home, store, {
          now: options.now,
          onError: options.onError,
          snapshotTaskCandidate: async (run) => {
            if (run.purpose !== "review" || run.reviewRoundId === undefined) return undefined;
            const round = store.getReviewRound(run.taskId, run.reviewRoundId);
            if (round?.scope !== "task") return undefined;
            const task = store.getTask(run.taskId);
            const workspace = store.getTaskWorkspace(run.taskId);
            if (task === null || workspace === null || !(workspacePreparer instanceof FileTaskWorkspacePreparer)) {
              throw new Error("Task-final retry requires an observable authoritative Task workspace.");
            }
            const snapshot = await workspacePreparer.snapshotDirectTaskMain(
              workspace, task.projectBindings.map(p => p.projectId));
            return { schemaVersion: 1, projects: snapshot.projects.map(p => ({
              projectId: p.projectId, commit: p.headCommit
            })) };
          }
        }),
        jobSupervisor,
        globalInputDelivery: () => deliverGlobalInputs(home, store, async (roleName) => {
          await lifecycleDispatcher("runtime.ensure-role-session", { scope: "global", roleName });
        }, options.onError ?? (() => undefined)),
        jobControl,
        capabilityDispatcher: createCapabilityDispatcher(kernel.capabilities),
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
              )
            )
            : new FileRuntimeEventProcessor(runtimeEventInbox, schedulerStore)),
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
        web.close(),
        kernel.close(),
        asyncStoreClient?.close() ?? Promise.resolve(),
        inventoryClient?.close() ?? Promise.resolve()
      ]).then(() => undefined).finally(() => {
        ownedStore?.close();
      });
      return resourceClose;
    };
    const closed = running.closed.then(closeResources);
    return {
      ...running,
      kernel,
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
  } catch (error) {
    // The socket may never have opened. Startup failure must still release
    // this attempt's workers/instances instead of leaving an uncallable process.
    await Promise.allSettled([
      closeWeb(),
      closeKernel(),
      asyncStoreClient?.close() ?? Promise.resolve(),
      inventoryClient?.close() ?? Promise.resolve()
    ]);
    ownedStore?.close();
    throw error;
  }
}

export function createRuntimeLifecycleDispatcher(
  store: TaskStore,
  schedulerStore: FileSchedulerStoreAdapter,
  sessionHost: SessionHostPort,
  fallback?: ControllerDispatcher,
  sharedLaunchCoordinator?: RuntimeLaunchPreparationPort,
  environmentRefresher?: AgentEnvironmentRefreshPort
): ControllerDispatcher {
  const launchCoordinator = sharedLaunchCoordinator
    ?? new RuntimeLaunchCoordinator(schedulerStore, sessionHost, {
      assertCurrent: (request) => {
        assertRuntimeLaunchRequestCurrent(store, request);
      },
    });
  const lifecycleTails = new Map<string, Promise<void>>();
  return async (method, params) => {
    if (method === "runtime.host-observation-apply") {
      const id = (params as { eventId?: unknown }).eventId;
      if (typeof id !== "string") throw applicationError("INVALID_PARAMS", "Host event id is required.");
      // Eager delivery is only a hint about the exact immutable Inbox file.
      // Missing means the normal drainer has already committed and ACKed it.
      const event = new FileRuntimeEventInbox(store.rootDirectory()).read(id);
      if (event === null) return { outcome: "applied" };
      if (event.type !== "runtime-observation" || event.host === undefined) {
        throw applicationError("INVALID_PARAMS", "Expected an Agent Host observation.");
      }
      return { outcome: schedulerStore.observeAgentHostObservation(event, new Date()) };
    }
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
          ...(value.runId === undefined ? {} : { runId: value.runId }),
          agentId: value.agentId,
          nativeSessionId: value.nativeSessionId,
          attemptId: value.attemptId,
          authorityEpoch: value.authorityEpoch,
          authorityOwner: value.authorityOwner,
          holderId: value.holderId,
          boundedText: value.boundedText,
          retrySupported: value.retrySupported,
          now: value.now
        });
      } catch (error) {
        if (error instanceof AgentHostProviderSessionBusyError) throw error;
        if (error instanceof AgentHostProviderTurnFenceError) {
          throw applicationError("INVALID_PARAMS", error.message);
        }
        throw error;
      }
      const binding = (value.taskId === undefined
        ? store.getGlobalRoleSessionSet(value.roleName)
        : store.getTaskRoleSessionSet(value.taskId, value.roleName))?.providerBinding;
      const retry = binding?.retry;
      return { recorded: true, ...(retry?.currentAttemptId === value.attemptId && value.boundedText !== undefined
        ? { retryInput: {
            text: providerRetryPrompt(retry, value.boundedText),
            ...(retry.failedNativeTurnId === undefined ? {} : { expectedFailedNativeTurnId: retry.failedNativeTurnId })
          } } : {}) };
    }
    if (method === "runtime.provider-turn-submission-resolve") {
      const value = providerTurnControlParams(params);
      const status = (params as Record<string, unknown>).status;
      const reason = (params as Record<string, unknown>).reason;
      const raw = (params as Record<string, unknown>).raw;
      if ((status !== "rejected" && status !== "deferred" && status !== "delivery-unknown")
        || typeof reason !== "string" || reason.trim().length === 0
        || typeof raw !== "string" || raw.trim().length === 0) {
        throw applicationError("INVALID_PARAMS", "Provider Turn resolution is invalid.");
      }
      schedulerStore.resolveAgentHostProviderTurnSubmission({
        taskId: value.taskId,
        roleName: value.roleName,
        ...(value.runId === undefined ? {} : { runId: value.runId }),
        attemptId: value.attemptId,
        status,
        reason,
        raw,
        noProviderWrite: (params as Record<string, unknown>).providerWrite === "not-issued",
        now: value.now
      });
      return { recorded: true };
    }
    if (method === "runtime.process-exit-observe") {
      const observation = validateRuntimeProcessExitObservation(params as never);
      const run = observation.taskId === undefined || observation.runId === undefined
        ? null
        : store.getRun(observation.taskId, observation.runId);
      const globalRole = observation.taskId === undefined
        ? store.getGlobalRole(observation.roleName)
        : null;
      const adapterId = run?.effective.adapterId
        ?? globalRole?.agentBindings[globalRole.activeAgentId]?.adapterId;
      const driver = adapterId === undefined
        ? null
        : builtinAgentDriverRegistry().findByAdapterId(adapterId);
      const runTerminalObserved = observation.taskId !== undefined
        && observation.runId !== undefined
        && store.listEvents(observation.taskId).some((event) => {
          const runtime = runtimeObservationFromTaskEvent(event);
          return runtime !== null
            && runtime.fence.runId === observation.runId
            && ["turn.completed", "turn.failed", "turn.cancelled"].includes(runtime.kind)
            && Date.parse(runtime.receivedAt) <= Date.parse(observation.observedAt);
        });
      const runFailureObserved = observation.taskId !== undefined && observation.runId !== undefined && store.listEvents(observation.taskId).some((event) => {
          const runtime = runtimeObservationFromTaskEvent(event);
          return runtime !== null
            && runtime.fence.runId === observation.runId
            && runtime.fence.nativeSessionId === observation.nativeSessionId
            && runtime.kind === "turn.failed"
            && Date.parse(runtime.receivedAt) <= Date.parse(observation.observedAt);
        });
      const classification = classifyRuntimeProcessExit(observation, {
        ...(driver === null
          ? {}
          : { childLifecycle: driver.capabilities.lifecycle.providerProcess }),
        runTerminalObserved,
        runFailureObserved
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
      const ticket = (params as Record<string, unknown>).ticket;
      const hostPid = (params as Record<string, unknown>).hostPid;
      if (typeof ticket !== "string" || !Number.isSafeInteger(hostPid) || (hostPid as number) <= 0) {
        throw applicationError("INVALID_PARAMS", "Launch redemption identity is invalid.");
      }
      // The launch payload is validated at reservation time and every member
      // of its discriminated Provider-control union is JSON serializable.
      const payload = launchBrokerForHome(store.rootDirectory()).redeem(ticket);
      if (payload.executionEnvironment !== undefined) {
        if (payload.environment.YUI_SESSION_SCOPE !== "task"
          || payload.environment.YUI_TASK_ID !== payload.executionEnvironment.taskId
          || payload.cwd !== payload.executionEnvironment.directory.path) {
          throw applicationError("INVALID_PARAMS", "Launch does not match its adopted execution environment.");
        }
        assertExecutionEnvironmentCurrent(store, payload.executionEnvironment.taskId, payload.executionEnvironment);
      }
      return payload as unknown as JsonValue;
    }
    if (method === "runtime.execution-environment-check") {
      const value = params as Record<string, unknown>;
      const { taskId, roleName, agentId, nativeSessionId, workspace } = value;
      if ([taskId, roleName, agentId, nativeSessionId, workspace].some(v => typeof v !== "string")) {
        throw applicationError("INVALID_PARAMS", "Exact Host execution identity is required.");
      }
      const sessions = store.getTaskRoleSessionSet(taskId as string, roleName as string);
      const session = sessions?.sessions[agentId as string];
      if (sessions?.activeAgentId !== agentId || session?.status !== "active"
        || session.nativeSessionId !== nativeSessionId
        || (session.effective.executionEnvironment?.directory.path ?? session.effective.workspace.root) !== workspace) {
        throw applicationError("INVALID_PARAMS", "Host no longer owns the current execution environment.");
      }
      if (session.effective.executionEnvironment !== undefined) {
        assertExecutionEnvironmentCurrent(store, taskId as string, session.effective.executionEnvironment);
      }
      return { current: true };
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
    // Resolve the admitted Turn first: its purpose decides which Task
    // lifecycle and workspace fences apply. A Draft Leader planning Turn runs
    // without a Task workspace; every delivery Turn keeps the full fence.
    const activeRun = request.scope === "task"
      ? store.getActiveRun(request.taskId, request.roleName)
      : null;
    if (request.scope === "task" && activeRun === null) {
      throw applicationError(
        "INVALID_PARAMS",
        "Task Role runtime attachment requires an admitted active Turn; it cannot create an empty Provider Conversation."
      );
    }
    if (request.scope === "task"
      && (task === null || !runPurposeAdmitsTaskState(activeRun!.purpose, task))) {
      throw applicationError(
        "INVALID_PARAMS",
        task === null
          ? `Task not found: ${request.taskId}.`
          : `Task execution is not enabled: ${request.taskId}.`
      );
    }
    const planningDraft = request.scope === "task"
      && activeRun?.purpose === "planning"
      && task?.status === "draft";
    // A Task activated with an empty environment plan owns no managed
    // workspace, so there is nothing to prove ready. Every Task that does own
    // one keeps the full ownership fence.
    if (request.scope === "task"
      && task !== null
      && !planningDraft
      && taskOwnsManagedWorkspace(task)) {
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
    const managedWorkspace = request.scope === "task"
      ? activeRun?.workspace
        ?? currentDesiredManagedWorkspace(store, request.taskId, request.roleName)
      : undefined;
    // Distinguish "this Task owns no workspace by design" from "the
    // authoritative workspace is missing". Only the former may launch without
    // one. Two cases qualify: an empty plan binding no Project, and a Draft
    // planning conversation, which may bind a Project but has not activated, so
    // no worktree exists or is owed. Without the planning term a Project-bound
    // Draft fails closed on a workspace activation was never asked to create.
    const workspaceFree = request.scope === "task"
      && managedWorkspace === undefined
      && task !== null
      && (planningDraft || !taskOwnsManagedWorkspace(task));
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
    const session = sessions?.sessions[effective.agentId];
    // An ensure call may reattach the already-admitted AgentRun to its existing
    // Conversation, but it may not manufacture a fresh Conversation without a
    // pending managed AgentRun. Fresh replacement remains owned by AgentRun dispatch.
    const mode = activeRun === null
      ? roleAgentSessionResumeMode(sessions, effective.agentId, effective)
      : session?.nativeSessionId === undefined ? activeRun.mode : "resume";
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
      ...(workspaceFree ? { workspaceFree: true as const } : {}),
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
      && !["accepted", "retired"].includes(candidate.status)
  )) ?? null;
  const workspace = (item === null
    ? store.getTaskWorkspace(request.taskId)
    : store.getWorkItemWorkspace(request.taskId, item.id))
    ?? store.getTaskWorkspace(request.taskId)
    ?? undefined;
  return resolveEffectiveLaunch({
    role: taskRole,
    purpose: store.getTask(request.taskId)?.status === "draft" && request.roleName === "leader"
      ? "planning" : "execution",
    ...(workspace === undefined ? {} : { workspace }),
    ...(item === null ? {} : { workItemWriteProjectIds: item.writeProjectIds })
  });
}

function assertRuntimeLaunchRequestCurrent(
  store: TaskStore,
  request: CoordinatedRuntimeLaunchRequest
): void {
  let activeRun: ReturnType<TaskStore["getActiveRun"]> = null;
  if (request.owner.scope === "task") {
    const task = store.getTask(request.owner.taskId);
    if (task === null) {
      throw new Error(`Task is no longer active: ${request.owner.taskId}.`);
    }
    activeRun = store.getActiveRun(
      request.owner.taskId,
      request.owner.roleName
    );
    const purpose = activeRun?.purpose
      ?? (task.status === "draft" && request.owner.roleName === "leader" ? "planning" : "execution");
    if (!runPurposeAdmitsTaskState(purpose, task)) {
      throw new Error(`Task is no longer active: ${request.owner.taskId}.`);
    }
    if (
      request.runId !== undefined
      && activeRun?.id !== request.runId
    ) {
      throw new Error(`Role AgentRun is no longer current: ${request.runId}.`);
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
    if (!roleSessionMayContinue(session.effective, request.effective)) {
      throw new Error(
        `Native session cannot continue under this launch: ${request.owner.roleName}.`
      );
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
      && !["accepted", "retired"].includes(candidate.status)
  )) ?? null;
  const workspace = (item === null
    ? store.getTaskWorkspace(request.owner.taskId)
    : store.getWorkItemWorkspace(request.owner.taskId, item.id))
    ?? store.getTaskWorkspace(request.owner.taskId)
    ?? undefined;
  return resolveEffectiveLaunch({
    role: role as Role,
    purpose: store.getTask(request.owner.taskId)?.status === "draft" && request.owner.roleName === "leader"
      ? "planning" : "execution",
    ...(workspace === undefined ? {} : { workspace }),
    ...(item === null ? {} : { workItemWriteProjectIds: item.writeProjectIds })
  });
}

function currentDesiredManagedWorkspace(
  store: TaskStore,
  taskId: string,
  roleName: string
) {
  const item = store.listWorkItems(taskId).find((candidate) => (
    candidate.assignee === roleName
      && !["accepted", "retired"].includes(candidate.status)
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
  const allowedNative = new Set<string>(NATIVE_AGENT_ENVIRONMENT_NAMES);
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
  taskId?: string;
  roleName: string;
  runId?: string;
  agentId: string;
  nativeSessionId: string;
  attemptId: string;
  authorityEpoch: number;
  authorityOwner: "controller" | "human";
  holderId: string;
  now: Date;
  boundedText?: string;
  retrySupported?: boolean;
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
    ...(value.taskId === undefined ? {} : { taskId: requiredParam(value.taskId) }),
    roleName: requiredParam(value.roleName),
    ...(value.runId === undefined ? {} : { runId: requiredParam(value.runId) }),
    agentId: requiredParam(value.agentId),
    nativeSessionId: requiredParam(value.nativeSessionId),
    attemptId: requiredParam(value.attemptId),
    authorityEpoch: authorityEpoch as number,
    authorityOwner,
    holderId: requiredParam(value.holderId),
    ...(value.boundedText === undefined ? {} : { boundedText: requiredParam(value.boundedText) }),
    ...(value.retrySupport === undefined ? {} : { retrySupported: value.retrySupport === "codex-failed-turn-v1" }),
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
