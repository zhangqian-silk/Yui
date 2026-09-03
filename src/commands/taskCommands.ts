import type { ConfiguredAgent } from "../agent/agent.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createTurnInput } from "../context/turnInputContract.js";
import {
  buildTurnContextPack,
  buildTurnContextDelta,
  contextSnapshotDeltaRefIds,
  expandTurnContextRef,
  freezeWorkItemExecutionAssignmentContextSnapshot,
  freezeReviewStageContextSnapshot,
  freezeTurnContextSnapshot
} from "../context/turnContextPack.js";
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
  createTaskRecordRetirement,
  isTaskRecordRetired,
  operationalTaskRecords,
  taskRecordRetirement
} from "../task/taskRecordRetirement.js";
import {
  isRoleTurnStalled,
  TURN_PROGRESS_EVENT,
  TURN_RECOVERED_EVENT
} from "../scheduler/roleTurnStall.js";
import { readCommandText } from "./textInput.js";
import {
  assertTaskCompletionPublishedTreeProof,
  type TaskCompletionPublishedTreeProof
} from "./taskCompletionGate.js";
import {
  createRoleSessionSet,
  roleAgentSessionResumeMode,
  retireTaskRoleSessionsForWorkspace,
  updateTaskRoleProviderRuntime,
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
import type { RoleAgentConfig } from "../executor/agentAdapter.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatTimestamp } from "../output/timePresentation.js";
import { renderRoleDetails } from "../output/rolePresentation.js";
import {
  createTaskMessage,
  taskMessageAuthorLabel,
  updateDraftTaskMessage,
  type TaskMessage,
  type TaskMessageAuthor,
  type TaskMessageContext,
  type TaskMessageKind
} from "../message/message.js";
import {
  assertDraftTaskExecutionFree,
  validateDraftWorkItemEdit
} from "../task/draftPlan.js";
import type {
  TaskRetirementProof,
  WorkItemIntegrationProof
} from "../workspace/workItemChangeSetManager.js";
import { cancelInputRequest } from "../input/inputRequest.js";
import {
  retireExactActiveTurn,
  terminalizeExactTaskTurn,
  validateExactTurnReviewRound
} from "../lifecycle/exactTurnTerminalization.js";
import {
  activeRoleAgentBinding,
  copyGlobalRoleToTaskRole,
  createRole,
  createRoleAgentBinding,
  switchActiveRoleAgent,
  unbindRoleAgent,
  updateRole,
  type GlobalRole,
  type Role
} from "../role/role.js";
import {
  createTurn,
  withTurnContextSnapshot,
  type Turn
} from "../turn/turn.js";
import {
  createReviewRound,
  createTaskReviewRound,
  createTaskDeltaReviewRound,
  attachReviewExecutionGroup,
  deltaRecheckBlocksAcceptance,
  finishReviewRound,
  recordReviewWorkspaceDisposition,
  retryRunningReviewExecutionLane,
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
import { isAcceptedTaskReviewBaseline } from "../review/reviewAcceptance.js";
import {
  projectReviewerAvailability,
  type ReviewerBusy
} from "../review/reviewerAvailability.js";
import {
  buildTaskFinalReviewFindingContext,
  dispositionReviewFinding,
  planRepairGroups,
  reconcileReviewFindings,
  reconcileReviewFindingsAfterReview,
  type RepairGroup,
  type ReviewFindingDispositionCommand
} from "../review/reviewFindingLedger.js";
import {
  TASK_CONTROL_FINDING_DISPOSITIONS,
  type ReviewFindingDisposition
} from "../review/reviewFinding.js";
import { createTaskBrief, updateTaskBrief } from "../brief/taskBrief.js";
import { createDecision, supersedeDecision } from "../decision/decision.js";
import { createMilestone } from "../milestone/milestone.js";
import { runPublicationCommand } from "./taskPublicationCommands.js";
import {
  assertTaskRemoteDeliveryProof,
  type TaskRemoteDeliveryProof,
  projectTaskRemoteDeliveryFromStore,
  renderTaskRemoteDelivery,
  runTaskRemoteDeliveryCommand
} from "./taskRemoteDeliveryCommand.js";
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
import { projectProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
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
  formatTurnReceiptId,
  resolveTaskRecordReference
} from "../task/taskRecordReference.js";
import {
  projectCompletionReadiness,
  type CompletionAdvisory,
  type CompletionBlocker
} from "../task/completionReadiness.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { AgentProfile } from "../profile/agentProfile.js";
import { assertProjectActive, resolveProject, type Project } from "../repository/project.js";
import type { TaskWorkspaceActivation } from "../repository/taskWorkspacePreparer.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { TmuxRolePaneState } from "../tmux/tmuxManager.js";
import {
  currentWorkItemCandidate,
  governingWorkItemCandidate,
  currentWorkItemExecutionGroup,
  workItemExecutionGroupById,
  createWorkItem,
  editDraftWorkItemDefinition,
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
  assertWorkItemDependenciesCompleted as assertWorkItemDependencyGate,
  WorkItemDependencyGateError
} from "../workItem/dependencyGate.js";
import {
  addExecutionLane,
  createExecutionGroup,
  recordExecutionLaneResult,
  resolveExecutionGroup,
  updateExecutionLane,
  type ExecutionGroup,
  type ExecutionStrategy,
  type ExecutionLaneWorkspace,
  type ExecutionTarget
} from "../execution/executionGroup.js";
import {
  createWorkItemExecutionAssignment,
  createWorkItemExecutionGroup,
  MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS,
  updateWorkItemExecutionLane,
  workItemExecutionGroupSettled,
  type WorkItemExecutionLaneWorkspace
} from "../execution/workItemExecution.js";
import {
  reconcileWorkItemMainTurns,
  successfulWorkItemSynthesisProducers
} from "../execution/workItemMainTurn.js";
import {
  projectWorkItemExecution,
  type WorkItemExecutionProjection
} from "../execution/workItemExecutionProjection.js";
import {
  planResourceAdmissions,
  resolveResourceBrokerPolicy,
  type ResourceLaneIdentity
} from "../execution/resourceBroker.js";
import {
  resolveControllerTaskConcurrency,
  resolveRuntimeHealth
} from "../config/yuiConfig.js";
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
import {
  classifyReviewRoundOutcome,
  isSemanticReviewRound
} from "../review/reviewOutcomeClassifier.js";
import {
  resolveRecordedTaskFinalReviewContract,
  type TaskFinalReviewContractResolution
} from "../review/taskFinalReviewContractResolution.js";
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
  taskRoleLastTurnLabel,
  taskRoleNativeSessionLabel,
  taskRoleOpenInputLabel,
  taskRoleTmuxLabel
} from "./taskRoleRuntimeStatus.js";
import {
  assertNoOpenInputRequests,
  isCurrentGlobalOperator,
  openInputRequestCount,
  runTaskInputCommand
} from "./taskInputCommands.js";
import { runGrantCommand } from "./grantCommands.js";
import { runWorkflowCommand } from "./workflowCommands.js";
import {
  taskLocalActor as resolveTaskLocalActor,
  taskLeaderActionTurnId
} from "./taskActor.js";
import { enqueueOperatorEvent } from "../scheduler/operatorEvent.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import { renderWakeReason, wakeReason } from "../scheduler/wakeReason.js";
import { projectQueuedResourceLaneIdentities } from "../scheduler/resourceQueueProjection.js";
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
function taskFinalReviewDispatchDrift(error: unknown): TaskFinalReviewDispatchDriftError {
  return new TaskFinalReviewDispatchDriftError(
    error instanceof Error ? error.message : String(error),
    error instanceof CliError ? error : undefined
  );
}

/** `final` is a Task delivery policy, not a per-WorkItem ReviewRound rule. */
function workItemReviewConfig(
  config: ReviewConfig | null
): ReviewConfig | null {
  return config?.trigger === "final" ? null : config;
}

function storedTaskFinalReviewContract(
  store: TaskWorkflowStore,
  taskId: string
): TaskFinalReviewContract | undefined {
  return storedTaskFinalReviewContractResolution(store, taskId)?.effective;
}

function storedTaskFinalReviewContractResolution(
  store: TaskWorkflowStore,
  taskId: string
): TaskFinalReviewContractResolution | undefined {
  try {
    return resolveRecordedTaskFinalReviewContract(
      taskId,
      store.listWorkItems(taskId),
      store.listReviewRounds(taskId)
    );
  } catch (error) {
    throw dataError(
      error instanceof Error
        ? error.message
        : `Task ${taskId} contains conflicting final-review contracts.`
    );
  }
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
  options: TaskCommandOptions
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
  // The exact contract expresses a durable Reviewer policy. The persisted
  // contract remains the audit authority, but ordinary
  // protocol/storage-compatible CLIs may continue the Task without presenting
  // a release-bound capability on every mutation.
  if (supplied === undefined) return stored;
  if (!sameTaskFinalReviewContract(stored, supplied)) {
    throw usageError(`Task final-review contract control-plane digest mismatch for ${taskId}.`);
  }
  return stored;
}

export type TaskCommandExecution =
  | Readonly<{ kind: "output"; output: string; data?: unknown }>
  | Readonly<{
      kind: "session-stop";
      taskId: string;
      roleName: string;
      agentId: string;
      adapterId: string;
      nativeSessionId: string;
      launchId?: string;
      sessionUpdatedAt: string;
      reason: string;
      output: string;
    }>
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
  notifyMailboxChanged?(target: MailboxTarget): void | Promise<void>;
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
  /** CLI-verified clean Task-main snapshot for exact direct capture or safe delivery promotion. */
  directTaskMainSnapshot?: DirectTaskMainSnapshot;
  /** Prepared by the repository/workspace lifecycle before command mutation. */
  executionLaneWorkspaces?: ReadonlyMap<string, ManagedWorkspace>;
  /** Atomic Draft -> active plus Task-main workspace adoption completed by CLI preflight. */
  taskWorkspaceActivation?: TaskWorkspaceActivation;
  /**
   * Under-fence Project path snapshot captured when a new Group's Lane
   * workspaces were prepared. The dispatch aggregate CAS revalidates the Task
   * binding set and exact Project paths against it, so a project migrate in
   * the prepare/adopt gap fails closed instead of stranding a Lane on the
   * external checkout. Undefined when no fence is held (existing Group).
   */
  laneDispatchProjectPaths?: ReadonlyMap<string, string>;
  taskRetirementProof?: TaskRetirementProof;
  /** Verified by exact CLI preflight; never reconstructed from process.env. */
  taskFinalReviewContract?: TaskFinalReviewContract;
  /** Verified under the release handover lock by the exact global Operator CLI. */
  /** Physical Task-main heads verified by the CLI immediately before command execution. */
  actualTaskReviewCandidate?: TaskReviewCandidate;
  /** CLI-frozen remote merge coverage checked before destructive archive cleanup. */
  archiveRemoteDeliveryProof?: TaskRemoteDeliveryProof;
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

/** Normal scheduling result when a Reviewer slot is temporarily occupied. */
export type ReviewRequestBusy = ReviewerBusy;

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
  const actor = taskActor(store, options, task.id);
  if (task.status === "completed") {
    return { task, actor, completed: true, activeTaskReview: false };
  }
  if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
  if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);

  // Resolve the durable Task-local Reviewer policy before any remote fetch or
  // Integration write. Historical control-plane identity is audit evidence,
  // not a capability that every compatible CLI must reproduce.
  const taskFinalReviewContract = taskFinalReviewContractForMutation(
    store,
    task.id,
    options
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
    case "show": return showTaskCommand(
      rest,
      store,
      options.actualTaskReviewCandidate ?? null
    );
    case "context": return runTaskContextCommand(
      rest,
      store,
      options.actualTaskReviewCandidate ?? null
    );
    case "next-action": return runTaskNextActionCommand(
      rest,
      store,
      options.actualTaskReviewCandidate ?? null
    );
    case "remote-delivery": return runTaskRemoteDeliveryCommand(
      rest,
      store,
      options.actualTaskReviewCandidate ?? null
    );
    case "activate": return output(activateTaskCommand(rest, store, options));
    case "complete": return completeTaskCommand(rest, store, options);
    case "reopen": return output(reopenTaskCommand(rest, store, options));
    case "archive": return output(archiveTaskCommand(rest, store, options));
    case "retire": return retireTaskCommand(rest, store, options);
    case "reconcile": return output(reconcileTaskCommand(rest, store, options));
    case "message": {
      const execution = taskMessageCommand(rest, store, options);
      return typeof execution === "string" ? output(execution) : execution;
    }
    case "wake": return taskWakeDispatch(rest, store, options);
    case "project": return taskProjectCommand(rest, store, options);
    case "input": return runTaskInputCommand(rest, store, options);
    case "grant": return runGrantCommand(rest, store, options);
    case "workflow": return runWorkflowCommand(rest, store, options);
    case "publication": return runPublicationCommand(rest, store, options);
    case "role": return taskRoleCommand(rest, store, options);
    case "work": return taskWorkCommand(rest, store, options);
    case "review": return taskReviewCommand(rest, store, options);
    case "turn": return taskTurnCommand(rest, store, options);
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

/** Pure preflight shared by workspace preparation and the dispatch mutation. */
export function planReplicatedWorkItemLanes(
  assignee: string,
  requestedRoles: readonly string[],
  nextGroupId: string
): Readonly<{
  roles: readonly string[];
  laneIds: readonly string[];
}> {
  const roles = [...requestedRoles];
  if (roles.length === 1) {
    throw usageError(
      "Exactly one --lane-role is invalid; omit --lane-role for direct execution or provide at least two distinct roles."
    );
  }
  if (new Set(roles).size !== roles.length) {
    throw usageError("Each replicated Lane must use a distinct Task Role.");
  }
  if (roles.includes(assignee)) {
    throw usageError("A replicated Lane Role cannot be the WorkItem assignee.");
  }
  return {
    roles,
    laneIds: roles.map((_, index) => `${nextGroupId}-lane-${index + 1}`)
  };
}

function activeResourceLaneIdentities(store: TaskWorkflowStore): ResourceLaneIdentity[] {
  return store.listActiveTaskIds().flatMap((taskId) => (
    store.listTurns(taskId).flatMap((run): ResourceLaneIdentity[] => {
      if (run.status !== "active"
        || run.executionGroupId === undefined
        || run.executionLaneId === undefined) return [];
      return [{
        taskId,
        ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId }),
        executionGroupId: run.executionGroupId,
        executionLaneId: run.executionLaneId,
        providerId: run.effective.adapterId,
        agentId: run.effective.agentId,
        ...(run.effective.model === undefined ? {} : { model: run.effective.model }),
        requestedAt: run.createdAt
      }];
    })
  ));
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
    taskActor(tx, options, task.id);
    const project = resolveProject(tx.listProjects(), parsed.positionals[1]);
    if (project === null) throw usageError(`Project not found: ${parsed.positionals[1]}.`);
    assertProjectActive(project, "bind to a Task");
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
  const optionNames = new Set([
    "--title", "--type", "--description", "--priority", "--tags", "--due-at"
  ]);
  const flagOptions = new Set([
    "--clear-type", "--clear-description", "--clear-priority", "--clear-tags", "--clear-due-at"
  ]);
  const usage = "Task update usage: yui task update <id> [--title <text>] [--type <project-defined-type>|--clear-type] [--description <text>|--clear-description] [--priority <low|medium|high|urgent>|--clear-priority] [--tags <comma-separated>|--clear-tags] [--due-at <RFC3339>|--clear-due-at].";
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
    taskActor(tx, options, current.id);
    const updated = updateTaskMetadata(current, {
      ...(parsed.options.has("--title") ? { title: requiredOption(parsed.options, "--title") } : {}),
      ...(parsed.options.has("--type")
        ? { type: requiredOption(parsed.options, "--type") }
        : parsed.options.has("--clear-type") ? { type: null } : {}),
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
        : { dueAt })
    }, now);
    tx.saveTask(updated);
    recordTaskEvent(tx, updated.id, "task.updated", {
      status: updated.status,
      ...(updated.type === undefined ? {} : { taskType: updated.type })
    }, now);
    enqueueWork(tx, taskMailbox(updated.id), "task-updated", now, [taskRef(updated.id)]);
    return updated;
  });
  notifyMailbox(options.runtime, taskMailbox(result.id), result.id);
  return `Updated task ${result.id}\n`;
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
    ...(parsed.type === undefined ? {} : { type: parsed.type })
  }, now, parsed.defaultProjectIds));
  notifyMailbox(options.runtime, taskMailbox(created.task.id), created.task.id);
  return output(
    `Created Draft task ${created.task.id}: ${created.task.title}\n`
      + `Assigned role: ${created.leader.name}\n`
      + `Type: ${created.task.type ?? "unspecified"}\n`
      + (created.task.projectBindings.length > 0
        ? "Execution: Leader decides whether independent WorkItems are warranted\n"
        : "Execution: no Project delivery evidence required\n"),
    {
      task: created.task,
      leader: created.leader
    }
  );
}

function parseTaskCreation(
  args: string[],
  store: TaskWorkflowStore
): Readonly<{
  title: string;
  type?: string;
  projectBindings: readonly TaskProjectBinding[];
  defaultProjectIds: readonly string[];
}> {
  const usage = "Task create usage: yui task create <title> [--type <project-defined-type>] [--project <project> ...] [--base <project>=<ref> ...].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--type"]),
    new Set(["--project", "--base"]),
    usage
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
    assertProjectActive(project, "bind to a Task");
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
    ...(parsed.options.has("--type")
      ? { type: requiredOption(parsed.options, "--type") }
      : {}),
    projectBindings: projects.map((project) => ({
      projectId: project.id,
      directory: project.name,
      baseRef: bases.get(project.id) ?? project.developmentBranch
    })),
    defaultProjectIds
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
    ...(task.type === undefined ? {} : { taskType: task.type }),
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

function showTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  currentTaskCandidate: TaskReviewCandidate | null
): TaskCommandExecution {
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
  const remoteDelivery = projectTaskRemoteDeliveryFromStore(
    store,
    task,
    currentTaskCandidate
  );
  const verifiedMergedPublications = publications.filter((reference) => (
    reference.state === "merged" && reference.verification === "verified"
  )).length;
  const currentMessageCount = operationalTaskRecords(messages, events, "message").length;
  const currentWorkItemCount = work.filter(({ status }) => status !== "retired").length;
  const counts = {
    messages: messages.length,
    currentMessages: currentMessageCount,
    decisions: decisions.length,
    milestones: milestones.length,
    events: events.length,
    workItems: work.length,
    currentWorkItems: currentWorkItemCount,
    turns: store.listTurns(task.id).length,
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
    `Type: ${task.type ?? "unspecified"}`,
    ...(task.description === undefined ? [] : [`Description: ${task.description}`]),
    ...(task.priority === undefined ? [] : [`Priority: ${task.priority}`]),
    ...(task.tags === undefined ? [] : [`Tags: ${task.tags.join(", ")}`]),
    ...(task.dueAt === undefined ? [] : [`Due: ${presentTime(task.dueAt, timeZone)}`]),
    `Execution topology: ${task.projectBindings.length > 0
      ? "Leader-owned; WorkItems are optional independent delivery units"
      : "no Project delivery evidence required"}`,
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
    `Current messages: ${currentMessageCount}`,
    `Brief: ${brief === null ? "no" : "yes"}`,
    `Decisions: ${counts.decisions}`,
    `Milestones: ${counts.milestones}`,
    `Events: ${counts.events}`,
    `Work items: ${counts.workItems}`,
    `Current work items: ${currentWorkItemCount}`,
    `Turns: ${counts.turns}`,
    `ChangeSets: ${counts.changeSets}`,
    `Integration Attempts: ${counts.integrations}`,
    `Publication references: ${counts.publications} (${verifiedMergedPublications} verified merged)`,
    renderTaskRemoteDelivery(remoteDelivery).trimEnd(),
    `Open inputs: ${counts.openInputs}`,
    `Created: ${presentTime(task.createdAt, timeZone)}`,
    `Updated: ${presentTime(task.updatedAt, timeZone)}`
  ].join("\n").concat("\n");
  return output(rendered, {
    task,
    counts,
    hasBrief: brief !== null,
    remoteDelivery
  });
}

function activateTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task activate usage: yui task activate <task>.");
  const activation = options.taskWorkspaceActivation;
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
    if (task.status === "retired") throw usageError(`Task is retired: ${task.id}.`);
    if (task.status === "completed") {
      throw usageError(`Task ${task.id} is completed; use task reopen before activating it.`);
    }
    if (task.status === "active") {
      if (activation === undefined) return { task, changed: false } as const;
      const workspace = tx.getTaskWorkspace(task.id);
      if (activation.taskId !== task.id
        || activation.task.id !== task.id
        || activation.task.status !== "active"
        || !isDeepStrictEqual(activation.task.workspaceIdentity, task.workspaceIdentity)
        || activation.path !== task.cwd
        || workspace === null
        || workspace.owner.type !== "task"
        || workspace.owner.taskId !== task.id
        || workspace.root !== task.cwd) {
        throw usageError(`Task workspace activation proof does not match ${task.id}.`);
      }
      return { task, changed: activation.changed } as const;
    }
    throw usageError(
      `Task ${task.id} activation requires atomic workspace adoption through the CLI preflight.`
    );
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
        completionAdvisories: [] as CompletionAdvisory[],
        finalReview: undefined
      } as const;
    }
    const taskFinalContract = preflight.taskFinalReviewContract;
    const actualTaskCandidate = task.projectBindings.length === 0
      ? undefined
      : actualTaskReviewCandidateForMutation(tx, task, options);
    const publishedTreeProof = request.acceptedPublishedTreePublicationId === undefined
      ? undefined
      : assertTaskCompletionPublishedTreeProof(
        tx,
        task,
        request.acceptedPublishedTreePublicationId,
        options.completionPublishedTreeProof,
        actualTaskCandidate!
      );
    const roles = tx.listRoles(task.id);
    // A final (Task-scoped) review is the Task delivery policy: it reviews the
    // complete frozen Task heads, not a single WorkItem Candidate. If the
    // review config requests a final review, create the Task ReviewRound here
    // and return it for dispatch instead of completing the Task.
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
        completionAdvisories: [] as CompletionAdvisory[],
        finalReview,
      } as const;
    }
    // Completion is a Task decision only. The current Provider Turn remains
    // responsible for closing its own Turn, and the reusable Session keeps
    // its independent lifecycle.
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
    if (publishedTreeProof !== undefined) {
      recordTaskEvent(tx, task.id, "task.completion-published-tree-accepted", {
        by: actor,
        projectId: publishedTreeProof.projectId,
        publicationId: publishedTreeProof.publicationId,
        ...(publishedTreeProof.reviewRoundId === undefined
          ? {}
          : { reviewRoundId: publishedTreeProof.reviewRoundId }),
        localCommit: publishedTreeProof.localCommit,
        remoteCommit: publishedTreeProof.remoteCommit,
        tree: publishedTreeProof.tree
      }, now);
    }
    const taskWorkspace = readinessFacts.managedWorkspaces.find((workspace) => (
      workspace.owner.type === "task"
      && workspace.owner.taskId === task.id
    ));
    const completedProjectHeads = actualTaskCandidate === undefined
      ? undefined
      : formatProjectCommits(actualTaskCandidate.projects);
    const completedProjectBases = taskWorkspace === undefined
      ? undefined
      : formatProjectCommits(taskWorkspace.entries.map(({ projectId, baseCommit }) => ({
        projectId,
        commit: baseCommit
      })));
    const terminalEvent = recordTaskEvent(tx, task.id, "task.completed", {
      by: actor,
      summary,
      ...(completedProjectHeads === undefined
        ? {}
        : { projectHeads: completedProjectHeads }),
      ...(completedProjectBases === undefined
        ? {}
        : { projectBases: completedProjectBases }),
      ...(readiness.advisories.length === 0
        ? {}
        : { cleanupAdvisories: String(readiness.advisories.length) })
    }, now);
    enqueueOperatorEvent(tx, terminalEvent, "task-terminal", now);
    // A terminal Task must never leave a Task-lane signal that can wake it.
    // The durable records remain intact; only the derived mailbox work is
    // discarded at this lifecycle boundary.
    tx.removeWorkMailbox(taskMailbox(task.id));
    // Role mailboxes are also derived wake state. A Worker result or runtime
    // signal queued while the final Turn was being settled must not survive a
    // completed Task and become actionable after a later explicit reopen.
    for (const role of roles) {
      tx.removeWorkMailbox(roleMailbox(task.id, role.name));
    }
    return {
      task: completed,
      changed: true,
      completionAdvisories: readiness.advisories,
      finalReview: undefined
    } as const;
  });
  if (result.changed) {
    notifyMailbox(options.runtime, { kind: "operator" }, result.task.id);
  }
  if (result.finalReview !== undefined) {
    const status = result.finalReview.status === "pending"
      ? `Final Task Review requested as ${result.finalReview.id}.`
      : `Final Task Review is blocked: ${result.finalReview.summary ?? result.finalReview.id}.`;
    return output(`${status}\n`, {
      task: result.task,
      reviewRound: result.finalReview
    });
  }
  const completionOutput = result.changed
    ? `Completed task ${result.task.id}\n`
    : `Task ${result.task.id} is already completed\n`;
  const advisoryOutput = result.completionAdvisories.length === 0
    ? ""
    : `Cleanup advisories (non-blocking; settle before archive):\n`
      + result.completionAdvisories.map((advisory) => (
        `- ${advisory.code} (${advisory.ref.kind} ${advisory.ref.id}): ${advisory.fix}`
      )).join("\n").concat("\n");
  return output(completionOutput + advisoryOutput, {
    task: result.task,
    completionAdvisories: result.completionAdvisories
  });
}

function reopenTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task reopen usage: yui task reopen <id>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    if (task.status === "active") return { task, changed: false } as const;
    if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
    if (task.status !== "completed") throw usageError(`Task is not completed: ${task.id}.`);
    const active = reopenTask(task, now);
    tx.saveTask(active);
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
    const actor = taskActor(tx, options, task.id);
    if (task.status === "archived") return { task, changed: false } as const;
    if (task.status !== "completed"
      && task.status !== "retired") {
      throw usageError(`Task ${task.id} must be completed or retired before it can be archived.`);
    }
    const remoteDelivery = request.disposition === "integrated"
      ? assertTaskRemoteDeliveryProof(
        tx,
        task,
        options.archiveRemoteDeliveryProof,
        { forceUnverified: request.forceUnverified }
      )
      : undefined;
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
    if (task.cwd !== undefined || tx.listManagedWorkspaces(task.id).length > 0) {
      throw usageError(`Task ${task.id} still has managed worktrees; clean them before archiving.`);
    }
    const activeRole = tx.listRoles(task.id)
      .find((role) => tx.getActiveTurn(task.id, role.name) !== null);
    if (activeRole !== undefined) {
      throw usageError(
        `Task ${task.id} still has an active Turn for Role ${activeRole.name}; `
        + "stop its runtime before archiving."
      );
    }
    const liveSessionRole = tx.listRoles(task.id).find((role) => {
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      const session = sessions?.sessions[sessions.activeAgentId];
      return session !== undefined && session.status !== "ended";
    });
    if (liveSessionRole !== undefined) {
      throw usageError(
        `Task ${task.id} still has a live Session for Role ${liveSessionRole.name}; `
        + "stop that Session before archiving."
      );
    }
    const archived = archiveTask(task, now, { by: actor });
    tx.saveTask(archived);
    tx.clearPendingWakeup(task.id);
    tx.clearLeaderFailure(task.id);
    for (const role of tx.listRoles(task.id)) {
      tx.removeWorkMailbox(roleMailbox(task.id, role.name));
    }
    const remoteProjectHeads = remoteDelivery === undefined
      ? undefined
      : formatProjectCommits(
        remoteDelivery.projects.map(({ projectId, expectedLocalCommit }) => ({
          projectId,
          commit: expectedLocalCommit
        }))
      );
    const remoteProjectBases = remoteDelivery === undefined
      ? undefined
      : formatProjectCommits(
        remoteDelivery.projects.map(({ projectId, baseCommit }) => ({
          projectId,
          commit: baseCommit
        }))
      );
    recordTaskEvent(tx, task.id, "task.archived", {
      by: actor,
      workspaceDisposition: request.disposition,
      ...(remoteDelivery === undefined
        ? {}
        : {
            mergeCoverage: remoteDelivery.status,
            allMerged: String(remoteDelivery.allMerged),
            allVerified: String(remoteDelivery.allVerified),
            ...(request.forceUnverified && !remoteDelivery.allVerified
              ? { verificationOverride: "true" }
              : {})
          }),
      ...(remoteProjectHeads === undefined ? {} : { projectHeads: remoteProjectHeads }),
      ...(remoteProjectBases === undefined ? {} : { projectBases: remoteProjectBases })
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
    const actor = taskActor(tx, options, task.id);
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

    for (const run of tx.listTurns(task.id).filter(({ status: runStatus }) => (
      runStatus === "active"
    ))) {
      const terminal = terminalizeExactTaskTurn(tx, {
        taskId: task.id,
        roleName: run.roleName,
        agentId: run.effective.agentId,
        turnId: run.id,
        mailboxDisposition: "discard",
        outcome: {
          status: "failed",
          summary: `Task retired: ${summary}`
        }
      }, now);
      if (terminal.disposition !== "applied") {
        throw usageError(
          `Task Turn changed during retirement: ${run.id}/${terminal.reason ?? "obsolete"}.`
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
    const retired = retireTask(task, {
      by: actor,
      summary,
      ...(replacementTaskId === undefined ? {} : { replacementTaskId })
    }, now);
    tx.saveTask(retired);
    const terminalEvent = recordTaskEvent(tx, task.id, "task.retired", {
      by: actor,
      summary,
      ...(replacementTaskId === undefined ? {} : { replacementTaskId })
    }, now);
    enqueueOperatorEvent(tx, terminalEvent, "task-terminal", now);
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
): Readonly<{
  taskId: string;
  disposition: "integrated" | "abandoned";
  forceUnverified: boolean;
}> {
  const usage = "Task archive usage: "
    + "yui task archive <id> (--integrated [--force]|--abandon).";
  const taskId = args[0]?.trim();
  const flags = args.slice(1);
  if (taskId === undefined
    || taskId.length === 0
    || flags.some((flag, index) => (
      !["--integrated", "--abandon", "--force"].includes(flag)
      || flags.indexOf(flag) !== index
    ))) {
    throw usageError(usage);
  }
  const integrated = flags.includes("--integrated");
  const abandoned = flags.includes("--abandon");
  const forceUnverified = flags.includes("--force");
  if (integrated === abandoned || (forceUnverified && !integrated)) {
    throw usageError(usage);
  }
  return {
    taskId,
    disposition: integrated ? "integrated" : "abandoned",
    forceUnverified
  };
}

function formatProjectCommits(
  projects: readonly Readonly<{ projectId: string; commit: string | null }>[]
): string | undefined {
  const values = projects.flatMap(({ projectId, commit }) => (
    commit === null ? [] : [`${projectId}@${commit}`]
  ));
  return values.length === 0 ? undefined : values.join(",");
}

export function validateTaskArchiveRequest(
  args: readonly string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): ReturnType<typeof parseTaskArchiveArguments> {
  const request = parseTaskArchiveArguments(args);
  const task = requireTask(store, request.taskId);
  taskActor(store, options, task.id);
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
): string | TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "send") {
    const usage = "Task message send usage: yui task message send <id> (<body>|--body-file <path|->) [--wake-policy leader|none].";
    const parsed = parseTail(
      rest,
      new Set(["--body-file", "--wake-policy"]),
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
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(tx, options, task.id);
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
          {
            source: actor,
            dedupeKey: `message:${task.id}:${message.id}`
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
    const retirements = new Map(store.listEvents(task.id).flatMap((event) => {
      const retirement = taskRecordRetirement(event);
      return retirement?.recordKind === "message"
        ? [[retirement.recordId, retirement] as const]
        : [];
    }));
    const timeZone = store.getConfig().timeZone;
    return `${renderTable(
      `Task messages: ${task.id}`,
      [
        { header: "Message", minWidth: 7, maxWidth: 18 },
        { header: "Status", minWidth: 6, maxWidth: 9 },
        { header: "Author", minWidth: 6, maxWidth: 18 },
        { header: "Created", minWidth: 10, maxWidth: 28 },
        { header: "Body", minWidth: 8, maxWidth: 72 }
      ],
      messages.map((message) => [
        message.id,
        retirements.has(message.id) ? "retired" : "active",
        taskMessageAuthorLabel(message.author),
        presentTime(message.createdAt, timeZone),
        message.body
      ]),
      defaultTableWidth()
    )}\n`;
  }
  if (command === "update") {
    return updateMessage(rest, store, options);
  }
  if (command === "retire") {
    return retireMessage(rest, store, options);
  }
  throw usageError(command === undefined
    ? "Task message command is required."
    : `Unknown command: task message ${command}`);
}

function updateMessage(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task message update usage: yui task message update <task>/<message> (<body>|--body-file <path|->) [--wake-policy leader|none].";
  const parsed = parseTail(args, new Set(["--body-file", "--wake-policy"]), usage);
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) throw usageError(usage);
  const body = readCommandText(
    parsed.positionals[1],
    parsed.options.get("--body-file"),
    "--body",
    usage
  );
  const wakePolicyRaw = parsed.options.get("--wake-policy");
  const wakePolicy = wakePolicyRaw === undefined
    ? undefined
    : wakePolicyRaw === "leader" || wakePolicyRaw === "none"
      ? wakePolicyRaw
      : (() => {
          throw usageError(`--wake-policy must be 'leader' or 'none': ${wakePolicyRaw}.`);
        })();
  const reference = taskRecordReference(
    parsed.positionals[0],
    "message",
    "Message reference",
    options
  );
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, reference.taskId);
    if (task.status !== "draft") {
      throw usageError(`Task Message update is Draft-only: ${task.id}/${task.status}.`);
    }
    assertDraftTaskExecutionFree(tx, task);
    const actor = taskActor(tx, options, task.id);
    if (actor !== "user" && actor !== "operator") {
      throw usageError("Only the user or Operator may update a Draft Task Message.");
    }
    const message = tx.listMessages(task.id).find(({ id }) => id === reference.localId);
    if (message === undefined) {
      throw dataError(`Task Message not found: ${task.id}/${reference.localId}.`);
    }
    if (isTaskRecordRetired(tx.listEvents(task.id), "message", message.id)) {
      throw usageError(`Task Message is retired: ${task.id}/${message.id}.`);
    }
    const updated = updateDraftTaskMessage(message, {
      body,
      ...(wakePolicy === undefined ? {} : { wakePolicy })
    });
    tx.updateMessage(task.id, updated);
    recordTaskEvent(tx, task.id, "message.updated", {
      messageId: updated.id,
      updatedBy: actor,
      ...(wakePolicy === undefined ? {} : { wakePolicy })
    }, now);
    return { task, message: updated };
  });
  options.runtime?.notifyStateChanged(result.task.id);
  return output(`Updated Task Message ${result.task.id}/${result.message.id}\n`, {
    message: result.message
  });
}

function retireMessage(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task message retire usage: yui task message retire <task>/<message> --reason <text>.";
  const parsed = parseTail(args, new Set(["--reason"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const reason = requiredOption(parsed.options, "--reason");
  const reference = taskRecordReference(
    parsed.positionals[0],
    "message",
    "Message reference",
    options
  );
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, reference.taskId);
    assertTaskOpen(task);
    if (task.status === "draft") assertDraftTaskExecutionFree(tx, task);
    const actor = taskActor(tx, options, task.id);
    const message = tx.listMessages(task.id).find(({ id }) => id === reference.localId);
    if (message === undefined) {
      throw dataError(`Task Message not found: ${task.id}/${reference.localId}.`);
    }
    const events = tx.listEvents(task.id);
    if (isTaskRecordRetired(events, "message", message.id)) {
      return { task, message, changed: false } as const;
    }
    // Remove an isolated pending wake for this exact directive. A merged batch
    // is retained because its other signals remain actionable; context and
    // actionability projections still filter the retired message below.
    if (task.status === "active") {
      try {
        settleExactWorkExecution(tx, leaderMailbox(task.id), messageRef(task.id, message.id));
      } catch {
        // Merged pending work cannot be split without losing unrelated signals.
      }
    }
    tx.saveEvent(task.id, createTaskRecordRetirement({
      eventId: tx.nextEventId(task.id),
      taskId: task.id,
      recordKind: "message",
      recordId: message.id,
      reason,
      retiredBy: actor
    }, now));
    return { task, message, changed: true } as const;
  });
  if (result.changed) options.runtime?.notifyStateChanged(result.task.id);
  return `Retired Task Message ${result.task.id}/${result.message.id}\n`;
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
  if (command === "session") return taskRoleSessionCommand(rest, store, options);
  if (command === "view") return viewTaskRole(rest, store);
  if (command === "takeover") return transferTaskRoleAuthority(rest, store, options, "takeover");
  if (command === "release") return transferTaskRoleAuthority(rest, store, options, "release");
  throw usageError(command === undefined
    ? "Task role command is required."
    : `Unknown command: task role ${command}`);
}

function taskRoleSessionCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "inspect") {
    exactPositionals(
      rest,
      2,
      "Task Role Session inspect usage: yui task role session inspect <task> <role>."
    );
    const task = requireTask(store, rest[0]);
    const role = requireRole(store, task.id, rest[1]);
    taskActor(store, options, task.id);
    const sessions = store.getTaskRoleSessionSet(task.id, role.name);
    const active = sessions?.sessions[sessions.activeAgentId] ?? null;
    const binding = sessions?.providerBinding ?? null;
    return output(
      active === null
        ? `No Session exists for ${task.id}/${role.name}.\n`
        : [
            `Session ${task.id}/${role.name}`,
            `Agent: ${active.agentId}/${active.adapterId}`,
            `Native id: ${active.nativeSessionId}`,
            `Host activation: ${active.launchId ?? "none"}`,
            `Session: ${active.status}${active.endReason === undefined ? "" : `/${active.endReason}`}`,
            `Turn: ${binding?.turn?.status ?? "none"}`
          ].join("\n") + "\n",
      { task, role, session: active, providerBinding: binding }
    );
  }
  if (command === "stop") {
    const usage = "Task Role Session stop usage: yui task role session stop <task> <role> --reason <text>.";
    const parsed = parseTail(rest, new Set(["--reason"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const reason = requiredOption(parsed.options, "--reason");
    const now = clock(options);
    const request = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      if (task.status !== "active" && task.status !== "completed") {
        throw usageError(
          `Task Role Session stop requires an active or completed Task: ${task.id}.`,
          usage
        );
      }
      const actor = taskActor(tx, options, task.id);
      const role = requireRole(tx, task.id, parsed.positionals[1]);
      if (actor === "leader" && role.name === LEADER_ROLE) {
        throw usageError("A Leader cannot stop the Session executing its own current command.", usage);
      }
      if (tx.getActiveTurn(task.id, role.name) !== null) {
        throw usageError(
          `Task Role has an active Turn; settle or retire it before stopping the Session: ${task.id}/${role.name}.`,
          usage
        );
      }
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      const session = sessions?.sessions[sessions.activeAgentId];
      if (session === undefined || session.status === "ended") {
        throw usageError(`Task Role has no active Session: ${task.id}/${role.name}.`, usage);
      }
      const lifecycle = tx.getWorkMailbox(runtimeLifecycleTarget({
        scope: "task",
        taskId: task.id,
        roleName: role.name
      }));
      if (lifecycle !== null && workMailboxHasWork(lifecycle)) {
        throw usageError(`Task Role Session lifecycle is busy: ${task.id}/${role.name}.`, usage);
      }
      recordTaskEvent(tx, task.id, "runtime.session-stop-requested", {
        roleName: role.name,
        agentId: session.agentId,
        adapterId: session.adapterId,
        nativeSessionId: session.nativeSessionId,
        launchId: session.launchId ?? "",
        reason,
        requestedBy: actor
      }, now);
      return {
        taskId: task.id,
        roleName: role.name,
        agentId: session.agentId,
        adapterId: session.adapterId,
        nativeSessionId: session.nativeSessionId,
        ...(session.launchId === undefined ? {} : { launchId: session.launchId }),
        sessionUpdatedAt: session.updatedAt
      };
    });
    return {
      kind: "session-stop",
      ...request,
      reason,
      output: `Stopped Session ${request.taskId}/${request.roleName}: ${reason}\n`
    };
  }
  throw usageError(
    command === undefined
      ? "Task Role Session command is required."
      : `Unknown command: task role session ${command}`
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
    taskActor(tx, options, task.id);
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
      created = applyWorkerAgentProfile(created, requireAgentProfile(tx, profileId), now);
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
      { header: "Last turn", minWidth: 10, maxWidth: 28 },
      { header: "Native session", minWidth: 10, maxWidth: 28 },
      { header: "tmux", minWidth: 6, maxWidth: 22 }
    ],
    statuses.map((status) => [
      status.roleName,
      status.agentId,
      status.health,
      taskRoleOpenInputLabel(status),
      taskRoleActiveWorkLabel(status),
      taskRoleLastTurnLabel(status),
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
    taskActor(tx, options, task.id);
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
    const profileId = parsed.one("--profile");
    const withProfile = profileId === undefined
      ? role
      : applyWorkerAgentProfile(role, requireAgentProfile(tx, profileId), now);
    let bindings = withProfile.agentBindings;
    if (changesAgentConfig) {
      const agentId = parsed.one("--agent")?.trim() || withProfile.activeAgentId;
      const agent = requireAgent(tx, agentId);
      const binding = bindings[agentId]
        ?? createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
      bindings = { ...bindings, [agentId]: patchRoleAgentBinding(binding, parsed) };
    }
    const next = updateRole(withProfile, {
      ...(bindings === withProfile.agentBindings ? {} : { agentBindings: bindings }),
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
    taskActor(tx, options, task.id);
    const role = requireRole(tx, task.id, args[1]);
    if (role.name === LEADER_ROLE) throw usageError("The Task Leader role cannot be removed.");
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    }, "removal");
    if (tx.getActiveTurn(task.id, role.name) !== null) {
      throw usageError(`Task Role has an active Turn and cannot be removed: ${task.id}/${role.name}.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    if (Object.values(sessions?.sessions ?? {}).some(({ status }) => status === "active")) {
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
    taskActor(tx, options, task.id);
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
          activeTurn: tx.getActiveTurn(task.id, role.name) !== null,
          nativeProcessRunning: currentSession !== undefined
            && currentSession.status === "active"
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
    assertTaskOpen(task);
    taskActor(tx, options, task.id);
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
  if (session === null || session.status === "ended") {
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
      taskActor(tx, options, task.id);
      const role = requireRole(tx, task.id, args[1]);
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      const session = sessions?.sessions[role.activeAgentId];
      const binding = sessions?.providerBinding;
      if (sessions === null || sessions === undefined || session === undefined
        || binding === null || binding === undefined
        || session.launchId === undefined
        || session.status === "ended") {
        throw new Error(`Task Role has no live managed Provider: ${task.id}/${role.name}.`);
      }
      const activation = currentProviderActivation(binding);
      if (activation === null) {
        throw new Error(`Provider Activation is not live: ${task.id}/${role.name}.`);
      }
      if (action === "takeover") {
        const activeTurn = tx.getActiveTurn(task.id, role.name);
        if (activeTurn === null) {
          throw new Error(`Task Role has no active managed Turn for takeover: ${task.id}/${role.name}.`);
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
  if (command === "edit") return editWork(rest, store, options);
  if (command === "update") return updateWork(rest, store, options);
  if (command === "scope") return output(updateWorkScope(rest, store, options));
  if (command === "dispatch") return output(dispatchWork(rest, store, options));
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

function editWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work edit usage: yui task work edit <task>/<work> [--title <text>] [--objective <text>] [--accept <criterion> ...|--clear-acceptance] [--after <work> ...|--clear-dependencies] [--project <project> ...|--clear-projects] [--base-ref <project>=<ref> ...|--clear-base-refs] [--role <name>|--clear-role].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--title", "--objective", "--role"]),
    new Set(["--accept", "--after", "--project", "--base-ref"]),
    usage,
    new Set([
      "--clear-acceptance",
      "--clear-dependencies",
      "--clear-projects",
      "--clear-base-refs",
      "--clear-role"
    ])
  );
  exactPositionals(parsed.positionals, 1, usage);
  const optionCount = parsed.options.size + parsed.multiOptions.size;
  if (optionCount === 0) throw usageError("At least one Work Item definition field is required.", usage);
  assertReplaceOrClear(parsed, "--accept", "--clear-acceptance", usage);
  assertReplaceOrClear(parsed, "--after", "--clear-dependencies", usage);
  assertReplaceOrClear(parsed, "--project", "--clear-projects", usage);
  assertReplaceOrClear(parsed, "--base-ref", "--clear-base-refs", usage);
  if (parsed.options.has("--role") && parsed.options.has("--clear-role")) {
    throw usageError("--role and --clear-role cannot be combined.", usage);
  }
  const now = clock(options);
  const result = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "draft") {
      throw usageError(`Work Item definition edit is Draft-only: ${task.id}/${task.status}.`);
    }
    assertDraftTaskExecutionFree(tx, task);
    const actor = taskActor(tx, options, task.id);
    if (actor !== "user" && actor !== "operator") {
      throw usageError("Only the user or Operator may edit a Draft Work Item.");
    }
    if (item.status === "retired") {
      throw usageError(`Work Item is retired: ${item.id}.`);
    }
    const projects = parsed.multiOptions.has("--project")
      ? parsed.multiOptions.get("--project")!.map((reference) => {
          const project = resolveProject(
            task.projectBindings.map(({ projectId }) => requireProject(tx, projectId)),
            reference
          );
          if (project === null) throw usageError(`Task Project not found: ${reference}.`);
          assertProjectActive(project, "edit a Work Item");
          return project.id;
        })
      : parsed.options.has("--clear-projects") ? [] : undefined;
    const baseRefs = parsed.multiOptions.has("--base-ref")
      ? parseWorkItemBaseRefs(
          parsed.multiOptions.get("--base-ref")!,
          task,
          tx,
          projects ?? item.writeProjectIds,
          usage
        )
      : parsed.options.has("--clear-base-refs") ? null : undefined;
    const assignee = parsed.options.has("--role")
      ? requiredOption(parsed.options, "--role")
      : parsed.options.has("--clear-role") ? null : undefined;
    if (typeof assignee === "string") requireRole(tx, task.id, assignee);
    const updated = editDraftWorkItemDefinition(item, {
      ...(parsed.options.has("--title")
        ? { title: requiredOption(parsed.options, "--title") }
        : {}),
      ...(parsed.options.has("--objective")
        ? { objective: requiredOption(parsed.options, "--objective") }
        : {}),
      ...(parsed.multiOptions.has("--accept")
        ? { acceptance: parsed.multiOptions.get("--accept")! }
        : parsed.options.has("--clear-acceptance") ? { acceptance: [] } : {}),
      ...(parsed.multiOptions.has("--after")
        ? { dependsOn: parsed.multiOptions.get("--after")! }
        : parsed.options.has("--clear-dependencies") ? { dependsOn: [] } : {}),
      ...(projects === undefined ? {} : { writeProjectIds: projects }),
      ...(baseRefs === undefined ? {} : { baseRefs }),
      ...(assignee === undefined ? {} : { assignee })
    }, now);
    validateDraftWorkItemEdit(tx, task, updated);
    tx.saveWorkItem(task.id, updated);
    const changedFields = [
      parsed.options.has("--title") ? "title" : undefined,
      parsed.options.has("--objective") ? "objective" : undefined,
      parsed.multiOptions.has("--accept") || parsed.options.has("--clear-acceptance")
        ? "acceptance" : undefined,
      parsed.multiOptions.has("--after") || parsed.options.has("--clear-dependencies")
        ? "dependsOn" : undefined,
      parsed.multiOptions.has("--project") || parsed.options.has("--clear-projects")
        ? "writeProjectIds" : undefined,
      parsed.multiOptions.has("--base-ref") || parsed.options.has("--clear-base-refs")
        ? "baseRefs" : undefined,
      parsed.options.has("--role") || parsed.options.has("--clear-role")
        ? "assignee" : undefined
    ].filter((field): field is string => field !== undefined);
    recordTaskEvent(tx, task.id, "work.edited", {
      workItemId: updated.id,
      revision: String(updated.revision),
      fields: changedFields.join(","),
      editedBy: actor
    }, now);
    return { task, item: updated };
  });
  options.runtime?.notifyStateChanged(result.task.id);
  return output(`Edited Work Item ${result.task.id}/${result.item.id}\n`, {
    workItem: result.item
  });
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
    taskActor(tx, options, task.id);
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
      assertProjectActive(project, "scope a Work Item");
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
    taskActor(tx, options, task.id);
    if (tx.getActiveTurn(task.id, item.assignee ?? "") !== null) {
      throw usageError(`Stop the active Work Item Turn before changing scope: ${item.id}.`);
    }
    const requestedProjectIds = (parsed.multiOptions.get("--project") ?? []).map((reference) => {
      const project = resolveProject(
        task.projectBindings.map(({ projectId }) => requireProject(tx, projectId)),
        reference
      );
      if (project === null) throw usageError(`Task Project not found: ${reference}.`);
      assertProjectActive(project, "scope a Work Item");
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
      taskActor(tx, options, task.id);
      if (status === "running") {
        assertWorkItemDependenciesCompletedForCommand(tx, current);
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
        ? workItemReviewConfig(configuredReview)
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
    taskActor(tx, options, task.id);
    if (status !== "completed" || current.status !== "running") {
      throw usageError(
        `Assigned Work Item ${current.id} can only submit a completed direct Turn from running; `
        + "use dispatch, task turn retry, or task work retire for other transitions."
      );
    }
    if (tx.getActiveTurn(task.id, current.assignee) !== null) {
      throw usageError(`Work Item main Turn is still active: ${current.id}/${current.assignee}.`);
    }
    const sourceGroup = currentWorkItemExecutionGroup(current);
    const mainTurn = tx.listTurns(task.id).filter((turn) => (
      turn.purpose === "execution"
      && turn.workItemId === current.id
      && turn.roleName === current.assignee
      && turn.executionGroupId === undefined
      && turn.executionLaneId === undefined
      && turn.sourceExecutionGroupId === sourceGroup?.id
      && turn.status === "completed"
      && turn.result !== undefined
    )).at(-1);
    if (mainTurn === undefined) {
      throw usageError(
        sourceGroup === undefined
          ? `Work Item ${current.id} has no completed direct main Turn.`
          : `Work Item ${current.id} has no completed main Turn for ExecutionGroup ${sourceGroup.id}.`
      );
    }
    if (mainTurn.result === undefined) {
      throw dataError(`Completed WorkItem main Turn has no result: ${mainTurn.id}.`);
    }
    const configuredReview = tx.getReviewConfig();
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    const candidatePolicy = taskFinalContract === undefined
      ? workItemReviewConfig(configuredReview)
      : taskFinalReviewConfig(taskFinalContract);
    const projectDelivery = task.projectBindings.length > 0
      && current.writeProjectIds.length > 0;
    const developWorkspace = tx.getWorkItemWorkspace(task.id, current.id);
    const exactTaskMainDelivery = taskFinalContract !== undefined
      && developWorkspace === null;
    if (projectDelivery && developWorkspace === null && !exactTaskMainDelivery) {
      throw usageError(
        `Project-backed Work Item ${current.id} must be isolated before Candidate submission.`
      );
    }
    const updated = submitWorkItemCandidate(current, {
      summary: mainTurn.result.output,
      source: { type: "turn", turnId: mainTurn.id },
      ...(candidatePolicy === null ? {} : { reviewPolicy: candidatePolicy }),
      ...(taskFinalContract === undefined
        ? {}
        : { taskFinalReviewContract: taskFinalContract }),
      ...(developWorkspace === null ? {} : { workspace: developWorkspace }),
      ...(options.candidateGitSnapshot === undefined
        ? {}
        : { gitSnapshot: options.candidateGitSnapshot }),
      ...(options.directTaskMainSnapshot === undefined
        ? {}
        : { taskMainSnapshot: options.directTaskMainSnapshot })
    }, now);
    tx.saveWorkItem(task.id, updated);
    recordTaskEvent(tx, task.id, "work.updated", {
      workItemId: updated.id,
      status: updated.status,
      summary: summary!,
      turnId: mainTurn.id,
      ...leaderActionEventPayload(tx, task.id, options)
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "work-updated", now, [
      workItemRef(task.id, updated.id),
      turnRef(task.id, mainTurn.id)
    ]);
    const reviewDispatch = candidatePolicy?.trigger === "always"
      ? queueReviewRound(tx, updated, candidatePolicy, "policy", now)
      : null;
    return {
      item: updated,
      reviewDispatch,
      reviewTrigger: candidatePolicy?.trigger ?? null
    };
  });
  notifyMailbox(options.runtime, taskMailbox(result.item.taskId), result.item.taskId);
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
  const usage = "Task work dispatch usage: yui task work dispatch <task>/<work> [--input <text>] [--lane-role <role> ...].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--input"]),
    new Set(["--lane-role"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const requestedLaneRoles = parsed.multiOptions.get("--lane-role") ?? [];
  const now = clock(options);
  const dispatch = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, item.taskId);
    taskActor(tx, options, task.id);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "dispatch"));
    assertTaskExecutionEnabled(task, "dispatching work");
    if (item.assignee === undefined) {
      throw usageError(
        `Work Item has no Task Role assignee: ${item.id}. `
        + `The Task Leader must run "yui task work update ${item.id} running" and execute it directly.`
      );
    }
    const lanePlan = planReplicatedWorkItemLanes(
      item.assignee,
      requestedLaneRoles,
      `execution-group-${tx.peekNextTurnId(task.id)}`
    );
    const currentGroup = currentWorkItemExecutionGroup(item);
    if (item.status !== "pending" && item.status !== "failed") {
      throw usageError(`Work item ${item.id} cannot be dispatched from ${item.status}.`);
    }
    if (currentGroup !== undefined && !workItemExecutionGroupSettled(currentGroup)) {
      throw usageError(
        `Work Item ${item.id} retains open ExecutionGroup ${currentGroup.id}; retry or settle its exact Lane Turns.`
      );
    }
    assertWorkItemDependenciesCompletedForCommand(tx, item);
    const leaderOwned = item.assignee === "leader";
    const workspace = leaderOwned
      ? tx.getTaskWorkspace(task.id)
      : tx.getWorkItemWorkspace(task.id, item.id);
    if (workspace === null) {
      throw usageError(
        leaderOwned
          ? `Leader-owned Work Item ${item.id} requires the Task main workspace.`
          : `Work Item ${item.id} must be isolated with its approved Project scope before dispatch.`
      );
    }
    const visible = workspace.entries.map(({ projectId }) => projectId).sort();
    const expectedVisible = task.projectBindings.map(({ projectId }) => projectId).sort();
    const writable = workspace.entries
      .filter(({ access }) => access === "write")
      .map(({ projectId }) => projectId)
      .sort();
    if (!isDeepStrictEqual(visible, expectedVisible)
      || !isDeepStrictEqual(writable, [...item.writeProjectIds].sort())) {
      throw usageError(`Work Item ${item.id} workspace does not match its approved Project scope.`);
    }
    const roles = lanePlan.roles.map((name) => requireRole(tx, task.id, name));
    for (const role of roles) {
      if (tx.getActiveTurn(task.id, role.name) !== null) {
        throw usageError(`${task.id}/${role.name} already has an active turn.`);
      }
    }
    const rawInput = trimmed(parsed.options.get("--input")) ?? item.objective;
    let workItemForDispatch = item.status === "failed"
      ? retryFailedWorkItem(item, now)
      : item;
    if (lanePlan.roles.length === 0) {
      const role = requireRole(tx, task.id, item.assignee);
      if (tx.getActiveTurn(task.id, role.name) !== null) {
        throw usageError(`${task.id}/${role.name} already has an active turn.`);
      }
      const effective = resolveEffectiveLaunch({
        role,
        purpose: "execution",
        workspace,
        workItemWriteProjectIds: item.writeProjectIds
      });
      const turnId = tx.nextTurnId(task.id);
      const turn = createTurn(
        turnId,
        task.id,
        role.name,
        roleAgentSessionResumeMode(
          tx.getTaskRoleSessionSet(task.id, role.name),
          effective.agentId,
          effective
        ),
        createTurnInput({
          source: { type: "yui", channel: "workitem-dispatch" },
          directive: rawInput,
          deltaRefIds: []
        }),
        now,
        {
          workItemId: item.id,
          workspace,
          effective
        }
      );
      const snapshot = freezeTurnContextSnapshot(tx, {
        taskId: task.id,
        roleName: turn.roleName,
        purpose: "execution",
        workItemId: item.id
      }, now, "controller");
      const withContext = withTurnContextSnapshot(
        turn,
        contextSnapshotRef(snapshot),
        contextSnapshotDeltaRefIds(tx, snapshot)
      );
      if (workItemForDispatch.status !== "running") {
        workItemForDispatch = updateWorkItemStatus(workItemForDispatch, "running", now);
      }
      tx.saveWorkItem(task.id, workItemForDispatch);
      tx.saveTurn(withContext);
      tx.saveActiveTurn(withContext);
      enqueueWork(tx, roleMailbox(task.id, role.name), "turn-dispatched", now, [
        turnRef(task.id, withContext.id),
        workItemRef(task.id, item.id)
      ]);
      recordTaskEvent(tx, task.id, "turn.dispatched", turnLaunchEventPayload(withContext), now);
      return { kind: "direct" as const, turns: [withContext] };
    }
    const groupId = `execution-group-${tx.peekNextTurnId(task.id)}`;
    if (workItemForDispatch !== item) {
      // Freeze the Assignment against the retried WorkItem revision. The
      // aggregate transaction rolls this back if a later precondition fails.
      tx.saveWorkItem(task.id, workItemForDispatch);
    }
    const assignmentContext = contextSnapshotRef(freezeWorkItemExecutionAssignmentContextSnapshot(tx, {
      taskId: task.id,
      workItemId: item.id,
      executionGroupId: groupId
    }, now));
    const plans = roles.map((role, index) => {
      const laneId = `${groupId}-lane-${index + 1}`;
      const managedWorkspace = options.executionLaneWorkspaces?.get(laneId);
      if (managedWorkspace === undefined && options.yuiHome !== undefined) {
        throw usageError(`Execution Lane workspace preflight is missing: ${groupId}/${laneId}.`);
      }
      const laneWorkspace = managedWorkspace ?? workspace;
      const effective = resolveEffectiveLaunch({
        role,
        purpose: "execution",
        workspace: laneWorkspace,
        workItemWriteProjectIds: item.writeProjectIds
      });
      return {
        role,
        laneId,
        managedWorkspace: laneWorkspace,
        effective,
        turnId: tx.nextTurnId(task.id),
        dispatchMode: roleAgentSessionResumeMode(
          tx.getTaskRoleSessionSet(task.id, role.name),
          effective.agentId,
          effective
        )
      };
    });
    const assignmentProjects = plans[0]!.managedWorkspace.entries
      .filter(({ projectId }) => item.writeProjectIds.includes(projectId))
      .map(({ projectId, baseCommit }) => ({ projectId, baseCommit }));
    if (plans.some(({ managedWorkspace }) => !isDeepStrictEqual(
      managedWorkspace.entries
        .filter(({ projectId }) => item.writeProjectIds.includes(projectId))
        .map(({ projectId, baseCommit }) => ({ projectId, baseCommit })),
      assignmentProjects
    ))) {
      throw usageError(`Execution Lane input heads disagree: ${groupId}.`);
    }
    const assignment = createWorkItemExecutionAssignment({
      input: replicatedProducerAssignmentInput(rawInput, item.writeProjectIds.length > 0),
      objective: item.objective,
      acceptance: item.acceptance,
      contextSnapshotRef: assignmentContext,
      taskId: task.id,
      workItemId: item.id,
      workItemRevision: workItemForDispatch.revision,
      projects: assignmentProjects,
      dependencyFacts: item.dependsOn.map((dependencyId) => {
        const dependency = requireWorkItem(tx, `${task.id}/${dependencyId}`, options);
        return { workItemId: dependency.id, revision: dependency.revision };
      })
    });
    const group = createWorkItemExecutionGroup(
      groupId,
      task.id,
      assignment,
      plans.map((plan): Readonly<{
        roleName: string;
        effective: EffectiveLaunchSnapshot;
        workspace: WorkItemExecutionLaneWorkspace;
        currentTurnId: string;
      }> => ({
        roleName: plan.role.name,
        effective: plan.effective,
        workspace: {
          root: plan.managedWorkspace.root,
          writableProjectIds: [...item.writeProjectIds]
        },
        currentTurnId: plan.turnId
      })),
      now
    );
    workItemForDispatch = attachWorkItemExecutionGroup(workItemForDispatch, group, now);
    if (workItemForDispatch.status !== "running") {
      workItemForDispatch = updateWorkItemStatus(workItemForDispatch, "running", now);
    }
    tx.saveWorkItem(task.id, workItemForDispatch);
    const turns = plans.map((plan, index) => {
      const turn = createTurn(
        plan.turnId,
        task.id,
        plan.role.name,
        plan.dispatchMode,
        createTurnInput({
          source: { type: "yui", channel: "workitem-dispatch" },
          directive: assignment.input,
          deltaRefIds: []
        }),
        now,
        {
          workItemId: item.id,
          executionGroupId: group.id,
          executionLaneId: group.lanes[index]!.id,
          workspace: plan.managedWorkspace,
          effective: plan.effective
        }
      );
      const snapshot = freezeTurnContextSnapshot(tx, {
        taskId: task.id,
        roleName: turn.roleName,
        purpose: "execution",
        workItemId: item.id
      }, now, "controller", assignment.contextSnapshotRef);
      const withContext = withTurnContextSnapshot(
        turn,
        contextSnapshotRef(snapshot),
        contextSnapshotDeltaRefIds(tx, snapshot)
      );
      const prepared = options.executionLaneWorkspaces?.get(group.lanes[index]!.id);
      if (prepared !== undefined && tx.getManagedWorkspace(prepared.owner) === null) {
        tx.saveManagedWorkspace(prepared);
      }
      tx.saveTurn(withContext);
      tx.saveActiveTurn(withContext);
      enqueueWork(tx, roleMailbox(task.id, plan.role.name), "turn-dispatched", now, [
        turnRef(task.id, withContext.id),
        workItemRef(task.id, item.id)
      ]);
      recordTaskEvent(tx, task.id, "turn.dispatched", turnLaunchEventPayload(withContext), now);
      return withContext;
    });
    return { kind: "replicated" as const, turns };
  });
  for (const turn of dispatch.turns) {
    notifyMailbox(options.runtime, roleMailbox(turn.taskId, turn.roleName), turn.taskId);
  }
  return dispatch.kind === "direct"
    ? `Direct WorkItem Turn queued as ${dispatch.turns[0]!.id}\n`
    : `Dispatch queued for ${dispatch.turns.length} replicated Lanes\n`;
}

function replicatedProducerAssignmentInput(input: string, requiresCodeRef: boolean): string {
  return [
    input,
    "",
    "Return the final result as one JSON object with: summary, checks, findings, evidence, and evidenceCommit.",
    "checks must list the validation commands and passed/failed/skipped outcomes.",
    requiresCodeRef
      ? "evidenceCommit must be the 40-character commit containing this Lane's clean final code."
      : "For a Gitless or read-only Lane, evidenceCommit may be omitted."
  ].join("\n");
}



function executionTargetForReviewRound(
  task: Task,
  round: ReviewRound,
  item?: WorkItem,
  candidate?: WorkItemCandidate
): ExecutionTarget {
  const taskScope = (round.scope ?? "work-item") === "task";
  if (!taskScope && (item === undefined || candidate === undefined)) {
    throw dataError(`WorkItem ReviewRound target is missing its Candidate: ${round.id}.`);
  }
  const projects = taskScope
    ? round.taskCandidate?.projects ?? []
    : candidate!.gitSnapshot?.projects ?? [];
  const fingerprint = JSON.stringify({
    taskId: task.id,
    reviewRoundId: round.id,
    ...(taskScope ? {} : { workItemId: item!.id, candidateId: candidate!.id }),
    scope: taskScope ? "task" : "work-item",
    projects,
    contractDigest: round.taskFinalReviewContract?.digest
  });
  return {
    schemaVersion: 1,
    kind: taskScope ? "task-final-review" : "work-item",
    taskId: task.id,
    ...(taskScope ? {} : { workItemId: item!.id, candidateId: candidate!.id }),
    // A Task-final ReviewRound is itself the immutable semantic target. Turns
    // retry that same revision; a changed frozen Task creates a new Round.
    revision: taskScope ? 1 : candidate!.workItemRevision,
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
    const actor = taskActor(tx, options, task.id);
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
      ...(candidate.source.type === "turn"
        ? { turnId: candidate.source.turnId }
        : { workItemRevision: String(candidate.workItemRevision) }),
      acceptedBy: actor,
      summary,
      ...(actor === "leader" ? leaderActionEventPayload(tx, item.taskId, options) : {})
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
    if (!store.listIntegrationAttempts(workspace.owner.taskId).some((integration) => (
      integration.status === "committed"
      && integration.projectId === entry.projectId
      && integration.source.kind === "work-item"
      && integration.source.workItemId === workItemId
      && integration.source.startCommit === projectProof.baseCommit
      && integration.source.resultCommit === projectProof.headCommit
    ))) {
      throw usageError(`Work Item result is not integrated: ${workItemId}/${entry.projectId}.`);
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
    const actor = taskActor(tx, options, task.id);
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
      rejectedBy: actor,
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
  const replacementReference = parsed.options.get("--replacement");
  const now = clock(options);
  const retired = store.transaction((tx) => {
    const item = requireWorkItem(tx, workItemId, options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active" && task.status !== "draft") {
      throw usageError(`Task is not open for Work Item retirement: ${task.id}/${task.status}.`);
    }
    if (task.status === "draft") assertDraftTaskExecutionFree(tx, task);
    const actor = taskActor(tx, options, task.id);
    const replacement = replacementReference === undefined
      ? undefined
      : requireWorkItem(tx, replacementReference, options);
    if (replacement !== undefined) {
      if (replacement.taskId !== task.id) {
        throw usageError(
          `Replacement Work Item must belong to the same Task: ${replacementReference}.`
        );
      }
      if (replacement.id === item.id) {
        throw usageError("A Work Item cannot replace itself.");
      }
    }
    // rr4/finding-5: A Work Item with an active DurableJob cannot be retired —
    // the runner may still be using its workspace. Block on queued, running,
    // and unacknowledged unknown-needs-attention jobs owned by this Work Item.
    if (task.status === "active") {
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
      for (const run of tx.listTurns(task.id).filter((candidate) => (
        candidate.status === "active" && candidate.workItemId === item.id
      ))) {
        const terminal = terminalizeExactTaskTurn(tx, {
          taskId: task.id,
          roleName: run.roleName,
          agentId: run.effective.agentId,
          turnId: run.id,
          outcome: {
            status: "failed",
            summary: `Work Item retired: ${summary}`
          }
        }, now);
        if (terminal.disposition !== "applied") {
          throw usageError(
            `Work Item Turn changed during retirement: ${run.id}/${terminal.reason ?? "obsolete"}.`
          );
        }
      }
    }
    const next = retireWorkItem(item, {
      by: actor,
      summary,
      ...(replacement === undefined ? {} : { replacementWorkItemId: replacement.id })
    }, now);
    if (next !== item) {
      tx.saveWorkItem(task.id, next);
      recordTaskEvent(tx, task.id, "work.retired", {
        workItemId: next.id,
        summary,
        ...(replacement === undefined
          ? {}
          : { replacementWorkItemId: replacement.id }),
        ...(actor === "leader" ? leaderActionEventPayload(tx, task.id, options) : { retiredBy: actor })
      }, now);
      tx.saveEvent(task.id, createTaskRecordRetirement({
        eventId: tx.nextEventId(task.id),
        taskId: task.id,
        recordKind: "work-item",
        recordId: next.id,
        reason: summary,
        retiredBy: actor
      }, now));
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
  const turns = store.listTurns(task.id);
  const sessionSets = store.listRoleSessionSets(task.id);
  const executions = items.map((item) => projectWorkItemExecution(item, turns, sessionSets));
  const rendered = items.length === 0
    ? "No work items found.\n"
    : `${renderTable(
        `Task work: ${task.id}`,
        [
          { header: "Work", minWidth: 6, maxWidth: 20 },
          { header: "Status", minWidth: 6, maxWidth: 12 },
          { header: "Role", minWidth: 4, maxWidth: 18 },
          { header: "Shape", minWidth: 6, maxWidth: 10 },
          { header: "Execution", minWidth: 12, maxWidth: 42 },
          { header: "Next / Owner", minWidth: 12, maxWidth: 36 },
          { header: "Title", minWidth: 8, maxWidth: 64 },
          { header: "Outcome", minWidth: 8, maxWidth: 40 }
        ],
        items.map((item, index) => [
          item.id,
          presentWorkStatus(item.status),
          item.assignee ?? "Leader",
          executions[index]!.shape,
          compactWorkItemExecution(executions[index]!),
          `${executions[index]!.nextAction.kind} / ${executions[index]!.nextAction.owners.join(",") || "none"}`,
          item.title,
          item.outcome ?? "-"
        ]),
        defaultTableWidth()
      )}\n`;
  return output(rendered, { workItems: items, executions });
}

function showWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task work show usage: yui task work show <work>.");
  const item = requireWorkItem(store, args[0], options);
  const execution = projectWorkItemExecution(
    item,
    store.listTurns(item.taskId),
    store.listRoleSessionSets(item.taskId)
  );
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
    ...renderWorkItemExecutionProjection(execution),
    `Acceptance: ${item.acceptance.length === 0 ? "-" : item.acceptance.join("; ")}`,
    `Outcome: ${item.outcome ?? "-"}`,
    `Retirement: ${item.disposition === undefined ? "-" : "retired"}`,
    `Replacement: ${replacement ?? "-"}`
  ].join("\n");
  return output(`${rendered}\n`, { workItem: item, execution });
}

function compactWorkItemExecution(projection: WorkItemExecutionProjection): string {
  if (projection.shape === "direct") return `main=${projection.mainTurn.status}`;
  const counts = projection.laneCounts;
  return `lanes ${counts.running}/${counts.succeeded}/${counts.needsAttention}/${counts.failed}/${counts.unknown}; ${projection.synthesis.status}`;
}

function renderWorkItemExecutionProjection(
  projection: WorkItemExecutionProjection
): string[] {
  return [
    `Execution Shape: ${projection.shape}`,
    ...(projection.groupId === undefined ? [] : [`Execution Group: ${projection.groupId}`]),
    ...(projection.lanes.length === 0
      ? ["Lanes: none"]
      : [
          `Lanes: running=${projection.laneCounts.running}, succeeded=${projection.laneCounts.succeeded}, needs-attention=${projection.laneCounts.needsAttention}, failed=${projection.laneCounts.failed}, unknown=${projection.laneCounts.unknown}`,
          ...projection.lanes.map((lane) => (
            `  ${lane.laneId} (#${lane.ordinal}, ${lane.roleName}): ${lane.status}; `
            + `turn=${lane.currentTurnId ?? "unknown"}; session=${lane.session}; `
            + `retry=${lane.retryTurnId ?? "none"}; settle=${lane.settleTurnId ?? "none"}`
          ))
        ]),
    `Synthesis: ${projection.synthesis.status}; successful=${projection.synthesis.successfulLaneCount}/${projection.synthesis.requiredSuccessfulLaneCount}`,
    `Main Turn: ${projection.mainTurn.turnId ?? "unobserved"} [${projection.mainTurn.status}]; role=${projection.mainTurn.roleName ?? "unobserved"}; session=${projection.mainTurn.session}; retry=${projection.mainTurn.retryTurnId ?? "none"}`,
    `Candidate Source: ${projection.candidate.candidateId ?? "none"} [${projection.candidate.status}]; source=${projection.candidate.sourceType ?? "unobserved"}; main=${projection.candidate.mainTurnId ?? "unobserved"}`,
    ...(projection.candidate.sourceExecutionGroupId === undefined
      ? []
      : [
          `Candidate Provenance: main ${projection.candidate.mainTurnId ?? "unobserved"} -> group ${projection.candidate.sourceExecutionGroupId} -> ${projection.candidate.successfulLaneTurns.map(({ laneId, successfulTurnId }) => `${laneId} -> ${successfulTurnId}`).join(", ") || "unobserved"}`
        ]),
    `Next Action: ${projection.nextAction.kind}; owner=${projection.nextAction.owners.join(", ") || "none"}; target=${projection.nextAction.targetIds.join(", ") || "none"}`
  ];
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
    const requestedBy = taskActor(tx, options, task.id);
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
      const resourceQueued = activeRound.executionGroup !== undefined
        && activeRound.executionGroup.resolution === undefined
        && activeRound.executionGroup.lanes.some((lane) => (
          lane.status === "pending"
          && lane.turnId === undefined
        ));
      if ((activeRound.status === "pending" && activeRound.reviewerTurnId === undefined)
        || (activeRound.status === "running" && resourceQueued)) {
        return { round: activeRound, resumed: true as const };
      }
      throw usageError(`ReviewRound is already active: ${activeRound.id}/${activeRound.status}.`);
    }
    const queued = queueReviewRound(
      tx,
      item,
      config,
      requestedBy,
      now
    );
    return { ...queued, resumed: false as const };
  });
  if (result.resumed) {
    return output(
      `Review request ${result.round.id} has pending Lanes; resuming dispatch.\n`,
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
 * Task-control recovery for a failed Task-final ReviewRound that never
 * created a Reviewer Turn. This is deliberately separate from `task turn retry`:
 * that command requires an exact failed Turn and remains the only retry
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
    taskActor(tx, options, task.id);
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
              .filter((lane) => lane.status === "completed")
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
      ...(round.workItemId === undefined ? [] : [workItemRef(task.id, round.workItemId)])
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
 * let the Leader inspect the ledger, disposition each finding, and plan one
 * convergent repair unit by default. Parallel fan-out is explicit.
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
  if (!TASK_CONTROL_FINDING_DISPOSITIONS.includes(disposition)) {
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
    const actor = taskActor(tx, options, task.id);
    const command: ReviewFindingDispositionCommand = {
      disposition,
      by: actor === "leader"
        ? taskLeaderActionTurnId(tx, task.id, options.environment, options.yuiHome) ?? actor
        : actor,
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
  const usage = "Task review finding repair-wave usage: yui task review finding repair-wave <task> [--strategy <consolidated|parallel>] [--create].";
  const parsed = parseTail(args, new Set(["--strategy"]), usage, new Set(["--create"]));
  exactPositionals(parsed.positionals, 1, usage);
  const task = requireTask(store, parsed.positionals[0]!);
  const strategy = parsed.options.get("--strategy") ?? "consolidated";
  if (strategy !== "consolidated" && strategy !== "parallel") {
    throw usageError(`Review repair strategy is invalid: ${strategy}.`, usage);
  }
  const groups = repairGroupsForStrategy(planRepairGroups(store, task.id), strategy);
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
      taskActor(tx, options, currentTask.id);
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
      `Review repair wave for ${task.id} (${strategy}, ${groups.length} group(s)):\n${lines.join("\n")}\n`,
      { strategy, groups: created }
    );
  }
  const lines = groups.map((group, index) => {
    const findings = group.findings
      .map((finding) => `${finding.id} [${finding.severity}] ${finding.title}`)
      .join("; ");
    return `wave ${index + 1}: ${findings}`
      + ` (paths: ${group.affectedPaths.join(", ") || "none"}; invariants: ${group.invariants.join(", ")})`;
  });
  return output(
    `Repair wave for ${task.id} (${strategy}, ${groups.length} group(s)):\n${lines.join("\n")}\n`
      + (strategy === "consolidated"
        ? "Default: keep all findings in one WorkItem; use --strategy parallel only for proven independent ownership.\n"
        : "Parallel strategy explicitly selected; each disjoint group may become one WorkItem.\n")
  );
}

function repairGroupsForStrategy(
  groups: readonly RepairGroup[],
  strategy: "consolidated" | "parallel"
): readonly RepairGroup[] {
  if (strategy === "parallel" || groups.length <= 1) return groups;
  const findings = groups.flatMap(({ findings }) => findings)
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  return [{
    groupKey: findings.map(({ id }) => id).join("+"),
    findings,
    findingIds: findings.map(({ id }) => id),
    affectedPaths: [...new Set(groups.flatMap(({ affectedPaths }) => affectedPaths))].sort(),
    affectedSymbols: [...new Set(groups.flatMap(({ affectedSymbols }) => affectedSymbols))].sort(),
    invariants: [...new Set(groups.flatMap(({ invariants }) => invariants))].sort()
  }];
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
    const requestedBy = taskActor(tx, options, task.id);
    if (task.projectBindings.length === 0) {
      throw usageError(`Task ${task.id} has no bound Projects for a Task-final Review.`);
    }
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (deltaRecheckRequested) {
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
    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id))
      .filter((entry) => (entry.scope ?? "work-item") === "task");
    const latestNonAcceptingDelta = deltaRecheckRequested
      ? undefined
      : taskRounds.filter((entry) => (
          entry.reviewerRoleName === reviewerRoleName
          && entry.deltaRecheck !== undefined
          && deltaRecheckBlocksAcceptance(entry)
          && isSameTaskReviewCandidate(entry.taskCandidate, provenance.candidate)
        )).at(-1);
    const exact = taskRounds.filter((entry) => (
      entry.reviewerRoleName === reviewerRoleName
      && (deltaRecheckRequested
        ? entry.deltaRecheck !== undefined
        : entry.deltaRecheck === undefined)
      && (taskFinalContract === undefined || sameTaskFinalReviewContract(
        entry.taskFinalReviewContract,
        taskFinalContract
      ))
      && isSameTaskReviewCandidate(entry.taskCandidate, provenance.candidate)
    )).at(-1);
    if (exact?.status === "failed") {
      throw usageError(
        `Explicit Task-final ReviewRound ${exact.id} is failed for this exact candidate; resolve it before requesting again.`
      );
    }
    if (exact !== undefined
      && (exact.status === "pending" || exact.status === "running")) {
      assertNoConflictingTaskReviewRound(taskRounds, exact.id, reviewerRoleName);
      if (requestedLaneRoles.length === 0) {
        if (exact.status === "running"
          && exact.executionGroup?.resolution === undefined
          && exact.executionGroup?.lanes.some((lane) => (
            lane.status === "pending" && lane.turnId === undefined
          ))) return exact;
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
      for (const laneRoleName of laneRoles) {
        const existingLane = exact.executionGroup.lanes.find(({ roleName }) => (
          roleName === laneRoleName
        ));
        if (existingLane !== undefined) {
          if (existingLane.turnId === undefined) continue;
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
          const availability = projectReviewerAvailability(tx, task.id, laneRoleName);
          if (availability.kind === "busy") return availability;
        }
      }
      let appended = exact.executionGroup;
      for (const laneRoleName of laneRoles) {
        if (appended.lanes.some(({ roleName }) => roleName === laneRoleName)) continue;
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
      const updated = updateReviewExecutionGroup(exact, appended);
      tx.saveReviewRound(task.id, updated);
      return updated;
    }
    const primaryAvailability = projectReviewerAvailability(tx, task.id, reviewerRoleName);
    if (primaryAvailability.kind === "busy") return primaryAvailability;
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
      const availability = projectReviewerAvailability(tx, task.id, laneRoleName);
      if (availability.kind === "busy") return availability;
      if (taskReviewProducerCollision(provenance, laneRoleName) !== null) {
        throw usageError(`Reviewer Role must be separate from the Candidate producer: ${laneRoleName}.`);
      }
    }
    for (const laneRoleName of laneRoles) {
      if (tx.getRole(task.id, laneRoleName) === null) {
        tx.saveRole(task.id, createTaskRole(
          tx,
          task,
          laneRoleName,
          undefined,
          now,
          laneRoleName
        ));
      }
    }
    let deltaRecord: DeltaRecheckPreflight["record"] | undefined;
    if (deltaRecheckRequested) {
      if (requestedLaneRoles.length > 0 || requestedStrategy !== undefined) {
        throw usageError("Delta-recheck supports only the default single Reviewer Lane.");
      }
      deltaRecord = validateDeltaRecheckRequest(
        tx,
        task.id,
        provenance.candidate,
        options.deltaRecheckPreflight
      );
    }
    let created = deltaRecord === undefined
      ? createTaskReviewRound(
          tx.nextReviewRoundId(task.id),
          task.id,
          reviewerRoleName,
          requestedBy,
          provenance.candidate,
          now,
          taskFinalContract
        )
      : createTaskDeltaReviewRound(
          tx.nextReviewRoundId(task.id),
          task.id,
          reviewerRoleName,
          requestedBy,
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
        target: executionTargetForReviewRound(task, created),
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
    if (latestNonAcceptingDelta !== undefined
      && created.deltaRecheck === undefined
      && latestNonAcceptingDelta.deltaRecheck !== undefined
      && latestNonAcceptingDelta.deltaRecheck.escalatedToReviewRoundId === undefined) {
      tx.saveReviewRound(task.id, {
        ...latestNonAcceptingDelta,
        deltaRecheck: {
          ...latestNonAcceptingDelta.deltaRecheck,
          escalatedToReviewRoundId: created.id
        }
      });
    }
    recordTaskEvent(tx, task.id, "review.task-final-requested", {
      reviewRoundId: created.id,
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
  if ("kind" in round && round.kind === "busy") {
    return output(
      `Reviewer ${round.reviewerRoleName} is busy (${round.phase}`
        + `${round.activeTurnId === undefined ? "" : `; Turn ${round.activeTurnId}`}); `
        + `${round.activeReviewRoundId === undefined
          ? ""
          : `active ReviewRound ${round.activeReviewRoundId}; `}`
        + `retry after ${round.retryAfterSeconds}s or choose another Reviewer.\n`,
      { reviewRequest: round }
    );
  }
  const requestedRound = round as ReviewRound;
  return output(
    requestedRound.status === "pending"
      ? requestedRound.deltaRecheck === undefined
        ? `Task-final Review requested as ${requestedRound.id}\n`
        : `Task-final delta-recheck requested as ${requestedRound.id} (rechecks ${requestedRound.deltaRecheck.previousReviewRoundId})\n`
      : `Task-final Review is already ${requestedRound.status}: ${requestedRound.id}\n`,
    { reviewRound: requestedRound }
  );
}

const TASK_FINAL_FORCE_FRESH_EVENT = "review.task-final-force-fresh-requested";

/**
 * Creates a distinct full Task-final ReviewRound only when the exact previous
 * terminal Round durably proves that no semantic review was produced. The
 * source Round, Turn, findings, workspace, and terminal report remain immutable
 * history; the linking Event is both the audit record and the idempotence key.
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
    const requestedBy = taskActor(tx, options, task.id);
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
        || replacement.reviewerRoleName !== source.reviewerRoleName
        || replacement.deltaRecheck !== undefined
        || !sameTaskFinalReviewContract(
          replacement.taskFinalReviewContract,
          source.taskFinalReviewContract
        )
        || !isSameTaskReviewCandidate(replacement.taskCandidate, source.taskCandidate!)
        || replacementEvent.payload.reviewerRoleName !== replacement.reviewerRoleName
        || replacementEvent.payload.taskCandidate !== JSON.stringify(replacement.taskCandidate)) {
        throw dataError(`Force-fresh audit for ${source.id} does not match its replacement Round.`);
      }
      return { round: replacement, source, created: false } as const;
    }

    const recovery = classifyForceFreshReviewRecovery(tx, source);
    if (recovery.kind === "semantic-or-ambiguous") {
      throw usageError(
        `ReviewRound ${source.id} is not eligible for force-fresh: ${recovery.reason}`
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

    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((entry) => (entry.scope ?? "work-item") === "task"));
    const sourceIndex = taskRounds.findIndex(({ id }) => id === source.id);
    if (sourceIndex < 0) {
      throw dataError(`Final ReviewRound is not in Task history: ${source.id}.`);
    }
    const laterRound = taskRounds.slice(sourceIndex + 1).find((entry) => (
      entry.reviewerRoleName === source.reviewerRoleName
    ));
    if (laterRound !== undefined) {
      throw usageError(
        `A newer Task-final ReviewRound already exists after ${source.id}: `
        + `${laterRound.id}/${laterRound.status}.`
      );
    }
    assertNoConflictingTaskReviewRound(taskRounds, source.id, source.reviewerRoleName);
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
      source.reviewerRoleName,
      requestedBy,
      source.taskCandidate,
      now,
      taskFinalContract
    );
    const group = createExecutionGroup(
      `execution-group-${created.id}`,
      task.id,
      {
        purpose: "review",
        target: executionTargetForReviewRound(task, created),
        strategy: { mode: "fixed", count: 1 },
        lanes: [{ roleName: reviewer.name, reviewRoundId: created.id }]
      },
      now
    );
    created = { ...created, executionGroup: group };
    tx.saveReviewRound(task.id, created);
    recordTaskEvent(tx, task.id, TASK_FINAL_FORCE_FRESH_EVENT, {
      sourceReviewRoundId: source.id,
      ...(source.reviewerTurnId === undefined ? {} : { sourceReviewerTurnId: source.reviewerTurnId }),
      reviewRoundId: created.id,
      reviewerRoleName: created.reviewerRoleName,
      taskCandidate: JSON.stringify(created.taskCandidate),
      reason: "source-round-terminal-without-semantic-review",
      requestedBy,
      ...(requestedBy === "leader" ? leaderActionEventPayload(tx, task.id, options) : {})
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

export type ForceFreshReviewRecoveryClassification =
  | Readonly<{ kind: "non-semantic-terminal"; reason: string }>
  | Readonly<{ kind: "semantic-or-ambiguous"; reason: string }>;

type ForceFreshReviewEvidenceStore = Pick<
  TaskWorkflowStore,
  "listTurns" | "listReviewFindings" | "listEvents"
>;

/**
 * Conservatively classifies an immutable Task-final Review as replaceable.
 * A failed Round keeps the existing no-semantic-evidence behavior. A completed
 * Round needs stronger, mutually corroborating evidence: an explicit internal
 * context/workspace failure, its exact completed Turn, matching Lane
 * output, and the mechanically emitted empty completion Event.
 * This is command eligibility only; it never rewrites the source outcome or
 * changes the global semantic classifier used by the finding ledger.
 */
export function classifyForceFreshReviewRecovery(
  store: ForceFreshReviewEvidenceStore,
  round: ReviewRound
): ForceFreshReviewRecoveryClassification {
  const classification = classifyReviewRoundOutcome(round, store);
  return classification?.kind === "non-semantic"
    ? { kind: "non-semantic-terminal", reason: classification.reason }
    : {
        kind: "semantic-or-ambiguous",
        reason: classification?.reason ?? `source status is ${round.status}, not terminal.`
      };
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
  candidate: TaskReviewCandidate,
  preflight: DeltaRecheckPreflight | undefined
): DeltaRecheckPreflight["record"] {
  if (preflight === undefined) {
    throw usageError(
      "Delta-recheck assessment is missing; the CLI preflight did not turn. "
      + "Request a full Review or retry with a current CLI."
    );
  }
  const previous = store.getReviewRound(taskId, preflight.record.previousReviewRoundId);
  if (previous === null
    || !isAcceptedTaskReviewBaseline(store, previous)) {
    throw usageError(
      `Delta-recheck previous ReviewRound is not an accepted Task-final baseline: `
      + `${preflight.record.previousReviewRoundId}.`
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
      + `${previous.deltaRecheck.disposition}. The Leader must choose the next Review action.`
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
  const activePointer = store.getActiveTurn(taskId, reviewerRoleName);
  const activeTurns = store.listTurns(taskId).filter((entry) => (
    entry.roleName === reviewerRoleName && entry.status === "active"
  ));
  if (reusableRound === undefined || reusableRound.status === "pending") {
    if (activePointer !== null || activeTurns.length > 0
      || hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
      throw usageError(`Reviewer has unrelated active execution: ${reviewerRoleName}.`);
    }
    return;
  }
  if (reusableRound.status === "completed") {
    if (activePointer !== null || activeTurns.length > 0
      || hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
      throw usageError(`Reviewer has unrelated active execution: ${reviewerRoleName}.`);
    }
    return;
  }
  const reviewerTurnId = reusableRound.reviewerTurnId;
  const activeMatches = reviewerTurnId !== undefined
    && activePointer?.id === reviewerTurnId
    && activePointer.status === "active"
    && activeTurns.length === 1
    && activeTurns[0]!.id === reviewerTurnId;
  if (!activeMatches) {
    throw usageError(
      `Existing Task-final ReviewRound ${reusableRound.id} is running without its exact Reviewer execution.`
    );
  }
  const exactTurn = turnRef(taskId, reviewerTurnId!);
  const reviewerPending = reviewerMailbox === null ? null : nextPendingBatch(reviewerMailbox);
  const processingMatches = reviewerMailbox?.processing !== null
    && reviewerMailbox?.processing !== undefined
    && reviewerPending === null
    && reviewerMailbox.processing.executionRef !== undefined
    && isDeepStrictEqual(reviewerMailbox.processing.executionRef, exactTurn);
  const pendingMatches = reviewerPending !== null
    && reviewerMailbox?.processing === null
    && reviewerPending.requestCount === 1
    && reviewerPending.refs.some((ref) => isDeepStrictEqual(ref, exactTurn));
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
    const requestedBy = taskActor(tx, options, task.id);
    if ((round.scope ?? "work-item") !== "task") {
      throw usageError(`ReviewRound ${round.id} is not a failed Task-final ReviewRound.`);
    }
    if (round.reviewerTurnId !== undefined) {
      if (round.status === "completed") {
        throw usageError(`ReviewRound ${round.id} is not retryable from ${round.status}.`);
      }
      throw usageError(
        `ReviewRound ${round.id} has Reviewer Turn ${round.reviewerTurnId}; use task turn retry instead.`
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

    const reviewerRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id));
    const roundIndex = reviewerRounds.findIndex((entry) => entry.id === round.id);
    if (roundIndex < 0) {
      throw dataError(`Final ReviewRound is not in Task history: ${round.id}.`);
    }
    // Issue 06: infra retries reuse the same semantic Round ID. Any later
    // Round supersedes this one; an active Round for the same Reviewer blocks.
    const conflictingLater = reviewerRounds.slice(roundIndex + 1).find((entry) => (
      entry.reviewerRoleName === round.reviewerRoleName
    ));
    if (conflictingLater !== undefined) {
      throw usageError(
        `A newer conflicting final ReviewRound already exists after ${round.id}: `
        + `${conflictingLater.id}/${conflictingLater.status}.`
      );
    }
    assertNoConflictingTaskReviewRound(reviewerRounds, round.id, round.reviewerRoleName);
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
    const activeReviewerTurns = tx.listTurns(task.id).filter((entry) => (
      entry.roleName === reviewer.name && entry.status === "active"
    ));
    const activePointer = tx.getActiveTurn(task.id, reviewer.name);

    if (activePointer !== null || activeReviewerTurns.length > 0) {
      throw usageError(`Reviewer Role already has an active Turn: ${reviewer.name}.`);
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
    const resetRound = retryTaskReviewRound(round, requestedBy);
    tx.saveReviewRound(task.id, resetRound);
    recordTaskEvent(tx, task.id, "review.task-final-retried", {
      reviewRoundId: round.id
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

function taskTurnCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") return output(listTurns(rest, store, options));
  if (command === "show") return showTurn(rest, store, options);
  if (command === "context") return turnContextCommand(rest, store, options);
  if (command === "retry") return retryTurn(rest, store, options);
  if (command === "settle") return settleTurn(rest, store, options);
  if (command === "checkpoint") return output(checkpointTurn(rest, store, options));
  if (command === "retire") return retireTurn(rest, store, options);
  throw usageError(command === undefined
    ? "Task turn command is required."
    : `Unknown command: task turn ${command}`);
}

function settleTurn(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task turn settle usage: yui task turn settle <task>/<turn>.");
  const previous = store.transaction((tx) => requireTurn(tx, args[0], options));
  if (previous.purpose === "review") {
    return settleStaleFinalReviewTurn(args, store, options);
  }
  return settleFailedExecutionLaneTurn(previous, store, options);
}

function settleFailedExecutionLaneTurn(
  previous: Turn,
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const now = clock(options);
  const result = store.transaction((tx) => {
    const run = tx.getTurn(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "execution") {
      throw usageError(`Turn ${previous.id} is not a failed execution Turn.`);
    }
    if (run.workItemId === undefined
      || run.executionGroupId === undefined
      || run.executionLaneId === undefined
      || run.sourceExecutionGroupId !== undefined) {
      throw usageError(`Turn ${run.id} is not a failed WorkItem Execution Lane Turn.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const actor = taskActor(tx, options, task.id);
    const item = tx.getWorkItem(task.id, run.workItemId);
    if (item === null) throw dataError(`Work item not found for Turn ${run.id}: ${run.workItemId}.`);
    const group = currentWorkItemExecutionGroup(item);
    if (group === undefined || group.id !== run.executionGroupId) {
      throw usageError(`Turn ${run.id} no longer belongs to the current ExecutionGroup.`);
    }
    const lane = group.lanes.find(({ id }) => id === run.executionLaneId);
    if (lane === undefined || lane.currentTurnId !== run.id) {
      throw usageError(`Turn ${run.id} no longer owns its Execution Lane.`);
    }
    if (lane.disposition === "failed") {
      return {
        turn: run,
        workItem: item,
        changed: false,
        mainTurns: [] as readonly Turn[]
      } as const;
    }
    if (item.status !== "running" || lane.disposition !== "open") {
      throw usageError(
        `Turn ${run.id} cannot settle ${item.id}/${group.id}/${lane.id} from `
        + `${item.status}/${lane.disposition}.`
      );
    }
    if (tx.getActiveExecutionLaneTurn(task.id, group.id, lane.id) !== null) {
      throw usageError(`Execution Lane still has an active Turn: ${group.id}/${lane.id}.`);
    }
    const settledGroup = updateWorkItemExecutionLane(group, lane.id, {
      currentTurnId: run.id,
      disposition: "failed"
    }, now);
    const settledItem = updateWorkItemExecutionGroup(item, settledGroup, now);
    tx.saveWorkItem(task.id, settledItem);
    recordTaskEvent(tx, task.id, "turn.execution-settled", {
      turnId: run.id,
      workItemId: item.id,
      executionGroupId: group.id,
      executionLaneId: lane.id,
      settledBy: actor,
      ...(actor === "leader" ? leaderActionEventPayload(tx, task.id, options) : {})
    }, now);
    const reconciliation = reconcileWorkItemMainTurns(tx, task.id, now);
    return {
      turn: run,
      workItem: tx.getWorkItem(task.id, item.id) ?? settledItem,
      changed: true,
      mainTurns: reconciliation.createdTurns
    } as const;
  });
  for (const turn of result.mainTurns) {
    notifyMailbox(options.runtime, roleMailbox(turn.taskId, turn.roleName), turn.taskId);
  }
  return output(
    result.changed
      ? `Settled failed Execution Lane from Turn ${result.turn.id}\n`
      : `Failed Execution Lane already settled from Turn ${result.turn.id}\n`,
    {
      turn: result.turn,
      workItem: result.workItem,
      ...(result.mainTurns.length === 0 ? {} : { mainTurns: result.mainTurns })
    }
  );
}

function retireTurn(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task turn retire usage: yui task turn retire <task>/<turn> --reason <text> [--expected-progress-at <timestamp>] [--agent-id <id>] [--adapter-id <id>] [--native-session-id <id>] [--launch-id <id>].";
  const parsed = parseTail(args, new Set([
    "--reason",
    "--expected-progress-at",
    "--progress-at",
    "--agent-id",
    "--adapter-id",
    "--native-session-id",
    "--launch-id"
  ]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const reason = requiredOption(parsed.options, "--reason");
  const reference = taskRecordReference(
    parsed.positionals[0],
    "turn",
    "Turn reference",
    options
  );
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, reference.taskId);
    assertTaskOpen(task);
    const actor = taskActor(tx, options, task.id);
    let run = tx.getTurn(task.id, reference.localId);
    if (run === null) throw dataError(`Turn not found: ${task.id}/${reference.localId}.`);
    const events = tx.listEvents(task.id);
    if (isTaskRecordRetired(events, "turn", run.id)) {
      return { task, turn: run, changed: false } as const;
    }
    if (run.status === "active") {
      if (actor === "leader"
        && taskLeaderActionTurnId(tx, task.id, options.environment, options.yuiHome) === run.id) {
        throw usageError("A Task Leader cannot retire its own current authority Turn.", usage);
      }
      const expectedProgressAt = requiredOption(
        parsed.options,
        parsed.options.has("--expected-progress-at")
          ? "--expected-progress-at"
          : "--progress-at"
      );
      if (parsed.options.has("--expected-progress-at") && parsed.options.has("--progress-at")) {
        throw usageError(
          "--expected-progress-at and --progress-at are mutually exclusive.",
          usage
        );
      }
      const agentId = requiredOption(parsed.options, "--agent-id");
      const adapterId = requiredOption(parsed.options, "--adapter-id");
      const nativeSessionId = parsed.options.get("--native-session-id");
      const launchId = parsed.options.get("--launch-id");
      const sessions = tx.getTaskRoleSessionSet(task.id, run.roleName);
      const session = sessions?.sessions[run.effective.agentId];
      if (session?.nativeSessionId !== undefined && nativeSessionId === undefined) {
        throw usageError("--native-session-id is required for this active Turn.", usage);
      }
      if (session?.nativeSessionId === undefined && launchId === undefined) {
        throw usageError("--launch-id is required for an opaque active Turn.", usage);
      }
      const terminal = retireExactActiveTurn(tx, {
        taskId: task.id,
        roleName: run.roleName,
        turnId: run.id,
        agentId,
        adapterId,
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
        ...(launchId === undefined ? {} : { launchId }),
        expectedProgressAt,
        reason: `Turn retired: ${reason}`
      }, now);
      if (terminal.disposition !== "applied" || terminal.turn === null) {
        throw usageError(
          terminal.disposition === "blocked"
            ? `Turn retirement is blocked: ${run.id}/${terminal.reason ?? "unsafe"}.`
            : `Turn changed during retirement: ${run.id}/${terminal.reason ?? "obsolete"}.`
        );
      }
      run = terminal.turn;
    }
    recordTaskEvent(tx, task.id, "turn.retired", {
      turnId: run.id,
      reason,
      ...(parsed.options.get("--expected-progress-at") === undefined
        && parsed.options.get("--progress-at") === undefined
        ? {}
        : {
            expectedProgressAt: parsed.options.get("--expected-progress-at")
              ?? parsed.options.get("--progress-at")!
          }),
      ...(parsed.options.get("--native-session-id") === undefined
        ? {}
        : { nativeSessionId: parsed.options.get("--native-session-id")! }),
      ...(parsed.options.get("--launch-id") === undefined
        ? {}
        : { launchId: parsed.options.get("--launch-id")! }),
      ...(actor === "leader"
        ? leaderActionEventPayload(tx, task.id, options)
        : { retiredBy: actor })
    }, now);
    tx.saveEvent(task.id, createTaskRecordRetirement({
      eventId: tx.nextEventId(task.id),
      taskId: task.id,
      recordKind: "turn",
      recordId: run.id,
      reason,
      retiredBy: actor
    }, now));
    return { task, turn: run, changed: true } as const;
  });
  if (result.changed) options.runtime?.notifyStateChanged(result.task.id);
  return output(`Retired Turn ${result.task.id}/${result.turn.id}\n`, {
    turn: result.turn,
    retired: true
  });
}

function turnContextCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [first, ...rest] = args;
  if (first === "expand") {
    const usage = "Task turn context expand usage: yui task turn context expand <task>/<turn> <ref-id> [--store <store>] [--mode full].";
    const parsed = parseTail(rest, new Set(["--store", "--mode"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const mode = parsed.options.get("--mode");
    if (mode !== undefined && mode !== "full") {
      throw usageError("Turn Context expansion mode must be full.", usage);
    }
    const { taskId, turnId } = parseTurnContextReference(parsed.positionals[0]!);
    authorizeTurnContext(store, taskId, turnId, options.environment);
    const expanded = store.transaction((tx) => expandTurnContextRef(
      tx,
      taskId,
      turnId,
      parsed.positionals[1]!,
      optionalNonEmptyOption(parsed.options, "--store")
    ));
    return output(`${JSON.stringify(expanded, null, 2)}\n`, { context: expanded });
  }
  if (first === "delta") {
    if (rest.length !== 3 || rest[1] !== "--after") {
      throw usageError(
        "Task turn context delta usage: yui task turn context delta <task>/<turn> --after <cursor>."
      );
    }
    const { taskId, turnId } = parseTurnContextReference(rest[0]!);
    authorizeTurnContext(store, taskId, turnId, options.environment);
    const delta = store.transaction((tx) => (
      buildTurnContextDelta(tx, taskId, turnId, rest[2]!)
    ));
    return output(`${JSON.stringify(delta, null, 2)}\n`, { contextDelta: delta });
  }
  if (first === undefined || rest.length !== 0) {
    throw usageError("Task turn context usage: yui task turn context <task>/<turn>.");
  }
  const { taskId, turnId } = parseTurnContextReference(first);
  authorizeTurnContext(store, taskId, turnId, options.environment);
  const pack = store.transaction((tx) => buildTurnContextPack(tx, taskId, turnId));
  return output(`${JSON.stringify(pack, null, 2)}\n`, { context: pack });
}

function parseTurnContextReference(value: string): { taskId: string; turnId: string } {
  const [taskId, turnId, extra] = value.split("/");
  if (taskId === undefined || taskId.length === 0 || turnId === undefined || turnId.length === 0
    || extra !== undefined) {
    throw usageError(`Turn context reference is invalid: ${value}.`);
  }
  return { taskId, turnId };
}

function authorizeTurnContext(
  store: TaskWorkflowStore,
  taskId: string,
  turnId: string,
  environment: NodeJS.ProcessEnv | undefined
): void {
  const managed = environment?.YUI_SESSION_SCOPE !== undefined
    || environment?.YUI_TASK_ID !== undefined
    || environment?.YUI_ROLE !== undefined
    || environment?.YUI_TURN_ID !== undefined;
  if (!managed) return;
  const run = store.getTurn(taskId, turnId);
  const active = run === null ? null : store.getActiveTurn(taskId, run.roleName);
  if (environment?.YUI_SESSION_SCOPE !== "task"
    || environment.YUI_TASK_ID !== taskId
    || run === null
    || environment.YUI_ROLE !== run.roleName
    || environment.YUI_AGENT_ID !== run.effective.agentId
    || environment.YUI_ADAPTER_ID !== run.effective.adapterId
    || run.status !== "active"
    || active?.id !== turnId) {
    throw usageError(`Turn Context access is not authorized: ${taskId}/${turnId}.`);
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
    throw usageError(`Turn Context caller key is not authorized: ${taskId}/${turnId}.`);
  }
}

function listTurns(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task turn list usage: yui task turn list <task|task/work>.";
  exactPositionals(args, 1, usage);
  const reference = args[0]!;
  const task = store.getTask(reference);
  const item = task === null ? requireWorkItem(store, reference, options) : null;
  const taskId = task?.id ?? item!.taskId;
  const turns = store.listTurns(taskId).filter((turn) => (
    item === null || turn.workItemId === item.id
  ));
  if (turns.length === 0) return "No Turns found.\n";
  const events = store.listEvents(taskId);
  return `${renderTable(
    `Turns: ${item?.id ?? taskId}`,
    [
      { header: "Turn", minWidth: 6, maxWidth: 20 },
      { header: "Role", minWidth: 4, maxWidth: 22 },
      { header: "Subject", minWidth: 7, maxWidth: 24 },
      { header: "Purpose", minWidth: 6, maxWidth: 10 },
      { header: "Mode", minWidth: 4, maxWidth: 8 },
      { header: "Effective", minWidth: 10, maxWidth: 30 },
      { header: "Profile", minWidth: 7, maxWidth: 8 },
      { header: "Permission", minWidth: 8, maxWidth: 16 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "History", minWidth: 7, maxWidth: 9 },
      { header: "Summary", minWidth: 8, maxWidth: 58 }
    ],
    turns.map((run) => [
      run.id,
      run.roleName,
      run.workItemId ?? (run.reviewRoundId === undefined ? "task" : `review:${run.reviewRoundId}`),
      run.purpose,
      run.mode,
      `${run.effective.agentId}/${run.effective.adapterId} r${run.effective.sourceDesiredRevision}`,
      run.effective.profileAccess,
      run.effective.permission.strategy,
      run.status,
      isTaskRecordRetired(events, "turn", run.id) ? "retired" : "active",
      run.result?.output ?? "-"
    ]),
    defaultTableWidth()
  )}\n`;
}

/**
 * Settles only the known bootstrap split where a failed Task-final Turn
 * still owns a running ReviewRound, but the committed Task heads have moved
 * on. This is deliberately narrower than retry: it cannot manufacture a
 * review or fail an arbitrary Round, and every identity/mailbox fence is
 * checked before the old Round changes. The next normal Task completion then
 * creates one fresh Round over the newer frozen Task heads.
 */
function settleStaleFinalReviewTurn(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task turn settle usage: yui task turn settle <task>/<turn>.");
  const now = clock(options);
  const previous = store.transaction((tx) => requireTurn(tx, args[0], options));
  const result = store.transaction((tx) => {
    const run = tx.getTurn(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "review") {
      throw usageError(`Turn ${previous.id} is not a failed review Turn.`);
    }
    if (run.reviewRoundId === undefined) {
      throw usageError(`Review Turn ${run.id} has no ReviewRound.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const actor = taskActor(tx, options, task.id);
    const round = tx.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) {
      throw dataError(`ReviewRound not found for Turn ${run.id}: ${run.reviewRoundId}.`);
    }
    if ((round.scope ?? "work-item") !== "task") {
      throw usageError(
        `Review Turn ${run.id} is not a Task-final review; request a new WorkItem review `
        + "for a new Candidate."
      );
    }
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (!sameTaskFinalReviewContract(round.taskFinalReviewContract, taskFinalContract)) {
      throw usageError(`Task final-review contract does not match ReviewRound ${round.id}.`);
    }
    // This read-only compare-and-swap fence covers the exact Turn/Round,
    // Candidate, stored Review workspace, frozen Project scope, and frozen
    // Project heads before any mailbox or Round write.
    const validation = validateExactTurnReviewRound(tx, run, { allowTerminal: true });
    if (validation.disposition !== "applied" || validation.round === null) {
      throw usageError(
        `Review Turn ${run.id} identity does not match its ReviewRound or frozen Task state changed: ${validation.reason ?? "mismatch"}.`
      );
    }
    const activeReviewerTurn = tx.listTurns(task.id).find((entry) => (
      entry.purpose === "review"
      && entry.roleName === round.reviewerRoleName
      && entry.status === "active"
    ));
    const activeRoleTurn = tx.getActiveTurn(task.id, round.reviewerRoleName);
    if (activeReviewerTurn !== undefined || activeRoleTurn !== null) {
      const active = activeReviewerTurn ?? activeRoleTurn!;
      throw usageError(
        `${task.id}/${round.reviewerRoleName} already has active Turn ${active.id}.`
      );
    }

    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((entry) => (entry.scope ?? "work-item") === "task"));
    const roundIndex = taskRounds.findIndex(({ id }) => id === round.id);
    if (roundIndex < 0) {
      throw dataError(`Final ReviewRound is not in Task history: ${round.id}.`);
    }
    const laterRound = taskRounds.slice(roundIndex + 1).find((entry) => (
      entry.reviewerRoleName === round.reviewerRoleName
    ));
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
      const summary = run.result?.output.trim();
      if (summary !== undefined
        && round.summary === summary
        && round.report === summary
        && (round.checks?.length ?? 0) === 0
        && round.evidenceCommit === undefined) {
        return { turn: run, round, changed: false } as const;
      }
      throw usageError(`Final ReviewRound is already terminal: ${round.id}/${round.status}.`);
    }
    if (round.status !== "running") {
      throw usageError(`Final ReviewRound is not stranded running: ${round.id}/${round.status}.`);
    }

    const reviewerTarget = roleMailbox(task.id, round.reviewerRoleName);
    const reviewerMailbox = tx.getWorkMailbox(reviewerTarget);
    const reviewerPending = reviewerMailbox === null ? null : nextPendingBatch(reviewerMailbox);
    const exactTurnRef = turnRef(task.id, run.id);
    if (reviewerMailbox?.processing !== null && reviewerMailbox?.processing !== undefined) {
      const processing = reviewerMailbox.processing;
      if (
        processing.executionRef === undefined
        || !isDeepStrictEqual(processing.executionRef, exactTurnRef)
        || reviewerPending !== null
      ) {
        throw usageError(`Reviewer mailbox has unrelated processing work: ${round.reviewerRoleName}.`);
      }
    } else if (reviewerPending !== null) {
      const pending = reviewerPending;
      if (
        pending.requestCount !== 1
        || !pending.refs.some((ref) => isDeepStrictEqual(ref, exactTurnRef))
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

    // A matching pending/processing dispatch belongs to this failed Turn and
    // is safe to settle here. It is never merged with unrelated mailbox work.
    if (reviewerMailbox !== null && reviewerMailbox !== undefined) {
      const settlement = settleExactWorkExecution(tx, reviewerTarget, exactTurnRef);
      if (settlement === "absent") {
        throw usageError(`Reviewer mailbox changed before stale final settlement: ${round.reviewerRoleName}.`);
      }
    }

    // Preserve any report/check/evidence already attached to the old Round;
    // terminalization only adds the missing failure boundary and end time.
    const summary = round.summary
      ?? run.result?.output
      ?? `Review Turn ${run.id} failed before delivery; committed Task heads changed.`;
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
    recordTaskEvent(tx, task.id, "turn.review-stale-settled", {
      turnId: run.id,
      reviewRoundId: round.id,
      previousTaskCandidate: JSON.stringify(round.taskCandidate),
      currentTaskCandidate: JSON.stringify(currentTaskCandidate),
      settledBy: actor,
      ...(actor === "leader" ? leaderActionEventPayload(tx, task.id, options) : {})
    }, now);
    return { turn: run, round: terminal, changed: true } as const;
  });
  return output(
    result.changed
      ? `Settled obsolete final Review ${result.round.id} from failed Turn ${result.turn.id}\n`
      : `Obsolete final Review already settled: ${result.round.id}/${result.turn.id}\n`,
    { reviewRound: result.round, reviewTurn: result.turn }
  );
}

function retryTurn(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task turn retry usage: yui task turn retry <task>/<turn>.");
  const now = clock(options);
  const previous = store.transaction((tx) => requireTurn(tx, args[0], options));
  if (previous.purpose === "review") {
    return retryFailedReviewRun(previous, store, options, now);
  }
  const retried = store.transaction((tx) => {
    if (previous.status !== "failed") {
      throw usageError(`Turn ${previous.id} is not retryable from ${previous.status}.`);
    }
    const task = requireTask(tx, previous.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    assertTaskExecutionEnabled(task, "retrying a Turn");
    const role = requireRole(tx, task.id, previous.roleName);
    if (tx.getActiveTurn(task.id, role.name) !== null) {
      throw usageError(`${task.id}/${role.name} already has an active turn.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const retryItem = previous.workItemId === undefined
      ? null
      : tx.getWorkItem(task.id, previous.workItemId);
    if (previous.workItemId !== undefined && retryItem === null) {
      throw dataError(`Work item not found for Turn ${previous.id}: ${previous.workItemId}.`);
    }
    const retriesSynthesisMain = previous.sourceExecutionGroupId !== undefined;
    if (retriesSynthesisMain
      && (previous.executionGroupId !== undefined || previous.executionLaneId !== undefined)) {
      throw dataError(`Turn ${previous.id} has conflicting execution lineage.`);
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
    const retriesExecutionLane = previous.executionGroupId !== undefined;
    const exactCurrentLane = !retriesExecutionLane || (
      retryItem !== null
      && currentRetryGroup !== undefined
      && currentRetryGroup.id === previous.executionGroupId
      && !workItemExecutionGroupSettled(currentRetryGroup)
      && retryLaneBefore !== undefined
      && retryLaneBefore.id === previous.executionLaneId
      && retryLaneBefore.disposition === "open"
      && retryLaneBefore.currentTurnId === previous.id
    );
    if (!exactCurrentLane) {
      throw usageError(
        `Turn ${previous.id} no longer owns the current failed Execution Lane.`
      );
    }
    const sourceGroup = !retriesSynthesisMain || retryItem === null
      ? undefined
      : workItemExecutionGroupById(retryItem, previous.sourceExecutionGroupId!);
    const sourceMainTurns = retriesSynthesisMain
      ? chronologicalTurns(tx.listTurns(task.id).filter((turn) => (
          turn.purpose === "execution"
          && turn.workItemId === previous.workItemId
          && turn.sourceExecutionGroupId === previous.sourceExecutionGroupId
        )))
      : [];
    const exactSourceMain = !retriesSynthesisMain || (
      retryItem !== null
      && retryItem.status === "running"
      && retryItem.assignee === previous.roleName
      && sourceGroup !== undefined
      && currentRetryGroup?.id === sourceGroup.id
      && workItemExecutionGroupSettled(sourceGroup)
      && successfulWorkItemSynthesisProducers(tx, retryItem, sourceGroup).length
        >= MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS
      && sourceMainTurns.at(-1)?.id === previous.id
    );
    if (!exactSourceMain) {
      throw usageError(
        `Turn ${previous.id} no longer owns the current WorkItem main synthesis.`
      );
    }
    const directMainTurns = retryItem === null
      ? []
      : chronologicalTurns(tx.listTurns(task.id).filter((turn) => (
          turn.purpose === "execution"
          && turn.workItemId === retryItem.id
          && turn.executionGroupId === undefined
          && turn.executionLaneId === undefined
          && turn.sourceExecutionGroupId === undefined
        )));
    const retriesDirectMain = retryItem !== null
      && !retriesExecutionLane
      && !retriesSynthesisMain;
    const exactDirectMain = !retriesDirectMain || (
      (retryItem.status === "running" || retryItem.status === "failed")
      && retryItem.assignee === previous.roleName
      && directMainTurns.at(-1)?.id === previous.id
    );
    if (!exactDirectMain) {
      throw usageError(
        `Turn ${previous.id} no longer owns the current direct WorkItem execution.`
      );
    }
    const groupedRunningRetry = retryItem?.status === "running"
      && retriesExecutionLane
      && exactCurrentLane;
    const synthesisRunningRetry = retryItem?.status === "running"
      && retriesSynthesisMain
      && exactSourceMain;
    const directRunningRetry = retryItem?.status === "running"
      && retriesDirectMain
      && exactDirectMain;
    if (retryItem !== null
      && retryItem.status !== "failed"
      && !groupedRunningRetry
      && !synthesisRunningRetry
      && !directRunningRetry) {
      throw usageError(`Work Item ${retryItem.id} is not retryable from ${retryItem.status}.`);
    }
    if (retryItem !== null) assertWorkItemDependenciesCompletedForCommand(tx, retryItem);
    const runWorkspace = previous.workspace
      ?? (retryItem === null
        ? tx.getTaskWorkspace(task.id)
        : retryItem.assignee === "leader"
          ? tx.getTaskWorkspace(task.id)
          : tx.getWorkItemWorkspace(task.id, retryItem.id))
      ?? undefined;
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
      throw dataError(`Turn ${previous.id} execution lineage no longer matches its Work Item.`);
    }
    const retryManagedWorkspace = retryLane === undefined ? runWorkspace : previous.workspace;
    if (retryLane !== undefined) {
      const storedLaneWorkspace = previous.workspace === undefined
        ? null
        : tx.getManagedWorkspace(previous.workspace.owner);
      const writableProjectIds = previous.workspace?.entries
        .filter(({ access }) => access === "write")
        .map(({ projectId }) => projectId)
        .sort();
      if (previous.workspace === undefined
        || previous.workspace.owner.type !== "execution-lane"
        || previous.workspace.owner.executionGroupId !== retryGroup!.id
        || previous.workspace.owner.executionLaneId !== retryLane.id
        || previous.workspace.root !== retryLane.workspace.root
        || !isDeepStrictEqual(previous.effective, retryLane.effective)
        || !isDeepStrictEqual(writableProjectIds, [...retryLane.workspace.writableProjectIds].sort())
        || storedLaneWorkspace === null
        || !isDeepStrictEqual(storedLaneWorkspace, previous.workspace)) {
        throw dataError(`Turn ${previous.id} Lane workspace is missing or has drifted.`);
      }
    }
    if (retriesSynthesisMain) {
      const storedMainWorkspace = previous.workspace === undefined
        ? null
        : tx.getManagedWorkspace(previous.workspace.owner);
      const currentMainWorkspace = retryItem?.assignee === "leader"
        ? tx.getTaskWorkspace(task.id)
        : retryItem === null
          ? null
          : tx.getWorkItemWorkspace(task.id, retryItem.id);
      if (previous.workspace === undefined
        || storedMainWorkspace === null
        || currentMainWorkspace === null
        || !isDeepStrictEqual(storedMainWorkspace, previous.workspace)
        || !isDeepStrictEqual(currentMainWorkspace, previous.workspace)) {
        throw dataError(`Turn ${previous.id} WorkItem main workspace is missing or has drifted.`);
      }
    }
    if (retriesDirectMain) {
      const storedDirectWorkspace = previous.workspace === undefined
        ? null
        : tx.getManagedWorkspace(previous.workspace.owner);
      const currentDirectWorkspace = retryItem?.assignee === "leader"
        ? tx.getTaskWorkspace(task.id)
        : retryItem === null
          ? null
          : tx.getWorkItemWorkspace(task.id, retryItem.id);
      if (previous.workspace === undefined
        || storedDirectWorkspace === null
        || currentDirectWorkspace === null
        || !isDeepStrictEqual(storedDirectWorkspace, previous.workspace)
        || !isDeepStrictEqual(currentDirectWorkspace, previous.workspace)) {
        throw dataError(`Turn ${previous.id} direct WorkItem workspace is missing or has drifted.`);
      }
    }
    const effective = retryLane?.effective ?? resolveEffectiveLaunch({
      role,
      purpose: "execution",
      ...(retryManagedWorkspace === undefined ? {} : { workspace: retryManagedWorkspace }),
      ...(retryItem === null ? {} : { workItemWriteProjectIds: retryItem.writeProjectIds })
    });
    const turnId = tx.nextTurnId(task.id);
    const runningGroup = retryGroup === undefined || retryLane === undefined
      ? undefined
      : updateWorkItemExecutionLane(retryGroup, retryLane.id, {
          currentTurnId: turnId
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
    const input = retriesSynthesisMain
      ? previous.inputs[0]!.input
      : (() => {
          const retrySnapshot = freezeTurnContextSnapshot(tx, {
            taskId: task.id,
            roleName: role.name,
            purpose: "execution",
            ...(previous.workItemId === undefined ? {} : { workItemId: previous.workItemId })
          }, now, "controller", retryGroup?.assignment.contextSnapshotRef);
          return createTurnInput({
            source: {
              type: "yui",
              channel: previous.workItemId === undefined ? "task-dispatch" : "workitem-dispatch"
            },
            ...(previous.inputs[0]!.input.directive === undefined
              ? {}
              : { directive: previous.inputs[0]!.input.directive }),
            contextSnapshotRef: contextSnapshotRef(retrySnapshot),
            deltaRefIds: contextSnapshotDeltaRefIds(tx, retrySnapshot)
          });
        })();
    const created = createTurn(
      turnId!,
      task.id,
      role.name,
      roleAgentSessionResumeMode(sessions, effective.agentId, effective),
      input,
      now,
      {
        ...(previous.workItemId === undefined ? {} : { workItemId: previous.workItemId }),
        ...(runningGroup === undefined ? {} : {
          executionGroupId: runningGroup.id,
          executionLaneId: retryLane!.id
        }),
        ...(previous.sourceExecutionGroupId === undefined
          ? {}
          : { sourceExecutionGroupId: previous.sourceExecutionGroupId }),
        ...(retryManagedWorkspace === undefined ? {} : { workspace: retryManagedWorkspace }),
        effective
      }
    );
    tx.saveTurn(created);
    tx.saveActiveTurn(created);
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
    enqueueWork(tx, roleMailbox(task.id, role.name), "turn-retried", now, [turnRef(task.id, created.id)]);
    recordTaskEvent(tx, task.id, "turn.retried", {
      ...turnLaunchEventPayload(created),
      previousTurnId: previous.id
    }, now);
    return { kind: "turn" as const, turn: created };
  });
  notifyMailbox(
    options.runtime,
    roleMailbox(retried.turn.taskId, retried.turn.roleName),
    retried.turn.taskId
  );
  return output(
    `Retry queued as ${retried.turn.id} for ${retried.turn.taskId}/${retried.turn.roleName}\n`
  );
}

function actualTaskReviewCandidateForMutation(
  store: TaskWorkflowStore,
  task: Task,
  options: TaskCommandOptions
): TaskReviewCandidate {
  if (options.actualTaskReviewCandidate === undefined) {
    throw usageError(
      `Actual Task Project heads were not verified for delivery: ${task.id}.`
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
    const binding = task.projectBindings.find((entry) => entry.projectId === projectId);
    if (binding?.currentCommit === undefined || binding.currentCommit !== commit) {
      throw usageError(
        `Project ${projectId} actual Task head ${commit} does not match Task currentCommit ${
          binding?.currentCommit ?? "missing"
        }.`
      );
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
    : `Reviewer Role must be separate from every WorkItem Candidate producer: `
      + `${reviewerRoleName} (${workItemIds.join(", ")}).`;
}

/**
 * Resolve the complete frozen Task-final provenance from the physical head of
 * every bound Project. Where a Project has a committed Integration, its
 * WorkItem source contributes producer Roles. A bound context Project without
 * an Integration is still frozen, but contributes no producer.
 *
 * When `expected` is supplied this is also the final dispatch compare-and-swap
 * fence: every bound Project must still point at the exact frozen physical
 * head. Drift fails closed before a Reviewer Turn is created.
 */
function taskReviewProvenance(
  store: TaskWorkflowStore,
  task: Task,
  options: TaskCommandOptions,
  expected?: TaskReviewCandidate
): TaskReviewProvenance {
  const candidate = actualTaskReviewCandidateForMutation(store, task, options);
  if (expected !== undefined && !isSameTaskReviewCandidate(candidate, expected)) {
    throw usageError(`Task-final ReviewRound frozen Task heads changed for its Project set.`);
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
      if (committed.source.kind !== "work-item") continue;
      const source = committed.source;
      const item = store.getWorkItem(task.id, source.workItemId);
      if (item === null) {
        throw dataError(
          `Committed Integration producer WorkItem is unavailable: `
          + `${committed.id}/${source.workItemId}.`
        );
      }
      const sourceCandidate = [...item.candidates].reverse().find((candidate) => (
        candidate.gitSnapshot?.projects.some((project) => (
          project.projectId === projectId
          && project.commit === source.resultCommit
        ))
      ));
      if (sourceCandidate === undefined) {
        throw dataError(
          `Committed Integration result provenance is invalid: ${committed.id}/${item.id}.`
        );
      }
      if (item.assignee !== undefined) recordProducer(item.assignee, item.id);
      if (sourceCandidate.source.type === "direct") {
        recordProducer(LEADER_ROLE, item.id);
        continue;
      }
      const sourceRun = store.getTurn(task.id, sourceCandidate.source.turnId);
      if (sourceRun === null
        || sourceRun.workItemId !== item.id
        || sourceRun.purpose !== "execution"
        || sourceRun.status !== "completed") {
        throw dataError(
          `Committed producer Candidate Turn is unavailable: `
          + `${item.id}/${sourceCandidate.source.turnId}.`
        );
      }
      recordProducer(sourceRun.roleName, item.id);
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
 * One Reviewer Role has one live Task-final Review lane. Different Reviewer
 * Roles own independent Session/Workspace slots and may review concurrently.
 */
function assertNoConflictingTaskReviewRound(
  rounds: readonly ReviewRound[],
  reusableRoundIds: string | readonly string[] = [],
  reviewerRoleName?: string
): void {
  const reusable = new Set(
    typeof reusableRoundIds === "string" ? [reusableRoundIds] : reusableRoundIds
  );
  const conflicting = rounds.find((entry) => (
    !reusable.has(entry.id)
    && (entry.scope ?? "work-item") === "task"
    && (entry.status === "pending" || entry.status === "running")
    && (reviewerRoleName === undefined || entry.reviewerRoleName === reviewerRoleName)
  ));
  if (conflicting !== undefined) {
    throw usageError(
      `Another active Task-final ReviewRound already exists: ${conflicting.id}/${conflicting.reviewerRoleName}.`
    );
  }
}

/**
 * Queues a Task-scoped final ReviewRound only after the Reviewer lane passes
 * its mechanical preflight. Busy or unavailable preparation never becomes a
 * failed semantic ReviewRound.
 */
function queueTaskReviewRound(
  store: TaskWorkflowStore,
  task: Task,
  config: ReviewConfig,
  taskCandidate: TaskReviewCandidate,
  options: TaskCommandOptions,
  now: Date,
  requestedBy: ReviewRequestSource = "policy",
  taskFinalContract?: TaskFinalReviewContract
): ReviewRound {
  const provenance = taskReviewProvenance(store, task, options, taskCandidate);
  if (!isSameTaskReviewCandidate(provenance.candidate, taskCandidate)) {
    throw usageError(`Task-final ReviewRound frozen Task heads changed before queueing.`);
  }
  const producerCollision = taskReviewProducerCollision(provenance, config.roleName);
  if (producerCollision !== null) {
    throw usageError(producerCollision);
  }
  const availability = projectReviewerAvailability(store, task.id, config.roleName);
  if (availability.kind === "busy") {
    throw usageError(
      `Reviewer ${config.roleName} is busy (${availability.phase}`
        + `${availability.activeTurnId === undefined ? "" : `; Turn ${availability.activeTurnId}`}); `
        + `retry after ${availability.retryAfterSeconds}s.`
    );
  }
  let reviewer = store.getRole(task.id, config.roleName);
  if (reviewer === null) {
    const globalRole = store.getGlobalRole(config.roleName);
    if (globalRole === null) {
      throw usageError(`Global Role not found: ${config.roleName}.`);
    }
    reviewer = createTaskRole(store, task, config.roleName, undefined, now, config.roleName);
    store.saveRole(task.id, reviewer);
  }
  const pending = createTaskReviewRound(
    store.nextReviewRoundId(task.id),
    task.id,
    config.roleName,
    requestedBy,
    taskCandidate,
    now,
    taskFinalContract
  );
  store.saveReviewRound(task.id, pending);
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
  // A Leader-requested ReviewRound is evidence, not policy. Only an explicit
  // immutable Task contract creates a durable completion obligation; optional
  // historical Rounds never cause completion to manufacture another Round for
  // a later head.
  if (taskFinalContract === undefined || task.projectBindings.length === 0) return null;
  const taskRounds = reviewRoundsByIdentity(store.listReviewRounds(task.id))
    .filter((round) => (
      (round.scope ?? "work-item") === "task"
      && sameTaskFinalReviewContract(
        round.taskFinalReviewContract,
        taskFinalContract
      )
    ));
  const establishedRound = taskRounds.at(-1);
  const config = taskFinalReviewConfig(taskFinalContract);

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
      latest.taskCandidate!,
      taskFinalContract,
      options
    );
  }
  if (taskRounds.some((round) => isAcceptedTaskReviewBaseline(store, round))) {
    return null;
  }
  const taskCandidate = taskReviewProvenance(store, task, options).candidate;
  if (latest !== undefined && isSameTaskReviewCandidate(latest.taskCandidate, taskCandidate)) {
    // A terminal round for the same immutable heads is already the final
    // review evidence. Do not create duplicate rounds on repeated completion
    // attempts. A failed round remains a blocker until the Leader changes the
    // candidate or otherwise resolves the failed evidence explicitly.
    // A non-accepting delta is durable evidence for the Leader, not an
    // instruction for Core to manufacture a full Review. Completion remains
    // blocked until the Leader explicitly chooses and obtains valid evidence.
    return isAcceptedTaskReviewBaseline(store, latest) ? null : latest;
  }

  return queueTaskReviewRound(
    store,
    task,
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
  if (round.reviewerTurnId !== undefined) {
    throw usageError(
      `Pending final ReviewRound already records Reviewer Turn ${round.reviewerTurnId}: ${round.id}.`
    );
  }
  assertNoConflictingTaskReviewRound(
    store.listReviewRounds(task.id),
    round.id,
    round.reviewerRoleName
  );
  const reviewer = store.getRole(task.id, round.reviewerRoleName);
  if (reviewer === null || reviewer.name !== round.reviewerRoleName) {
    throw usageError(`Pending final ReviewRound Reviewer identity changed: ${round.id}.`);
  }
  if (store.getActiveTurn(task.id, reviewer.name) !== null) {
    throw usageError(`Reviewer Role already has an active Turn: ${reviewer.name}.`);
  }
  assertPendingFinalReviewWorkspaceEvidence(store, task, round);
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

/**
 * Task-control retry of an exact failed Task-final review Turn. The old failed
 * Turn remains the attempt trail, while the semantic ReviewRound is reset to
 * pending under its existing identity. Every identity and frozen-head fence is
 * checked inside one transaction so a partial fail-old-without-reset state can
 * never be committed.
 */
function retryFailedReviewRun(
  previous: Turn,
  store: TaskWorkflowStore,
  options: TaskCommandOptions,
  now: Date
): TaskCommandExecution {
  const result = store.transaction((tx) => {
    const run = tx.getTurn(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "review") {
      throw usageError(`Turn ${previous.id} is not a failed review Turn.`);
    }
    if (run.reviewRoundId === undefined) {
      throw usageError(`Review Turn ${run.id} has no ReviewRound.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const requestedBy = taskActor(tx, options, task.id);
    const round = tx.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) {
      throw dataError(`ReviewRound not found for run ${run.id}: ${run.reviewRoundId}.`);
    }
    if ((round.scope ?? "work-item") !== "task") {
      throw usageError(
        `Review Turn ${run.id} is not a Task-final review; request a new WorkItem review `
        + "for a new Candidate."
      );
    }
    const retryLane = run.executionLaneId === undefined
      ? undefined
      : round.executionGroup?.lanes.find(({ id }) => id === run.executionLaneId);
    if (run.executionGroupId !== undefined && (
      round.executionGroup?.id !== run.executionGroupId
      || retryLane === undefined
      || retryLane.turnId !== run.id
      || retryLane.roleName !== run.roleName
    )) {
      throw usageError(
        `Review Turn ${run.id} no longer owns its exact Review Lane attempt.`
      );
    }
    const panelGroup = round.executionGroup !== undefined
      && (round.executionGroup.lanes.length > 1
        || round.executionGroup.strategy.mode === "adaptive");
    const runningPanelLaneRetry = round.status === "running"
      && panelGroup
      && retryLane?.status === "failed";
    if (round.status === "running" && panelGroup && !runningPanelLaneRetry) {
      throw usageError(
        `Review Turn ${run.id} is not the current failed Lane attempt in running Round ${round.id}.`
      );
    }
    const retryReviewerRoleName = retryLane?.roleName ?? round.reviewerRoleName;
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
        `Task-final ReviewRound ${round.id} no longer matches the frozen Task heads.`
      );
    }
    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((entry) => (entry.scope ?? "work-item") === "task"));
    const roundIndex = taskRounds.findIndex(({ id }) => id === round.id);
    if (roundIndex < 0) {
      throw dataError(`Final ReviewRound is not in Task history: ${round.id}.`);
    }
    const laterRound = taskRounds.slice(roundIndex + 1).find((entry) => (
      entry.reviewerRoleName === retryReviewerRoleName
    ));
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
        entry.reviewerRoleName === retryReviewerRoleName
      ))
    );
    assertNoConflictingTaskReviewRound(
      tx.listReviewRounds(task.id),
      round.id,
      retryReviewerRoleName
    );
    const activeRound = allReviewerRounds.find((entry) => (
      entry.id !== round.id
      && (entry.status === "pending" || entry.status === "running")
    ));
    if (activeRound !== undefined) {
      throw usageError(
        `Reviewer already has an active review round for this candidate: ${activeRound.id}.`
      );
    }

    const reviewerMailboxTarget = roleMailbox(task.id, retryReviewerRoleName);
    const reviewerMailbox = tx.getWorkMailbox(reviewerMailboxTarget);
    const reviewerPending = reviewerMailbox === null ? null : nextPendingBatch(reviewerMailbox);
    const runtimeMailbox = tx.getWorkMailbox(runtimeLifecycleTarget({
      scope: "task",
      taskId: task.id,
      roleName: retryReviewerRoleName
    }));

    const hasMailboxWork = (mailbox: ReturnType<typeof tx.getWorkMailbox>): boolean => (
      mailbox !== null && workMailboxHasWork(mailbox)
    );

    const reviewer = requireRole(tx, task.id, retryReviewerRoleName);
    const activePointer = tx.getActiveTurn(task.id, reviewer.name);
    const activeReviewerTurns = tx.listTurns(task.id).filter((entry) => (
      entry.roleName === reviewer.name && entry.status === "active"
    ));

    // Issue 06: a completed same-Round retry is a no-write idempotent result.
    if (round.status === "completed") {
      if (activePointer !== null || activeReviewerTurns.length > 0) {
        throw usageError(`Reviewer Role already has an active Turn: ${reviewer.name}.`);
      }
      if (hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
        throw usageError(`Reviewer has unrelated mailbox work: ${reviewer.name}.`);
      }
      return { round, previousRun: run, created: false };
    }

    // Issue 06: a running same Round is reusable only with its exact active
    // Turn and mailbox execution. A stranded Turn (no active pointer) falls
    // through and resets the Round after the identity fences below.
    if (round.status === "running" && !runningPanelLaneRetry) {
      const reviewerTurnId = round.reviewerTurnId;
      const activeMatches = reviewerTurnId !== undefined
        && activePointer !== null
        && activePointer.id === reviewerTurnId
        && activePointer.status === "active"
        && activeReviewerTurns.length === 1
        && activeReviewerTurns[0]!.id === reviewerTurnId;
      const processingMatches = reviewerTurnId !== undefined
        && reviewerMailbox?.processing?.executionRef !== undefined
        && isDeepStrictEqual(
          reviewerMailbox.processing.executionRef,
          turnRef(task.id, reviewerTurnId)
        )
        && reviewerPending === null;
      const pendingMatches = reviewerTurnId !== undefined
        && reviewerMailbox?.processing === null
        && reviewerPending?.requestCount === 1
        && reviewerPending.refs.some((ref) => (
          isDeepStrictEqual(ref, turnRef(task.id, reviewerTurnId))
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
      if (activePointer !== null || activeReviewerTurns.length > 0) {
        throw usageError(`Reviewer Role already has an active Turn: ${reviewer.name}.`);
      }
      if (hasMailboxWork(reviewerMailbox) || hasMailboxWork(runtimeMailbox)) {
        throw usageError(`Reviewer has unrelated mailbox work: ${reviewer.name}.`);
      }
      return { round, previousRun: run, created: false };
    }

    if (activePointer !== null || activeReviewerTurns.length > 0) {
      throw usageError(`Reviewer Role already has an active Turn: ${reviewer.name}.`);
    }
    if (runtimeMailbox?.processing !== null && runtimeMailbox?.processing !== undefined) {
      throw usageError(`Reviewer runtime lifecycle is pending: ${reviewer.name}.`);
    }
    if (runtimeMailbox !== null && workMailboxHasWork(runtimeMailbox)) {
      throw usageError(`Reviewer runtime lifecycle has pending work: ${reviewer.name}.`);
    }

    const validation = validateExactTurnReviewRound(tx, run, { allowTerminal: true });
    if (validation.disposition !== "applied" || validation.round === null) {
      throw usageError(
        `Review Turn ${run.id} identity does not match its ReviewRound or frozen Task state changed: ${validation.reason ?? "mismatch"}.`
      );
    }

    // A stranded pre-delivery Turn can leave its exact pending or processing
    // dispatch behind; settle only that exact reference while holding the
    // same aggregate lock. Any merged or unrelated batch fails closed.
    const exactOldTurnRef = turnRef(task.id, run.id);
    if (reviewerMailbox?.processing !== null && reviewerMailbox?.processing !== undefined) {
      if (
        reviewerMailbox.processing.executionRef === undefined
        || !isDeepStrictEqual(reviewerMailbox.processing.executionRef, exactOldTurnRef)
        || reviewerPending !== null
      ) {
        throw usageError(`Reviewer mailbox is busy: ${reviewer.name}.`);
      }
      settleExactWorkExecution(tx, reviewerMailboxTarget, exactOldTurnRef);
    } else if (reviewerPending !== null) {
      const exact = reviewerPending.refs.some((ref) => (
        isDeepStrictEqual(ref, exactOldTurnRef)
      ));
      if (!exact) throw usageError(`Reviewer mailbox has unrelated pending work: ${reviewer.name}.`);
      if (reviewerPending.requestCount !== 1) {
        throw usageError(`Reviewer mailbox has merged pending work: ${reviewer.name}.`);
      }
      settleExactWorkExecution(tx, reviewerMailboxTarget, exactOldTurnRef);
    }
    if (runningPanelLaneRetry) {
      const resetRound = retryRunningReviewExecutionLane(
        round,
        retryLane!.id,
        run.id,
        now
      );
      tx.saveReviewRound(task.id, resetRound);
      recordTaskEvent(tx, task.id, "turn.review-retried", {
        turnId: run.id,
        reviewRoundId: round.id,
        executionLaneId: retryLane!.id
      }, now);
      return { round: resetRound, previousRun: run, created: true };
    }
    // Terminalize the old stranded Round only after every identity and mailbox
    // fence has passed. The outer transaction rolls back if Round creation fails.
    let roundToReset = round;
    if (round.status !== "failed") {
      const summary = round.summary
        ?? run.result?.output
        ?? `Review Turn ${run.id} failed before delivery.`;
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
    const resetRound = retryTaskReviewRound(roundToReset, requestedBy, run.executionLaneId);
    tx.saveReviewRound(task.id, resetRound);
    recordTaskEvent(tx, task.id, "turn.review-retried", {
      turnId: run.id,
      reviewRoundId: round.id
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

/** Turn details are retained audit evidence; continuation uses durable Task state. */
function showTurn(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task turn show usage: yui task turn show <task>/<turn> [--json].";
  const asJson = args.includes("--json");
  const positionals = args.filter((arg) => arg !== "--json");
  exactPositionals(positionals, 1, usage);
  const data = store.transaction((tx) => {
    const run = requireTurn(tx, positionals[0], options);
    const retirement = tx.listEvents(run.taskId)
      .map(taskRecordRetirement)
      .find((entry) => entry?.recordKind === "turn" && entry.recordId === run.id) ?? null;
    return { turn: run, retirement };
  });
  if (asJson) {
    return { kind: "output" as const, output: `${JSON.stringify(data, null, 2)}\n`, data };
  }
  return {
    kind: "output" as const,
    output: renderTurnShow(
      data.turn,
      data.retirement
    ),
    data
  };
}

function renderTurnShow(
  run: Turn,
  retirement: ReturnType<typeof taskRecordRetirement>
): string {
  const lines = [
    `Turn: ${run.id}`,
    `Task: ${run.taskId}`,
    `Role: ${run.roleName}`,
    `Purpose: ${run.purpose}`,
    `Mode: ${run.mode}`,
    `Status: ${run.status}`,
    ...(retirement === null ? [] : [
      `History: retired by ${retirement.retiredBy}`,
      `Retirement reason: ${retirement.reason}`
    ]),
    `Effective: ${run.effective.agentId}/${run.effective.adapterId} r${run.effective.sourceDesiredRevision}`,
    `Created: ${run.createdAt}`,
    ...(run.result === undefined ? [] : [`Ended: ${run.result.completedAt}`]),
    ...(run.result === undefined || run.result.output.trim().length === 0
      ? []
      : [`Summary: ${run.result.output}`])
  ];
  return `${lines.join("\n")}\n`;
}


/**
 * Records a structured progress checkpoint for an active Turn. This is a durable
 * Turn fact, not a Task Message: it advances the Turn's durable-progress clock so
 * a healthy but long-running Turn keeps proving it is alive without adding
 * collaboration-narrative noise. It never completes, mutates the Turn, or wakes the
 * Leader.
 */
function checkpointTurn(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task turn checkpoint usage: yui task turn checkpoint <turn> (--note <text>|--note-file <path|->).";
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
    const run = requireTurn(tx, parsed.positionals[0], options);
    if (run.status !== "active") {
      throw usageError(`Turn ${run.id} is already terminal: ${run.status}.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "checkpointing a Turn"));
    const pointer = activeTurnPointer(tx, run);
    if (pointer?.id !== run.id) {
      throw usageError(`Turn is not active for ${task.id}/${run.roleName}: ${run.id}.`);
    }
    const events = tx.listEvents(task.id);
    const recovered = isRoleTurnStalled(events, run.id);
    const progress = recordTaskEventRecord(tx, task.id, TURN_PROGRESS_EVENT, {
      turnId: run.id,
      note: truncateEventNote(note),
      ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId })
    }, now);
    if (recovered) {
      recordTaskEventRecord(tx, task.id, TURN_RECOVERED_EVENT, {
        turnId: run.id,
        roleName: run.roleName,
        progressAt: now.toISOString(),
        kind: "checkpoint"
      }, now);
    }
    return progress;
  });
  return `Checkpoint recorded for ${parsed.positionals[0]} (${event.id}).\n`;
}

export function queueReviewRound(
  store: TaskWorkflowStore,
  item: WorkItem,
  config: ReviewConfig,
  requestedBy: ReviewRequestSource,
  now: Date
): Readonly<{ round: ReviewRound }> {
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
    ?? (candidate.source.type === "turn"
      ? store.getTurn(item.taskId, candidate.source.turnId)?.roleName
      : LEADER_ROLE);
  if (producerRoleName === config.roleName) {
    const failed = finishReviewRound(
      pending,
      "failed",
      `Reviewer Role must be separate from the Candidate producer: ${config.roleName}.`,
      now
    );
    store.saveReviewRound(item.taskId, failed);
    return { round: failed };
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
      return { round: failed };
    }
    const task = requireTask(store, item.taskId);
    reviewer = createTaskRole(store, task, config.roleName, undefined, now, config.roleName);
    store.saveRole(task.id, reviewer);
  }
  if (store.getActiveTurn(item.taskId, reviewer.name) !== null) {
    const failed = finishReviewRound(
      pending,
      "failed",
      `Reviewer Role already has an active Turn: ${reviewer.name}.`,
      now
    );
    store.saveReviewRound(item.taskId, failed);
    return { round: failed };
  }
  return { round: pending };
}

export function dispatchPreparedReviewRound(
  taskId: string,
  reviewRoundId: string,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): Turn | null {
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
    const taskScope = (round.scope ?? "work-item") === "task";
    let item: WorkItem | undefined;
    let candidate: WorkItemCandidate | undefined;
    if (taskScope) {
      // A Task-scoped final ReviewRound is anchored directly to its frozen
      // Task candidate. It deliberately has no synthetic WorkItem Candidate.
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
    } else {
      if (round.workItemId === undefined || round.candidateId === undefined) {
        throw dataError(`WorkItem ReviewRound has no Candidate anchor: ${round.id}.`);
      }
      item = tx.getWorkItem(taskId, round.workItemId) ?? undefined;
      if (item === undefined) {
        throw dataError(`ReviewRound Work Item not found: ${round.workItemId}.`);
      }
      candidate = item.candidates.find(({ id }) => id === round.candidateId);
      if (candidate === undefined) {
        throw dataError(`ReviewRound Candidate not found: ${round.candidateId}.`);
      }
      if (candidate.gitSnapshot?.reviewBaseCommit !== round.reviewBaseCommit) {
        throw usageError(`ReviewRound Candidate snapshot changed: ${round.id}.`);
      }
    }
    const task = requireTask(tx, taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    assertTaskExecutionEnabled(task, "dispatching a Review");
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
      if (round.status === "pending" && round.reviewerTurnId !== undefined) {
        throw new TaskFinalReviewDispatchDriftError(
          `Pending final ReviewRound already records Reviewer Turn ${round.reviewerTurnId}: `
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
            ? "Task-final ReviewRound frozen Task heads changed for its Project set."
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
      const requestedReviewers = new Set(
        round.executionGroup?.lanes.map(({ roleName }) => roleName)
          ?? [round.reviewerRoleName]
      );
      const conflicting = tx.listReviewRounds(task.id).find((entry) => (
        entry.id !== round.id
        && (entry.scope ?? "work-item") === "task"
        && (entry.status === "pending" || entry.status === "running")
        && (entry.executionGroup?.lanes.some(({ roleName }) => requestedReviewers.has(roleName))
          ?? requestedReviewers.has(entry.reviewerRoleName))
        && !(entry.status === "running"
          && entry.reviewerTurnId !== undefined
          && tx.getTurn(task.id, entry.reviewerTurnId)?.status === "failed")
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
    const candidateLabel = taskScope
      ? "frozen Task candidate"
      : candidate!.source.type === "turn"
        ? `candidate Turn ${candidate!.source.turnId}`
        : `revision ${candidate!.workItemRevision}`;
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
      if (previousRound === null || !isAcceptedTaskReviewBaseline(tx, previousRound)) {
        throw new TaskFinalReviewDispatchDriftError(
          `Delta-recheck accepted baseline is unavailable: ${round.deltaRecheck.previousReviewRoundId}.`
        );
      }
      const diffByProject = options.deltaRecheckDiff;
      if (diffByProject === undefined) {
        throw new TaskFinalReviewDispatchDriftError(
          `Delta-recheck diff is missing for ${round.id}; the CLI preflight did not turn.`
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
      taskScope
        ? `Review the ${scopeLabel} ${candidateLabel}.`
        : `Review ${scopeLabel} WorkItem ${item!.id} ${candidateLabel}.`,
      `ReviewRound: ${round.id}`,
      `Review scope: ${taskScope ? "task" : "work-item"}`,
      `Review base commit: ${round.reviewBaseCommit}`,
      ...(taskScope
        ? [`Frozen Task heads: ${frozenHeads}`]
        : [`Candidate snapshot base: ${round.reviewBaseCommit}`]),
      `Project Policy pointers: ${projectPolicyPointers || "none"}`,
      `Review workspace source: exact workspace attached to this Reviewer Lane`,
      `Candidate summary: ${taskScope ? task.title : candidate!.summary}`,
      `Acceptance criteria: ${taskScope
        ? "Task objective, maintained decisions, and Project Policy"
        : item!.acceptance.length === 0 ? "none" : item!.acceptance.join("; ")}`,
      ...(taskScope ? [deltaContext !== "" ? deltaContext : findingContext] : []),
      "Start from the user's core outcome and the WorkItem intent. The candidate summary is a pointer, not proof: inspect the complete relevant change, callers, and proportionate checks.",
      "Keep Yui Core lifecycle safety, generic Reviewer behavior, Project Policy/Knowledge, and the Task Contract separate. Follow Project Policy pointers from the dispatch context for project-specific checks.",
      ...(round.scope === "task" && round.deltaRecheck === undefined
        ? ["This is a full Task Review: inspect every bound Project at the frozen Task heads, and report only reachable, material, actionable P1/P2 findings or bounded verification gaps."]
        : []),
      "You may freely edit source/tests, run local build or test commands, and optionally commit diagnostic evidence only inside this stable Reviewer workspace at the exact ReviewRound snapshot.",
      "Do not push, integrate, mutate Task state, touch the Candidate or Worker workspace, another Task/workspace, a stable checkout, or the real Yui control-plane home.",
      "End the Provider turn with complete findings, evidence, checks actually run, uncertainty, and recommended next actions in clear Markdown or JSON. Yui preserves the full report automatically; no fixed wording or field list is required. If you include evidenceCommit, it must match the managed Review workspace.",
      "Report reviewBaseCommit, exact checks/results, material findings, and uncertainty. This Turn result completes only the Round and creates no Candidate or ChangeSet.",
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
      lane.status === "pending" && lane.turnId === undefined
    ));
    const laneRoles = dispatchLanes.map(({ roleName }) => roleName);
    const reviewers = laneRoles.map((roleName) => {
      const laneReviewer = tx.getRole(taskId, roleName);
      if (laneReviewer === null) {
        throw usageError(`Reviewer Role not found: ${taskId}/${roleName}.`);
      }
      if (tx.getActiveTurn(taskId, roleName) !== null) {
        throw usageError(`Reviewer Role already has an active Turn: ${roleName}.`);
      }
      return laneReviewer;
    });
    const createdTurns: Turn[] = [];
    const config = tx.getConfig();
    const controllerConcurrency = resolveControllerTaskConcurrency(config.controllerTaskConcurrency);
    const capacity = runningGroup.strategy.mode === "fixed"
      ? runningGroup.strategy.count
      : runningGroup.strategy.max;
    const brokerPolicy = resolveResourceBrokerPolicy({
      maxActiveLanes: controllerConcurrency,
      maxActiveLanesPerProvider: controllerConcurrency,
      maxQueuedLanesPerGroup: Math.max(controllerConcurrency, capacity)
    });
    const activeResources = activeResourceLaneIdentities(tx);
    const queuedResources = projectQueuedResourceLaneIdentities(tx, now);
    const reviewBaseline = dispatchLanes.length === 0
      ? undefined
      : freezeReviewStageContextSnapshot(tx, {
          taskId,
          reviewRoundId: round.id,
          executionGroupId: runningGroup.id
        }, now);
    for (let index = 0; index < reviewers.length; index += 1) {
      const lane = dispatchLanes[index]!;
      const laneReviewer = reviewers[index]!;
      const laneManagedWorkspace = runningGroup.lanes.length > 1 || runningGroup.strategy.mode === "adaptive"
        ? options.executionLaneWorkspaces?.get(lane.id)
        : round.workspace;
      if (laneManagedWorkspace === undefined && options.yuiHome !== undefined) {
        throw usageError(`Review Lane workspace preflight is missing: ${runningGroup.id}/${lane.id}.`);
      }
      const effective = lane.effective ?? resolveEffectiveLaunch({
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
      const request: ResourceLaneIdentity = {
        taskId,
        ...(item === undefined ? {} : { workItemId: item.id }),
        executionGroupId: runningGroup.id,
        executionLaneId: lane.id,
        providerId: effective.adapterId,
        agentId: effective.agentId,
        ...(effective.model === undefined ? {} : { model: effective.model }),
        requestedAt: lane.effective === undefined ? now.toISOString() : lane.updatedAt
      };
      const admission = planResourceAdmissions({
        policy: brokerPolicy,
        active: activeResources,
        queued: queuedResources.filter(({ taskId: queuedTaskId, executionGroupId, executionLaneId }) => !(
          queuedTaskId === request.taskId
          && executionGroupId === request.executionGroupId
          && executionLaneId === request.executionLaneId
        )),
        requests: [request]
      })[0]!;
      if (admission.decision !== "admitted") {
        if (lane.effective === undefined) {
          runningGroup = updateExecutionLane(runningGroup, lane.id, {
            reviewRoundId: round.id,
            effective,
            workspace: laneWorkspace
          }, now);
        }
        if (!queuedResources.some(({ taskId: queuedTaskId, executionGroupId, executionLaneId }) => (
          queuedTaskId === request.taskId
          && executionGroupId === request.executionGroupId
          && executionLaneId === request.executionLaneId
        ))) queuedResources.push(request);
        continue;
      }
      activeResources.push(request);
      const turnId = tx.nextTurnId(taskId);
      const input = createTurnInput({
        source: {
          type: "yui",
          channel: item === undefined ? "task-dispatch" : "workitem-dispatch"
        },
        directive: `${rawInput}\nFrozen target: ${runningGroup.target.fingerprint}.`,
        deltaRefIds: []
      });
      runningGroup = updateExecutionLane(runningGroup, lane.id, {
        status: "running",
        turnId,
        reviewRoundId: round.id,
        effective,
        workspace: laneWorkspace
      }, now);
      createdTurns.push(createTurn(
        turnId,
        taskId,
        laneReviewer.name,
        roleAgentSessionResumeMode(sessions, effective.agentId, effective),
        input,
        now,
        {
          ...(item === undefined ? {} : { workItemId: item.id }),
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
    const persistedRound = round.status === "pending" && createdTurns.length > 0
      ? startReviewRound(roundWithGroup, createdTurns[0]!.id)
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
    for (let index = 0; index < createdTurns.length; index += 1) {
      const unboundTurn = createdTurns[index]!;
      const snapshot = freezeTurnContextSnapshot(tx, {
        taskId,
        roleName: unboundTurn.roleName,
        purpose: "review",
        ...(item === undefined ? {} : { workItemId: item.id }),
        reviewRoundId: round.id
      }, now, "controller", reviewBaseline === undefined
        ? undefined
        : contextSnapshotRef(reviewBaseline));
      const created = withTurnContextSnapshot(
        unboundTurn,
        contextSnapshotRef(snapshot),
        contextSnapshotDeltaRefIds(tx, snapshot)
      );
      createdTurns[index] = created;
      const laneReviewer = requireRole(tx, taskId, unboundTurn.roleName);
      tx.saveTurn(created);
      tx.saveActiveTurn(created);
      enqueueWork(tx, roleMailbox(taskId, laneReviewer.name), "review-requested", now, [
        turnRef(taskId, created.id),
        ...(item === undefined ? [] : [workItemRef(taskId, item.id)])
      ]);
      recordTaskEvent(tx, taskId, "turn.review-dispatched", turnLaunchEventPayload(created), now);
    }
    return createdTurns;
  });
  for (const run of runs) {
    notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName), run.taskId);
  }
  return runs[0] ?? null;
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
    const task = requireTask(tx, taskId);
    taskActor(tx, options, task.id);
    const round = tx.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw usageError(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    if (round.status !== "pending") return round;
    const terminal = finishReviewRound(round, "failed", summary, now);
    tx.saveReviewRound(taskId, terminal);
    const event = recordTaskEventRecord(tx, taskId, "review.failed-to-start", {
      reviewRoundId: terminal.id,
      reviewerRoleName: terminal.reviewerRoleName,
      reason: summary
    }, now);
    enqueueWork(tx, leaderMailbox(taskId), "review-failed", now, [
      eventRef(taskId, event.id),
      ...(round.workItemId === undefined ? [] : [workItemRef(taskId, round.workItemId)])
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

function applyWorkerAgentProfile(role: Role, profile: AgentProfile, now: Date): Role {
  const binding = activeRoleAgentBinding(role);
  const config = structuredClone(binding.config) as unknown as Record<string, unknown>;
  if (profile.model === undefined) delete config.model;
  else config.model = profile.model;
  if (profile.effort === undefined) delete config.effort;
  else config.effort = profile.effort;
  const profiledBinding = createRoleAgentBinding({
    id: binding.agentId,
    adapterId: binding.adapterId
  }, config as unknown as RoleAgentConfig);
  return updateRole(role, {
    ...workerProfileRolePatch(profile),
    agentBindings: {
      ...role.agentBindings,
      [binding.agentId]: profiledBinding
    }
  }, now);
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
    ...(message.turnId === undefined ? {} : { turnId: message.turnId })
  }, now);
  return message;
}

function recordTaskEvent(
  store: TaskWorkflowStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): TaskEvent {
  return recordTaskEventRecord(store, taskId, type, payload, now);
}

function leaderActionEventPayload(
  store: TaskWorkflowStore,
  taskId: string,
  options: TaskCommandOptions
): TaskEventPayload {
  const turnId = taskLeaderActionTurnId(
    store,
    taskId,
    options.environment,
    options.yuiHome
  );
  return turnId === undefined ? {} : { leaderTurnId: turnId };
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

/** Keeps a free-text Turn-fact note bounded so an event payload stays compact. */
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

function turnLaunchEventPayload(run: Turn): TaskEventPayload {
  return {
    turnId: run.id,
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
    ...(run.sourceExecutionGroupId === undefined
      ? {}
      : { sourceExecutionGroupId: run.sourceExecutionGroupId }),
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

function requireTurn(
  store: TaskWorkflowStore,
  turnId: string | undefined,
  options: TaskCommandOptions
): Turn {
  const reference = taskRecordReference(
    turnId,
    "turn",
    "Turn reference",
    options
  );
  const run = store.getTurn(reference.taskId, reference.localId);
  if (run === null) {
    throw usageError(`Turn not found: ${reference.taskId}/${reference.localId}.`);
  }
  return run;
}

function activeTurnPointer(store: TaskWorkflowStore, run: Turn): Turn | null {
  return run.executionGroupId !== undefined && run.executionLaneId !== undefined
    ? store.getActiveExecutionLaneTurn(
      run.taskId,
      run.executionGroupId,
      run.executionLaneId
    )
    : store.getActiveTurn(run.taskId, run.roleName);
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
  kind: "workItem" | "turn" | "reviewRound" | "message",
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

export function assertWorkItemDependenciesCompletedForCommand(
  store: TaskWorkflowStore,
  item: WorkItem
): void {
  try {
    assertWorkItemDependencyGate(store, item);
  } catch (error) {
    if (error instanceof WorkItemDependencyGateError) {
      throw usageError(error.message, undefined, error.details);
    }
    throw error;
  }
}

function chronologicalTurns(turns: readonly Turn[]): Turn[] {
  return [...turns].sort((left, right) => (
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

function assertTaskExecutionEnabled(task: Task, action: string): void {
  if (task.executionGate.state === "enabled") return;
  throw usageError(
    `Task execution is stopped: ${task.id}. Run "yui task execution start ${task.id}" before ${action}.`
  );
}

function taskActor(
  store: Pick<
    TaskWorkflowStore,
    "getRole" | "getActiveTurn" | "getTaskRoleSessionSet"
  >,
  options: TaskCommandOptions,
  taskId: string
) {
  return resolveTaskLocalActor(store, options.environment, taskId, options.yuiHome);
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

function assertReplaceOrClear(
  parsed: ParsedMultiTail,
  replaceOption: string,
  clearOption: string,
  usage: string
): void {
  if (parsed.multiOptions.has(replaceOption) && parsed.options.has(clearOption)) {
    throw usageError(`${replaceOption} and ${clearOption} cannot be combined.`, usage);
  }
}

function parseWorkItemBaseRefs(
  values: readonly string[],
  task: Task,
  store: TaskWorkflowStore,
  writableProjectIds: readonly string[],
  usage: string
): WorkItemProjectBaseRef[] {
  const baseRefs = values.map((value): WorkItemProjectBaseRef => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw usageError("--base-ref must use <project>=<ref>.", usage);
    }
    const reference = value.slice(0, separator);
    const project = resolveProject(
      task.projectBindings.map(({ projectId }) => requireProject(store, projectId)),
      reference
    );
    if (project === null) throw usageError(`Task Project not found: ${reference}.`);
    assertProjectActive(project, "edit a Work Item");
    if (!writableProjectIds.includes(project.id)) {
      throw usageError(`Work Item base-ref Project must be writable: ${project.id}.`);
    }
    return { projectId: project.id, baseRef: value.slice(separator + 1) };
  });
  if (new Set(baseRefs.map(({ projectId }) => projectId)).size !== baseRefs.length) {
    throw usageError("Each Work Item Project may specify at most one base ref.", usage);
  }
  return baseRefs;
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
      const updatedBy = taskActor(tx, options, task.id);
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
      const actor = taskActor(tx, options, task.id);
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
      const actor = taskActor(tx, options, task.id);
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
      const actor = taskActor(tx, options, task.id);
      const milestone = createMilestone(
        tx.nextMilestoneId(task.id),
        task.id,
        title,
        summary,
        actor,
        now
      );
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
      turnId: continuation.turnId,
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
        { header: "Turn", minWidth: 10, maxWidth: 20 },
        { header: "Dispatched", minWidth: 10, maxWidth: 28 }
      ],
      wakes.map((wake) => [
        wake.id,
        wake.status,
        wake.reasons.map(renderWakeReason).join(", "),
        wake.turnId ?? "-",
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
    const turns = store.listTurns(task.id).filter((turn) => inWindow(turn.createdAt));
    const lines: string[] = [
      `Wake: ${wake.id}`,
      `Task: ${task.id}`,
      `Status: ${wake.status}`,
      `Reasons: ${wake.reasons.map(renderWakeReason).join(", ")}`,
      `Delta window: ${wake.fromCursor} → ${wake.toCursor}`,
      ...(wake.turnId === undefined ? [] : [`Turn: ${wake.turnId}`]),
      `Dispatched: ${presentTime(wake.createdAt, timeZone)}`,
      ...(wake.consumedAt === undefined
        ? []
        : [`Consumed: ${presentTime(wake.consumedAt, timeZone)}`]),
      `Events (${events.length}):`,
      ...events.map((e) => `  ${e.id} ${e.type} ${presentTime(e.createdAt, timeZone)}`),
      `Messages (${messages.length}):`,
      ...messages.map((m) => `  ${m.id} [${taskMessageAuthorLabel(m.author)}] ${presentTime(m.createdAt, timeZone)}`),
      `Turns (${turns.length}):`,
      ...turns.map((turn) => `  ${turn.id} [${turn.status}/${turn.purpose}] ${turn.roleName} ${presentTime(turn.createdAt, timeZone)}`)
    ];
    return output(lines.join("\n").concat("\n"), {
      taskId: task.id,
      wake,
      events,
      messages,
      turns
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
): "accept" | "reject" | "retry" | "blocked" {
  if (value === "accept" || value === "reject" || value === "retry" || value === "blocked") {
    return value;
  }
  throw usageError("--decision must be accept, reject, retry, or blocked.", usage);
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

function roleMailbox(taskId: string, roleName: string): MailboxTarget {
  return { kind: "role", taskId, roleName };
}

function leaderMailbox(taskId: string): MailboxTarget {
  return roleMailbox(taskId, LEADER_ROLE);
}

function taskRef(id: string): MailboxEntityRef {
  return { type: "task", id };
}

function turnRef(taskId: string, id: string): MailboxEntityRef {
  return { type: "turn", taskId, id };
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
