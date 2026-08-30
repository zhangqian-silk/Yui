import { reconciliationIntervalMilliseconds } from "../config/yuiConfig.js";
import {
  processLeaderWakeups,
  type LeaderWakeupProcessingResult
} from "../scheduler/leaderWakeupProcessor.js";
import {
  pendingWakeupsMatch,
  type PendingWakeup
} from "../scheduler/pendingWakeup.js";
import {
  processActiveRoleRunDeliveries,
  type ActiveRoleRunDeliveryResult
} from "../scheduler/activeRoleRunDelivery.js";
import {
  selectedActiveSchedulerTasks,
  selectedSchedulerRoles,
  selectedSchedulerTasks
} from "../scheduler/ports.js";
import type {
  AutoResolvedInput,
  RoleRunDeliveryFailurePersistence,
  SchedulerReconcileSelection,
  SchedulerRoleSession,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "../scheduler/ports.js";
import { reconcileExitedRoleRuns } from "../scheduler/roleRunLiveness.js";
import {
  DEFAULT_STALL_WINDOW_MS,
  DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS,
  reconcileStalledRoleRuns,
  type RoleRunResourceEvidence
} from "../scheduler/roleRunStall.js";
import { repairOrphanedActiveTasks } from "../scheduler/activeTaskProgress.js";
import {
  processOperatorInputNotifications,
  type OperatorInputNotificationResult
} from "../scheduler/operatorInputNotificationProcessor.js";
import {
  startControllerServer,
  type ControllerDispatcher,
  type RunningControllerServer
} from "../core/controllerServer.js";
import {
  monotonicMilliseconds,
  type ControllerEventLoopDelayMetrics,
  type ControllerRouteMetrics
} from "../core/controllerTelemetry.js";
import type { JsonValue } from "../core/protocol.js";
import type { TaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";
import { isProjectMaintenanceFenced } from "../repository/projectMaintenanceLock.js";
import { isHandoverLockHeld } from "../release/runtimeRelease.js";
import { KeyedWorkQueue } from "../coordination/keyedWorkQueue.js";
import { MailboxScheduler } from "../coordination/mailboxScheduler.js";
import { nearestDeadlineBatch } from "../coordination/deadlineScheduler.js";
import {
  mailboxHasWork,
  nextPendingBatch,
  type MailboxTarget,
  type ProcessingBatch,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import type { SessionHostPort } from "../runtime/ports.js";
import type {
  TaskRuntimeCleanupReason,
  TaskRuntimeLifecycleCleanupPort
} from "../runtime/taskRuntimeIsolation.js";
import { formatTaskRecordReference } from "../task/taskRecordReference.js";
import type {
  AsyncRuntimeEventProcessorPort,
  RuntimeEventDrainMetrics,
  RuntimeEventDrainResult,
  RuntimeEventProcessorPort
} from "./runtimeEventProcessor.js";
import type { EphemeralDomainIdentity } from "./domainIdentity.js";
import type { AgentRuntimeObserverPort } from "./agentRuntimeObserver.js";
import type { DurableJobControlPort } from "./jobControl.js";
import {
  parseDurableJobAcknowledgeParams,
  parseDurableJobCancelParams,
  parseDurableJobRefParams,
  parseDurableJobStartParams
} from "./jobControl.js";

const DEFAULT_RECONCILIATION_INTERVAL_MS = reconciliationIntervalMilliseconds();
const DEFAULT_SIGNAL_WINDOW_MS = 100;
const DEFAULT_RUNTIME_OBSERVER_INTERVAL_MS = 1_000;
const DEFAULT_DELIVERY_RETRY_MS = 250;
const DEFAULT_DELIVERY_RETRY_LIMIT = 60;
const DEFAULT_DELIVERY_TIMEOUT_MS = 120_000;
const DEFAULT_TASK_ORCHESTRATION_RETRY_LIMIT = 2;
const DEFAULT_TASK_CONCURRENCY = 4;
const MAX_TASK_CONCURRENCY = 32;
const RUNTIME_RESERVATION_RECOVERY_AGE_MS = 120_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CONTROLLER_LATENCY_BUCKETS_MS = [10, 50, 100, 250, 500, 1_000, 3_000] as const;

class RuntimeEventApplyError extends AggregateError {}

type RuntimeLifecycleHost = Pick<
  SessionHostPort,
  "inspectOwner" | "inspectOwners" | "stopOwner"
> & Partial<TaskRuntimeLifecycleCleanupPort>;

type RoleRunDeliveryFailureIdentity = Omit<
  RoleRunDeliveryFailurePersistence,
  "now"
>;

export type ControllerSchedulerResult = Readonly<{
  activeRunDeliveries: readonly ActiveRoleRunDeliveryResult[];
  failedRunRefs: readonly string[];
  wakeups: readonly LeaderWakeupProcessingResult[];
  inputNotifications: readonly OperatorInputNotificationResult[];
  autoResolvedInputs: readonly AutoResolvedInput[];
}>;

export type ControllerRuntimeOptions = Readonly<{
  intervalMs?: number;
  signalWindowMs?: number;
  taskConcurrency?: number;
  deliveryRetryMs?: number;
  deliveryRetryLimit?: number;
  deliveryTimeoutMs?: number;
  taskOrchestrationRetryLimit?: number;
  stallWindowMs?: number;
  diagnosticAfterMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  workspacePreparer?: Pick<TaskWorkspacePreparer, "prepareTaskWorkspace">;
  runtimeEventProcessor?: RuntimeEventProcessorPort | AsyncRuntimeEventProcessorPort;
  runtimeObserver?: AgentRuntimeObserverPort;
  runtimeObserverIntervalMs?: number;
  lifecycleHost?: RuntimeLifecycleHost;
  configuration?: ControllerConfigurationPort;
  domainIdentity?: EphemeralDomainIdentity;
  resourceReaper?: () => Promise<Readonly<{
    cleaned: number;
    failed: readonly Readonly<{ id: string; message: string }>[];
    expiredDomains?: readonly Readonly<{ yuiHome: string; token?: string }>[];
  }>>;
  /**
   * Issue 10: optional automatic Resource GC hook, invoked once per full
   * reconciliation pass after the scheduler pass settles. The production
   * runner self-skips unless `resourcesGcMode=quarantine` and
   * `resourcesGcAutoQuarantine=true`; errors are routed to `onError` and
   * never break the scheduler.
   */
  resourceAutoGc?: () => Promise<Readonly<{
    skipped: boolean;
    applied: number;
    failed: number;
    restored: number;
  }>>;
  onExpiredEphemeralDomain?:
    (domain: Readonly<{ yuiHome: string; token?: string }>) => void;
  /**
   * Per-Project maintenance fence consulted before preparing a Task's
   * workspaces: a Task whose Project is fenced is deferred for this pass
   * (never marked failed), so maintenance is never interleaved.
   */
  maintenanceFence?: (projectId: string) => boolean;
  /** Log hook invoked once per deferred Task with the fenced Project ids. */
  onMaintenanceFenceDefer?: (detail: Readonly<{
    taskId: string;
    projectIds: readonly string[];
  }>) => void;
  /** Suppresses new Leader dispatch while a release/rebind handover is live. */
  leaderWakeFence?: () => boolean;
  /**
   * Reconciles DurableJobs once per scheduler pass: spawns queued detached
   * runners, harvests terminal evidence, and enqueues Leader wakeups.
   */
  jobSupervisor?: Readonly<{ reconcile(now: Date): void }>;
  /** Metadata-only reconciliation of already-known detached provider work. */
  continuationReconciler?: Readonly<{
    reconcile(now: Date): Promise<readonly string[]>;
  }>;
  /** Serves the socket `job.*` methods; absent methods report METHOD_NOT_FOUND. */
  jobControl?: DurableJobControlPort;
}>;

export interface ControllerConfigurationPort {
  reconciliationIntervalMs(): number;
}

export type MailboxKey =
  | `task:${string}`
  | `role:${string}/${string}`
  | `global-role:${string}`
  | "operator";

export type ReconcileScope =
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "dirty"; keys: readonly MailboxKey[] }>;

export type ReconcileSelection = SchedulerReconcileSelection;

type DirtyTaskReconcileScope = Readonly<{
  taskId: string;
  keys: readonly MailboxKey[];
}>;

type DirtyScopePartition = Readonly<{
  taskScopes: readonly DirtyTaskReconcileScope[];
  globalKeys: readonly MailboxKey[];
}>;

type DirtySchedulerPassResult = Readonly<{
  result: ControllerSchedulerResult;
  failedTaskScopes: readonly DirtyTaskReconcileScope[];
}>;

export type RunningFileTaskController = Readonly<{
  runtime: FileTaskController;
  server: RunningControllerServer;
  closed: Promise<void>;
  close(): Promise<void>;
}>;

export type ControllerRuntimeMetrics = Readonly<{
  inbox: Readonly<{
    depth: number;
    semanticDepth: number;
    progressDepth: number;
  }>;
  drain: Readonly<{
    passes: number;
    listedEvents: number;
    selectedEvents: number;
    progressEventsCoalesced: number;
    stateTransactions: number;
  }>;
  commands: Readonly<{
    // Dispatcher service time only: measured inside the FileTask dispatcher
    // from dispatch to completion. It does not include the socket/event-loop
    // wait before routing, so it must not be read as end-to-end latency.
    dispatcher: Readonly<{
      completed: number;
      inFlight: number;
      maximumServiceTimeMs: number;
      serviceTimeBuckets: Readonly<Record<string, number>>;
    }>;
    // Core routing observation: every authenticated request counted once at
    // the routing layer, covering built-in and dispatcher routes.
    routes: ControllerRouteMetrics;
    // Bounded event-loop delay sampled by the core server: the pre-dispatch
    // wait an already-written request experiences while the loop is busy.
    eventLoopDelay: ControllerEventLoopDelayMetrics;
  }>;
}>;

const ZERO_DRAIN_METRICS: RuntimeEventDrainMetrics = Object.freeze({
  listedEventCount: 0,
  selectedEventCount: 0,
  semanticEventsSelected: 0,
  progressEventsSelected: 0,
  progressEventsCoalesced: 0,
  stateTransactions: 0,
  remainingSemanticEventCount: 0,
  remainingProgressEventCount: 0
});

/**
 * Runs one lean scheduler pass. Due native Turn completions are folded before
 * liveness, so a valid Hook boundary fences destructive process reconciliation.
 */
export async function runControllerSchedulerPass(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  workspacePreparer?: Pick<TaskWorkspacePreparer, "prepareTaskWorkspace">,
  scope: ReconcileScope = { kind: "full" },
  includeOperator = true,
  runtimeCleanupOutcomes: RuntimeCleanupOutcome[] = [],
  lifecycleHost?: RuntimeLifecycleHost,
  stallWindowMs = DEFAULT_STALL_WINDOW_MS,
  maintenanceFence?: (projectId: string) => boolean,
  onMaintenanceFenceDefer?: ControllerRuntimeOptions["onMaintenanceFenceDefer"],
  blockedTaskIds: ReadonlySet<string> = new Set(),
  inputDeliveryRecoveryCutoff?: Date,
  diagnosticAfterMs = DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS,
  leaderWakeFence?: () => boolean
): Promise<ControllerSchedulerResult> {
  const compiledSelection = compileReconcileSelection(scope);
  const selection = includeOperator
    ? { ...compiledSelection, blockedTaskIds }
    : { ...compiledSelection, operator: false, blockedTaskIds };
  queueSelectedCompletedTaskRuntimeCleanups(store, selection, now);
  // A full-state Task projection can be individually bounded yet still starve
  // control sockets when several scheduler phases repeat it in one native
  // event-loop turn. Give already-written requests a poll boundary before the
  // next durable phase; later phases retain their existing CAS fences.
  await controlEventLoopTurn();
  const failedCleanupRoles = await processSelectedRoleRuntimeCleanups(
    store,
    delivery,
    lifecycleHost,
    scope,
    now,
    runtimeCleanupOutcomes,
    blockedTaskIds
  );
  const roleSelection = selectionWithoutFailedCleanupRoles(
    store,
    selection,
    failedCleanupRoles
  );
  const availableWakeupSelection = (): SchedulerReconcileSelection => (
    leaderWakeFence?.() === true
      ? exactTaskSelection(new Set())
      : selectionWithoutFailedLeaderCleanupTasks(
          store,
          selection,
          failedCleanupRoles
        )
  );
  if (selection.full) repairOrphanedActiveTasks(store, now, selection);
  const claimedTaskMailboxes = claimSelectedTaskMailboxes(store, selection, now);
  try {
    // Durable Leader work that already has a ready Task workspace belongs to
    // the control path. Dispatch it before any unrelated Task workspace I/O;
    // the processor itself retains the fail-closed workspace-ready guard.
    const initialWakeups = selectedPendingWakeups(store, availableWakeupSelection());
    const initialWakeupResults = await processLeaderWakeups(
      store,
      delivery,
      now,
      exactTaskSelection(new Set(initialWakeups.keys()))
    );
    // Preserve ready-Leader-first ordering, then bound the repeated state
    // projections that follow it in this pass.
    await controlEventLoopTurn();
    const workspacePreparation = await prepareActiveWorkspaces(
      store,
      workspacePreparer,
      selection,
      maintenanceFence,
      onMaintenanceFenceDefer
    );
    await controlEventLoopTurn();
    // Issue 04: reopen due in-place Provider retries on their original
    // Sessions before delivery, so the existing delivery path re-pushes the
    // exact same input in this same pass.
    resolveDueProviderRetries(store, roleSelection, now);
    const activeRunDeliveries = await processActiveRoleRunDeliveries(
      store, delivery, now, roleSelection, inputDeliveryRecoveryCutoff
    );
    await controlEventLoopTurn();
    const unsettledRunRefs = new Set(activeRunDeliveries.flatMap((result) => (
      result.reason === "delivery-uncertain" || result.terminalFailure !== undefined
        ? [formatTaskRecordReference(result.taskId, result.runId, "agentRun")]
        : []
    )));
    // Every successful Task has completed the targeted phases owned by its
    // mailbox at this boundary. Settle that exact claim before advisory
    // cross-Task reconciliation so an unrelated failure cannot retain and
    // retry already-progressed work.
    for (const claim of claimedTaskMailboxes) {
      if (!workspacePreparation.failed.has(claim.target.taskId)) {
        store.completeWorkMailbox(claim.target, claim.processing.batchId);
      }
    }
    const newlyIdleBusyTaskIds = new Set(initialWakeupResults.flatMap((result) => (
      result.reason === "busy"
        && store.getActiveAgentRun(result.taskId, "leader") === null
        && (
          typeof store.hasInFlightTurn !== "function"
          || !store.hasInFlightTurn(result.taskId, "leader")
        )
        ? [result.taskId]
        : []
    )));
    // Phase-one Leader Runs did not exist at the pass's liveness boundary.
    // Keep every newly claimed Run outside destructive absence decisions until
    // a later pass can observe its stable provider/session generation.
    for (const result of initialWakeupResults) {
      if (
        result.runId !== undefined
        && store.getActiveAgentRun(result.taskId, "leader")?.id === result.runId
      ) {
        unsettledRunRefs.add(
          formatTaskRecordReference(result.taskId, result.runId, "agentRun")
        );
      }
    }
    // Let socket callbacks queued during the bounded scheduler phases run
    // before starting a potentially large liveness inventory.
    await controlEventLoopTurn();
    const liveStatuses = new Map<string, "present" | "absent">();
    const resourceEvidence = new Map<string, RoleRunResourceEvidence>();
    const failedRunRefs = await reconcileExitedRoleRuns(
      store,
      delivery,
      now,
      roleSelection,
      unsettledRunRefs,
      liveStatuses,
      resourceEvidence,
      scope.kind === "dirty"
    );
    await controlEventLoopTurn();
    await reconcileStalledRoleRuns(
      store,
      delivery,
      now,
      roleSelection,
      stallWindowMs,
      liveStatuses,
      resourceEvidence,
      diagnosticAfterMs
    );
    await controlEventLoopTurn();
    await reconcileDormantRuntimeOwners(
      store,
      delivery,
      lifecycleHost,
      scope,
      now,
      selection.blockedTaskIds
    );
    const selectedInputTaskIds = selectedTaskIdsForBoundedPass(store, selection);
    const autoResolvedInputs = selectedInputTaskIds === undefined
      ? store.resolveExpiredInputRecommendations(now)
      : selectedInputTaskIds.size === 0
        ? []
        : store.resolveExpiredInputRecommendations(now, selectedInputTaskIds);
    // Liveness and auto-resolution can durably queue new Leader work. Process
    // only Tasks that were not part of phase one, except when a same-pass due
    // completion made an initially busy Leader idle. Result order remains
    // deterministic and every other retained/busy wake stays single-shot.
    const autoResolvedTaskIds = new Set(autoResolvedInputs.map(({ taskId }) => taskId));
    const waitingInputTaskIds = new Set(initialWakeupResults.flatMap((result) => (
      result.reason === "waiting-input" && autoResolvedTaskIds.has(result.taskId)
        ? [result.taskId]
        : []
    )));
    const workspaceReadyTaskIds = new Set(initialWakeupResults.flatMap((result) => (
      result.reason === "workspace-not-ready"
        && workspacePreparation.ready.has(result.taskId)
        ? [result.taskId]
        : []
    )));
    const laterWakeupTaskIds = new Set(
      [...selectedPendingWakeups(store, availableWakeupSelection())]
        .flatMap(([taskId, wakeup]) => {
          const initial = initialWakeups.get(taskId);
          return initial === undefined
            || !pendingWakeupsMatch(initial, wakeup)
            || waitingInputTaskIds.has(taskId)
            || workspaceReadyTaskIds.has(taskId)
            || newlyIdleBusyTaskIds.has(taskId)
            ? [taskId]
            : [];
        })
    );
    const laterWakeups = await processLeaderWakeups(
      store,
      delivery,
      now,
      exactTaskSelection(laterWakeupTaskIds)
    );
    const inputNotifications = includeOperator
      ? await processOperatorInputNotifications(store, delivery, selection, now)
      : [];
    return {
      activeRunDeliveries,
      failedRunRefs,
      wakeups: mergeWakeupPhaseResults(initialWakeupResults, laterWakeups),
      inputNotifications,
      autoResolvedInputs
    };
  } catch (error) {
    // Task orchestration retries are owned by this Controller generation.
    // Preserve each exact processing claim in place; releasing here would
    // rewrite the full aggregate and then immediately claim the same batch.
    throw error;
  }
}

function selectedPendingWakeups(
  store: Pick<SchedulerStorePort, "getPendingWakeup" | "listPendingWakeups">,
  selection: SchedulerReconcileSelection
): Map<string, PendingWakeup> {
  const wakeups = selection.full
    ? store.listPendingWakeups().filter((wakeup) => (
        !selection.blockedTaskIds?.has(wakeup.taskId)
      ))
    : [...selection.taskIds].flatMap((taskId) => {
        if (selection.blockedTaskIds?.has(taskId)) return [];
        const wakeup = store.getPendingWakeup(taskId);
        return wakeup === null ? [] : [wakeup];
      });
  return new Map(wakeups.map((wakeup) => [
    wakeup.taskId,
    { ...wakeup, reasons: [...wakeup.reasons] }
  ]));
}

function exactTaskSelection(taskIds: ReadonlySet<string>): SchedulerReconcileSelection {
  return {
    full: false,
    taskIds,
    allRoleTaskIds: new Set(),
    rolesByTask: new Map(),
    operator: false,
    blockedTaskIds: new Set()
  };
}

function mergeWakeupPhaseResults(
  initial: readonly LeaderWakeupProcessingResult[],
  later: readonly LeaderWakeupProcessingResult[]
): LeaderWakeupProcessingResult[] {
  const merged = [...initial];
  const positions = new Map(initial.map(({ taskId }, index) => [taskId, index]));
  for (const result of later) {
    const position = positions.get(result.taskId);
    if (position === undefined) {
      positions.set(result.taskId, merged.length);
      merged.push(result);
    } else {
      merged[position] = result;
    }
  }
  return merged;
}

type ClaimedTaskMailbox = Readonly<{
  target: Extract<MailboxTarget, { kind: "task" }>;
  processing: ProcessingBatch;
}>;

type RuntimeCleanupOutcome = Readonly<{
  target: RuntimeLifecycleTarget;
  batchId: string;
  status: "completed" | "failed";
  error?: unknown;
}>;

function queueSelectedCompletedTaskRuntimeCleanups(
  store: SchedulerStorePort,
  selection: ReconcileSelection,
  now: Date
): void {
  if (store.enqueueRuntimeCleanup === undefined) return;
  if (selection.full && store.listRuntimeSessionCandidates !== undefined) {
    for (const candidate of store.listRuntimeSessionCandidates({
      cleanupRequiredOnly: true
    })) {
      if (
        candidate.owner.scope !== "task"
        || !candidate.cleanupRequired
        || selection.blockedTaskIds?.has(candidate.owner.taskId)
      ) {
        continue;
      }
      const { taskId, roleName } = candidate.owner;
      if (store.getTask(taskId)?.status !== "completed") continue;
      if (store.getActiveAgentRun(taskId, roleName) !== null) continue;
      const target = runtimeLifecycleTarget(candidate.owner);
      if (hasRuntimeCleanupObligation(store.getWorkMailbox(target))) continue;
      store.enqueueRuntimeCleanup(candidate.owner, now);
    }
    return;
  }
  for (const task of selectedSchedulerTasks(store, selection)) {
    if (task.status !== "completed") continue;
    for (const role of selectedSchedulerRoles(store, task.id, selection)) {
      if (store.getActiveAgentRun(task.id, role.name) !== null) continue;
      const session = store.getRoleSession(task.id, role.name);
      if (!schedulerSessionRequiresRuntimeCleanup(session)) continue;
      const target = runtimeLifecycleTarget({
        scope: "task",
        taskId: task.id,
        roleName: role.name
      });
      if (hasRuntimeCleanupObligation(store.getWorkMailbox(target))) continue;
      store.enqueueRuntimeCleanup({
        scope: "task",
        taskId: task.id,
        roleName: role.name
      }, now);
    }
  }
}

function schedulerSessionRequiresRuntimeCleanup(
  session: SchedulerRoleSession | null
): boolean {
  if (session === null || session.status === "stopped" || session.status === "broken") {
    return false;
  }
  return session.status === "running" || session.launchId !== undefined;
}

async function processSelectedRoleRuntimeCleanups(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  lifecycleHost: RuntimeLifecycleHost | undefined,
  scope: ReconcileScope,
  now: Date,
  outcomes: RuntimeCleanupOutcome[],
  blockedTaskIds: ReadonlySet<string> = new Set()
): Promise<ReadonlySet<string>> {
  const targets = selectedRuntimeLifecycleTargets(store, scope, blockedTaskIds);
  const failedRoles = new Set<string>();
  for (const target of targets) {
    const mailbox = store.getWorkMailbox(target);
    if (mailbox === null) continue;
    const owner = runtimeOwner(target);
    const batchId = runtimeLifecycleBatchIdentity(target, mailbox);
    if (hasRuntimeCleanupObligation(mailbox)) {
      try {
        if (lifecycleHost === undefined) {
          throw new Error("Role runtime cleanup host is unavailable.");
        }
        if (!await lifecycleHost.stopOwner(owner)) {
          throw new Error(
            `Role runtime cleanup could not confirm the host stopped: ${runtimeOwnerLabel(owner)}.`
          );
        }
        if (target.kind === "role-runtime") {
          const session = store.getRoleSession(target.taskId, target.roleName);
          const reservedLaunchId = isRuntimeLaunchReservation(mailbox.processing)
            ? mailbox.processing!.batchId
            : undefined;
          // A failed fresh-Conversation launch can leave two exact resource
          // generations: the detached Session's last committed launch and the
          // replacement reservation. They are not competing authorities. The
          // owner-wide stop has already proven physical zero, so clean both
          // exact launch roots idempotently before settling the mailbox.
          const launchIds = new Set([
            reservedLaunchId,
            session?.launchId
          ].filter((launchId): launchId is string => launchId !== undefined));
          if (lifecycleHost.cleanupTaskLaunch !== undefined) {
            const task = store.getTask(target.taskId);
            const reason: TaskRuntimeCleanupReason = task?.status === "completed"
              ? "completion"
              : "interruption";
            for (const launchId of launchIds) {
              lifecycleHost.cleanupTaskLaunch({
                taskId: target.taskId,
                launchId,
                reason
              });
            }
          }
        }
        if (
          store.completeRuntimeCleanup === undefined
          || !store.completeRuntimeCleanup(target, now)
        ) {
          throw new Error(
            `Role runtime cleanup mailbox changed: ${runtimeOwnerLabel(owner)}.`
          );
        }
        forgetPreparedRuntimeOwner(delivery, owner);
        outcomes.push({ target, batchId, status: "completed" });
      } catch (error) {
        markFailedRuntimeTarget(failedRoles, target);
        outcomes.push({ target, batchId, status: "failed", error });
      }
      continue;
    }
    const reservation = mailbox.processing;
    if (
      reservation === null
      || !isRuntimeLaunchReservation(reservation)
      || now.getTime() - Date.parse(reservation.startedAt)
        < RUNTIME_RESERVATION_RECOVERY_AGE_MS
    ) {
      continue;
    }
    try {
      if (lifecycleHost === undefined) {
        throw new Error("Role runtime reservation inspection is unavailable.");
      }
      const inspection = await lifecycleHost.inspectOwner(owner);
      if (inspection.state === "running" || inspection.state === "starting") {
        continue;
      }
      if (inspection.state === "unavailable") {
        throw new Error(
          `Role runtime reservation could not inspect the host: ${runtimeOwnerLabel(owner)}.`
        );
      }
      const completed = store.completeStoppedRuntimeReservation === undefined
        ? store.completeWorkMailbox(target, reservation.batchId)
        : store.completeStoppedRuntimeReservation(
            target,
            reservation.batchId,
            now
          );
      if (!completed) {
        throw new Error(
          `Role runtime reservation mailbox changed: ${runtimeOwnerLabel(owner)}.`
        );
      }
      forgetPreparedRuntimeOwner(delivery, owner);
      outcomes.push({ target, batchId, status: "completed" });
    } catch (error) {
      markFailedRuntimeTarget(failedRoles, target);
      outcomes.push({ target, batchId, status: "failed", error });
    }
  }
  return failedRoles;
}

async function reconcileDormantRuntimeOwners(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  lifecycleHost: RuntimeLifecycleHost | undefined,
  scope: ReconcileScope,
  now: Date,
  blockedTaskIds: ReadonlySet<string> = new Set()
): Promise<void> {
  if (
    scope.kind !== "full"
    || lifecycleHost === undefined
    || store.listDormantRuntimeOwners === undefined
    || store.markRuntimeOwnerStopped === undefined
  ) {
    return;
  }
  const candidates = store.listDormantRuntimeOwners().filter((candidate) => (
    candidate.owner.scope !== "task"
    || !blockedTaskIds.has(candidate.owner.taskId)
  ));
  if (candidates.length === 0) return;
  const owners = candidates.map((candidate) => candidate.owner);
  let inspections: readonly Readonly<{
    owner: RuntimeRoleOwner;
    inspection: Awaited<ReturnType<SessionHostPort["inspectOwner"]>>;
  }>[];
  try {
    inspections = lifecycleHost.inspectOwners === undefined
      ? await Promise.all(owners.map(async (owner) => ({
          owner,
          inspection: await lifecycleHost.inspectOwner(owner)
        })))
      : await lifecycleHost.inspectOwners(owners);
  } catch {
    // Host inventory is an advisory safety scan. Unknown state must never
    // mutate persisted session facts; the next full pass will retry.
    return;
  }
  const requested = new Set(owners.map(runtimeOwnerIdentity));
  const byOwner = new Map<string, (typeof inspections)[number]["inspection"]>();
  for (const result of inspections) {
    const identity = runtimeOwnerIdentity(result.owner);
    if (
      !requested.has(identity)
      || byOwner.has(identity)
    ) {
      return;
    }
    byOwner.set(identity, result.inspection);
  }
  if (byOwner.size !== requested.size) return;
  for (const candidate of candidates) {
    if (
      byOwner.get(runtimeOwnerIdentity(candidate.owner))?.state
      === "stopped"
    ) {
      if (
        candidate.owner.scope === "task"
        && candidate.launchId !== undefined
      ) {
        // The exact launch-owned resources must settle through the durable
        // cleanup lane before its Session fact becomes stopped. The candidate
        // is passed back as the CAS fence so a concurrent Hook/launch cannot
        // redirect cleanup to a newer generation.
        store.enqueueRuntimeCleanup?.(candidate.owner, now, candidate);
        continue;
      }
      if (store.markRuntimeOwnerStopped(candidate, now)) {
        forgetPreparedRuntimeOwner(delivery, candidate.owner);
      }
    }
  }
}

function forgetPreparedRuntimeOwner(
  delivery: TmuxDeliveryPort,
  owner: RuntimeRoleOwner
): void {
  if (owner.scope !== "task") return;
  delivery.forgetPrepared?.({
    taskId: owner.taskId,
    roleName: owner.roleName
  });
}

function runtimeOwnerIdentity(owner: RuntimeRoleOwner): string {
  return owner.scope === "task"
    ? `task\0${owner.taskId}\0${owner.roleName}`
    : `global\0${owner.roleName}`;
}

/**
 * Issue 04: reopens due in-place Provider retries on their original Native
 * Sessions before the active-run delivery pass, so the existing delivery
 * path re-pushes the exact same input in the same pass. A Run whose Session
 * is proven dead terminalizes with a replacement blocker instead.
 */
function resolveDueProviderRetries(
  store: SchedulerStorePort,
  selection: ReconcileSelection,
  now: Date
): void {
  if (typeof store.resolveDueProviderRetries !== "function") return;
  const selectedTaskIds = selectedTaskIdsForBoundedPass(store, selection);
  if (selectedTaskIds?.size === 0) return;
  store.resolveDueProviderRetries(now, selectedTaskIds);
}

function selectedTaskIdsForBoundedPass(
  store: SchedulerStorePort,
  selection: ReconcileSelection
): ReadonlySet<string> | undefined {
  if (!selection.full) {
    if ((selection.blockedTaskIds?.size ?? 0) === 0) return selection.taskIds;
    return new Set([...selection.taskIds].filter((taskId) => (
      !selection.blockedTaskIds!.has(taskId)
    )));
  }
  if ((selection.blockedTaskIds?.size ?? 0) === 0) return undefined;
  return new Set(selectedActiveSchedulerTasks(store, selection).map((task) => task.id));
}

function selectedReadyWorkMailboxes(
  store: Pick<SchedulerStorePort, "listReadyWorkMailboxes" | "listWorkMailboxes">
): readonly WorkMailbox[] {
  return store.listReadyWorkMailboxes?.() ?? store.listWorkMailboxes();
}

function selectedRuntimeLifecycleTargets(
  store: SchedulerStorePort,
  scope: ReconcileScope,
  blockedTaskIds: ReadonlySet<string> = new Set()
): RuntimeLifecycleTarget[] {
  if (scope.kind === "full") {
    return selectedReadyWorkMailboxes(store).flatMap<RuntimeLifecycleTarget>((mailbox) => {
      if (mailbox.target.kind === "role-runtime") {
        return blockedTaskIds.has(mailbox.target.taskId)
          ? []
          : [mailbox.target];
      }
      return mailbox.target.kind === "global-role-runtime"
        ? [mailbox.target]
        : [];
    });
  }
  const targets = new Map<string, RuntimeLifecycleTarget>();
  for (const key of scope.keys) {
    const parsed = parseMailboxKey(key);
    if (parsed.kind === "task") {
      if (blockedTaskIds.has(parsed.taskId)) continue;
      const task = store.getTask(parsed.taskId);
      if (task?.status !== "active" && task?.status !== "completed") continue;
      for (const role of store.listRoles(parsed.taskId)) {
        const target = {
          kind: "role-runtime",
          taskId: parsed.taskId,
          roleName: role.name
        } as const;
        targets.set(runtimeTargetIdentity(target), target);
      }
    } else if (parsed.kind === "role") {
      if (blockedTaskIds.has(parsed.taskId)) continue;
      const target = {
        kind: "role-runtime",
        taskId: parsed.taskId,
        roleName: parsed.roleName
      } as const;
      targets.set(runtimeTargetIdentity(target), target);
    } else if (parsed.kind === "global-role") {
      const target = {
        kind: "global-role-runtime",
        roleName: parsed.roleName
      } as const;
      targets.set(runtimeTargetIdentity(target), target);
    }
  }
  return [...targets.values()];
}

function runtimeOwner(target: RuntimeLifecycleTarget): RuntimeRoleOwner {
  return target.kind === "role-runtime"
    ? {
        scope: "task",
        taskId: target.taskId,
        roleName: target.roleName
      }
    : { scope: "global", roleName: target.roleName };
}

function runtimeOwnerLabel(owner: RuntimeRoleOwner): string {
  return owner.scope === "task"
    ? `${owner.taskId}/${owner.roleName}`
    : `global/${owner.roleName}`;
}

function runtimeTargetIdentity(target: RuntimeLifecycleTarget): string {
  return target.kind === "role-runtime"
    ? `task\0${target.taskId}\0${target.roleName}`
    : `global\0${target.roleName}`;
}

function runtimeCleanupMailboxKey(target: RuntimeLifecycleTarget): MailboxKey {
  return target.kind === "role-runtime"
    ? `role:${encodeURIComponent(target.taskId)}/${encodeURIComponent(target.roleName)}`
    : `global-role:${encodeURIComponent(target.roleName)}`;
}

function runtimeLifecycleBatchIdentity(
  target: RuntimeLifecycleTarget,
  mailbox: NonNullable<ReturnType<SchedulerStorePort["getWorkMailbox"]>>
): string {
  if (mailbox.processing !== null) return mailbox.processing.batchId;
  const pending = nextPendingBatch(mailbox);
  return pending === null
    ? runtimeTargetIdentity(target)
    : `${runtimeTargetIdentity(target)}:${pending.fromSequence}-${pending.toSequence}`;
}

function markFailedRuntimeTarget(
  failedRoles: Set<string>,
  target: RuntimeLifecycleTarget
): void {
  if (target.kind === "role-runtime") {
    failedRoles.add(roleIdentity(target.taskId, target.roleName));
  }
}

function selectionWithoutFailedCleanupRoles(
  store: SchedulerStorePort,
  selection: ReconcileSelection,
  failedRoles: ReadonlySet<string>
): ReconcileSelection {
  if (failedRoles.size === 0) return selection;
  const taskIds = selection.full
    ? new Set(selectedActiveSchedulerTasks(store, selection).map((task) => task.id))
    : new Set(selection.taskIds);
  const rolesByTask = new Map<string, ReadonlySet<string>>();
  for (const taskId of taskIds) {
    const roleNames = selection.full || selection.allRoleTaskIds.has(taskId)
      ? store.listRoles(taskId).map((role) => role.name)
      : [...(selection.rolesByTask.get(taskId) ?? [])];
    rolesByTask.set(taskId, new Set(roleNames.filter((roleName) => (
      !failedRoles.has(roleIdentity(taskId, roleName))
    ))));
  }
  return {
    full: false,
    taskIds,
    allRoleTaskIds: new Set(),
    rolesByTask,
    operator: selection.operator,
    blockedTaskIds: selection.blockedTaskIds
  };
}

function selectionWithoutFailedLeaderCleanupTasks(
  store: SchedulerStorePort,
  selection: ReconcileSelection,
  failedRoles: ReadonlySet<string>
): ReconcileSelection {
  if (![...failedRoles].some((identity) => identity.endsWith("\0leader"))) {
    return selection;
  }
  const taskIds = selection.full
    ? new Set(selectedActiveSchedulerTasks(store, selection).map((task) => task.id))
    : new Set(selection.taskIds);
  for (const taskId of taskIds) {
    if (failedRoles.has(roleIdentity(taskId, "leader"))) taskIds.delete(taskId);
  }
  return {
    full: false,
    taskIds,
    allRoleTaskIds: new Set(),
    rolesByTask: new Map(),
    operator: selection.operator,
    blockedTaskIds: selection.blockedTaskIds
  };
}

function roleIdentity(taskId: string, roleName: string): string {
  return `${taskId}\0${roleName}`;
}

function claimSelectedTaskMailboxes(
  store: SchedulerStorePort,
  selection: ReconcileSelection,
  now: Date
): ClaimedTaskMailbox[] {
  const targets = selection.full
    ? selectedReadyWorkMailboxes(store).flatMap((mailbox) => (
        mailbox.target.kind === "task"
        && !selection.blockedTaskIds?.has(mailbox.target.taskId)
          ? [mailbox.target]
          : []
      ))
    : [...selection.allRoleTaskIds]
      .filter((taskId) => !selection.blockedTaskIds?.has(taskId))
      .map((taskId) => ({ kind: "task", taskId } as const));
  const claims: ClaimedTaskMailbox[] = [];
  for (const target of targets) {
    const mailbox = store.getWorkMailbox(target);
    if (mailbox === null || !mailboxHasWork(mailbox)) continue;
    const pending = nextPendingBatch(mailbox);
    const batchId = mailbox.processing?.batchId
      ?? `task:${encodeURIComponent(target.taskId)}:${pending!.fromSequence}-${pending!.toSequence}`;
    const claim = store.claimWorkMailbox({
      target,
      batchId,
      owner: "controller",
      now
    });
    if (claim.status !== "empty") claims.push({ target, processing: claim.processing });
  }
  return claims;
}

export function compileReconcileSelection(scope: ReconcileScope): ReconcileSelection {
  if (scope.kind === "full") {
    return {
      full: true,
      taskIds: new Set(),
      allRoleTaskIds: new Set(),
      rolesByTask: new Map(),
      operator: true,
      blockedTaskIds: new Set()
    };
  }
  const taskIds = new Set<string>();
  const allRoleTaskIds = new Set<string>();
  const mutableRoles = new Map<string, Set<string>>();
  let operator = false;
  for (const key of scope.keys) {
    const target = parseMailboxKey(key);
    if (target.kind === "operator") {
      operator = true;
    } else if (target.kind === "task") {
      taskIds.add(target.taskId);
      allRoleTaskIds.add(target.taskId);
    } else if (target.kind === "role") {
      taskIds.add(target.taskId);
      const roles = mutableRoles.get(target.taskId) ?? new Set<string>();
      roles.add(target.roleName);
      mutableRoles.set(target.taskId, roles);
    }
  }
  return {
    full: false,
    taskIds,
    allRoleTaskIds,
    rolesByTask: mutableRoles,
    operator,
    blockedTaskIds: new Set()
  };
}

async function prepareActiveWorkspaces(
  store: SchedulerStorePort,
  workspace: ControllerRuntimeOptions["workspacePreparer"],
  selection: ReconcileSelection,
  maintenanceFence?: (projectId: string) => boolean,
  onMaintenanceFenceDefer?: ControllerRuntimeOptions["onMaintenanceFenceDefer"]
): Promise<Readonly<{ failed: Set<string>; ready: Set<string> }>> {
  if (workspace === undefined) return { failed: new Set(), ready: new Set() };
  const tasks = selection.full
    ? selectedActiveSchedulerTasks(store, selection)
    : [...selection.allRoleTaskIds].flatMap((taskId) => {
        if (selection.blockedTaskIds?.has(taskId)) return [];
        const task = store.getTask(taskId);
        return task?.status === "active" && task.executionGate.state === "enabled" ? [task] : [];
      });
  const failed = new Set<string>();
  const ready = new Set<string>();
  for (const task of tasks) {
    const taskId = task.id;
    // A Project under maintenance is fenced: defer this Task's preparation
    // for the pass. The deferral is per-Project, never a Controller stop,
    // and a deferred Task is not marked failed.
    if (maintenanceFence !== undefined) {
      const fencedProjects = task.projectBindings
        .map(({ projectId }) => projectId)
        .filter((projectId) => maintenanceFence(projectId));
      if (fencedProjects.length > 0) {
        onMaintenanceFenceDefer?.({ taskId, projectIds: fencedProjects });
        continue;
      }
    }
    try {
      const result = await workspace.prepareTaskWorkspace(taskId);
      if (result.status === "failed") failed.add(taskId);
      else ready.add(taskId);
    } catch {
      failed.add(taskId);
    }
  }
  return { failed, ready };
}

function parseMailboxKey(key: string):
  | Readonly<{ kind: "task"; taskId: string }>
  | Readonly<{ kind: "role"; taskId: string; roleName: string }>
  | Readonly<{ kind: "global-role"; roleName: string }>
  | Readonly<{ kind: "operator" }> {
  if (key === "operator") return { kind: "operator" };
  if (key.startsWith("task:")) {
    return { kind: "task", taskId: mailboxPart(key.slice("task:".length), key) };
  }
  if (key.startsWith("global-role:")) {
    return {
      kind: "global-role",
      roleName: mailboxPart(key.slice("global-role:".length), key)
    };
  }
  if (key.startsWith("role:")) {
    const value = key.slice("role:".length);
    const separator = value.indexOf("/");
    if (separator > 0 && separator < value.length - 1 && value.indexOf("/", separator + 1) < 0) {
      return {
        kind: "role",
        taskId: mailboxPart(value.slice(0, separator), key),
        roleName: mailboxPart(value.slice(separator + 1), key)
      };
    }
  }
  throw new TypeError(`Controller mailbox key is invalid: ${key}.`);
}

function mailboxPart(value: string, key: string): string {
  if (value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new TypeError(`Controller mailbox key is invalid: ${key}.`);
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0 || decoded.includes("\0") || encodeURIComponent(decoded) !== value) {
      throw new Error("not canonical");
    }
    return decoded;
  } catch {
    throw new TypeError(`Controller mailbox key is invalid: ${key}.`);
  }
}

function partitionDirtyScope(keys: readonly MailboxKey[]): DirtyScopePartition {
  const taskScopes = new Map<string, {
    taskKey: MailboxKey | undefined;
    roleKeys: Map<string, MailboxKey>;
  }>();
  const globalKeys = new Set<MailboxKey>();
  for (const key of keys) {
    const parsed = parseMailboxKey(key);
    if (parsed.kind === "operator" || parsed.kind === "global-role") {
      globalKeys.add(key);
      continue;
    }
    const current = taskScopes.get(parsed.taskId) ?? {
      taskKey: undefined,
      roleKeys: new Map<string, MailboxKey>()
    };
    if (parsed.kind === "task") {
      current.taskKey = key;
      current.roleKeys.clear();
    } else if (current.taskKey === undefined) {
      current.roleKeys.set(parsed.roleName, key);
    }
    taskScopes.set(parsed.taskId, current);
  }
  return {
    taskScopes: [...taskScopes].map(([taskId, scope]) => ({
      taskId,
      keys: scope.taskKey === undefined
        ? [...scope.roleKeys.values()]
        : [scope.taskKey]
    })),
    globalKeys: [...globalKeys]
  };
}

function emptyControllerSchedulerResult(): ControllerSchedulerResult {
  return {
    activeRunDeliveries: [],
    failedRunRefs: [],
    wakeups: [],
    inputNotifications: [],
    autoResolvedInputs: []
  };
}

function runtimeTaskFailureIds(
  result: RuntimeEventDrainResult | undefined
): ReadonlySet<string> {
  if (result === undefined) return new Set();
  return new Set(result.failed.flatMap((failure) => (
    failure.scope === "task"
      && typeof failure.taskId === "string"
      && failure.taskId.length > 0
      ? [failure.taskId]
      : []
  )));
}

function mergeControllerSchedulerResults(
  results: readonly ControllerSchedulerResult[]
): ControllerSchedulerResult {
  return {
    activeRunDeliveries: results.flatMap((result) => result.activeRunDeliveries),
    failedRunRefs: results.flatMap((result) => result.failedRunRefs),
    wakeups: results.flatMap((result) => result.wakeups),
    inputNotifications: results.flatMap((result) => result.inputNotifications),
    autoResolvedInputs: results.flatMap((result) => result.autoResolvedInputs)
  };
}

/**
 * Single-owner periodic runtime for FileTaskStore-backed scheduling. Full pump
 * requests remain exclusive, while dirty work is serialized per Task and may
 * progress concurrently across different Tasks up to the configured bound.
 */
export class FileTaskController {
  readonly #startedAt: Date;
  #intervalMs: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #workspacePreparer:
    | Pick<TaskWorkspacePreparer, "prepareTaskWorkspace">
    | undefined;
  readonly #deliveryRetryMs: number;
  readonly #deliveryRetryLimit: number;
  readonly #mailboxDeliveryRetryLimit: number;
  readonly #deliveryTimeoutMs: number;
  readonly #taskOrchestrationRetryLimit: number;
  readonly #taskConcurrency: number;
  readonly #stallWindowMs: number;
  readonly #diagnosticAfterMs: number;
  readonly #runtimeEventProcessor: RuntimeEventProcessorPort | AsyncRuntimeEventProcessorPort | undefined;
  readonly #runtimeObserver: AgentRuntimeObserverPort | undefined;
  readonly #runtimeObserverIntervalMs: number;
  readonly #lifecycleHost:
    | RuntimeLifecycleHost
    | undefined;
  readonly #deliveryRetryAttempts = new Map<MailboxKey, Readonly<{
    identity: string;
    attempts: number;
    startedAtMs: number;
    terminalFailure?: RoleRunDeliveryFailureIdentity;
  }>>();
  readonly #deliveryRetryTimers = new Map<MailboxKey, NodeJS.Timeout>();
  readonly #taskPassRetryAttempts = new Map<string, Readonly<{
    identity: string;
    attempts: number;
  }>>();
  readonly #taskPassRetryTimers = new Map<string, NodeJS.Timeout>();
  #dirtyTaskQueue: KeyedWorkQueue<string> | undefined;
  #passRetryTimer: NodeJS.Timeout | undefined;
  #passRetryAttempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #deadlineTimer: NodeJS.Timeout | undefined;
  #runtimeObserverTimer: NodeJS.Timeout | undefined;
  readonly #signalScheduler: MailboxScheduler<MailboxKey>;
  readonly #operatorSignalScheduler: MailboxScheduler<MailboxKey>;
  readonly #configuration: ControllerConfigurationPort | undefined;
  readonly #resourceReaper:
    | ControllerRuntimeOptions["resourceReaper"]
    | undefined;
  readonly #resourceAutoGc:
    | ControllerRuntimeOptions["resourceAutoGc"]
    | undefined;
  readonly #onExpiredEphemeralDomain:
    | ControllerRuntimeOptions["onExpiredEphemeralDomain"]
    | undefined;
  readonly #maintenanceFence:
    | ((projectId: string) => boolean)
    | undefined;
  readonly #onMaintenanceFenceDefer:
    | ControllerRuntimeOptions["onMaintenanceFenceDefer"]
    | undefined;
  readonly #leaderWakeFence: (() => boolean) | undefined;
  readonly #jobSupervisor: ControllerRuntimeOptions["jobSupervisor"];
  readonly #continuationReconciler: ControllerRuntimeOptions["continuationReconciler"];
  #current: Promise<ControllerSchedulerResult> | undefined;
  #operatorCurrent: Promise<void> | undefined;
  #runtimeObserverCurrent: Promise<void> | undefined;
  #pendingFull = false;
  readonly #pendingKeys = new Set<MailboxKey>();
  #operatorStartupRetryArmed = false;
  #lastOperatorSignalIdentity: string | undefined;
  #stopped = false;
  #lastRuntimeDrain: RuntimeEventDrainResult | undefined;
  #runtimeDrainPasses = 0;
  #runtimeListedEvents = 0;
  #runtimeSelectedEvents = 0;
  #runtimeProgressEventsCoalesced = 0;
  #runtimeStateTransactions = 0;

  constructor(
    readonly store: SchedulerStorePort,
    readonly delivery: TmuxDeliveryPort,
    options: ControllerRuntimeOptions = {}
  ) {
    this.#intervalMs = positiveInteger(
      options.intervalMs,
      DEFAULT_RECONCILIATION_INTERVAL_MS,
      "Controller reconciliation interval"
    );
    this.#now = options.now ?? (() => new Date());
    this.#startedAt = this.#now();
    this.#onError = options.onError ?? (() => {});
    this.#workspacePreparer = options.workspacePreparer;
    this.#deliveryRetryMs = positiveInteger(
      options.deliveryRetryMs,
      DEFAULT_DELIVERY_RETRY_MS,
      "Controller delivery retry delay"
    );
    this.#deliveryRetryLimit = positiveInteger(
      options.deliveryRetryLimit,
      DEFAULT_DELIVERY_RETRY_LIMIT,
      "Controller delivery retry limit"
    );
    this.#deliveryTimeoutMs = positiveInteger(
      options.deliveryTimeoutMs,
      DEFAULT_DELIVERY_TIMEOUT_MS,
      "Controller delivery timeout"
    );
    this.#mailboxDeliveryRetryLimit = options.deliveryRetryLimit === undefined
      ? Math.max(
          this.#deliveryRetryLimit,
          Math.ceil(this.#deliveryTimeoutMs / this.#deliveryRetryMs) + 2
        )
      : this.#deliveryRetryLimit;
    this.#taskOrchestrationRetryLimit = positiveInteger(
      options.taskOrchestrationRetryLimit,
      DEFAULT_TASK_ORCHESTRATION_RETRY_LIMIT,
      "Controller Task orchestration retry limit"
    );
    this.#taskConcurrency = boundedPositiveInteger(
      options.taskConcurrency,
      DEFAULT_TASK_CONCURRENCY,
      MAX_TASK_CONCURRENCY,
      "Controller Task concurrency"
    );
    this.#stallWindowMs = positiveInteger(
      options.stallWindowMs,
      DEFAULT_STALL_WINDOW_MS,
      "Controller Run stall window"
    );
    this.#diagnosticAfterMs = positiveInteger(
      options.diagnosticAfterMs,
      DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS,
      "Controller Run diagnostic threshold"
    );
    this.#runtimeEventProcessor = options.runtimeEventProcessor;
    this.#runtimeObserver = options.runtimeObserver;
    this.#runtimeObserverIntervalMs = positiveInteger(
      options.runtimeObserverIntervalMs,
      DEFAULT_RUNTIME_OBSERVER_INTERVAL_MS,
      "Controller runtime observer interval"
    );
    this.#lifecycleHost = options.lifecycleHost;
    this.#configuration = options.configuration;
    this.#resourceReaper = options.resourceReaper;
    this.#resourceAutoGc = options.resourceAutoGc;
    this.#onExpiredEphemeralDomain = options.onExpiredEphemeralDomain;
    this.#maintenanceFence = options.maintenanceFence;
    this.#onMaintenanceFenceDefer = options.onMaintenanceFenceDefer;
    this.#leaderWakeFence = options.leaderWakeFence;
    this.#jobSupervisor = options.jobSupervisor;
    this.#continuationReconciler = options.continuationReconciler;
    this.#signalScheduler = new MailboxScheduler(
      async (keys) => { await this.#requestPass({ kind: "dirty", keys }); },
      {
        windowMs: options.signalWindowMs ?? DEFAULT_SIGNAL_WINDOW_MS,
        onError: this.#onError,
        setTimer: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          timer.unref();
          return timer;
        }
      }
    );
    this.#operatorSignalScheduler = new MailboxScheduler(
      async () => {
        const running = this.#runOperatorPass();
        this.#operatorCurrent = running;
        try {
          await running;
        } finally {
          if (this.#operatorCurrent === running) this.#operatorCurrent = undefined;
        }
      },
      {
        windowMs: options.signalWindowMs ?? DEFAULT_SIGNAL_WINDOW_MS,
        onError: this.#onError,
        setTimer: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          timer.unref();
          return timer;
        }
      }
    );
  }

  get reconciliationIntervalMs(): number {
    return this.#intervalMs;
  }

  runtimeMetrics(): Pick<ControllerRuntimeMetrics, "inbox" | "drain"> {
    const metrics = this.#lastRuntimeDrain?.metrics ?? ZERO_DRAIN_METRICS;
    return {
      // Status is intentionally O(1): scanning the inbox while serving the
      // control socket would recreate the starvation this metric diagnoses.
      inbox: {
        depth: this.#lastRuntimeDrain?.remainingEventCount ?? 0,
        semanticDepth: metrics.remainingSemanticEventCount,
        progressDepth: metrics.remainingProgressEventCount
      },
      drain: {
        passes: this.#runtimeDrainPasses,
        listedEvents: this.#runtimeListedEvents,
        selectedEvents: this.#runtimeSelectedEvents,
        progressEventsCoalesced: this.#runtimeProgressEventsCoalesced,
        stateTransactions: this.#runtimeStateTransactions
      }
    };
  }

  updateReconciliationInterval(intervalMs: number): void {
    const next = positiveInteger(
      intervalMs,
      DEFAULT_RECONCILIATION_INTERVAL_MS,
      "Controller reconciliation interval"
    );
    if (this.#stopped) throw new Error("Controller runtime is stopped.");
    if (next === this.#intervalMs) return;
    this.#intervalMs = next;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = setInterval(() => {
        this.#requestBackgroundPump();
      }, this.#intervalMs);
      this.#timer.unref();
    }
  }

  reloadReconciliationInterval(): number {
    if (this.#configuration !== undefined) {
      this.updateReconciliationInterval(
        this.#configuration.reconciliationIntervalMs()
      );
    }
    return this.#intervalMs;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    if (this.#stopped) throw new Error("Controller runtime is stopped.");
    this.#requestBackgroundPump();
    this.#requestRuntimeObservation();
    // Arm the Operator lane once for work that was already pending when the
    // Controller started. Subsequent main-lane passes signal it only when a
    // new Operator batch is durably queued; an unchanged pending batch must
    // not keep an unavailable Operator lane in a zero-delay drain loop.
    this.#signalOperatorMailbox();
    this.#timer = setInterval(() => {
      this.#requestBackgroundPump();
    }, this.#intervalMs);
    this.#timer.unref();
    if (this.#runtimeObserver !== undefined) {
      this.#runtimeObserverTimer = setInterval(() => {
        this.#requestRuntimeObservation();
      }, this.#runtimeObserverIntervalMs);
      this.#runtimeObserverTimer.unref();
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#signalScheduler.stop();
    this.#operatorSignalScheduler.stop();
    if (this.#deadlineTimer !== undefined) {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#runtimeObserverTimer !== undefined) {
      clearInterval(this.#runtimeObserverTimer);
      this.#runtimeObserverTimer = undefined;
    }
    for (const timer of this.#deliveryRetryTimers.values()) clearTimeout(timer);
    this.#deliveryRetryTimers.clear();
    this.#deliveryRetryAttempts.clear();
    this.#clearAllTaskPassRetries();
    void this.#dirtyTaskQueue?.abortPending();
    if (this.#passRetryTimer !== undefined) {
      clearTimeout(this.#passRetryTimer);
      this.#passRetryTimer = undefined;
    }
  }

  async shutdownAndDrain(): Promise<void> {
    this.stop();
    await Promise.allSettled([
      this.#current ?? Promise.resolve(),
      this.#operatorCurrent ?? Promise.resolve(),
      this.#runtimeObserverCurrent ?? Promise.resolve()
    ]);
  }

  /** Adds one dirty Task key to the fixed-window wake queue and returns immediately. */
  signal(key: string): void {
    if (this.#stopped) throw new Error("Controller runtime is stopped.");
    parseMailboxKey(key);
    if (key === "operator") {
      // Main lane owns durable Hook folding; the Operator lane is the sole
      // consumer of the Operator delivery mailbox.
      this.#signalScheduler.signal("operator");
      this.#operatorSignalScheduler.signal("operator");
    }
    else this.#signalScheduler.signal(key as MailboxKey);
  }

  pump(): Promise<ControllerSchedulerResult> {
    return this.#requestPass({ kind: "full" });
  }

  #requestRuntimeObservation(): void {
    if (this.#stopped || this.#runtimeObserver === undefined
      || this.#runtimeObserverCurrent !== undefined) return;
    const running = this.#runtimeObserver.sample(this.#now()).then((keys) => {
      if (this.#stopped) return;
      for (const key of keys) this.signal(key);
    }).catch(this.#onError).finally(() => {
      if (this.#runtimeObserverCurrent === running) this.#runtimeObserverCurrent = undefined;
    });
    this.#runtimeObserverCurrent = running;
  }

  armOperatorStartupRetry(): void {
    if (this.#stopped) return;
    const mailbox = this.store.getWorkMailbox({ kind: "operator" });
    const shouldArm = mailbox !== null
      && mailboxHasWork(mailbox);
    if (shouldArm) this.#clearDeliveryRetry("operator");
    this.#operatorStartupRetryArmed = shouldArm;
  }

  #requestPass(scope: ReconcileScope): Promise<ControllerSchedulerResult> {
    if (this.#stopped) {
      return Promise.reject(new Error("Controller runtime is stopped."));
    }
    if (scope.kind === "full") {
      this.#pendingFull = true;
      this.#pendingKeys.clear();
      this.#clearAllTaskPassRetries();
      void this.#dirtyTaskQueue?.abortPending();
    } else if (!this.#pendingFull) {
      for (const key of scope.keys) this.#pendingKeys.add(key);
    }
    if (this.#current !== undefined) {
      return this.#current;
    }

    const running = this.#runCoalesced();
    this.#current = running;
    void running.finally(() => {
      if (this.#current === running) this.#current = undefined;
    }).catch(() => {});
    return running;
  }

  #requestBackgroundPump(): void {
    void this.pump().catch(this.#onError);
  }

  async #runCoalesced(): Promise<ControllerSchedulerResult> {
    let result = emptyControllerSchedulerResult();
    let pendingRuntimeDrain = false;
    try {
      while (this.#pendingFull || this.#pendingKeys.size > 0 || pendingRuntimeDrain) {
        const scope: ReconcileScope = this.#pendingFull
          ? { kind: "full" }
          : { kind: "dirty", keys: [...this.#pendingKeys] };
        const runtimeCleanupOutcomes: RuntimeCleanupOutcome[] = [];
        const runtimeFailedTaskIds = new Set<string>();
        let failedTaskScopes: readonly DirtyTaskReconcileScope[] = [];
        pendingRuntimeDrain = false;
        this.#pendingFull = false;
        this.#pendingKeys.clear();
        try {
          if (scope.kind === "full") this.reloadReconciliationInterval();
          if (scope.kind === "full" && this.#resourceReaper !== undefined) {
            const reap = await this.#resourceReaper();
            for (const failure of reap.failed) {
              this.#onError(new Error(
                `Ephemeral runtime reap failed for ${failure.id}: ${failure.message}`
              ));
            }
            // The reaper owns the exact resource fences. Once a whole expired
            // domain converges, let the detached Controller close itself on a
            // later turn; never close while this reconciliation pass is still
            // the in-flight server request.
            if (reap.failed.length === 0 && (reap.expiredDomains?.length ?? 0) > 0) {
              for (const domain of reap.expiredDomains ?? []) {
                queueMicrotask(() => {
                  this.#onExpiredEphemeralDomain?.(domain);
                });
              }
            }
          }
          const firstRuntimeDrain = await this.#drainRuntimeEvents();
          for (const taskId of runtimeTaskFailureIds(firstRuntimeDrain)) {
            runtimeFailedTaskIds.add(taskId);
          }
          // Detached reconciliation is deliberately confined to the low-rate
          // full pass. It queries only identities already present in Task
          // facts and cannot start a model Turn or scan unknown children.
          if (scope.kind === "full" && this.#continuationReconciler !== undefined) {
            await this.#continuationReconciler.reconcile(this.#now());
          }
          // DurableJob reconciliation runs before the scheduler pass so a
          // terminal job's Leader wakeup is enqueued in the same pass that
          // processes Leader wakeups.
          this.#jobSupervisor?.reconcile(this.#now());
          if (scope.kind === "full") {
            result = await runControllerSchedulerPass(
              this.store,
              this.delivery,
              this.#now(),
              this.#workspacePreparer,
              scope,
              false,
              runtimeCleanupOutcomes,
              this.#lifecycleHost,
              this.#stallWindowMs,
              this.#maintenanceFence,
              this.#onMaintenanceFenceDefer,
              runtimeFailedTaskIds,
              this.#startedAt,
              this.#diagnosticAfterMs,
              this.#leaderWakeFence
            );
          } else {
            const dirtyPass = await this.#runDirtySchedulerPass(
              scope,
              runtimeCleanupOutcomes,
              runtimeFailedTaskIds
            );
            result = dirtyPass.result;
            failedTaskScopes = dirtyPass.failedTaskScopes;
          }
          const secondRuntimeDrain = await this.#drainRuntimeEvents();
          for (const taskId of runtimeTaskFailureIds(secondRuntimeDrain)) {
            runtimeFailedTaskIds.add(taskId);
          }
          pendingRuntimeDrain = (
            (secondRuntimeDrain?.remainingEventCount ?? 0) > 0
            && (
              (firstRuntimeDrain?.acknowledgedEventIds.length ?? 0) > 0
              || (secondRuntimeDrain?.acknowledgedEventIds.length ?? 0) > 0
            )
          );
          // Issue 10: automatic Resource GC runs only on full passes, after
          // the scheduler pass and both runtime drains have settled Task
          // terminal state. It is default-off and self-skipping; a failed
          // pass is logged and retried next time, never breaking the
          // scheduler.
          if (scope.kind === "full" && this.#resourceAutoGc !== undefined) {
            try {
              const gc = await this.#resourceAutoGc();
              if (!gc.skipped && gc.failed > 0) {
                this.#onError(new Error(
                  `Resource auto-GC failed to quarantine ${gc.failed} `
                    + "resource(s); they stay in place and retry next pass."
                ));
              }
            } catch (error) {
              this.#onError(error);
            }
          }
          this.#clearPassRetry();
          if (scope.kind === "full") this.#clearAllTaskPassRetries();
          this.#scheduleRuntimeCleanupRetries(runtimeCleanupOutcomes);
          this.#scheduleDeliveryRetries(result);
          const failedTaskIds = new Set(
            [
              ...failedTaskScopes.map((failedScope) => failedScope.taskId),
              ...runtimeFailedTaskIds
            ]
          );
          this.#scheduleTaskMailboxRetries(
            scope.kind === "dirty" && failedTaskIds.size > 0
              ? {
                  kind: "dirty",
                  keys: scope.keys.filter((key) => {
                    const target = parseMailboxKey(key);
                    return (
                      target.kind === "operator"
                      || target.kind === "global-role"
                      || !failedTaskIds.has(target.taskId)
                    );
                  })
                }
              : scope
          );
          for (const failedScope of failedTaskScopes) {
            this.#clearDeliveryRetry(
              `task:${encodeURIComponent(failedScope.taskId)}`
            );
            this.#scheduleTaskPassRetry(failedScope);
          }
          for (const taskId of runtimeFailedTaskIds) {
            const key = `task:${encodeURIComponent(taskId)}` as const;
            this.#clearDeliveryRetry(key);
            this.#scheduleTaskPassRetry({ taskId, keys: [key] });
          }
          const runtimeAdvanced = (firstRuntimeDrain?.acknowledgedEventIds.length ?? 0) > 0
            || (secondRuntimeDrain?.acknowledgedEventIds.length ?? 0) > 0;
          if (
            scope.kind === "full"
            || scope.keys.some((key) => key !== "operator")
            || runtimeAdvanced
          ) {
            this.#signalOperatorMailbox(runtimeAdvanced);
          }
        } catch (error) {
          if (scope.kind === "full") {
            this.#pendingFull = true;
            this.#pendingKeys.clear();
          } else if (!this.#pendingFull) {
            for (const key of scope.keys) this.#pendingKeys.add(key);
          }
          this.#schedulePassRetry();
          throw error;
        }
        if (this.#stopped) break;
        if (this.#pendingFull || this.#pendingKeys.size > 0 || pendingRuntimeDrain) {
          // A continuous Hook signal stream must yield to socket callbacks
          // between bounded scheduler passes.
          await eventLoopTurn();
        }
      }
      return result;
    } finally {
      this.#scheduleNextInputDeadline();
    }
  }

  async #runDirtySchedulerPass(
    scope: Extract<ReconcileScope, { kind: "dirty" }>,
    runtimeCleanupOutcomes: RuntimeCleanupOutcome[],
    blockedTaskIds: ReadonlySet<string> = new Set()
  ): Promise<DirtySchedulerPassResult> {
    const partition = partitionDirtyScope(scope.keys);
    const taskScopes = partition.taskScopes.filter((taskScope) => (
      !blockedTaskIds.has(taskScope.taskId)
    ));
    const orderedResults: ControllerSchedulerResult[] = [];
    if (partition.globalKeys.length > 0) {
      orderedResults.push(await runControllerSchedulerPass(
        this.store,
        this.delivery,
        this.#now(),
        this.#workspacePreparer,
        { kind: "dirty", keys: partition.globalKeys },
        false,
        runtimeCleanupOutcomes,
        this.#lifecycleHost,
        this.#stallWindowMs,
        this.#maintenanceFence,
        this.#onMaintenanceFenceDefer,
        blockedTaskIds,
        this.#startedAt,
        this.#diagnosticAfterMs,
        this.#leaderWakeFence
      ));
    }
    if (
      taskScopes.length === 0
      || this.#stopped
      || this.#pendingFull
    ) {
      return {
        result: mergeControllerSchedulerResults(orderedResults),
        failedTaskScopes: []
      };
    }

    const queue = new KeyedWorkQueue<string>();
    this.#dirtyTaskQueue = queue;
    const scopesByTask = new Map(
      taskScopes.map((taskScope, index) => [
        taskScope.taskId,
        { taskScope, index }
      ])
    );
    const taskResults: Array<ControllerSchedulerResult | undefined> =
      Array(taskScopes.length);
    const taskCleanupOutcomes: RuntimeCleanupOutcome[][] =
      Array.from({ length: taskScopes.length }, () => []);
    const failedTaskScopes: Array<DirtyTaskReconcileScope | undefined> =
      Array(taskScopes.length);
    const consume = async (): Promise<void> => {
      while (true) {
        const item = await queue.take();
        if (item === undefined) return;
        const selected = scopesByTask.get(item.key);
        if (selected === undefined) {
          item.done();
          throw new Error(`Dirty Task queue returned an unknown Task: ${item.key}.`);
        }
        try {
          if (this.#stopped || this.#pendingFull) continue;
          try {
            taskResults[selected.index] = await runControllerSchedulerPass(
              this.store,
              this.delivery,
              this.#now(),
              this.#workspacePreparer,
              { kind: "dirty", keys: selected.taskScope.keys },
              false,
              taskCleanupOutcomes[selected.index]!,
              this.#lifecycleHost,
              this.#stallWindowMs,
              this.#maintenanceFence,
              this.#onMaintenanceFenceDefer,
              blockedTaskIds,
              this.#startedAt,
              this.#diagnosticAfterMs,
              this.#leaderWakeFence
            );
            this.#clearTaskPassRetry(selected.taskScope.taskId);
          } catch (error) {
            failedTaskScopes[selected.index] = selected.taskScope;
            this.#onError(error);
          }
        } finally {
          item.done();
        }
      }
    };
    const consumers = Array.from(
      {
        length: Math.min(this.#taskConcurrency, taskScopes.length)
      },
      () => consume()
    );
    for (const taskScope of taskScopes) queue.signal(taskScope.taskId);
    const stopped = queue.shutdown();
    if (this.#stopped || this.#pendingFull) void queue.abortPending();
    try {
      await Promise.all(consumers);
      await stopped;
    } catch (error) {
      await queue.abortPending();
      await Promise.allSettled(consumers);
      throw error;
    } finally {
      if (this.#dirtyTaskQueue === queue) this.#dirtyTaskQueue = undefined;
    }
    for (const outcomes of taskCleanupOutcomes) {
      runtimeCleanupOutcomes.push(...outcomes);
    }
    orderedResults.push(...taskResults.filter(
      (taskResult): taskResult is ControllerSchedulerResult => taskResult !== undefined
    ));
    return {
      result: mergeControllerSchedulerResults(orderedResults),
      failedTaskScopes: failedTaskScopes.filter(
        (failedScope): failedScope is DirtyTaskReconcileScope => failedScope !== undefined
      )
    };
  }

  async #runOperatorPass(): Promise<void> {
    const result = await runControllerSchedulerPass(
      this.store,
      this.delivery,
      this.#now(),
      undefined,
      { kind: "dirty", keys: ["operator"] }
    );
    if (this.#operatorStartupRetryArmed && result.inputNotifications.length === 0) {
      const mailbox = this.store.getWorkMailbox({ kind: "operator" });
      if (
        mailbox === null
        || !mailboxHasWork(mailbox)
      ) {
        this.#operatorStartupRetryArmed = false;
      }
    }
    this.#scheduleDeliveryRetries(result);
    this.#clearEmptyOperatorRetry();
    this.#scheduleNextInputDeadline();
  }

  #signalOperatorMailbox(retryReady = false): void {
    if (this.#stopped) return;
    const mailbox = this.store.getWorkMailbox({ kind: "operator" });
    const identity = operatorMailboxBatchIdentity(mailbox);
    if (identity === null) {
      this.#lastOperatorSignalIdentity = undefined;
      return;
    }
    if (
      identity !== this.#lastOperatorSignalIdentity
      || (retryReady && this.store.getOperatorDeliveryTarget() !== null)
    ) {
      this.#operatorSignalScheduler.signal("operator");
      this.#lastOperatorSignalIdentity = identity;
    }
  }

  async #drainRuntimeEvents(): Promise<RuntimeEventDrainResult | undefined> {
    const processor = this.#runtimeEventProcessor;
    if (processor === undefined) return undefined;
    // The worker backend exposes drainAsync; the file backend stays sync.
    const result = "drainAsync" in processor
      ? await processor.drainAsync(this.#now())
      : processor.drain(this.#now());
    this.#lastRuntimeDrain = result;
    this.#runtimeDrainPasses += 1;
    const metrics = result.metrics ?? ZERO_DRAIN_METRICS;
    this.#runtimeListedEvents += metrics.listedEventCount;
    this.#runtimeSelectedEvents += metrics.selectedEventCount;
    this.#runtimeProgressEventsCoalesced += metrics.progressEventsCoalesced;
    this.#runtimeStateTransactions += metrics.stateTransactions;
    const taskFailures = result.failed.filter((failure) => (
      failure.scope === "task"
      && typeof failure.taskId === "string"
      && failure.taskId.length > 0
    ));
    const invalidFailures = result.failed.filter((failure) => !(
      failure.scope === "task"
      && typeof failure.taskId === "string"
      && failure.taskId.length > 0
    ));
    for (const failure of taskFailures) this.#onError(failure.error);
    if (invalidFailures.length > 0) {
      throw new RuntimeEventApplyError(
        invalidFailures.map((failure) => failure.error),
        "One or more native Turn events could not be applied."
      );
    }
    return result;
  }

  #schedulePassRetry(): void {
    if (
      this.#stopped
      || this.#passRetryTimer !== undefined
      || this.#passRetryAttempt >= this.#deliveryRetryLimit
    ) return;
    const delayMs = Math.min(
      2_000,
      this.#deliveryRetryMs * (2 ** Math.min(this.#passRetryAttempt, 3))
    );
    this.#passRetryAttempt += 1;
    this.#passRetryTimer = setTimeout(() => {
      this.#passRetryTimer = undefined;
      if (this.#stopped) return;
      void this.#requestPass({ kind: "dirty", keys: [] }).catch(this.#onError);
    }, delayMs);
    this.#passRetryTimer.unref();
  }

  #clearPassRetry(): void {
    if (this.#passRetryTimer !== undefined) clearTimeout(this.#passRetryTimer);
    this.#passRetryTimer = undefined;
    this.#passRetryAttempt = 0;
  }

  #scheduleTaskPassRetry(scope: DirtyTaskReconcileScope): void {
    if (this.#stopped || this.#pendingFull) return;
    const task = this.store.getTask(scope.taskId);
    if (task?.status !== "active" || task.executionGate.state !== "enabled") {
      this.#clearTaskPassRetry(scope.taskId);
      return;
    }
    const identity = JSON.stringify([...scope.keys].sort((left, right) => (
      left.localeCompare(right, undefined, { numeric: true })
    )));
    let previous = this.#taskPassRetryAttempts.get(scope.taskId);
    if (previous !== undefined && previous.identity !== identity) {
      this.#clearTaskPassRetry(scope.taskId);
      previous = undefined;
    }
    if (this.#taskPassRetryTimers.has(scope.taskId)) return;
    const attempts = previous?.attempts ?? 0;
    if (attempts >= this.#taskOrchestrationRetryLimit) {
      this.#clearTaskPassRetry(scope.taskId);
      return;
    }
    this.#taskPassRetryAttempts.set(scope.taskId, {
      identity,
      attempts: attempts + 1
    });
    const delayMs = Math.min(
      2_000,
      this.#deliveryRetryMs * (2 ** Math.min(attempts, 3))
    );
    const timer = setTimeout(() => {
      this.#taskPassRetryTimers.delete(scope.taskId);
      if (this.#stopped || this.#pendingFull) return;
      try {
        const currentTask = this.store.getTask(scope.taskId);
        if (currentTask?.status !== "active"
          || currentTask.executionGate.state !== "enabled") {
          this.#clearTaskPassRetry(scope.taskId);
          return;
        }
        void this.#requestPass({ kind: "dirty", keys: scope.keys }).catch(this.#onError);
      } catch (error) {
        this.#clearTaskPassRetry(scope.taskId);
        this.#onError(error);
      }
    }, delayMs);
    timer.unref();
    this.#taskPassRetryTimers.set(scope.taskId, timer);
  }

  #clearTaskPassRetry(taskId: string): void {
    const timer = this.#taskPassRetryTimers.get(taskId);
    if (timer !== undefined) clearTimeout(timer);
    this.#taskPassRetryTimers.delete(taskId);
    this.#taskPassRetryAttempts.delete(taskId);
  }

  #clearAllTaskPassRetries(): void {
    for (const timer of this.#taskPassRetryTimers.values()) clearTimeout(timer);
    this.#taskPassRetryTimers.clear();
    this.#taskPassRetryAttempts.clear();
  }

  #scheduleNextInputDeadline(): void {
    if (this.#deadlineTimer !== undefined) {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
    if (this.#stopped) return;
    const deadlines = [
      ...this.store.listOpenInputRequests()
      .flatMap((request) => request.policy.kind === "recommended"
        ? [{
            key: `task:${encodeURIComponent(request.taskId)}` as MailboxKey,
            at: Date.parse(request.policy.timeoutAt)
          }]
        : []),
      // Issue 04 durable in-place retry timer: arm the Controller wake at the
      // earliest dispatch/deadline wake. Scheduled retries re-push on their
      // original Session; in-flight retries only wake at the episode deadline.
      // The projection is durable, so a restart resumes the lineage.
      ...(typeof this.store.listPendingProviderRetries === "function"
        ? this.store.listPendingProviderRetries()
        : []).map((retry) => ({
        key: `role:${encodeURIComponent(retry.taskId)}/${encodeURIComponent(retry.roleName)}` as MailboxKey,
        at: Date.parse(retry.dueAt)
      }))
    ];
    const nearest = nearestDeadlineBatch(deadlines);
    if (nearest === null) return;
    const now = this.#now().getTime();
    // Preserve an upcoming semantic deadline even while another pass backs
    // off. Once that deadline has fired, the bounded pass retry owns failures
    // so an overdue record cannot create a zero-delay hot loop.
    if (nearest.at <= now && this.#passRetryAttempt > 0) return;
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, nearest.at - now)
    );
    this.#deadlineTimer = setTimeout(() => {
      this.#deadlineTimer = undefined;
      for (const key of nearest.keys) this.#signalScheduler.signal(key);
      void this.#signalScheduler.drain().catch(this.#onError);
    }, delayMs);
    this.#deadlineTimer.unref();
  }

  #scheduleDeliveryRetries(result: ControllerSchedulerResult): void {
    const retry = new Map<MailboxKey, Readonly<{
      identity: string;
      terminalFailure?: RoleRunDeliveryFailureIdentity;
    }>>();
    const settled = new Set<MailboxKey>();
    const writerBlocked = new Set<MailboxKey>();
    const resignal = new Set<MailboxKey>();
    for (const delivery of result.activeRunDeliveries) {
      const key = `role:${encodeURIComponent(delivery.taskId)}/${encodeURIComponent(delivery.roleName)}` as const;
      if (delivery.terminalized === true) {
        settled.add(key);
        resignal.add(key);
      }
      else if (delivery.reason === "writer-attached") writerBlocked.add(key);
      else if (delivery.reason === "not-ready"
        || delivery.reason === "runtime-unavailable") {
        retry.set(key, {
          identity: delivery.runId,
          ...(delivery.terminalFailure === undefined
            ? {}
            : { terminalFailure: delivery.terminalFailure })
        });
      }
      else if (delivery.status === "delivered" || delivery.status === "already-delivered") settled.add(key);
    }
    for (const wakeup of result.wakeups) {
      const key = `role:${encodeURIComponent(wakeup.taskId)}/leader` as const;
      if (wakeup.terminalized === true) {
        settled.add(key);
        resignal.add(key);
      }
      else if (
        wakeup.reason === "writer-attached"
      ) {
        writerBlocked.add(key);
      }
      else if (
        wakeup.reason === "not-ready"
        || (wakeup.reason === "busy" && wakeup.runId !== undefined)
      ) {
        retry.set(key, { identity: wakeup.runId ?? key });
      }
      else if (wakeup.status === "dispatched") settled.add(key);
    }
    const operatorRetries = result.inputNotifications.filter(
      (notification) => notification.reason === "operator-not-ready"
        || (
          notification.reason === "operator-unavailable"
          && this.#operatorStartupRetryArmed
        )
    );
    if (operatorRetries.length > 0) {
      retry.set("operator", {
        identity: operatorRetries.map((notification) => (
          `${notification.sourceKind}:${notification.taskId}:${notification.sourceId}`
        )).join("|")
      });
    } else if (result.inputNotifications.some(
      (notification) => notification.status === "sent"
        || notification.status === "already-sent"
    )) {
      this.#operatorStartupRetryArmed = false;
      settled.add("operator");
    }
    for (const key of settled) this.#clearDeliveryRetry(key);
    for (const key of writerBlocked) this.#clearDeliveryRetry(key);
    for (const key of resignal) this.signal(key);
    for (const [key, candidate] of retry) {
      this.#scheduleDeliveryRetry(
        key,
        candidate.identity,
        candidate.terminalFailure
      );
    }
  }

  #scheduleRuntimeCleanupRetries(outcomes: readonly RuntimeCleanupOutcome[]): void {
    for (const outcome of outcomes) {
      const key = runtimeCleanupMailboxKey(outcome.target);
      const identity = `runtime-cleanup:${outcome.batchId}`;
      if (outcome.status === "failed") {
        if (outcome.error !== undefined) this.#onError(outcome.error);
        this.#scheduleDeliveryRetry(key, identity);
        continue;
      }
      if (this.#deliveryRetryAttempts.get(key)?.identity === identity) {
        this.#clearDeliveryRetry(key);
      }
    }
  }

  #scheduleTaskMailboxRetries(scope: ReconcileScope): void {
    const selection = compileReconcileSelection(scope);
    const targets = selection.full
      ? selectedReadyWorkMailboxes(this.store).flatMap((mailbox) => (
          mailbox.target.kind === "task" ? [mailbox.target] : []
        ))
      : [...selection.allRoleTaskIds].map((taskId) => (
          { kind: "task", taskId } as const
        ));
    for (const target of targets) {
      const key = `task:${encodeURIComponent(target.taskId)}` as const;
      const mailbox = this.store.getWorkMailbox(target);
      // A newly queued pending batch must not reset the retry identity/bound
      // while this Controller still owns an older processing batch.
      const batch = mailbox?.processing?.batch
        ?? (mailbox === null || mailbox === undefined ? null : nextPendingBatch(mailbox));
      if (batch === undefined || batch === null) {
        this.#clearDeliveryRetry(key);
        continue;
      }
      this.#scheduleDeliveryRetry(
        key,
        `${batch.fromSequence}-${batch.toSequence}`
      );
    }
  }

  #scheduleDeliveryRetry(
    key: MailboxKey,
    identity: string,
    terminalFailure?: RoleRunDeliveryFailureIdentity
  ): void {
    let previous = this.#deliveryRetryAttempts.get(key);
    if (previous !== undefined && previous.identity !== identity) {
      this.#clearDeliveryRetry(key);
      previous = undefined;
    }
    const stableTerminalFailure = previous?.terminalFailure ?? terminalFailure;
    if (this.#deliveryRetryTimers.has(key)) {
      if (previous !== undefined && stableTerminalFailure !== previous.terminalFailure) {
        this.#deliveryRetryAttempts.set(key, {
          ...previous,
          terminalFailure: stableTerminalFailure
        });
      }
      return;
    }
    const attempts = previous?.attempts ?? 0;
    const startedAtMs = previous?.startedAtMs ?? this.#now().getTime();
    const retryLimit = key.startsWith("task:")
      ? this.#taskOrchestrationRetryLimit
      : this.#mailboxDeliveryRetryLimit;
    const remainingMs = this.#deliveryTimeoutMs - (this.#now().getTime() - startedAtMs);
    if (attempts >= retryLimit || remainingMs <= 0) {
      if (key === "operator") this.#operatorStartupRetryArmed = false;
      this.#terminalizePreparedAfterRetryExhaustion(
        key,
        identity,
        stableTerminalFailure
      );
      return;
    }
    this.#deliveryRetryAttempts.set(key, {
      identity,
      attempts: attempts + 1,
      startedAtMs,
      ...(stableTerminalFailure === undefined
        ? {}
        : { terminalFailure: stableTerminalFailure })
    });
    const delayMs = Math.min(
      remainingMs,
      2_000,
      this.#deliveryRetryMs * (2 ** Math.min(attempts, 3))
    );
    const timer = setTimeout(() => {
      this.#deliveryRetryTimers.delete(key);
      if (!this.#stopped) this.signal(key);
    }, delayMs);
    timer.unref();
    this.#deliveryRetryTimers.set(key, timer);
  }

  #terminalizePreparedAfterRetryExhaustion(
    key: MailboxKey,
    runId: string,
    failure: RoleRunDeliveryFailureIdentity | undefined
  ): void {
    if (
      !key.startsWith("role:")
      || runId.startsWith("runtime-cleanup:")
      || failure === undefined
    ) {
      return;
    }
    const target = parseMailboxKey(key);
    if (target.kind !== "role") return;
    if (
      target.taskId !== failure.taskId
      || target.roleName !== failure.roleName
      || runId !== failure.runId
    ) {
      throw new Error(`Role delivery retry identity changed: ${key}/${runId}.`);
    }
    const result = this.store.saveRoleRunDeliveryFailure({
      ...failure,
      now: this.#now()
    });
    this.#clearDeliveryRetry(key);
    if (result !== "failed") return;
    this.delivery.forgetPrepared?.({
      taskId: failure.taskId,
      roleName: failure.roleName,
      runId: failure.runId,
      ...(failure.launchId === undefined
        ? {}
        : { launchId: failure.launchId })
    });
    if (!this.#stopped) this.signal(key);
  }

  #clearEmptyOperatorRetry(): void {
    if (
      !this.#operatorStartupRetryArmed
      && !this.#deliveryRetryAttempts.has("operator")
    ) return;
    const mailbox = this.store.getWorkMailbox({ kind: "operator" });
    if (
      mailbox === null
      || !mailboxHasWork(mailbox)
    ) {
      this.#operatorStartupRetryArmed = false;
      this.#clearDeliveryRetry("operator");
    }
  }

  #clearDeliveryRetry(key: MailboxKey): void {
    const timer = this.#deliveryRetryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#deliveryRetryTimers.delete(key);
    this.#deliveryRetryAttempts.delete(key);
  }
}

/**
 * Starts the single private Unix-socket Controller for one YUI_HOME. The
 * shared server owns status/stop and rejects a second live instance; this
 * layer adds scheduler.signal/scheduler.scan plus an optional command dispatcher.
 */
export async function startFileTaskController(
  home: string,
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  dispatcher?: ControllerDispatcher,
  options: ControllerRuntimeOptions = {}
): Promise<RunningFileTaskController> {
  // The Controller defers preparation for a Project while its maintenance
  // fence is held, so migrate/rebuild/archive/cleanup never interleave with
  // worktree creation. Callers may override the predicate (e.g. tests).
  const runtime = new FileTaskController(store, delivery, {
    ...options,
    maintenanceFence: options.maintenanceFence
      ?? ((projectId: string) => isProjectMaintenanceFenced(home, projectId)),
    leaderWakeFence: options.leaderWakeFence
      ?? (() => isHandoverLockHeld(home))
  });
  let stopping = false;
  const lifecycleRequests = new Set<Promise<unknown>>();
  const dispatcherServiceTime = new ControllerDispatcherServiceTimeMetrics();
  const server = await startControllerServer(home, async (method, params) => {
    const startedAt = monotonicMilliseconds();
    dispatcherServiceTime.started();
    try {
      if (stopping) {
        throw controllerApplicationError("CONTROLLER_DRAINING", "Controller is draining.");
      }
      if (method === "scheduler.signal") {
        runtime.signal(signalMailboxKey(params));
        return { accepted: true };
      }
      if (method === "scheduler.scan") {
        if (!isEmptyJsonObject(params)) {
          throw controllerApplicationError(
            "INVALID_PARAMS",
            "scheduler.scan params are invalid."
          );
        }
        return schedulerResultJson(await runtime.pump());
      }
      if (method === "scheduler.configure") {
        requireEmptySchedulerConfigureParams(params);
        const intervalMs = runtime.reloadReconciliationInterval();
        return { configured: true, reconciliationIntervalMs: intervalMs };
      }
      if (method === "job.start" || method === "job.get" || method === "job.cancel" || method === "job.acknowledge") {
        const control = options.jobControl;
        if (control === undefined) {
          throw controllerApplicationError("METHOD_NOT_FOUND", "Controller method was not found.");
        }
        if (method === "job.start") {
          const input = parseDurableJobStartParams(params);
          const { job, created } = control.startJob(input, new Date());
          if (created) runtime.signal(`task:${job.taskId}`);
          return jobControlJson({ job, created });
        }
        if (method === "job.acknowledge") {
          // rr26: acknowledge uses the same ephemeral task Session caller key
          // as start/cancel; a replayable assertion alone is not authority.
          const { taskId, jobId, caller } = parseDurableJobAcknowledgeParams(params);
          const job = control.acknowledgeJob(taskId, jobId, new Date(), caller);
          if (job === null) {
            throw controllerApplicationError(
              "NOT_FOUND",
              `DurableJob not found: ${taskId}/${jobId}.`
            );
          }
          runtime.signal(`task:${job.taskId}`);
          return jobControlJson({ job, acknowledged: job.acknowledgedAt !== undefined });
        }
        if (method === "job.get") {
          const ref = parseDurableJobRefParams(params);
          const job = control.getJob(ref.taskId, ref.jobId);
          if (job === null) {
            throw controllerApplicationError(
              "NOT_FOUND",
              `DurableJob not found: ${ref.taskId}/${ref.jobId}.`
            );
          }
          return jobControlJson({ job });
        }
        // rr8: job.cancel carries the caller identity so the control port can
        // bind the cancel request to the caller's managed scope.
        const cancel = parseDurableJobCancelParams(params);
        const job = control.cancelJob(cancel.taskId, cancel.jobId, new Date(), cancel.caller);
        if (job === null) {
          throw controllerApplicationError(
            "NOT_FOUND",
            `DurableJob not found: ${cancel.taskId}/${cancel.jobId}.`
          );
        }
        runtime.signal(`task:${job.taskId}`);
        return jobControlJson({ job, cancelRequested: job.cancelRequestedAt !== undefined });
      }
      if (dispatcher === undefined) {
        throw controllerApplicationError(
          "METHOD_NOT_FOUND",
          "Controller method was not found."
        );
      }
      const request = Promise.resolve(dispatcher(method, params));
      lifecycleRequests.add(request);
      try {
        const result = await request;
        if (
          method === "runtime.ensure-role-session"
          && isGlobalOperatorSessionRequest(params)
          && isStartedRuntimeSessionResult(result)
        ) {
          runtime.armOperatorStartupRetry();
        }
        return result;
      } finally {
        lifecycleRequests.delete(request);
      }
    } finally {
      dispatcherServiceTime.completed(monotonicMilliseconds() - startedAt);
    }
  }, async () => {
    stopping = true;
    runtime.stop();
    await Promise.allSettled([...lifecycleRequests]);
    await runtime.shutdownAndDrain();
  }, {
    domainIdentity: options.domainIdentity,
    status: ({ commandObserver, eventLoopDelay }) => ({
      ...runtime.runtimeMetrics(),
      commands: {
        dispatcher: dispatcherServiceTime.snapshot(),
        routes: commandObserver.snapshot(),
        eventLoopDelay: eventLoopDelay.snapshot()
      }
    })
  });
  runtime.start();
  const closed = server.closed;
  return {
    runtime,
    server,
    closed,
    close: async () => {
      runtime.stop();
      await server.close();
      await runtime.shutdownAndDrain();
    }
  };
}

/**
 * Measures dispatcher service time only: the elapsed time inside the FileTask
 * dispatcher from dispatch to completion. It deliberately excludes the
 * socket/event-loop wait before routing, which the core server's event-loop
 * delay telemetry observes separately.
 */
class ControllerDispatcherServiceTimeMetrics {
  #completed = 0;
  #inFlight = 0;
  #maximumServiceTimeMs = 0;
  readonly #buckets = new Map<number, number>(
    CONTROLLER_LATENCY_BUCKETS_MS.map((threshold) => [threshold, 0])
  );

  started(): void {
    this.#inFlight += 1;
  }

  completed(serviceTimeMs: number): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#completed += 1;
    const bounded = Math.max(0, Math.ceil(serviceTimeMs));
    this.#maximumServiceTimeMs = Math.max(this.#maximumServiceTimeMs, bounded);
    for (const threshold of CONTROLLER_LATENCY_BUCKETS_MS) {
      if (bounded <= threshold) {
        this.#buckets.set(threshold, (this.#buckets.get(threshold) ?? 0) + 1);
      }
    }
  }

  snapshot(): ControllerRuntimeMetrics["commands"]["dispatcher"] {
    return {
      completed: this.#completed,
      inFlight: this.#inFlight,
      maximumServiceTimeMs: this.#maximumServiceTimeMs,
      serviceTimeBuckets: Object.fromEntries(
        CONTROLLER_LATENCY_BUCKETS_MS.map((threshold) => [
          `le${threshold}ms`,
          this.#buckets.get(threshold) ?? 0
        ])
      )
    };
  }
}

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function controlEventLoopTurn(): Promise<void> {
  // A setImmediate scheduled from the check phase may resume before the next
  // poll phase. Two turns guarantee already-written socket data gets one poll
  // opportunity before another synchronous scheduler projection starts.
  await eventLoopTurn();
  await eventLoopTurn();
}

function signalMailboxKey(value: JsonValue): MailboxKey {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw controllerApplicationError("INVALID_PARAMS", "scheduler.signal params are invalid.");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  if (
    Object.keys(record).length !== 1
    || typeof record.key !== "string"
  ) {
    throw controllerApplicationError("INVALID_PARAMS", "scheduler.signal params are invalid.");
  }
  try {
    parseMailboxKey(record.key);
    return record.key as MailboxKey;
  } catch {
    throw controllerApplicationError("INVALID_PARAMS", "scheduler.signal params are invalid.");
  }
}

function requireEmptySchedulerConfigureParams(value: JsonValue): void {
  if (!isEmptyJsonObject(value)) {
    throw controllerApplicationError("INVALID_PARAMS", "scheduler.configure params are invalid.");
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return resolved;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number {
  const resolved = positiveInteger(value, fallback, label);
  if (resolved > maximum) {
    throw new TypeError(`${label} must be at most ${maximum}`);
  }
  return resolved;
}

function operatorMailboxBatchIdentity(
  mailbox: ReturnType<SchedulerStorePort["getWorkMailbox"]>
): string | null {
  const batch = mailbox?.processing?.batch
    ?? (mailbox === null || mailbox === undefined ? null : nextPendingBatch(mailbox));
  if (batch === null || batch === undefined) return null;
  return [
    batch.fromSequence,
    batch.toSequence,
    batch.firstQueuedAt,
    batch.lastQueuedAt
  ].join(":");
}

function schedulerResultJson(result: ControllerSchedulerResult): JsonValue {
  return JSON.parse(JSON.stringify(result)) as JsonValue;
}

function isEmptyJsonObject(value: JsonValue): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

function isGlobalOperatorSessionRequest(value: JsonValue): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Readonly<Record<string, JsonValue>>).scope === "global"
    && (value as Readonly<Record<string, JsonValue>>).roleName === "operator";
}

function isStartedRuntimeSessionResult(value: JsonValue): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Readonly<Record<string, JsonValue>>).sessionStarted === true;
}

function controllerApplicationError(
  code: "INVALID_PARAMS" | "METHOD_NOT_FOUND" | "NOT_FOUND" | "CONTROLLER_DRAINING",
  message: string
): Error {
  const error = Object.assign(new Error(message), { code });
  error.name = "CoreApplicationError";
  return error;
}

/** DurableJob records are validated plain data; normalize to a JsonValue. */
function jobControlJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
