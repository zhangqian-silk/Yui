import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import type { AgentRun, AgentRunFailureReason, AgentRunPurpose } from "../agentRun/agentRun.js";
import type { TaskBrief } from "../brief/taskBrief.js";
import type {
  MailboxEntityRef,
  MailboxTarget,
  ProcessingBatch,
  WorkMailbox
} from "../coordination/workMailbox.js";
import type {
  RoleRunDispatchSettlement,
  RoleRunDispatchToken
} from "../coordination/workMailboxQueue.js";
import type { Decision } from "../decision/decision.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { AgentSessionStatus } from "../executor/agentExecutor.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { Milestone } from "../milestone/milestone.js";
import type {
  AgentErrorInputDisposition,
  AgentErrorPhase,
  AgentErrorRegistrationDisposition,
  AgentErrorSessionDisposition,
  AgentErrorSource,
  ProviderDeliveryFailure
} from "../runtime/agentError.js";
import type {
  RuntimeLifecycleTarget,
  RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import type { RuntimeLaunchPreStart } from "../runtime/ports.js";
import type {
  RuntimeSessionCandidate,
  RuntimeSessionCandidateQuery
} from "../runtime/runtimeSessionCandidate.js";
import type { TaskRuntimeLaunchPolicy } from "../runtime/taskRuntimeIsolation.js";
import type { Task } from "../task/task.js";
import { taskOwnsManagedWorkspace } from "../task/task.js";
import {
  isTaskOwnedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import type { LeaderFailure } from "./leaderFailure.js";
import type { PendingWakeup } from "./pendingWakeup.js";

export type { RuntimeSessionCandidate } from "../runtime/runtimeSessionCandidate.js";

export type SchedulerTask = Readonly<Pick<
  Task,
  "id" | "title" | "status" | "executionGate" | "projectBindings" | "cwd"
> & {
  /** Explicit Activation intent, so a released deferral is visible to a pass. */
  activationRequest?: Task["activationRequest"];
}>;

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
}>;

export type SchedulerRun = AgentRun;

export type SchedulerRoleSession = Readonly<{
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  title?: string;
  status: AgentSessionStatus;
  endReason?: "stopped" | "failed";
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
}>;

export type SchedulerRoleResourceEvidence = Readonly<{
  observedAt: string;
  /** Exact producer Session; missing identity is never consumable progress evidence. */
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

/** Exact Role Session identity requested for one advisory resource sample. */
export type SchedulerRoleResourceInput = Readonly<{
  taskId: string;
  roleName: string;
  runId?: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
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

export type LeaderNotification = Readonly<{
  wakeId: string;
  attemptId: string;
  disposition: "submit" | "pending" | "unknown";
}>;

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

export type RoleRunDeliveryPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerRun;
  session: SchedulerRoleSession | null;
  now: Date;
}>;

export type RoleRunDeliveryFailurePersistence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: AgentAdapterId;
  runId: string;
  nativeSessionId?: string;
  /** Exact terminal explanation for this conclusively unaccepted delivery. */
  summary?: string;
  failureReason: AgentRunFailureReason;
  now: Date;
}>;

/**
 * Per-AgentRun progress facts folded from a Task's event history in one O(events)
 * pass. Stall reconciliation reads this current projection instead of
 * re-scanning history per AgentRun candidate.
 */
export type AgentRunProgressFacts = Readonly<{
  latestCheckpointAt?: string;
  latestActivityAt?: string;
  latestStall?: Readonly<{ progressAt: string; evidenceKey: string }>;
}>;

/**
 * TaskStore-facing scheduler boundary. The concrete adapter owns the exact
 * Role/session-set model and performs each multi-record persistence operation.
 */
export interface SchedulerStorePort {
  listTasks(): readonly SchedulerTask[];
  /**
   * Indexed active-Task selection for full Controller reconciliation. Stores
   * that do not expose the projection retain their existing selection path;
   * production SQLite storage provides it directly from `tasks_catalog`.
   */
  listActiveTaskIds?(): readonly string[];
  /**
   * Draft Task ids that already carry an active planning Turn. Planning is the
   * one purpose admitted before activation, so the phases that keep an admitted
   * Turn converging can resolve those Drafts without scanning Task history.
   * Optional: a store without the projection falls back to the full scan, which
   * still consults the durable Turn before admitting anything.
   */
  listPlanningDraftTaskIds?(): readonly string[];
  /**
   * Draft Task ids whose activation request is still pending. A deferral is
   * released by its planning Turn ending, which enqueues a mailbox signal — but
   * a Controller that was not running then, or that restarts before the signal
   * is acted on, has no dirty key to reconcile from. Full reconciliation reads
   * this projection instead, so a released request is recovered rather than
   * waiting for unrelated traffic on the Task.
   *
   * Optional: a store without the projection falls back to the full scan. The
   * request itself is still re-read at the adoption boundary, so this only
   * decides which Tasks are looked at, never whether one is adopted.
   */
  listPendingActivationRequestTaskIds?(): readonly string[];
  getTask(taskId: string): SchedulerTask | null;
  /** Durable Task-owned main workspace used to fence every active launch. */
  getTaskWorkspace(taskId: string): ManagedWorkspace | null;
  listRoles(taskId: string): readonly SchedulerRole[];
  getRole(taskId: string, roleName: string): SchedulerRole | null;
  getActiveRun(taskId: string, roleName: string): SchedulerRun | null;
  hasOpenInputRequest(taskId: string): boolean;
  listOpenInputRequests(taskIds?: readonly string[]): readonly InputRequest[];
  getInputRequest(taskId: string, inputRequestId: string): InputRequest | null;
  getOperatorDeliveryTarget(): SchedulerOperatorDeliveryTarget | null;
  /** Marks a submitted Operator turn busy until its exact native completion. */
  markOperatorRunStarted(now: Date): void;
  resolveExpiredInputRecommendations(
    now: Date,
    taskIds?: ReadonlySet<string>
  ): readonly AutoResolvedInput[];
  /** Persist exact tmux remain-on-exit evidence before rebuilding an Agent Host. */
  saveRoleHostExitObservation?(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    nativeSessionId?: string;
    deadStatus?: number;
    observedAt: Date;
  }>): void;
  getRoleSession(
    taskId: string,
    roleName: string,
    agentId?: string
  ): SchedulerRoleSession | null;
  /** Read-only Session projection used by orchestration observability. */
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
  listRuns?(taskId: string): readonly SchedulerRun[];
  listWorkItems?(taskId: string): readonly import("../workItem/workItem.js").WorkItem[];
  listReviewRounds?(taskId: string): readonly import("../review/reviewRound.js").ReviewRound[];
  listIntegrationAttempts?(taskId: string): readonly import("../integration/integrationAttempt.js").IntegrationAttempt[];
  listDurableJobs?(taskId: string): readonly import("../job/durableJob.js").DurableJob[];
  listInputRequests?(taskId: string): readonly import("../input/inputRequest.js").InputRequest[];
  listMessages?(taskId: string): readonly import("../message/message.js").TaskMessage[];
  /** Current fold of WorkItem/Review/Integration progress for a AgentRun. */
  getRunDurableProgress(taskId: string, roleName: string, runId: string): SchedulerRunProgress | null;
  /**
   * One-pass fold of a Task's event history for one AgentRun. Stall reconciliation
   * reads this projection instead of maintaining a second event-scan path.
   */
  getRunProgressFacts(taskId: string, runId: string): AgentRunProgressFacts | undefined;
  /** Materializes a newly observed related-record fold as one turn.progress fact. */
  recordRoleRunProgress?(input: RoleRunProgressPersistence): "recorded" | "already-recorded" | "state-changed";
  /** Closes one coalesced read-only runtime diagnostic window. */
  recordRoleRunDiagnostic?(input: RoleRunDiagnosticPersistence): "recorded" | "already-recorded" | "state-changed";
  /** Atomically records one advisory no-progress episode. */
  recordRoleRunStall?(input: RoleRunStallPersistence): "raised" | "already-raised" | "state-changed";
  /** Exact durable Provider writer; human/unknown ownership blocks Controller writes. */
  getProviderAuthorityFence?(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
    nativeSessionId: string;
  }>): Readonly<{
    conversationId: string;
    epoch: number;
    owner: "controller" | "human" | "none" | "unknown";
    holderId?: string;
  }> | null;
  peekNextRunId(taskId: string): string;

  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
  listWorkMailboxes(): readonly WorkMailbox[];
  /**
   * Mailboxes with a pending or processing batch, selected from the durable
   * ready-work projection. Production Controller full passes use this method
   * so empty historical mailboxes never enter reconciliation.
   */
  listReadyWorkMailboxes?(): readonly WorkMailbox[];
  claimWorkMailbox(input: SchedulerMailboxClaimInput): SchedulerMailboxClaimResult;
  /** Settles the exact ordinary Role dispatch after acceptance or terminalization. */
  settleRoleRunDispatch(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    expected?: RoleRunDispatchToken | null;
  }>): RoleRunDispatchSettlement;
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
  /** Queues physical Host cleanup while preserving its resumable Session. */
  enqueueRuntimeHostDetach?(
    owner: RuntimeRoleOwner,
    now?: Date,
    expectedDormantCandidate?: DormantRuntimeOwnerCandidate
  ): RuntimeLifecycleTarget | null;
  /** Non-stopped native sessions with no active Task AgentRun or lifecycle work. */
  listDormantRuntimeOwners?(): readonly DormantRuntimeOwnerCandidate[];
  /**
   * Current non-stopped Role Sessions from a storage-owned hot projection.
   * Historical RoleSessionSets must never be scanned to answer this query.
   */
  listRuntimeSessionCandidates?(
    query?: RuntimeSessionCandidateQuery
  ): readonly RuntimeSessionCandidate[];
  /** Persists one provider-neutral failure fact and wakes the responsible Agent. */
  recordAgentError?(input: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    source: AgentErrorSource;
    phase: AgentErrorPhase;
    message: string;
    raw: string;
    inputDisposition?: AgentErrorInputDisposition;
    sessionDisposition?: AgentErrorSessionDisposition;
    /**
     * Structured facts the failing operation knew and a message cannot carry:
     * the failure class, the innermost cause, the generation the caller
     * expected against the one the Host reported, and whether the durable
     * registration committed. Persisted alongside the record so a reader does
     * not have to parse them back out of prose.
     */
    errorName?: string;
    causeName?: string;
    hostState?: string;
    attemptId?: string;
    registrationDisposition?: AgentErrorRegistrationDisposition;
  }>, now: Date): string;
  queueTaskProgress(taskId: string, reason: string, now: Date): void;

  getPendingWakeup(taskId: string): PendingWakeup | null;
  listPendingWakeups(): readonly PendingWakeup[];
  /** Atomically appends one Leader signal without a read/merge/write race. */
  enqueueLeaderWakeup?(taskId: string, reason: string, now: Date): PendingWakeup | null;
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
  claimLeaderNotification(taskId: string, now: Date): LeaderNotification | null;
  prepareMessageContinuations?(taskId: string, now: Date): void;
  prepareDraftPlanning?(taskId: string, now: Date): boolean;
  settleLeaderNotification(taskId: string, attemptId: string,
    outcome: "accepted" | "deferred" | "rejected" | "unknown", now: Date, detail?: string): void;
  /** Persist a fixed Session discovered while preparing an undelivered AgentRun. */
  saveRoleRunPrepared(input: RoleRunDeliveryPersistence): void;
  /** Atomically fail one exact AgentRun after a conclusive Provider failure. */
  saveRoleRunDeliveryFailure(
    input: RoleRunDeliveryFailurePersistence
  ): "failed" | "state-changed";
}

/**
 * Whether the Task's workspace state admits a launch.
 *
 * A Task that owns no managed workspace — activated with an empty environment
 * plan, binding no Project — is admitted with no workspace record at all. The
 * scheduler must not wait for a worktree that was deliberately never created.
 * Every Task that does own one still needs the full ownership proof.
 *
 * A Draft planning conversation is a third case: the Task may already bind a
 * Project, yet activation has not run, so no worktree exists or is owed. It is
 * admitted with no workspace at all, and precisely because it has none it must
 * never be handed one implicitly — workspace preparation keeps the strictly
 * active selection, so a planning Draft never enters it.
 */
export function isSchedulerTaskWorkspaceReady(
  task: SchedulerTask,
  workspace: ManagedWorkspace | null | undefined,
  purpose?: AgentRunPurpose
): boolean {
  if (isSchedulerPlanningDraft(task, purpose)) {
    return workspace === null || workspace === undefined;
  }
  if (!taskOwnsManagedWorkspace(task)) {
    return workspace === null || workspace === undefined;
  }
  return isTaskOwnedWorkspace(
    workspace,
    task.id,
    task.cwd,
    task.projectBindings.map(({ projectId, directory }) => ({ projectId, directory }))
  );
}

/**
 * A Draft running a planning Turn: durable planning before activation.
 *
 * This is the single predicate every scheduler phase uses to tell that third
 * case apart, so admitting planning never widens to "a Draft is active". The
 * purpose comes from the durable Turn, never from a caller argument.
 */
export function isSchedulerPlanningDraft(
  task: Readonly<{ status: string }>,
  purpose: AgentRunPurpose | undefined
): boolean {
  return purpose === "planning" && task.status === "draft";
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
 *
 * With `includePlanningDrafts`, a Draft that already carries an active planning
 * Turn is resolved too. Planning is durable work owed to a Role, so the phases
 * that keep an admitted Turn converging — delivery, liveness, stall — must be
 * able to see it, or a Draft planning Turn could be dispatched and then never
 * re-delivered, resumed, or terminalized. The Draft is admitted only on the
 * evidence of its own durable planning Turn: `listPlanningDraftTaskIds` reads
 * the Turn, never the Task status alone, so an ordinary Draft with no planning
 * Turn stays invisible exactly as before. Phases that act on execution facts
 * (workspace preparation, integration, completion) keep the default and
 * therefore keep seeing active Tasks only.
 */
export function selectedActiveSchedulerTasks(
  store: Pick<
    SchedulerStorePort,
    "listTasks" | "listActiveTaskIds" | "getTask" | "listPlanningDraftTaskIds"
  >,
  selection?: SchedulerReconcileSelection,
  options?: Readonly<{ includePlanningDrafts?: boolean }>
): SchedulerTask[] {
  const planningDrafts = options?.includePlanningDrafts === true;
  const admits = (task: SchedulerTask | null): boolean => {
    if (task === null || task.executionGate.state !== "enabled") return false;
    if (task.status === "active") return true;
    return planningDrafts && hasActivePlanningRun(store, task);
  };
  if (selection === undefined || selection.full) {
    const indexedTaskIds = store.listActiveTaskIds?.();
    if (indexedTaskIds === undefined) {
      return store.listTasks().filter((task) => (
        admits(task) && !selection?.blockedTaskIds?.has(task.id)
      ));
    }
    // The active index is bounded and authoritative for active Tasks; planning
    // Drafts come from their own bounded index rather than a full-history scan.
    const taskIds = planningDrafts
      ? [...indexedTaskIds, ...(store.listPlanningDraftTaskIds?.() ?? [])]
      : [...indexedTaskIds];
    const seen = new Set<string>();
    return taskIds.flatMap((taskId) => {
      if (seen.has(taskId) || selection?.blockedTaskIds?.has(taskId)) return [];
      seen.add(taskId);
      const task = store.getTask(taskId);
      return admits(task) ? [task!] : [];
    });
  }
  const taskIds = selection.taskIds;
  return [...taskIds].flatMap((taskId) => {
    if (selection.blockedTaskIds?.has(taskId)) return [];
    const task = store.getTask(taskId);
    return admits(task) ? [task!] : [];
  });
}

/**
 * Whether a Draft carries an active planning Turn on any of its Roles. Read
 * from the durable active-Turn pointers, so a Draft is never admitted on its
 * status alone.
 */
function hasActivePlanningRun(
  store: Pick<SchedulerStorePort, "getTask">
    & Partial<Pick<SchedulerStorePort, "listRoles" | "getActiveRun">>,
  task: SchedulerTask
): boolean {
  if (task.status !== "draft") return false;
  const roles = store.listRoles?.(task.id) ?? [];
  return roles.some((role) => {
    const run = store.getActiveRun?.(task.id, role.name) ?? null;
    return run !== null
      && run.status === "active"
      && isSchedulerPlanningDraft(task, run.purpose);
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
  /** Durable AgentRun identity whose transient preparation this entry serves. */
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
   * Session (for example Codex); omission means preparation has not observed a
   * pre-readiness Session fact.
   */
  session?: SchedulerRoleSession | null;
}>;

export type ReadyRoleDelivery = Readonly<{
  prepared: PreparedRoleDelivery;
  /** Codex fresh launches remain null until runtime session registration. */
  session: SchedulerRoleSession | null;
}>;

export type RoleDeliveryStatus =
  | "sent"
  | "already-sent"
  | "pending"
  | "busy"
  | "rejected"
  | "delivery-unknown"
  | "unavailable";

/**
 * A delivery status plus the Host's original cause when it did not send.
 *
 * A bare status cannot say why a Provider write failed, so a caller holding
 * only the status was forced to substitute a guess. This is the single
 * delivery contract; there is no bare-status form.
 */
export type RoleDeliveryReport = Readonly<{
  status: RoleDeliveryStatus;
  failure?: ProviderDeliveryFailure;
}>;

/**
 * The Scheduler never reads stdin and never writes terminal bytes itself.
 * A tmux-owned Host implementation launches/resumes the role, establishes the
 * structured Provider control channel, and submits idempotent native Turns.
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
    /** The Task owns no workspace by design; see RuntimeLaunchPreparationRequest. */
    workspaceFree?: true;
    runtimePolicy?: TaskRuntimeLaunchPolicy;
    mode: RoleSessionLaunchMode;
    runId?: string;
    nativeSessionId?: string;
    beforeHostStart?: RuntimeLaunchPreStart;
  }>): Promise<PreparedRoleDelivery>;
  waitUntilReady(delivery: PreparedRoleDelivery): Promise<ReadyRoleDelivery>;
  sendOnce(input: Readonly<{
    delivery: ReadyRoleDelivery;
    /** Stable Provider request id. Repeating it must not create another AgentRun. */
    receiptId: string;
    text: string;
    notificationId?: string;
  }>): Promise<RoleDeliveryReport>;
  steerOnce(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    nativeTurnId: string;
    authority: import("../runtime/providerAuthorityFence.js").ProviderAuthorityFence;
    receiptId: string;
    text: string;
  }>): Promise<RoleDeliveryReport>;
  /**
   * Drops transient prepared bindings after authoritative terminal/absence
   * state. Omitting turnId clears every prepared Session for the Role.
   */
  forgetPrepared?(input: Readonly<{
    taskId: string;
    roleName: string;
    runId?: string;
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
