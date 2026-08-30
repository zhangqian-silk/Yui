import type { TaskBrief } from "../brief/taskBrief.js";
import type { Decision } from "../decision/decision.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { Milestone } from "../milestone/milestone.js";
import type { LeaderFailure } from "./leaderFailure.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import type { AgentRun } from "../run/agentRun.js";
import type { PendingProviderRetry } from "../run/providerRetry.js";
import type {
  MailboxEntityRef,
  MailboxTarget,
  MailboxLane,
  DeliveryMode,
  InputDelivery,
  ProcessingBatch,
  WorkMailbox
} from "../coordination/workMailbox.js";
import type {
  RuntimeLifecycleTarget,
  RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import type { Task } from "../task/task.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { RuntimeLaunchPreStart } from "../runtime/ports.js";
import {
  isTaskOwnedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import type { TaskRuntimeLaunchPolicy } from "../runtime/taskRuntimeIsolation.js";
import type {
  RuntimeSessionCandidate,
  RuntimeSessionCandidateQuery
} from "../runtime/runtimeSessionCandidate.js";

export type { RuntimeSessionCandidate } from "../runtime/runtimeSessionCandidate.js";

export type SchedulerTask = Readonly<Pick<
  Task,
  "id" | "title" | "status" | "projectBindings" | "cwd"
>>;

export type SchedulerRole = Readonly<{
  taskId: string;
  name: string;
  activeAgentId: string;
  adapterId: AgentAdapterId;
  model?: string;
  effort?: string;
  effective: EffectiveLaunchSnapshot;
  workspace: string;
  managedWorkspace?: ManagedWorkspace;
  status: "idle" | "running" | "detached" | "exited" | "failed";
}>;

export type SchedulerAgentRun = AgentRun;

export type SchedulerRoleSession = Readonly<{
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  /** Exact external-process generation, when runtime coordination recorded it. */
  launchId?: string;
  title?: string;
  status: "reserved" | "ready" | "running" | "stopped" | "broken";
  effective: EffectiveLaunchSnapshot;
  /** Last durable session transition, when the adapter can expose it. */
  updatedAt?: string;
}>;

export type RoleRunStallPersistence = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  agentId: string;
  adapterId: string;
  /** Exact Session fact observed by the scan; null is itself a fenced fact. */
  session: Readonly<{
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    launchId?: string;
    status: SchedulerRoleSession["status"];
  }> | null;
  kind: "delivery-stalled" | "workflow-not-progressing";
  classification: "truly-stalled";
  progressAt: string;
  idleMs: number;
  evidenceKey: string;
  now: Date;
}>;

export type SchedulerRunProgress = Readonly<{
  progressAt: string;
  evidence?: string;
}>;

/** One bounded advisory process sample carried by the full Role inventory. */
export type SchedulerRoleResourceIdentity = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
}>;

export type SchedulerRoleResourceEvidence = Readonly<{
  observedAt: string;
  /** Exact producer generation; missing identity is never consumable progress evidence. */
  identity?: SchedulerRoleResourceIdentity;
  /** Durable progress fence observed/requested for this sample. */
  progressAt?: string;
  /** Set by the inventory producer when one of the counters changed. */
  changed?: boolean;
  /** Explicit activity is advisory and never advances durable progress. */
  active?: boolean;
  cpuTimeMs?: number;
  rssBytes?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
}>;

export type SchedulerRoleResourceEntry = Readonly<{
  taskId: string;
  roleName: string;
  resource: SchedulerRoleResourceEvidence;
}>;

/** Exact Role generation identity requested for one advisory resource sample. */
export type SchedulerRoleResourceInput = Readonly<{
  taskId: string;
  roleName: string;
  runId?: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
  progressAt?: string;
}>;

export type RoleRunProgressPersistence = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  progressAt: string;
  evidence?: string;
  now: Date;
}>;

export type RoleRunDiagnosticPersistence = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  startedAt: string;
  outcome: "observed" | "observation-error";
  now: Date;
}>;

/**
 * Exact persisted session fact used to fence a low-frequency native-host
 * absence observation from a concurrent launch or Hook update.
 */
export type DormantRuntimeOwnerCandidate = Readonly<{
  owner: RuntimeRoleOwner;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  launchId?: string;
  sessionUpdatedAt: string;
}>;

export type SchedulerOperatorDeliveryTarget = Readonly<{
  roleName: "operator";
  adapterId: string;
}>;

export type AutoResolvedInput = Readonly<{
  inputRequestId: string;
  taskId: string;
  choiceKey: string;
}>;

/** Compiled Controller scope shared by scheduler processors. */
export type SchedulerReconcileSelection = Readonly<{
  full: boolean;
  taskIds: ReadonlySet<string>;
  allRoleTaskIds: ReadonlySet<string>;
  rolesByTask: ReadonlyMap<string, ReadonlySet<string>>;
  operator: boolean;
  /** Tasks whose scheduler phases are fenced for this bounded pass. */
  blockedTaskIds?: ReadonlySet<string>;
}>;

export type LeaderDispatchPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerAgentRun;
  session: SchedulerRoleSession | null;
  wakeup: PendingWakeup;
  /** The TaskWake record id this dispatch will persist (peeked before dispatch). */
  wakeId?: string;
  /** The delta window's exclusive lower bound for this wake. */
  wakeFromCursor?: string;
  now: Date;
}>;

export type LeaderDispatchClaimResult = "claimed" | "busy" | "unavailable" | "state-changed";

export type SchedulerMailboxClaimInput = Readonly<{
  target: MailboxTarget;
  batchId: string;
  owner: string;
  now: Date;
  executionRef?: MailboxEntityRef;
}>;

export type SchedulerMailboxClaimResult =
  | Readonly<{ status: "claimed" | "processing"; processing: ProcessingBatch }>
  | Readonly<{ status: "empty" }>;

export type SchedulerInputDeliveryClaimInput = Readonly<{
  target: Extract<MailboxTarget, { kind: "role" | "operator" }>;
  attemptId: string;
  lane: MailboxLane;
  mode: DeliveryMode;
  owner: string;
  now: Date;
  executionRef: MailboxEntityRef;
  providerFence: Readonly<{
    conversationId: string;
    activationId: string;
    nativeTurnId?: string;
  }>;
}>;

export type SchedulerInputDeliveryClaimResult =
  | Readonly<{ status: "claimed" | "delivery"; delivery: InputDelivery }>
  | Readonly<{ status: "empty" }>;

export type RoleRunDeliveryPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerAgentRun;
  session: SchedulerRoleSession | null;
  /** Matching external-process generation, when lifecycle coordination is enabled. */
  launchId?: string;
  now: Date;
}>;

export type RoleRunDeliveryFailurePersistence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: AgentAdapterId;
  runId: string;
  mailboxBatchId: string;
  nativeSessionId?: string;
  /** Exact external-process generation prepared for this undelivered Run. */
  launchId?: string;
  /** Exact terminal explanation when the failure is not retry exhaustion. */
  summary?: string;
  /** Whether the failed delivery also requires the local Host to be stopped. */
  cleanupRequired?: boolean;
  now: Date;
}>;

export type ExitedRoleRunPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerAgentRun;
  session: SchedulerRoleSession | null;
  summary: string;
  /** Static pre-accept failures fail closed instead of creating another Leader generation. */
  leaderRecovery: "automatic" | "blocked";
  now: Date;
}>;

export type LeaderDispatchFailurePersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  session: SchedulerRoleSession | null;
  claimed: Readonly<{ run: SchedulerAgentRun; wakeup: PendingWakeup }>;
  failure: LeaderFailure;
  now: Date;
}>;

/**
 * Per-Run progress facts folded from a Task's event history in one O(events)
 * pass. The stall reconciliation uses these to avoid re-scanning the whole
 * history per Run candidate; absent implementation falls back to per-Run
 * scans.
 */
export type RunProgressFacts = Readonly<{
  latestCheckpointAt?: string;
  latestActivityAt?: string;
  latestStall?: Readonly<{ progressAt: string; evidenceKey: string }>;
}>;

/**
 * FileTaskStore-facing scheduler boundary. The concrete adapter owns the exact
 * Role/session-set model and performs each multi-record persistence operation.
 */
export interface SchedulerStorePort {
  listTasks(): readonly SchedulerTask[];
  /**
   * Indexed active-Task selection for full Controller reconciliation. Stores
   * that do not expose the projection retain their existing selection path;
   * production layout-7 storage provides it directly from `tasks_catalog`.
   */
  listActiveTaskIds?(): readonly string[];
  getTask(taskId: string): SchedulerTask | null;
  /** Durable Task-owned main workspace used to fence every active launch. */
  getTaskWorkspace(taskId: string): ManagedWorkspace | null;
  listRoles(taskId: string): readonly SchedulerRole[];
  getRole(taskId: string, roleName: string): SchedulerRole | null;
  getActiveAgentRun(taskId: string, roleName: string): SchedulerAgentRun | null;
  hasOpenInputRequest(taskId: string): boolean;
  listOpenInputRequests(taskIds?: readonly string[]): readonly InputRequest[];
  getInputRequest(taskId: string, inputRequestId: string): InputRequest | null;
  getOperatorDeliveryTarget(): SchedulerOperatorDeliveryTarget | null;
  /** Marks a submitted Operator turn busy until its exact native completion. */
  markOperatorTurnStarted(now: Date): void;
  resolveExpiredInputRecommendations(
    now: Date,
    taskIds?: ReadonlySet<string>
  ): readonly AutoResolvedInput[];
  /**
   * Issue 04 durable in-place retry timer. Lists active Runs whose Provider
   * retry is due; the Controller arms its deadline timer from this projection.
   * Optional so adapters without the feature keep the old behavior.
   */
  listPendingProviderRetries?(taskIds?: readonly string[]): ReadonlyArray<PendingProviderRetry>;
  /**
   * Issue 04: reopens each due retry on its original Native Session, or
   * terminalizes a Run whose Session is proven dead. Returns the reopened Run
   * references. Optional so adapters without the feature keep the old behavior.
   */
  resolveDueProviderRetries?(
    now: Date,
    taskIds?: ReadonlySet<string>
  ): readonly string[];
  /** Persist exact tmux remain-on-exit evidence before rebuilding an Agent Host. */
  saveRoleHostExitObservation?(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    launchId?: string;
    nativeSessionId?: string;
    deadStatus?: number;
    observedAt: Date;
  }>): void;
  getRoleSession(
    taskId: string,
    roleName: string,
    agentId?: string
  ): SchedulerRoleSession | null;
  /** Read-only generation projection used by orchestration observability. */
  getTaskRoleSessionSet?(
    taskId: string,
    roleName: string
  ): import("../executor/agentExecutor.js").TaskRoleSessionSet | null;
  /** Immutable runtime facts used by the low-frequency stall projection. */
  listEvents?(taskId: string): readonly TaskEvent[];
  /**
   * Optional durable-record reads used by the actionability projection
   * (Issue 05). Absent implementations fall back to an empty family, which
   * yields a coarser digest; the fail-open rule covers computation errors.
   */
  listAgentRuns?(taskId: string): readonly SchedulerAgentRun[];
  listWorkItems?(taskId: string): readonly import("../workItem/workItem.js").WorkItem[];
  listReviewRounds?(taskId: string): readonly import("../review/reviewRound.js").ReviewRound[];
  listIntegrationAttempts?(taskId: string): readonly import("../integration/integrationAttempt.js").IntegrationAttempt[];
  listDurableJobs?(taskId: string): readonly import("../job/durableJob.js").DurableJob[];
  listInputRequests?(taskId: string): readonly import("../input/inputRequest.js").InputRequest[];
  listMessages?(taskId: string): readonly import("../message/message.js").TaskMessage[];
  /** Optional richer fold of WorkItem/Review/Integration progress for a Run. */
  getRunDurableProgress?(taskId: string, roleName: string, runId: string): SchedulerRunProgress | null;
  /**
   * Optional one-pass fold of a Task's event history for one Run. When present,
   * stall reconciliation uses these facts instead of re-scanning the whole
   * history per candidate. Absent implementation ⇒ per-Run scans.
   */
  getRunProgressFacts?(taskId: string, runId: string): RunProgressFacts | undefined;
  /** Materializes a newly observed related-record fold as one run.progress fact. */
  recordRoleRunProgress?(input: RoleRunProgressPersistence): "recorded" | "already-recorded" | "state-changed";
  /** Closes one coalesced read-only runtime diagnostic window. */
  recordRoleRunDiagnostic?(input: RoleRunDiagnosticPersistence): "recorded" | "already-recorded" | "state-changed";
  /** Atomically records one advisory no-progress episode. */
  recordRoleRunStall?(input: RoleRunStallPersistence): "raised" | "already-raised" | "state-changed";
  hasInFlightTurn(taskId: string, roleName: string): boolean;
  /** Exact durable Provider writer; human/unknown ownership blocks Controller writes. */
  getProviderAuthorityFence?(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
    launchId: string;
    nativeSessionId: string;
  }>): Readonly<{
    conversationId: string;
    activationId: string;
    epoch: number;
    owner: "controller" | "human" | "none" | "unknown";
    holderId?: string;
  }> | null;
  peekNextAgentRunId(taskId: string): string;
  /** Freeze the exact authoritative context before claiming a new Leader Run. */
  freezeLeaderContextSnapshot?(
    taskId: string,
    roleName: string,
    now: Date
  ): Readonly<{
    ref: import("../context/contextSnapshot.js").ContextSnapshotRef;
    deltaRefIds: readonly string[];
  }>;

  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
  listWorkMailboxes(): readonly WorkMailbox[];
  /**
   * Mailboxes with a pending or processing batch, selected from the durable
   * ready-work projection. Production Controller full passes use this method
   * so empty historical mailboxes never enter reconciliation.
   */
  listReadyWorkMailboxes?(): readonly WorkMailbox[];
  claimWorkMailbox(input: SchedulerMailboxClaimInput): SchedulerMailboxClaimResult;
  claimInputDelivery(input: SchedulerInputDeliveryClaimInput): SchedulerInputDeliveryClaimResult;
  markInputDeliveryPushed(target: MailboxTarget, attemptId: string, now: Date): boolean;
  completeInputDelivery(target: MailboxTarget, attemptId: string, now: Date): boolean;
  releaseInputDelivery(target: MailboxTarget, attemptId: string, now: Date): boolean;
  resolveInputDeliveryNotAccepted(target: MailboxTarget, attemptId: string, now: Date): boolean;
  markInputDeliveryUnknown(
    target: MailboxTarget,
    attemptId: string,
    reason: string,
    now: Date
  ): boolean;
  completeWorkMailbox(target: MailboxTarget, batchId: string): boolean;
  releaseWorkMailbox(target: MailboxTarget, batchId: string): boolean;
  /**
   * After a successful targeted stop, atomically clears both a launch
   * reservation and every coalesced cleanup request in its dedicated lane.
   */
  completeRuntimeCleanup?(
    target: Extract<
      MailboxTarget,
      { kind: "role-runtime" | "global-role-runtime" }
    >,
    now: Date
  ): boolean;
  /** Queues durable owner cleanup, optionally fenced by one dormant Session fact. */
  enqueueRuntimeCleanup?(
    owner: RuntimeRoleOwner,
    now?: Date,
    expectedDormantCandidate?: DormantRuntimeOwnerCandidate
  ): RuntimeLifecycleTarget | null;
  /** Atomically clears one confirmed-absent reservation and stops its session fact. */
  completeStoppedRuntimeReservation?(
    target: Extract<
      MailboxTarget,
      { kind: "role-runtime" | "global-role-runtime" }
    >,
    batchId: string,
    now: Date
  ): boolean;
  /** Non-stopped native sessions with no active Task Run or lifecycle work. */
  listDormantRuntimeOwners?(): readonly DormantRuntimeOwnerCandidate[];
  /**
   * Current non-stopped Role Sessions from a storage-owned hot projection.
   * Historical RoleSessionSets must never be scanned to answer this query.
   */
  listRuntimeSessionCandidates?(
    query?: RuntimeSessionCandidateQuery
  ): readonly RuntimeSessionCandidate[];
  /**
   * Persists a confirmed absent dormant owner only while its exact session
   * fact is still current and no launch, cleanup, or Task Run has appeared.
   */
  markRuntimeOwnerStopped?(
    candidate: DormantRuntimeOwnerCandidate,
    now: Date
  ): boolean;
  queueTaskProgress(taskId: string, reason: string, now: Date): void;

  getPendingWakeup(taskId: string): PendingWakeup | null;
  listPendingWakeups(): readonly PendingWakeup[];
  /** Atomically appends one Leader signal without a read/merge/write race. */
  enqueueLeaderWakeup?(taskId: string, reason: string, now: Date): PendingWakeup;
  /**
   * Atomically releases a stranded Leader execution and appends its recovery
   * signal. This prevents a concurrent signal from being lost between those
   * two mailbox transitions.
   */
  releaseLeaderWakeupAndEnqueue?(
    taskId: string,
    batchId: string,
    reason: string,
    now: Date
  ): boolean;
  savePendingWakeup(wakeup: PendingWakeup): void;
  clearPendingWakeup(taskId: string): void;
  /**
   * Records that a Leader wake was suppressed by scheduler single-flight
   * (the Role runtime lifecycle lane was busy). The wake stays durable and
   * is retried after the lane settles.
   */
  recordWakeSuppression?(taskId: string, reason: string, now: Date): void;

  getLeaderFailure(taskId: string): LeaderFailure | null;
  getTaskBrief(taskId: string): TaskBrief | null;
  listDecisions(taskId: string): readonly Decision[];
  listMilestones(taskId: string): readonly Milestone[];
  /**
   * Issue 04 (long-term): the minimal wake envelope for a Leader wake —
   * aggregated reason tags, the delta window, and read pointers. The Agent
   * reads delta content on demand with `yui task wake show`. Returns null
   * when no wake is pending. Optional so adapters without the feature keep
   * the full-context prompt.
   */
  getTaskWakeEnvelope?(
    taskId: string
  ): import("../context/wakeNotification.js").WakeEnvelope | null;
  /** Persist the AgentRun, active-run pointer, running Role and active fixed session. */
  saveLeaderDispatch(input: LeaderDispatchPersistence): LeaderDispatchClaimResult;
  /** Persist a fixed session discovered while preparing an undelivered Run. */
  saveRoleRunPrepared(input: RoleRunDeliveryPersistence): void;
  /** Persist successful delivery of a Work AgentRun and its fixed session. */
  saveRoleRunDelivery(input: RoleRunDeliveryPersistence): void;
  /** Atomically fail one exact prepared Run after conclusive non-delivery. */
  saveRoleRunDeliveryFailure(
    input: RoleRunDeliveryFailurePersistence
  ): "failed" | "state-changed";
  /** Persist LeaderFailure, its semantic attention event, and failed/broken runtime state. */
  saveLeaderDispatchFailure(input: LeaderDispatchFailurePersistence): "failed" | "state-changed";
  /** Fail the exact Run and its WorkItem or ReviewRound, clear active-run, and stop the Role session. */
  saveExitedRoleRun(input: ExitedRoleRunPersistence): "failed" | "state-changed";
}

export function isSchedulerTaskWorkspaceReady(
  task: SchedulerTask,
  workspace: ManagedWorkspace | null | undefined
): workspace is ManagedWorkspace {
  return isTaskOwnedWorkspace(
    workspace,
    task.id,
    task.cwd,
    task.projectBindings.map(({ projectId, directory }) => ({ projectId, directory }))
  );
}

/** Resolves Tasks without a global scan for a dirty reconciliation pass. */
export function selectedSchedulerTasks(
  store: Pick<SchedulerStorePort, "listTasks" | "getTask">,
  selection?: SchedulerReconcileSelection
): SchedulerTask[] {
  if (selection === undefined || selection.full) {
    return [...store.listTasks()].filter((task) => (
      !selection?.blockedTaskIds?.has(task.id)
    ));
  }
  return [...selection.taskIds].flatMap((taskId) => {
    if (selection.blockedTaskIds?.has(taskId)) return [];
    const task = store.getTask(taskId);
    return task === null ? [] : [task];
  });
}

/**
 * Resolves only active Tasks for Controller execution phases. Full passes use
 * the durable active index, so terminal history never enters Role, delivery,
 * workspace, or liveness projections. Dirty passes keep their exact-key
 * semantics and simply discard a Task that is no longer active.
 */
export function selectedActiveSchedulerTasks(
  store: Pick<SchedulerStorePort, "listTasks" | "listActiveTaskIds" | "getTask">,
  selection?: SchedulerReconcileSelection
): SchedulerTask[] {
  if (selection === undefined || selection.full) {
    const indexedTaskIds = store.listActiveTaskIds?.();
    if (indexedTaskIds === undefined) {
      return store.listTasks().filter((task) => (
        task.status === "active"
        && !selection?.blockedTaskIds?.has(task.id)
      ));
    }
    return [...indexedTaskIds].flatMap((taskId) => {
      if (selection?.blockedTaskIds?.has(taskId)) return [];
      const task = store.getTask(taskId);
      return task?.status === "active" ? [task] : [];
    });
  }
  const taskIds = selection.taskIds;
  return [...taskIds].flatMap((taskId) => {
    if (selection.blockedTaskIds?.has(taskId)) return [];
    const task = store.getTask(taskId);
    return task?.status === "active" ? [task] : [];
  });
}

/** Resolves either every Role in a selected Task or only explicit Role keys. */
export function selectedSchedulerRoles(
  store: Pick<SchedulerStorePort, "listRoles" | "getRole">,
  taskId: string,
  selection?: SchedulerReconcileSelection
): SchedulerRole[] {
  if (selection?.blockedTaskIds?.has(taskId)) return [];
  if (
    selection === undefined
    || selection.full
    || selection.allRoleTaskIds.has(taskId)
  ) {
    return [...store.listRoles(taskId)];
  }
  const names = selection.rolesByTask.get(taskId);
  if (names === undefined) return [];
  return [...names].flatMap((roleName) => {
    const role = store.getRole(taskId, roleName);
    return role === null ? [] : [role];
  });
}

export type RoleSessionLaunchMode = "new" | "resume";

export type PreparedRoleDelivery = Readonly<{
  deliveryId: string;
  /** External process generation; distinct from the per-Run delivery id. */
  launchId?: string;
  /** Durable Run identity whose transient preparation this entry serves. */
  runId?: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  mode: RoleSessionLaunchMode;
  /** The prepare request created a new external Role window/process. */
  sessionStarted: boolean;
  /**
   * Exact native Session reserved by preparation, when the provider exposes it
   * before readiness. `null` is meaningful for a fresh runtime-discovered
   * Session (for example Codex); omission preserves older delivery adapters
   * that do not expose a pre-readiness Session fact.
   */
  session?: SchedulerRoleSession | null;
  /** The launch workflow durably fenced and accepted this Run's first structured Turn. */
  turnAcceptedDuringLaunch?: boolean;
  /** Provider launch lost the exact acknowledgement for this Run's first Turn. */
  turnDeliveryUnknownDuringLaunch?: boolean;
  /** Another ordinary client has an active Turn; retry this Run later. */
  turnBusyDuringLaunch?: boolean;
  /** Provider definitively rejected this Run's first Turn during launch. */
  turnRejectedDuringLaunch?: boolean;
}>;

export type ReadyRoleDelivery = Readonly<{
  prepared: PreparedRoleDelivery;
  /** Codex fresh launches remain null until runtime session registration. */
  session: SchedulerRoleSession | null;
}>;

/**
 * The Scheduler never reads stdin and never writes terminal bytes itself.
 * A tmux-owned Host implementation launches/resumes the role, establishes the
 * structured Provider control channel, and performs receipt-backed delivery.
 */
export interface TmuxDeliveryPort {
  prepareRoleSession(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    effective: EffectiveLaunchSnapshot;
    workspace: string;
    managedWorkspace?: ManagedWorkspace;
    runtimePolicy?: TaskRuntimeLaunchPolicy;
    mode: RoleSessionLaunchMode;
    runId?: string;
    nativeSessionId?: string;
    beforeHostStart?: RuntimeLaunchPreStart;
  }>): Promise<PreparedRoleDelivery>;
  waitUntilReady(delivery: PreparedRoleDelivery): Promise<ReadyRoleDelivery>;
  sendOnce(input: Readonly<{
    delivery: ReadyRoleDelivery;
    receiptId: string;
    text: string;
  }>): Promise<
    "sent" | "already-sent" | "busy" | "rejected" | "delivery-unknown" | "unavailable"
  >;
  /**
   * Drops transient prepared bindings after authoritative terminal/absence
   * state. Omitting runId clears every prepared generation for the Role.
   */
  forgetPrepared?(input: Readonly<{
    taskId: string;
    roleName: string;
    runId?: string;
    launchId?: string;
  }>): void;
  /** Best-effort nudge to an already-running global Operator process. */
  notifyOperatorInputOnce?(input: Readonly<{
    roleName: "operator";
    adapterId: string;
    receiptId: string;
    text: string;
  }>): Promise<"sent" | "already-sent" | "unavailable" | "not-ready">;
  inspectRole(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"present" | "absent">;
  /** Full-reconciliation safety probe for a missing native Turn Hook. */
  inspectRoleReadiness?(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"ready" | "busy" | "absent">;
  inspectRoles?(inputs: readonly Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    runId?: string;
    launchId?: string;
    progressAt?: string;
  }>[], resourceInputs?: readonly SchedulerRoleResourceInput[]):
    Promise<readonly Readonly<{
      taskId: string;
      roleName: string;
      status: "present" | "absent";
      resource?: SchedulerRoleResourceEvidence;
      hostExit?: Readonly<{ deadStatus?: number }>;
    }>[]>;
  /** Retryable stale lifecycle cleanup for one exact Task Role pane. */
  stopRole?(taskId: string, roleName: string): Promise<boolean>;
}
