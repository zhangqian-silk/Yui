import type { ConfiguredAgent } from "../agent/agent.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRunAssignment } from "../context/runContextContract.js";
import {
  buildRunContextPack,
  buildRunContextDelta,
  contextSnapshotDeltaRefIds,
  expandRunContextRef,
  freezeRunContextSnapshot
} from "../context/runContextPack.js";
import { contextSnapshotRef } from "../context/contextSnapshot.js";
import {
  CliError,
  dataError,
  roleNotFound,
  runtimeError,
  taskNotFound,
  usageError
} from "../errors/cliError.js";
import { createTaskEvent, type TaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import {
  clearMatchingLeaderStallAttention,
  isRoleRunStalled,
  RUN_PROGRESS_EVENT,
  RUN_RECOVERED_EVENT
} from "../scheduler/roleRunStall.js";
import { readCommandText } from "./textInput.js";
import {
  assertTaskCompletionPublishedTreeProof,
  type TaskCompletionPublishedTreeProof
} from "./taskCompletionGate.js";
import {
  createRoleSessionSet,
  roleAgentSessionResumeMode,
  updateTaskRoleProviderRuntime,
  updateRoleAgentSessionStatus,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  currentProviderActivation,
  transferProviderAuthority
} from "../runtime/providerRuntimeIdentity.js";
import type { ProviderAuthorityFence } from "../runtime/providerAuthorityFence.js";
import {
  resolveEffectiveLaunch,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatTimestamp } from "../output/timePresentation.js";
import { renderRoleDetails } from "../output/rolePresentation.js";
import {
  createTaskMessage,
  taskMessageAuthorLabel,
  type TaskMessage,
  type TaskMessageAuthor,
  type TaskMessageContext,
  type TaskMessageKind
} from "../message/message.js";
import type {
  TaskRetirementProof,
  WorkItemIntegrationProof
} from "../workspace/workItemChangeSetManager.js";
import { cancelInputRequest } from "../input/inputRequest.js";
import {
  recoverExactAgentRun,
  terminalizeExactTaskRun,
  validateExactRunReviewRound,
  type ExactAgentRunRecoveryAction
} from "../lifecycle/exactRunTerminalization.js";
import { resetTaskRoleSessionGeneration } from "../lifecycle/taskRoleSessionReset.js";
import {
  activeRoleAgentBinding,
  copyGlobalRoleToTaskRole,
  createRole,
  createRoleAgentBinding,
  switchActiveRoleAgent,
  unbindRoleAgent,
  updateRole,
  updateRoleStatus,
  type GlobalRole,
  type Role
} from "../role/role.js";
import {
  agentRunDeliveryReceiptId,
  createAgentRun,
  failAgentRun,
  withAgentRunContextSnapshot,
  yieldAgentRun,
  type AgentRun
} from "../run/agentRun.js";
import {
  projectRunRecovery,
  readRunRecoveryFacts,
  type RunRecoveryProjection
} from "../run/recoveryProjection.js";
import { matchYieldReceipt } from "../run/yieldReceipt.js";
import {
  createReviewRound,
  createTaskReviewRound,
  createTaskDeltaReviewRound,
  attachReviewExecutionGroup,
  deltaRecheckBlocksAcceptance,
  finishReviewRound,
  parseReviewYieldReport,
  recordReviewWorkspaceDisposition,
  retryTaskReviewRound,
  startReviewRound,
  updateReviewExecutionGroup,
  validateTaskReviewCandidate,
  type ReviewRound,
  type TaskReviewCandidate,
  type ReviewRequestSource
} from "../review/reviewRound.js";
import {
  buildDeltaRecheckDispatchContext,
  verifyDeltaRecheckDiff,
  type DeltaRecheckPreflight
} from "../review/deltaRecheck.js";
import {
  buildTaskFinalReviewFindingContext,
  dispositionReviewFinding,
  planRepairGroups,
  reconcileReviewFindings,
  reconcileReviewFindingsAfterReview,
  type ReviewFindingDispositionCommand
} from "../review/reviewFindingLedger.js";
import {
  LEADER_FINDING_DISPOSITIONS,
  type ReviewFindingDisposition
} from "../review/reviewFinding.js";
import { createTaskBrief, updateTaskBrief } from "../brief/taskBrief.js";
import { createDecision, supersedeDecision } from "../decision/decision.js";
import { createMilestone } from "../milestone/milestone.js";
import { runPublicationCommand } from "./taskPublicationCommands.js";
import {
  enqueueWork,
  requireCompleteWorkExecution,
  settleExactWorkExecution
} from "../coordination/workMailboxQueue.js";
import {
  mailboxHasWork as workMailboxHasWork,
  nextPendingBatch,
  type MailboxEntityRef,
  type MailboxTarget
} from "../coordination/workMailbox.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import {
  blockingProviderContinuations,
  projectProviderContinuations
} from "../runtime/runtimeContinuationProjection.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";
import {
  activateTask,
  addTaskProjectBinding,
  archiveTask,
  completeTask,
  createTask,
  retireTask,
  reopenTask,
  updateTaskMetadata,
  type TaskCompletedBy,
  type Task,
  type TaskMetadata,
  type TaskProjectBinding,
  type TaskPriority
} from "../task/task.js";
import {
  formatAgentRunReceiptId,
  resolveTaskRecordReference
} from "../task/taskRecordReference.js";
import { TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT } from "../task/publicationReference.js";
import {
  projectCompletionReadiness,
  type CompletionBlocker
} from "../task/completionReadiness.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { AgentProfile } from "../profile/agentProfile.js";
import { resolveProject, type Project } from "../repository/project.js";
import { acquireProjectMaintenanceLocks } from "../repository/projectMaintenanceLock.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { TmuxRolePaneState } from "../tmux/tmuxManager.js";
import {
  currentWorkItemCandidate,
  governingWorkItemCandidate,
  currentWorkItemExecutionGroup,
  workItemExecutionGroupById,
  createWorkItem,
  attachWorkItemExecutionGroup,
  updateWorkItemExecutionGroup,
  retireWorkItem,
  retryFailedWorkItem,
  submitWorkItemCandidate,
  updateWorkItemWriteProjects,
  updateWorkItemStatus,
  type WorkItem,
  type WorkItemProjectBaseRef,
  type CandidateGitSnapshot,
  type DirectTaskMainSnapshot,
  type WorkItemCandidate,
  type WorkItemStatus
} from "../workItem/workItem.js";
import {
  addExecutionLane,
  createExecutionGroup,
  recordExecutionLaneResult,
  resolveExecutionGroup,
  restartExecutionLane,
  updateExecutionLane,
  type ExecutionGroup,
  type ExecutionLaneGitSnapshot,
  type ExecutionStrategy,
  type ExecutionLaneWorkspace,
  type ExecutionTarget
} from "../execution/executionGroup.js";
import {
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import {
  sameTaskFinalReviewContract,
  taskFinalReviewConfig,
  validateTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import { managedWorkspaceKey } from "../worktree/managedWorkspace.js";
import {
  hasAgentConfigOptions,
  parseRoleOptions,
  patchRoleAgentBinding,
  roleOptionSpecs,
  roleProfilePatch
} from "./roleConfiguration.js";
import {
  hasRoleLaunchContextOptions,
  validateConfiguredRoleSkills
} from "./roleSkillValidation.js";
import { assertRoleRuntimeMutationAllowed } from "./roleRuntimeGuard.js";
import { runTaskContextCommand } from "./taskContextCommand.js";
import { runTaskNextActionCommand } from "./taskNextActionCommand.js";
import {
  runDeliveryGuardPreflight,
  withGuardWarnings
} from "./deliveryGuardPreflight.js";
import {
  inspectTaskRoleRuntimeStatuses,
  renderTaskRoleRuntimeStatus,
  taskRoleActiveWorkLabel,
  taskRoleLastRunLabel,
  taskRoleNativeSessionLabel,
  taskRoleOpenInputLabel,
  taskRoleTmuxLabel
} from "./taskRoleRuntimeStatus.js";
import {
  assertNoOpenInputRequests,
  openInputRequestCount,
  runTaskInputCommand
} from "./taskInputCommands.js";
import { runGrantCommand } from "./grantCommands.js";
import { runWorkflowCommand } from "./workflowCommands.js";
import {
  taskActor as resolveTaskActor,
  taskLeaderActionRunId
} from "./taskActor.js";
import { createTaskTerminalNotification } from "../scheduler/operatorNotification.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import { renderWakeReason, wakeReason } from "../scheduler/wakeReason.js";
import {
  collectTaskActionability,
  computeActionabilityDigest,
  deriveLeaderRunDisposition
} from "../scheduler/actionability.js";
import { buildTaskExecutionProjection } from "../scheduler/taskExecutionProjection.js";
import {
  buildTaskOverview,
  parseTaskListOptions,
  renderTaskOverview
} from "./taskOverviewCommand.js";

const LEADER_ROLE = "leader";

/** Exact Task-final identity or evidence changed between queueing and dispatch. */
export class TaskFinalReviewDispatchDriftError extends CliError {
  constructor(message: string, source?: CliError) {
    super(
      source?.code ?? "USAGE_ERROR",
      message,
      source?.helpText,
      source?.details
    );
    this.name = "TaskFinalReviewDispatchDriftError";
  }
}

/** Process-local command metadata; symbols never enter JSON output or durable state. */
export const RESUMED_PENDING_FINAL_REVIEW = Symbol("resumed-pending-final-review");
export const TERMINALIZED_LEADER_BEFORE_FINAL_REVIEW = Symbol(
  "terminalized-leader-before-final-review"
);

function taskFinalReviewDispatchDrift(error: unknown): TaskFinalReviewDispatchDriftError {
  return new TaskFinalReviewDispatchDriftError(
    error instanceof Error ? error.message : String(error),
    error instanceof CliError ? error : undefined
  );
}

/** `final` is a Task delivery policy, not a per-WorkItem ReviewRound rule. */
function legacyWorkItemReviewConfig(
  config: ReviewConfig | null
): ReviewConfig | null {
  return config?.trigger === "final" ? null : config;
}

function storedTaskFinalReviewContract(
  store: TaskWorkflowStore,
  taskId: string
): TaskFinalReviewContract | undefined {
  const contracts = store.listWorkItems(taskId)
    .flatMap((item) => {
      const candidate = governingWorkItemCandidate(item);
      return candidate?.taskFinalReviewContract === undefined
        ? []
        : [candidate.taskFinalReviewContract];
    });
  const first = contracts[0];
  if (first === undefined) return undefined;
  validateTaskFinalReviewContract(first);
  if (contracts.some((contract) => !sameTaskFinalReviewContract(first, contract))) {
    throw dataError(`Task ${taskId} contains conflicting final-review contracts.`);
  }
  return first;
}

/**
 * Resolve one exact Task-local contract before the caller performs any write.
 * Once a Candidate has established the contract, every later Candidate,
 * acceptance, and completion mutation must present the same verified
 * capability; shared review-config drift is intentionally irrelevant.
 */
function taskFinalReviewContractForMutation(
  store: TaskWorkflowStore,
  taskId: string,
  options: TaskCommandOptions,
  authorization: Readonly<{ allowStoredWithoutSupplied?: boolean }> = {}
): TaskFinalReviewContract | undefined {
  const supplied = options.taskFinalReviewContract;
  if (supplied !== undefined) {
    validateTaskFinalReviewContract(supplied);
    if (supplied.taskId !== taskId) {
      throw usageError(
        `Task final-review contract Task id mismatch: expected ${taskId}, found ${supplied.taskId}.`
      );
    }
  }
  const stored = storedTaskFinalReviewContract(store, taskId);
  if ((stored ?? supplied) !== undefined
    && requireTask(store, taskId).projectBindings.length === 0) {
    throw usageError(
      `Task final-review contract requires a Project-backed Task: ${taskId}.`
    );
  }
  if (stored === undefined) return supplied;
  if (supplied === undefined) {
    if (authorization.allowStoredWithoutSupplied === true) return stored;
    throw usageError(`Task final-review contract is missing for ${taskId}.`);
  }
  if (!sameTaskFinalReviewContract(stored, supplied)) {
    throw usageError(`Task final-review contract control-plane digest mismatch for ${taskId}.`);
  }
  return stored;
}

export type TaskCommandExecution =
  | Readonly<{ kind: "output"; output: string; data?: unknown }>
  | Readonly<{
      kind: "view";
      taskId: string;
      roleName: string;
      access: "read-only";
      output?: string;
    }>
  | Readonly<{
      kind: "authority";
      action: "takeover" | "release";
      taskId: string;
      roleName: string;
      launchId: string;
      nativeSessionId: string;
      authority: ProviderAuthorityFence;
      output: string;
    }>;

/**
 * The command layer only persists intent. It never launches an Agent, writes
 * terminal bytes, or attaches a tmux client.
 */
export type TaskWorkflowRuntimePort = Readonly<{
  notifyStateChanged(taskId: string): void;
  notifyMailboxChanged?(target: MailboxTarget): void;
  reconcileTask(taskId: string): void;
  inspectTaskRolePanes?(taskId: string): readonly TmuxRolePaneState[];
}>;

export type TaskWorkflowStore = TaskStore;

export type TaskCommandOptions = Readonly<{
  runtime?: TaskWorkflowRuntimePort;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  yuiHome?: string;
  /** Completion CLI parsing may read stdin/files before remote reconciliation. */
  completionSummary?: string;
  /** Explicit Git/publication proof prepared before completion mutation. */
  completionPublishedTreeProof?: TaskCompletionPublishedTreeProof;
  workItemIntegrationProof?: WorkItemIntegrationProof;
  candidateGitSnapshot?: CandidateGitSnapshot;
  /** Managed Candidate workspace; null is an explicit Gitless/no-workspace preflight. */
  candidateWorkspace?: ManagedWorkspace | null;
  directTaskMainSnapshot?: DirectTaskMainSnapshot;
  /** Prepared by the repository/workspace lifecycle before command mutation. */
  executionLaneWorkspaces?: ReadonlyMap<string, ManagedWorkspace>;
  /**
   * Under-fence Project path snapshot captured when a new Group's Lane
   * workspaces were prepared. The dispatch aggregate CAS revalidates the Task
   * binding set and exact Project paths against it, so a project migrate in
   * the prepare/adopt gap fails closed instead of stranding a Lane on the
   * external checkout. Undefined when no fence is held (existing Group).
   */
  laneDispatchProjectPaths?: ReadonlyMap<string, string>;
  /** Frozen managed workspace heads captured immediately before Lane yield. A
   * null value is an explicit preflight result for a Gitless/read-only Lane. */
  executionLaneGitSnapshot?: ExecutionLaneGitSnapshot | null;
  reviewWorkspaceResult?: Readonly<{
    evidenceCommit?: string;
  }>;
  taskRetirementProof?: TaskRetirementProof;
  /** Verified by exact CLI preflight; never reconstructed from process.env. */
  taskFinalReviewContract?: TaskFinalReviewContract;
  /** Physical Task-main heads verified by the CLI immediately before mutation. */
  actualTaskReviewCandidate?: TaskReviewCandidate;
  /** Issue 07: CLI-verified delta-recheck assessment for `task review request --delta-recheck`. */
  deltaRecheckPreflight?: DeltaRecheckPreflight;
  /** Issue 07: per-Project diff text for a delta-recheck dispatch, digest-verified. */
  deltaRecheckDiff?: Readonly<Record<string, string>>;
}>;

export type TaskCompletionPreflight = Readonly<{
  task: Task;
  actor: TaskCompletedBy;
  completed: boolean;
  /** Existing Task-final ReviewRound must use the normal resume/block path. */
  activeTaskReview: boolean;
  taskFinalReviewContract?: TaskFinalReviewContract;
}>;

export function parseTaskCompletionRequest(
  args: string[],
  summaryOverride?: string
): Readonly<{
  taskId: string;
  summary: string;
  acceptedPublishedTreePublicationId?: string;
}> {
  const usage = "Task complete usage: yui task complete <id> (--summary <text>|--summary-file <path|->) [--refresh-remote] [--accept-published-tree <publication-id>].";
  const parsed = parseTail(
    args,
    new Set(["--summary", "--summary-file", "--accept-published-tree"]),
    usage,
    new Set(["--refresh-remote"])
  );
  exactPositionals(parsed.positionals, 1, usage);
  const inlineSummary = parsed.options.get("--summary");
  const summaryFile = parsed.options.get("--summary-file");
  if ((inlineSummary === undefined) === (summaryFile === undefined)) {
    throw usageError(`Specify exactly one of --summary or --summary-file.`, usage);
  }
  const summary = summaryOverride ?? readCommandText(
    inlineSummary,
    summaryFile,
    "--summary",
    usage
  );
  const acceptedPublishedTreePublicationId = parsed.options.get("--accept-published-tree");
  return {
    taskId: parsed.positionals[0]!,
    summary,
    ...(acceptedPublishedTreePublicationId === undefined
      ? {}
      : { acceptedPublishedTreePublicationId })
  };
}

/**
 * Check every read-only completion blocker before a caller resolves remote
 * baselines or creates an Integration Attempt.  The transactional completion
 * path invokes this same preflight and then repeats its checks while holding
 * the store write fence, so remote reconciliation can never get ahead of the
 * local lifecycle/readiness gate.
 *
 * Issue 06: the blocker enumeration is the pure `projectCompletionReadiness`
 * projection, shared with `task next-action` so the Leader sees every
 * terminalization precondition before attempting completion.  All blockers
 * are reported in one error instead of one per attempt.
 */
export function preflightTaskCompletion(
  taskId: string,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {},
  request: Readonly<{ acceptedPublishedTreePublicationId?: string }> = {}
): TaskCompletionPreflight {
  const task = requireTask(store, taskId);
  const actor = taskActor(options, task.id);
  if (task.status === "completed") {
    return { task, actor, completed: true, activeTaskReview: false };
  }
  if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
  if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);

  // Resolve and authenticate the durable Task-local gate before any remote
  // fetch or Integration write.  All checks below mirror the transactional
  // completion path, which remains the final CAS fence after reconciliation.
  // A human/global Operator cannot present the exact managed Leader contract.
  // For the explicit published-tree path only, let that caller authenticate
  // the stored contract far enough to persist an exact authorization fact.
  // The same command must return before any contract-governed completion
  // mutation; the exact Leader later consumes the authorization with the real
  // contract capability.
  const authorizingPublishedTree = request.acceptedPublishedTreePublicationId !== undefined
    && actor !== "leader";
  const taskFinalReviewContract = taskFinalReviewContractForMutation(
    store,
    task.id,
    options,
    { allowStoredWithoutSupplied: authorizingPublishedTree }
  );
  const activeTaskReview = store.listReviewRounds(task.id).some((round) => (
    (round.scope ?? "work-item") === "task"
    && (round.status === "pending" || round.status === "running")
  ));
  // Issue 06: one shared readiness projection enumerates every blocker.
  const readinessFacts = store.readCompletionReadinessFacts(task.id);
  if (readinessFacts === null) throw taskNotFound(task.id);
  // The finding ledger gate is intentionally deferred: the transactional
  // completion path runs it after `prepareFinalTaskReview`, which may create
  // the Task-final Review that resolves `fixed-pending-review` findings.
  const readiness = projectCompletionReadiness(readinessFacts, { findingsGate: false });
  // An active Task-final Review is not a preflight failure: the transactional
  // path resumes a pending Round (or reports the running one) via
  // `prepareFinalTaskReview`, and the CLI skips remote reconciliation while
  // `activeTaskReview` is true.  The blocker stays in the shared projection
  // so other surfaces (next-action, future readers) see the full rule set.
  const blockers = readiness.blockers.filter((blocker) => blocker.code !== "active-task-review");
  if (blockers.length > 0) {
    throw usageError(formatCompletionBlockers(task.id, blockers));
  }

  const roles = store.listRoles(task.id);
  const activeRuns = roles
    .map((role) => ({ role, run: store.getActiveAgentRun(task.id, role.name) }))
    .filter((entry): entry is { role: Role; run: AgentRun } => entry.run !== null);

  const leaderEntry = activeRuns.find(({ role }) => role.name === LEADER_ROLE);
  if (leaderEntry !== undefined) {
    if (actor !== "leader") {
      throw usageError(`Task ${task.id} has an active Leader run.`);
    }
    if (leaderEntry.run.workItemId !== undefined) {
      throw usageError(`Task ${task.id} has running work: ${leaderEntry.run.workItemId}.`);
    }
    if (leaderEntry.run.pushedAt === undefined) {
      throw usageError(`Task ${task.id} Leader delivery is still pending.`);
    }
  }

  return {
    task,
    actor,
    completed: false,
    activeTaskReview,
    ...(taskFinalReviewContract === undefined ? {} : { taskFinalReviewContract })
  };
}

/**
 * Issue 06: format every completion blocker into one fail-closed error so the
 * Leader sees the full remaining work instead of one blocker per attempt.
 */
function formatCompletionBlockers(taskId: string, blockers: readonly CompletionBlocker[]): string {
  const lines = blockers.map((blocker) =>
    `  ${blocker.code} (${blocker.ref.kind} ${blocker.ref.id}): ${blocker.reason}`
    + ` — fix: ${blocker.fix}`
  );
  return `Task ${taskId} cannot complete: ${blockers.length} blocker(s) remain.\n${lines.join("\n")}`;
}

export function runTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): TaskCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "create": return createTaskCommand(rest, store, options);
    case "update": return output(updateTaskCommand(rest, store, options));
    case "list": return listTaskCommand(rest, store);
    case "show": return showTaskCommand(rest, store);
    case "context": return runTaskContextCommand(rest, store);
    case "next-action": return runTaskNextActionCommand(rest, store);
    case "activate": return output(activateTaskCommand(rest, store, options));
    case "complete": return completeTaskCommand(rest, store, options);
    case "reopen": return output(reopenTaskCommand(rest, store, options));
    case "archive": return output(archiveTaskCommand(rest, store, options));
    case "retire": return retireTaskCommand(rest, store, options);
    case "reconcile": return output(reconcileTaskCommand(rest, store, options));
    case "message": return output(taskMessageCommand(rest, store, options));
    case "wake": return taskWakeDispatch(rest, store, options);
    case "project": return taskProjectCommand(rest, store, options);
    case "input": return runTaskInputCommand(rest, store, options);
    case "grant": return runGrantCommand(rest, store, options);
    case "workflow": return runWorkflowCommand(rest, store, options);
    case "publication": return runPublicationCommand(rest, store, options);
    case "role": return taskRoleCommand(rest, store, options);
    case "work": return taskWorkCommand(rest, store, options);
    case "review": return taskReviewCommand(rest, store, options);
    case "run": return taskRunCommand(rest, store, options);
    case "brief": return taskBriefCommand(rest, store, options);
    case "decision": return taskDecisionCommand(rest, store, options);
    case "milestone": return taskMilestoneCommand(rest, store, options);
    case "event": return taskEventCommand(rest, store);
    case "continuation": return taskContinuationCommand(rest, store);
    default:
      throw usageError(command === undefined
        ? "Task command is required."
        : `Unknown command: task ${command}`);
  }
}

/**
 * The single Lane-role plan shared by CLI preflight and dispatch mutation.
 * For a new Group the WorkItem assignee is the implicit first Lane unless it
 * was already supplied. During adaptive expansion the explicit roles are the
 * new Lanes; the existing assignee is not re-added.
 */
export function normalizedExecutionLaneRoles(
  assignee: string,
  requestedRoles: readonly string[],
  expanding = false
): readonly string[] {
  if (expanding) return [...requestedRoles];
  if (requestedRoles.length === 0) return [assignee];
  return requestedRoles[0] === assignee
    ? [...requestedRoles]
    : [assignee, ...requestedRoles];
}

export type NormalizedExecutionLanePlan = Readonly<{
  expanding: boolean;
  roles: readonly string[];
  strategy: ExecutionStrategy;
  capacity: number;
  requestedCount: number;
  laneIds: readonly string[];
}>;

/** Derive the complete Worker Lane plan once for both preflight and mutation. */
export function normalizedExecutionLanePlan(input: Readonly<{
  assignee: string;
  requestedRoles: readonly string[];
  requestedStrategy?: ExecutionStrategy;
  existingGroup?: Pick<ExecutionGroup, "id" | "lanes" | "strategy">;
  status: WorkItemStatus;
  nextGroupId: string;
  retryLaneId?: string;
  phase?: "dispatch" | "retry";
}>): NormalizedExecutionLanePlan {
  const retry = input.phase === "retry" || input.retryLaneId !== undefined;
  const expanding = !retry && input.status === "running" && input.existingGroup !== undefined;
  const roles = retry
    ? []
    : normalizedExecutionLaneRoles(input.assignee, input.requestedRoles, expanding);
  const strategy = input.existingGroup?.strategy
    ?? input.requestedStrategy
    ?? { mode: "fixed", count: roles.length };
  const capacity = strategy.mode === "fixed" ? strategy.count : strategy.max;
  const requestedCount = retry
    ? input.existingGroup?.lanes.length ?? 0
    : expanding
      ? input.existingGroup!.lanes.length + roles.length
      : roles.length;
  const laneIds = input.retryLaneId !== undefined
    ? [input.retryLaneId]
    : retry
      ? []
      : input.existingGroup === undefined
      ? roles.map((_, index) => `${input.nextGroupId}-lane-${index + 1}`)
      : roles.map((_, index) => `${input.existingGroup!.id}-lane-${input.existingGroup!.lanes.length + index + 1}`);
  return { expanding, roles, strategy, capacity, requestedCount, laneIds };
}

function taskProjectCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") {
    exactPositionals(rest, 1, "Task project list usage: yui task project list <task>.");
    const task = requireTask(store, rest[0]);
    const rendered = task.projectBindings.length === 0
      ? `Task ${task.id} has no Projects.\n`
      : `${renderTable(
          `Task Projects: ${task.id}`,
          [
            { header: "Directory", minWidth: 8, maxWidth: 24 },
            { header: "Project", minWidth: 8, maxWidth: 24 },
            { header: "Base", minWidth: 6, maxWidth: 36 }
          ],
          task.projectBindings.map(({ directory, projectId, baseRef }) => [
            directory, projectId, baseRef
          ]),
          defaultTableWidth()
        )}\n`;
    return output(rendered, { projectBindings: task.projectBindings });
  }
  if (command !== "add") {
    throw usageError(command === undefined
      ? "Task project command is required."
      : `Unknown command: task project ${command}`);
  }
  const usage = "Task project add usage: yui task project add <task> <project> [--base <ref>] [--directory <name>].";
  const parsed = parseTail(rest, new Set(["--base", "--directory"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const now = clock(options);
  const updated = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    assertTaskOpen(task);
    if (task.status === "active" && taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may add a Project to an active Task.");
    }
    const project = resolveProject(tx.listProjects(), parsed.positionals[1]);
    if (project === null) throw usageError(`Project not found: ${parsed.positionals[1]}.`);
    const next = addTaskProjectBinding(task, {
      projectId: project.id,
      directory: parsed.options.get("--directory") ?? project.name,
      baseRef: parsed.options.get("--base") ?? project.developmentBranch
    }, now);
    tx.saveTask(next);
    recordTaskEvent(tx, task.id, "task.project-added", {
      projectId: project.id,
      directory: next.projectBindings.at(-1)!.directory
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "task-project-added", now, [taskRef(task.id)]);
    if (task.status === "active") {
      enqueueWork(tx, leaderMailbox(task.id), "task-project-added", now, [taskRef(task.id)]);
    }
    return next;
  });
  notifyMailbox(options.runtime, taskMailbox(updated.id), updated.id);
  if (updated.status === "active") {
    notifyMailbox(options.runtime, leaderMailbox(updated.id), updated.id);
  }
  return output(`Added Project to ${updated.id}\n`, { task: updated });
}

function updateTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const optionNames = new Set(["--title", "--description", "--priority", "--tags", "--due-at"]);
  const flagOptions = new Set([
    "--clear-description", "--clear-priority", "--clear-tags", "--clear-due-at",
    "--require-integration"
  ]);
  const usage = "Task update usage: yui task update <id> [--title <text>] [--description <text>|--clear-description] [--priority <low|medium|high|urgent>|--clear-priority] [--tags <comma-separated>|--clear-tags] [--due-at <RFC3339>|--clear-due-at] [--require-integration].";
  const parsed = parseTail(args, optionNames, usage, flagOptions);
  exactPositionals(parsed.positionals, 1, usage);
  if (parsed.options.size === 0) throw usageError("At least one Task metadata option is required.", usage);
  for (const [setOption, clearOption] of [
    ["--description", "--clear-description"],
    ["--priority", "--clear-priority"],
    ["--tags", "--clear-tags"],
    ["--due-at", "--clear-due-at"]
  ] as const) {
    if (parsed.options.has(setOption) && parsed.options.has(clearOption)) {
      throw usageError(`${setOption} and ${clearOption} cannot be used together.`, usage);
    }
  }
  const priority = parsed.options.has("--priority")
    ? parseTaskPriority(requiredOption(parsed.options, "--priority"))
    : undefined;
  const dueAt = parsed.options.has("--due-at")
    ? parseIsoTimestamp(requiredOption(parsed.options, "--due-at"), "--due-at")
    : undefined;
  const tags = parsed.options.has("--tags")
    ? parseTaskTags(requiredOption(parsed.options, "--tags"))
    : undefined;
  const now = clock(options);
  const result = store.transaction((tx) => {
    const current = requireTask(tx, parsed.positionals[0]);
    if (current.status === "archived") throw usageError(`Task is archived: ${current.id}.`);
    if (parsed.options.has("--require-integration") && current.status === "completed") {
      throw usageError(
        `Task ${current.id} is completed; use task reopen before enabling integration evidence.`
      );
    }
    if (
      parsed.options.size === 1
      && parsed.options.has("--require-integration")
      && current.requireIntegration === true
    ) {
      return { task: current, integrationState: "already-enabled" as const };
    }
    const updated = updateTaskMetadata(current, {
      ...(parsed.options.has("--title") ? { title: requiredOption(parsed.options, "--title") } : {}),
      ...(parsed.options.has("--description")
        ? { description: requiredOption(parsed.options, "--description") }
        : parsed.options.has("--clear-description") ? { description: null } : {}),
      ...(priority === undefined
        ? parsed.options.has("--clear-priority") ? { priority: null } : {}
        : { priority }),
      ...(tags === undefined
        ? parsed.options.has("--clear-tags") ? { tags: null } : {}
        : { tags }),
      ...(dueAt === undefined
        ? parsed.options.has("--clear-due-at") ? { dueAt: null } : {}
        : { dueAt }),
      ...(parsed.options.has("--require-integration") ? { requireIntegration: true } : {})
    }, now);
    tx.saveTask(updated);
    recordTaskEvent(tx, updated.id, "task.updated", {
      status: updated.status,
      ...(parsed.options.has("--require-integration")
        ? { completionEvidence: "integration-required" }
        : {})
    }, now);
    enqueueWork(tx, taskMailbox(updated.id), "task-updated", now, [taskRef(updated.id)]);
    return {
      task: updated,
      integrationState: parsed.options.has("--require-integration")
        ? "enabled" as const
        : "unchanged" as const
    };
  });
  if (result.integrationState !== "already-enabled") {
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
  }
  return result.integrationState === "enabled"
    ? `Updated task ${result.task.id}\nCompletion evidence enabled: WorkItem, ChangeSet, and committed Integration required\n`
    : result.integrationState === "already-enabled"
      ? `Task ${result.task.id} completion evidence is already enabled\n`
      : `Updated task ${result.task.id}\n`;
}

/** Compatibility helper for call sites that cannot yet handle foreground enter. */
export function runTaskOutputCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): string {
  const execution = runTaskCommand(args, store, options);
  if (execution.kind !== "output") {
    throw runtimeError("Task Role foreground runtime control requires the CLI.");
  }
  return execution.output;
}

export function submitOperatorMessage(
  body: string,
  taskId: string | undefined,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): string {
  const now = clock(options);
  const result = store.transaction((tx) => {
    if (taskId !== undefined) {
      const task = requireTask(tx, taskId);
      assertTaskOpen(task);
      const message = appendMessage(tx, task.id, body, "operator", { type: "operator" }, now);
      if (task.status === "active") {
        enqueueWork(tx, leaderMailbox(task.id), "operator-input", now, [messageRef(task.id, message.id)]);
      }
      return { task, message, created: false } as const;
    }

    const created = createTaskAggregate(tx, titleFrom(body), {}, now);
    const message = appendMessage(tx, created.task.id, body, "operator", { type: "operator" }, now);
    return { ...created, message, created: true } as const;
  });
  notifyMailbox(
    options.runtime,
    result.task.status === "active" ? leaderMailbox(result.task.id) : taskMailbox(result.task.id),
    result.task.id
  );
  return result.created
    ? `Created Draft task ${result.task.id}: ${result.task.title}\nSubmitted message ${result.message.id}\n`
    : `Submitted message ${result.message.id} to ${result.task.id}\n`;
}

function createTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const parsed = parseTaskCreation(args, store);
  const now = clock(options);
  const created = store.transaction((tx) => createTaskAggregate(tx, parsed.title, {
    projectBindings: parsed.projectBindings,
    ...(parsed.requireIntegration ? { requireIntegration: true } : {})
  }, now, parsed.defaultProjectIds));
  notifyMailbox(options.runtime, taskMailbox(created.task.id), created.task.id);
  return output(
    `Created Draft task ${created.task.id}: ${created.task.title}\n`
      + `Assigned role: ${created.leader.name}\n`
      + (created.task.requireIntegration
        ? "Completion: WorkItem, ChangeSet, and committed Integration required\n"
        : "Completion: delivery integration not required\n"),
    { task: created.task, leader: created.leader }
  );
}

function parseTaskCreation(
  args: string[],
  store: TaskWorkflowStore
): Readonly<{
  title: string;
  projectBindings: readonly TaskProjectBinding[];
  defaultProjectIds: readonly string[];
  requireIntegration: boolean;
}> {
  const usage = "Task create usage: yui task create <title> [--project <project> ...] [--base <project>=<ref> ...] [--require-integration].";
  const parsed = parseMultiValueTail(
    args,
    new Set(),
    new Set(["--project", "--base"]),
    usage,
    new Set(["--require-integration"])
  );
  exactPositionals(parsed.positionals, 1, usage);
  const projectReferences = parsed.multiOptions.get("--project") ?? [];
  const baseOptions = parsed.multiOptions.get("--base") ?? [];
  if (baseOptions.length > 0 && projectReferences.length === 0) {
    throw usageError("--base requires --project.");
  }
  const projects = projectReferences.map((reference) => {
    const project = resolveProject(store.listProjects(), reference);
    if (project === null) throw usageError(`Project not found: ${reference}.`);
    return project;
  });
  if (new Set(projects.map(({ id }) => id)).size !== projects.length) {
    throw usageError("A Task cannot bind the same Project more than once.");
  }
  const bases = new Map<string, string>();
  for (const option of baseOptions) {
    const separator = option.indexOf("=");
    if (separator < 0) {
      if (projects.length !== 1) {
        throw usageError("--base must use <project>=<ref> when a Task has multiple Projects.");
      }
      bases.set(projects[0].id, requiredText(option, "--base"));
      continue;
    }
    const reference = requiredText(option.slice(0, separator), "--base Project");
    const baseRef = requiredText(option.slice(separator + 1), "--base ref");
    const project = resolveProject(projects, reference);
    if (project === null) throw usageError(`Task Project not found for --base: ${reference}.`);
    if (bases.has(project.id)) throw usageError(`Project base may only be specified once: ${reference}.`);
    bases.set(project.id, baseRef);
  }
  const defaultProjectIds = projects
    .filter((project) => !bases.has(project.id))
    .map(({ id }) => id);
  return {
    title: parsed.positionals[0],
    projectBindings: projects.map((project) => ({
      projectId: project.id,
      directory: project.name,
      baseRef: bases.get(project.id) ?? project.developmentBranch
    })),
    defaultProjectIds,
    requireIntegration: parsed.options.has("--require-integration")
  };
}

function createTaskAggregate(
  store: TaskWorkflowStore,
  title: string,
  metadata: TaskMetadata,
  now: Date,
  defaultProjectIds: readonly string[] = []
): Readonly<{ task: Task; leader: Role }> {
  const task = createTask(store.nextTaskId(), title, now, metadata);
  const leader = createTaskRole(store, task, LEADER_ROLE, undefined, now);
  store.saveTask(task);
  store.saveRole(task.id, leader);
  recordTaskEvent(store, task.id, "task.created", {
    status: task.status,
    ...(defaultProjectIds.length === 0
      ? {}
      : { defaultProjectIds: defaultProjectIds.join(",") })
  }, now);
  enqueueWork(store, taskMailbox(task.id), "task-created", now, [taskRef(task.id)]);
  return { task, leader };
}

function listTaskCommand(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const options = parseTaskListOptions(args);
  const snapshot = store.transaction((reader) => ({
    result: buildTaskOverview(reader, options),
    timeZone: reader.getConfig().timeZone
  }));
  const rendered = renderTaskOverview(
    snapshot.result,
    options,
    snapshot.timeZone,
    defaultTableWidth()
  );
  return output(rendered, snapshot.result);
}

function showTaskCommand(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const [taskId] = args;
  exactPositionals(args, 1, "Task show usage: yui task show <id>.");
  const task = requireTask(store, taskId);
  const messages = store.listMessages(task.id);
  const brief = store.getTaskBrief(task.id);
  const decisions = store.listDecisions(task.id);
  const milestones = store.listMilestones(task.id);
  const events = store.listEvents(task.id);
  const openInputs = openInputRequestCount(store, task.id);
  const work = store.listWorkItems(task.id);
  const changeSets = store.listChangeSets(task.id);
  const integrations = store.listIntegrationAttempts(task.id);
  const publications = store.listPublicationReferences(task.id);
  const verifiedMergedPublications = publications.filter((reference) => (
    reference.state === "merged" && reference.verification === "verified"
  )).length;
  const counts = {
    messages: messages.length,
    decisions: decisions.length,
    milestones: milestones.length,
    events: events.length,
    workItems: work.length,
    agentRuns: store.listAgentRuns(task.id).length,
    changeSets: changeSets.length,
    integrations: integrations.length,
    publications: publications.length,
    openInputs
  };
  const timeZone = store.getConfig().timeZone;
  const rendered = [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    ...(task.description === undefined ? [] : [`Description: ${task.description}`]),
    ...(task.priority === undefined ? [] : [`Priority: ${task.priority}`]),
    ...(task.tags === undefined ? [] : [`Tags: ${task.tags.join(", ")}`]),
    ...(task.dueAt === undefined ? [] : [`Due: ${presentTime(task.dueAt, timeZone)}`]),
    `Completion evidence: ${task.requireIntegration === true ? "required" : "not required"}`,
    ...(task.completedAt === undefined ? [] : [`Completed: ${presentTime(task.completedAt, timeZone)}`]),
    ...(task.completedBy === undefined ? [] : [`Completed by: ${task.completedBy}`]),
    ...(task.completionSummary === undefined ? [] : [`Completion summary: ${task.completionSummary}`]),
    ...(task.retiredAt === undefined ? [] : [`Retired: ${presentTime(task.retiredAt, timeZone)}`]),
    ...(task.retiredBy === undefined ? [] : [`Retired by: ${task.retiredBy}`]),
    ...(task.retirementSummary === undefined ? [] : [`Retirement summary: ${task.retirementSummary}`]),
    ...(task.replacementTaskId === undefined ? [] : [`Replacement Task: ${task.replacementTaskId}`]),
    ...(task.projectBindings.length === 0
      ? []
      : [
          "Projects:",
          ...task.projectBindings.map((binding) => (
            `- ${binding.directory}: ${binding.projectId} @ ${binding.baseRef}`
          ))
        ]),
    ...(task.cwd === undefined ? [] : [`Workspace: ${task.cwd}`]),
    `Messages: ${counts.messages}`,
    `Brief: ${brief === null ? "no" : "yes"}`,
    `Decisions: ${counts.decisions}`,
    `Milestones: ${counts.milestones}`,
    `Events: ${counts.events}`,
    `Work items: ${counts.workItems}`,
    `Agent Runs: ${counts.agentRuns}`,
    `ChangeSets: ${counts.changeSets}`,
    `Integration Attempts: ${counts.integrations}`,
    `Publication references: ${counts.publications} (${verifiedMergedPublications} verified merged)`,
    `Open inputs: ${counts.openInputs}`,
    `Created: ${presentTime(task.createdAt, timeZone)}`,
    `Updated: ${presentTime(task.updatedAt, timeZone)}`
  ].join("\n").concat("\n");
  return output(rendered, { task, counts, hasBrief: brief !== null });
}

function activateTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task activate usage: yui task activate <task>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
    if (task.status === "completed") {
      throw usageError(`Task ${task.id} is completed; use task reopen before activating it.`);
    }
    if (task.status === "active") return { task, changed: false } as const;
    const active = activateTask(task, now);
    tx.saveTask(active);
    // Project-backed Tasks keep this durable wake pending until the
    // Controller has prepared and recorded the Task workspace.
    enqueueWork(tx, leaderMailbox(task.id), "task-created", now, [taskRef(task.id)]);
    enqueueWork(tx, taskMailbox(task.id), "task-activated", now, [taskRef(task.id)]);
    recordTaskEvent(tx, task.id, "task.activated", {
      fromStatus: task.status,
      status: active.status
    }, now);
    return { task: active, changed: true } as const;
  });
  if (result.changed) {
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
  }
  return result.changed
    ? `Activated task ${result.task.id}\n`
    : `Task ${result.task.id} is already active\n`;
}

function completeTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const request = parseTaskCompletionRequest(args, options.completionSummary);
  const summary = request.summary;
  const now = clock(options);
  const result = store.transaction((tx) => {
    const preflight = preflightTaskCompletion(request.taskId, tx, options, request);
    const { task, actor } = preflight;
    if (preflight.completed) {
      return {
        task,
        changed: false,
        runtimeCleanupTargets: [] as RuntimeLifecycleTarget[],
        finalReview: undefined,
        publishedTreeAuthorization: undefined
      } as const;
    }
    const taskFinalContract = preflight.taskFinalReviewContract;
    const publishedTreeProof = request.acceptedPublishedTreePublicationId === undefined
      ? undefined
      : assertTaskCompletionPublishedTreeProof(
        tx,
        task,
        request.acceptedPublishedTreePublicationId,
        options.completionPublishedTreeProof,
        actualTaskReviewCandidateForMutation(tx, task, options)
      );
    const requiresContractHandoff = publishedTreeProof !== undefined
      && taskFinalContract !== undefined;
    if (requiresContractHandoff && actor !== "leader") {
      const existing = matchingPublishedTreeAuthorization(tx, publishedTreeProof);
      const event = existing ?? recordTaskEventRecord(
        tx,
        task.id,
        TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT,
        publishedTreeAuthorizationPayload(actor, publishedTreeProof),
        now
      );
      enqueueWork(
        tx,
        leaderMailbox(task.id),
        wakeReason("published-tree-authorized", event.id),
        now,
        [eventRef(task.id, event.id)]
      );
      return {
        task,
        changed: false,
        runtimeCleanupTargets: [] as RuntimeLifecycleTarget[],
        finalReview: undefined,
        publishedTreeAuthorization: {
          event,
          proof: publishedTreeProof,
          created: existing === undefined
        }
      } as const;
    }
    if (publishedTreeProof !== undefined && actor === "leader") {
      requirePublishedTreeAuthorization(tx, publishedTreeProof);
    }

    const roles = tx.listRoles(task.id);
    const activeRuns = roles
      .map((role) => ({ role, run: tx.getActiveAgentRun(task.id, role.name) }))
      .filter((entry): entry is { role: Role; run: AgentRun } => entry.run !== null);
    // The preflight (above, same transaction) already projected the full
    // readiness via projectCompletionReadiness.  The leader-Run check is
    // actor-dependent and stays here; every other blocker is re-validated by
    // the post-Review readiness fence below.

    let terminalizedLeaderRun = false;
    const leaderEntry = activeRuns.find(({ role }) => role.name === LEADER_ROLE);
    if (leaderEntry !== undefined) {
      if (actor !== "leader") {
        throw usageError(`Task ${task.id} has an active Leader run.`);
      }
      if (leaderEntry.run.workItemId !== undefined) {
        throw usageError(`Task ${task.id} has running work: ${leaderEntry.run.workItemId}.`);
      }
      if (leaderEntry.run.pushedAt === undefined) {
        throw usageError(`Task ${task.id} Leader delivery is still pending.`);
      }
      const terminal = terminalizeExactTaskRun(tx, {
        taskId: task.id,
        roleName: LEADER_ROLE,
        agentId: leaderEntry.run.effective.agentId,
        runId: leaderEntry.run.id,
        receiptId: agentRunDeliveryReceiptId(leaderEntry.run),
        outcome: { status: "yielded", summary }
      }, now);
      if (terminal.disposition !== "applied") {
        throw usageError(
          `Task Leader Run changed during completion: ${leaderEntry.run.id}/${terminal.reason}.`
        );
      }
      terminalizedLeaderRun = true;
    }

    // A final (Task-scoped) review is the Task delivery policy: it reviews the
    // complete integrated Task heads, not a single WorkItem Candidate. If the
    // review config requests a final review, create the Task ReviewRound here
    // and return it for dispatch instead of completing the Task.
    const pendingFinalReviewIds = new Set(tx.listReviewRounds(task.id)
      .filter((round) => (
        (round.scope ?? "work-item") === "task" && round.status === "pending"
      ))
      .map(({ id }) => id));
    const finalReview = prepareFinalTaskReview(
      tx,
      task,
      now,
      taskFinalContract,
      options
    );
    if (finalReview !== null) {
      return {
        task,
        changed: false,
        runtimeCleanupTargets: [] as RuntimeLifecycleTarget[],
        finalReview,
        resumedPendingFinalReview: pendingFinalReviewIds.has(finalReview.id),
        terminalizedLeaderRun,
        publishedTreeAuthorization: undefined
      } as const;
    }
    // Issue 06: re-validate the full completion readiness inside the
    // transaction (the CAS fence) after final-review preparation.  This is the
    // same pure projection `task next-action` displays, now with the finding
    // ledger gate enabled: `fixed-pending-review` findings that the prepared
    // Review would resolve are no longer blocked, but once no Review is needed
    // every remaining blocker fails closed with the fresh list.
    const readinessFacts = tx.readCompletionReadinessFacts(task.id);
    if (readinessFacts === null) throw taskNotFound(task.id);
    const readiness = projectCompletionReadiness(readinessFacts);
    if (!readiness.ready) {
      throw usageError(formatCompletionBlockers(task.id, readiness.blockers));
    }

    const completed = completeTask(task, now, { by: actor, summary });
    tx.saveTask(completed);
    tx.clearPendingWakeup(task.id);
    tx.clearLeaderFailure(task.id);
    tx.clearOperatorNotification(task.id);
    tx.saveOperatorNotification(createTaskTerminalNotification(
      task.id,
      "completed",
      actor,
      summary,
      now
    ));
    enqueueWork(tx, { kind: "operator" }, "task-terminal", now, [taskRef(task.id)]);
    if (publishedTreeProof !== undefined) {
      recordTaskEvent(tx, task.id, "task.completion-published-tree-accepted", {
        by: actor,
        projectId: publishedTreeProof.projectId,
        publicationId: publishedTreeProof.publicationId,
        reviewRoundId: publishedTreeProof.reviewRoundId,
        localCommit: publishedTreeProof.localCommit,
        remoteCommit: publishedTreeProof.remoteCommit,
        tree: publishedTreeProof.tree
      }, now);
    }
    recordTaskEvent(tx, task.id, "task.completed", { by: actor, summary }, now);
    // A terminal Task must never leave a Task-lane signal that can wake it.
    // The durable records remain intact; only the derived mailbox work is
    // discarded at this lifecycle boundary.
    tx.removeWorkMailbox(taskMailbox(task.id));
    // Role mailboxes are also derived wake state. A Worker result or recovery
    // signal queued while the final Run was being settled must not survive a
    // completed Task and become actionable after a later explicit reopen.
    for (const role of roles) {
      tx.removeWorkMailbox(roleMailbox(task.id, role.name));
    }
    const runtimeCleanupTargets = queueCompletedTaskRuntimeCleanups(
      tx,
      task.id,
      roles,
      now
    );
    return {
      task: completed,
      changed: true,
      runtimeCleanupTargets,
      finalReview: undefined,
      resumedPendingFinalReview: false,
      terminalizedLeaderRun,
      publishedTreeAuthorization: undefined
    } as const;
  });
  if (result.publishedTreeAuthorization !== undefined) {
    notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    const authorization = result.publishedTreeAuthorization;
    return output(
      authorization.created
        ? `Authorized published-tree completion for ${result.task.id} as ${authorization.event.id}; exact Task Leader completion is required.\n`
        : `Published-tree completion is already authorized for ${result.task.id} as ${authorization.event.id}; exact Task Leader completion is required.\n`,
      {
        task: result.task,
        authorizationEvent: authorization.event,
        publishedTreeProof: authorization.proof
      }
    );
  }
  if (result.changed) {
    for (const target of result.runtimeCleanupTargets) {
      // Cleanup owns an independent lifecycle lane. Never fall back to the
      // Task signal for older runtime ports: a completed Task must not wake.
      options.runtime?.notifyMailboxChanged?.(target);
    }
    notifyMailbox(options.runtime, { kind: "operator" }, result.task.id);
  }
  if (result.finalReview !== undefined) {
    const status = result.finalReview.status === "pending"
      ? `Final Task Review requested as ${result.finalReview.id}.`
      : `Final Task Review is blocked: ${result.finalReview.summary ?? result.finalReview.id}.`;
    return output(`${status}\n`, {
      task: result.task,
      reviewRound: result.finalReview,
      [RESUMED_PENDING_FINAL_REVIEW]: result.resumedPendingFinalReview,
      [TERMINALIZED_LEADER_BEFORE_FINAL_REVIEW]: result.terminalizedLeaderRun
    });
  }
  return output(result.changed
    ? `Completed task ${result.task.id}\n`
    : `Task ${result.task.id} is already completed\n`);
}

function reopenTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task reopen usage: yui task reopen <id>.");
  const now = clock(options);
  // Reopen changes the Task status that archiveLegacyTaskRefs reads before
  // deleting the legacy ref. Take the same per-Project maintenance fence so a
  // reopen cannot commit between archive's status read and its ref deletion:
  // the two operations are mutually exclusive per Project.
  const existing = store.getTask(args[0]);
  const projectIds = existing === null
    ? []
    : existing.projectBindings.map(({ projectId }) => projectId);
  const release = options.yuiHome === undefined || projectIds.length === 0
    ? () => {}
    : acquireProjectMaintenanceLocks(options.yuiHome, projectIds);
  try {
    const result = store.transaction((tx) => {
      const task = requireTask(tx, args[0]);
      if (task.status === "active") return { task, changed: false } as const;
      if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
      if (task.status !== "completed") throw usageError(`Task is not completed: ${task.id}.`);
      const active = reopenTask(task, now);
      tx.saveTask(active);
      tx.clearOperatorNotification(task.id);
      const reopenedReason = wakeReason("task-reopened");
      enqueueWork(tx, leaderMailbox(task.id), reopenedReason, now, [taskRef(task.id)]);
      enqueueWork(tx, taskMailbox(task.id), reopenedReason, now, [taskRef(task.id)]);
      recordTaskEvent(tx, task.id, "task.reopened", { status: active.status }, now);
      return { task: active, changed: true } as const;
    });
    if (result.changed) {
      notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
      notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    }
    return result.changed
      ? `Reopened task ${result.task.id}\n`
      : `Task ${result.task.id} is already active\n`;
  } finally {
    release();
  }
}

function archiveTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const request = validateTaskArchiveRequest(args, store, options);
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, request.taskId);
    const actor = taskActor(options, task.id);
    if (task.status === "archived") return { task, changed: false } as const;
    if (task.status !== "completed"
      && task.status !== "retired") {
      throw usageError(`Task ${task.id} must be completed or retired before it can be archived.`);
    }
    assertNoOpenInputRequests(tx, task.id, "archiving the Task");
    const unresolvedIntegration = tx.listIntegrationAttempts(task.id).find((integration) => (
      integration.status === "running"
      || integration.status === "blocked"
      || integration.status === "validating"
    ));
    if (unresolvedIntegration !== undefined) {
      throw usageError(
        `Task ${task.id} has an unresolved Integration Attempt: ${unresolvedIntegration.id}.`
      );
    }
    const activeArchiveJob = tx.listDurableJobs(task.id).find((job) => (
      job.status === "queued"
      || job.status === "running"
      || (job.status === "unknown-needs-attention" && job.acknowledgedAt === undefined)
    ));
    if (activeArchiveJob !== undefined) {
      throw usageError(
        `Task ${task.id} has an active DurableJob: ${activeArchiveJob.id}/${activeArchiveJob.status}.`
      );
    }
    const continuationBlockers = blockingProviderContinuations(tx.listEvents(task.id));
    if (continuationBlockers.length > 0) {
      throw usageError(
        `Task ${task.id} still owns unsettled Provider continuation(s); `
        + "reconcile or cancel them before archiving."
      );
    }
    if (task.cwd !== undefined || tx.listManagedWorkspaces(task.id).length > 0) {
      throw usageError(`Task ${task.id} still has managed worktrees; clean them before archiving.`);
    }
    const activeRole = tx.listRoles(task.id)
      .find((role) => tx.getActiveAgentRun(task.id, role.name) !== null);
    if (activeRole !== undefined) {
      throw usageError(
        `Task ${task.id} still has an active Run for Role ${activeRole.name}; `
        + "stop its runtime before archiving."
      );
    }
    const archived = archiveTask(task, now, { by: actor });
    tx.saveTask(archived);
    tx.clearPendingWakeup(task.id);
    tx.clearLeaderFailure(task.id);
    tx.clearOperatorNotification(task.id);
    for (const role of tx.listRoles(task.id)) {
      tx.removeWorkMailbox(roleMailbox(task.id, role.name));
    }
    recordTaskEvent(tx, task.id, "task.archived", {
      by: actor,
      workspaceDisposition: request.disposition
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "task-archived", now, [taskRef(task.id)]);
    return { task: archived, changed: true } as const;
  });
  if (result.changed) notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
  return result.changed
    ? `Archived task ${result.task.id}\n`
    : `Task ${result.task.id} is already archived\n`;
}

function retireTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task retire usage: yui task retire <task> (--summary <text>|--summary-file <path|->) [--replacement <task>].";
  const parsed = parseTail(
    args,
    new Set(["--summary", "--summary-file", "--replacement"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const taskId = parsed.positionals[0]!;
  const summary = readCommandText(
    parsed.options.get("--summary"),
    parsed.options.get("--summary-file"),
    "--summary",
    usage
  );
  const replacementTaskId = parsed.options.get("--replacement");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, taskId);
    const actor = taskActor(options, task.id);
    if (task.status === "retired") {
      const same = task.retirementSummary === summary
        && task.replacementTaskId === replacementTaskId;
      if (!same) throw usageError(`Task already has a different retirement: ${task.id}.`);
      return { task, changed: false } as const;
    }
    if (task.status !== "active" && task.status !== "draft") {
      throw usageError(`Task cannot be retired from ${task.status}: ${task.id}.`);
    }
    if (replacementTaskId !== undefined) {
      const replacement = tx.getTask(replacementTaskId);
      if (replacement === null || replacement.id === task.id) {
        throw usageError(
          `Replacement Task must be a different existing Task: ${replacementTaskId}.`
        );
      }
    }
    const unresolvedIntegration = tx.listIntegrationAttempts(task.id).find((integration) => (
      integration.status === "running"
      || integration.status === "blocked"
      || integration.status === "validating"
    ));
    if (unresolvedIntegration !== undefined) {
      throw usageError(
        `Task ${task.id} has an unresolved Integration Attempt: ${unresolvedIntegration.id}.`
      );
    }
    const activeRetireJob = tx.listDurableJobs(task.id).find((job) => (
      job.status === "queued"
      || job.status === "running"
      || (job.status === "unknown-needs-attention" && job.acknowledgedAt === undefined)
    ));
    if (activeRetireJob !== undefined) {
      throw usageError(
        `Task ${task.id} has an active DurableJob: ${activeRetireJob.id}/${activeRetireJob.status}.`
      );
    }
    assertTaskRetirementProof(tx, task, options.taskRetirementProof);

    for (const run of tx.listAgentRuns(task.id).filter(({ status: runStatus }) => (
      runStatus === "active"
    ))) {
      const terminal = terminalizeExactTaskRun(tx, {
        taskId: task.id,
        roleName: run.roleName,
        agentId: run.effective.agentId,
        runId: run.id,
        receiptId: agentRunDeliveryReceiptId(run),
        mailboxDisposition: "discard",
        outcome: {
          status: "failed",
          summary: `Task retired: ${summary}`
        }
      }, now);
      if (terminal.disposition !== "applied") {
        throw usageError(
          `Task Run changed during retirement: ${run.id}/${terminal.reason ?? "obsolete"}.`
        );
      }
    }

    for (const item of tx.listWorkItems(task.id)) {
      if (item.status === "completed" || item.status === "retired") continue;
      tx.saveWorkItem(task.id, updateWorkItemStatus(
        item,
        "retired",
        now,
        `Task retired: ${summary}`
      ));
    }
    for (const request of tx.listInputRequests(task.id)) {
      if (request.status === "open") {
        tx.saveInputRequest(
          task.id,
          cancelInputRequest(request, `Task retired: ${summary}`, now)
        );
      }
    }
    for (const role of tx.listRoles(task.id)) {
      if (role.status !== "idle") {
        tx.saveRole(task.id, updateRoleStatus(role, "idle", now));
      }
    }
    for (const mailbox of tx.listWorkMailboxes()) {
      if (
        (mailbox.target.kind === "task"
          || mailbox.target.kind === "role")
        && mailbox.target.taskId === task.id
      ) {
        tx.removeWorkMailbox(mailbox.target);
      }
    }
    tx.clearPendingWakeup(task.id);
    tx.clearLeaderFailure(task.id);
    tx.clearOperatorNotification(task.id);
    const retired = retireTask(task, {
      by: actor,
      summary,
      ...(replacementTaskId === undefined ? {} : { replacementTaskId })
    }, now);
    tx.saveTask(retired);
    tx.saveOperatorNotification(createTaskTerminalNotification(
      task.id,
      "retired",
      actor,
      summary,
      now
    ));
    enqueueWork(tx, { kind: "operator" }, "task-terminal", now, [taskRef(task.id)]);
    recordTaskEvent(tx, task.id, "task.retired", {
      by: actor,
      summary,
      ...(replacementTaskId === undefined ? {} : { replacementTaskId })
    }, now);
    return { task: retired, changed: true } as const;
  });
  if (result.changed) {
    options.runtime?.notifyStateChanged(result.task.id);
    notifyMailbox(options.runtime, { kind: "operator" }, result.task.id);
  }
  return output(
    result.changed
      ? `Retired task ${result.task.id}\n`
      : `Task ${result.task.id} is already ${result.task.status}\n`,
    { task: result.task }
  );
}

function assertTaskRetirementProof(
  store: TaskWorkflowStore,
  task: Task,
  proof: TaskRetirementProof | undefined
): void {
  const workspaces = store.listManagedWorkspaces(task.id);
  if (proof === undefined) {
    if (workspaces.length === 0 && task.projectBindings.length === 0) return;
    throw usageError(`Task retirement preflight proof is required: ${task.id}.`);
  }
  if (
    proof.taskId !== task.id
    || proof.taskUpdatedAt !== task.updatedAt
    || proof.workspaces.length !== workspaces.length
  ) {
    throw usageError(`Task changed after retirement preflight: ${task.id}.`);
  }
  const expected = [...proof.workspaces]
    .sort((left, right) => left.ownerKey.localeCompare(right.ownerKey));
  const actual = [...workspaces]
    .sort((left, right) => managedWorkspaceKey(left.owner)
      .localeCompare(managedWorkspaceKey(right.owner)));
  if (!actual.every((workspace, index) => (
    expected[index]?.ownerKey === managedWorkspaceKey(workspace.owner)
    && isDeepStrictEqual(expected[index]?.workspace, workspace)
  ))) {
    throw usageError(`Task workspaces changed after retirement preflight: ${task.id}.`);
  }
}

export function parseTaskArchiveArguments(
  args: readonly string[]
): Readonly<{ taskId: string; disposition: "integrated" | "abandoned" }> {
  const usage = "Task archive usage: yui task archive <id> (--integrated|--abandon).";
  if (args.length !== 2 || !["--integrated", "--abandon"].includes(args[1] ?? "")) {
    throw usageError(usage);
  }
  return {
    taskId: args[0]!,
    disposition: args[1] === "--integrated" ? "integrated" : "abandoned"
  };
}

export function validateTaskArchiveRequest(
  args: readonly string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): Readonly<{ taskId: string; disposition: "integrated" | "abandoned" }> {
  const request = parseTaskArchiveArguments(args);
  const task = requireTask(store, request.taskId);
  const actor = taskActor(options, task.id);
  if (actor === "leader") {
    throw usageError("Only the global Operator may archive a Task from a managed Session.");
  }
  if (task.status !== "archived"
    && task.status !== "completed"
    && task.status !== "retired") {
    throw usageError(`Task ${task.id} must be completed or retired before it can be archived.`);
  }
  if (task.status !== "archived") {
    assertNoOpenInputRequests(store, task.id, "archiving the Task");
    const unresolvedIntegration = store.listIntegrationAttempts(task.id).find((integration) => (
      integration.status === "running"
      || integration.status === "blocked"
      || integration.status === "validating"
    ));
    if (unresolvedIntegration !== undefined) {
      throw usageError(
        `Task ${task.id} has an unresolved Integration Attempt: ${unresolvedIntegration.id}.`
      );
    }
  }
  return request;
}

function reconcileTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task reconcile usage: yui task reconcile <task>.");
  const task = requireTask(store, args[0]);
  const runtime = requireRuntime(options);
  runtime.reconcileTask(task.id);
  return `Reconcile requested for task ${task.id}\n`;
}

function taskMessageCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const [command, ...rest] = args;
  if (command === "send") {
    const usage = "Task message send usage: yui task message send <id> (<body>|--body-file <path|->) [--wake-policy leader|none] [--delivery-mode followup|steer].";
    const parsed = parseTail(
      rest,
      new Set(["--body-file", "--wake-policy", "--delivery-mode"]),
      usage
    );
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2) throw usageError(usage);
    const body = readCommandText(
      parsed.positionals[1],
      parsed.options.get("--body-file"),
      "--body",
      usage
    );
    const wakePolicyRaw = parsed.options.get("--wake-policy");
    let wakePolicy: "leader" | "none" | undefined;
    if (wakePolicyRaw === undefined) {
      wakePolicy = undefined;
    } else if (wakePolicyRaw === "leader" || wakePolicyRaw === "none") {
      wakePolicy = wakePolicyRaw;
    } else {
      throw usageError(`--wake-policy must be 'leader' or 'none': ${wakePolicyRaw}.`);
    }
    const deliveryModeRaw = parsed.options.get("--delivery-mode") ?? "followup";
    if (deliveryModeRaw !== "followup" && deliveryModeRaw !== "steer") {
      throw usageError(`--delivery-mode must be 'followup' or 'steer': ${deliveryModeRaw}.`);
    }
    if (deliveryModeRaw === "steer" && wakePolicy === "none") {
      throw usageError("--delivery-mode steer cannot be combined with --wake-policy none.");
    }
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(options, task.id);
      const message = actor === "leader"
        ? appendMessage(
            tx,
            task.id,
            body,
            "role-result",
            { type: "role", roleName: LEADER_ROLE },
            now
          )
        : actor === "operator"
          ? appendMessage(tx, task.id, body, "operator", { type: "operator" }, now, { wakePolicy })
          : appendMessage(tx, task.id, body, "user", { type: "user" }, now, { wakePolicy });
      // Issue 05: only `wakePolicy=leader` (the default for backward
      // compatibility) enqueues Leader work. `wakePolicy=none` persists the
      // message as context without waking the Leader.
      if (task.status === "active"
        && actor !== "leader"
        && wakePolicy !== "none") {
        enqueueWork(
          tx,
          leaderMailbox(task.id),
          actor === "operator" ? "operator-input" : "user-message",
          now,
          [messageRef(task.id, message.id)],
          deliveryModeRaw === "steer"
            ? {
                source: actor,
                dedupeKey: `user-correction:${task.id}:${message.id}`,
                deliveryMode: "steer-if-safe",
                lane: "user-correction"
              }
            : {
                source: actor,
                dedupeKey: `message:${task.id}:${message.id}`,
                deliveryMode: "followup",
                lane: "normal"
              }
        );
      }
      return { task, message, actor };
    });
    if (result.actor !== "leader") {
      notifyMailbox(
        options.runtime,
        result.task.status === "active"
          ? leaderMailbox(result.task.id)
          : taskMailbox(result.task.id),
        result.task.id
      );
    }
    return `Sent message ${result.message.id} to ${result.task.id}\n`;
  }
  if (command === "list") {
    const messageListUsage = "Task message list usage: yui task message list <id> [--after <timestamp>] [--limit <n>].";
    const parsed = parseTail(rest, new Set(["--after", "--limit"]), messageListUsage);
    exactPositionals(parsed.positionals, 1, messageListUsage);
    const task = requireTask(store, parsed.positionals[0]);
    let messages = store.listMessages(task.id);
    const after = optionalNonEmptyOption(parsed.options, "--after");
    if (after !== undefined) {
      const afterMs = Date.parse(after);
      if (!Number.isFinite(afterMs)) throw usageError("--after must be a valid timestamp.", messageListUsage);
      messages = messages.filter((m) => Date.parse(m.createdAt) > afterMs);
    }
    const limit = optionalNonEmptyOption(parsed.options, "--limit");
    if (limit !== undefined) {
      const n = Number(limit);
      if (!Number.isSafeInteger(n) || n <= 0) throw usageError("--limit must be a positive integer.", messageListUsage);
      messages = messages.slice(-n);
    }
    if (messages.length === 0) return "No messages found.\n";
    const timeZone = store.getConfig().timeZone;
    return `${renderTable(
      `Task messages: ${task.id}`,
      [
        { header: "Message", minWidth: 7, maxWidth: 18 },
        { header: "Author", minWidth: 6, maxWidth: 18 },
        { header: "Created", minWidth: 10, maxWidth: 28 },
        { header: "Body", minWidth: 8, maxWidth: 72 }
      ],
      messages.map((message) => [
        message.id,
        taskMessageAuthorLabel(message.author),
        presentTime(message.createdAt, timeZone),
        message.body
      ]),
      defaultTableWidth()
    )}\n`;
  }
  throw usageError(command === undefined
    ? "Task message command is required."
    : `Unknown command: task message ${command}`);
}

/**
 * Issue 05: force-wake escape hatch. Bypasses the actionability digest and
 * enqueues exactly one Leader wakeup with an auditable reason. The reason is
 * truncated to keep the event payload compact.
 */
function taskWakeForceCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task wake usage: yui task wake <id> --force --reason <text>.";
  const parsed = parseTail(args, new Set(["--reason"]), usage, new Set(["--force"]));
  exactPositionals(parsed.positionals, 1, usage);
  if (!parsed.options.has("--force")) {
    throw usageError("--force is required to wake a Task.", usage);
  }
  const reason = requiredOption(parsed.options, "--reason");
  const now = clock(options);
  const task = requireTask(store, parsed.positionals[0]);
  assertTaskOpen(task);
  const wakeReasonTag = wakeReason("force-wake", truncateEventNote(reason));
  store.transaction((tx) => {
    queueLeaderWakeup(tx, task.id, wakeReasonTag, now);
    recordTaskEvent(tx, task.id, "task.wake-forced", { reason: wakeReasonTag }, now);
  });
  notifyMailbox(options.runtime, leaderMailbox(task.id), task.id);
  return `Woke ${task.id} (${wakeReasonTag})\n`;
}

function taskRoleCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "add") return output(addTaskRole(rest, store, options));
  if (command === "list") return listTaskRoles(rest, store, options);
  if (command === "status") return taskRoleStatus(rest, store, options);
  if (command === "show") return output(showTaskRole(rest, store));
  if (command === "update") return output(updateTaskRole(rest, store, options));
  if (command === "remove") return output(removeTaskRole(rest, store, options));
  if (command === "bind") return output(bindTaskRole(rest, store, options));
  if (command === "unbind") return output(unbindTaskRole(rest, store, options));
  if (command === "reset") return resetTaskRole(rest, store, options);
  if (command === "view") return viewTaskRole(rest, store);
  if (command === "takeover") return transferTaskRoleAuthority(rest, store, options, "takeover");
  if (command === "release") return transferTaskRoleAuthority(rest, store, options, "release");
  throw usageError(command === undefined
    ? "Task role command is required."
    : `Unknown command: task role ${command}`);
}

function resetTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task role reset usage: yui task role reset <task> <role> --reason <text>.";
  const parsed = parseTail(args, new Set(["--reason"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const reason = requiredOption(parsed.options, "--reason");
  const now = clock(options);
  let result;
  try {
    result = store.transaction((tx) => resetTaskRoleSessionGeneration(
      tx,
      parsed.positionals[0],
      parsed.positionals[1],
      reason,
      now
    ));
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error), usage);
  }
  const target = runtimeLifecycleTarget({
    scope: "task",
    taskId: result.taskId,
    roleName: result.roleName
  });
  options.runtime?.notifyMailboxChanged?.(target);
  notifyMailbox(
    options.runtime,
    result.roleName === LEADER_ROLE
      ? { kind: "operator" }
      : leaderMailbox(result.taskId),
    result.taskId
  );
  return output(
    `Reset Task Role Session ${result.taskId}/${result.roleName}; runtime cleanup is pending.\n`,
    result
  );
}

function addTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task role add usage: yui task role add <task> <name> [Role and Agent settings].";
  const [taskId, roleName, ...tail] = args;
  if (taskId === undefined || roleName === undefined || taskId.startsWith("--") || roleName.startsWith("--")) {
    throw usageError("Task id and Role name are required.", usage);
  }
  const parsed = parseRoleOptions(tail, new Map([
    ...roleOptionSpecs({ update: false, includeAgent: true }),
    ["--profile", "value" as const]
  ]), usage);
  const agentId = parsed.one("--agent")?.trim();
  if (parsed.has("--agent") && (agentId === undefined || agentId.length === 0)) {
    throw usageError("--agent is required.", usage);
  }
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, taskId);
    assertTaskOpen(task);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "task",
      taskId: task.id,
      roleName
    }, "creation");
    if (roleName === LEADER_ROLE) throw usageError("The Task leader role already exists.");
    if (tx.getRole(task.id, roleName) !== null) throw usageError(`Role already exists: ${roleName}.`);
    let created = createTaskRole(tx, task, roleName, agentId, now);
    const profileId = parsed.one("--profile");
    if (profileId !== undefined) {
      created = updateRole(created, workerProfileRolePatch(
        requireAgentProfile(tx, profileId)
      ), now);
    }
    const profile = roleProfilePatch(parsed);
    if (Object.keys(profile).length > 0) created = updateRole(created, profile, now);
    if (hasAgentConfigOptions(parsed)) {
      const targetAgentId = agentId || created.activeAgentId;
      const binding = created.agentBindings[targetAgentId];
      if (binding === undefined) throw usageError(`Role Agent is not bound: ${targetAgentId}.`);
      created = updateRole(created, {
        agentBindings: {
          ...created.agentBindings,
          [targetAgentId]: patchRoleAgentBinding(binding, parsed)
        }
      }, now);
    }
    validateConfiguredRoleSkills(options.yuiHome, created.skills ?? []);
    tx.saveRole(task.id, created);
    enqueueWork(tx, taskMailbox(task.id), "role-added", now, [taskRef(task.id)]);
    const binding = created.agentBindings[created.activeAgentId];
    recordTaskEvent(tx, task.id, "role.added", {
      role: created.name,
      runtimeSource: agentId === undefined ? "Global Role worker" : `Explicit Agent ${agentId}`,
      agent: `${created.activeAgentId}/${binding.adapterId}`,
      model: binding.config.model ?? "CLI default",
      effort: binding.config.effort ?? "CLI default",
      permissionStrategy: binding.config.permission.strategy,
      ...roleLaunchEventPayload(created, null)
    }, now);
    return { role: created, binding };
  });
  notifyMailbox(options.runtime, taskMailbox(result.role.taskId), result.role.taskId);
  return [
    `Added role ${result.role.name} to ${result.role.taskId}`,
    `Runtime source: ${agentId === undefined ? "Global Role worker" : `Explicit Agent ${agentId}`}`,
    `Agent: ${result.role.activeAgentId}/${result.binding.adapterId}`,
    `Model: ${result.binding.config.model ?? "CLI default"}; effort: ${result.binding.config.effort ?? "CLI default"}; permission: ${result.binding.config.permission.strategy}`,
    "Next: create a WorkItem and start this Role when it has assigned work."
  ].join("\n").concat("\n");
}

function listTaskRoles(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task role list usage: yui task role list <task>.");
  const task = requireTask(store, args[0]);
  const roles = store.listRoles(task.id);
  const statuses = inspectTaskRoleRuntimeStatuses(
    task.id,
    roles,
    store,
    options.runtime?.inspectTaskRolePanes?.(task.id) ?? [],
    options.now?.() ?? new Date()
  );
  if (statuses.length === 0) return output("No roles assigned.\n", { roles: statuses });
  return output(`${renderTable(
    `Task roles: ${task.id}`,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Health", minWidth: 6, maxWidth: 15 },
      { header: "Open input", minWidth: 5, maxWidth: 10 },
      { header: "Active work", minWidth: 10, maxWidth: 34 },
      { header: "Last run", minWidth: 10, maxWidth: 28 },
      { header: "Native session", minWidth: 10, maxWidth: 28 },
      { header: "tmux", minWidth: 6, maxWidth: 22 }
    ],
    statuses.map((status) => [
      status.roleName,
      status.agentId,
      status.health,
      taskRoleOpenInputLabel(status),
      taskRoleActiveWorkLabel(status),
      taskRoleLastRunLabel(status),
      taskRoleNativeSessionLabel(status),
      taskRoleTmuxLabel(status)
    ]),
    defaultTableWidth()
  )}\n`, { roles: statuses });
}

function taskRoleStatus(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 2, "Task role status usage: yui task role status <task> <role>.");
  const task = requireTask(store, args[0]);
  const role = requireRole(store, task.id, args[1]);
  const [status] = inspectTaskRoleRuntimeStatuses(
    task.id,
    [role],
    store,
    options.runtime?.inspectTaskRolePanes?.(task.id) ?? [],
    options.now?.() ?? new Date()
  );
  if (status === undefined) throw roleNotFound(role.name);
  return output(renderTaskRoleRuntimeStatus(status), { role: status });
}

function showTaskRole(args: string[], store: TaskWorkflowStore): string {
  exactPositionals(args, 2, "Task role show usage: yui task role show <task> <role>.");
  const task = requireTask(store, args[0]);
  const role = requireRole(store, task.id, args[1]);
  return renderRoleDetails(`Task Role: ${role.name}`, role, {
    kind: "task",
    sessions: store.getTaskRoleSessionSet(task.id, role.name)
  });
}

function updateTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task role update usage: yui task role update <task> <role> [Role and Agent settings].";
  const [taskId, roleName, ...tail] = args;
  if (taskId === undefined || roleName === undefined || taskId.startsWith("--") || roleName.startsWith("--")) {
    throw usageError("Task id and Role name are required.", usage);
  }
  const parsed = parseRoleOptions(tail, new Map([
    ...roleOptionSpecs({ update: true, includeAgent: true }),
    ["--profile", "value" as const]
  ]), usage);
  if (parsed.has("--agent") && (parsed.one("--agent")?.trim().length ?? 0) === 0) {
    throw usageError("--agent is required.", usage);
  }
  if ([...parsed.seen].every((option) => option === "--agent")) {
    throw usageError("At least one role update option is required.", usage);
  }
  const now = clock(options);
  const updated = store.transaction((tx) => {
    const task = requireTask(tx, taskId);
    assertTaskOpen(task);
    const role = requireRole(tx, task.id, roleName);
    const changesLaunchContext = hasRoleLaunchContextOptions(parsed) || parsed.has("--profile");
    const changesAgentConfig = hasAgentConfigOptions(parsed);
    if (changesLaunchContext || changesAgentConfig) {
      assertRoleRuntimeMutationAllowed(tx, {
        scope: "task",
        taskId: task.id,
        roleName: role.name
      }, "desired launch configuration update");
    }
    let bindings = role.agentBindings;
    if (changesAgentConfig) {
      const agentId = parsed.one("--agent")?.trim() || role.activeAgentId;
      const agent = requireAgent(tx, agentId);
      const binding = bindings[agentId]
        ?? createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
      bindings = { ...bindings, [agentId]: patchRoleAgentBinding(binding, parsed) };
    }
    const profileId = parsed.one("--profile");
    const withProfile = profileId === undefined
      ? role
      : updateRole(role, workerProfileRolePatch(requireAgentProfile(tx, profileId)), now);
    const next = updateRole(withProfile, {
      ...(bindings === role.agentBindings ? {} : { agentBindings: bindings }),
      ...roleProfilePatch(parsed)
    }, now);
    if (changesLaunchContext) {
      validateConfiguredRoleSkills(options.yuiHome, next.skills ?? []);
    }
    tx.saveRole(task.id, next);
    enqueueWork(tx, taskMailbox(task.id), "role-updated", now, [taskRef(task.id)]);
    recordTaskEvent(
      tx,
      task.id,
      "role.updated",
      roleLaunchEventPayload(next, tx.getTaskRoleSessionSet(task.id, next.name)),
      now
    );
    return next;
  });
  notifyMailbox(options.runtime, taskMailbox(updated.taskId), updated.taskId);
  return renderRoleDetails(`Updated Task Role: ${updated.name}`, updated, {
    kind: "task",
    sessions: store.getTaskRoleSessionSet(updated.taskId, updated.name)
  });
}

function removeTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 2, "Task role remove usage: yui task role remove <task> <role>.");
  const now = clock(options);
  const removed = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    assertTaskOpen(task);
    const role = requireRole(tx, task.id, args[1]);
    if (role.name === LEADER_ROLE) throw usageError("The Task Leader role cannot be removed.");
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    }, "removal");
    if (tx.getActiveAgentRun(task.id, role.name) !== null) {
      throw usageError(`Task Role has an active Run and cannot be removed: ${task.id}/${role.name}.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    if (Object.values(sessions?.sessions ?? {}).some(({ status }) => status !== "stopped")) {
      throw usageError(`Task Role has a running native Agent and cannot be removed: ${task.id}/${role.name}.`);
    }
    if (!tx.removeTaskRole(task.id, role.name)) throw roleNotFound(role.name);
    enqueueWork(tx, taskMailbox(task.id), "role-removed", now, [taskRef(task.id)]);
    return role;
  });
  notifyMailbox(options.runtime, taskMailbox(removed.taskId), removed.taskId);
  return `Removed role ${removed.name} from ${removed.taskId}\n`;
}

function bindTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 3, "Task role bind usage: yui task role bind <task> <role> <agent-id>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    assertTaskOpen(task);
    const role = requireRole(tx, task.id, args[1]);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    }, "desired Agent binding update");
    const agent = requireAgent(tx, args[2]);
    const binding = role.agentBindings[agent.id]
      ?? createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
    const bound = updateRole(role, {
      agentBindings: { ...role.agentBindings, [agent.id]: binding }
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "role-bound", now, [taskRef(task.id)]);
    if (agent.id === role.activeAgentId) {
      tx.saveRole(task.id, bound);
      recordTaskEvent(tx, task.id, "role.agent-bound", {
        role: bound.name,
        agentId: agent.id,
        ...roleLaunchEventPayload(
          bound,
          tx.getTaskRoleSessionSet(task.id, bound.name)
        )
      }, now);
      return { role: bound, mode: "current" as const };
    }
    const existing = tx.getTaskRoleSessionSet(task.id, role.name)
      ?? createRoleSessionSet({ scope: "task", taskId: task.id, roleName: role.name }, role.activeAgentId, now);
    const currentSession = existing.sessions[existing.activeAgentId];
    const switched = (() => {
      try {
        return switchActiveRoleAgent(bound, existing, agent.id, {
          activeRun: tx.getActiveAgentRun(task.id, role.name) !== null,
          nativeProcessRunning: currentSession !== undefined
            && currentSession.status !== "stopped"
        }, now);
      } catch (error) {
        throw usageError(messageOf(error));
      }
    })();
    tx.saveTaskRoleWithSessionSet(switched.role, switched.sessions);
    recordTaskEvent(tx, task.id, "role.agent-bound", {
      role: switched.role.name,
      agentId: agent.id,
      ...roleLaunchEventPayload(switched.role, switched.sessions)
    }, now);
    return { role: switched.role, mode: switched.mode };
  });
  notifyMailbox(options.runtime, taskMailbox(result.role.taskId), result.role.taskId);
  return `Bound ${result.role.taskId}/${result.role.name} to ${result.role.activeAgentId} (${result.mode})\n`;
}

function unbindTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(
    args,
    3,
    "Task role unbind usage: yui task role unbind <task> <role> <agent-id>."
  );
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    const role = requireRole(tx, task.id, args[1]);
    try {
      const unbound = unbindRoleAgent(
        role,
        tx.getTaskRoleSessionSet(task.id, role.name),
        args[2],
        now
      );
      if (unbound.sessions === null) tx.saveRole(task.id, unbound.role);
      else tx.saveTaskRoleWithSessionSet(unbound.role, unbound.sessions);
      recordTaskEvent(tx, task.id, "role.agent-unbound", {
        role: unbound.role.name,
        agentId: args[2],
        ...roleLaunchEventPayload(unbound.role, unbound.sessions)
      }, now);
      return unbound.role;
    } catch (error) {
      throw usageError(messageOf(error));
    }
  });
  return `Unbound Agent ${args[2]} from ${result.taskId}/${result.name}\n`;
}

function viewTaskRole(
  args: string[],
  store: TaskWorkflowStore
): TaskCommandExecution {
  const usage = "Task role view usage: yui task role view <task> <role>.";
  exactPositionals(args, 2, usage);
  const task = requireTask(store, args[0]);
  if (task.status !== "active") {
    throw usageError(inactiveTaskMessage(task, "viewing a role session"));
  }
  const role = requireRole(store, task.id, args[1]);
  const session = store.getRoleSession(task.id, role.name);
  if (session === null || session.status === "stopped" || session.status === "broken") {
    throw usageError(`Task Role has no live Provider view: ${task.id}/${role.name}.`);
  }
  return {
    kind: "view",
    taskId: task.id,
    roleName: role.name,
    access: "read-only",
    output: `Viewing ${role.name} for ${task.id} (read-only)\n`
  };
}

function transferTaskRoleAuthority(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions,
  action: "takeover" | "release"
): TaskCommandExecution {
  const usage = `Task role ${action} usage: yui task role ${action} <task> <role>.`;
  exactPositionals(args, 2, usage);
  const now = clock(options);
  try {
    return store.transaction((tx) => {
      const task = requireTask(tx, args[0]);
      if (task.status !== "active") {
        throw usageError(inactiveTaskMessage(task, `${action} Provider authority`));
      }
      const role = requireRole(tx, task.id, args[1]);
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      const session = sessions?.sessions[role.activeAgentId];
      const binding = sessions?.providerBinding;
      if (sessions === null || sessions === undefined || session === undefined
        || binding === null || binding === undefined
        || session.launchId === undefined
        || session.status === "stopped" || session.status === "broken") {
        throw new Error(`Task Role has no live managed Provider: ${task.id}/${role.name}.`);
      }
      const activation = currentProviderActivation(binding);
      if (activation === null) {
        throw new Error(`Provider Activation is not live: ${task.id}/${role.name}.`);
      }
      if (action === "takeover") {
        const activeRun = tx.getActiveAgentRun(task.id, role.name);
        if (sessions.inFlight === null || activeRun?.id !== sessions.inFlight.runId) {
          throw new Error(`Task Role has no active managed Run for takeover: ${task.id}/${role.name}.`);
        }
      }
      if (action === "takeover"
        && binding.authority.owner !== "controller"
        && binding.authority.owner !== "human") {
        throw new Error(`Provider authority is not Controller-owned: ${task.id}/${role.name}.`);
      }
      if (action === "release"
        && binding.authority.owner !== "human"
        && binding.authority.owner !== "controller") {
        throw new Error(`Provider authority is not human-owned: ${task.id}/${role.name}.`);
      }
      const desiredOwner = action === "takeover" ? "human" : "controller";
      const unchanged = binding.authority.owner === desiredOwner;
      const updatedBinding = unchanged
        ? binding
        : transferProviderAuthority(binding, {
            expectedEpoch: binding.authority.epoch,
            expectedOwner: binding.authority.owner,
            owner: desiredOwner,
            holderId: action === "takeover" ? `human:${randomUUID()}` : activation.activationId,
            changedAt: now.toISOString()
          });
      const authority = updatedBinding.authority;
      if (authority.owner !== "controller" && authority.owner !== "human") {
        throw new Error("Provider authority transfer did not produce a writer.");
      }
      if (!unchanged) {
        tx.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, updatedBinding, now));
        recordTaskEvent(tx, task.id, "runtime.provider-authority-transferred", {
          role: role.name,
          owner: authority.owner,
          holderId: authority.holderId!,
          epoch: String(authority.epoch)
        }, now);
      }
      return {
        kind: "authority" as const,
        action,
        taskId: task.id,
        roleName: role.name,
        launchId: session.launchId,
        nativeSessionId: session.nativeSessionId,
        authority: {
          epoch: authority.epoch,
          owner: authority.owner,
          holderId: authority.holderId!
        },
        output: action === "takeover"
          ? `Human authority ${unchanged ? "replayed" : "acquired"} for ${task.id}/${role.name} at epoch ${authority.epoch}.\n`
          : `Controller authority ${unchanged ? "replayed" : "restored"} for ${task.id}/${role.name} at epoch ${authority.epoch}.\n`
      };
    });
  } catch (error) {
    throw usageError(messageOf(error), usage);
  }
}

function taskWorkCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "create") return createWork(rest, store, options);
  if (command === "list") return listWork(rest, store);
  if (command === "show") return showWork(rest, store, options);
  if (command === "update") return updateWork(rest, store, options);
  if (command === "scope") return output(updateWorkScope(rest, store, options));
  if (command === "dispatch") return output(dispatchWork(rest, store, options));
  if (command === "group") return resolveWorkExecutionGroup(rest, store, options);
  if (command === "review") {
    return rest[0] === "retry"
      ? retryFailedTaskReviewRound(rest.slice(1), store, options)
      : reviewWork(rest, store, options);
  }
  if (command === "accept") return acceptWork(rest, store, options);
  if (command === "reject") return rejectWork(rest, store, options);
  if (command === "retire") return retireWork(rest, store, options);
  throw usageError(command === undefined
    ? "Task work command is required."
    : `Unknown command: task work ${command}`);
}

function createWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work create usage: yui task work create <task> <title> [--project <project> ...] [--base-ref <project>=<ref> ...] [--objective <text>] [--accept <criterion> ...] [--after <work> ...] [--role <name>].";
  const parsed = parseWorkCreateArgs(args, usage);
  exactPositionals(parsed.positionals, 2, usage);
  const now = clock(options);
  const item = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    assertTaskOpen(task);
    for (const dependencyId of parsed.after) {
      const dependency = tx.getWorkItem(task.id, dependencyId);
      if (dependency === null) throw usageError(`Work Item dependency not found: ${dependencyId}.`);
    }
    if (parsed.role !== undefined) requireRole(tx, task.id, parsed.role);
    const writeProjectIds = parsed.projects.map((reference) => {
      const project = resolveProject(
        task.projectBindings.map(({ projectId }) => requireProject(tx, projectId)),
        reference
      );
      if (project === null) throw usageError(`Task Project not found: ${reference}.`);
      return project.id;
    });
    const baseRefs: WorkItemProjectBaseRef[] = parsed.baseRefs.map(({ project, baseRef }) => {
      const resolved = resolveProject(
        task.projectBindings.map(({ projectId }) => requireProject(tx, projectId)),
        project
      );
      if (resolved === null) throw usageError(`Task Project not found: ${project}.`);
      if (!writeProjectIds.includes(resolved.id)) {
        throw usageError(`Work Item base-ref Project must be writable: ${resolved.id}.`);
      }
      return { projectId: resolved.id, baseRef };
    });
    if (new Set(baseRefs.map(({ projectId }) => projectId)).size !== baseRefs.length) {
      throw usageError("Each Work Item Project may specify at most one base ref.");
    }
    const guard = runDeliveryGuardPreflight(tx, task.id, {
      kind: "create-work-item",
      scope: {
        title: parsed.positionals[1]!,
        objective: parsed.objective ?? parsed.positionals[1]!,
        acceptance: parsed.acceptance,
        writeProjectIds
      }
    }, { environment: options.environment, budget: true });
    const created = createWorkItem(tx.nextWorkItemId(task.id), task.id, {
      title: parsed.positionals[1],
      objective: parsed.objective ?? parsed.positionals[1],
      acceptance: parsed.acceptance,
      dependsOn: parsed.after,
      writeProjectIds,
      ...(baseRefs.length === 0 ? {} : { baseRefs }),
      ...(parsed.role === undefined ? {} : { assignee: parsed.role })
    }, now);
    tx.saveWorkItem(task.id, created);
    enqueueWork(tx, taskMailbox(task.id), "work-created", now, [workItemRef(task.id, created.id)]);
    return { item: created, guard };
  });
  notifyMailbox(options.runtime, taskMailbox(item.item.taskId), item.item.taskId);
  return output(
    withGuardWarnings(item.guard, `Created work item ${item.item.id} for ${item.item.taskId}\n`),
    { workItem: item.item }
  );
}

function updateWorkScope(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task work scope usage: yui task work scope <task>/<work> [--project <project> ...].";
  const parsed = parseMultiValueTail(
    args,
    new Set(),
    new Set(["--project"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const now = clock(options);
  const updated = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, item.taskId);
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may change a Work Item Project scope.");
    }
    if (tx.getActiveAgentRun(task.id, item.assignee ?? "") !== null) {
      throw usageError(`Stop the active Work Item Run before changing scope: ${item.id}.`);
    }
    const requestedProjectIds = (parsed.multiOptions.get("--project") ?? []).map((reference) => {
      const project = resolveProject(
        task.projectBindings.map(({ projectId }) => requireProject(tx, projectId)),
        reference
      );
      if (project === null) throw usageError(`Task Project not found: ${reference}.`);
      return project.id;
    });
    const requested = new Set(requestedProjectIds);
    const projectIds = task.projectBindings
      .map(({ projectId }) => projectId)
      .filter((projectId) => requested.has(projectId));
    const next = updateWorkItemWriteProjects(item, projectIds, now);
    if (next === item) return { item, changed: false } as const;
    tx.saveWorkItem(task.id, next);
    recordTaskEvent(tx, task.id, "work.scope-updated", {
      workItemId: item.id,
      projectIds: projectIds.join(",")
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "work-scope-updated", now, [workItemRef(task.id, item.id)]);
    return { item: next, changed: true } as const;
  });
  if (updated.changed) {
    notifyMailbox(options.runtime, taskMailbox(updated.item.taskId), updated.item.taskId);
  }
  return `${updated.changed ? "Updated" : "Unchanged"} Work Item Project scope ${
    updated.item.id
  }: ${
    updated.item.writeProjectIds.join(", ") || "read-only"
  }\n`;
}

function updateWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work update usage: yui task work update <task>/<work> <todo|running|done|failed> [--summary <text>].";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const requested = parsed.positionals[1];
  const status = parseWorkStatus(requested);
  const summary = trimmed(parsed.options.get("--summary"));
  if (["completed", "failed"].includes(status)
    && summary === undefined) {
    throw usageError(`--summary is required when work becomes ${requested}.`);
  }
  const now = clock(options);
  const result = store.transaction((tx) => {
    const current = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, current.taskId);
    assertTaskOpen(task);
    if (current.assignee === undefined) {
      if (taskActor(options, task.id) !== "leader") {
        throw usageError(
          `Only the Task Leader may update unassigned Work Item execution: ${current.id}.`
        );
      }
      if (status === "running") {
        assertWorkItemDependenciesCompleted(tx, current);
      }
      if (status === "completed" && current.status === "awaiting_acceptance") {
        throw usageError(
          `Work Item ${current.id} is awaiting acceptance; use task work accept `
          + "after the required ReviewRound and Integration evidence."
        );
      }
      const configuredReview = status === "completed" && !isTerminalWorkItemStatus(current.status)
        ? tx.getReviewConfig()
        : null;
      const taskFinalContract = status === "completed" && current.status === "running"
        ? taskFinalReviewContractForMutation(tx, task.id, options)
        : undefined;
      const candidatePolicy = taskFinalContract === undefined
        ? legacyWorkItemReviewConfig(configuredReview)
        : taskFinalReviewConfig(taskFinalContract);
      const projectDelivery = task.projectBindings.length > 0
        && current.writeProjectIds.length > 0;
      const metadataOnlyTaskFinalDelivery = taskFinalContract !== undefined
        && current.assignee === undefined;
      const candidateRequired = status === "completed"
        && current.status === "running"
        && (projectDelivery || candidatePolicy !== null);
      const developWorkspace = tx.getWorkItemWorkspace(task.id, current.id);
      if (status === "completed"
        && projectDelivery
        && developWorkspace === null
        && !metadataOnlyTaskFinalDelivery) {
        throw usageError(
          `Project-backed Work Item ${current.id} must be isolated before Candidate submission.`
        );
      }
      const updated = candidateRequired
        ? submitWorkItemCandidate(current, {
            summary: summary!,
            source: { type: "direct" },
            ...(candidatePolicy === null ? {} : { reviewPolicy: candidatePolicy }),
            ...(taskFinalContract === undefined
              ? {}
              : { taskFinalReviewContract: taskFinalContract }),
            ...(developWorkspace === null
              ? {}
              : { workspace: developWorkspace }),
            ...(options.candidateGitSnapshot === undefined
              ? {}
              : { gitSnapshot: options.candidateGitSnapshot }),
            ...(options.directTaskMainSnapshot === undefined
              ? {}
              : { taskMainSnapshot: options.directTaskMainSnapshot })
          }, now)
        : current.status === "failed" && status === "running"
        ? retryFailedWorkItem(current, now)
        : updateWorkItemStatus(
            current,
            status,
            now,
            isTerminalWorkItemStatus(status) ? summary : undefined
          );
      tx.saveWorkItem(task.id, updated);
      if (summary !== undefined) {
        recordTaskEvent(tx, task.id, "work.updated", {
          workItemId: updated.id,
          status: updated.status,
          summary,
          ...leaderActionEventPayload(tx, task.id, options)
        }, now);
      }
      enqueueWork(tx, taskMailbox(task.id), "work-updated", now, [
        workItemRef(task.id, updated.id)
      ]);
      const reviewDispatch = candidatePolicy?.trigger === "always"
        ? queueReviewRound(
            tx,
            updated,
            candidatePolicy,
            "policy",
            now
          )
        : null;
      return {
        item: updated,
        reviewDispatch,
        reviewTrigger: candidatePolicy?.trigger ?? null
      };
    }
    throw usageError(
      `Assigned Work Item execution cannot use task work update: ${current.id}. `
      + "Use dispatch and run yield, then let the Task Leader accept or reject the result; "
      + "use task work retire for an explicit Leader retirement."
    );
  });
  notifyMailbox(options.runtime, taskMailbox(result.item.taskId), result.item.taskId);
  if (result.reviewDispatch?.run !== null
    && result.reviewDispatch?.run !== undefined) {
    notifyReviewMailbox(
      options,
      options.runtime,
      roleMailbox(result.reviewDispatch.run.taskId, result.reviewDispatch.run.roleName),
      result.reviewDispatch.run.taskId
    );
  }
  if (result.item.status === "awaiting_acceptance" && status === "completed") {
    const failure = result.reviewDispatch?.round.status === "failed"
      ? `Review could not start: ${result.reviewDispatch.round.summary}\n`
      : "";
    const destination = result.reviewTrigger === "always"
      ? "review"
      : "Leader decision";
    return output(`Submitted work item ${result.item.id} for ${destination}\n${failure}`, {
      workItem: result.item,
      ...(result.reviewDispatch === null
        ? {}
        : { reviewRound: result.reviewDispatch.round })
    });
  }
  return output(`Updated work item ${result.item.id} to ${requested}\n`, {
    workItem: result.item
  });
}

function dispatchWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task work dispatch usage: yui task work dispatch <task>/<work> [--input <text>] [--strategy fixed:<count>|adaptive:<max>] [--lane-role <role> ...].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--input", "--strategy"]),
    new Set(["--lane-role"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const requestedStrategy = parseExecutionStrategy(parsed.options.get("--strategy"), usage);
  const requestedLaneRoles = parsed.multiOptions.get("--lane-role") ?? [];
  const now = clock(options);
  const runs = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(inactiveTaskMessage(task, "dispatch"));
    }
    const currentGroup = currentWorkItemExecutionGroup(item);
    const existingGroup = currentGroup?.resolution === undefined
      ? currentGroup
      : undefined;
    const expanding = item.status === "running" && existingGroup !== undefined;
    if (!expanding && item.status !== "pending" && item.status !== "failed") {
      throw usageError(`Work item ${item.id} cannot be dispatched from ${item.status}.`);
    }
    if (item.assignee === undefined) {
      throw usageError(
        `Work Item has no Task Role assignee: ${item.id}. `
        + `The Task Leader must run "yui task work update ${item.id} running", `
        + "then execute it directly or create native subagents in the Leader Session."
      );
    }
    if (expanding && taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may expand a running ExecutionGroup.");
    }
    assertWorkItemDependenciesCompleted(tx, item);
    const workspace = tx.getWorkItemWorkspace(task.id, item.id);
    if (workspace?.owner.type === "work-item"
      && workspace.owner.workItemId !== item.id) {
      throw usageError(
        `Task Role ${item.assignee} still uses the isolated worktree for ${workspace.owner.workItemId}; `
        + `cleanup ${workspace.owner.workItemId} before dispatching ${item.id}.`
      );
    }
    if (task.projectBindings.length > 0) {
      const writable = workspace?.owner.type === "work-item"
        && workspace.owner.workItemId === item.id
        ? workspace.entries
          .filter(({ access }) => access === "write")
          .map(({ projectId }) => projectId)
          .sort()
        : [];
      const visible = workspace?.owner.type === "work-item"
        && workspace.owner.workItemId === item.id
        ? workspace.entries.map(({ projectId }) => projectId).sort()
        : [];
      if (
        !isDeepStrictEqual(writable, [...item.writeProjectIds].sort())
        || !isDeepStrictEqual(
          visible,
          task.projectBindings.map(({ projectId }) => projectId).sort()
        )
      ) {
        throw usageError(
          `Work Item ${item.id} must be isolated with its approved Project scope before dispatch.`
        );
      }
    }
    const rawInput = trimmed(parsed.options.get("--input")) ?? item.objective;
    const runWorkspace = workspace ?? tx.getTaskWorkspace(task.id) ?? undefined;
    const lanePlan = normalizedExecutionLanePlan({
      assignee: item.assignee,
      requestedRoles: requestedLaneRoles,
      requestedStrategy,
      existingGroup,
      status: item.status,
      nextGroupId: `execution-group-${tx.peekNextAgentRunId(task.id)}`,
      retryLaneId: undefined,
      phase: "dispatch"
    });
    const laneRoles = lanePlan.roles;
    if (laneRoles.length === 0) {
      throw usageError("At least one --lane-role is required when expanding an ExecutionGroup.");
    }
    if (new Set(laneRoles).size !== laneRoles.length) {
      throw usageError("Each ExecutionGroup Lane must use a distinct Task Role.");
    }
    const strategy = lanePlan.strategy;
    if (existingGroup !== undefined && requestedStrategy !== undefined
      && !sameExecutionStrategy(existingGroup.strategy, requestedStrategy)) {
      throw usageError(`ExecutionGroup strategy is frozen: ${existingGroup.id}.`);
    }
    const available = lanePlan.capacity;
    const requestedCount = lanePlan.requestedCount;
    if (requestedCount > available) {
      throw usageError(`ExecutionGroup Lane count ${requestedCount} exceeds its ${strategy.mode} capacity ${available}.`);
    }
    if (strategy.mode === "fixed" && !expanding && laneRoles.length !== strategy.count) {
      throw usageError(`fixed:${strategy.count} requires exactly ${strategy.count} --lane-role values.`);
    }
    const roles = laneRoles.map((name) => requireRole(tx, task.id, name));
    const plans = roles.map((role) => {
      if (tx.getActiveAgentRun(task.id, role.name) !== null) {
        throw usageError(`${task.id}/${role.name} already has an active run.`);
      }
      return {
        role,
        runId: tx.nextAgentRunId(task.id)
      };
    });
    let group = existingGroup;
    if (group === undefined) {
      group = createExecutionGroup(
        `execution-group-${plans[0]!.runId}`,
        task.id,
        {
          purpose: "execution",
          target: executionTargetForWorkItem(task.id, item.id, item.revision, item, workspace),
          strategy,
          lanes: laneRoles.map((roleName) => ({ roleName }))
        },
        now
      );
    } else if (expanding) {
      for (const roleName of laneRoles) {
        group = addExecutionLane(group, { roleName }, now);
      }
    }
    const lanes = expanding
      ? group.lanes.slice(-plans.length)
      : group.lanes.slice(0, plans.length);
    if (lanes.length !== plans.length) throw new Error(`ExecutionGroup Lane planning drift: ${group.id}.`);
    const createdRuns: AgentRun[] = [];
    let runningGroup: ExecutionGroup = group;
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index]!;
      const lane = lanes[index]!;
      const laneIsolated = plans.length > 1 || group.lanes.length > 1 || group.strategy.mode === "adaptive";
      const laneManagedWorkspace = laneIsolated
        ? options.executionLaneWorkspaces?.get(lane.id)
        : runWorkspace;
      if (laneIsolated && laneManagedWorkspace === undefined && options.yuiHome !== undefined) {
        throw usageError(`Execution Lane workspace preflight is missing: ${group.id}/${lane.id}.`);
      }
      const effective = resolveEffectiveLaunch({
        role: plan.role,
        purpose: "execution",
        ...(laneManagedWorkspace === undefined ? {} : { workspace: laneManagedWorkspace }),
        workItemWriteProjectIds: item.writeProjectIds
      });
      const sessions = tx.getTaskRoleSessionSet(task.id, plan.role.name);
      const dispatchMode = roleAgentSessionResumeMode(
        sessions,
        effective.agentId,
        effective
      );
      const laneWorkspace = laneManagedWorkspace === undefined
        ? undefined
        : {
            root: laneManagedWorkspace.root,
            writableProjectIds: [...item.writeProjectIds]
          };
      const runningLane = lane.status === "failed"
        || lane.status === "yielded"
        || lane.status === "completed"
        ? restartExecutionLane(runningGroup, lane.id, {
            runId: plan.runId,
            effective,
            workspace: laneWorkspace
          }, now)
        : updateExecutionLane(runningGroup, lane.id, {
            status: "running",
            runId: plan.runId,
            effective,
            workspace: laneWorkspace
          }, now);
      runningGroup = runningLane;
      const assignment = createRunAssignment({
        runId: plan.runId,
        roleName: plan.role.name,
        purpose: "execution",
        action: item.status === "failed" ? "repair-work-item" : "execute-work-item",
        subject: {
          taskId: task.id,
          workItemId: item.id,
          executionGroupId: runningGroup.id,
          executionLaneId: lane.id
        },
        directive: `${rawInput}\nFrozen target: ${group.target.fingerprint}.`,
        deltaRefIds: []
      });
      createdRuns.push(createAgentRun(
        plan.runId,
        task.id,
        plan.role.name,
        dispatchMode,
        assignment,
        now,
        {
          workItemId: item.id,
          executionGroupId: runningGroup.id,
          executionLaneId: lane.id,
          ...(laneManagedWorkspace === undefined ? {} : { workspace: laneManagedWorkspace }),
          effective
        }
      ));
    }
    // A failed WorkItem must be reopened before attaching or updating its
    // execution Group. Each persisted transform advances exactly one revision.
    let workItemForDispatch = item.status === "failed"
      ? retryFailedWorkItem(item, now)
      : item;
    if (workItemForDispatch !== item) tx.saveWorkItem(task.id, workItemForDispatch);
    workItemForDispatch = currentWorkItemExecutionGroup(workItemForDispatch) === undefined
      ? attachWorkItemExecutionGroup(workItemForDispatch, runningGroup, now)
      : updateWorkItemExecutionGroup(workItemForDispatch, runningGroup, now);
    if (workItemForDispatch !== item) {
      tx.saveWorkItem(task.id, workItemForDispatch);
    }
    if (workItemForDispatch.status !== "running") {
      workItemForDispatch = updateWorkItemStatus(workItemForDispatch, "running", now);
      tx.saveWorkItem(task.id, workItemForDispatch);
    }
    for (const lane of runningGroup.lanes) {
      const prepared = options.executionLaneWorkspaces?.get(lane.id);
      if (prepared !== undefined) {
        if (prepared.owner.type !== "execution-lane"
          || prepared.owner.executionGroupId !== runningGroup.id
          || prepared.owner.executionLaneId !== lane.id) {
          throw usageError(`Execution Lane workspace identity does not match dispatch: ${runningGroup.id}/${lane.id}.`);
        }
        if (options.laneDispatchProjectPaths !== undefined) {
          // The prepared workspaces were created under a held maintenance
          // fence that this transaction still holds. Re-prove the Task
          // binding set and exact Project paths match the preparation
          // snapshot: a migrate in the prepare/adopt gap fails closed here
          // rather than stranding a Lane on the external checkout.
          const currentIds = task.projectBindings.map(({ projectId }) => projectId).sort();
          const proofIds = [...options.laneDispatchProjectPaths.keys()].sort();
          if (currentIds.length !== proofIds.length
            || currentIds.some((projectId, index) => projectId !== proofIds[index])) {
            throw new Error(`Task Project bindings changed during Lane dispatch: ${task.id}.`);
          }
          for (const [projectId, preparedPath] of options.laneDispatchProjectPaths) {
            if (requireProject(tx, projectId).path !== preparedPath) {
              throw new Error(`Project path changed during Lane dispatch: ${projectId}.`);
            }
          }
        }
        if (tx.getManagedWorkspace(prepared.owner) === null) tx.saveManagedWorkspace(prepared);
      }
    }
    for (let index = 0; index < createdRuns.length; index += 1) {
      const unboundRun = createdRuns[index]!;
      const snapshot = freezeRunContextSnapshot(tx, {
        taskId: task.id,
        roleName: unboundRun.roleName,
        purpose: "execution",
        workItemId: item.id
      }, now);
      const runWithLineage = withAgentRunContextSnapshot(
        unboundRun,
        contextSnapshotRef(snapshot),
        contextSnapshotDeltaRefIds(tx, snapshot)
      );
      createdRuns[index] = runWithLineage;
      const role = plans[index]!.role;
      tx.saveAgentRun(runWithLineage);
      tx.saveActiveAgentRun(runWithLineage);
      tx.saveRole(task.id, updateRoleStatus(role, "running", now));
      enqueueWork(tx, roleMailbox(task.id, role.name), "run-dispatched", now, [
        runRef(task.id, runWithLineage.id),
        workItemRef(task.id, item.id)
      ]);
      recordTaskEvent(tx, task.id, "run.dispatched", runLaunchEventPayload(runWithLineage), now);
    }
    return createdRuns;
  });
  for (const run of runs) notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName), run.taskId);
  const first = runs[0]!;
  return `Dispatch queued for ${first.taskId}/${first.roleName} (${first.id})${runs.length > 1 ? `; ${runs.length} Lanes` : ""}\n`;
}

function resolveWorkExecutionGroup(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work group resolve usage: yui task work group resolve <task>/<work> --decision <accept|reject|blocked> --summary <text> [--lane <lane-id> ...].";
  if (args[0] !== "resolve") throw usageError(usage);
  const parsed = parseMultiValueTail(
    args.slice(1),
    new Set(["--decision", "--summary"]),
    new Set(["--lane"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const decision = parseExecutionResolutionDecision(parsed.options.get("--decision"), usage);
  const summary = requiredOption(parsed.options, "--summary");
  const selectedLaneIds = parsed.multiOptions.get("--lane");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "resolving an ExecutionGroup"));
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may resolve an ExecutionGroup.");
    }
    const group = currentWorkItemExecutionGroup(item);
    if (group === undefined
      || (group.lanes.length < 2 && group.strategy.mode !== "adaptive")) {
      throw usageError(`Work Item ${item.id} has no resolvable ExecutionGroup.`);
    }
    if (item.status !== "running") {
      throw usageError(`Work Item ${item.id} cannot resolve from ${item.status}.`);
    }
    const acceptedLaneIds = decision === "accept"
      ? selectedLaneIds ?? group.lanes
        .filter((lane) => lane.status === "yielded" || lane.status === "completed")
        .map(({ id }) => id)
      : undefined;
    const resolutionSummary = acceptedLaneIds === undefined
      ? summary
      : aggregateExecutionLaneSummary(summary, group, acceptedLaneIds);
    const resolved = resolveExecutionGroup(group, {
      decision,
      summary: resolutionSummary,
      ...(decision === "accept"
        ? { selectedLaneIds: acceptedLaneIds }
        : selectedLaneIds === undefined ? {} : { selectedLaneIds })
    }, now);
    const groupedItem = updateWorkItemExecutionGroup(item, resolved, now);
    tx.saveWorkItem(task.id, groupedItem);
    if (decision !== "accept") {
      const failed = updateWorkItemStatus(groupedItem, "failed", now, summary);
      tx.saveWorkItem(task.id, failed);
      enqueueWork(tx, leaderMailbox(task.id), "work-group-resolved", now, [
        workItemRef(task.id, item.id)
      ]);
      return { item: failed, group: resolved, reviewDispatch: null };
    }
    const eligible = resolved.lanes
      .filter((lane) => resolved.resolution?.selectedLaneIds.includes(lane.id) ?? false)
      .map((lane) => lane.runId === undefined ? null : tx.getAgentRun(task.id, lane.runId))
      .find((run): run is AgentRun => run !== null && run !== undefined && run.status === "yielded");
    if (eligible === undefined) {
      throw usageError(`ExecutionGroup ${group.id} has no yielded selected Lane Run to capture.`);
    }
    const candidateWorkspace = options.candidateWorkspace;
    if (candidateWorkspace === undefined && options.yuiHome !== undefined) {
      throw usageError(`ExecutionGroup ${group.id} Candidate materialization preflight is missing.`);
    }
    const configuredReview = tx.getReviewConfig();
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    const candidatePolicy = taskFinalContract === undefined
      ? legacyWorkItemReviewConfig(configuredReview)
      : taskFinalReviewConfig(taskFinalContract);
    const candidate = submitWorkItemCandidate(groupedItem, {
      summary: resolutionSummary,
      source: { type: "run", runId: eligible.id },
      executionGroupId: resolved.id,
      executionLaneId: eligible.executionLaneId,
      ...(candidatePolicy === null ? {} : { reviewPolicy: candidatePolicy }),
      ...(taskFinalContract === undefined ? {} : { taskFinalReviewContract: taskFinalContract }),
      ...(candidateWorkspace === null
        ? {}
        : candidateWorkspace === undefined
          ? (eligible.workspace === undefined ? {} : { workspace: eligible.workspace })
          : { workspace: candidateWorkspace }),
      ...(options.candidateGitSnapshot === undefined ? {} : { gitSnapshot: options.candidateGitSnapshot })
    }, now);
    tx.saveWorkItem(task.id, candidate);
    const reviewDispatch = candidatePolicy?.trigger === "always"
      ? queueReviewRound(tx, candidate, candidatePolicy, "policy", now)
      : null;
    enqueueWork(tx, leaderMailbox(task.id), "candidate-ready", now, [
      runRef(task.id, eligible.id),
      workItemRef(task.id, item.id)
    ]);
    return { item: candidate, group: resolved, reviewDispatch };
  });
  if (result.reviewDispatch?.run !== null && result.reviewDispatch?.run !== undefined) {
    notifyReviewMailbox(
      options,
      options.runtime,
      roleMailbox(result.reviewDispatch.run.taskId, result.reviewDispatch.run.roleName),
      result.reviewDispatch.run.taskId
    );
  }
  return output(
    `Resolved ExecutionGroup ${result.group.id} as ${decision}; Work Item ${result.item.id} is ${result.item.status}.\n`,
    { workItem: result.item, executionGroup: result.group }
  );
}

function aggregateExecutionLaneSummary(
  leaderSummary: string,
  group: ExecutionGroup,
  selectedLaneIds?: readonly string[]
): string {
  const selected = selectedLaneIds === undefined ? null : new Set(selectedLaneIds);
  const lanes = group.lanes.filter((lane) => selected === null || selected.has(lane.id)).map((lane) => {
    const result = lane.result;
    return [
      `Lane ${lane.id} (${lane.roleName}) status=${lane.status}`,
      result?.report === undefined ? "" : `report=${result.report}`,
      result?.checks === undefined ? "" : `checks=${JSON.stringify(result.checks)}`,
      result?.findings === undefined ? "" : `findings=${JSON.stringify(result.findings)}`,
      result?.evidence === undefined ? "" : `evidence=${JSON.stringify(result.evidence)}`,
      result?.evidenceCommit === undefined ? "" : `evidenceCommit=${result.evidenceCommit}`,
    ].filter((part) => part.length > 0).join("; ");
  });
  return [leaderSummary.trim(), ...lanes].filter((part) => part.length > 0).join("\n");
}

function executionTargetForWorkItem(
  taskId: string,
  workItemId: string,
  revision: number,
  item: WorkItem,
  workspace: ReturnType<TaskWorkflowStore["getWorkItemWorkspace"]>
): ExecutionTarget {
  const projects = item.writeProjectIds.flatMap((projectId) => {
    const entry = workspace?.entries.find((candidate) => candidate.projectId === projectId);
    return entry === undefined ? [] : [{ projectId, commit: entry.baseCommit }];
  });
  const fingerprint = JSON.stringify({ taskId, workItemId, revision, projects });
  return {
    schemaVersion: 1,
    kind: "work-item",
    taskId,
    workItemId,
    revision,
    projects,
    fingerprint
  };
}

function executionTargetForReviewRound(
  task: Task,
  round: ReviewRound,
  item: WorkItem,
  candidate: WorkItemCandidate
): ExecutionTarget {
  const taskScope = (round.scope ?? "work-item") === "task";
  const projects = taskScope
    ? round.taskCandidate?.projects ?? []
    : candidate.gitSnapshot?.projects ?? [];
  const fingerprint = JSON.stringify({
    taskId: task.id,
    reviewRoundId: round.id,
    workItemId: item.id,
    candidateId: candidate.id,
    scope: taskScope ? "task" : "work-item",
    projects,
    contractDigest: round.taskFinalReviewContract?.digest
  });
  return {
    schemaVersion: 1,
    kind: taskScope ? "task-final-review" : "work-item",
    taskId: task.id,
    workItemId: item.id,
    candidateId: candidate.id,
    revision: candidate.workItemRevision,
    projects,
    ...(round.taskFinalReviewContract === undefined
      ? {}
      : { contractDigest: round.taskFinalReviewContract.digest }),
    fingerprint
  };
}

function acceptWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work accept usage: yui task work accept <task>/<work> --summary <text>.";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = requiredOption(parsed.options, "--summary");
  const now = clock(options);
  const accepted = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may accept a Work Item.");
    }
    if (item.status !== "awaiting_acceptance") {
      throw usageError(`Work Item is not awaiting acceptance: ${item.id}/${item.status}.`);
    }
    if (options.workItemIntegrationProof?.workspace.owner.type === "review-round") {
      throw usageError(
        "A ReviewRound-owned workspace cannot be used for WorkItem acceptance."
      );
    }
    // Only diagnostic evidence commits (a reviewer's own commit on top of the
    // frozen base) are barred from WorkItem acceptance.  A clean review
    // attests the frozen base itself (evidenceCommit === reviewBaseCommit),
    // which is the candidate's own head.
    const diagnosticEvidence = new Set(tx.listReviewRounds(item.taskId)
      .flatMap(({ evidenceCommit, reviewBaseCommit }) =>
        evidenceCommit !== undefined && evidenceCommit !== reviewBaseCommit
          ? [evidenceCommit]
          : []));
    if (options.workItemIntegrationProof?.projects.some(
      ({ headCommit }) => diagnosticEvidence.has(headCommit)
    )) {
      throw usageError("A ReviewRound diagnostic evidence commit cannot be used for WorkItem acceptance.");
    }
    const candidate = requireWorkItemCandidate(item);
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (!sameTaskFinalReviewContract(
      candidate.taskFinalReviewContract,
      taskFinalContract
    )) {
      throw usageError(
        `Task final-review contract does not match Candidate ${candidate.id}.`
      );
    }
    const latestReview = reviewRoundsByIdentity(tx.listReviewRounds(item.taskId)
      .filter((round) => round.workItemId === item.id
        && round.candidateId === candidate.id)).at(-1);
    if (latestReview !== undefined
      && (latestReview.status === "pending" || latestReview.status === "running")) {
      throw usageError(
        `ReviewRound is not completed: ${latestReview.id}/${latestReview.status}.`
      );
    }
    if (candidate.reviewPolicy?.trigger === "always"
      && latestReview === undefined) {
      throw usageError(`Work Item candidate has no required ReviewRound: ${item.id}.`);
    }
    const isolatedWorkspace = tx.getWorkItemWorkspace(item.taskId, item.id);
    const metadataOnlyTaskFinalDelivery = item.assignee === undefined
      && candidate.source.type === "direct"
      && candidate.workspace === undefined
      && candidate.taskFinalReviewContract !== undefined
      && taskFinalContract !== undefined;
    if (task.projectBindings.length > 0
      && item.writeProjectIds.length > 0
      && isolatedWorkspace === null
      && !metadataOnlyTaskFinalDelivery) {
      throw usageError(
        `Project-backed Work Item ${item.id} has no WorkItem Develop workspace for acceptance.`
      );
    }
    if (
      isolatedWorkspace?.owner.type === "work-item"
      && isolatedWorkspace.owner.workItemId === item.id
      && isolatedWorkspace.entries.some(({ access }) => access === "write")
    ) {
      assertWorkItemIntegrationProof(
        tx,
        item.id,
        item.assignee,
        isolatedWorkspace,
        options.workItemIntegrationProof
      );
    }
    const completed = updateWorkItemStatus(item, "completed", now, summary);
    tx.saveWorkItem(item.taskId, completed);
    recordTaskEvent(tx, item.taskId, "work.accepted", {
      workItemId: item.id,
      candidateId: candidate.id,
      ...(candidate.source.type === "run"
        ? { runId: candidate.source.runId }
        : { workItemRevision: String(candidate.workItemRevision) }),
      acceptedBy: "leader",
      summary,
      ...leaderActionEventPayload(tx, item.taskId, options)
    }, now);
    return completed;
  });
  return output(`Accepted Work Item ${accepted.id}\n`, { workItem: accepted });
}

function assertWorkItemIntegrationProof(
  store: TaskWorkflowStore,
  workItemId: string,
  assignee: string | undefined,
  workspace: NonNullable<ReturnType<TaskWorkflowStore["getWorkItemWorkspace"]>>,
  proof: WorkItemIntegrationProof | undefined
): void {
  if (
    proof === undefined
    || proof.workItemId !== workItemId
    || proof.assignee !== assignee
    || !isDeepStrictEqual(proof.workspace, workspace)
  ) {
    throw usageError(
      `WorkItem workspace has not been verified for acceptance: ${workItemId}.`
    );
  }
  const writable = workspace.entries.filter(({ access }) => access === "write");
  if (proof.projects.length !== writable.length) {
    throw usageError(`WorkItem integration verification is stale: ${workItemId}.`);
  }
  for (const entry of writable) {
    const projectProof = proof.projects.find(({ projectId }) => projectId === entry.projectId);
    if (projectProof === undefined || projectProof.baseCommit !== entry.baseCommit) {
      throw usageError(`WorkItem integration verification is stale: ${workItemId}.`);
    }
    const latestChangeSet = store.listChangeSets(workspace.owner.taskId)
      .filter((changeSet) => (
        changeSet.workItemId === workItemId
        && changeSet.projectId === entry.projectId
      ))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ))
      .at(-1);
    if (projectProof.headCommit === entry.baseCommit) {
      if (projectProof.changeSetId !== undefined || latestChangeSet !== undefined) {
        throw usageError(`WorkItem integration verification is stale: ${workItemId}.`);
      }
      continue;
    }
    if (
      projectProof.changeSetId === undefined
      || latestChangeSet?.id !== projectProof.changeSetId
      || latestChangeSet.baseCommit !== entry.baseCommit
      || latestChangeSet.headCommit !== projectProof.headCommit
      || latestChangeSet.branch !== entry.branch
    ) {
      throw usageError(
        `WorkItem integration verification is stale: ${workItemId}.`
      );
    }
    if (!store.listIntegrationAttempts(workspace.owner.taskId).some((integration) => (
      integration.status === "committed"
      && integration.projectId === entry.projectId
      && integration.changeSetIds.includes(projectProof.changeSetId!)
    ))) {
      throw usageError(`Work Item ChangeSet is not integrated: ${projectProof.changeSetId}.`);
    }
  }
}

function rejectWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work reject usage: yui task work reject <task>/<work> --summary <text>.";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = requiredOption(parsed.options, "--summary");
  const now = clock(options);
  const rejected = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may reject a Work Item.");
    }
    if (item.status !== "awaiting_acceptance") {
      throw usageError(`Work Item is not awaiting acceptance: ${item.id}/${item.status}.`);
    }
    const candidate = requireWorkItemCandidate(item);
    const activeReview = activeReviewRoundForCandidate(tx, item, candidate);
    if (activeReview !== undefined) {
      throw usageError(`ReviewRound is still active: ${activeReview.id}/${activeReview.status}.`);
    }
    const failed = updateWorkItemStatus(item, "failed", now, summary);
    tx.saveWorkItem(item.taskId, failed);
    recordTaskEvent(tx, item.taskId, "work.rejected", {
      workItemId: item.id,
      candidateId: candidate.id,
      rejectedBy: "leader",
      summary
    }, now);
    return failed;
  });
  return output(`Rejected Work Item ${rejected.id}\n`, { workItem: rejected });
}

function retireWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work retire usage: yui task work retire <task>/<work> --summary <text> [--replacement <task>/<work>].";
  const parsed = parseTail(args, new Set(["--summary", "--replacement"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const workItemId = parsed.positionals[0]!;
  const summary = requiredOption(parsed.options, "--summary");
  const replacementWorkItemId = parsed.options.get("--replacement");
  const now = clock(options);
  const retired = store.transaction((tx) => {
    const item = requireWorkItem(tx, workItemId, options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may retire a Work Item.");
    }
    if (replacementWorkItemId !== undefined) {
      const replacement = requireWorkItem(tx, replacementWorkItemId, options);
      if (replacement.taskId !== task.id) {
        throw usageError(
          `Replacement Work Item must belong to the same Task: ${replacementWorkItemId}.`
        );
      }
      if (replacement.id === item.id) {
        throw usageError("A Work Item cannot replace itself.");
      }
    }
    // rr4/finding-5: A Work Item with an active DurableJob cannot be retired —
    // the runner may still be using its workspace. Block on queued, running,
    // and unacknowledged unknown-needs-attention jobs owned by this Work Item.
    const activeWorkItemJob = tx.listDurableJobs(task.id).find((job) => (
      job.owner.kind === "work-item"
      && job.owner.workItemId === item.id
      && (
        job.status === "queued"
        || job.status === "running"
        || (job.status === "unknown-needs-attention" && job.acknowledgedAt === undefined)
      )
    ));
    if (activeWorkItemJob !== undefined) {
      throw usageError(
        `Work Item ${item.id} has an active DurableJob: `
        + `${activeWorkItemJob.id}/${activeWorkItemJob.status}. `
        + "Cancel or acknowledge it before retiring."
      );
    }
    for (const run of tx.listAgentRuns(task.id).filter((candidate) => (
      candidate.status === "active" && candidate.workItemId === item.id
    ))) {
      const terminal = terminalizeExactTaskRun(tx, {
        taskId: task.id,
        roleName: run.roleName,
        agentId: run.effective.agentId,
        runId: run.id,
        receiptId: agentRunDeliveryReceiptId(run),
        outcome: {
          status: "failed",
          summary: `Work Item retired: ${summary}`
        }
      }, now);
      if (terminal.disposition !== "applied") {
        throw usageError(
          `Work Item Run changed during retirement: ${run.id}/${terminal.reason ?? "obsolete"}.`
        );
      }
    }
    const next = retireWorkItem(item, {
      by: "leader",
      summary,
      ...(replacementWorkItemId === undefined ? {} : { replacementWorkItemId })
    }, now);
    if (next !== item) {
      tx.saveWorkItem(task.id, next);
      recordTaskEvent(tx, task.id, "work.retired", {
        workItemId: next.id,
        summary,
        ...(replacementWorkItemId === undefined
          ? {}
          : { replacementWorkItemId }),
        ...leaderActionEventPayload(tx, task.id, options)
      }, now);
    }
    return next;
  });
  options.runtime?.notifyStateChanged(retired.taskId);
  return output(`Retired Work Item ${retired.id}\n`, { workItem: retired });
}

function listWork(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  exactPositionals(args, 1, "Task work list usage: yui task work list <task>.");
  const task = requireTask(store, args[0]);
  const items = store.listWorkItems(task.id);
  const rendered = items.length === 0
    ? "No work items found.\n"
    : `${renderTable(
        `Task work: ${task.id}`,
        [
          { header: "Work", minWidth: 6, maxWidth: 20 },
          { header: "Status", minWidth: 6, maxWidth: 12 },
          { header: "Role", minWidth: 4, maxWidth: 18 },
          { header: "Write Projects", minWidth: 8, maxWidth: 28 },
          { header: "Title", minWidth: 8, maxWidth: 64 },
          { header: "Acceptance", minWidth: 10, maxWidth: 16 },
          { header: "Outcome", minWidth: 8, maxWidth: 40 }
        ],
        items.map((item) => [
          item.id,
          presentWorkStatus(item.status),
          item.assignee ?? "Leader",
          item.writeProjectIds.join(", ") || "-",
          item.title,
          String(item.acceptance.length),
          item.outcome ?? "-"
        ]),
        defaultTableWidth()
      )}\n`;
  return output(rendered, { workItems: items });
}

function showWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task work show usage: yui task work show <work>.");
  const item = requireWorkItem(store, args[0], options);
  const replacement = item.disposition?.replacementWorkItemId;
  const rendered = [
    `Work Item: ${item.id}`,
    `Task: ${item.taskId}`,
    `Status: ${presentWorkStatus(item.status)}`,
    `Role: ${item.assignee ?? "Leader"}`,
    `Title: ${item.title}`,
    `Objective: ${item.objective}`,
    `Write Projects: ${item.writeProjectIds.join(", ") || "-"}`,
    `Base Refs: ${item.baseRefs?.map(({ projectId, baseRef }) => `${projectId}=${baseRef}`).join(", ") || "-"}`,
    `Acceptance: ${item.acceptance.length === 0 ? "-" : item.acceptance.join("; ")}`,
    `Outcome: ${item.outcome ?? "-"}`,
    `Retirement: ${item.disposition === undefined ? "-" : "retired"}`,
    `Replacement: ${replacement ?? "-"}`
  ].join("\n");
  return output(`${rendered}\n`, { workItem: item });
}

function reviewWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task work review usage: yui task work review <task>/<work>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const item = requireWorkItem(tx, args[0], options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may request a Work Item review.");
    }
    if (item.status !== "awaiting_acceptance") {
      throw usageError(`Work Item is not awaiting acceptance: ${item.id}/${item.status}.`);
    }
    const candidate = requireWorkItemCandidate(item);
    const config = candidate.reviewPolicy;
    if (config === undefined) {
      throw usageError(`Candidate has no review policy: ${candidate.id}.`);
    }
    if (config.trigger === "final") {
      throw usageError(
        `Final review policy is Task-scoped; complete Task ${task.id} to request its final Review.`
      );
    }
    const activeRound = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((round) => (
        round.workItemId === item.id
        && round.candidateId === candidate.id
        && (round.status === "pending" || round.status === "running")
      ))).at(-1);
    if (activeRound !== undefined) {
      if (activeRound.status === "pending" && activeRound.reviewerRunId === undefined) {
        return { round: activeRound, run: null, resumed: true as const };
      }
      throw usageError(`ReviewRound is already active: ${activeRound.id}/${activeRound.status}.`);
    }
    const queued = queueReviewRound(
      tx,
      item,
      config,
      "leader",
      now
    );
    return { ...queued, resumed: false as const };
  });
  if (result.run !== null) {
    notifyReviewMailbox(
      options,
      options.runtime,
      roleMailbox(result.run.taskId, result.run.roleName),
      result.run.taskId
    );
  }
  if (result.resumed) {
    return output(
      `Review request ${result.round.id} is pending; resuming dispatch.\n`,
      { reviewRound: result.round }
    );
  }
  return result.round.status === "failed"
    ? output(
        `Review could not start for ${result.round.workItemId}: ${result.round.summary}\n`,
        { reviewRound: result.round }
      )
    : output(`Review requested as ${result.round.id}\n`, { reviewRound: result.round });
}

/**
 * Leader-controlled recovery for a failed Task-final ReviewRound that never
 * created a Reviewer Run. This is deliberately separate from `task run retry`:
 * that command requires an exact failed Agent Run and remains the only retry
 * path for a failed provider execution. Here the old terminal Round is an
 * immutable anchor and one fresh Round is created only after the same frozen
 * committed Integration/ChangeSet provenance and Reviewer independence fences
 * pass again.
 */
function taskReviewCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "request") return requestTaskReviewRound(rest, store, options);
  if (command === "force-fresh") return forceFreshTaskReviewRound(rest, store, options);
  if (command === "retry") return retryFailedTaskReviewRound(rest, store, options);
  if (command === "group") return resolveReviewExecutionGroup(rest, store, options);
  if (command === "finding") return reviewFindingCommand(rest, store, options);
  throw usageError(command === undefined
    ? "Task review command is required."
    : `Unknown command: task review ${command}`);
}

function resolveReviewExecutionGroup(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task review group resolve usage: yui task review group resolve <task>/<review-round> --decision <accept|reject|blocked> --summary <text> [--lane <lane-id> ...].";
  if (args[0] !== "resolve") throw usageError(usage);
  const parsed = parseMultiValueTail(
    args.slice(1),
    new Set(["--decision", "--summary"]),
    new Set(["--lane"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const decision = parseExecutionResolutionDecision(parsed.options.get("--decision"), usage);
  const summary = requiredOption(parsed.options, "--summary");
  const selectedLaneIds = parsed.multiOptions.get("--lane");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const round = requireReviewRound(tx, parsed.positionals[0], options);
    const task = requireTask(tx, round.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "resolving a Review ExecutionGroup"));
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may resolve a Reviewer ExecutionGroup.");
    }
    const group = round.executionGroup;
    if (group === undefined
      || (group.lanes.length < 2 && group.strategy.mode !== "adaptive")) {
      throw usageError(`ReviewRound ${round.id} has no resolvable ExecutionGroup.`);
    }
    if (round.status !== "running") {
      throw usageError(`ReviewRound ${round.id} cannot resolve from ${round.status}.`);
    }
    const resolved = resolveExecutionGroup(group, {
      decision,
      summary,
      ...(decision === "accept"
        ? {
            selectedLaneIds: selectedLaneIds ?? group.lanes
              .filter((lane) => lane.status === "yielded" || lane.status === "completed")
              .map(({ id }) => id)
          }
        : selectedLaneIds === undefined ? {} : { selectedLaneIds })
    }, now);
    const withGroup = updateReviewExecutionGroup(round, resolved);
    const selectedLanes = resolved.lanes
      .filter((lane) => resolved.resolution?.selectedLaneIds.includes(lane.id) ?? false);
    const laneReports = selectedLanes
      .map((lane) => lane.result?.report ?? lane.result?.summary ?? "")
      .filter((report) => report.length > 0);
    const checks = selectedLanes
      .flatMap((lane) => lane.result?.checks ?? [])
      .map(({ name, outcome, details }) => ({
        name,
        outcome,
        ...(details === undefined ? {} : { details })
      }));
    const findings = selectedLanes
      .flatMap((lane) => lane.result?.findings ?? []);
    const evidence = selectedLanes
      .flatMap((lane) => lane.result?.evidence ?? []);
    const evidenceCommits = [...new Set(selectedLanes
      .map((lane) => lane.result?.evidenceCommit)
      .filter((commit): commit is string => commit !== undefined))];
    // A Round attests a single tree only when EVERY selected Lane attests it.
    // A dirty Lane (no evidenceCommit) ran checks on an uncommitted tree, so its
    // checks cannot be covered by another Lane's base attestation.
    const allLanesAttest = selectedLanes.every(
      (lane) => lane.result?.evidenceCommit !== undefined
    );
    const evidenceCommit = allLanesAttest && evidenceCommits.length === 1
      ? evidenceCommits[0]
      : undefined;
    const terminal = finishReviewRound(
      withGroup,
      decision === "accept" ? "completed" : "failed",
      summary,
      now,
      {
        report: [
          laneReports.join("\n\n") || summary,
          ...(findings.length === 0
            ? []
            : [`Findings: ${findings.map(({ id, severity, status, summary: findingSummary }) => `${id} [${severity}/${status}] ${findingSummary}`).join("; ")}`]),
          ...(evidence.length === 0 ? [] : [`Evidence: ${evidence.join("; ")}`]),
          ...(evidenceCommits.length <= 1
            ? []
            : [`Lane evidence commits: ${evidenceCommits.join(", ")}`])
        ].join("\n\n"),
        checks,
        ...(evidenceCommit === undefined ? {} : { evidenceCommit })
      }
    );
    tx.saveReviewRound(task.id, terminal);
    // Issue 06: a panel-resolved completed Round feeds the finding ledger;
    // a rejected Round is an execution-attempt failure and is skipped.
    if (terminal.status === "completed") {
      reconcileReviewFindingsAfterReview(tx, task.id, terminal.id, now);
    }
    enqueueWork(tx, leaderMailbox(task.id), "review-group-resolved", now, [
      workItemRef(task.id, round.workItemId)
    ]);
    return terminal;
  });
  return output(
    `Resolved Review ExecutionGroup ${result.executionGroup?.id ?? "unknown"} as ${decision}; ReviewRound ${result.id} is ${result.status}.\n`,
    { reviewRound: result }
  );
}

/**
 * Issue 06: `yui task review finding` — the cross-Round finding ledger CLI.
 * Findings are extracted automatically from completed Rounds; these commands
 * let the Leader inspect the ledger, disposition each finding, and plan the
 * parallel repair wave.
 */
function reviewFindingCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") return listReviewFindings(rest, store, options);
  if (command === "dispose") return disposeReviewFindingCommand(rest, store, options);
  if (command === "repair-wave") return planReviewRepairWave(rest, store, options);
  if (command === "extract") return extractReviewFindingsCommand(rest, store, options);
  throw usageError(command === undefined
    ? "Task review finding command is required."
    : `Unknown command: task review finding ${command}`);
}

function listReviewFindings(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task review finding list usage: yui task review finding list <task>.";
  exactPositionals(args, 1, usage);
  const task = requireTask(store, args[0]!);
  const findings = store.listReviewFindings(task.id);
  if (findings.length === 0) {
    return output(`No review findings recorded for ${task.id}.\n`);
  }
  const lines = findings.map((finding) => {
    const repair = finding.repair === undefined
      ? ""
      : `; repair: ${finding.repair.workItemId ?? "?"}${finding.repair.commit === undefined ? "" : `@${finding.repair.commit.slice(0, 12)}`}`;
    const merge = finding.mergeRequired === true ? " [merge-required]" : "";
    return `${finding.id} [${finding.severity}/${finding.disposition}] ${finding.title}`
      + ` (invariant: ${finding.invariant}; first: ${finding.firstReviewRoundId}; last: ${finding.lastReviewRoundId})${repair}${merge}`;
  });
  return output(`Review findings for ${task.id}:\n${lines.join("\n")}\n`);
}

function disposeReviewFindingCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task review finding dispose usage: yui task review finding dispose <task>/<finding> "
    + "--disposition <fixed-pending-review|verified-fixed|accepted-risk|not-actionable|superseded> "
    + "[--work-item <id>] [--commit <sha>] [--verification <text>] [--note <text>] [--superseded-by <stable-key>].";
  const parsed = parseTail(
    args,
    new Set(["--disposition", "--work-item", "--commit", "--verification", "--note", "--superseded-by"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const disposition = requiredOption(parsed.options, "--disposition") as ReviewFindingDisposition;
  if (!LEADER_FINDING_DISPOSITIONS.includes(disposition)) {
    throw usageError(`Review finding disposition is invalid: ${disposition}.`);
  }
  const now = clock(options);
  const reference = resolveTaskRecordReference(parsed.positionals[0]!, {
    kind: "reviewFinding",
    label: "Review finding"
  });
  const result = store.transaction((tx) => {
    const task = requireTask(tx, reference.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "dispositioning a review finding"));
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may disposition a review finding.");
    }
    const command: ReviewFindingDispositionCommand = {
      disposition,
      by: taskLeaderActionRunId(tx, task.id, options.environment, options.yuiHome) ?? "leader",
      ...(parsed.options.get("--note") === undefined ? {} : { note: parsed.options.get("--note")! }),
      ...(parsed.options.get("--work-item") === undefined ? {} : { workItemId: parsed.options.get("--work-item")! }),
      ...(parsed.options.get("--commit") === undefined ? {} : { commit: parsed.options.get("--commit")! }),
      ...(parsed.options.get("--verification") === undefined ? {} : { verification: parsed.options.get("--verification")! }),
      ...(parsed.options.get("--superseded-by") === undefined ? {} : { supersededBy: parsed.options.get("--superseded-by")! }),
      now
    };
    return dispositionReviewFinding(tx, task.id, reference.localId, command);
  });
  return output(`Dispositioned ${result.id} as ${result.disposition}.\n`);
}

function planReviewRepairWave(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task review finding repair-wave usage: yui task review finding repair-wave <task> [--create].";
  const parsed = parseTail(args, new Set(), usage, new Set(["--create"]));
  exactPositionals(parsed.positionals, 1, usage);
  const task = requireTask(store, parsed.positionals[0]!);
  const groups = planRepairGroups(store, task.id);
  if (groups.length === 0) {
    return output(`No open P1/P2 findings need repair for ${task.id}.\n`);
  }
  if (parsed.options.has("--create")) {
    const now = clock(options);
    const created = store.transaction((tx) => {
      const currentTask = requireTask(tx, task.id);
      if (currentTask.status !== "active") {
        throw usageError(inactiveTaskMessage(currentTask, "creating a review repair wave"));
      }
      if (taskActor(options, currentTask.id) !== "leader") {
        throw usageError("Only the Task Leader may create a review repair wave.");
      }
      const openItems = tx.listWorkItems(currentTask.id)
        .filter((item) => item.status === "pending" || item.status === "running");
      return groups.map((group) => {
        const findingMarkers = group.findingIds.map((id) => `review-finding:${id}`);
        const existing = openItems.find((item) => isDeepStrictEqual(
          [...item.acceptance].sort(),
          [...findingMarkers].sort()
        ));
        if (existing !== undefined) return { group, item: existing, changed: false } as const;
        const item = createWorkItem(tx.nextWorkItemId(currentTask.id), currentTask.id, {
          title: `Repair review findings ${group.findingIds.join(", ")}`,
          objective: [
            "Repair the following Task-final Review findings as one overlapping group:",
            ...group.findings.map((finding) => (
              `- ${finding.id} [${finding.severity}] ${finding.title} `
              + `(invariant: ${finding.invariant}; evidence: ${finding.evidence.join(" | ") || "see ReviewRound"})`
            )),
            "Integrate this repair with the rest of the Task before requesting another Task-final Review."
          ].join("\n"),
          acceptance: findingMarkers,
          writeProjectIds: reviewRepairProjectIds(currentTask, group.affectedPaths)
        }, now);
        tx.saveWorkItem(currentTask.id, item);
        enqueueWork(tx, taskMailbox(currentTask.id), "work-created", now, [
          workItemRef(currentTask.id, item.id)
        ]);
        return { group, item, changed: true } as const;
      });
    });
    const lines = created.map(({ group, item, changed }) => (
      `wave ${group.groupKey}: ${item.id} ${changed ? "created" : "already open"} `
      + `(${group.findingIds.join(", ")})`
    ));
    return output(
      `Review repair wave for ${task.id} (${groups.length} group(s)):\n${lines.join("\n")}\n`,
      { groups: created }
    );
  }
  const lines = groups.map((group, index) => {
    const findings = group.findings
      .map((finding) => `${finding.id} [${finding.severity}] ${finding.title}`)
      .join("; ");
    return `wave ${index + 1}: ${findings}`
      + ` (paths: ${group.affectedPaths.join(", ") || "none"}; invariants: ${group.invariants.join(", ")})`;
  });
  return output(`Repair wave for ${task.id} (${groups.length} group(s), run disjoint groups in parallel):\n${lines.join("\n")}\n`);
}

function reviewRepairProjectIds(
  task: Task,
  affectedPaths: readonly string[]
): readonly string[] {
  const bindings = task.projectBindings;
  const matched = bindings.filter((binding) => affectedPaths.some((path) => pathWithinProject(path, binding.directory)));
  const projectIds = (matched.length > 0 ? matched : bindings).map(({ projectId }) => projectId);
  return [...new Set(projectIds)];
}

function pathWithinProject(path: string, directory: string): boolean {
  const normalizedPath = path.replace(/^\.\//u, "").replace(/^\/+/u, "");
  const normalizedDirectory = directory.replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
  if (normalizedDirectory.length === 0 || normalizedDirectory === ".") return true;
  return normalizedPath === normalizedDirectory
    || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

function extractReviewFindingsCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task review finding extract usage: yui task review finding extract <task>/<review-round>.";
  exactPositionals(args, 1, usage);
  const reference = resolveTaskRecordReference(args[0]!, {
    kind: "reviewRound",
    label: "ReviewRound"
  });
  const now = clock(options);
  const result = store.transaction((tx) =>
    reconcileReviewFindings(tx, reference.taskId, reference.localId, now));
  if (result.skipped) {
    return output(`ReviewRound ${result.roundId} produced no findings: ${result.reason ?? "skipped"}\n`);
  }
  return output(`Reconciled ${result.created.length + result.updated.length + result.conflicts.length} finding(s) from ${result.roundId}: `
    + `${result.created.length} created, ${result.updated.length} updated, ${result.conflicts.length} conflict(s).\n`);
}

function requestTaskReviewRound(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task review request usage: yui task review request <task> --role <global-role> "
    + "[--strategy fixed:<count>|adaptive:<max>] [--lane-role <role> ...] [--delta-recheck].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--role", "--strategy"]),
    new Set(["--lane-role"]),
    usage,
    new Set(["--delta-recheck"])
  );
  exactPositionals(parsed.positionals, 1, usage);
  const reviewerRoleName = requiredOption(parsed.options, "--role");
  const requestedStrategy = parseExecutionStrategy(parsed.options.get("--strategy"), usage);
  const requestedLaneRoles = parsed.multiOptions.get("--lane-role") ?? [];
  const deltaRecheckRequested = parsed.options.has("--delta-recheck");
  const now = clock(options);
  const round = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may request a Task-final Review.");
    }
    if (task.projectBindings.length === 0) {
      throw usageError(`Task ${task.id} has no bound Projects for a Task-final Review.`);
    }
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (deltaRecheckRequested) {
      const reviewConfig = tx.getReviewConfig();
      if (reviewConfig === null || reviewConfig.deltaRecheck !== "enabled") {
        throw usageError(
          "Delta-recheck is not enabled for this Project's review policy. "
          + "Set `yui config workflow set review --role <role> --trigger final --delta-recheck enabled` "
          + "or request a full Review."
        );
      }
      if (taskFinalContract !== undefined) {
        throw usageError("Delta-recheck is not supported with a Task-final review contract.");
      }
    }
    if (tx.getGlobalRole(reviewerRoleName) === null) {
      throw usageError(`Global Role not found: ${reviewerRoleName}.`);
    }

    const provenance = taskReviewProvenance(tx, task, options);
    const producerCollision = taskReviewProducerCollision(provenance, reviewerRoleName);
    if (producerCollision !== null) {
      throw usageError(producerCollision);
    }
    const anchor = latestTaskReviewAnchor(tx, task);
    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id))
      .filter((entry) => (entry.scope ?? "work-item") === "task");
    const exact = taskRounds.filter((entry) => (
      entry.reviewerRoleName === reviewerRoleName
      && (taskFinalContract === undefined || sameTaskFinalReviewContract(
        entry.taskFinalReviewContract,
        taskFinalContract
      ))
      && isSameTaskReviewCandidate(entry.taskCandidate, provenance.candidate)
    )).at(-1);
    if (exact !== undefined
      && (deltaRecheckRequested || !deltaRecheckBlocksAcceptance(exact))) {
      if (exact.status === "failed") {
        throw usageError(
          `Explicit Task-final ReviewRound ${exact.id} is failed for this exact candidate; resolve it before requesting again.`
        );
      }
      assertNoConflictingTaskReviewRound(taskRounds, exact.id);
      if (requestedLaneRoles.length === 0) {
        assertTaskReviewRequestLane(tx, task.id, reviewerRoleName, exact);
        return exact;
      }
      if (exact.status !== "running"
        || exact.executionGroup?.strategy.mode !== "adaptive"
        || exact.executionGroup.resolution !== undefined) {
        throw usageError(`ReviewRound ${exact.id} cannot append Reviewer Lanes from ${exact.status}.`);
      }
      // Expansion receives only the newly requested Roles; the existing
      // reviewer Role is already represented by its persisted first Lane.
      const laneRoles = requestedLaneRoles;
      if (new Set(laneRoles).size !== laneRoles.length) {
        throw usageError("Each Reviewer Lane must use a distinct Task Role.");
      }
      const strategy = requestedStrategy ?? exact.executionGroup.strategy;
      if (!sameExecutionStrategy(strategy, exact.executionGroup.strategy)) {
        throw usageError(`Review ExecutionGroup strategy is frozen: ${exact.executionGroup.id}.`);
      }
      if (strategy.mode !== "adaptive") {
        throw usageError(`Review ExecutionGroup ${exact.executionGroup.id} is not adaptive.`);
      }
      if (exact.executionGroup.lanes.length + laneRoles.filter((role) => (
        !exact.executionGroup!.lanes.some((lane) => lane.roleName === role)
      )).length > strategy.max) {
        throw usageError(`Reviewer Lane count exceeds adaptive capacity ${strategy.max}.`);
      }
      let appended = exact.executionGroup;
      for (const laneRoleName of laneRoles) {
        const existingLane = appended.lanes.find(({ roleName }) => roleName === laneRoleName);
        if (existingLane !== undefined) {
          if (existingLane.runId === undefined) continue;
          if (existingLane.status !== "running") continue;
          if (laneRoleName === reviewerRoleName) {
            assertTaskReviewRequestLane(tx, task.id, laneRoleName, exact);
          } else {
            throw usageError(`Reviewer Role already has a Lane: ${laneRoleName}.`);
          }
        } else {
          if (tx.getGlobalRole(laneRoleName) === null && tx.getRole(task.id, laneRoleName) === null) {
            throw usageError(`Global Role not found: ${laneRoleName}.`);
          }
          if (taskReviewProducerCollision(provenance, laneRoleName) !== null) {
            throw usageError(`Reviewer Role must be separate from the Candidate producer: ${laneRoleName}.`);
          }
          assertTaskReviewRequestLane(tx, task.id, laneRoleName);
          let laneRole = tx.getRole(task.id, laneRoleName);
          if (laneRole === null) {
            laneRole = createTaskRole(tx, task, laneRoleName, undefined, now, laneRoleName);
            tx.saveRole(task.id, laneRole);
          }
          appended = addExecutionLane(appended, {
            roleName: laneRole.name,
            reviewRoundId: exact.id
          }, now);
        }
      }
      const updated = updateReviewExecutionGroup(exact, appended);
      tx.saveReviewRound(task.id, updated);
      return updated;
    }
    assertNoConflictingTaskReviewRound(taskRounds);
    assertTaskReviewRequestLane(tx, task.id, reviewerRoleName);

    let reviewer = tx.getRole(task.id, reviewerRoleName);
    if (reviewer === null) {
      reviewer = createTaskRole(tx, task, reviewerRoleName, undefined, now, reviewerRoleName);
      tx.saveRole(task.id, reviewer);
    }
    const laneRoles = requestedLaneRoles.length === 0
      ? [reviewerRoleName]
      : requestedLaneRoles[0] === reviewerRoleName
        ? requestedLaneRoles
        : [reviewerRoleName, ...requestedLaneRoles];
    if (new Set(laneRoles).size !== laneRoles.length) {
      throw usageError("Each Reviewer Lane must use a distinct Task Role.");
    }
    const strategy = requestedStrategy ?? { mode: "fixed", count: laneRoles.length };
    const capacity = strategy.mode === "fixed" ? strategy.count : strategy.max;
    if (laneRoles.length > capacity
      || strategy.mode === "fixed" && laneRoles.length !== strategy.count) {
      throw usageError(`Reviewer Lane count must match the ${strategy.mode} strategy capacity.`);
    }
    for (const laneRoleName of laneRoles) {
      if (tx.getGlobalRole(laneRoleName) === null && tx.getRole(task.id, laneRoleName) === null) {
        throw usageError(`Global Role not found: ${laneRoleName}.`);
      }
      let laneRole = tx.getRole(task.id, laneRoleName);
      if (laneRole === null) {
        laneRole = createTaskRole(tx, task, laneRoleName, undefined, now, laneRoleName);
        tx.saveRole(task.id, laneRole);
      }
      if (taskReviewProducerCollision(provenance, laneRole.name) !== null) {
        throw usageError(`Reviewer Role must be separate from the Candidate producer: ${laneRole.name}.`);
      }
      assertTaskReviewRequestLane(tx, task.id, laneRole.name);
    }
    let deltaRecord: DeltaRecheckPreflight["record"] | undefined;
    if (deltaRecheckRequested) {
      if (requestedLaneRoles.length > 0 || requestedStrategy !== undefined) {
        throw usageError("Delta-recheck supports only the default single Reviewer Lane.");
      }
      deltaRecord = validateDeltaRecheckRequest(
        tx,
        task.id,
        reviewerRoleName,
        provenance.candidate,
        options.deltaRecheckPreflight
      );
    }
    let created = deltaRecord === undefined
      ? createTaskReviewRound(
          tx.nextReviewRoundId(task.id),
          task.id,
          anchor.item.id,
          anchor.candidate.id,
          reviewerRoleName,
          "leader",
          provenance.candidate,
          now,
          taskFinalContract
        )
      : createTaskDeltaReviewRound(
          tx.nextReviewRoundId(task.id),
          task.id,
          anchor.item.id,
          anchor.candidate.id,
          reviewerRoleName,
          "leader",
          provenance.candidate,
          deltaRecord,
          now,
          taskFinalContract
        );
    let group = createExecutionGroup(
      `execution-group-${created.id}`,
      task.id,
      {
        purpose: "review",
        target: executionTargetForReviewRound(task, created, anchor.item, anchor.candidate),
        strategy,
        lanes: laneRoles.map((roleName) => ({ roleName, reviewRoundId: created.id }))
      },
      now
    );
    created = {
      ...created,
      executionGroup: group
    };
    tx.saveReviewRound(task.id, created);
    // Issue 07: when a full Review is created after a non-accepting delta
    // disposition, record the escalation lineage on the delta Round.
    if (exact !== undefined
      && deltaRecheckBlocksAcceptance(exact)
      && created.deltaRecheck === undefined
      && exact.deltaRecheck !== undefined
      && exact.deltaRecheck.escalatedToReviewRoundId === undefined) {
      tx.saveReviewRound(task.id, {
        ...exact,
        deltaRecheck: {
          ...exact.deltaRecheck,
          escalatedToReviewRoundId: created.id
        }
      });
    }
    recordTaskEvent(tx, task.id, "review.task-final-requested", {
      reviewRoundId: created.id,
      workItemId: created.workItemId,
      candidateId: created.candidateId,
      reviewerRoleName: created.reviewerRoleName,
      requestedBy: created.requestedBy,
      taskCandidate: JSON.stringify(created.taskCandidate),
      ...(created.deltaRecheck === undefined
        ? {}
        : {
            deltaRecheck: "true",
            previousReviewRoundId: created.deltaRecheck.previousReviewRoundId,
            diffDigest: created.deltaRecheck.diffDigest
          })
    }, now);
    return created;
  });
  return output(
    round.status === "pending"
      ? round.deltaRecheck === undefined
        ? `Task-final Review requested as ${round.id}\n`
        : `Task-final delta-recheck requested as ${round.id} (rechecks ${round.deltaRecheck.previousReviewRoundId})\n`
      : `Task-final Review is already ${round.status}: ${round.id}\n`,
    { reviewRound: round }
  );
}

const TASK_FINAL_FORCE_FRESH_EVENT = "review.task-final-force-fresh-requested";

/**
 * Creates a distinct full Task-final ReviewRound only when the exact previous
 * Round failed without producing semantic review evidence. The source Round,
 * Run, findings, workspace, and terminal report remain immutable history; the
 * linking Event is both the audit record and the idempotence key.
 */
function forceFreshTaskReviewRound(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task review force-fresh usage: yui task review force-fresh <task>/<review-round>.";
  exactPositionals(args, 1, usage);
  const reference = taskRecordReference(
    args[0],
    "reviewRound",
    "ReviewRound reference",
    options
  );
  const now = clock(options);
  const result = store.transaction((tx) => {
    const source = tx.getReviewRound(reference.taskId, reference.localId);
    if (source === null) {
      throw dataError(`ReviewRound not found: ${reference.taskId}/${reference.localId}.`);
    }
    const task = requireTask(tx, reference.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may force a fresh Task-final ReviewRound.");
    }
    if ((source.scope ?? "work-item") !== "task") {
      throw usageError(`ReviewRound ${source.id} is not a Task-final ReviewRound.`);
    }

    const replacementEvents = tx.listEvents(task.id).filter((event) => (
      event.type === TASK_FINAL_FORCE_FRESH_EVENT
      && event.payload.sourceReviewRoundId === source.id
    ));
    if (replacementEvents.length > 1) {
      throw dataError(`ReviewRound ${source.id} has duplicate force-fresh audit events.`);
    }
    const replacementEvent = replacementEvents[0];
    if (replacementEvent !== undefined) {
      const replacementId = replacementEvent.payload.reviewRoundId;
      const replacement = replacementId === undefined
        ? null
        : tx.getReviewRound(task.id, replacementId);
      if (replacement === null
        || replacement.id === source.id
        || (replacement.scope ?? "work-item") !== "task"
        || replacement.workItemId !== source.workItemId
        || replacement.candidateId !== source.candidateId
        || replacement.reviewerRoleName !== source.reviewerRoleName
        || replacement.deltaRecheck !== undefined
        || !sameTaskFinalReviewContract(
          replacement.taskFinalReviewContract,
          source.taskFinalReviewContract
        )
        || !isSameTaskReviewCandidate(replacement.taskCandidate, source.taskCandidate!)
        || replacementEvent.payload.workItemId !== replacement.workItemId
        || replacementEvent.payload.candidateId !== replacement.candidateId
        || replacementEvent.payload.reviewerRoleName !== replacement.reviewerRoleName
        || replacementEvent.payload.taskCandidate !== JSON.stringify(replacement.taskCandidate)) {
        throw dataError(`Force-fresh audit for ${source.id} does not match its replacement Round.`);
      }
      return { round: replacement, source, created: false } as const;
    }

    const semanticBlocker = forceFreshSemanticBlocker(tx, source);
    if (semanticBlocker !== null) {
      throw usageError(
        `ReviewRound ${source.id} is not eligible for force-fresh: ${semanticBlocker}`
      );
    }
    if (source.taskCandidate === undefined) {
      throw dataError(`ReviewRound ${source.id} has no frozen Task candidate.`);
    }
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (!sameTaskFinalReviewContract(source.taskFinalReviewContract, taskFinalContract)) {
      throw usageError(`Task final-review contract does not match ReviewRound ${source.id}.`);
    }
    if (source.executionGroup !== undefined
      && (source.executionGroup.strategy.mode !== "fixed"
        || source.executionGroup.strategy.count !== 1
        || source.executionGroup.lanes.length !== 1
        || source.executionGroup.lanes[0]!.roleName !== source.reviewerRoleName)) {
      throw usageError(
        `ReviewRound ${source.id} is not a single-Reviewer full Review; force-fresh is refused.`
      );
    }

    const item = tx.getWorkItem(task.id, source.workItemId);
    const candidate = item?.candidates.find(({ id }) => id === source.candidateId);
    if (item === null || item === undefined || candidate === undefined) {
      throw dataError(
        `Final Review anchor Candidate is no longer available: `
        + `${source.workItemId}/${source.candidateId}.`
      );
    }
    const provenance = taskReviewProvenance(tx, task, options);
    if (!isSameTaskReviewCandidate(source.taskCandidate, provenance.candidate)) {
      throw usageError(
        `Final ReviewRound ${source.id} freezes a candidate that is no longer the current Task candidate.`
      );
    }
    const producerCollision = taskReviewProducerCollision(provenance, source.reviewerRoleName);
    if (producerCollision !== null) throw usageError(producerCollision);

    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((entry) => (entry.scope ?? "work-item") === "task"));
    const sourceIndex = taskRounds.findIndex(({ id }) => id === source.id);
    if (sourceIndex < 0) {
      throw dataError(`Final ReviewRound is not in Task history: ${source.id}.`);
    }
    const laterRound = taskRounds.slice(sourceIndex + 1).at(-1);
    if (laterRound !== undefined) {
      throw usageError(
        `A newer Task-final ReviewRound already exists after ${source.id}: `
        + `${laterRound.id}/${laterRound.status}.`
      );
    }
    assertNoConflictingTaskReviewRound(taskRounds, source.id);
    assertTaskReviewRequestLane(tx, task.id, source.reviewerRoleName);

    let reviewer = tx.getRole(task.id, source.reviewerRoleName);
    if (reviewer === null) {
      if (tx.getGlobalRole(source.reviewerRoleName) === null) {
        throw usageError(`Global Role not found: ${source.reviewerRoleName}.`);
      }
      reviewer = createTaskRole(
        tx,
        task,
        source.reviewerRoleName,
        undefined,
        now,
        source.reviewerRoleName
      );
      tx.saveRole(task.id, reviewer);
    }

    let created = createTaskReviewRound(
      tx.nextReviewRoundId(task.id),
      task.id,
      source.workItemId,
      source.candidateId,
      source.reviewerRoleName,
      "leader",
      source.taskCandidate,
      now,
      taskFinalContract
    );
    const group = createExecutionGroup(
      `execution-group-${created.id}`,
      task.id,
      {
        purpose: "review",
        target: executionTargetForReviewRound(task, created, item, candidate),
        strategy: { mode: "fixed", count: 1 },
        lanes: [{ roleName: reviewer.name, reviewRoundId: created.id }]
      },
      now
    );
    created = { ...created, executionGroup: group };
    tx.saveReviewRound(task.id, created);
    recordTaskEvent(tx, task.id, TASK_FINAL_FORCE_FRESH_EVENT, {
      sourceReviewRoundId: source.id,
      ...(source.reviewerRunId === undefined ? {} : { sourceReviewerRunId: source.reviewerRunId }),
      reviewRoundId: created.id,
      workItemId: created.workItemId,
      candidateId: created.candidateId,
      reviewerRoleName: created.reviewerRoleName,
      taskCandidate: JSON.stringify(created.taskCandidate),
      reason: "source-round-failed-without-semantic-review",
      leaderActionRunId: taskLeaderActionRunId(
        tx,
        task.id,
        options.environment,
        options.yuiHome
      ) ?? "leader"
    }, now);
    return { round: created, source, created: true } as const;
  });
  return output(
    result.created
      ? `Fresh Task-final Review requested as ${result.round.id} after ${result.source.id}\n`
      : `Fresh Task-final Review already requested as ${result.round.id} after ${result.source.id}\n`,
    { reviewRound: result.round, sourceReviewRound: result.source }
  );
}

/** Returns the exact semantic evidence that makes a failed Round ineligible. */
function forceFreshSemanticBlocker(
  store: TaskWorkflowStore,
  round: ReviewRound
): string | null {
  if (round.status !== "failed") return `source status is ${round.status}, not failed.`;
  if ((round.checks ?? []).length > 0) return "the Round records review checks.";
  if (round.evidenceCommit !== undefined) return "the Round records a review evidence commit.";
  if (round.report !== round.summary) {
    return "the Round stores a report distinct from its failure summary.";
  }
  if (round.deltaRecheck?.disposition !== undefined
    || round.deltaRecheck?.reasoning !== undefined) {
    return "the Round records a semantic delta-recheck disposition.";
  }
  const semanticLane = round.executionGroup?.lanes.find((lane) => (
    lane.status === "yielded"
    || lane.status === "completed"
    || lane.result?.report !== undefined
    || (lane.result?.checks ?? []).length > 0
    || (lane.result?.findings ?? []).length > 0
    || (lane.result?.evidence ?? []).length > 0
    || lane.result?.evidenceCommit !== undefined
  ));
  if (semanticLane !== undefined) {
    return `Reviewer Lane ${semanticLane.id} delivered semantic evidence.`;
  }
  const yieldedRun = store.listAgentRuns(round.taskId).find((run) => (
    run.purpose === "review"
    && run.reviewRoundId === round.id
    && run.status === "yielded"
  ));
  if (yieldedRun !== undefined) return `Reviewer Run ${yieldedRun.id} yielded a report.`;
  const finding = store.listReviewFindings(round.taskId).find((entry) => (
    entry.firstReviewRoundId === round.id || entry.lastReviewRoundId === round.id
  ));
  if (finding !== undefined) return `Review finding ${finding.id} references the Round.`;
  const semanticEvent = store.listEvents(round.taskId).find((event) => (
    event.type === "review.completed" && event.payload.reviewRoundId === round.id
  ));
  if (semanticEvent !== undefined) return `Review completion Event ${semanticEvent.id} exists.`;
  if (looksLikeStructuredReviewReport(round.report ?? "")) {
    return "the Round stores a structured reviewer report.";
  }
  return null;
}

function looksLikeStructuredReviewReport(report: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(report) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return [
    "summary",
    "report",
    "checks",
    "findings",
    "evidence",
    "evidenceCommit",
    "deltaDisposition",
    "deltaReasoning"
  ].some((key) => Object.hasOwn(record, key));
}

/**
 * Issue 07: re-validates the CLI-computed delta preflight inside the store
 * transaction.  The previous Round must be a completed acceptance (a full
 * Review or an equivalent-and-accepted delta) so a delta never extends a
 * non-accepting disposition.
 */
function validateDeltaRecheckRequest(
  store: TaskWorkflowStore,
  taskId: string,
  reviewerRoleName: string,
  candidate: TaskReviewCandidate,
  preflight: DeltaRecheckPreflight | undefined
): DeltaRecheckPreflight["record"] {
  if (preflight === undefined) {
    throw usageError(
      "Delta-recheck assessment is missing; the CLI preflight did not run. "
      + "Request a full Review or retry with a current CLI."
    );
  }
  const previous = store.getReviewRound(taskId, preflight.record.previousReviewRoundId);
  if (previous === null
    || (previous.scope ?? "work-item") !== "task"
    || previous.status !== "completed") {
    throw usageError(
      `Delta-recheck previous ReviewRound is not a completed Task-final Review: `
      + `${preflight.record.previousReviewRoundId}.`
    );
  }
  if (previous.reviewerRoleName !== reviewerRoleName) {
    throw usageError(
      `Delta-recheck Reviewer Role must match the previous acceptance: `
      + `${previous.reviewerRoleName}.`
    );
  }
  if (previous.reviewBaseCommit !== preflight.record.previousBaseCommit) {
    throw usageError(
      "Delta-recheck previous base commit does not match the recorded acceptance."
    );
  }
  // A delta may only extend an acceptance, never a finding or an escalation.
  if (previous.deltaRecheck !== undefined
    && previous.deltaRecheck.disposition !== "equivalent-and-accepted") {
    throw usageError(
      `Delta-recheck cannot extend ${previous.id}: its disposition is `
      + `${previous.deltaRecheck.disposition}. Resolve it with a full Review first.`
    );
  }
  if (candidate.projects[0]!.commit === preflight.record.previousBaseCommit) {
    throw usageError(
      "Delta-recheck candidate head is unchanged; the previous acceptance already covers it."
    );
  }
  return preflight.record;
}

function assertTaskReviewRequestLane(
  store: TaskWorkflowStore,
  taskId: string,
  reviewerRoleName: string,
  reusableRound?: ReviewRound
): void {
  const reviewerMailbox = store.getWorkMailbox(roleMailbox(taskId, reviewerRoleName));
  const runtimeMailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName: reviewerRoleName
  }));
  const hasMailboxWork = (mailbox: ReturnType<TaskWorkflowStore["getWorkMailbox"]>): boolean => (
    mailbox !== null && workMailboxHasWork(mailbox)
  );
  const activePointer = store.getActiveAgentRun(taskId, reviewerRoleName);
  const activeRuns = store.listAgentRuns(taskId).filter((entry) => (
    entry.roleName === reviewerRoleName && entry.status === "active"
  ));
  if (reusableRound === undefined || reusableRound.status === "pending") {
    if (activePointer !== null || activeRuns.length > 0
      || hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
      throw usageError(`Reviewer has unrelated active execution: ${reviewerRoleName}.`);
    }
    return;
  }
  if (reusableRound.status === "completed") {
    if (activePointer !== null || activeRuns.length > 0
      || hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
      throw usageError(`Reviewer has unrelated active execution: ${reviewerRoleName}.`);
    }
    return;
  }
  const reviewerRunId = reusableRound.reviewerRunId;
  const activeMatches = reviewerRunId !== undefined
    && activePointer?.id === reviewerRunId
    && activePointer.status === "active"
    && activeRuns.length === 1
    && activeRuns[0]!.id === reviewerRunId;
  if (!activeMatches) {
    throw usageError(
      `Existing Task-final ReviewRound ${reusableRound.id} is running without its exact Reviewer execution.`
    );
  }
  const exactRun = runRef(taskId, reviewerRunId!);
  const reviewerPending = reviewerMailbox === null ? null : nextPendingBatch(reviewerMailbox);
  const processingMatches = reviewerMailbox?.processing !== null
    && reviewerMailbox?.processing !== undefined
    && reviewerPending === null
    && reviewerMailbox.processing.executionRef !== undefined
    && isDeepStrictEqual(reviewerMailbox.processing.executionRef, exactRun);
  const pendingMatches = reviewerPending !== null
    && reviewerMailbox?.processing === null
    && reviewerPending.requestCount === 1
    && reviewerPending.refs.some((ref) => isDeepStrictEqual(ref, exactRun));
  if (hasMailboxWork(reviewerMailbox) && !processingMatches && !pendingMatches) {
    throw usageError(`Reviewer mailbox has unrelated active work: ${reviewerRoleName}.`);
  }
  if (hasMailboxWork(runtimeMailbox)) {
    throw usageError(`Reviewer runtime lifecycle has active work: ${reviewerRoleName}.`);
  }
}

function retryFailedTaskReviewRound(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task review retry usage: yui task review retry <task>/<review-round>.");
  const now = clock(options);
  const reference = taskRecordReference(
    args[0],
    "reviewRound",
    "ReviewRound reference",
    options
  );
  const result = store.transaction((tx) => {
    const round = tx.getReviewRound(reference.taskId, reference.localId);
    if (round === null) {
      throw dataError(`ReviewRound not found: ${reference.taskId}/${reference.localId}.`);
    }
    const task = requireTask(tx, reference.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may retry a failed Task-final ReviewRound.");
    }
    if ((round.scope ?? "work-item") !== "task") {
      throw usageError(`ReviewRound ${round.id} is not a failed Task-final ReviewRound.`);
    }
    if (round.reviewerRunId !== undefined) {
      if (round.status === "completed") {
        throw usageError(`ReviewRound ${round.id} is not retryable from ${round.status}.`);
      }
      throw usageError(
        `ReviewRound ${round.id} has Reviewer Run ${round.reviewerRunId}; use task run retry instead.`
      );
    }
    if (round.status !== "failed" && round.status !== "pending") {
      throw usageError(`ReviewRound ${round.id} is not retryable from ${round.status}.`);
    }
    if (round.taskCandidate === undefined) {
      throw dataError(`ReviewRound ${round.id} has no frozen Task candidate.`);
    }
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (!sameTaskFinalReviewContract(round.taskFinalReviewContract, taskFinalContract)) {
      throw usageError(`Task final-review contract does not match ReviewRound ${round.id}.`);
    }

    // Re-read the exact current integrated heads and all ChangeSet-linked
    // WorkItem producer roles before touching any record. A moved head,
    // missing anchor, malformed provenance, or reviewer collision fails closed
    // with the old failed Round byte-for-byte unchanged.
    const item = tx.getWorkItem(task.id, round.workItemId);
    if (item === null || item.candidates.every(({ id }) => id !== round.candidateId)) {
      throw dataError(
        `Final Review anchor Candidate is no longer available: `
        + `${round.workItemId}/${round.candidateId}.`
      );
    }
    const provenance = taskReviewProvenance(tx, task, options);
    if (!isSameTaskReviewCandidate(round.taskCandidate, provenance.candidate)) {
      throw usageError(
        `Final ReviewRound ${round.id} freezes a candidate that is no longer the current Task candidate.`
      );
    }
    const producerCollision = taskReviewProducerCollision(
      provenance,
      round.reviewerRoleName
    );
    if (producerCollision !== null) {
      throw usageError(producerCollision);
    }

    const reviewerRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id));
    const roundIndex = reviewerRounds.findIndex((entry) => entry.id === round.id);
    if (roundIndex < 0) {
      throw dataError(`Final ReviewRound is not in Task history: ${round.id}.`);
    }
    // Issue 06: infra retries reuse the same semantic Round ID. Any later
    // Round supersedes this one; an active Round for the same Reviewer blocks.
    const conflictingLater = reviewerRounds.slice(roundIndex + 1).at(-1);
    if (conflictingLater !== undefined) {
      throw usageError(
        `A newer conflicting final ReviewRound already exists after ${round.id}: `
        + `${conflictingLater.id}/${conflictingLater.status}.`
      );
    }
    assertNoConflictingTaskReviewRound(reviewerRounds, round.id);
    const activeRound = reviewerRounds.find((entry) => (
      entry.id !== round.id
      && entry.reviewerRoleName === round.reviewerRoleName
      && (entry.status === "pending" || entry.status === "running")
    ));
    if (activeRound !== undefined) {
      throw usageError(`Reviewer already has an active review round: ${activeRound.id}.`);
    }

    let reviewer = tx.getRole(task.id, round.reviewerRoleName);
    if (reviewer === null) {
      const globalRole = tx.getGlobalRole(round.reviewerRoleName);
      if (globalRole === null) {
        throw usageError(`Global Role not found: ${round.reviewerRoleName}.`);
      }
      reviewer = createTaskRole(tx, task, round.reviewerRoleName, undefined, now, round.reviewerRoleName);
      tx.saveRole(task.id, reviewer);
    }

    const reviewerMailboxTarget = roleMailbox(task.id, reviewer.name);
    const reviewerMailbox = tx.getWorkMailbox(reviewerMailboxTarget);
    const runtimeMailbox = tx.getWorkMailbox(runtimeLifecycleTarget({
      scope: "task",
      taskId: task.id,
      roleName: reviewer.name
    }));
    const hasMailboxWork = (mailbox: ReturnType<typeof tx.getWorkMailbox>): boolean => (
      mailbox !== null && workMailboxHasWork(mailbox)
    );
    const activeReviewerRuns = tx.listAgentRuns(task.id).filter((entry) => (
      entry.roleName === reviewer.name && entry.status === "active"
    ));
    const activePointer = tx.getActiveAgentRun(task.id, reviewer.name);

    if (activePointer !== null || activeReviewerRuns.length > 0) {
      throw usageError(`Reviewer Role already has an active run: ${reviewer.name}.`);
    }
    if (hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
      throw usageError(`Reviewer has unrelated mailbox work: ${reviewer.name}.`);
    }

    // Issue 06: an already-pending Round is the idempotent retry result.
    if (round.status === "pending") {
      return { round, created: false } as const;
    }

    // Issue 06: infra retry resets the same semantic Round to pending instead
    // of manufacturing a new Round, so Round count and finding identity stay
    // stable across execution-attempt failures.
    const resetRound = retryTaskReviewRound(round);
    tx.saveReviewRound(task.id, resetRound);
    recordTaskEvent(tx, task.id, "review.task-final-retried", {
      reviewRoundId: round.id,
      workItemId: round.workItemId,
      candidateId: round.candidateId
    }, now);
    return { round: resetRound, created: true } as const;
  });
  return output(
    result.created
      ? `Task-final Review retry requested as ${result.round.id}\n`
      : `Task-final Review retry already requested as ${result.round.id} (${result.round.status})\n`,
    { reviewRound: result.round }
  );
}

function taskRunCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") return output(listRuns(rest, store, options));
  if (command === "show") return showRun(rest, store, options);
  if (command === "context") return runContextCommand(rest, store, options);
  if (command === "retry") return retryRun(rest, store, options);
  if (command === "settle") return settleStaleFinalReviewRun(rest, store, options);
  if (command === "recover") return output(recoverRun(rest, store, options));
  if (command === "yield") return yieldRun(rest, store, options);
  if (command === "yield-status") return yieldRunStatus(rest, store, options);
  if (command === "checkpoint") return output(checkpointRun(rest, store, options));
  throw usageError(command === undefined
    ? "Task run command is required."
    : `Unknown command: task run ${command}`);
}

function runContextCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [first, ...rest] = args;
  if (first === "expand") {
    const usage = "Task run context expand usage: yui task run context expand <task>/<run> <ref-id> [--store <store>] [--mode full].";
    const parsed = parseTail(rest, new Set(["--store", "--mode"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const mode = parsed.options.get("--mode");
    if (mode !== undefined && mode !== "full") {
      throw usageError("Run Context expansion mode must be full.", usage);
    }
    const { taskId, runId } = parseRunContextReference(parsed.positionals[0]!);
    authorizeRunContext(store, taskId, runId, options.environment);
    const expanded = store.transaction((tx) => expandRunContextRef(
      tx,
      taskId,
      runId,
      parsed.positionals[1]!,
      optionalNonEmptyOption(parsed.options, "--store")
    ));
    return output(`${JSON.stringify(expanded, null, 2)}\n`, { context: expanded });
  }
  if (first === "delta") {
    if (rest.length !== 3 || rest[1] !== "--after") {
      throw usageError(
        "Task run context delta usage: yui task run context delta <task>/<run> --after <cursor>."
      );
    }
    const { taskId, runId } = parseRunContextReference(rest[0]!);
    authorizeRunContext(store, taskId, runId, options.environment);
    const delta = store.transaction((tx) => (
      buildRunContextDelta(tx, taskId, runId, rest[2]!)
    ));
    return output(`${JSON.stringify(delta, null, 2)}\n`, { contextDelta: delta });
  }
  if (first === undefined || rest.length !== 0) {
    throw usageError("Task run context usage: yui task run context <task>/<run>.");
  }
  const { taskId, runId } = parseRunContextReference(first);
  authorizeRunContext(store, taskId, runId, options.environment);
  const pack = store.transaction((tx) => buildRunContextPack(tx, taskId, runId));
  return output(`${JSON.stringify(pack, null, 2)}\n`, { context: pack });
}

function parseRunContextReference(value: string): { taskId: string; runId: string } {
  const [taskId, runId, extra] = value.split("/");
  if (taskId === undefined || taskId.length === 0 || runId === undefined || runId.length === 0
    || extra !== undefined) {
    throw usageError(`Run context reference is invalid: ${value}.`);
  }
  return { taskId, runId };
}

function authorizeRunContext(
  store: TaskWorkflowStore,
  taskId: string,
  runId: string,
  environment: NodeJS.ProcessEnv | undefined
): void {
  const managed = environment?.YUI_SESSION_SCOPE !== undefined
    || environment?.YUI_TASK_ID !== undefined
    || environment?.YUI_ROLE !== undefined
    || environment?.YUI_RUN_ID !== undefined;
  if (!managed) return;
  const run = store.getAgentRun(taskId, runId);
  const active = run === null ? null : store.getActiveAgentRun(taskId, run.roleName);
  if (environment?.YUI_SESSION_SCOPE !== "task"
    || environment.YUI_TASK_ID !== taskId
    || run === null
    || environment.YUI_ROLE !== run.roleName
    || environment.YUI_AGENT_ID !== run.effective.agentId
    || environment.YUI_ADAPTER_ID !== run.effective.adapterId
    || run.status !== "active"
    || active?.id !== runId) {
    throw usageError(`Run Context access is not authorized: ${taskId}/${runId}.`);
  }
  const callerKey = environment.YUI_JOB_CALLER_KEY;
  const expectedCallerKeyHash = store.getJobCallerKeyHash(
    taskId,
    run.roleName,
    run.effective.agentId
  );
  if (callerKey === undefined
    || expectedCallerKeyHash === null
    || createHash("sha256").update(callerKey).digest("hex") !== expectedCallerKeyHash) {
    throw usageError(`Run Context caller key is not authorized: ${taskId}/${runId}.`);
  }
}

function listRuns(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task run list usage: yui task run list <task>/<work>.");
  const item = requireWorkItem(store, args[0], options);
  const runs = store.listAgentRuns(item.taskId).filter((run) => run.workItemId === item.id);
  if (runs.length === 0) return "No runs found.\n";
  return `${renderTable(
    `Runs: ${item.id}`,
    [
      { header: "Run", minWidth: 6, maxWidth: 20 },
      { header: "Role", minWidth: 4, maxWidth: 22 },
      { header: "Purpose", minWidth: 6, maxWidth: 10 },
      { header: "Mode", minWidth: 4, maxWidth: 8 },
      { header: "Effective", minWidth: 10, maxWidth: 30 },
      { header: "Profile", minWidth: 7, maxWidth: 8 },
      { header: "Permission", minWidth: 8, maxWidth: 16 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "Summary", minWidth: 8, maxWidth: 58 }
    ],
    runs.map((run) => [
      run.id,
      run.roleName,
      run.purpose,
      run.mode,
      `${run.effective.agentId}/${run.effective.adapterId} r${run.effective.sourceDesiredRevision}`,
      run.effective.profileAccess,
      run.effective.permission.strategy,
      run.status,
      run.summary ?? "-"
    ]),
    defaultTableWidth()
  )}\n`;
}

/**
 * Settles only the known bootstrap split where a failed Task-final Run
 * still owns a running ReviewRound, but the committed Task heads have moved
 * on. This is deliberately narrower than retry: it cannot manufacture a
 * review or fail an arbitrary Round, and every identity/mailbox fence is
 * checked before the old Round changes. The next normal Task completion then
 * creates one fresh Round over the newer integrated heads.
 */
function settleStaleFinalReviewRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task run settle usage: yui task run settle <task>/<run>.");
  const now = clock(options);
  const previous = store.transaction((tx) => requireRun(tx, args[0], options));
  const result = store.transaction((tx) => {
    const run = tx.getAgentRun(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "review") {
      throw usageError(`Run ${previous.id} is not a failed review run.`);
    }
    if (run.reviewRoundId === undefined) {
      throw usageError(`Review Run ${run.id} has no ReviewRound.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may settle a stale final review Run.");
    }
    const round = tx.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) {
      throw dataError(`ReviewRound not found for run ${run.id}: ${run.reviewRoundId}.`);
    }
    if ((round.scope ?? "work-item") !== "task") {
      throw usageError(
        `Review Run ${run.id} is not a Task-final review; request a new WorkItem review `
        + "for a new Candidate."
      );
    }
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (!sameTaskFinalReviewContract(round.taskFinalReviewContract, taskFinalContract)) {
      throw usageError(`Task final-review contract does not match ReviewRound ${round.id}.`);
    }
    // This read-only compare-and-swap fence covers the exact Run/Round,
    // Candidate, stored Review workspace, frozen Project scope, and frozen
    // Project heads before any mailbox or Round write.
    const validation = validateExactRunReviewRound(tx, run, { allowTerminal: true });
    if (validation.disposition !== "applied" || validation.round === null) {
      throw usageError(
        `Review Run ${run.id} identity does not match its ReviewRound or frozen Task state changed: ${validation.reason ?? "mismatch"}.`
      );
    }
    const item = tx.getWorkItem(task.id, round.workItemId);
    if (item === null) {
      throw dataError(`Work item not found for run ${run.id}: ${round.workItemId}.`);
    }
    const candidate = item.candidates.find(({ id }) => id === round.candidateId);
    if (candidate === undefined) {
      throw dataError(`ReviewRound Candidate not found: ${round.candidateId}.`);
    }

    const activeReviewerRun = tx.listAgentRuns(task.id).find((entry) => (
      entry.purpose === "review" && entry.status === "active"
    ));
    const activeRoleRun = tx.getActiveAgentRun(task.id, round.reviewerRoleName);
    if (activeReviewerRun !== undefined || activeRoleRun !== null) {
      const active = activeReviewerRun ?? activeRoleRun!;
      throw usageError(
        `${task.id}/${round.reviewerRoleName} already has active Run ${active.id}.`
      );
    }

    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((entry) => (entry.scope ?? "work-item") === "task"));
    const roundIndex = taskRounds.findIndex(({ id }) => id === round.id);
    if (roundIndex < 0) {
      throw dataError(`Final ReviewRound is not in Task history: ${round.id}.`);
    }
    const laterRound = taskRounds.slice(roundIndex + 1).at(-1);
    if (laterRound !== undefined) {
      throw usageError(
        `A later final ReviewRound already exists: ${laterRound.id}/${laterRound.status}.`
      );
    }
    const currentTaskCandidate = actualTaskReviewCandidateForMutation(tx, task, options);
    if (isSameTaskReviewCandidate(currentTaskCandidate, round.taskCandidate!)) {
      throw usageError(
        `Final ReviewRound ${round.id} freezes the current Task candidate; use exact retry.`
      );
    }

    if (round.status === "failed") {
      const summary = run.summary?.trim();
      if (summary !== undefined
        && round.summary === summary
        && round.report === summary
        && (round.checks?.length ?? 0) === 0
        && round.evidenceCommit === undefined) {
        return { run, round, changed: false } as const;
      }
      throw usageError(`Final ReviewRound is already terminal: ${round.id}/${round.status}.`);
    }
    if (round.status !== "running") {
      throw usageError(`Final ReviewRound is not stranded running: ${round.id}/${round.status}.`);
    }

    const reviewerTarget = roleMailbox(task.id, round.reviewerRoleName);
    const reviewerMailbox = tx.getWorkMailbox(reviewerTarget);
    const reviewerPending = reviewerMailbox === null ? null : nextPendingBatch(reviewerMailbox);
    const exactRunRef = runRef(task.id, run.id);
    if (reviewerMailbox?.processing !== null && reviewerMailbox?.processing !== undefined) {
      const processing = reviewerMailbox.processing;
      if (
        processing.executionRef === undefined
        || !isDeepStrictEqual(processing.executionRef, exactRunRef)
        || reviewerPending !== null
      ) {
        throw usageError(`Reviewer mailbox has unrelated processing work: ${round.reviewerRoleName}.`);
      }
    } else if (reviewerPending !== null) {
      const pending = reviewerPending;
      if (
        pending.requestCount !== 1
        || !pending.refs.some((ref) => isDeepStrictEqual(ref, exactRunRef))
      ) {
        throw usageError(`Reviewer mailbox has unrelated pending work: ${round.reviewerRoleName}.`);
      }
    }
    const runtimeMailbox = tx.getWorkMailbox(runtimeLifecycleTarget({
      scope: "task",
      taskId: task.id,
      roleName: round.reviewerRoleName
    }));
    if (runtimeMailbox?.processing !== null && runtimeMailbox?.processing !== undefined) {
      throw usageError(`Reviewer runtime lifecycle is pending: ${round.reviewerRoleName}.`);
    }
    if (runtimeMailbox !== null && workMailboxHasWork(runtimeMailbox)) {
      throw usageError(`Reviewer runtime lifecycle has pending work: ${round.reviewerRoleName}.`);
    }

    // A matching pending/processing dispatch belongs to this failed Run and
    // is safe to settle here. It is never merged with unrelated mailbox work.
    if (reviewerMailbox !== null && reviewerMailbox !== undefined) {
      const settlement = settleExactWorkExecution(tx, reviewerTarget, exactRunRef);
      if (settlement === "absent") {
        throw usageError(`Reviewer mailbox changed before stale final settlement: ${round.reviewerRoleName}.`);
      }
    }

    // Preserve any report/check/evidence already attached to the old Round;
    // terminalization only adds the missing failure boundary and end time.
    const summary = round.summary
      ?? run.summary
      ?? `Review Run ${run.id} failed before delivery; committed Task heads changed.`;
    const terminal = finishReviewRound(
      round,
      "failed",
      summary,
      now,
      {
        report: round.report ?? summary,
        checks: round.checks ?? [],
        ...(round.evidenceCommit === undefined ? {} : { evidenceCommit: round.evidenceCommit })
      }
    );
    tx.saveReviewRound(task.id, terminal);
    recordTaskEvent(tx, task.id, "run.review-stale-settled", {
      runId: run.id,
      reviewRoundId: round.id,
      candidateId: candidate.id,
      previousTaskCandidate: JSON.stringify(round.taskCandidate),
      currentTaskCandidate: JSON.stringify(currentTaskCandidate)
    }, now);
    return { run, round: terminal, changed: true } as const;
  });
  return output(
    result.changed
      ? `Settled obsolete final Review ${result.round.id} from failed Run ${result.run.id}\n`
      : `Obsolete final Review already settled: ${result.round.id}/${result.run.id}\n`,
    { reviewRound: result.round, reviewRun: result.run }
  );
}

function retryRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task run retry usage: yui task run retry <task>/<run>.");
  const now = clock(options);
  const previous = store.transaction((tx) => requireRun(tx, args[0], options));
  if (previous.purpose === "review") {
    return retryFailedReviewRun(previous, store, options, now);
  }
  const retried = store.transaction((tx) => {
    if (previous.status !== "failed") {
      throw usageError(`Run ${previous.id} is not retryable from ${previous.status}.`);
    }
    const task = requireTask(tx, previous.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const role = requireRole(tx, task.id, previous.roleName);
    if (tx.getActiveAgentRun(task.id, role.name) !== null) {
      throw usageError(`${task.id}/${role.name} already has an active run.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const retryItem = previous.workItemId === undefined
      ? null
      : tx.getWorkItem(task.id, previous.workItemId);
    if (previous.workItemId !== undefined && retryItem === null) {
      throw dataError(`Work item not found for run ${previous.id}: ${previous.workItemId}.`);
    }
    const retryLaneBefore = previous.executionLaneId === undefined
      ? undefined
      : retryItem === null || previous.executionGroupId === undefined
        ? undefined
        : workItemExecutionGroupById(retryItem, previous.executionGroupId)?.lanes.find(
          ({ id }) => id === previous.executionLaneId
        );
    const currentRetryGroup = retryItem === null
      ? undefined
      : currentWorkItemExecutionGroup(retryItem);
    const groupedRunningRetry = retryItem?.status === "running"
      && currentRetryGroup?.id === previous.executionGroupId
      && (currentRetryGroup?.lanes.length ?? 0) > 1
      && retryLaneBefore?.status === "failed";
    if (retryItem !== null && retryItem.status !== "failed" && !groupedRunningRetry) {
      throw usageError(`Work Item ${retryItem.id} is not retryable from ${retryItem.status}.`);
    }
    const runWorkspace = previous.workspace
      ?? (retryItem === null
        ? tx.getTaskWorkspace(task.id)
        : tx.getWorkItemWorkspace(task.id, retryItem.id))
      ?? undefined;
    const runId = tx.nextAgentRunId(task.id);
    const retryGroup = retryItem === null || previous.executionGroupId === undefined
      ? undefined
      : workItemExecutionGroupById(retryItem, previous.executionGroupId);
    const retryLane = previous.executionGroupId === undefined
      && previous.executionLaneId === undefined
      ? undefined
      : retryGroup?.lanes.find(({ id }) => id === previous.executionLaneId);
    if ((previous.executionGroupId === undefined) !== (previous.executionLaneId === undefined)
      || (previous.executionGroupId !== undefined
        && (retryGroup === undefined
          || retryGroup.id !== previous.executionGroupId
          || retryLane === undefined))) {
      throw dataError(`Run ${previous.id} execution lineage no longer matches its Work Item.`);
    }
    const retryManagedWorkspace = retryLane === undefined
      ? runWorkspace
      : options.executionLaneWorkspaces?.get(retryLane.id) ?? previous.workspace ?? runWorkspace;
    const effective = resolveEffectiveLaunch({
      role,
      purpose: "execution",
      ...(retryManagedWorkspace === undefined ? {} : { workspace: retryManagedWorkspace }),
      ...(retryItem === null ? {} : { workItemWriteProjectIds: retryItem.writeProjectIds })
    });
    const runningGroup = retryGroup === undefined || retryLane === undefined
      ? undefined
      : restartExecutionLane(retryGroup, retryLane.id, {
          runId,
          effective,
          ...(retryManagedWorkspace === undefined
            ? {}
            : {
                workspace: {
                  root: retryManagedWorkspace.root,
                  writableProjectIds: [...(retryItem?.writeProjectIds ?? [])]
                }
              })
        }, now);
    // Restart the bound lane and reopen the failed WorkItem as two ordered
    // single-step record revisions, matching the dispatch path. Folding both
    // transforms into one save would move the WorkItem two revisions at once,
    // which the store's one-step transition guard rejects.
    const laneRestartedItem = retryItem === null || runningGroup === undefined
      ? retryItem
      : updateWorkItemExecutionGroup(retryItem, runningGroup, now);
    const retriedItemWithGroup = laneRestartedItem === null
      ? null
      : laneRestartedItem.status === "failed"
        ? retryFailedWorkItem(laneRestartedItem, now)
        : laneRestartedItem;
    if (retriedItemWithGroup !== null) {
      if (laneRestartedItem !== null && laneRestartedItem !== retryItem) {
        tx.saveWorkItem(task.id, laneRestartedItem);
      }
      if (retriedItemWithGroup !== laneRestartedItem) {
        tx.saveWorkItem(task.id, retriedItemWithGroup);
      }
    }
    const retrySnapshot = freezeRunContextSnapshot(tx, {
      taskId: task.id,
      roleName: role.name,
      purpose: "execution",
      ...(previous.workItemId === undefined ? {} : { workItemId: previous.workItemId })
    }, now);
    const assignment = createRunAssignment({
      runId,
      roleName: role.name,
      purpose: previous.assignment.purpose,
      action: previous.workItemId === undefined ? previous.assignment.action : "repair-work-item",
      subject: {
        taskId: task.id,
        ...(previous.workItemId === undefined ? {} : { workItemId: previous.workItemId }),
        ...(runningGroup === undefined ? {} : {
          executionGroupId: runningGroup.id,
          executionLaneId: retryLane!.id
        })
      },
      ...(previous.assignment.directive === undefined
        ? {}
        : { directive: previous.assignment.directive }),
      contextSnapshotRef: contextSnapshotRef(retrySnapshot),
      deltaRefIds: contextSnapshotDeltaRefIds(tx, retrySnapshot)
    });
    const created = createAgentRun(
      runId,
      task.id,
      role.name,
      roleAgentSessionResumeMode(sessions, effective.agentId, effective),
      assignment,
      now,
      {
        ...(previous.workItemId === undefined ? {} : { workItemId: previous.workItemId }),
        ...(runningGroup === undefined ? {} : {
          executionGroupId: runningGroup.id,
          executionLaneId: retryLane!.id
        }),
        ...(retryManagedWorkspace === undefined ? {} : { workspace: retryManagedWorkspace }),
        effective
      }
    );
    tx.saveAgentRun(created);
    tx.saveActiveAgentRun(created);
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    if (previous.workItemId !== undefined && retriedItemWithGroup !== null) {
      const item = retriedItemWithGroup;
      const workspace = tx.getWorkItemWorkspace(task.id, item.id);
      if (workspace?.owner.type === "work-item"
        && workspace.owner.workItemId !== item.id) {
        throw usageError(
          `Role ${role.name} uses the isolated worktree for ${workspace.owner.workItemId}; `
          + `cannot retry ${item.id}.`
        );
      }
    }
    enqueueWork(tx, roleMailbox(task.id, role.name), "run-retried", now, [runRef(task.id, created.id)]);
    recordTaskEvent(tx, task.id, "run.retried", {
      ...runLaunchEventPayload(created),
      previousRunId: previous.id
    }, now);
    return { kind: "run" as const, run: created };
  });
  notifyMailbox(
    options.runtime,
    roleMailbox(retried.run.taskId, retried.run.roleName),
    retried.run.taskId
  );
  return output(
    `Retry queued as ${retried.run.id} for ${retried.run.taskId}/${retried.run.roleName}\n`
  );
}

function actualTaskReviewCandidateForMutation(
  store: TaskWorkflowStore,
  task: Task,
  options: TaskCommandOptions
): TaskReviewCandidate {
  if (options.actualTaskReviewCandidate === undefined) {
    throw usageError(
      `Actual Task Project heads were not verified for final Review: ${task.id}.`
    );
  }
  let actual: TaskReviewCandidate;
  try {
    actual = validateTaskReviewCandidate(options.actualTaskReviewCandidate);
  } catch (error) {
    throw usageError(
      `Actual Task Project heads are invalid for ${task.id}: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (actual.projects.length !== task.projectBindings.length
    || actual.projects.some(({ projectId }, index) => (
      projectId !== task.projectBindings[index]?.projectId
    ))) {
    throw usageError(`Actual Task Project heads do not match bound Projects: ${task.id}.`);
  }
  const projects = actual.projects.map(({ projectId, commit }) => {
    const committed = latestCommittedIntegration(store, task.id, projectId);
    if (committed !== undefined) {
      if (committed.candidateCommit === undefined) {
        throw dataError(
          `Committed Integration has no candidate commit: ${task.id}/${committed.id}.`
        );
      }
      if (commit !== committed.candidateCommit) {
        throw usageError(
          `Project ${projectId} actual Task head ${commit} does not match latest committed `
          + `Integration ${committed.id}/${committed.candidateCommit}.`
        );
      }
    }
    return { projectId, commit };
  });
  return { schemaVersion: 1, projects };
}

type TaskReviewProvenance = Readonly<{
  candidate: TaskReviewCandidate;
  producerRoles: ReadonlySet<string>;
  producerWorkItemIds: ReadonlyMap<string, ReadonlySet<string>>;
}>;

function taskReviewProducerCollision(
  provenance: TaskReviewProvenance,
  reviewerRoleName: string
): string | null {
  const workItemIds = [...(provenance.producerWorkItemIds.get(reviewerRoleName) ?? [])]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  return workItemIds.length === 0
    ? null
    : `Reviewer Role must be separate from every integrated Candidate producer: `
      + `${reviewerRoleName} (${workItemIds.join(", ")}).`;
}

/**
 * Resolve the complete frozen Task-final provenance from the physical head of
 * every bound Project. Where a Project has a committed Integration, that head
 * must match its latest numeric Task-local Integration and the Integration's
 * ChangeSets contribute producer Roles. A bound context Project without an
 * Integration is still frozen, but contributes no producer.
 *
 * When `expected` is supplied this is also the final dispatch compare-and-swap
 * fence: every bound Project must still point at the exact frozen physical
 * head. Drift fails closed before a Reviewer Run is created.
 */
function taskReviewProvenance(
  store: TaskWorkflowStore,
  task: Task,
  options: TaskCommandOptions,
  expected?: TaskReviewCandidate
): TaskReviewProvenance {
  const candidate = actualTaskReviewCandidateForMutation(store, task, options);
  if (expected !== undefined && !isSameTaskReviewCandidate(candidate, expected)) {
    throw usageError(`Task-final ReviewRound frozen integrated heads changed for its Project set.`);
  }
  const producerRoles = new Set<string>();
  const producerWorkItemIds = new Map<string, Set<string>>();
  const recordProducer = (roleName: string, workItemId: string): void => {
    producerRoles.add(roleName);
    const workItemIds = producerWorkItemIds.get(roleName) ?? new Set<string>();
    workItemIds.add(workItemId);
    producerWorkItemIds.set(roleName, workItemIds);
  };
  for (const { projectId, commit } of candidate.projects) {
    const committedAttempts = store.listIntegrationAttempts(task.id)
      .filter((attempt) => (
        attempt.projectId === projectId && attempt.status === "committed"
      ))
      .sort((left, right) => (
        left.id.localeCompare(right.id, undefined, { numeric: true })
      ));
    if (committedAttempts.length === 0) {
      continue;
    }
    let headIndex = -1;
    for (let index = committedAttempts.length - 1; index >= 0; index -= 1) {
      if (committedAttempts[index]!.candidateCommit === commit) {
        headIndex = index;
        break;
      }
    }
    if (headIndex < 0) {
      throw dataError(
        `Committed Integration provenance is unavailable for Project ${projectId}@${commit}.`
      );
    }
    const head = committedAttempts[headIndex]!;
    const lineage = committedAttempts.slice(0, headIndex + 1)
      .filter(({ targetRef }) => targetRef === head.targetRef);
    for (const committed of lineage) {
      if (committed.changeSetIds.length === 0) {
        throw dataError(
          `Committed Integration ${committed.id} has no ChangeSet provenance for Project ${projectId}.`
        );
      }
      for (const changeSetId of committed.changeSetIds) {
        const changeSet = store.getChangeSet(task.id, changeSetId);
        if (changeSet === null || changeSet.projectId !== projectId) {
          throw dataError(
            `Committed Integration ChangeSet provenance is invalid: `
            + `${committed.id}/${changeSetId}.`
          );
        }
        assertTaskReviewChangeSetProvenance(task, projectId, committed.id, changeSet);
        const item = store.getWorkItem(task.id, changeSet.workItemId);
        if (item === null) {
          throw dataError(
            `Committed Integration producer WorkItem is unavailable: `
            + `${changeSet.id}/${changeSet.workItemId}.`
          );
        }
        if (item.assignee !== undefined) recordProducer(item.assignee, item.id);
        if (item.candidates.length === 0) {
          throw dataError(
            `Committed producer WorkItem has no Candidate: ${item.id}.`
          );
        }
        for (const itemCandidate of item.candidates) {
          if (itemCandidate.source.type === "direct") {
            recordProducer(LEADER_ROLE, item.id);
            continue;
          }
          const sourceRun = store.getAgentRun(task.id, itemCandidate.source.runId);
          if (sourceRun === null
            || sourceRun.workItemId !== item.id
            || sourceRun.purpose !== "execution"
            || sourceRun.status !== "yielded") {
            throw dataError(
              `Committed producer Candidate Run is unavailable: `
              + `${item.id}/${itemCandidate.source.runId}.`
            );
          }
          recordProducer(sourceRun.roleName, item.id);
        }
      }
    }
  }
  return { candidate, producerRoles, producerWorkItemIds };
}

function latestCommittedIntegration(
  store: TaskWorkflowStore,
  taskId: string,
  projectId: string
) {
  return store.listIntegrationAttempts(taskId)
    .filter((attempt) => (
      attempt.projectId === projectId
      && attempt.status === "committed"
    ))
    .sort((left, right) => (
      left.id.localeCompare(right.id, undefined, { numeric: true })
    ))
    .at(-1);
}

function assertTaskReviewChangeSetProvenance(
  task: Task,
  projectId: string,
  integrationId: string,
  changeSet: ChangeSet
): void {
  if (changeSet.taskId !== task.id) {
    throw dataError(
      `Committed Integration ChangeSet provenance is invalid: ${integrationId}/${changeSet.id}.`
    );
  }
  if (changeSet.projectId !== projectId) {
    throw dataError(
      `Committed Integration ChangeSet provenance is invalid: ${integrationId}/${changeSet.id}.`
    );
  }
}

function isSameTaskReviewCandidate(
  left: TaskReviewCandidate | undefined,
  right: TaskReviewCandidate
): boolean {
  return left !== undefined && isDeepStrictEqual(left, right);
}

/**
 * A Task can have at most one live Task-final ReviewRound. An exact existing
 * Round may be reused by an idempotent caller; every other pending/running
 * Round is a conflicting lane regardless of its Reviewer Role.
 */
function assertNoConflictingTaskReviewRound(
  rounds: readonly ReviewRound[],
  reusableRoundIds: string | readonly string[] = []
): void {
  const reusable = new Set(
    typeof reusableRoundIds === "string" ? [reusableRoundIds] : reusableRoundIds
  );
  const conflicting = rounds.find((entry) => (
    !reusable.has(entry.id)
    && (entry.scope ?? "work-item") === "task"
    && (entry.status === "pending" || entry.status === "running")
  ));
  if (conflicting !== undefined) {
    throw usageError(
      `Another active Task-final ReviewRound already exists: ${conflicting.id}/${conflicting.reviewerRoleName}.`
    );
  }
}

function latestTaskReviewAnchor(
  store: TaskWorkflowStore,
  task: Task
): Readonly<{ item: WorkItem; candidate: WorkItemCandidate }> {
  const item = [...store.listWorkItems(task.id)]
    .filter(({ candidates }) => candidates.length > 0)
    .sort((left, right) => (
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
    ))
    .at(-1);
  if (item === undefined) {
    throw usageError(`Task ${task.id} has no WorkItem Candidate to anchor its final Review.`);
  }
  const candidate = item.candidates.at(-1);
  if (candidate === undefined) {
    throw usageError(`Task ${task.id} has no WorkItem Candidate to anchor its final Review.`);
  }
  return { item, candidate };
}

/**
 * Queues a Task-scoped final ReviewRound. The reviewer Role must be separate
 * from the Candidate producer. Returns the round (pending or failed) so the
 * caller can surface it to the CLI for workspace preparation and dispatch.
 */
function queueTaskReviewRound(
  store: TaskWorkflowStore,
  task: Task,
  item: WorkItem,
  candidateId: string,
  config: ReviewConfig,
  taskCandidate: TaskReviewCandidate,
  options: TaskCommandOptions,
  now: Date,
  requestedBy: ReviewRequestSource = "policy",
  taskFinalContract?: TaskFinalReviewContract
): ReviewRound {
  assertNoConflictingTaskReviewRound(store.listReviewRounds(task.id));
  const provenance = taskReviewProvenance(store, task, options, taskCandidate);
  if (!isSameTaskReviewCandidate(provenance.candidate, taskCandidate)) {
    throw usageError(`Task-final ReviewRound integrated heads changed before queueing.`);
  }
  const pending = createTaskReviewRound(
    store.nextReviewRoundId(task.id),
    task.id,
    item.id,
    candidateId,
    config.roleName,
    requestedBy,
    taskCandidate,
    now,
    taskFinalContract
  );
  store.saveReviewRound(task.id, pending);
  const producerCollision = taskReviewProducerCollision(provenance, config.roleName);
  if (producerCollision !== null) {
    const failed = finishReviewRound(
      pending,
      "failed",
      producerCollision,
      now
    );
    store.saveReviewRound(task.id, failed);
    return failed;
  }
  let reviewer = store.getRole(task.id, config.roleName);
  if (reviewer === null) {
    const globalRole = store.getGlobalRole(config.roleName);
    if (globalRole === null) {
      const failed = finishReviewRound(
        pending,
        "failed",
        `Global Role not found: ${config.roleName}.`,
        now
      );
      store.saveReviewRound(task.id, failed);
      return failed;
    }
    reviewer = createTaskRole(store, task, config.roleName, undefined, now, config.roleName);
    store.saveRole(task.id, reviewer);
  }
  if (store.getActiveAgentRun(task.id, reviewer.name) !== null) {
    const failed = finishReviewRound(
      pending,
      "failed",
      `Reviewer Role already has an active run: ${reviewer.name}.`,
      now
    );
    store.saveReviewRound(task.id, failed);
    return failed;
  }
  return pending;
}

/**
 * Creates the Task-scoped final ReviewRound when the review config trigger is
 * `final`. The round reviews the complete physical Task heads after validating
 * every Project with Integration evidence against its latest commit. If a pending
 * or running round already exists for the same frozen heads, it is returned
 * (or a failed round is surfaced as a blocker).
 */
function prepareFinalTaskReview(
  store: TaskWorkflowStore,
  task: Task,
  now: Date,
  taskFinalContract: TaskFinalReviewContract | undefined,
  options: TaskCommandOptions
): ReviewRound | null {
  // Any Task-final ReviewRound is durable completion evidence/obligation.
  // Once one exists, later changes to the mutable global review config cannot
  // weaken the requirement or change its reviewer. Before the first such
  // Round, the current global `final` config is still the supported way to
  // establish the policy and queue that initial Round.
  const taskRounds = reviewRoundsByIdentity(store.listReviewRounds(task.id))
    .filter((round) => (
      (round.scope ?? "work-item") === "task"
      && (taskFinalContract === undefined || sameTaskFinalReviewContract(
        round.taskFinalReviewContract,
        taskFinalContract
      ))
    ));
  const establishedRound = taskRounds.at(-1);
  let config: ReviewConfig | null;
  if (taskFinalContract !== undefined) {
    config = taskFinalReviewConfig(taskFinalContract);
  } else if (establishedRound === undefined) {
    const globalConfig = store.getReviewConfig();
    config = globalConfig?.trigger === "final" ? globalConfig : null;
  } else {
    config = { roleName: establishedRound.reviewerRoleName, trigger: "final" as const };
  }
  if (config === null || task.projectBindings.length === 0) return null;

  const taskCandidate = taskReviewProvenance(store, task, options).candidate;
  const latest = establishedRound;
  if (latest?.status === "running") {
    throw usageError(`Final Task Review is still active: ${latest.id}/${latest.status}.`);
  }
  if (latest?.status === "pending") {
    return resumablePendingFinalTaskReview(
      store,
      task,
      latest,
      config,
      taskCandidate,
      taskFinalContract,
      options
    );
  }
  if (latest !== undefined && isSameTaskReviewCandidate(latest.taskCandidate, taskCandidate)) {
    // A terminal round for the same immutable heads is already the final
    // review evidence. Do not create duplicate rounds on repeated completion
    // attempts. A failed round remains a blocker until the Leader changes the
    // candidate or otherwise resolves the failed evidence explicitly.
    // Issue 07: a completed delta-recheck that did not accept the head is not
    // final evidence.  A `requires-full-review` disposition escalates to a new
    // full Review; a `finding` disposition stays a blocker for the Leader.
    if (latest.status === "completed"
      && latest.deltaRecheck !== undefined
      && latest.deltaRecheck.disposition === "requires-full-review") {
      // Fall through to queue a full Review for the same candidate.
      const anchor = taskFinalContract === undefined
        ? latestTaskReviewAnchor(store, task)
        : latestTaskReviewContractAnchor(store, task, taskFinalContract);
      const escalated = queueTaskReviewRound(
        store,
        task,
        anchor.item,
        anchor.candidate.id,
        config,
        taskCandidate,
        options,
        now,
        establishedRound?.requestedBy ?? "policy",
        taskFinalContract
      );
      // Record the escalation lineage on the delta Round so the full Review
      // is traceable from the non-accepting delta disposition.
      if (latest.deltaRecheck.escalatedToReviewRoundId === undefined) {
        store.saveReviewRound(task.id, {
          ...latest,
          deltaRecheck: {
            ...latest.deltaRecheck,
            escalatedToReviewRoundId: escalated.id
          }
        });
      }
      return escalated;
    } else {
      return latest.status === "completed" ? null : latest;
    }
  }

  const anchor = taskFinalContract === undefined
    ? latestTaskReviewAnchor(store, task)
    : latestTaskReviewContractAnchor(store, task, taskFinalContract);
  return queueTaskReviewRound(
    store,
    task,
    anchor.item,
    anchor.candidate.id,
    config,
    taskCandidate,
    options,
    now,
    establishedRound?.requestedBy ?? "policy",
    taskFinalContract
  );
}

function resumablePendingFinalTaskReview(
  store: TaskWorkflowStore,
  task: Task,
  round: ReviewRound,
  config: ReviewConfig,
  taskCandidate: TaskReviewCandidate,
  taskFinalContract: TaskFinalReviewContract | undefined,
  options: TaskCommandOptions
): ReviewRound {
  if (taskFinalContract === undefined || round.taskFinalReviewContract === undefined) {
    throw usageError(`Final Task Review is still active: ${round.id}/${round.status}.`);
  }
  if (!sameTaskFinalReviewContract(round.taskFinalReviewContract, taskFinalContract)) {
    throw usageError(
      `Pending final ReviewRound ${round.id} does not match the durable Task final-review contract.`
    );
  }
  if (round.reviewerRoleName !== config.roleName
    || round.reviewerRoleName !== taskFinalContract.reviewerRoleName) {
    throw usageError(`Pending final ReviewRound Reviewer identity changed: ${round.id}.`);
  }
  if (round.reviewerRunId !== undefined) {
    throw usageError(
      `Pending final ReviewRound already records Reviewer Run ${round.reviewerRunId}: ${round.id}.`
    );
  }
  if (!isSameTaskReviewCandidate(round.taskCandidate, taskCandidate)) {
    throw usageError(
      `Final ReviewRound ${round.id} freezes a candidate that is no longer the current Task candidate.`
    );
  }
  assertNoConflictingTaskReviewRound(store.listReviewRounds(task.id), round.id);
  const reviewer = store.getRole(task.id, round.reviewerRoleName);
  if (reviewer === null || reviewer.name !== round.reviewerRoleName) {
    throw usageError(`Pending final ReviewRound Reviewer identity changed: ${round.id}.`);
  }
  if (store.getActiveAgentRun(task.id, reviewer.name) !== null) {
    throw usageError(`Reviewer Role already has an active run: ${reviewer.name}.`);
  }
  assertPendingFinalReviewWorkspaceEvidence(store, task, round);
  const provenance = taskReviewProvenance(store, task, options, taskCandidate);
  const producerCollision = taskReviewProducerCollision(provenance, reviewer.name);
  if (producerCollision !== null) {
    throw usageError(producerCollision);
  }
  return round;
}

function assertPendingFinalReviewWorkspaceEvidence(
  store: TaskWorkflowStore,
  task: Task,
  round: ReviewRound
): void {
  const stored = store.getReviewRoundWorkspace(task.id, round.id);
  if (round.workspace !== undefined) {
    if (stored === null || !isDeepStrictEqual(round.workspace, stored)) {
      throw usageError(`Pending final ReviewRound workspace evidence changed: ${round.id}.`);
    }
    return;
  }
  if (stored === null) return;
  const commits = new Map(
    round.taskCandidate!.projects.map(({ projectId, commit }) => [projectId, commit])
  );
  if (stored.owner.type !== "review-round"
    || stored.owner.taskId !== task.id
    || stored.owner.reviewRoundId !== round.id
    || stored.entries.length !== task.projectBindings.length) {
    throw usageError(`Pending final ReviewRound workspace evidence changed: ${round.id}.`);
  }
  for (const binding of task.projectBindings) {
    const entry = stored.entries.find(({ projectId }) => projectId === binding.projectId);
    const commit = commits.get(binding.projectId);
    if (entry === undefined
      || commit === undefined
      || entry.directory !== binding.directory
      || entry.access !== "write"
      || entry.baseCommit !== commit
      || entry.baseRef !== commit) {
      throw usageError(`Pending final ReviewRound workspace evidence changed: ${round.id}.`);
    }
  }
}

function latestTaskReviewContractAnchor(
  store: TaskWorkflowStore,
  task: Task,
  taskFinalContract: TaskFinalReviewContract
): Readonly<{ item: WorkItem; candidate: WorkItemCandidate }> {
  const anchor = store.listWorkItems(task.id)
    .flatMap((item) => {
      const candidate = governingWorkItemCandidate(item);
      return candidate !== undefined && sameTaskFinalReviewContract(
        candidate.taskFinalReviewContract,
        taskFinalContract
      )
        ? [{ item, candidate }]
        : [];
    })
    .sort((left, right) => (
      left.item.updatedAt.localeCompare(right.item.updatedAt)
      || left.item.id.localeCompare(right.item.id)
    ))
    .at(-1);
  if (anchor === undefined) {
    throw usageError(`Task ${task.id} has no WorkItem Candidate to anchor its final Review.`);
  }
  return anchor;
}

/**
 * Leader-only retry of an exact failed Task-final review Run. The old failed
 * Run remains the attempt trail, while the semantic ReviewRound is reset to
 * pending under its existing identity. Every identity and frozen-head fence is
 * checked inside one transaction so a partial fail-old-without-reset state can
 * never be committed.
 */
function retryFailedReviewRun(
  previous: AgentRun,
  store: TaskWorkflowStore,
  options: TaskCommandOptions,
  now: Date
): TaskCommandExecution {
  const result = store.transaction((tx) => {
    const run = tx.getAgentRun(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "review") {
      throw usageError(`Run ${previous.id} is not a failed review run.`);
    }
    if (run.reviewRoundId === undefined) {
      throw usageError(`Review Run ${run.id} has no ReviewRound.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may retry a failed final review Run.");
    }
    const round = tx.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) {
      throw dataError(`ReviewRound not found for run ${run.id}: ${run.reviewRoundId}.`);
    }
    if ((round.scope ?? "work-item") !== "task") {
      throw usageError(
        `Review Run ${run.id} is not a Task-final review; request a new WorkItem review `
        + "for a new Candidate."
      );
    }
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (!sameTaskFinalReviewContract(round.taskFinalReviewContract, taskFinalContract)) {
      throw usageError(`Task final-review contract does not match ReviewRound ${round.id}.`);
    }
    if (round.status !== "failed"
      && round.status !== "running"
      && round.status !== "pending"
      && round.status !== "completed") {
      throw usageError(`ReviewRound ${round.id} is not retryable from ${round.status}.`);
    }
    const currentTaskCandidate = actualTaskReviewCandidateForMutation(tx, task, options);
    if (!isSameTaskReviewCandidate(currentTaskCandidate, round.taskCandidate!)) {
      throw usageError(
        `Task-final ReviewRound ${round.id} no longer matches the latest committed Integration heads.`
      );
    }
    const item = tx.getWorkItem(task.id, round.workItemId);
    if (item === null) {
      throw dataError(`Work item not found for run ${run.id}: ${round.workItemId}.`);
    }
    const candidate = item.candidates.find(({ id }) => id === round.candidateId);
    if (candidate === undefined) {
      throw dataError(`ReviewRound Candidate not found: ${round.candidateId}.`);
    }
    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((entry) => (entry.scope ?? "work-item") === "task"));
    const roundIndex = taskRounds.findIndex(({ id }) => id === round.id);
    if (roundIndex < 0) {
      throw dataError(`Final ReviewRound is not in Task history: ${round.id}.`);
    }
    const laterRound = taskRounds.slice(roundIndex + 1).at(-1);
    if (laterRound !== undefined && !isSameTaskReviewCandidate(
      laterRound.taskCandidate,
      round.taskCandidate!
    )) {
      throw usageError(
        `A newer final Task candidate already has ReviewRound ${laterRound.id}.`
      );
    }
    const allReviewerRounds = reviewRoundsByIdentity(
      tx.listReviewRounds(task.id).filter((entry) => (
        entry.reviewerRoleName === round.reviewerRoleName
      ))
    );
    assertNoConflictingTaskReviewRound(tx.listReviewRounds(task.id), round.id);
    const activeRound = allReviewerRounds.find((entry) => (
      entry.id !== round.id
      && (entry.status === "pending" || entry.status === "running")
    ));
    if (activeRound !== undefined) {
      throw usageError(
        `Reviewer already has an active review round for this candidate: ${activeRound.id}.`
      );
    }

    const reviewerMailboxTarget = roleMailbox(task.id, round.reviewerRoleName);
    const reviewerMailbox = tx.getWorkMailbox(reviewerMailboxTarget);
    const reviewerPending = reviewerMailbox === null ? null : nextPendingBatch(reviewerMailbox);
    const runtimeMailbox = tx.getWorkMailbox(runtimeLifecycleTarget({
      scope: "task",
      taskId: task.id,
      roleName: round.reviewerRoleName
    }));

    const hasMailboxWork = (mailbox: ReturnType<typeof tx.getWorkMailbox>): boolean => (
      mailbox !== null && workMailboxHasWork(mailbox)
    );

    const reviewer = requireRole(tx, task.id, round.reviewerRoleName);
    const activePointer = tx.getActiveAgentRun(task.id, reviewer.name);
    const activeReviewerRuns = tx.listAgentRuns(task.id).filter((entry) => (
      entry.roleName === reviewer.name && entry.status === "active"
    ));

   // Issue 06: a completed same-Round retry is a no-write idempotent result.
   if (round.status === "completed") {
     if (activePointer !== null || activeReviewerRuns.length > 0) {
       throw usageError(`Reviewer Role already has an active run: ${reviewer.name}.`);
     }
     if (hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
       throw usageError(`Reviewer has unrelated mailbox work: ${reviewer.name}.`);
     }
      return { round, previousRun: run, created: false };
   }

    // Issue 06: a running same Round is reusable only with its exact active
    // Run and mailbox execution. A stranded Run (no active pointer) falls
    // through and resets the Round after the identity fences below.
    if (round.status === "running") {
      const reviewerRunId = round.reviewerRunId;
      const activeMatches = reviewerRunId !== undefined
        && activePointer !== null
        && activePointer.id === reviewerRunId
        && activePointer.status === "active"
        && activeReviewerRuns.length === 1
        && activeReviewerRuns[0]!.id === reviewerRunId;
      const processingMatches = reviewerRunId !== undefined
        && reviewerMailbox?.processing?.executionRef !== undefined
        && isDeepStrictEqual(
          reviewerMailbox.processing.executionRef,
          runRef(task.id, reviewerRunId)
        )
        && reviewerPending === null;
      const pendingMatches = reviewerRunId !== undefined
        && reviewerMailbox?.processing === null
        && reviewerPending?.requestCount === 1
        && reviewerPending.refs.some((ref) => (
          isDeepStrictEqual(ref, runRef(task.id, reviewerRunId))
        ));
      if (activePointer !== null
        && (!activeMatches
          || (!processingMatches && !pendingMatches)
          || hasMailboxWork(runtimeMailbox))) {
        throw usageError(
          `Existing running ReviewRound ${round.id} lacks its exact active Reviewer execution.`
        );
      }
      if (activeMatches) return { round, previousRun: run, created: false };
   }

   // Issue 06: an already-pending Round is the idempotent retry result.
   if (round.status === "pending") {
     if (activePointer !== null || activeReviewerRuns.length > 0) {
       throw usageError(`Reviewer Role already has an active run: ${reviewer.name}.`);
     }
     if (hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
       throw usageError(`Reviewer has unrelated mailbox work: ${reviewer.name}.`);
     }
      return { round, previousRun: run, created: false };
   }

    if (activePointer !== null || activeReviewerRuns.length > 0) {
      throw usageError(`Reviewer Role already has an active run: ${reviewer.name}.`);
    }
    if (runtimeMailbox?.processing !== null && runtimeMailbox?.processing !== undefined) {
      throw usageError(`Reviewer runtime lifecycle is pending: ${reviewer.name}.`);
    }
    if (runtimeMailbox !== null && workMailboxHasWork(runtimeMailbox)) {
      throw usageError(`Reviewer runtime lifecycle has pending work: ${reviewer.name}.`);
    }

    const validation = validateExactRunReviewRound(tx, run, { allowTerminal: true });
    if (validation.disposition !== "applied" || validation.round === null) {
      throw usageError(
        `Review Run ${run.id} identity does not match its ReviewRound or frozen Task state changed: ${validation.reason ?? "mismatch"}.`
      );
    }

    // A stranded pre-delivery Run can leave its exact pending or processing
    // dispatch behind; settle only that exact reference while holding the
    // same aggregate lock. Any merged or unrelated batch fails closed.
    const exactOldRunRef = runRef(task.id, run.id);
    if (reviewerMailbox?.processing !== null && reviewerMailbox?.processing !== undefined) {
      if (
        reviewerMailbox.processing.executionRef === undefined
        || !isDeepStrictEqual(reviewerMailbox.processing.executionRef, exactOldRunRef)
        || reviewerPending !== null
      ) {
        throw usageError(`Reviewer mailbox is busy: ${reviewer.name}.`);
      }
      settleExactWorkExecution(tx, reviewerMailboxTarget, exactOldRunRef);
    } else if (reviewerPending !== null) {
      const exact = reviewerPending.refs.some((ref) => (
        isDeepStrictEqual(ref, exactOldRunRef)
      ));
      if (!exact) throw usageError(`Reviewer mailbox has unrelated pending work: ${reviewer.name}.`);
      if (reviewerPending.requestCount !== 1) {
        throw usageError(`Reviewer mailbox has merged pending work: ${reviewer.name}.`);
      }
      settleExactWorkExecution(tx, reviewerMailboxTarget, exactOldRunRef);
    }
    // Terminalize the old stranded Round only after every identity and mailbox
    // fence has passed. The outer transaction rolls back if Round creation fails.
    let roundToReset = round;
    if (round.status !== "failed") {
      const summary = round.summary
        ?? run.summary
        ?? `Review Run ${run.id} failed before delivery.`;
      roundToReset = finishReviewRound(
        round,
        "failed",
        summary,
        now,
        {
          report: round.report ?? summary,
          checks: round.checks ?? [],
          ...(round.evidenceCommit === undefined ? {} : { evidenceCommit: round.evidenceCommit })
        }
      );
      tx.saveReviewRound(task.id, roundToReset);
    }
    // Issue 06: infra retry resets the same semantic Round to pending instead
    // of manufacturing a new Round, so Round count and finding identity stay
    // stable across execution-attempt failures.
    const resetRound = retryTaskReviewRound(roundToReset);
    tx.saveReviewRound(task.id, resetRound);
    recordTaskEvent(tx, task.id, "run.review-retried", {
      runId: run.id,
      reviewRoundId: round.id,
      candidateId: candidate.id
    }, now);
    return { round: resetRound, previousRun: run, created: true };
  });
  return output(
    result.created
      ? `Review retry requested as ${result.round.id}\n`
      : `Review retry already requested as ${result.round.id} (${result.round.status})\n`,
    { reviewRound: result.round }
  );
}

/**
 * Records one explicit Leader recovery decision against an exact live Run.
 * Retry and Session replacement remain requests: the Controller never sends
 * another input or changes a native generation from this command.
 */
function recoverRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task run recover usage: yui task run recover <task>/<run> --action <diagnose|retry|replace-session|terminate> (--expected-progress-at <timestamp>|--from-next-action <fingerprint>) --provider-acceptance <accepted|rejected|ambiguous> --reason <text> [--agent-id <id>] [--adapter-id <id>] [--native-session-id <id>] [--launch-id <id>].";
  const parsed = parseTail(
    args,
    new Set([
      "--action",
      "--expected-progress-at",
      "--progress-at",
      "--from-next-action",
      "--provider-acceptance",
      "--reason",
      "--role",
      "--agent-id",
      "--adapter-id",
      "--native-session-id",
      "--launch-id"
    ]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const now = clock(options);
  const fingerprint = parsed.options.get("--from-next-action");
  const explicitFence = parsed.options.get("--expected-progress-at")
    ?? parsed.options.get("--progress-at");
  if (fingerprint !== undefined && explicitFence !== undefined) {
    throw usageError(
      "--from-next-action and --expected-progress-at/--progress-at are mutually exclusive.",
      usage
    );
  }
  const input = store.transaction((tx) => {
    const active = requireRun(tx, parsed.positionals[0], options);
    const task = requireTask(tx, active.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "recovering a run"));
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may control exact Agent Run recovery.");
    }
    const roleName = parsed.options.get("--role") ?? active.roleName;
    if (roleName !== active.roleName) {
      throw usageError(`Recovery Role does not match Run ${active.id}: ${roleName}.`);
    }
    const role = requireRole(tx, task.id, roleName);
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const session = sessions?.sessions[sessions.activeAgentId];
    // Issue 08: a fingerprint copied from `task run show` resolves the
    // canonical fence server-side. The projection is recomputed here, so a
    // fingerprint from stale observations matches nothing and fails closed.
    let plan: RunRecoveryProjection["actions"][number] | null = null;
    if (fingerprint !== undefined) {
      const facts = readRunRecoveryFacts(tx, task.id, active.id);
      if (facts === null) throw usageError(`Agent Run not found: ${task.id}/${active.id}.`, usage);
      const projection = projectRunRecovery(facts);
      plan = projection.actions.find((entry) => entry.fingerprint === fingerprint) ?? null;
      if (plan === null) {
        throw usageError(runRecoveryStaleDiagnosis(
          task.id,
          active.id,
          projection.canonicalProgressAt ?? null,
          "recovery action fingerprint is stale or unknown"
        ), usage);
      }
    }
    const action = parseRecoveryAction(
      parsed.options.get("--action") ?? plan?.action,
      usage
    );
    if (plan !== null && plan.action !== action) {
      throw usageError(
        `--action ${action} does not match recovery fingerprint action ${plan.action}.`,
        usage
      );
    }
    const expectedProgressAt = explicitFence ?? plan?.expectedProgressAt;
    if (expectedProgressAt === undefined) {
      throw usageError("--expected-progress-at is required.", usage);
    }
    const providerAcceptance = parseProviderAcceptance(
      parsed.options.get("--provider-acceptance"),
      usage
    );
    const agentId = parsed.options.get("--agent-id")
      ?? plan?.agentId
      ?? active.effective.agentId;
    const adapterId = parsed.options.get("--adapter-id")
      ?? plan?.adapterId
      ?? active.effective.adapterId;
    const nativeSessionId = parsed.options.get("--native-session-id")
      ?? plan?.nativeSessionId
      ?? session?.nativeSessionId;
    const launchId = parsed.options.get("--launch-id")
      ?? plan?.launchId
      ?? session?.launchId;
    return {
      taskId: task.id,
      roleName: role.name,
      runId: active.id,
      agentId,
      adapterId,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      ...(launchId === undefined ? {} : { launchId }),
      expectedProgressAt,
      providerAcceptance,
      action,
      reason: requiredOption(parsed.options, "--reason"),
      now
    };
  });
  const result = recoverExactAgentRun(store, input);
  if (result.disposition !== "applied") {
    throw usageError(
      runRecoveryStaleDiagnosis(
        input.taskId,
        input.runId,
        result.progressAt ?? null,
        `exact Run recovery ${result.disposition}: ${result.reason ?? "state changed"}`
      ),
      usage
    );
  }
  // The durable recovery request is committed before asking the Controller to
  // wake the owning Leader; a failed transaction must not leak a signal.
  if (result.run !== null && result.run.roleName !== LEADER_ROLE) {
    notifyMailbox(options.runtime, leaderMailbox(result.run.taskId), result.run.taskId);
  }
  const followup = result.requiresExplicitFollowup === true
    ? " Leader follow-up is required; no provider input or Session action was performed."
    : "";
  return `Recorded exact ${result.action} recovery for ${result.run?.id ?? "unknown Run"}.${followup}\n`;
}

/**
 * Issue 08: every recovery rejection carries the current canonical fence and
 * points at the single read-only command that projects it. The caller's
 * side-effecting action is never retried automatically.
 */
function runRecoveryStaleDiagnosis(
  taskId: string,
  runId: string,
  canonicalProgressAt: string | null,
  detail: string
): string {
  const fence = canonicalProgressAt === null
    ? "no durable progress timestamp is available for this Run"
    : `the canonical durable fence is now ${canonicalProgressAt}`;
  return `${detail}; ${fence}. Re-read the recovery plan: yui task run show ${taskId}/${runId}.`;
}

/**
 * Issue 08: read-only Run detail with the canonical recovery fence, Provider
 * evidence, and every exact recovery action. Never mutates state and never
 * selects an action or Provider acceptance for the Leader.
 */
function showRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task run show usage: yui task run show <task>/<run> [--json].";
  const asJson = args.includes("--json");
  const positionals = args.filter((arg) => arg !== "--json");
  exactPositionals(positionals, 1, usage);
  const data = store.transaction((tx) => {
    const run = requireRun(tx, positionals[0], options);
    const facts = readRunRecoveryFacts(tx, run.taskId, run.id);
    if (facts === null) throw usageError(`Agent Run not found: ${run.taskId}/${run.id}.`, usage);
    return { run, recovery: projectRunRecovery(facts) };
  });
  if (asJson) {
    return { kind: "output" as const, output: `${JSON.stringify(data, null, 2)}\n`, data };
  }
  return { kind: "output" as const, output: renderRunShow(data.run, data.recovery), data };
}

function renderRunShow(run: AgentRun, recovery: RunRecoveryProjection): string {
  const lines = [
    `Run: ${run.id}`,
    `Task: ${run.taskId}`,
    `Role: ${run.roleName}`,
    `Purpose: ${run.purpose}`,
    `Mode: ${run.mode}`,
    `Status: ${run.status}`,
    `Effective: ${run.effective.agentId}/${run.effective.adapterId} r${run.effective.sourceDesiredRevision}`,
    `Created: ${run.createdAt}`,
    ...(run.pushedAt === undefined ? [] : [`Pushed: ${run.pushedAt}`]),
    ...(run.deliveredAt === undefined
      ? []
      : [`Provider accepted (durable): ${run.deliveredAt}`]),
    ...(run.summary === undefined || run.summary.trim().length === 0
      ? []
      : [`Summary: ${run.summary}`])
  ];
  if (recovery.canonicalProgressAt !== null) {
    lines.push(
      `Canonical recovery fence (Yui durable CAS): ${recovery.canonicalProgressAt}`,
      ...(recovery.canonicalProgressEvidence === undefined
        ? []
        : [`Fence evidence: ${recovery.canonicalProgressEvidence}`])
    );
  }
  if (recovery.provider.observedAt !== null) {
    lines.push(
      `Provider observation (evidence only, not a fence): `
      + `${recovery.provider.observationKind} at ${recovery.provider.observedAt}`
    );
  }
  if (recovery.session !== null) {
    const session = recovery.session;
    lines.push(
      `Session: ${session.status}`
      + `${session.nativeSessionId === undefined ? "" : ` ${session.nativeSessionId}`}`
      + `${session.launchId === undefined ? "" : ` launch ${session.launchId}`}`
    );
  }
  if (recovery.recoverable) {
    lines.push(
      `Provider acceptance options: ${recovery.providerAcceptance.options.join(", ")}`,
      "Recovery actions (copy one; the fence is already canonical):"
    );
    for (const plan of recovery.actions) {
      lines.push(`  [${plan.action}] ${plan.reason}`, `    ${plan.command}`);
    }
    if (recovery.judgmentRequired !== undefined) {
      lines.push(`Judgment: ${recovery.judgmentRequired}`);
    }
  } else {
    lines.push(`Not recoverable: ${recovery.reason ?? "unknown"}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Issue 04: builds the terminal yield outcome from the command inputs. The
 * same construction feeds both the first commit and the idempotent replay, so
 * a resend always hashes to the same digest.
 */
function buildYieldOutcome(
  run: AgentRun,
  inputSummary: string,
  options: TaskCommandOptions
): { summary: string; reviewResult?: Parameters<typeof terminalizeExactTaskRun>[1]["reviewResult"] } {
  let yieldedReport;
  if (run.purpose === "review"
    || (run.purpose === "execution" && run.executionGroupId !== undefined)) {
    yieldedReport = parseReviewYieldReport(inputSummary);
  }
  const summary = yieldedReport?.summary ?? inputSummary;
  if (yieldedReport === undefined) return { summary };
  return {
    summary,
    reviewResult: {
      report: yieldedReport.report,
      checks: yieldedReport.checks,
      ...(yieldedReport.findings === undefined ? {} : { findings: yieldedReport.findings }),
      ...(yieldedReport.evidence === undefined ? {} : { evidence: yieldedReport.evidence }),
      ...(run.purpose === "review"
        && options.reviewWorkspaceResult?.evidenceCommit === undefined
        ? {}
        : run.purpose === "review"
          ? { evidenceCommit: options.reviewWorkspaceResult!.evidenceCommit }
          : yieldedReport.evidenceCommit === undefined
            ? {}
            : { evidenceCommit: yieldedReport.evidenceCommit }),
      ...(options.executionLaneGitSnapshot === undefined
        || options.executionLaneGitSnapshot === null
        ? {}
        : { gitSnapshot: options.executionLaneGitSnapshot }),
      ...(yieldedReport.deltaDisposition === undefined
        ? {}
        : { deltaDisposition: yieldedReport.deltaDisposition }),
      ...(yieldedReport.deltaReasoning === undefined
        ? {}
        : { deltaReasoning: yieldedReport.deltaReasoning })
    }
  };
}

/**
 * Issue 04: replays an already-committed yield. Returns the committed receipt
 * for the same outcome, fails closed for a different outcome, or returns
 * `null` to keep the legacy "already terminal" behavior.
 */
function replayYieldReceipt(
  run: AgentRun,
  inputSummary: string,
  options: TaskCommandOptions
): TaskCommandExecution | null {
  if (run.yieldReceipt === undefined) return null;
  const outcome = buildYieldOutcome(run, inputSummary, options);
  const match = matchYieldReceipt(run.yieldReceipt, {
    status: "yielded",
    summary: outcome.summary,
    ...(outcome.reviewResult === undefined ? {} : { reviewResult: outcome.reviewResult })
  });
  if (match === null) return null;
  if (match.kind === "digest-mismatch") {
    throw usageError(
      `Run ${run.id} is already terminal with a different yield outcome. `
      + `Existing receipt: ${match.existing.receiptId} (request ${match.existing.requestId}).`
    );
  }
  return output(
    `Run ${run.id} yield already committed.\n`
    + `Receipt: ${match.receipt.receiptId}\n`
    + `Request: ${match.receipt.requestId}\n`,
    { receipt: match.receipt }
  );
}

/**
 * Issue 04: `yui task run yield-status <task>/<run>` — returns the committed
 * yield receipt for a terminal Run, or the current status for an active Run.
 */
function yieldRunStatus(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task run yield-status usage: yui task run yield-status <task>/<run>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const run = requireRun(store, parsed.positionals[0], options);
  if (run.status === "active") {
    return output(`Run ${run.id} is active; no yield receipt yet.\n`, {
      runId: run.id,
      status: run.status
    });
  }
  if (run.yieldReceipt === undefined) {
    return output(`Run ${run.id} is ${run.status}; no yield receipt recorded.\n`, {
      runId: run.id,
      status: run.status
    });
  }
  return output(
    `Run ${run.id} yield receipt:\n`
    + `Receipt: ${run.yieldReceipt.receiptId}\n`
    + `Request: ${run.yieldReceipt.requestId}\n`
    + `Committed: ${run.yieldReceipt.committedAt}\n`,
    { receipt: run.yieldReceipt }
  );
}

function yieldRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task run yield usage: yui task run yield <task>/<run> (--summary <text>|--summary-file <path|->).";
  const parsed = parseTail(args, new Set(["--summary", "--summary-file"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const inputSummary = readCommandText(
    parsed.options.get("--summary"),
    parsed.options.get("--summary-file"),
    "--summary",
    usage
  );
  const now = clock(options);
  // Issue 04: an already-terminal Run may be a lost-response resend. Match
  // the presented outcome against the committed receipt before opening the
  // transaction; the receipt is immutable once committed.
  const existing = requireRun(store, parsed.positionals[0], options);
  if (existing.status !== "active") {
    const replayed = replayYieldReceipt(
      existing,
      inputSummary,
      options
    );
    if (replayed !== null) return replayed;
    throw usageError(`Run ${existing.id} is already terminal: ${existing.status}.`);
  }
  const yielded = store.transaction((tx) => {
    const active = requireRun(tx, parsed.positionals[0], options);
    if (active.status !== "active") {
      throw usageError(`Run ${active.id} is already terminal: ${active.status}.`);
    }
    if (active.pushedAt === undefined) {
      throw usageError(`Run ${active.id} delivery is still pending.`);
    }
    const task = requireTask(tx, active.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "yielding a run"));
    const role = requireRole(tx, task.id, active.roleName);
    const pointer = activeRunPointer(tx, active);
    if (pointer?.id !== active.id) throw usageError(`Run is not active for ${task.id}/${role.name}: ${active.id}.`);
    const taskFinalContract = active.purpose === "execution"
      && active.workItemId !== undefined
      ? taskFinalReviewContractForMutation(tx, task.id, options)
      : undefined;
    const wasStalled = isRoleRunStalled(tx.listEvents(task.id), active.id);
    let yieldedReport;
    if (active.purpose === "review"
      || (active.purpose === "execution" && active.executionGroupId !== undefined)) {
      try {
        yieldedReport = parseReviewYieldReport(inputSummary);
      } catch (error) {
        throw usageError(error instanceof Error ? error.message : String(error));
      }
    }
    const groupedLaneRun = active.executionGroupId !== undefined
      && active.executionLaneId !== undefined;
    if (active.purpose !== "review"
      && groupedLaneRun
      && options.yuiHome !== undefined
      && options.executionLaneGitSnapshot === undefined) {
      throw usageError(
        `Managed Execution Lane Git snapshot preflight is missing: ${active.id}.`
      );
    }
    if (active.purpose === "review") {
      if (options.reviewWorkspaceResult === undefined) {
        throw usageError(`Review Run requires managed workspace preflight: ${active.id}.`);
      }
      if (yieldedReport?.evidenceCommit !== undefined
        && yieldedReport.evidenceCommit !== options.reviewWorkspaceResult.evidenceCommit) {
        throw usageError(
          `Reported Review evidence commit does not match the managed workspace: ${active.id}.`
        );
      }
    }
    const yieldOutcome = buildYieldOutcome(active, inputSummary, options);
    const summary = yieldOutcome.summary;
    const terminalization = terminalizeExactTaskRun(tx, {
      taskId: task.id,
      roleName: role.name,
      agentId: active.effective.agentId,
      runId: active.id,
      receiptId: agentRunDeliveryReceiptId(active),
      ...(active.purpose !== "review" || options.environment?.YUI_NATIVE_SESSION_ID === undefined
        ? {}
        : { nativeSessionId: options.environment.YUI_NATIVE_SESSION_ID }),
      ...(active.purpose !== "review" || options.environment?.YUI_LAUNCH_ID === undefined
        ? {}
        : { launchId: options.environment.YUI_LAUNCH_ID }),
      outcome: { status: "yielded", summary },
      ...(yieldOutcome.reviewResult === undefined
        ? {}
        : { reviewResult: yieldOutcome.reviewResult })
    }, now);
    if (terminalization.disposition !== "applied" || terminalization.run === null) {
      throw usageError(
        `Run ${active.id} no longer matches its exact execution fence: `
        + `${terminalization.reason ?? "obsolete"}.`
      );
    }
    const terminal = terminalization.run;
    let reviewGroupPending = false;
    let reviewGroupReady = false;
    if (wasStalled) {
      recordTaskEvent(tx, task.id, RUN_RECOVERED_EVENT, {
        runId: terminal.id,
        roleName: role.name,
        progressAt: now.toISOString(),
        kind: "yield"
      }, now);
    }
    clearMatchingLeaderStallAttention(tx, task.id, active.id);
    if (active.purpose === "review") {
      const round = active.reviewRoundId === undefined
        ? null
        : tx.getReviewRound(task.id, active.reviewRoundId);
      const panel = round?.executionGroup !== undefined
        && (round.executionGroup.lanes.length > 1
          || round.executionGroup.strategy.mode === "adaptive");
      if (round === null || round.reviewerRunId === undefined) {
        throw usageError(`ReviewRun did not complete its exact ReviewRound: ${active.id}.`);
      }
      if (panel) {
        reviewGroupPending = round.status !== "completed";
        reviewGroupReady = reviewGroupPending
          && round.executionGroup!.lanes.every(({ status }) => (
            ["yielded", "completed", "failed"].includes(status)
          ));
        if (reviewGroupReady) {
          const panelGroup = round.executionGroup!;
          recordTaskEvent(tx, task.id, "review-group-ready", {
            reviewRoundId: round.id,
            workItemId: round.workItemId,
            candidateId: round.candidateId,
            executionGroupId: panelGroup.id,
            terminalLanes: String(panelGroup.lanes
              .filter(({ status }) => ["yielded", "completed", "failed"].includes(status)).length),
            laneCount: String(panelGroup.lanes.length)
          }, now);
        }
      } else {
        if (round.status !== "completed" || round.reviewerRunId !== active.id) {
          throw usageError(`ReviewRun did not complete its exact ReviewRound: ${active.id}.`);
        }
        recordTaskEvent(tx, task.id, "review.completed", {
          reviewRoundId: round.id,
          workItemId: round.workItemId,
          candidateId: round.candidateId,
          reviewBaseCommit: round.reviewBaseCommit,
          evidenceCommit: round.evidenceCommit ?? "none",
          checks: round.checks?.map(({ name, outcome }) => `${name}:${outcome}`)
            .join(",") || "none",
          ...(round.deltaRecheck === undefined
            ? {}
            : {
                reviewMode: "delta-recheck",
                deltaDisposition: round.deltaRecheck.disposition ?? "requires-full-review",
                previousReviewRoundId: round.deltaRecheck.previousReviewRoundId,
                diffDigest: round.deltaRecheck.diffDigest
              })
        }, now);
      }
    }
    let automaticReview: Readonly<{
      item: WorkItem;
      config: ReviewConfig;
    }> | null = null;
    let submittedItem: WorkItem | null = null;
    let executionGroupPending = false;
    let executionGroupReady = false;
    if (active.purpose === "review") {
      // Saving the terminal review Run completes its ReviewRound in the same
      // aggregate transaction. The WorkItem remains the candidate under review.
    } else if (active.workItemId !== undefined) {
      const item = tx.getWorkItem(task.id, active.workItemId);
      if (item === null) throw dataError(`Work item not found for run ${active.id}: ${active.workItemId}.`);
      const currentGroup = currentWorkItemExecutionGroup(item);
      const multiLaneGroup = currentGroup !== undefined
        && (currentGroup.lanes.length > 1
          || currentGroup.strategy.mode === "adaptive")
        && currentGroup.resolution === undefined;
      if (multiLaneGroup) {
        executionGroupPending = true;
        executionGroupReady = currentGroup!.lanes.every(({ status }) => (
          ["yielded", "completed", "failed"].includes(status)
        ));
        if (executionGroupReady) {
          recordTaskEvent(tx, task.id, "execution-group-ready", {
            workItemId: item.id,
            executionGroupId: currentGroup!.id,
            terminalLanes: String(currentGroup!.lanes.length),
            laneCount: String(currentGroup!.lanes.length)
          }, now);
        }
      } else {
      const configuredReview = tx.getReviewConfig();
      const candidatePolicy = taskFinalContract === undefined
        ? legacyWorkItemReviewConfig(configuredReview)
        : taskFinalReviewConfig(taskFinalContract);
      const projectDelivery = task.projectBindings.length > 0
        && item.writeProjectIds.length > 0;
      const candidateRequired = role.name !== LEADER_ROLE
        || candidatePolicy !== null
        || projectDelivery;
      let candidateSourceItem = item;
      if (candidateRequired
        && currentGroup !== undefined
        && currentGroup.resolution === undefined) {
        const resolvedSingle = resolveExecutionGroup(currentGroup, {
          decision: "accept",
          summary,
          selectedLaneIds: [active.executionLaneId!]
        }, now);
        candidateSourceItem = updateWorkItemExecutionGroup(item, resolvedSingle, now);
        tx.saveWorkItem(task.id, candidateSourceItem);
      }
      const yieldedItem = candidateRequired
          ? submitWorkItemCandidate(candidateSourceItem, {
            summary,
            source: { type: "run", runId: terminal.id },
            ...(candidatePolicy === null ? {} : { reviewPolicy: candidatePolicy }),
            ...(taskFinalContract === undefined
              ? {}
              : { taskFinalReviewContract: taskFinalContract }),
            ...(active.executionGroupId === undefined
              ? {}
              : {
                  executionGroupId: active.executionGroupId,
                  executionLaneId: active.executionLaneId
                }),
            ...(active.workspace === undefined
              || (active.workspace.owner.type === "task"
                && active.workspace.entries.length === 0)
              ? {}
              : { workspace: active.workspace }),
            ...(options.candidateGitSnapshot === undefined
              ? {}
              : { gitSnapshot: options.candidateGitSnapshot })
          }, now)
        : updateWorkItemStatus(item, "completed", now, summary);
      tx.saveWorkItem(task.id, yieldedItem);
      if (candidateRequired) submittedItem = yieldedItem;
      if (candidatePolicy?.trigger === "always") {
        automaticReview = { item: yieldedItem, config: candidatePolicy };
      }
      }
    } else if (role.name !== LEADER_ROLE) {
      throw usageError(`Run ${active.id} is not a work run.`);
    }
    const reviewDispatch = automaticReview === null
      ? null
      : queueReviewRound(
          tx,
          automaticReview.item,
          automaticReview.config,
          "policy",
          now
        );
    const leaderHandoff = active.purpose === "review"
      ? (reviewGroupPending
        ? (reviewGroupReady ? "review-group-ready" : null)
        : "review-result")
      : submittedItem === null
        && executionGroupPending
        ? (executionGroupReady ? "execution-group-ready" : null)
        : submittedItem === null
        || (reviewDispatch !== null && reviewDispatch.run !== null)
        ? null
        : reviewDispatch?.round.status === "failed"
          ? "review-failed"
          : "candidate-ready";
    if (leaderHandoff !== null) {
      enqueueWork(tx, leaderMailbox(task.id), leaderHandoff, now, [
        runRef(task.id, terminal.id),
        ...(terminal.workItemId === undefined ? [] : [workItemRef(task.id, terminal.workItemId)])
      ]);
    }
    // Issue 05: record the Leader's terminal receipt so the Scheduler can
    // suppress no-change `task-orphaned` wakes. The disposition and digest are
    // machine-derived from the post-yield projection; the Leader does not
    // need to cooperate for the admission check to work.
    if (role.name === LEADER_ROLE) {
      const receipt = leaderYieldReceipt(tx, task, terminal, now);
      if (receipt !== null) {
        tx.saveAgentRun(receipt);
        return {
          run: receipt,
          reviewDispatch,
          notifyLeader: leaderHandoff !== null
        };
      }
    }
    return {
      run: terminal,
      reviewDispatch,
      notifyLeader: leaderHandoff !== null
    };
  });
  if (yielded.notifyLeader) {
    notifyMailbox(options.runtime, leaderMailbox(yielded.run.taskId), yielded.run.taskId);
  }
  if (yielded.reviewDispatch?.run !== null
    && yielded.reviewDispatch?.run !== undefined) {
    notifyReviewMailbox(
      options,
      options.runtime,
      roleMailbox(
        yielded.reviewDispatch.run.taskId,
        yielded.reviewDispatch.run.roleName
      ),
      yielded.reviewDispatch.run.taskId
    );
  }
  return output(`Yielded ${yielded.run.id}: ${yielded.run.summary ?? inputSummary}\n`, {
    run: yielded.run,
    ...(yielded.reviewDispatch === null
      ? {}
      : { reviewRound: yielded.reviewDispatch.round })
  });
}

/**
 * Issue 05: compute the Leader Run terminal receipt (disposition + observed
 * actionability digest) from the post-yield projection. Returns the updated
 * Run, or null when the receipt cannot be computed (the caller keeps the
 * unmodified terminal Run in that case; the Scheduler fails open).
 */
function leaderYieldReceipt(
  tx: TaskWorkflowStore,
  task: Task,
  terminal: AgentRun,
  now: Date
): AgentRun | null {
  try {
    const projection = buildTaskExecutionProjection(tx, task.id, task);
    if (projection === null) return null;
    const disposition = deriveLeaderRunDisposition(projection.status, task.status);
    const digest = computeActionabilityDigest(
      collectTaskActionability(tx, task.id)
    );
    const waitReason = disposition === "waiting" || disposition === "blocked"
      ? leaderWaitReason(projection)
      : undefined;
    return {
      ...terminal,
      disposition,
      observedActionabilityDigest: digest,
      ...(waitReason === undefined ? {} : { waitReason }),
      updatedAt: now.toISOString()
    };
  } catch {
    return null;
  }
}

function leaderWaitReason(
  projection: import("../scheduler/taskExecutionProjection.js").TaskExecutionProjection
): import("../scheduler/actionability.js").LeaderWaitReason | undefined {
  const blocker = projection.blockers[0];
  if (blocker !== undefined) {
    return { kind: blocker.kind, ref: blocker.id };
  }
  if (projection.status === "waiting-on-agents") {
    return { kind: "delegated-work" };
  }
  if (projection.status === "waiting-user") {
    return { kind: "input" };
  }
  return undefined;
}

/**
 * Records a structured progress checkpoint for an active Run. This is a durable
 * run fact, not a Task Message: it advances the Run's durable-progress clock so
 * a healthy but long-running Run keeps proving it is alive without adding
 * collaboration-narrative noise. It never yields, mutates the Run, or wakes the
 * Leader.
 */
function checkpointRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task run checkpoint usage: yui task run checkpoint <run> (--note <text>|--note-file <path|->).";
  const parsed = parseTail(args, new Set(["--note", "--note-file"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const note = readCommandText(
    parsed.options.get("--note"),
    parsed.options.get("--note-file"),
    "--note",
    usage
  );
  const now = clock(options);
  const event = store.transaction((tx) => {
    const run = requireRun(tx, parsed.positionals[0], options);
    if (run.status !== "active") {
      throw usageError(`Run ${run.id} is already terminal: ${run.status}.`);
    }
    if (run.deliveredAt === undefined) {
      throw usageError(`Run ${run.id} delivery is still pending.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "checkpointing a run"));
    const pointer = activeRunPointer(tx, run);
    if (pointer?.id !== run.id) {
      throw usageError(`Run is not active for ${task.id}/${run.roleName}: ${run.id}.`);
    }
    const events = tx.listEvents(task.id);
    const recovered = isRoleRunStalled(events, run.id);
    const progress = recordTaskEventRecord(tx, task.id, RUN_PROGRESS_EVENT, {
      runId: run.id,
      note: truncateEventNote(note),
      ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId })
    }, now);
    if (recovered) {
      recordTaskEventRecord(tx, task.id, RUN_RECOVERED_EVENT, {
        runId: run.id,
        roleName: run.roleName,
        progressAt: now.toISOString(),
        kind: "checkpoint"
      }, now);
    }
    clearMatchingLeaderStallAttention(tx, task.id, run.id);
    return progress;
  });
  return `Checkpoint recorded for ${parsed.positionals[0]} (${event.id}).\n`;
}

export function queueReviewRound(
  store: TaskWorkflowStore,
  item: WorkItem,
  config: ReviewConfig,
  requestedBy: "policy" | "leader",
  now: Date
): Readonly<{ round: ReviewRound; run: AgentRun | null }> {
  const candidate = requireWorkItemCandidate(item);
  if (candidate.gitSnapshot === undefined) {
    throw usageError(`Candidate has no frozen managed Git snapshot: ${candidate.id}.`);
  }
  const pending = createReviewRound(
    store.nextReviewRoundId(item.taskId),
    item.taskId,
    item.id,
    candidate.id,
    config.roleName,
    requestedBy,
    candidate.gitSnapshot.reviewBaseCommit,
    now
  );
  store.saveReviewRound(item.taskId, pending);
  const producerRoleName = item.assignee
    ?? (candidate.source.type === "run"
      ? store.getAgentRun(item.taskId, candidate.source.runId)?.roleName
      : LEADER_ROLE);
  if (producerRoleName === config.roleName) {
    const failed = finishReviewRound(
      pending,
      "failed",
      `Reviewer Role must be separate from the Candidate producer: ${config.roleName}.`,
      now
    );
    store.saveReviewRound(item.taskId, failed);
    return { round: failed, run: null };
  }
  let reviewer = store.getRole(item.taskId, config.roleName);
  if (reviewer === null) {
    const globalRole = store.getGlobalRole(config.roleName);
    if (globalRole === null) {
      const failed = finishReviewRound(
        pending,
        "failed",
        `Global Role not found: ${config.roleName}.`,
        now
      );
      store.saveReviewRound(item.taskId, failed);
      return { round: failed, run: null };
    }
    const task = requireTask(store, item.taskId);
    reviewer = createTaskRole(store, task, config.roleName, undefined, now, config.roleName);
    store.saveRole(task.id, reviewer);
  }
  if (store.getActiveAgentRun(item.taskId, reviewer.name) !== null) {
    const failed = finishReviewRound(
      pending,
      "failed",
      `Reviewer Role already has an active run: ${reviewer.name}.`,
      now
    );
    store.saveReviewRound(item.taskId, failed);
    return { round: failed, run: null };
  }
  return { round: pending, run: null };
}

export function dispatchPreparedReviewRound(
  taskId: string,
  reviewRoundId: string,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): AgentRun {
  const now = clock(options);
  const runs = store.transaction((tx) => {
    const round = tx.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw usageError(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    if (round.status !== "pending" && round.status !== "running") {
      throw usageError(`ReviewRound is not dispatchable: ${round.id}/${round.status}.`);
    }
    if (round.workspace === undefined) {
      if ((round.scope ?? "work-item") === "task") {
        throw new TaskFinalReviewDispatchDriftError(
          `ReviewRound workspace is not ready: ${round.id}.`
        );
      }
      throw usageError(`ReviewRound workspace is not ready: ${round.id}.`);
    }
    const item = tx.getWorkItem(taskId, round.workItemId);
    if (item === null) throw dataError(`ReviewRound Work Item not found: ${round.workItemId}.`);
    const candidate = item.candidates.find(({ id }) => id === round.candidateId);
    if (candidate === undefined) {
      throw dataError(`ReviewRound Candidate not found: ${round.candidateId}.`);
    }
    const taskScope = (round.scope ?? "work-item") === "task";
    if (taskScope) {
      // A Task-scoped final ReviewRound freezes the integrated Task heads in
      // its taskCandidate. The WorkItem Candidate snapshot is irrelevant: the
      // authoritative review base is the first Project's committed head.
      if (round.taskCandidate === undefined) {
        throw new TaskFinalReviewDispatchDriftError(
          `Task ReviewRound ${round.id} has no frozen Task candidate.`
        );
      }
      if (round.taskCandidate.projects[0]!.commit !== round.reviewBaseCommit) {
        throw new TaskFinalReviewDispatchDriftError(
          `Task ReviewRound base does not match its frozen Task candidate: ${round.id}.`
        );
      }
    } else if (candidate.gitSnapshot?.reviewBaseCommit !== round.reviewBaseCommit) {
      throw usageError(`ReviewRound Candidate snapshot changed: ${round.id}.`);
    }
    const task = requireTask(tx, taskId);
    if ((round.scope ?? "work-item") === "task") {
      let taskFinalContract: TaskFinalReviewContract | undefined;
      try {
        taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
      } catch (error) {
        throw taskFinalReviewDispatchDrift(error);
      }
      if (!sameTaskFinalReviewContract(
        round.taskFinalReviewContract,
        taskFinalContract
      )) {
        throw new TaskFinalReviewDispatchDriftError(
          `Task final-review contract does not match ReviewRound ${round.id}.`
        );
      }
      if (taskFinalContract !== undefined
        && round.reviewerRoleName !== taskFinalContract.reviewerRoleName) {
        throw new TaskFinalReviewDispatchDriftError(
          `Task final-review Reviewer identity does not match ReviewRound ${round.id}.`
        );
      }
      if (round.status === "pending" && round.reviewerRunId !== undefined) {
        throw new TaskFinalReviewDispatchDriftError(
          `Pending final ReviewRound already records Reviewer Run ${round.reviewerRunId}: `
          + `${round.id}.`
        );
      }
      let currentTaskCandidate: TaskReviewCandidate;
      try {
        currentTaskCandidate = actualTaskReviewCandidateForMutation(
          tx,
          task,
          options
        );
      } catch (error) {
        throw taskFinalReviewDispatchDrift(error);
      }
      if (!isSameTaskReviewCandidate(round.taskCandidate, currentTaskCandidate)) {
        const frozenCommits = new Map(
          round.taskCandidate?.projects.map(({ projectId, commit }) => [projectId, commit]) ?? []
        );
        const committedIntegrationMoved = currentTaskCandidate.projects.some((project) => {
          const latest = latestCommittedIntegration(tx, task.id, project.projectId);
          return latest?.candidateCommit === project.commit
            && frozenCommits.get(project.projectId) !== project.commit;
        });
        throw new TaskFinalReviewDispatchDriftError(
          committedIntegrationMoved
            ? "Task-final ReviewRound frozen integrated heads changed for its Project set."
            : `Final ReviewRound ${round.id} freezes a candidate that is no longer `
              + "the current Task candidate."
        );
      }
    }
    const reviewer = tx.getRole(taskId, round.reviewerRoleName);
    if (reviewer === null) {
      if ((round.scope ?? "work-item") === "task") {
        throw new TaskFinalReviewDispatchDriftError(
          `Reviewer Role not found: ${taskId}/${round.reviewerRoleName}.`
        );
      }
      throw roleNotFound(round.reviewerRoleName);
    }
    if (tx.getActiveAgentRun(taskId, reviewer.name) !== null) {
      const message = `Reviewer Role already has an active run: ${reviewer.name}.`;
      if ((round.scope ?? "work-item") === "task") {
        throw new TaskFinalReviewDispatchDriftError(message);
      }
      throw usageError(message);
    }
    const storedWorkspace = tx.getReviewRoundWorkspace(taskId, round.id);
    if (storedWorkspace === null
      || !isDeepStrictEqual(storedWorkspace, round.workspace)
      || storedWorkspace.owner.type !== "review-round"
      || storedWorkspace.owner.reviewRoundId !== round.id) {
      const message = `ReviewRound workspace ownership changed: ${round.id}.`;
      if ((round.scope ?? "work-item") === "task") {
        throw new TaskFinalReviewDispatchDriftError(message);
      }
      throw usageError(message);
    }
    if (taskScope) {
      const conflicting = tx.listReviewRounds(task.id).find((entry) => (
        entry.id !== round.id
        && (entry.scope ?? "work-item") === "task"
        && (entry.status === "pending" || entry.status === "running")
        && !(entry.status === "running"
          && entry.reviewerRunId !== undefined
          && tx.getAgentRun(task.id, entry.reviewerRunId)?.status === "failed")
      ));
      if (conflicting !== undefined) {
        throw new TaskFinalReviewDispatchDriftError(
          `Another active Task-final ReviewRound already exists: ${conflicting.id}/${conflicting.reviewerRoleName}.`
        );
      }
      let provenance: TaskReviewProvenance;
      try {
        provenance = taskReviewProvenance(tx, task, options, round.taskCandidate!);
      } catch (error) {
        throw taskFinalReviewDispatchDrift(error);
      }
      const producerCollision = taskReviewProducerCollision(provenance, reviewer.name);
      if (producerCollision !== null) {
        throw new TaskFinalReviewDispatchDriftError(
          `Final Task Review cannot dispatch: ${producerCollision}`
        );
      }
      const frozenProjects = new Map(
        round.taskCandidate!.projects.map(({ projectId, commit }) => [projectId, commit])
      );
      if (frozenProjects.size !== task.projectBindings.length
        || task.projectBindings.some(({ projectId }) => !frozenProjects.has(projectId))
        || storedWorkspace.entries.length !== frozenProjects.size
        || storedWorkspace.entries.some((entry) => (
          entry.access !== "write"
          || frozenProjects.get(entry.projectId) !== entry.baseCommit
          || entry.baseRef !== entry.baseCommit
      ))) {
        throw new TaskFinalReviewDispatchDriftError(
          `Task ReviewRound frozen Project heads changed: ${round.id}.`
        );
      }
    }
    const candidateLabel = candidate.source.type === "run"
      ? `candidate Run ${candidate.source.runId}`
      : `revision ${candidate.workItemRevision}`;
    const frozenHeads = taskScope
      ? round.taskCandidate!.projects
        .map(({ projectId, commit }) => `${projectId}@${commit}`)
        .join(", ")
      : `candidate@${round.reviewBaseCommit}`;
    const findingContext = taskScope
      ? buildTaskFinalReviewFindingContext(tx, taskId, round.taskCandidate!).context
      : "";
    let deltaContext = "";
    if (taskScope && round.deltaRecheck !== undefined) {
      const previousRound = tx.getReviewRound(taskId, round.deltaRecheck.previousReviewRoundId);
      if (previousRound === null || previousRound.status !== "completed") {
        throw new TaskFinalReviewDispatchDriftError(
          `Delta-recheck previous ReviewRound is unavailable: ${round.deltaRecheck.previousReviewRoundId}.`
        );
      }
      const diffByProject = options.deltaRecheckDiff;
      if (diffByProject === undefined) {
        throw new TaskFinalReviewDispatchDriftError(
          `Delta-recheck diff is missing for ${round.id}; the CLI preflight did not run.`
        );
      }
      try {
        verifyDeltaRecheckDiff(round.deltaRecheck, diffByProject);
      } catch (error) {
        throw new TaskFinalReviewDispatchDriftError(
          `Delta-recheck diff verification failed for ${round.id}: `
          + `${error instanceof Error ? error.message : String(error)}`
        );
      }
      deltaContext = buildDeltaRecheckDispatchContext({
        round,
        previousRound,
        diffByProject,
        ledgerContext: findingContext
      });
    }
    const scopeLabel = taskScope ? "Task-final" : "WorkItem";
    const projectPolicyPointers = task.projectBindings
      .map(({ projectId }) => (
        `yui project show ${projectId}; yui project knowledge list ${projectId}`
      ))
      .join(" | ");
    const rawInput = [
      `Review ${scopeLabel} WorkItem ${item.id} ${candidateLabel}.`,
      `ReviewRound: ${round.id}`,
      `Review scope: ${taskScope ? "task" : "work-item"}`,
      `Review base commit: ${round.reviewBaseCommit}`,
      ...(taskScope
        ? [`Frozen integrated Task heads: ${frozenHeads}`]
        : [`Candidate snapshot base: ${round.reviewBaseCommit}`]),
      `Project Policy pointers: ${projectPolicyPointers || "none"}`,
      `Review workspace source: exact workspace attached to this Reviewer Lane`,
      `Candidate summary: ${candidate.summary}`,
      `Acceptance criteria: ${item.acceptance.length === 0 ? "none" : item.acceptance.join("; ")}`,
      ...(taskScope ? [deltaContext !== "" ? deltaContext : findingContext] : []),
      "Start from the user's core outcome and the WorkItem intent. The candidate summary is a pointer, not proof: inspect the complete relevant change, callers, and proportionate checks.",
      "Keep Yui Core lifecycle safety, generic Reviewer behavior, Project Policy/Knowledge, and the Task Contract separate. Follow Project Policy pointers from the dispatch context for project-specific checks.",
      ...(round.scope === "task" && round.deltaRecheck === undefined
        ? ["This is the one final Task Review: inspect every bound Project at the frozen integrated heads, and report only reachable, material, actionable P1/P2 findings or bounded verification gaps."]
        : []),
      "You may freely edit source/tests, run local build or test commands, and optionally commit diagnostic evidence only inside this ReviewRound-owned workspace.",
      "Do not push, integrate, mutate Task state, touch the Candidate or Worker workspace, another Task/workspace, a stable checkout, or the real Yui control-plane home.",
      "Use the exact --summary-file - body to report complete findings, evidence, checks actually run, uncertainty, and recommended next actions in clear Markdown or JSON. Yui preserves the full report; no fixed wording or field list is required. If you include evidenceCommit, it must match the managed Review workspace.",
      "Report reviewBaseCommit, exact checks/results, material findings, and uncertainty. Review yield completes only this Round and creates no Candidate or ChangeSet.",
      "The Leader alone interprets and routes evidence: original Worker when open, a small Repair WorkItem when needed, or Leader/Integration for merge and local fixes; never merge review evidence yourself."
    ].join("\n");
    const executionTarget = executionTargetForReviewRound(task, round, item, candidate);
    let runningGroup = round.executionGroup ?? createExecutionGroup(
      `execution-group-${round.id}`,
      taskId,
      {
        purpose: "review",
        target: executionTarget,
        strategy: { mode: "fixed", count: 1 },
        lanes: [{ roleName: reviewer.name, reviewRoundId: round.id }]
      },
      now
    );
    const dispatchLanes = runningGroup.lanes.filter((lane) => (
      lane.status === "pending" && lane.runId === undefined
    ));
    const laneRoles = dispatchLanes.map(({ roleName }) => roleName);
    const reviewers = laneRoles.map((roleName) => {
      const laneReviewer = tx.getRole(taskId, roleName);
      if (laneReviewer === null) {
        throw usageError(`Reviewer Role not found: ${taskId}/${roleName}.`);
      }
      if (tx.getActiveAgentRun(taskId, roleName) !== null) {
        throw usageError(`Reviewer Role already has an active run: ${roleName}.`);
      }
      return laneReviewer;
    });
    const createdRuns: AgentRun[] = [];
    for (let index = 0; index < reviewers.length; index += 1) {
      const lane = dispatchLanes[index]!;
      const laneReviewer = reviewers[index]!;
      const runId = tx.nextAgentRunId(taskId);
      const laneManagedWorkspace = runningGroup.lanes.length > 1 || runningGroup.strategy.mode === "adaptive"
        ? options.executionLaneWorkspaces?.get(lane.id)
        : round.workspace;
      if (laneManagedWorkspace === undefined && options.yuiHome !== undefined) {
        throw usageError(`Review Lane workspace preflight is missing: ${runningGroup.id}/${lane.id}.`);
      }
      const effective = resolveEffectiveLaunch({
        role: laneReviewer,
        purpose: "review",
        workspace: laneManagedWorkspace ?? round.workspace,
        reviewRoundId: round.id,
        reviewBaseCommit: round.reviewBaseCommit
      });
      const sessions = tx.getTaskRoleSessionSet(taskId, laneReviewer.name);
      const laneWorkspace = laneManagedWorkspace === undefined
        ? undefined
        : {
            root: laneManagedWorkspace.root,
            writableProjectIds: laneManagedWorkspace.entries
              .filter(({ access }) => access === "write")
              .map(({ projectId }) => projectId)
          };
      const assignment = createRunAssignment({
        runId,
        roleName: laneReviewer.name,
        purpose: "review",
        action: "review-round",
        subject: {
          taskId,
          workItemId: item.id,
          reviewRoundId: round.id,
          executionGroupId: runningGroup.id,
          executionLaneId: lane.id
        },
        directive: `${rawInput}\nFrozen target: ${runningGroup.target.fingerprint}.`,
        deltaRefIds: []
      });
      runningGroup = updateExecutionLane(runningGroup, lane.id, {
        status: "running",
        runId,
        reviewRoundId: round.id,
        effective,
        workspace: laneWorkspace
      }, now);
      createdRuns.push(createAgentRun(
        runId,
        taskId,
        laneReviewer.name,
        roleAgentSessionResumeMode(sessions, effective.agentId, effective),
        assignment,
        now,
        {
          workItemId: item.id,
          purpose: "review",
          reviewRoundId: round.id,
          executionGroupId: runningGroup.id,
          executionLaneId: lane.id,
          workspace: laneManagedWorkspace ?? round.workspace,
          effective
        }
      ));
    }
    const roundWithGroup = round.executionGroup === undefined
      ? attachReviewExecutionGroup(round, runningGroup)
      : updateReviewExecutionGroup(round, runningGroup);
    const persistedRound = round.status === "pending"
      ? startReviewRound(roundWithGroup, createdRuns[0]!.id)
      : roundWithGroup;
    // Save the aggregate before adopting prepared Lane workspaces.  The
    // managed-workspace validator deliberately requires durable Group/Lane
    // lineage, so a new Review Group cannot own a Lane until this write lands.
    tx.saveReviewRound(taskId, persistedRound);
    for (const lane of runningGroup.lanes) {
      const prepared = options.executionLaneWorkspaces?.get(lane.id);
      if (prepared !== undefined) {
        if (prepared.owner.type !== "execution-lane"
          || prepared.owner.executionGroupId !== runningGroup.id
          || prepared.owner.executionLaneId !== lane.id) {
          throw usageError(`Review Lane workspace identity does not match dispatch: ${runningGroup.id}/${lane.id}.`);
        }
        if (tx.getManagedWorkspace(prepared.owner) === null) tx.saveManagedWorkspace(prepared);
      }
    }
    for (let index = 0; index < createdRuns.length; index += 1) {
      const unboundRun = createdRuns[index]!;
      const snapshot = freezeRunContextSnapshot(tx, {
        taskId,
        roleName: unboundRun.roleName,
        purpose: "review",
        workItemId: item.id,
        reviewRoundId: round.id
      }, now);
      const created = withAgentRunContextSnapshot(
        unboundRun,
        contextSnapshotRef(snapshot),
        contextSnapshotDeltaRefIds(tx, snapshot)
      );
      createdRuns[index] = created;
      const laneReviewer = reviewers[index]!;
      tx.saveAgentRun(created);
      tx.saveActiveAgentRun(created);
      tx.saveRole(taskId, updateRoleStatus(laneReviewer, "running", now));
      enqueueWork(tx, roleMailbox(taskId, laneReviewer.name), "review-requested", now, [
        runRef(taskId, created.id),
        workItemRef(taskId, item.id)
      ]);
      recordTaskEvent(tx, taskId, "run.review-dispatched", runLaunchEventPayload(created), now);
    }
    return createdRuns;
  });
  for (const run of runs) {
    notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName), run.taskId);
  }
  return runs[0]!;
}

export function failPendingReviewRound(
  taskId: string,
  reviewRoundId: string,
  summary: string,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): ReviewRound {
  const now = clock(options);
  const failed = store.transaction((tx) => {
    const round = tx.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw usageError(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    if (round.status !== "pending") return round;
    const terminal = finishReviewRound(round, "failed", summary, now);
    tx.saveReviewRound(taskId, terminal);
    enqueueWork(tx, leaderMailbox(taskId), "review-failed", now, [
      workItemRef(taskId, round.workItemId)
    ]);
    return terminal;
  });
  notifyMailbox(options.runtime, leaderMailbox(taskId), taskId);
  return failed;
}

export function preserveReviewRoundWorkspace(
  taskId: string,
  reviewRoundId: string,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): ReviewRound {
  return store.transaction((tx) => {
    const round = tx.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw usageError(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    const preserved = recordReviewWorkspaceDisposition(
      round,
      "preserved",
      clock(options)
    );
    tx.saveReviewRound(taskId, preserved);
    return preserved;
  });
}

function requireWorkItemCandidate(item: WorkItem): WorkItemCandidate {
  const candidate = currentWorkItemCandidate(item);
  if (candidate === undefined) {
    throw dataError(`Work Item has no submitted candidate: ${item.id}.`);
  }
  return candidate;
}

/** ReviewRound ids are the durable Task-local creation order; wall time is not causal. */
function reviewRoundsByIdentity(rounds: ReviewRound[]): ReviewRound[] {
  return [...rounds].sort((left, right) => (
    left.id.localeCompare(right.id, undefined, { numeric: true })
  ));
}

function activeReviewRoundForCandidate(
  store: TaskWorkflowStore,
  item: WorkItem,
  candidate: WorkItemCandidate
): ReviewRound | undefined {
  return reviewRoundsByIdentity(store.listReviewRounds(item.taskId)
    .filter((round) => round.workItemId === item.id
      && round.candidateId === candidate.id
      && (round.status === "pending" || round.status === "running")))
    .at(-1);
}

function createTaskRole(
  store: TaskWorkflowStore,
  task: Task,
  roleName: string,
  explicitAgentId: string | undefined,
  now: Date,
  sourceGlobalRoleName?: string
): Role {
  const workspace = task.cwd ?? store.getConfig().defaultWorkspace ?? process.cwd();
  if (explicitAgentId === undefined) {
    const sourceRoleName = sourceGlobalRoleName
      ?? (roleName === LEADER_ROLE ? LEADER_ROLE : "worker");
    const globalRole = store.getGlobalRole(sourceRoleName);
    if (globalRole !== null) {
      const copied = copyGlobalRoleToTaskRole(globalRole, task.id, now, roleName);
      return copied.workspace === workspace ? copied : updateRole(copied, { workspace }, now);
    }
    if (roleName !== LEADER_ROLE) {
      throw dataError(`Global Role ${sourceRoleName} is not configured for Task role: ${roleName}.`);
    }
  }
  const agentId = explicitAgentId?.trim() || store.getConfig().defaultAgent;
  if (agentId === undefined) {
    throw dataError(`No Agent is configured for Task role: ${roleName}.`);
  }
  const agent = requireAgent(store, agentId);
  const binding = createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
  return createRole(task.id, roleName, [binding], agent.id, workspace, now);
}

function requireAgentProfile(store: TaskWorkflowStore, id: string): AgentProfile {
  const profile = store.getAgentProfile(id);
  if (profile === null) throw usageError(`Agent Profile not found: ${id}.`);
  return profile;
}

function workerProfileRolePatch(profile: AgentProfile) {
  return {
    defaultAccess: profile.defaultAccess,
    description: profile.description,
    systemPrompt: profile.instructions,
    skills: profile.skills === undefined ? undefined : [...profile.skills],
    constraints: profile.defaultAccess === "read"
      ? ["Do not modify files or external state."]
      : undefined
  };
}

function appendMessage(
  store: TaskWorkflowStore,
  taskId: string,
  body: string,
  kind: TaskMessageKind,
  author: TaskMessageAuthor,
  now: Date,
  context: TaskMessageContext = {}
): TaskMessage {
  const message = createTaskMessage(
    store.nextMessageId(taskId), taskId, body, kind, author, now, context
  );
  store.saveMessage(taskId, message);
  recordTaskEvent(store, taskId, "message.sent", {
    messageId: message.id,
    kind: message.kind,
    ...(message.runId === undefined ? {} : { runId: message.runId })
  }, now);
  return message;
}

function recordTaskEvent(
  store: TaskWorkflowStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): void {
  recordTaskEventRecord(store, taskId, type, payload, now);
}

function leaderActionEventPayload(
  store: TaskWorkflowStore,
  taskId: string,
  options: TaskCommandOptions
): TaskEventPayload {
  const runId = taskLeaderActionRunId(
    store,
    taskId,
    options.environment,
    options.yuiHome
  );
  return runId === undefined ? {} : { leaderRunId: runId };
}

function recordTaskEventRecord(
  store: TaskWorkflowStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): TaskEvent {
  const event = createTaskEvent(store.nextEventId(taskId), taskId, type, payload, now);
  store.saveEvent(taskId, event);
  return event;
}

function publishedTreeAuthorizationPayload(
  actor: Exclude<TaskCompletedBy, "leader">,
  proof: TaskCompletionPublishedTreeProof
): TaskEventPayload {
  return {
    by: actor,
    projectId: proof.projectId,
    publicationId: proof.publicationId,
    reviewRoundId: proof.reviewRoundId,
    localCommit: proof.localCommit,
    remoteCommit: proof.remoteCommit,
    tree: proof.tree
  };
}

function matchingPublishedTreeAuthorization(
  store: TaskWorkflowStore,
  proof: TaskCompletionPublishedTreeProof
): TaskEvent | undefined {
  const events = store.listEvents(proof.taskId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "task.completed" || event.type === "task.reopened") return undefined;
    if (event.type === TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT
      && (event.payload.by === "user" || event.payload.by === "operator")
      && event.payload.projectId === proof.projectId
      && event.payload.publicationId === proof.publicationId
      && event.payload.reviewRoundId === proof.reviewRoundId
      && event.payload.localCommit === proof.localCommit
      && event.payload.remoteCommit === proof.remoteCommit
      && event.payload.tree === proof.tree) {
      return event;
    }
  }
  return undefined;
}

function requirePublishedTreeAuthorization(
  store: TaskWorkflowStore,
  proof: TaskCompletionPublishedTreeProof
): TaskEvent {
  const authorization = matchingPublishedTreeAuthorization(store, proof);
  if (authorization === undefined) {
    throw usageError(
      `Published-tree completion requires explicit user or global Operator authorization for `
      + `${proof.taskId}/${proof.publicationId} at Task-final Review ${proof.reviewRoundId}.`
    );
  }
  return authorization;
}

/** Keeps a free-text run-fact note bounded so an event payload stays compact. */
function truncateEventNote(note: string): string {
  const normalized = note.trim();
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 279)}…`;
}

function roleLaunchEventPayload(
  role: Role,
  sessions: TaskRoleSessionSet | null
): TaskEventPayload {
  const effective = sessions?.sessions[sessions.activeAgentId]?.effective;
  return {
    desiredRevision: String(role.launchRevision),
    defaultAccess: role.defaultAccess,
    effectiveRevision: effective === undefined
      ? "none"
      : String(effective.sourceDesiredRevision),
    profileAccess: effective?.profileAccess ?? "none",
    effectivePermission: effective?.permission.strategy ?? "none",
    desiredDrift: effective === undefined
      ? "not-started"
      : effective.sourceDesiredRevision === role.launchRevision
        ? "none"
        : "pending-next-launch"
  };
}

function runLaunchEventPayload(run: AgentRun): TaskEventPayload {
  return {
    runId: run.id,
    role: run.roleName,
    purpose: run.purpose,
    mode: run.mode,
    agent: `${run.effective.agentId}/${run.effective.adapterId}`,
    effectiveRevision: String(run.effective.sourceDesiredRevision),
    profileAccess: run.effective.profileAccess,
    effectivePermission: run.effective.permission.strategy,
    writeProjectIds: run.effective.writeProjectIds.join(",") || "none",
    ...(run.executionGroupId === undefined
      ? {}
      : {
          executionGroupId: run.executionGroupId,
          executionLaneId: run.executionLaneId!
        }),
    ...(run.reviewRoundId === undefined
      ? {}
      : {
          reviewRoundId: run.reviewRoundId,
          reviewBaseCommit: run.effective.reviewBaseCommit ?? "none"
        })
  };
}

function requireTask(store: TaskWorkflowStore, taskId: string | undefined): Task {
  const id = requiredText(taskId, "Task id");
  const task = store.getTask(id);
  if (task === null) throw taskNotFound(id);
  return task;
}

function requireRole(store: TaskWorkflowStore, taskId: string, roleName: string | undefined): Role {
  const name = requiredText(roleName, "Role name");
  const role = store.getRole(taskId, name);
  if (role === null) throw roleNotFound(name);
  return role;
}

function requireProject(store: TaskWorkflowStore, projectId: string): Project {
  const project = store.getProject(projectId);
  if (project === null) throw usageError(`Project not found: ${projectId}.`);
  return project;
}

function requireAgent(store: TaskWorkflowStore, agentId: string | undefined): ConfiguredAgent {
  const id = requiredText(agentId, "Agent id");
  const agent = store.getConfiguredAgent(id);
  if (agent === null) throw usageError(`Agent not found: ${id}.`);
  return agent;
}

function requireWorkItem(
  store: TaskWorkflowStore,
  workItemId: string | undefined,
  options: TaskCommandOptions
): WorkItem {
  const reference = taskRecordReference(
    workItemId,
    "workItem",
    "Work Item reference",
    options
  );
  const item = store.getWorkItem(reference.taskId, reference.localId);
  if (item === null) {
    throw usageError(`Work Item not found: ${reference.taskId}/${reference.localId}.`);
  }
  return item;
}

function requireRun(
  store: TaskWorkflowStore,
  runId: string | undefined,
  options: TaskCommandOptions
): AgentRun {
  const reference = taskRecordReference(
    runId,
    "agentRun",
    "Agent Run reference",
    options
  );
  const run = store.getAgentRun(reference.taskId, reference.localId);
  if (run === null) {
    throw usageError(`Agent Run not found: ${reference.taskId}/${reference.localId}.`);
  }
  return run;
}

function activeRunPointer(store: TaskWorkflowStore, run: AgentRun): AgentRun | null {
  return run.executionGroupId !== undefined && run.executionLaneId !== undefined
    ? store.getActiveExecutionLaneRun(
      run.taskId,
      run.executionGroupId,
      run.executionLaneId
    )
    : store.getActiveAgentRun(run.taskId, run.roleName);
}

function requireReviewRound(
  store: TaskWorkflowStore,
  reviewRoundId: string | undefined,
  options: TaskCommandOptions
): ReviewRound {
  const reference = taskRecordReference(
    reviewRoundId,
    "reviewRound",
    "ReviewRound reference",
    options
  );
  const round = store.getReviewRound(reference.taskId, reference.localId);
  if (round === null) {
    throw usageError(`ReviewRound not found: ${reference.taskId}/${reference.localId}.`);
  }
  return round;
}

function taskRecordReference(
  value: string | undefined,
  kind: "workItem" | "agentRun" | "reviewRound",
  label: string,
  options: TaskCommandOptions
) {
  try {
    return resolveTaskRecordReference(requiredText(value, label), {
      kind,
      label,
      ...(options.environment?.YUI_TASK_ID === undefined
        ? {}
        : { contextTaskId: options.environment.YUI_TASK_ID })
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

function assertWorkItemDependenciesCompleted(
  store: TaskWorkflowStore,
  item: WorkItem
): void {
  for (const dependencyId of item.dependsOn) {
    const dependency = store.getWorkItem(item.taskId, dependencyId);
    if (dependency === null || dependency.status !== "completed") {
      throw usageError(`Work Item dependency is not completed: ${dependencyId}.`);
    }
  }
}

function chronologicalAgentRuns(runs: readonly AgentRun[]): AgentRun[] {
  return [...runs].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
  ));
}

function isTerminalWorkItemStatus(status: WorkItemStatus): boolean {
  return ["completed", "failed", "retired"].includes(status);
}

function assertTaskOpen(task: Task): void {
  if (task.status === "completed") {
    throw usageError(`Task ${task.id} is completed; reopen it before continuing.`);
  }
  if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
  if (task.status === "retired") throw usageError(`Task is retired: ${task.id}.`);
}

function taskActor(options: TaskCommandOptions, taskId: string) {
  return resolveTaskActor(options.environment, taskId);
}

function inactiveTaskMessage(task: Task, action: string): string {
  if (task.status === "draft") {
    return `Task ${task.id} is a Draft; activate it before ${action}.`;
  }
  if (task.status === "completed") {
    return `Task ${task.id} is completed; reopen it before ${action}.`;
  }
  if (task.status === "retired") return `Task ${task.id} is retired; it cannot resume ${action}.`;
  return `Task is archived: ${task.id}.`;
}

function requireRuntime(options: TaskCommandOptions): TaskWorkflowRuntimePort {
  if (options.runtime === undefined) throw runtimeError("Task workflow runtime is not configured.");
  return options.runtime;
}

function parseWorkStatus(value: string): WorkItemStatus {
  if (value === "todo") return "pending";
  if (value === "running") return "running";
  if (value === "done") return "completed";
  if (value === "failed") return "failed";
  throw usageError(`Invalid work item status: ${value}.`);
}

function parseRecoveryAction(
  value: string | undefined,
  usage: string
): ExactAgentRunRecoveryAction {
  if (
    value === "diagnose"
    || value === "retry"
    || value === "replace-session"
    || value === "terminate"
  ) return value;
  throw usageError("--action must be diagnose, retry, replace-session, or terminate.", usage);
}

function parseProviderAcceptance(
  value: string | undefined,
  usage: string
): "accepted" | "rejected" | "ambiguous" {
  if (value === "accepted" || value === "rejected" || value === "ambiguous") return value;
  throw usageError("--provider-acceptance must be accepted, rejected, or ambiguous.", usage);
}

function presentWorkStatus(status: WorkItemStatus): string {
  if (status === "pending") return "todo";
  if (status === "completed") return "done";
  return status;
}

function parseWorkCreateArgs(
  args: readonly string[],
  usage: string
): Readonly<{
  positionals: string[];
  objective?: string;
  acceptance: string[];
  after: string[];
  projects: string[];
  baseRefs: Array<Readonly<{ project: string; baseRef: string }>>;
  role?: string;
}> {
  const positionals: string[] = [];
  const acceptance: string[] = [];
  const after: string[] = [];
  const projects: string[] = [];
  const baseRefs: Array<Readonly<{ project: string; baseRef: string }>> = [];
  let objective: string | undefined;
  let role: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (
      argument !== "--objective"
      && argument !== "--accept"
      && argument !== "--after"
      && argument !== "--project"
      && argument !== "--base-ref"
      && argument !== "--role"
    ) {
      throw usageError(`Unsupported option: ${argument}.`, usage);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`${argument} is required.`, usage);
    }
    if (argument === "--objective") {
      if (objective !== undefined) throw usageError("--objective may only be specified once.", usage);
      objective = value;
    } else if (argument === "--role") {
      if (role !== undefined) throw usageError("--role may only be specified once.", usage);
      role = value;
    } else if (argument === "--accept") acceptance.push(value);
    else if (argument === "--after") after.push(value);
    else if (argument === "--project") projects.push(value);
    else {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw usageError(
          "--base-ref must use <project>=<ref>.",
          usage
        );
      }
      baseRefs.push({
        project: value.slice(0, separator),
        baseRef: value.slice(separator + 1)
      });
    }
    index += 1;
  }
  return {
    positionals,
    ...(objective === undefined ? {} : { objective }),
    ...(role === undefined ? {} : { role }),
    acceptance,
    after,
    projects,
    baseRefs
  };
}

function parseTaskPriority(value: string): TaskPriority {
  if (["low", "medium", "high", "urgent"].includes(value)) return value as TaskPriority;
  throw usageError(`Invalid Task priority: ${value}.`);
}

function parseTaskTags(value: string): string[] {
  const tags = [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length === 0) throw usageError("--tags must contain at least one tag.");
  return tags;
}

function parseIsoTimestamp(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw usageError(`${label} must be an ISO/RFC 3339 timestamp with a timezone.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw usageError(`${label} must be an ISO/RFC 3339 timestamp with a timezone.`);
  }
  return timestamp.toISOString();
}

function taskBriefCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "show") {
    exactPositionals(rest, 1, "Task brief show usage: yui task brief show <task>.");
    const task = requireTask(store, rest[0]);
    const brief = store.getTaskBrief(task.id);
    if (brief === null) {
      return output(`Task ${task.id} has no brief.\n`, { taskId: task.id, brief: null });
    }
    const timeZone = store.getConfig().timeZone;
    return output([
      `Task: ${task.id}`,
      `Objective: ${brief.objective}`,
      `Boundaries:`,
      ...(brief.boundaries.length === 0 ? ["  (none)"] : brief.boundaries.map((b) => `  - ${b}`)),
      `Technical approach: ${brief.technicalApproach || "(not defined)"}`,
      `Current focus: ${brief.currentFocus}`,
      `Leader summary: ${brief.leaderSummary}`,
      `Updated by: ${brief.updatedBy}`,
      `Updated at: ${presentTime(brief.updatedAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, brief });
  }
  if (command === "update") {
    const usage = "Task brief update usage: yui task brief update <task> [--objective <text>] [--boundary <text> ...] [--approach <text>] [--focus <text>] [--leader-summary <text>].";
    const parsed = parseMultiValueTail(
      rest,
      new Set(["--objective", "--approach", "--focus", "--leader-summary"]),
      new Set(["--boundary"]),
      usage
    );
    exactPositionals(parsed.positionals, 1, usage);
    const hasObjective = parsed.options.has("--objective");
    const hasApproach = parsed.options.has("--approach");
    const hasFocus = parsed.options.has("--focus");
    const hasSummary = parsed.options.has("--leader-summary");
    const boundaries = parsed.multiOptions.get("--boundary") ?? [];
    if (!hasObjective && !hasApproach && !hasFocus && !hasSummary && boundaries.length === 0) {
      throw usageError("At least one brief field is required.", usage);
    }
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const existing = tx.getTaskBrief(task.id);
      const updatedBy = taskActor(options, task.id);
      const brief = existing === null
        ? createTaskBrief({
            objective: requiredText(parsed.options.get("--objective"), "--objective"),
            boundaries,
            ...(hasApproach
              ? { technicalApproach: requiredText(
                  parsed.options.get("--approach"),
                  "--approach"
                ) }
              : {}),
            currentFocus: requiredText(parsed.options.get("--focus"), "--focus"),
            leaderSummary: requiredText(parsed.options.get("--leader-summary"), "--leader-summary"),
            updatedBy
          }, now)
        : updateTaskBrief(existing, {
            ...(hasObjective ? { objective: parsed.options.get("--objective") } : {}),
            ...(boundaries.length > 0 ? { boundaries } : {}),
            ...(hasApproach
              ? { technicalApproach: parsed.options.get("--approach") }
              : {}),
            ...(hasFocus ? { currentFocus: parsed.options.get("--focus") } : {}),
            ...(hasSummary ? { leaderSummary: parsed.options.get("--leader-summary") } : {})
          }, updatedBy, now);
      tx.saveTaskBrief(task.id, brief);
      recordTaskEvent(tx, task.id, "brief.updated", { updatedBy }, now);
      enqueueWork(tx, taskMailbox(task.id), "brief-updated", now, [taskRef(task.id)]);
      if (task.status === "active" && updatedBy !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "brief-updated", now, [taskRef(task.id)]);
      }
      return { task, brief };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") {
      notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    }
    return output(`Updated brief for ${result.task.id}\n`);
  }
  throw usageError(command === undefined
    ? "Task brief command is required."
    : `Unknown command: task brief ${command}`);
}

function taskDecisionCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "record") {
    const usage = "Task decision record usage: yui task decision record <task> --title <text> --rationale <text>.";
    const parsed = parseTail(rest, new Set(["--title", "--rationale"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const title = requiredOption(parsed.options, "--title");
    const rationale = requiredOption(parsed.options, "--rationale");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(options, task.id);
      const decision = createDecision(tx.nextDecisionId(task.id), task.id, title, rationale, now);
      tx.saveDecision(task.id, decision);
      recordTaskEvent(tx, task.id, "decision.recorded", {
        decisionId: decision.id,
        title,
        ...leaderActionEventPayload(tx, task.id, options)
      }, now);
      enqueueWork(tx, taskMailbox(task.id), "decision-recorded", now, [taskRef(task.id)]);
      if (task.status === "active" && actor !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "decision-recorded", now, [taskRef(task.id)]);
      }
      return { task, decision };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    return output(`Recorded decision ${result.decision.id} for ${result.task.id}\n`);
  }
  if (command === "list") {
    const usage = "Task decision list usage: yui task decision list <task> [--status active|superseded].";
    const parsed = parseTail(rest, new Set(["--status"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const task = requireTask(store, parsed.positionals[0]);
    let decisions = store.listDecisions(task.id);
    const status = parsed.options.get("--status");
    if (status !== undefined) {
      if (status !== "active" && status !== "superseded") {
        throw usageError("--status must be active or superseded.", usage);
      }
      decisions = decisions.filter((d) => d.status === status);
    }
    if (decisions.length === 0) {
      return output(`No decisions found for ${task.id}.\n`, { taskId: task.id, decisions: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Decisions: ${task.id}`,
      [
        { header: "Decision", minWidth: 8, maxWidth: 18 },
        { header: "Status", minWidth: 6, maxWidth: 12 },
        { header: "Title", minWidth: 8, maxWidth: 64 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      decisions.map((d) => [d.id, d.status, d.title, presentTime(d.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, decisions });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task decision show usage: yui task decision show <task> <decision>.");
    const task = requireTask(store, rest[0]);
    const decision = store.getDecision(task.id, rest[1]);
    if (decision === null) throw dataError(`Decision not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Decision: ${decision.id}`,
      `Task: ${task.id}`,
      `Title: ${decision.title}`,
      `Rationale: ${decision.rationale}`,
      `Status: ${decision.status}`,
      ...(decision.supersededReason === undefined ? [] : [`Superseded reason: ${decision.supersededReason}`]),
      ...(decision.supersededAt === undefined ? [] : [`Superseded at: ${presentTime(decision.supersededAt, timeZone)}`]),
      `Created: ${presentTime(decision.createdAt, timeZone)}`,
      `Updated: ${presentTime(decision.updatedAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, decision });
  }
  if (command === "supersede") {
    const usage = "Task decision supersede usage: yui task decision supersede <task> <decision> --reason <text>.";
    const parsed = parseTail(rest, new Set(["--reason"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const reason = requiredOption(parsed.options, "--reason");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(options, task.id);
      const existing = tx.getDecision(task.id, parsed.positionals[1]);
      if (existing === null) throw dataError(`Decision not found: ${parsed.positionals[1]}.`);
      const decision = supersedeDecision(existing, reason, now);
      tx.saveDecision(task.id, decision);
      recordTaskEvent(tx, task.id, "decision.superseded", {
        decisionId: decision.id,
        reason,
        ...leaderActionEventPayload(tx, task.id, options)
      }, now);
      enqueueWork(tx, taskMailbox(task.id), "decision-superseded", now, [taskRef(task.id)]);
      if (task.status === "active" && actor !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "decision-superseded", now, [taskRef(task.id)]);
      }
      return { task, decision };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    return output(`Superseded decision ${result.decision.id} for ${result.task.id}\n`);
  }
  throw usageError(command === undefined
    ? "Task decision command is required."
    : `Unknown command: task decision ${command}`);
}

function taskMilestoneCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "add") {
    const usage = "Task milestone add usage: yui task milestone add <task> --title <text> --summary <text>.";
    const parsed = parseTail(rest, new Set(["--title", "--summary"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const title = requiredOption(parsed.options, "--title");
    const summary = requiredOption(parsed.options, "--summary");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      if (taskActor(options, task.id) !== "leader") {
        throw usageError("Only the Task Leader can add a Milestone.");
      }
      const milestone = createMilestone(tx.nextMilestoneId(task.id), task.id, title, summary, now);
      tx.saveMilestone(task.id, milestone);
      recordTaskEvent(tx, task.id, "milestone.added", {
        milestoneId: milestone.id,
        title,
        ...leaderActionEventPayload(tx, task.id, options)
      }, now);
      enqueueWork(tx, taskMailbox(task.id), "milestone-added", now, [taskRef(task.id)]);
      return { task, milestone };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    return output(`Added milestone ${result.milestone.id} for ${result.task.id}\n`);
  }
  if (command === "list") {
    exactPositionals(rest, 1, "Task milestone list usage: yui task milestone list <task>.");
    const task = requireTask(store, rest[0]);
    const milestones = store.listMilestones(task.id);
    if (milestones.length === 0) {
      return output(`No milestones found for ${task.id}.\n`, { taskId: task.id, milestones: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Milestones: ${task.id}`,
      [
        { header: "Milestone", minWidth: 9, maxWidth: 18 },
        { header: "Title", minWidth: 8, maxWidth: 64 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      milestones.map((m) => [m.id, m.title, presentTime(m.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, milestones });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task milestone show usage: yui task milestone show <task> <milestone>.");
    const task = requireTask(store, rest[0]);
    const milestone = store.getMilestone(task.id, rest[1]);
    if (milestone === null) throw dataError(`Milestone not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Milestone: ${milestone.id}`,
      `Task: ${task.id}`,
      `Title: ${milestone.title}`,
      `Summary: ${milestone.summary}`,
      `Created by: ${milestone.createdBy}`,
      `Created: ${presentTime(milestone.createdAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, milestone });
  }
  throw usageError(command === undefined
    ? "Task milestone command is required."
    : `Unknown command: task milestone ${command}`);
}

function taskEventCommand(
  args: string[],
  store: TaskWorkflowStore
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") {
    const eventListUsage = "Task event list usage: yui task event list <task> [--after <timestamp>] [--limit <n>].";
    const parsed = parseTail(rest, new Set(["--after", "--limit"]), eventListUsage);
    exactPositionals(parsed.positionals, 1, eventListUsage);
    const task = requireTask(store, parsed.positionals[0]);
    let events = store.listEvents(task.id);
    const after = optionalNonEmptyOption(parsed.options, "--after");
    if (after !== undefined) {
      const afterMs = Date.parse(after);
      if (!Number.isFinite(afterMs)) throw usageError("--after must be a valid timestamp.", eventListUsage);
      events = events.filter((e) => Date.parse(e.createdAt) > afterMs);
    }
    const limit = optionalNonEmptyOption(parsed.options, "--limit");
    if (limit !== undefined) {
      const n = Number(limit);
      if (!Number.isSafeInteger(n) || n <= 0) throw usageError("--limit must be a positive integer.", eventListUsage);
      events = events.slice(-n);
    }
    if (events.length === 0) {
      return output(`No events found for ${task.id}.\n`, { taskId: task.id, events: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Events: ${task.id}`,
      [
        { header: "Event", minWidth: 8, maxWidth: 18 },
        { header: "Type", minWidth: 8, maxWidth: 28 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      events.map((e) => [e.id, e.type, presentTime(e.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, events });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task event show usage: yui task event show <task> <event>.");
    const task = requireTask(store, rest[0]);
    const events = store.listEvents(task.id);
    const event = events.find((e) => e.id === rest[1]) ?? null;
    if (event === null) throw dataError(`Event not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Event: ${event.id}`,
      `Task: ${task.id}`,
      `Type: ${event.type}`,
      `Created: ${presentTime(event.createdAt, timeZone)}`,
      `Payload:`,
      ...(Object.keys(event.payload).length === 0
        ? ["  (none)"]
        : Object.entries(event.payload).map(([k, v]) => `  ${k}: ${v}`))
    ].join("\n").concat("\n"), { taskId: task.id, event });
  }
  throw usageError(command === undefined
    ? "Task event command is required."
    : `Unknown command: task event ${command}`);
}

/**
 * Issue 13: native child durability visibility. A native Provider subagent is
 * best-effort until Yui persists its result content; once a continuation
 * report carries a result digest receipt the child is durable-result and its
 * full content stays readable through the referenced Task event.
 */
function taskContinuationCommand(
  args: string[],
  store: TaskWorkflowStore
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command !== "list") {
    throw usageError(command === undefined
      ? "Task continuation command is required."
      : `Unknown command: task continuation ${command}`);
  }
  const usage = "Task continuation list usage: yui task continuation list <task> [--json].";
  const asJson = rest.includes("--json");
  const positionals = rest.filter((arg) => arg !== "--json");
  exactPositionals(positionals, 1, usage);
  const task = requireTask(store, positionals[0]);
  const events = store.listEvents(task.id);
  const continuations = projectProviderContinuations(events);
  const reportEvents = continuationReportEvents(events);
  const rows = continuations.map((continuation) => {
    const identity = continuation.identity;
    const report = [...continuation.reports].reverse()[0];
    const reportEvent = report === undefined
      ? undefined
      : reportEvents.find((entry) => (
        entry.continuationId === identity.continuationId
        && entry.continuationGeneration === identity.generation
        && entry.reportId === report.reportId
      ));
    return Object.freeze({
      continuationId: identity.continuationId,
      generation: identity.generation,
      driver: identity.providerNamespace,
      runId: continuation.runId,
      execution: continuation.execution,
      outcome: continuation.outcome,
      attachment: continuation.attachment,
      durability: continuation.durability,
      ...(report?.resultDigest === undefined
        ? {}
        : { resultDigest: report.resultDigest }),
      ...(report?.resultSize === undefined
        ? {}
        : { resultSize: report.resultSize }),
      ...(reportEvent === undefined ? {} : { resultEvent: reportEvent.event.id }),
      ...(continuation.settledAt === undefined ? {} : { settledAt: continuation.settledAt })
    });
  });
  if (asJson) {
    return output(`${JSON.stringify({ taskId: task.id, continuations: rows }, null, 2)}\n`,
      { taskId: task.id, continuations: rows });
  }
  if (rows.length === 0) {
    return output(`No native child continuations found for ${task.id}.\n`,
      { taskId: task.id, continuations: rows });
  }
  const timeZone = store.getConfig().timeZone;
  return output(`${renderTable(
    `Native child continuations: ${task.id}`,
    [
      { header: "Child", minWidth: 8, maxWidth: 24 },
      { header: "Driver", minWidth: 8, maxWidth: 24 },
      { header: "Execution", minWidth: 8, maxWidth: 12 },
      { header: "Outcome", minWidth: 8, maxWidth: 12 },
      { header: "Durability", minWidth: 10, maxWidth: 16 },
      { header: "Result", minWidth: 8, maxWidth: 24 },
      { header: "Settled", minWidth: 10, maxWidth: 28 }
    ],
    rows.map((row) => [
      row.continuationId,
      row.driver,
      row.execution,
      row.outcome,
      row.durability,
      row.resultEvent ?? (row.resultDigest === undefined ? "-" : `digest:${row.resultDigest.slice(0, 12)}`),
      ...(row.settledAt === undefined ? ["-"] : [presentTime(row.settledAt, timeZone)])
    ]),
    defaultTableWidth()
  )}\n`, { taskId: task.id, continuations: rows });
}

function continuationReportEvents(
  events: readonly TaskEvent[]
): readonly Readonly<{
  event: TaskEvent;
  continuationId: string;
  continuationGeneration: number;
  reportId: string;
}>[] {
  const result: {
    event: TaskEvent;
    continuationId: string;
    continuationGeneration: number;
    reportId: string;
  }[] = [];
  for (const event of events) {
    const observation = runtimeObservationFromTaskEvent(event);
    if (observation !== null && observation.kind === "continuation.reported") {
      const continuationId = observation.fence.continuationId;
      const continuationGeneration = observation.fence.continuationGeneration;
      const reportId = observation.payload?.reportId;
      if (continuationId !== undefined
        && continuationGeneration !== undefined
        && reportId !== undefined) {
        result.push({ event, continuationId, continuationGeneration, reportId });
      }
    }
  }
  return result;
}

/**
 * Issue 04 (long-term): the durable wake ledger. `wake list` shows the
 * dispatch history; `wake show` returns the structured delta content for one
 * wake — the on-demand read the Agent uses instead of a context dump in the
 * wake envelope.
 */
function taskWakeDispatch(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [subcommand] = args;
  if (subcommand === "list" || subcommand === "show") {
    return taskWakeInspectionCommand(args, store);
  }
  return output(taskWakeForceCommand(args, store, options));
}

/**
 * Issue 04 (long-term): the durable wake ledger. `wake list` shows the
 * dispatch history; `wake show` returns the structured delta content for one
 * wake — the on-demand read the Agent uses instead of a context dump in the
 * wake envelope.
 */
function taskWakeInspectionCommand(
  args: string[],
  store: TaskWorkflowStore
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") {
    const usage = "Task wake list usage: yui task wake list <task>.";
    exactPositionals(rest, 1, usage);
    const task = requireTask(store, rest[0]);
    const wakes = store.listTaskWakes(task.id);
    if (wakes.length === 0) {
      return output(`No wakes recorded for ${task.id}.\n`, { taskId: task.id, wakes: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Wakes: ${task.id}`,
      [
        { header: "Wake", minWidth: 8, maxWidth: 18 },
        { header: "Status", minWidth: 8, maxWidth: 12 },
        { header: "Reasons", minWidth: 10, maxWidth: 40 },
        { header: "Run", minWidth: 10, maxWidth: 20 },
        { header: "Dispatched", minWidth: 10, maxWidth: 28 }
      ],
      wakes.map((wake) => [
        wake.id,
        wake.status,
        wake.reasons.map(renderWakeReason).join(", "),
        wake.runId ?? "-",
        presentTime(wake.createdAt, timeZone)
      ]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, wakes });
  }
  if (command === "show") {
    const usage = "Task wake show usage: yui task wake show <task> <wake>.";
    exactPositionals(rest, 2, usage);
    const task = requireTask(store, rest[0]);
    const wake = store.getTaskWake(task.id, rest[1]);
    if (wake === null) throw dataError(`Wake not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    const fromMs = Date.parse(wake.fromCursor);
    const toMs = Date.parse(wake.toCursor);
    const inWindow = (createdAt: string) => {
      const ms = Date.parse(createdAt);
      return ms > fromMs && ms <= toMs;
    };
    const events = store.listEvents(task.id).filter((e) => inWindow(e.createdAt));
    const messages = store.listMessages(task.id).filter((m) => inWindow(m.createdAt));
    const runs = store.listAgentRuns(task.id).filter((r) => inWindow(r.createdAt));
    const lines: string[] = [
      `Wake: ${wake.id}`,
      `Task: ${task.id}`,
      `Status: ${wake.status}`,
      `Reasons: ${wake.reasons.map(renderWakeReason).join(", ")}`,
      `Delta window: ${wake.fromCursor} → ${wake.toCursor}`,
      ...(wake.runId === undefined ? [] : [`Run: ${wake.runId}`]),
      `Dispatched: ${presentTime(wake.createdAt, timeZone)}`,
      ...(wake.consumedAt === undefined
        ? []
        : [`Consumed: ${presentTime(wake.consumedAt, timeZone)}`]),
      `Events (${events.length}):`,
      ...events.map((e) => `  ${e.id} ${e.type} ${presentTime(e.createdAt, timeZone)}`),
      `Messages (${messages.length}):`,
      ...messages.map((m) => `  ${m.id} [${taskMessageAuthorLabel(m.author)}] ${presentTime(m.createdAt, timeZone)}`),
      `Runs (${runs.length}):`,
      ...runs.map((r) => `  ${r.id} [${r.status}/${r.purpose}] ${r.roleName} ${presentTime(r.createdAt, timeZone)}`)
    ];
    return output(lines.join("\n").concat("\n"), {
      taskId: task.id,
      wake,
      events,
      messages,
      runs
    });
  }
  throw usageError(command === undefined
    ? "Task wake command is required."
    : `Unknown command: task wake ${command}`);
}

type ParsedMultiTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
  multiOptions: ReadonlyMap<string, string[]>;
}>;

function parseMultiValueTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  repeatOptions: ReadonlySet<string>,
  usage: string,
  flagOptions: ReadonlySet<string> = new Set()
): ParsedMultiTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const multiOptions = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value) && !repeatOptions.has(value) && !flagOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (flagOptions.has(value)) {
      if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
      options.set(value, "");
      continue;
    }
    if (repeatOptions.has(value)) {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        throw usageError(`${value} is required.`, usage);
      }
      const existing = multiOptions.get(value) ?? [];
      multiOptions.set(value, [...existing, optionValue]);
      index += 1;
      continue;
    }
    if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options, multiOptions };
}

type ParsedTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
}>;

function parseTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  usage: string,
  flagOptions: ReadonlySet<string> = new Set()
): ParsedTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value) && !flagOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
    if (flagOptions.has(value)) {
      options.set(value, "");
      continue;
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options };
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  return requiredText(options.get(name), name);
}

function optionalNonEmptyOption(
  options: ReadonlyMap<string, string>,
  name: string
): string | undefined {
  if (!options.has(name)) return undefined;
  return requiredText(options.get(name), name);
}

function exactPositionals(values: readonly string[], count: number, usage: string): void {
  if (values.length !== count || values.some((value) => value.trim().length === 0)) {
    throw usageError(usage);
  }
}

function assertNoArguments(args: readonly string[], usage: string): void {
  if (args.length > 0) throw usageError(usage);
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) throw usageError(`${label} is required.`);
  return normalized;
}

function parseExecutionStrategy(
  value: string | undefined,
  usage: string
): ExecutionStrategy | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const fixed = /^fixed:([1-9]\d*)$/u.exec(normalized);
  if (fixed !== null) {
    return { mode: "fixed", count: Number(fixed[1]) };
  }
  const adaptive = /^adaptive:([1-9]\d*)$/u.exec(normalized);
  if (adaptive !== null) {
    return { mode: "adaptive", max: Number(adaptive[1]) };
  }
  throw usageError(
    `Invalid execution strategy: ${value}. Use fixed:<count> or adaptive:<max>.`,
    usage
  );
}

function sameExecutionStrategy(
  left: ExecutionStrategy,
  right: ExecutionStrategy
): boolean {
  return left.mode === right.mode
    && (left.mode === "fixed"
      ? right.mode === "fixed" && left.count === right.count
      : right.mode === "adaptive" && left.max === right.max);
}

function parseExecutionResolutionDecision(
  value: string | undefined,
  usage: string
): "accept" | "reject" | "blocked" {
  if (value === "accept" || value === "reject" || value === "blocked") return value;
  throw usageError("--decision must be accept, reject, or blocked.", usage);
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function titleFrom(body: string): string {
  const oneLine = requiredText(body, "Message body").replace(/\s+/g, " ");
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}

function presentTime(value: string, timeZone: string | undefined): string {
  return formatTimestamp(value, timeZone);
}

function output(value: string, data?: unknown): TaskCommandExecution {
  return data === undefined
    ? { kind: "output", output: value }
    : { kind: "output", output: value, data };
}

function clock(options: TaskCommandOptions): Date {
  return options.now?.() ?? new Date();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskMailbox(taskId: string): MailboxTarget {
  return { kind: "task", taskId };
}

function queueCompletedTaskRuntimeCleanups(
  store: TaskWorkflowStore,
  taskId: string,
  roles: readonly Role[],
  now: Date
): RuntimeLifecycleTarget[] {
  const targets: RuntimeLifecycleTarget[] = [];
  for (const role of roles) {
    if (store.getActiveAgentRun(taskId, role.name) !== null) continue;
    const sessions = store.getTaskRoleSessionSet(taskId, role.name);
    const active = sessions?.sessions[sessions.activeAgentId];
    if (!ownedRuntimeSessionRequiresCleanup(active)) continue;
    const target = runtimeLifecycleTarget({
      scope: "task",
      taskId,
      roleName: role.name
    });
    enqueueWork(
      store,
      target,
      RUNTIME_CLEANUP_REQUIRED_REASON,
      now,
      [taskRef(taskId)]
    );
    targets.push(target);
  }
  return targets;
}

function ownedRuntimeSessionRequiresCleanup(
  session: TaskRoleSessionSet["sessions"][string] | undefined
): boolean {
  if (session === undefined || session.status === "stopped" || session.status === "broken") {
    return false;
  }
  // Older synthetic session fixtures can represent a ready native session
  // without a lifecycle generation. Do not manufacture a cleanup obligation
  // for those records; coordinated launches always carry launchId, while a
  // running session remains actionable even when an older record lacks it.
  return session.status === "running" || session.launchId !== undefined;
}

function roleMailbox(taskId: string, roleName: string): MailboxTarget {
  return { kind: "role", taskId, roleName };
}

function leaderMailbox(taskId: string): MailboxTarget {
  return roleMailbox(taskId, LEADER_ROLE);
}

function taskRef(id: string): MailboxEntityRef {
  return { type: "task", id };
}

function runRef(taskId: string, id: string): MailboxEntityRef {
  return { type: "run", taskId, id };
}

function workItemRef(taskId: string, id: string): MailboxEntityRef {
  return { type: "work-item", taskId, id };
}

function messageRef(taskId: string, id: string): MailboxEntityRef {
  return { type: "message", taskId, id };
}

function eventRef(taskId: string, id: string): MailboxEntityRef {
  return { type: "event", taskId, id };
}

function notifyMailbox(
  runtime: TaskWorkflowRuntimePort | undefined,
  target: MailboxTarget,
  compatibilityTaskId: string
): void {
  if (runtime?.notifyMailboxChanged !== undefined) {
    runtime.notifyMailboxChanged(target);
  } else {
    runtime?.notifyStateChanged(compatibilityTaskId);
  }
}

function notifyReviewMailbox(
  _options: TaskCommandOptions,
  runtime: TaskWorkflowRuntimePort | undefined,
  target: MailboxTarget,
  compatibilityTaskId: string
): void {
  notifyMailbox(runtime, target, compatibilityTaskId);
}
