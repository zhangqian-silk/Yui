import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ConfiguredAgent } from "../agent/agent.js";
import { agentExecutionComponentLabel } from "../agent/executionComponents.js";
import {
  createRun,
  runExecutionObservation,
  runPurposeAdmitsTaskState,
  withRunContextSnapshot,
  type AgentRun
} from "../agentRun/agentRun.js";
import {
  isGitArtifactRefString,
  parseGitArtifactRef,
  type GitArtifactRef
} from "../artifacts/gitArtifactRef.js";
import { contextSnapshotRef } from "../context/contextSnapshot.js";
import {
  buildRunContextDelta,
  buildRunContextPack,
  contextSnapshotDeltaRefIds,
  expandRunContextRef,
  freezeReviewStageContextSnapshot,
  freezeRunContextSnapshot,
  freezeWorkItemExecutionAssignmentContextSnapshot,
  synthesisSourceRunIds
} from "../context/runContextPack.js";
import { createRunInput } from "../context/runInputContract.js";
import {
  parseTaskCatalogOptions,
  readTaskCatalog,
  renderTaskCatalog
} from "../context/taskCatalog.js";
import { listContextMessages } from "../context/taskContext.js";
import { referencedWakeRunIds } from "../context/wakeRunReferences.js";
import {
  completeProcessing,
  type MailboxEntityRef
} from "../coordination/workMailbox.js";
import {
  enqueueRoleRunDispatch,
  enqueueWork,
  settleExactWorkExecution
} from "../coordination/workMailboxQueue.js";
import {
  CliError,
  dataError,
  roleNotFound,
  runtimeError,
  taskNotFound,
  usageError
} from "../errors/cliError.js";
import { type TaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import {
  dispatchReviewSynthesis,
  selectedReviewSynthesisProducers
} from "../execution/reviewMainRun.js";
import {
  createExecutionGroup,
  createReviewExecutionAssignment,
  createWorkItemExecutionAssignment,
  createWorkItemExecutionGroup,
  updateExecutionLane as updateUnifiedExecutionLane,
  updateWorkItemExecutionLane,
  workItemExecutionGroupSettled,
  type WorkItemExecutionLaneWorkspace
} from "../execution/workItemExecution.js";
import {
  projectWorkItemExecution,
  type WorkItemExecutionProjection
} from "../execution/workItemExecutionProjection.js";
import {
  dispatchWorkItemSynthesis,
  selectedWorkItemSynthesisProducers
} from "../execution/workItemMainRun.js";
import {
  createRoleSessionSet,
  roleAgentSessionResumeMode,
  taskRoleControlTarget,
  updateTaskRoleProviderRuntime
} from "../executor/agentExecutor.js";
import {
  resolveEffectiveLaunch,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { cancelInputRequest } from "../input/inputRequest.js";
import {
  retireExactActiveRun,
  terminalizeExactTaskRun,
  validateExactRunReviewRound
} from "../lifecycle/exactRunTerminalization.js";
import {
  resolveTaskInputControl,
  type ResolvedInputTarget,
  type InputControlRequest
} from "../message/inputControlResolution.js";
import {
  createTaskMessage,
  expandTaskMessageResult,
  recordTaskMessageControlOutcome,
  TASK_SUBMISSION_INTENTS,
  taskMessageAuthorLabel,
  taskMessageInputControlState,
  updateDraftTaskMessage,
  withSubmissionReceipt,
  type TaskMessage,
  type TaskMessageAuthor,
  type TaskMessageContext,
  type TaskMessageInputAction,
  type TaskMessageKind,
  type TaskSubmissionIntent
} from "../message/message.js";
import { messageContinuationBlocker, resolveMessageRecipient } from "../message/messageContinuation.js";
import {
  findTaskInterrupt,
  reserveTaskInterrupt,
  taskInterruptReceipt,
  taskInterruptWasRejected
} from "../message/taskInterrupt.js";
import {
  agentRunConfigurationLabel,
  renderAgentRunConfiguration
} from "../output/agentRunConfigurationPresentation.js";
import { renderRoleDetails, renderRoleLaunchComparison } from "../output/rolePresentation.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { AgentProfile } from "../profile/agentProfile.js";
import {
  requireResolvedAgentProfileRuntime,
  type ResolvedAgentProfileRuntime
} from "../profile/agentProfileRuntime.js";
import { assertProjectActive, resolveProject, type Project } from "../repository/project.js";
import { createProjectResources } from "../resources/projectResourceService.js";
import {
  buildDeltaRecheckDispatchContext,
  verifyDeltaRecheckDiff,
  type DeltaRecheckPreflight
} from "../review/deltaRecheck.js";
import { isCompletedTaskReviewEvidence } from "../review/reviewAcceptance.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import {
  projectReviewerAvailability,
  type ReviewerBusy
} from "../review/reviewerAvailability.js";
import {
  attachReviewExecutionGroup,
  createReviewRound,
  createTaskDeltaReviewRound,
  createTaskReviewRound,
  finishReviewRound,
  recordReviewWorkspaceDisposition,
  retryReviewRound,
  retryRunningReviewExecutionLane,
  retryTaskReviewRound,
  startReplicatedReviewRound,
  startReviewRound,
  updateReviewExecutionGroup,
  validateTaskReviewCandidate,
  type ReviewRequestSource,
  type ReviewRound,
  type TaskReviewCandidate
} from "../review/reviewRound.js";
import {
  sameTaskFinalReviewContract,
  taskFinalReviewConfig,
  validateTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import {
  resolveRecordedTaskFinalReviewContract,
  type TaskFinalReviewContractResolution
} from "../review/taskFinalReviewContractResolution.js";
import {
  copyGlobalRoleToTaskRole,
  createRole,
  createRoleAgentBinding,
  switchActiveRoleAgent,
  unbindRoleAgent,
  updateRole,
  type Role,
  type RoleAgentBinding
} from "../role/role.js";
import { roleLaunchEventPayload, saveTaskRoleUpdate } from "../role/taskRoleUpdate.js";
import {
  RUNTIME_SESSION_REPLACE_REQUIRED_REASON,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import { currentManagedRuntime, resolveManagedTaskReader } from "../runtime/managedCaller.js";
import { controlProviderRetry, providerRetryProjection, renderProviderRetry } from "../runtime/providerRetry.js";
import { currentProviderConversation, transferProviderAuthority } from "../runtime/providerRuntimeIdentity.js";
import { projectProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";
import { enqueueOperatorEvent } from "../scheduler/operatorEvent.js";
import {
  isRoleRunStalled,
  RUN_PROGRESS_EVENT,
  RUN_RECOVERED_EVENT
} from "../scheduler/roleRunStall.js";
import { renderWakeReason, wakeReason } from "../scheduler/wakeReason.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import { planningRuntimeCwd } from "../storage/homeLayout.js";
import { StorageConflictError } from "../storage/taskStore.js";
import {
  archiveDeliveryWarnings,
  archiveRetainedResources,
  renderArchiveDiagnostics,
  taskArchiveDiagnostics
} from "../task/archiveDiagnostics.js";
import { archiveSettlementChecks } from "../task/archivePreflight.js";
import {
  projectCompletionReadiness,
  type CompletionAdvisory,
  type CompletionBlocker
} from "../task/completionReadiness.js";
import {
  assertDraftTaskExecutionFree,
  validateDraftWorkItemEdit
} from "../task/draftPlan.js";
import { assertTaskRemoteDeliveryProof, projectTaskRemoteDeliveryFromStore } from "../task/remoteDeliveryService.js";
import {
  addTaskProjectBinding,
  archiveTask,
  completeTask,
  createTask,
  reopenTask,
  retireTask,
  taskOwnsManagedWorkspace,
  updateTaskMetadata,
  type Task,
  type TaskMetadata,
  type TaskMetadataUpdate,
  type TaskPriority,
  type TaskProjectBinding,
  type TaskStatus
} from "../task/task.js";
import {
  recordTaskActivationRequestInTransaction,
  taskActivationOperationRef
} from "../task/taskActivationService.js";
import {
  assertTaskDeliveryAuthority,
  assertTaskInputControlAuthority
} from "../task/taskAuthority.js";
import {
  resolveTaskRecordReference
} from "../task/taskRecordReference.js";
import {
  createTaskRecordRetirement,
  isTaskRecordRetired,
  operationalTaskRecords,
  taskRecordRetirement
} from "../task/taskRecordRetirement.js";
import {
  decideSubmissionRouting,
  describeSubmissionFeedback,
  draftActivationState,
  draftHasEnteredPlanning,
  normalizeSubmissionIntent,
  sameSubmissionTarget,
  TASK_PLANNING_ENTERED_EVENT,
  type SubmissionFeedback,
  type SubmissionNextStep,
  type SubmissionReceipt,
  type SubmissionRouting,
  type SubmissionTarget
} from "../task/taskSubmission.js";
import {
  assertWorkItemDependenciesCompleted as assertWorkItemDependencyGate,
  WorkItemDependencyGateError
} from "../workItem/dependencyGate.js";
import {
  attachWorkItemExecutionGroup,
  createWorkItem,
  currentWorkItemCandidate,
  currentWorkItemExecutionGroup,
  editWorkItemDefinition,
  prepareWorkItemDispatch,
  retireWorkItem,
  submitWorkItemCandidate,
  updateWorkItemExecutionGroup,
  updateWorkItemStatus,
  updateWorkItemWriteProjects,
  workItemExecutionGroupById,
  type WorkItem,
  type WorkItemCandidate,
  type WorkItemProjectBaseRef,
  type WorkItemStatus
} from "../workItem/workItem.js";
import { CleanupInspectionError } from "../workspace/cleanupInspection.js";
import type {
  TaskRetirementProof,
  WorkItemIntegrationProof
} from "../workspace/workItemChangeSetManager.js";
import {
  managedWorkspaceKey,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import { runGrantCommand } from "./grantCommands.js";
import {
  hasAgentConfigOptions,
  hasNoRoleMutation,
  parseRoleOptions,
  patchRoleAgentBinding,
  roleOptionSpecs,
  roleProfilePatch,
  type ParsedRoleOptions
} from "./roleConfiguration.js";
import {
  assertRoleRuntimeMutationAllowed
} from "./roleRuntimeGuard.js";
import {
  hasRoleLaunchContextOptions,
  validateConfiguredRoleSkills
} from "./roleSkillValidation.js";
import { nonLeaderActivationIdentity, runTaskActivationCommand } from "./taskActivationCommands.js";
import {
  assertTaskOpen,
  clock,
  exactPositionals,
  leaderActionEventPayload,
  leaderMailbox,
  notifyMailbox,
  optionalNonEmptyOption,
  output,
  parseMultiValueTail,
  parseTail,
  presentTime,
  recordTaskEvent,
  recordTaskEventRecord,
  requiredOption,
  requiredText,
  requireTask,
  roleMailbox,
  taskActor,
  taskMailbox,
  taskRef,
  trimmed,
  type ParsedMultiTail
} from "./taskCommandSupport.js";
import {
  type TaskCommandExecution,
  type TaskCommandOptions,
  type TaskCompletionPreflight,
  type TaskRoleAgentConfigurationMutation,
  type TaskWorkflowRuntimePort,
  type TaskWorkflowStore
} from "./taskCommandTypes.js";
import {
  assertTaskCompletionPublishedTreeProof
} from "./taskCompletionGate.js";
import { runTaskContextCommand } from "./taskContextCommand.js";
import { taskBriefCommand, taskDecisionCommand, taskEventCommand, taskMilestoneCommand } from "./taskFactCommands.js";
import {
  openInputRequestCount,
  runTaskInputCommand
} from "./taskInputCommands.js";
import { runTaskNextActionCommand } from "./taskNextActionCommand.js";
import { runPublicationCommand } from "./taskPublicationCommands.js";
import { renderTaskRemoteDelivery, runTaskRemoteDeliveryCommand } from "./taskRemoteDeliveryCommand.js";
import {
  inspectTaskRoleRuntimeStatuses,
  renderTaskRoleRuntimeStatus,
  taskRoleActiveWorkLabel,
  taskRoleHostDiagnostic,
  taskRoleLastRunLabel,
  taskRoleNativeSessionLabel,
  taskRoleOpenInputLabel,
  taskRoleTmuxLabel,
  withTaskRoleHostObservation
} from "./taskRoleRuntimeStatus.js";
import { readCommandText } from "./textInput.js";
import { runWorkflowCommand } from "./workflowCommands.js";

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

/**
 * Resolve the exact Task Role binding a CLI command would write, without
 * mutating Task state. The CLI uses this to complete live/cache/fallback
 * capability validation before the command transaction begins.
 */
export function previewTaskRoleAgentConfigurationMutation(
  args: readonly string[],
  store: TaskWorkflowStore
): TaskRoleAgentConfigurationMutation | undefined {
  if (args[0] !== "role") return undefined;
  if (args[1] === "add") {
    const usage = "Task role add usage: yui task role add <task> <name> [Role and Agent settings].";
    const [taskId, roleName, ...tail] = args.slice(2);
    if (taskId === undefined || roleName === undefined
      || taskId.startsWith("--") || roleName.startsWith("--")) {
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
    if (hasAgentConfigOptions(parsed) && agentId === undefined) {
      throw usageError(
        "Task role add Agent settings require --agent so a complete binding is validated atomically.",
        usage
      );
    }
    const task = requireTask(store, taskId);
    const cwd = task.cwd ?? store.getConfig().defaultWorkspace ?? process.cwd();
    const profileId = parsed.one("--profile");
    const bindingUpdate = resolveTaskRoleAgentBindingAdd(
      parsed,
      profileId === undefined ? undefined : requireAgentProfile(store, profileId),
      store
    );
    if (bindingUpdate !== undefined) {
      return {
        agentId: bindingUpdate.agentId,
        config: bindingUpdate.binding.config,
        cwd
      };
    }
    const worker = store.getGlobalRole("worker");
    if (worker === null) return undefined;
    const binding = worker.agentBindings[worker.activeAgentId];
    return binding === undefined
      ? undefined
      : { agentId: binding.agentId, config: binding.config, cwd };
  }
  if (args[1] === "update") {
    const usage = "Task role update usage: yui task role update <task> <role> [Role and Agent settings].";
    const [taskId, roleName, ...tail] = args.slice(2);
    if (taskId === undefined || roleName === undefined
      || taskId.startsWith("--") || roleName.startsWith("--")) {
      throw usageError("Task id and Role name are required.", usage);
    }
    const parsed = parseRoleOptions(tail, new Map([
      ...roleOptionSpecs({ update: true, includeAgent: true }),
      ["--profile", "value" as const],
      ["--environment", "value" as const],
      ["--managed-environment", "flag" as const]
    ]), usage);
    validateTaskRoleEnvironmentOptions(parsed, usage);
    if (parsed.has("--agent") && (parsed.one("--agent")?.trim().length ?? 0) === 0) {
      throw usageError("--agent is required.", usage);
    }
    const role = requireRole(store, taskId, roleName);
    const profileId = parsed.one("--profile");
    const bindingUpdate = resolveTaskRoleAgentBindingUpdate(
      parsed,
      role,
      profileId === undefined ? undefined : requireAgentProfile(store, profileId),
      store
    );
    if (bindingUpdate === undefined) return undefined;
    return {
      agentId: bindingUpdate.agentId,
      config: bindingUpdate.binding.config,
      cwd: role.workspace
    };
  }
  return undefined;
}

export function parseTaskCompletionRequest(
  args: string[],
  summaryOverride?: string
): Readonly<{
  taskId: string;
  summary: string;
  artifactRefs: readonly string[];
  acceptedPublishedTreePublicationId?: string;
}> {
  const usage = "Task complete usage: yui task complete <id> (--summary <text>|--summary-file <path|->) [--refresh-remote] [--accept-published-tree <publication-id>].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--summary", "--summary-file", "--accept-published-tree"]),
    new Set(["--artifact-ref"]),
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
    artifactRefs: parsed.multiOptions.get("--artifact-ref") ?? [],
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
  _request: Readonly<{ acceptedPublishedTreePublicationId?: string }> = {}
): TaskCompletionPreflight {
  const task = requireTask(store, taskId);
  const actor = taskActor(store, options, task.id);
  assertTaskDeliveryAuthority(store, options.environment, task.id);
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
    round.scope === "task"
    && (round.status === "pending" || round.status === "running")
  ));
  // Issue 06: one shared readiness projection enumerates every blocker.
  const readinessFacts = store.readCompletionReadinessFacts(task.id);
  if (readinessFacts === null) throw taskNotFound(task.id);
  const readiness = projectCompletionReadiness(readinessFacts);
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
  const delivery = command === "complete"
    || (command === "work" && ["dispatch", "synthesize", "review", "accept"].includes(rest[0] ?? ""))
    || (command === "review" && !["list", "show"].includes(rest[0] ?? ""))
    || (command === "run" && rest[0] === "retry");
  if (delivery && options.environment?.YUI_SESSION_SCOPE === "task"
    && options.environment.YUI_TASK_ID !== undefined) {
    assertTaskDeliveryAuthority(store, options.environment, options.environment.YUI_TASK_ID);
  }
  switch (command) {
    case "create": return createTaskCommand(rest, store, options);
    case "update": return output(updateTaskCommand(rest, store, options));
    case "list": return listTaskCommand(rest, store, options.environment);
    case "show": return showTaskCommand(
      rest,
      store,
      options.actualTaskReviewCandidate ?? null
    );
    case "context": return runTaskContextCommand(
      rest,
      store,
      options.environment
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
    case "activation": return runTaskActivationCommand(rest, store, options);
    case "complete": return completeTaskCommand(rest, store, options);
    case "reopen": return output(reopenTaskCommand(rest, store, options));
    case "archive": return archiveTaskCommand(rest, store, options);
    case "retire": return retireTaskCommand(rest, store, options);
    case "cancel": return cancelTaskCommand(rest, store, options);
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

function validateReviewProducerRoles(
  reviewerRoleName: string,
  requestedRoles: readonly string[]
): readonly string[] {
  const roles = [...requestedRoles];
  if (roles.length === 1) {
    throw usageError("Replicated Review requires zero or at least two --lane-role values.");
  }
  if (new Set(roles).size !== roles.length) {
    throw usageError("Each Review Producer Lane must use a distinct Task Role.");
  }
  if (roles.includes(reviewerRoleName)) {
    throw usageError("The main Reviewer Role cannot also be a Review Producer Lane.");
  }
  return roles;
}

function workItemCandidateProducerRoles(
  store: TaskWorkflowStore,
  item: WorkItem,
  candidate: WorkItemCandidate
): ReadonlySet<string> {
  const roles = new Set<string>();
  if (item.assignee !== undefined) roles.add(item.assignee);
  if (candidate.source.type === "direct") {
    roles.add(LEADER_ROLE);
    return roles;
  }
  const sourceRun = store.getRun(item.taskId, candidate.source.runId);
  if (sourceRun === null
    || sourceRun.workItemId !== item.id
    || sourceRun.purpose !== "execution"
    || sourceRun.status !== "completed") {
    throw dataError(
      `WorkItem Candidate producer AgentRun is unavailable: ${item.id}/${candidate.source.runId}.`
    );
  }
  roles.add(sourceRun.roleName);
  if (sourceRun.sourceExecutionGroupId !== undefined) {
    const group = workItemExecutionGroupById(item, sourceRun.sourceExecutionGroupId);
    if (group === undefined) {
      throw dataError(
        `WorkItem Candidate ExecutionGroup is unavailable: `
        + `${item.id}/${sourceRun.sourceExecutionGroupId}.`
      );
    }
    for (const producer of selectedWorkItemSynthesisProducers(
      store, item, group, synthesisSourceRunIds(store, sourceRun)
    )) {
      roles.add(producer.roleName);
    }
  }
  return roles;
}

function assertCandidateReviewRoleIsolation(
  producerRoles: ReadonlySet<string>,
  reviewerRoleName: string,
  laneRoleNames: readonly string[]
): void {
  if (producerRoles.has(reviewerRoleName)) {
    throw usageError(
      `Reviewer Role must be separate from the Candidate producer: ${reviewerRoleName}.`
    );
  }
  const collidingLane = laneRoleNames.find((roleName) => producerRoles.has(roleName));
  if (collidingLane !== undefined) {
    throw usageError(
      `Review Producer Role must be separate from the Candidate producer: ${collidingLane}.`
    );
  }
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
  notifyMailbox(options.runtime, taskMailbox(updated.id));
  if (updated.status === "active") {
    notifyMailbox(options.runtime, leaderMailbox(updated.id));
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
  const result = updateTaskMetadataCommand(store, parsed.positionals[0], {
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
  }, options);
  return `Updated task ${result.id}\n`;
}

/** Shared domain transaction for structured capabilities and the CLI.
 * Parsing text flags must not become an alternate business write path. */
export function updateTaskMetadataCommand(
  store: TaskWorkflowStore,
  taskId: string,
  patch: Pick<TaskMetadataUpdate, "title" | "type" | "description" | "priority" | "tags" | "dueAt">,
  options: TaskCommandOptions = {}
): Task {
  if (Object.keys(patch).length === 0) throw usageError("At least one Task metadata field is required.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const current = requireTask(tx, taskId);
    if (current.status === "archived") throw usageError(`Task is archived: ${current.id}.`);
    taskActor(tx, options, current.id);
    const updated = updateTaskMetadata(current, patch, now);
    tx.saveTask(updated);
    recordTaskEvent(tx, updated.id, "task.updated", {
      status: updated.status,
      previous: editedFieldValues(current, Object.keys(patch)),
      current: editedFieldValues(updated, Object.keys(patch)),
      ...(updated.type === undefined ? {} : { taskType: updated.type })
    }, now);
    enqueueWork(tx, taskMailbox(updated.id), "task-updated", now, [taskRef(updated.id)]);
    return updated;
  });
  notifyMailbox(options.runtime, taskMailbox(result.id));
  return result;
}

/**
 * The single user/operator submission service (task-32 §2.3).
 *
 * CLI `yui task message send`, `yui operator submit`, the Web surface and the
 * `message.send` capability all route their user/operator submissions through
 * this one routine, so intent (record | discuss | develop) means exactly the
 * same thing everywhere and no surface owns a private notion of "submitting".
 *
 * It runs inside the caller's open transaction so the message, the phase read,
 * the planning-entered fact, and any develop activation request all commit
 * together. That single boundary is what decides a race: two concurrent
 * submissions each open `BEGIN IMMEDIATE`, so the second reads the phase and
 * activation the first already wrote and routes against them — the winner is
 * whoever commits first, with no separate lock.
 *
 * It never pre-enqueues a Draft Leader for a develop route and never invents a
 * second activation queue: it reuses {@link recordTaskActivationRequestInTransaction}
 * and enqueues only activation processing, leaving adoption at the existing
 * single boundary. Body text is never parsed to infer intent or authority.
 */
type SubmissionActor = "user" | "operator";

type UserSubmissionResult = Readonly<{
  task: Task;
  message: TaskMessage;
  routing: SubmissionRouting;
  feedback: SubmissionFeedback;
  /** True when this submission woke the Leader (planning entry/continuation or
   *  active-Task delivery); drives the post-commit mailbox notification. */
  queuedForLeader: boolean;
}>;

function routeUserSubmission(
  tx: TaskWorkflowStore,
  task: Task,
  actor: SubmissionActor,
  body: string,
  intent: TaskSubmissionIntent,
  now: Date,
  submissionKey?: string,
  target?: SubmissionTarget,
  inputControl?: TaskMessageContext["inputControl"]
): UserSubmissionResult {
  const kind: TaskMessageKind = actor;
  const author: TaskMessageAuthor = actor === "operator"
    ? { type: "operator" }
    : { type: "user" };

  // §2.3 keyed idempotency: a retry is detected by reading an existing keyed
  // Message, and its original disposition is reproduced from the receipt that
  // Message carries — never recomputed from current state. A matching key with
  // matching input and target replays; any mismatch conflicts.
  if (submissionKey !== undefined) {
    const prior = tx.listMessages(task.id).find(
      (message) => message.submissionKey === submissionKey
    );
    if (prior !== undefined) {
      return replayKeyedSubmission(task, prior, kind, body, intent, target);
    }
  }

  // Save first, recording intent and key, so the "saved" facet holds regardless of
  // how routing then resolves (§2.5). Intent is stored, never re-read from the body.
  const message = appendMessage(tx, task.id, body, kind, author, now, {
    intent,
    ...(submissionKey === undefined ? {} : { submissionKey }),
    ...(inputControl === undefined ? {} : { inputControl })
  });

  // Re-read phase and activation inside this same transaction: this is the point
  // the race is decided at (§2.3).
  const enteredPlanning = draftHasEnteredPlanning(tx, task);
  const activation = draftActivationState(task.activationRequest);
  const routing = decideSubmissionRouting({
    intent,
    status: task.status,
    enteredPlanning,
    activation,
    executionEnabled: task.executionGate.state === "enabled",
    // develop adopts no extra resource by guessing: the workspace is still built
    // from the Task's own Project bindings when it activates (§2.3).
    developEnvironmentPlan: { kind: "empty" }
  });

  let queuedForLeader = false;
  let activationRef: string | undefined;
  let activationFailure: string | undefined;
  switch (routing.kind) {
    case "record":
    case "planned-needs-manual-activation":
    case "activation-blocked-execution-stopped":
      // Save only. No Leader wake, no planning, no activation.
      break;
    case "await-activation":
      // The submission is a post-activation input or a report against an existing
      // request; it acts on nothing itself but surfaces the exact reference.
      activationRef = task.activationRequest === undefined
        ? undefined
        : taskActivationOperationRef(task.id, task.activationRequest.operation.requestId);
      if (routing.state === "failed") {
        activationFailure = task.activationRequest?.outcome;
      }
      break;
    case "enter-planning":
      // The one place the shared service itself writes the planning-entered fact,
      // in the same transaction as the message (§2.2 derivation source (a)).
      recordTaskEvent(tx, task.id, TASK_PLANNING_ENTERED_EVENT, {
        messageId: message.id,
        intent
      }, now);
      enqueueWork(tx, leaderMailbox(task.id), submissionEnqueueReason(actor), now,
        [messageRef(task.id, message.id)],
        { source: actor, dedupeKey: `message:${task.id}:${message.id}` });
      queuedForLeader = true;
      break;
    case "continue-planning":
    case "active-context":
      enqueueWork(tx, leaderMailbox(task.id), submissionEnqueueReason(actor), now,
        [messageRef(task.id, message.id)],
        { source: actor, dedupeKey: `message:${task.id}:${message.id}` });
      queuedForLeader = true;
      break;
    case "activate": {
      // Record the activation in-transaction, then queue only activation
      // processing. The requestId is derived from the message so a retried
      // submission cannot mint a second request.
      const identity = nonLeaderActivationIdentity(tx, actor);
      recordTaskActivationRequestInTransaction(tx, {
        taskId: task.id,
        requestId: `submit-${message.id}`,
        actorId: identity.actorId,
        authorityRef: identity.authorityRef,
        environmentPlan: routing.environmentPlan,
        origin: "submit-develop"
      }, now);
      activationRef = taskActivationOperationRef(task.id, `submit-${message.id}`);
      enqueueWork(tx, taskMailbox(task.id), "activation-requested", now, [taskRef(task.id)]);
      break;
    }
    default: {
      const exhaustive: never = routing;
      throw new Error(`Unhandled submission routing: ${JSON.stringify(exhaustive)}`);
    }
  }

  const feedback = describeSubmissionFeedback({
    taskId: task.id,
    messageId: message.id,
    status: task.status,
    enteredPlanning,
    activationState: activation,
    routing,
    ...(activationRef === undefined ? {} : { activationRef }),
    ...(activationFailure === undefined ? {} : { activationFailure })
  });

  // §2.3 receipt: a keyed submission records the disposition it actually received
  // (routing + feedback) and the target its key bound to, in this same
  // transaction, so a later retry reproduces exactly this outcome rather than
  // re-deriving one from a phase or activation that has since changed.
  if (submissionKey !== undefined && target !== undefined) {
    const receipted = withSubmissionReceipt(message, { target, routing, feedback });
    tx.updateMessage(task.id, receipted);
    return { task, message: receipted, routing, feedback, queuedForLeader };
  }
  return { task, message, routing, feedback, queuedForLeader };
}

/**
 * Reproduce a keyed submission's original outcome from the receipt it recorded
 * (task-32 §2.3), never by recomputing from the Task's current state. The prior
 * Message's frozen {@link SubmissionReceipt} names the routing it received and the
 * §2.5 feedback it returned, so a gate enabled or an activation cancelled after
 * the fact can no longer fabricate a different disposition. The replay writes
 * nothing — any Leader wake or activation request the original made already
 * exists — and preserves the original Task/Message/routing/request references
 * exactly.
 *
 * Same key with a different normalized input (kind, body or intent) or a
 * different target is a conflict, never a silent overwrite or a cross-target
 * replay. A prior keyed Message that carries no receipt (an old client, before
 * receipts existed) also conflicts rather than being replayed from a rebuilt
 * disposition.
 */
function replayKeyedSubmission(
  task: Task,
  prior: TaskMessage,
  kind: TaskMessageKind,
  body: string,
  intent: TaskSubmissionIntent,
  target?: SubmissionTarget
): UserSubmissionResult {
  const receipt = prior.submissionReceipt;
  if (prior.kind !== kind
    || prior.body !== body
    || normalizeSubmissionIntent(prior.intent) !== intent
    || receipt === undefined
    || (target !== undefined && !sameSubmissionTarget(receipt.target, target))) {
    throw new StorageConflictError(
      `Submission key ${prior.submissionKey} was already used for a different submission on ${task.id}/${prior.id}.`
    );
  }
  // Reproduce the recorded disposition verbatim; a retry acts on nothing itself.
  return {
    task,
    message: prior,
    routing: receipt.routing,
    feedback: receipt.feedback,
    queuedForLeader: false
  };
}

/** The mailbox reason a submission wake carries, preserving the existing
 *  operator-input / user-message vocabulary the Controller already understands. */
function submissionEnqueueReason(actor: SubmissionActor): string {
  return actor === "operator" ? "operator-input" : "user-message";
}

/**
 * Render the §2.5 feedback as CLI text, one facet per line, so the user always
 * sees the save, the phase, planning, activation, delivery and next step as
 * separate statements — never a single "started". Web and capability callers
 * return {@link SubmissionFeedback} structurally instead of this text.
 */
function renderSubmissionFeedback(feedback: SubmissionFeedback): string {
  const lines: string[] = [
    `Saved message ${feedback.saved.messageId} to ${feedback.saved.taskId}.`,
    `Phase: ${SUBMISSION_PHASE_LABEL[feedback.phase]}.`
  ];
  if (feedback.planning !== "none") {
    lines.push(`Planning: ${feedback.planning === "entered"
      ? "started; the Leader is queued to plan"
      : "continued; the Leader is queued"}.`);
  }
  if (feedback.activation !== "none") {
    lines.push(`Activation: ${SUBMISSION_ACTIVATION_LABEL[feedback.activation]}.`);
  }
  if (feedback.delivery === "queued" && feedback.planning === "none") {
    lines.push("Delivery: queued to the Leader.");
  }
  const nextStep = feedback.nextStep;
  if (nextStep !== undefined) lines.push(`Next: ${renderSubmissionNextStep(nextStep)}`);
  return `${lines.join("\n")}\n`;
}

const SUBMISSION_PHASE_LABEL: Record<SubmissionFeedback["phase"], string> = {
  active: "active",
  "draft-planning": "Draft, in planning",
  "draft-unplanned": "Draft, not yet in planning"
};

const SUBMISSION_ACTIVATION_LABEL: Record<SubmissionFeedback["activation"], string> = {
  none: "none",
  requested: "requested; activation is queued",
  pending: "already pending; this input waits for it",
  failed: "the previous request failed",
  "manual-required": "already planned; activate explicitly to develop",
  "execution-stopped": "not requested; execution is stopped"
};

function renderSubmissionNextStep(step: SubmissionNextStep): string {
  switch (step.kind) {
    case "activate-manually":
      return `request activation with "yui task activation request ${step.taskId} --request-id <id> --environment <plan>".`;
    case "start-execution":
      return `start execution with "yui task execution start ${step.taskId}", then submit develop again.`;
    case "await-pending-activation":
      return `wait for the pending activation ${step.activationRef}.`;
    case "resolve-failed-activation":
      return `retry with a new activation request or cancel ${step.activationRef} (failure: ${step.failure}).`;
    default: {
      const exhaustive: never = step;
      throw new Error(`Unhandled submission next step: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Parse and validate the CLI `--intent` option. Absent leaves it undefined so
 *  the shared service applies the discuss default (task-32 §2.5). */
function parseSubmissionIntentOption(
  raw: string | undefined,
  usage: string
): TaskSubmissionIntent | undefined {
  if (raw === undefined) return undefined;
  if ((TASK_SUBMISSION_INTENTS as readonly string[]).includes(raw)) {
    return raw as TaskSubmissionIntent;
  }
  throw usageError(`--intent must be one of ${TASK_SUBMISSION_INTENTS.join(", ")}: ${raw}.`, usage);
}

export function submitOperatorMessage(
  body: string,
  taskId: string | undefined,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {},
  intent?: TaskSubmissionIntent,
  submissionKey?: string
): string {
  const now = clock(options);
  const effectiveIntent = normalizeSubmissionIntent(intent);
  const result = store.transaction((tx) => {
    if (taskId !== undefined) {
      // Addressed submit: the key is scoped to this Task and dedups within it, so
      // no other Task is read (§2.3). Its target is this Task.
      const task = requireTask(tx, taskId);
      assertTaskOpen(task);
      const routed = routeUserSubmission(tx, task, "operator", body, effectiveIntent,
        now, submissionKey, { kind: "task", taskId: task.id });
      return { ...routed, created: false } as const;
    }
    // Task-less submit: the key is scoped to "create a new Task". A retry must
    // locate the Draft the original create produced — not any same-key Message on
    // an addressed Task — and a key already bound to a specific Task cannot be
    // reused to create (§2.3 "同 key 不同目标冲突").
    if (submissionKey !== undefined) {
      const lookup = findSubmissionKeyCreate(tx, submissionKey);
      if (lookup.kind === "create") {
        const task = requireTask(tx, lookup.taskId);
        const routed = routeUserSubmission(tx, task, "operator", body, effectiveIntent,
          now, submissionKey, { kind: "create" });
        return { ...routed, created: false } as const;
      }
      if (lookup.kind === "other-target") {
        throw new StorageConflictError(
          `Submission key ${submissionKey} is already bound to a specific Task; a task-less create cannot reuse it.`
        );
      }
    }
    const createdAgg = createTaskAggregate(tx, titleFrom(body), {}, now);
    const routed = routeUserSubmission(tx, createdAgg.task, "operator", body, effectiveIntent,
      now, submissionKey, { kind: "create" });
    return { ...routed, task: createdAgg.task, created: true } as const;
  });
  notifyMailbox(
    options.runtime,
    result.queuedForLeader ? leaderMailbox(result.task.id) : taskMailbox(result.task.id)
  );
  const header = result.created
    ? `Created Draft task ${result.task.id}: ${result.task.title}\n`
    : "";
  return `${header}${renderSubmissionFeedback(result.feedback)}`;
}

/**
 * Resolve a submission key for the task-less operator-create path (task-32 §2.3).
 * This is the one place a key is looked up across Tasks, mirroring the store's own
 * external-key lookups; the addressed path never scans beyond its own Task.
 *
 *  - `create`: a prior task-less create under this key exists (at most one, since a
 *    second create conflicts before it can save), so its Draft is the retry target.
 *  - `other-target`: the key exists only on Messages bound to a specific Task, so a
 *    task-less create would be reusing it for a different target — a conflict.
 *  - `unused`: the key is free, so a fresh Draft may be created under it.
 */
type SubmissionKeyResolution =
  | Readonly<{ kind: "create"; taskId: string }>
  | Readonly<{ kind: "other-target" }>
  | Readonly<{ kind: "unused" }>;

function findSubmissionKeyCreate(
  store: TaskWorkflowStore,
  submissionKey: string
): SubmissionKeyResolution {
  let otherTarget = false;
  for (const task of store.listTasks()) {
    for (const message of store.listMessages(task.id)) {
      if (message.submissionKey !== submissionKey) continue;
      if (message.submissionReceipt?.target.kind === "create") {
        return { kind: "create", taskId: task.id };
      }
      otherTarget = true;
    }
  }
  return otherTarget ? { kind: "other-target" } : { kind: "unused" };
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
  notifyMailbox(options.runtime, taskMailbox(created.task.id));
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

function listTaskCommand(args: string[], store: TaskWorkflowStore, environment: NodeJS.ProcessEnv = {}): TaskCommandExecution {
  const result = readTaskCatalog(store, parseTaskCatalogOptions(args), environment);
  return output(renderTaskCatalog(result), result);
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
  const archive = task.status === "archived" ? taskArchiveDiagnostics(store, task) : undefined;
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
    runs: store.listRuns(task.id).length,
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
    `AgentRuns: ${counts.runs}`,
    `ChangeSets: ${counts.changeSets}`,
    `Integration Attempts: ${counts.integrations}`,
    `Publication references: ${counts.publications} (${verifiedMergedPublications} verified merged)`,
    renderTaskRemoteDelivery(remoteDelivery).trimEnd(),
    ...(archive === undefined ? [] : [renderArchiveDiagnostics(archive).trimEnd()]),
    `Open inputs: ${counts.openInputs}`,
    `Created: ${presentTime(task.createdAt, timeZone)}`,
    `Updated: ${presentTime(task.updatedAt, timeZone)}`
  ].join("\n").concat("\n");
  return output(rendered, {
    task,
    counts,
    hasBrief: brief !== null,
    remoteDelivery,
    ...(archive === undefined ? {} : { archive })
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
    if (task.status === "cancelled") throw usageError(`Task is retired: ${task.id}.`);
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
        || activation.path !== task.cwd) {
        throw usageError(`Task workspace activation proof does not match ${task.id}.`);
      }
      // An empty environment plan over no bound Project is a legal Task shape,
      // so the proof of adoption is the *absence* of a workspace rather than a
      // ManagedWorkspace record. Demanding one here would have forced every
      // such activation to create a worktree purely to satisfy this check.
      if (taskOwnsManagedWorkspace(task)) {
        if (workspace === null
          || workspace.owner.type !== "task"
          || workspace.owner.taskId !== task.id
          || workspace.root !== task.cwd) {
          throw usageError(`Task workspace activation proof does not match ${task.id}.`);
        }
      } else if (workspace !== null
        || task.workspaceIdentity !== undefined
        || activation.path !== undefined) {
        throw usageError(
          `Workspace-free Task activation proof claims a workspace: ${task.id}.`
        );
      }
      return { task, changed: activation.changed } as const;
    }
    throw usageError(
      `Task ${task.id} activation requires atomic workspace adoption through the CLI preflight.`
    );
  });
  if (result.changed) {
    notifyMailbox(options.runtime, taskMailbox(result.task.id));
    notifyMailbox(options.runtime, leaderMailbox(result.task.id));
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
    // responsible for closing its own AgentRun, and the reusable Session keeps
    // its independent lifecycle.
    // Issue 06: re-validate the full completion readiness inside the
    // transaction (the CAS fence) after final-review preparation.  This is the
    // same pure projection `task next-action` displays. Once no Review is
    // needed, every remaining structural blocker fails closed.
    const readinessFacts = tx.readCompletionReadinessFacts(task.id);
    if (readinessFacts === null) throw taskNotFound(task.id);
    const readiness = projectCompletionReadiness(readinessFacts);
    if (!readiness.ready) {
      throw usageError(formatCompletionBlockers(task.id, readiness.blockers));
    }

    for (const ref of request.artifactRefs) {
      if (isGitArtifactRefString(ref)) {
        fixedArtifactRefs(task.id, [ref]);
      } else if (ref.startsWith("turn:")) {
        const run = tx.getRun(task.id, ref.slice("turn:".length));
        if (run === null || run.result === undefined) {
          throw usageError(`Task completion result ref is not readable: ${ref}.`);
        }
      } else if (!/^https?:\/\/[^\s]+$/u.test(ref)) {
        throw usageError("Completion --artifact-ref must be a commit-pinned git:<commit>:<relativePath> reference, turn:<local-turn-id>, or an explicit HTTP(S) reference URL.");
      }
    }
    const completed = completeTask(task, now, { by: actor, summary, artifactRefs: request.artifactRefs });
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
      ...(completed.completionArtifactRefs === undefined ? {} : {
        artifactRefs: JSON.stringify(completed.completionArtifactRefs)
      }),
      dispatchHistory: JSON.stringify(taskDispatchMailboxes(tx, task.id)),
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
    // signal queued while the final AgentRun was being settled must not survive a
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
    notifyMailbox(options.runtime, { kind: "operator" });
  }
  if (result.finalReview !== undefined) {
    const status = result.finalReview.status === "pending"
      ? `Final Task Review requested as ${result.finalReview.id}.`
      : `Final Task Review is blocked: ${
          result.finalReview.failure?.message ?? result.finalReview.id
        }.`;
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
    if (task.status !== "completed" && task.status !== "cancelled") {
      throw usageError(`Task is not completed or cancelled: ${task.id}.`);
    }
    const actor = taskActor(tx, options, task.id);
    if (task.status === "cancelled" && actor === "leader") {
      throw usageError("Restoring a cancelled Task requires user or Operator authority.");
    }
    const dispatchHistory = JSON.stringify(taskDispatchMailboxes(tx, task.id));
    // Reopening changes Task intent, not the disposition of existing inputs.
    // In particular, external messages and unknown deliveries remain owned by
    // their existing mailbox fences.
    const active = reopenTask(task, now);
    tx.saveTask(active);
    const reopenedReason = wakeReason("task-reopened");
    if (actor !== "leader") {
      enqueueWork(tx, leaderMailbox(task.id), reopenedReason, now, [taskRef(task.id)]);
    }
    enqueueWork(tx, taskMailbox(task.id), reopenedReason, now, [taskRef(task.id)]);
    recordTaskEvent(tx, task.id, "task.reopened", {
      status: active.status, by: actor, historicalInputs: "preserved", dispatchHistory,
      ...(actor === "leader" ? leaderActionEventPayload(tx, task.id, options) : {}),
      previous: editedFieldValues(task, [
        "status", "completedAt", "completedBy", "completionSummary", "completionArtifactRefs",
        "retiredAt", "retiredBy", "retirementSummary", "replacementTaskId", "retirementIsolation"
      ])
    }, now);
    return { task: active, changed: true, wakeLeader: actor !== "leader" } as const;
  });
  if (result.changed) {
    notifyMailbox(options.runtime, taskMailbox(result.task.id));
    if (result.wakeLeader) {
      notifyMailbox(options.runtime, leaderMailbox(result.task.id));
    }
  }
  return result.changed
    ? `Reopened task ${result.task.id}\n`
    : `Task ${result.task.id} is already active\n`;
}

function archiveTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const request = validateTaskArchiveRequest(args, store, options);
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, request.taskId);
    const actor = taskActor(tx, options, task.id);
    if (task.status === "archived") return { task, changed: false } as const;
    if (task.status !== "completed"
      && task.status !== "cancelled") {
      throw usageError(`Task ${task.id} must be completed or retired before it can be archived.`);
    }
    const remoteDelivery = request.force
      ? projectTaskRemoteDeliveryFromStore(tx, task)
      : request.disposition === "integrated"
      ? assertTaskRemoteDeliveryProof(
        tx,
        task,
        options.archiveRemoteDeliveryProof
      )
      : undefined;
    if (!request.force) {
      const checks = archiveSettlementChecks(tx, task);
      if (checks.length > 0) throw new CleanupInspectionError(checks);
      if (task.cwd !== undefined || tx.listManagedWorkspaces(task.id).length > 0) {
        throw usageError(`Task ${task.id} still has managed worktrees; clean them before archiving.`);
      }
      const activeRole = tx.listRoles(task.id)
        .find((role) => tx.getActiveRun(task.id, role.name) !== null);
      if (activeRole !== undefined) {
        throw usageError(
          `Task ${task.id} still has an active AgentRun for Role ${activeRole.name}; `
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
    }
    const retainedResources = request.force ? archiveRetainedResources(tx, task) : [];
    const warnings = request.force && remoteDelivery !== undefined ? archiveDeliveryWarnings(remoteDelivery) : [];
    const archived = { ...archiveTask(task, now, { by: actor }), executionGate: { state: "stopped" as const } };
    tx.saveTask(archived);
    tx.clearLeaderFailure(task.id);
    if (!request.force) {
      tx.clearPendingWakeup(task.id);
      for (const role of tx.listRoles(task.id)) {
        tx.removeWorkMailbox(roleMailbox(task.id, role.name));
      }
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
      ...(request.force ? {
        force: "true", cleanup: "pending",
        warnings: JSON.stringify(warnings),
        retainedResources: JSON.stringify(retainedResources)
      } : {}),
      ...(remoteDelivery === undefined
        ? {}
        : {
            mergeCoverage: remoteDelivery.status,
            allMerged: String(remoteDelivery.allMerged),
            allVerified: String(remoteDelivery.allVerified)
          }),
      ...(remoteProjectHeads === undefined ? {} : { projectHeads: remoteProjectHeads }),
      ...(remoteProjectBases === undefined ? {} : { projectBases: remoteProjectBases })
    }, now);
    return { task: archived, changed: true } as const;
  });
  if (result.changed && !request.force) options.runtime?.notifyMailboxChanged({ kind: "task", taskId: result.task.id });
  const diagnostics = taskArchiveDiagnostics(store, result.task);
  return output((result.changed
    ? `Archived task ${result.task.id}\n`
    : `Task ${result.task.id} is already archived\n`) + renderArchiveDiagnostics(diagnostics),
  { task: result.task, changed: result.changed, ...diagnostics });
}

function cancelTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task cancel usage: yui task cancel <task> (--summary <text>|--summary-file <path|->).";
  const parsed = parseTail(args, new Set(["--summary", "--summary-file"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = readCommandText(parsed.options.get("--summary"), parsed.options.get("--summary-file"), "--summary", usage);
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    const actor = taskActor(tx, options, task.id);
    const cancelled = retireTask(task, { by: actor, summary }, now);
    if (cancelled === task) return task;
    const dispatchHistory = JSON.stringify(taskDispatchMailboxes(tx, task.id));
    tx.saveTask(cancelled);
    tx.clearPendingWakeup(task.id);
    tx.clearLeaderFailure(task.id);
    for (const mailbox of tx.listWorkMailboxes()) {
      if ((mailbox.target.kind === "task" || mailbox.target.kind === "role")
        && mailbox.target.taskId === task.id) tx.removeWorkMailbox(mailbox.target);
    }
    const event = recordTaskEvent(tx, task.id, "task.cancelled", { by: actor, summary, dispatchHistory }, now);
    enqueueOperatorEvent(tx, event, "task-terminal", now);
    // Cancellation is intent, not fabricated proof that old processes stopped.
    // AgentRuns, inputs, WorkItems and their results remain independently readable.
    return cancelled;
  });
  options.runtime?.notifyMailboxChanged({ kind: "task", taskId: result.id });
  notifyMailbox(options.runtime, { kind: "operator" });
  return output(`Cancelled task ${result.id}\n`, { task: result });
}

/** Historical evidence only; these snapshots are never dispatch input. */
function taskDispatchMailboxes(store: TaskWorkflowStore, taskId: string) {
  return store.listWorkMailboxes().filter(({ target }) =>
    (target.kind === "task" || target.kind === "role") && target.taskId === taskId);
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
    if (task.status === "cancelled") {
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
      || integration.status === "conflicted"
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

    for (const run of tx.listRuns(task.id).filter(({ status: runStatus }) => (
      runStatus === "active"
    ))) {
      const terminal = terminalizeExactTaskRun(tx, {
        taskId: task.id,
        roleName: run.roleName,
        agentId: run.effective.agentId,
        runId: run.id,
        mailboxDisposition: "discard",
        outcome: {
          status: "failed",
          diagnostic: `Task retired: ${summary}`,
          failureReason: "cancelled"
        }
      }, now);
      if (terminal.disposition !== "applied") {
        throw usageError(
          `Task AgentRun changed during retirement: ${run.id}/${terminal.reason ?? "obsolete"}.`
        );
      }
    }

    for (const item of tx.listWorkItems(task.id)) {
      if (item.status === "accepted" || item.status === "retired") continue;
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
      isolated: true,
      ...(replacementTaskId === undefined ? {} : { replacementTaskId })
    }, now);
    tx.saveTask(retired);
    const terminalEvent = recordTaskEvent(tx, task.id, "task.retired", {
      by: actor,
      summary,
      isolationEstablished: "true",
      ...(replacementTaskId === undefined ? {} : { replacementTaskId })
    }, now);
    enqueueOperatorEvent(tx, terminalEvent, "task-terminal", now);
    return { task: retired, changed: true } as const;
  });
  if (result.changed) {
    options.runtime?.notifyMailboxChanged({ kind: "task", taskId: result.task.id });
    notifyMailbox(options.runtime, { kind: "operator" });
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
  args: readonly string[],
  command: "archive" | "archive-preflight" = "archive"
): Readonly<{
  taskId: string;
  disposition: "integrated" | "abandoned";
  force: boolean;
}> {
  const usage = "Task archive usage: "
    + `yui task ${command} <id> (--integrated|--abandon) [--force].`;
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
  const force = flags.includes("--force");
  if (integrated === abandoned) {
    throw usageError(usage);
  }
  return {
    taskId,
    disposition: integrated ? "integrated" : "abandoned",
    force
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
  const archiveActor = taskActor(store, options, task.id);
  if (archiveActor === "leader") {
    throw usageError("Task archive requires independent user or Operator authorization.");
  }
  if (task.status !== "archived"
    && task.status !== "completed"
    && task.status !== "cancelled") {
    throw usageError(`Task ${task.id} must be completed or retired before it can be archived.`);
  }
  if (task.status !== "archived" && !request.force) {
    const checks = archiveSettlementChecks(store, task);
    if (checks.length > 0) throw new CleanupInspectionError(checks);
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
  if (command === "handoff") {
    const usage = "Task message handoff usage: yui task message handoff <task/message> --to <role>.";
    const parsed = parseTail(rest, new Set(["--to"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const ref = taskRecordReference(parsed.positionals[0], "message", "Message reference", options);
    const now = clock(options);
    const message = store.transaction((tx) => {
      assertTaskDeliveryAuthority(tx, options.environment, ref.taskId);
      const current = tx.listMessages(ref.taskId).find((entry) => entry.id === ref.localId);
      if (current?.recipient?.ownerRunId === undefined || current.continuation?.runId !== undefined) {
        throw usageError("Only an unassigned pending Message can be explicitly handed off.");
      }
      const recipient = resolveMessageRecipient(tx, ref.taskId, requiredOption(parsed.options, "--to"), {
        ...(current.recipient.workItemId === undefined ? {} : { workItemId: current.recipient.workItemId }),
        ...(current.recipient.reviewRoundId === undefined ? {} : { reviewRoundId: current.recipient.reviewRoundId })
      });
      const updated = { ...current, recipient, continuation: {},
        handovers: [...(current.handovers ?? []), { from: current.recipient, at: now.toISOString() }] };
      const blocker = messageContinuationBlocker(tx, updated);
      if (blocker !== undefined) throw usageError(`Message handoff cannot proceed: ${blocker}.`);
      tx.updateMessage(ref.taskId, updated);
      recordTaskEvent(tx, ref.taskId, "message.handed-off", {
        messageId: current.id, fromRole: current.recipient.roleName, toRole: recipient.roleName,
        ownerRunId: recipient.ownerRunId
      }, now);
      enqueueWork(tx, taskMailbox(ref.taskId), "message-continuation", now, [messageRef(ref.taskId, current.id)]);
      return updated;
    });
    notifyMailbox(options.runtime, taskMailbox(ref.taskId));
    return output(`Handed off Message ${ref.localId} to ${message.recipient.roleName}.\n`, message);
  }
  if (command === "show") {
    const usage = "Task message show usage: yui task message show <task/message>.";
    exactPositionals(rest, 1, usage);
    const ref = taskRecordReference(rest[0], "message", "Message reference", options);
    const message = listContextMessages(store, ref.taskId, options.environment)
      .find((entry) => entry.id === ref.localId);
    if (message === undefined) throw dataError("Message is unavailable in the caller's scope.");
    const continuationRun = message.continuation?.runId === undefined
      ? null : store.getRun(ref.taskId, message.continuation.runId);
    const expanded = { ...expandTaskMessageResult(message, (task, run) => store.getRun(task, run)),
      ...(continuationRun === null ? {} : { execution: runExecutionObservation(continuationRun,
        store.getTaskRoleSessionSet(ref.taskId, continuationRun.roleName)?.providerBinding,
        store.listEvents(ref.taskId)) }) };
    return { kind: "output", output: `${JSON.stringify(expanded, null, 2)}\n`, data: expanded };
  }
  if (command === "send") {
    const usage = "Task message send usage: yui task message send <id> (<body>|--body-file <path|->) [--intent record|discuss|develop] [--request-id <key>] [--to <role> --work-item <id>|--review-round <id>].";
    const parsed = parseTail(
      rest,
      new Set(["--body-file", "--intent", "--request-id", "--to", "--work-item", "--review-round"]),
      usage
    );
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2) throw usageError(usage);
    const body = readCommandText(
      parsed.positionals[1],
      parsed.options.get("--body-file"),
      "--body",
      usage
    );
    const intent = parseSubmissionIntentOption(parsed.options.get("--intent"), usage);
    const submissionKey = parsed.options.get("--request-id");
    if (submissionKey !== undefined && submissionKey.trim().length === 0) {
      throw usageError("--request-id is required.", usage);
    }
    const recipientRole = parsed.options.get("--to");
    const workItemId = parsed.options.get("--work-item");
    const reviewRoundId = parsed.options.get("--review-round");
    if (recipientRole === undefined && (workItemId !== undefined || reviewRoundId !== undefined)) throw usageError("--to is required for scoped Message delivery.");
    const result = sendTaskMessageCommand(store, parsed.positionals[0], body, options,
      recipientRole === undefined ? undefined : { roleName: recipientRole, workItemId, reviewRoundId },
      intent, submissionKey);
    // A user/operator submission returns the unified §2.5 feedback; render each
    // facet on its own line and expose the structure to non-text callers.
    if (result.feedback !== undefined) {
      return output(renderSubmissionFeedback(result.feedback),
        { taskId: result.task.id, message: result.message, submission: result.feedback });
    }
    const reason = result.message.continuation?.notDeliveredReason;
    const delivery = reason !== undefined ? { state: "not-delivered", reason }
      : recipientRole !== undefined || result.queuedForLeader
        ? { state: "queued" } : { state: "saved" };
    return output(`Saved message ${result.message.id} to ${result.task.id} (${delivery.state}${reason === undefined ? "" : `: ${reason}`}).\n`,
      { taskId: result.task.id, message: result.message, delivery });
  }
  if (command === "queue") return queueTaskMessage(rest, store, options);
  if (command === "steer") return steerTaskMessage(rest, store, options);
  if (command === "list") {
    const messageListUsage = "Task message list usage: yui task message list <id> [--after <timestamp>] [--limit <n>].";
    const parsed = parseTail(rest, new Set(["--after", "--limit"]), messageListUsage);
    exactPositionals(parsed.positionals, 1, messageListUsage);
    const task = requireTask(store, parsed.positionals[0]);
    let messages = listContextMessages(store, task.id, options.environment);
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

/** CLI and authenticated user Surface share the same message and mailbox
 * transaction. Talking to Leader does not impersonate Leader authority. */
/**
 * `queue` is the explicit, idempotent form of the existing send: it persists a
 * Message tagged with the durable `queue` action and a stable requestId, and
 * relies on the identical continuation path as `send`. Repeating the exact same
 * (requestId, body) returns the original Message and delivers nothing twice;
 * reusing the requestId with different content is a conflict, never a second
 * input (decision-3 §5/§6).
 */
export function applyTaskInputControl(
  taskId: string, input: InputControlRequest, store: TaskWorkflowStore, options: TaskCommandOptions
): TaskCommandExecution {
  if (input.action === "queue") return queueTaskInput(taskId, input, store, options);
  if (input.action === "steer") return steerTaskInput(taskId, input, store, options);
  return interruptTaskInput(taskId, input, store, options);
}

function queueTaskMessage(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task message queue usage: yui task message queue <id> (<body>|--body-file <path|->) --request-id <id> [--to <role> --work-item <id>|--review-round <id>].";
  const parsed = parseTail(
    args,
    new Set(["--body-file", "--request-id", "--to", "--work-item", "--review-round"]),
    usage
  );
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) throw usageError(usage);
  const body = readCommandText(parsed.positionals[1], parsed.options.get("--body-file"), "--body", usage);
  const requestId = requiredOption(parsed.options, "--request-id");
  const recipientRole = parsed.options.get("--to");
  const workItemId = parsed.options.get("--work-item");
  const reviewRoundId = parsed.options.get("--review-round");
  return applyTaskInputControl(parsed.positionals[0]!, {
    action: "queue", body, requestId, to: recipientRole, workItem: workItemId, reviewRound: reviewRoundId
  }, store, options);
}

function queueTaskInput(
  taskId: string, input: Extract<InputControlRequest, { action: "queue" }>,
  store: TaskWorkflowStore, options: TaskCommandOptions
): TaskCommandExecution {
  const { body, requestId, to: recipientRole, workItem: workItemId, reviewRound: reviewRoundId } = input;
  if (recipientRole === undefined && (workItemId !== undefined || reviewRoundId !== undefined)) {
    throw usageError("--to is required for scoped Message delivery.");
  }
  const result = sendTaskMessageCommand(store, taskId, body, options,
    recipientRole === undefined ? undefined : { roleName: recipientRole, workItemId, reviewRoundId },
    undefined, undefined, { action: "queue", requestId });
  const reason = result.message.continuation?.notDeliveredReason;
  const delivery = result.idempotentReplay ? { state: "idempotent-replay" }
    : reason !== undefined ? { state: "not-delivered", reason }
    : recipientRole !== undefined || result.actor !== "leader" ? { state: "queued" } : { state: "saved" };
  return output(`Queued message ${result.message.id} to ${result.task.id} (${delivery.state}${reason === undefined ? "" : `: ${reason}`}).\n`,
    { taskId: result.task.id, message: result.message, delivery });
}

/**
 * `steer` targets only the exact current native Turn. It always persists the
 * Message (so an unsupported or missed steer stays visible and re-choosable),
 * then resolves the live target from durable state with no Provider call. On a
 * ready resolution it returns a structured intent the CLI performs against the
 * Agent Host; on any explicit failure it returns the saved Message plus the
 * exact error code, and never falls back to an interrupt or a queue
 * (decision-3 §1/§5). The steer Message is excluded from the queued
 * continuation path, so a failed live attempt cannot silently become a queue.
 */
function steerTaskMessage(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task message steer usage: yui task message steer <id> (<body>|--body-file <path|->) --request-id <id> --expected-target <turn> [--to <role> --work-item <id>|--review-round <id>].";
  const parsed = parseTail(
    args,
    new Set(["--body-file", "--request-id", "--expected-target", "--to", "--work-item", "--review-round"]),
    usage
  );
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) throw usageError(usage);
  const body = readCommandText(parsed.positionals[1], parsed.options.get("--body-file"), "--body", usage);
  const requestId = requiredOption(parsed.options, "--request-id");
  const expectedTarget = requiredOption(parsed.options, "--expected-target");
  const recipientRole = parsed.options.get("--to");
  const workItemId = parsed.options.get("--work-item");
  const reviewRoundId = parsed.options.get("--review-round");
  if (recipientRole === undefined) {
    throw usageError("steer requires --to <role>; it targets that Role's exact current Turn.");
  }
  return applyTaskInputControl(parsed.positionals[0]!, {
    action: "steer", body, requestId, expectedTarget, to: recipientRole,
    workItem: workItemId, reviewRound: reviewRoundId
  }, store, options);
}

function steerTaskInput(
  taskId: string, input: Extract<InputControlRequest, { action: "steer" }>,
  store: TaskWorkflowStore, options: TaskCommandOptions
): TaskCommandExecution {
  const { body, requestId, expectedTarget, to: recipientRole, workItem: workItemId, reviewRound: reviewRoundId } = input;
  // decision-3 §9: a Task Leader's current native turn (including a Draft's
  // planning turn) is a real turn but NOT an implicit AgentRun, so steering it
  // never establishes a Worker-style Assignment. It is persisted as an ordinary
  // no-Run Leader notification (recipient undefined, wake "none" so it never
  // spawns a Leader AgentRun) and its live target is the Leader's own turn. A
  // Worker/Reviewer steer keeps the exact Assignment recipient it always had.
  const leaderTarget = recipientRole === "leader";
  if (leaderTarget && (workItemId !== undefined || reviewRoundId !== undefined)) {
    throw usageError("Steering the Leader targets its current turn directly; it takes no --work-item/--review-round Assignment.");
  }
  const result = leaderTarget
    ? sendTaskMessageCommand(store, taskId, body, options,
        undefined, undefined, undefined, { action: "steer", requestId, expectedTarget })
    : sendTaskMessageCommand(store, taskId, body, options,
        { roleName: recipientRole, workItemId, reviewRoundId }, undefined, undefined,
        { action: "steer", requestId, expectedTarget });
  const roleName = result.message.recipient?.roleName ?? recipientRole;
  if (result.idempotentReplay) {
    // A replay is a later reader (another CLI invocation): surface the durable
    // control state the Host settlement folded onto this exact Message, so an
    // unknown steer is visibly not-submitted/pending/accepted/rejected/
    // delivery-unknown rather than silently re-attempted (message-5 gap D).
    const controlState = taskMessageInputControlState(result.message);
    return output(`Steer message ${result.message.id} already recorded (idempotent-replay${
      controlState === undefined ? "" : `; control ${controlState}`}).\n`,
      { taskId: result.task.id, message: result.message,
        steer: { state: "idempotent-replay" as const,
          ...(controlState === undefined ? {} : { control: controlState }) } });
  }
  // The static resolution is the testable contract: capability gate, exact-turn
  // match, and writer fence, all from durable state without a live Endpoint.
  const resolution = resolveTaskInputControl(store, result.task.id, roleName, "steer", expectedTarget);
  if (resolution.outcome !== "ready") {
    return output(`Steer message ${result.message.id} saved but not delivered (${resolution.code}: ${resolution.detail}).\n`,
      { taskId: result.task.id, message: result.message,
        steer: { state: "not-steered" as const, code: resolution.code, detail: resolution.detail } });
  }
  if (!leaderTarget) {
    const current = store.getActiveRun(result.task.id, roleName);
    const native = store.getTaskRoleSessionSet(result.task.id, roleName)?.providerBinding?.run;
    const recipient = result.message.recipient;
    if (current === null || native?.runId !== current.id
      || recipient?.ownerRunId !== current.id
      || recipient.workItemId !== current.workItemId
      || recipient.reviewRoundId !== current.reviewRoundId
      || messageContinuationBlocker(store, result.message) !== undefined) {
      return output(`Steer message ${result.message.id} saved but not delivered (TARGET_CHANGED: active Assignment differs).\n`,
        { taskId: result.task.id, message: result.message,
          steer: { state: "not-steered", code: "TARGET_CHANGED", detail: "The input does not belong to the active Turn's Assignment." } });
    }
  }
  const receiptId = `steer:${result.task.id}/${result.message.id}`;
  // Register the one independent control attempt as `pending` before the live
  // edge runs (decision-3 §3, message-5 gap D). This is the messageRef-associated
  // control op that makes a dispatched-but-unproven steer visibly distinct from a
  // steer that was merely saved and never attempted (`not-submitted`). It is
  // keyed by this exact receiptId and the steer's own requestId, and is monotonic
  // and idempotent, so the Host's later settlement fold promotes it to a proven
  // terminal and never rewinds it. An idempotent replay above already returned
  // the saved Message, so this records the attempt exactly once.
  store.transaction((tx) => {
    const saved = tx.listMessages(result.task.id).find((entry) => entry.id === result.message.id);
    const requestId = saved?.inputControl?.requestId;
    if (saved === undefined || requestId === undefined) return;
    tx.updateMessage(result.task.id, recordTaskMessageControlOutcome(saved, {
      requestId, receiptId, outcome: "pending", observedAt: clock(options)
    }));
  });
  return {
    kind: "input-steer",
    taskId: result.task.id,
    roleName,
    messageId: result.message.id,
    target: resolution.target,
    receiptId,
    // decision-3 §9: deliver the input as an authorized, reconcilable delta, not
    // loose body text and not a bare Message id. The Host additionally decorates
    // this with the Session Manifest read pointer, so the running turn can read
    // the exact durable Message through its authorized Context path.
    text: steerInputDelivery(result.task.id, result.message.id, roleName, body),
    output: `Steering ${result.task.id}/${roleName} at Turn ${resolution.target.nativeTurnId ?? resolution.target.attemptId} with message ${result.message.id}.\n`
  };
}

/** Compose the exact input a steer pushes into the live turn: a bounded header
 * that names the durable Message and states receipt-is-not-acceptance, then the
 * verbatim body. The header keeps the input reconcilable with durable state
 * (decision-3 §9) without copying the body twice or fabricating a Run. */
function steerInputDelivery(taskId: string, messageId: string, roleName: string, body: string): string {
  return [
    `[Steer ${taskId}/${messageId} → ${roleName}] Additional input to your current turn; receipt is not acceptance of prior work.`,
    `It is saved durably as Message ${messageId}; reconcile it through your Session Manifest's authorized Context read path.`,
    "",
    body
  ].join("\n");
}

/** CLI and authenticated user Surface share the same message and mailbox
 * transaction. Talking to Leader does not impersonate Leader authority. */
/**
 * The one transaction that turns an inbound Task Message into durable facts and,
 * when the Task's own lifecycle calls for it, Leader work.
 *
 * CLI `task message send` and the Web Task surface both call this, so neither
 * owns a private notion of what "sending a message" means. The Draft case is the
 * reason that matters here: a Draft's Leader conversation is its planning Turn,
 * so a Draft must wake its Leader exactly like an active Task does. Gating the
 * wake on `active` would leave the Draft entry point saving text that no Leader
 * ever reads — the message would be persisted and silently go nowhere, which is
 * indistinguishable to the user from a Provider that never answered.
 *
 * The wake carries intent only. Whether the resulting Turn is planning or
 * execution is decided by the Controller from the Task's own status, so this
 * function never names a purpose and no second planning path exists.
 */
export function sendTaskMessageCommand(
  store: TaskWorkflowStore, taskId: string, body: string,
  options: TaskCommandOptions = {},
  recipient?: Readonly<{ roleName: string; workItemId?: string; reviewRoundId?: string }>,
  intent?: TaskSubmissionIntent,
  submissionKey?: string,
  inputControl?: Readonly<{ action: TaskMessageInputAction; requestId: string; expectedTarget?: string }>
) {
  if (!body.trim()) throw usageError("Message body is required.");
  if (recipient !== undefined && intent !== undefined) {
    throw usageError("A submission intent applies only to unaddressed Leader Messages; an owner-directed Message uses its exact continuation boundary.");
  }
  if (recipient !== undefined && submissionKey !== undefined) {
    throw usageError("A submission key applies only to unaddressed Leader Messages; an owner-directed Message uses its exact continuation boundary.");
  }
  const now = clock(options);
  const result = store.transaction((tx): Readonly<{
    task: Task; message: TaskMessage; actor: string;
    queuedForLeader: boolean; feedback: SubmissionFeedback | undefined;
    idempotentReplay?: boolean;
  }> => {
    const task = requireTask(tx, taskId);
    // A stable requestId makes the whole send idempotent: an exact repeat
    // returns the original Message, and any different body/action/recipient/
    // target under the same id is a conflicting reuse, never a silent second
    // input (decision-3 §6). The prior input is matched by requestId across
    // both a live inputControl and the reusedInput provenance an interrupt-then
    // handoff preserved, so re-tagging a steer as a handoff never frees its
    // requestId to create a second Message.
    if (inputControl !== undefined) {
      const existing = tx.listMessages(task.id).find((entry) =>
        entry.inputControl?.requestId === inputControl.requestId
        || entry.interruptThen?.reusedInput?.requestId === inputControl.requestId);
      if (existing !== undefined) {
        const prior = existing.inputControl ?? existing.interruptThen?.reusedInput;
        const priorRecipient = existing.recipient === undefined ? undefined
          : { roleName: existing.recipient.roleName, workItemId: existing.recipient.workItemId,
              reviewRoundId: existing.recipient.reviewRoundId };
        const nextRecipient = recipient === undefined ? undefined
          : { roleName: recipient.roleName, workItemId: recipient.workItemId, reviewRoundId: recipient.reviewRoundId };
        if (prior?.action !== inputControl.action || existing.body !== body
          || prior.expectedTarget !== inputControl.expectedTarget
          || !isDeepStrictEqual(priorRecipient, nextRecipient)) {
          throw usageError(
            `Input requestId ${inputControl.requestId} was already used with different content or target; use a new requestId for a new input.`);
        }
        return { task, message: existing, actor: replayActor(existing), queuedForLeader: false,
          feedback: existing.submissionReceipt?.feedback, idempotentReplay: true };
      }
    }
    if (recipient === undefined) assertTaskOpen(task);
    const caller = currentManagedRuntime(tx, options.environment, task.id);
    const roleCaller = caller !== undefined && caller.roleName !== "leader" ? caller : undefined;
    if (roleCaller !== undefined) {
      const run = roleCaller.currentRunId === undefined ? null : tx.getRun(task.id, roleCaller.currentRunId);
      if (run === null || recipient?.roleName !== "leader"
        || recipient.workItemId !== run.workItemId || recipient.reviewRoundId !== run.reviewRoundId) {
        throw usageError("A Worker or Reviewer may send only to Leader within its current Assignment.");
      }
    }
    const actor = roleCaller === undefined ? taskActor(tx, options, task.id) : "role";
    // A user/operator Message with no explicit recipient is the single path that
    // carries submission intent (record | discuss | develop). It routes through
    // the one shared submission service so intent means exactly the same thing
    // here as on every other surface. Internal role/leader result messages and
    // owner-directed continuations keep their exact existing boundary and never
    // gain develop authority (task-32 §2.5).
    if (recipient === undefined && (actor === "user" || actor === "operator")) {
      const effectiveIntent = inputControl?.action === "steer" ? "record" : normalizeSubmissionIntent(intent);
      const routed = routeUserSubmission(tx, task, actor, body, effectiveIntent,
        now, submissionKey, { kind: "task", taskId: task.id }, inputControl);
      return {
        task: routed.task, message: routed.message, actor,
        queuedForLeader: routed.queuedForLeader, feedback: routed.feedback, idempotentReplay: false
      };
    }
    if (intent !== undefined) {
      throw usageError("Submission intent applies only to an unaddressed user or Operator Message.");
    }
    if (recipient !== undefined && actor === "leader") assertTaskDeliveryAuthority(tx, options.environment, task.id);
    const target: TaskMessageContext["recipient"] = recipient === undefined ? undefined
      : recipient.roleName === "leader" && roleCaller !== undefined ? {
        roleName: "leader", ...(recipient.workItemId === undefined ? {} : { workItemId: recipient.workItemId }),
        ...(recipient.reviewRoundId === undefined ? {} : { reviewRoundId: recipient.reviewRoundId })
      } : resolveMessageRecipient(tx, task.id, recipient.roleName, {
        ...(recipient.workItemId === undefined ? {} : { workItemId: recipient.workItemId }),
        ...(recipient.reviewRoundId === undefined ? {} : { reviewRoundId: recipient.reviewRoundId }) });
    const context: TaskMessageContext = {
      ...(target === undefined ? {} : { recipient: target }),
      ...(recipient?.workItemId === undefined ? {} : { workItemId: recipient.workItemId }),
      ...(inputControl === undefined ? {} : { inputControl })
    };
    const message = actor === "leader"
      ? appendMessage(tx, task.id, body, "role-result", { type: "role", roleName: LEADER_ROLE }, now, context)
      : actor === "role"
        ? appendMessage(tx, task.id, body, "role-result", { type: "role", roleName: roleCaller!.roleName }, now, context)
      : actor === "operator"
        ? appendMessage(tx, task.id, body, "operator", { type: "operator" }, now, context)
        : appendMessage(tx, task.id, body, "user", { type: "user" }, now, context);
    // Reached only by addressed Messages and by an unaddressed Leader result now:
    // unaddressed user/operator submissions are handled above by the shared
    // service. A Worker/Reviewer message addressed to its Leader still wakes the
    // Leader exactly as before; an owner-directed continuation posts to the Task
    // mailbox for its exact owner Run.
    const queuedForLeader = target?.ownerRunId === undefined
      && leaderWakingTaskStatus(task.status) && actor !== "leader";
    if (target?.ownerRunId !== undefined) {
      const reason = messageContinuationBlocker(tx, message);
      if (reason !== undefined) {
        message.continuation = { notDeliveredReason: reason };
        tx.updateMessage(task.id, message);
      }
      enqueueWork(tx, taskMailbox(task.id), "message-continuation", now,
        [messageRef(task.id, message.id)], { dedupeKey: `message:${task.id}:${message.id}` });
    } else if (queuedForLeader) {
      enqueueWork(tx, leaderMailbox(task.id), actor === "operator" ? "operator-input" : "user-message",
        now, [messageRef(task.id, message.id)], { source: actor, dedupeKey: `message:${task.id}:${message.id}` });
    }
    return { task, message, actor, queuedForLeader, feedback: undefined, idempotentReplay: false };
  });
  if (result.idempotentReplay) return result;
  if (recipient !== undefined) {
    notifyMailbox(options.runtime, taskMailbox(result.task.id));
  } else if (result.actor !== "leader") {
    notifyMailbox(options.runtime, result.queuedForLeader
      ? leaderMailbox(result.task.id) : taskMailbox(result.task.id));
  }
  return result;
}

/** The durable author of an already-persisted Message, for an idempotent replay
 * that must return the same actor label the original send computed. */
function replayActor(message: TaskMessage): "leader" | "role" | "operator" | "user" {
  if (message.author.type === "role") return message.author.roleName === LEADER_ROLE ? "leader" : "role";
  return message.author.type === "operator" ? "operator" : "user";
}

/**
 * Whether an inbound Message on a Task in this status is delivered to its
 * Leader. Draft qualifies because planning is a Leader conversation that
 * deliberately precedes any delivery environment or Activation (S01); a
 * terminal Task has no Leader lane and keeps the message as context only.
 */
export function leaderWakingTaskStatus(status: TaskStatus): boolean {
  return status === "active" || status === "draft";
}

function updateMessage(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task message update usage: yui task message update <task>/<message> (<body>|--body-file <path|->).";
  const parsed = parseTail(args, new Set(["--body-file"]), usage);
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) throw usageError(usage);
  const body = readCommandText(
    parsed.positionals[1],
    parsed.options.get("--body-file"),
    "--body",
    usage
  );
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
      body
    });
    tx.updateMessage(task.id, updated);
    recordTaskEvent(tx, task.id, "message.updated", {
      messageId: updated.id,
      updatedBy: actor
    }, now);
    const queuedForLeader = updated.wakePolicy !== "none";
    if (queuedForLeader) {
      enqueueWork(tx, leaderMailbox(task.id), actor === "operator" ? "operator-input" : "user-message",
        now, [messageRef(task.id, updated.id)], { source: actor });
    }
    return { task, message: updated, queuedForLeader };
  });
  notifyMailbox(options.runtime, result.queuedForLeader
    ? leaderMailbox(result.task.id) : taskMailbox(result.task.id));
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
    if (leaderWakingTaskStatus(task.status)) {
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
  if (result.changed) options.runtime?.notifyMailboxChanged({ kind: "task", taskId: result.task.id });
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
  notifyMailbox(options.runtime, leaderMailbox(task.id));
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
  if (command === "show") return showTaskRole(rest, store);
  if (command === "update") return updateTaskRole(rest, store, options);
  if (command === "remove") return output(removeTaskRole(rest, store, options));
  if (command === "bind") return output(bindTaskRole(rest, store, options));
  if (command === "unbind") return output(unbindTaskRole(rest, store, options));
  if (command === "session") return taskRoleSessionCommand(rest, store, options);
  if (command === "interrupt") return interruptTaskRole(rest, store, options);
  if (command === "view") return viewTaskRole(rest, store);
  if (command === "takeover") return transferTaskRoleAuthority(rest, store, options, "takeover");
  if (command === "release") return transferTaskRoleAuthority(rest, store, options, "release");
  throw usageError(command === undefined
    ? "Task role command is required."
    : `Unknown command: task role ${command}`);
}

/**
 * `interrupt` stops the exact current native Turn through the Provider's own
 * native cancel, and never through an owned-process kill, restart, or detach
 * (decision-3 §1/§7). It is a control operation, not a persisted Message, so it
 * carries no body of its own.
 *
 * The optional `--then-message` is the explicit continuation handoff
 * (decision-3 §4): it names a Message the Leader already saved (typically the
 * one a failed steer left behind, reusing that Message's original ref) and
 * claims "deliver this once, in the same Session, after the interrupted Turn
 * reaches a proven terminal, without the prior queue preempting it." The claim
 * is registered on the durable Message before the live cancel. Registration is
 * idempotent per interrupt requestId, and only one continuation may claim a
 * given target AgentRun; a conflicting second claim is refused, never silently
 * dropped or duplicated.
 */
function interruptTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task role interrupt usage: yui task role interrupt <task> <role> --expected-target <turn> [--then-message <task/message>] [--request-id <id>].";
  const parsed = parseTail(args, new Set(["--expected-target", "--then-message", "--request-id"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const expectedTarget = requiredOption(parsed.options, "--expected-target");
  const thenMessageRef = optionalNonEmptyOption(parsed.options, "--then-message");
  const requestId = optionalNonEmptyOption(parsed.options, "--request-id");
  return applyTaskInputControl(parsed.positionals[0]!, {
    action: "interrupt", expectedTarget, role: parsed.positionals[1]!, thenMessage: thenMessageRef, requestId
  }, store, options);
}

function interruptTaskInput(
  taskId: string, input: Extract<InputControlRequest, { action: "interrupt" }>,
  store: TaskWorkflowStore, options: TaskCommandOptions
): TaskCommandExecution {
  const { expectedTarget, thenMessage: thenMessageRef, requestId } = input;
  const now = clock(options);
  const task = requireTask(store, taskId);
  const role = requireRole(store, task.id, input.role);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    roleName: role.name, expectedTarget, thenMessageRef: thenMessageRef ?? null
  })).digest("hex");
  const operationId = requestId ?? `interrupt-${fingerprint}`;
  let receiptId = "";
  const resolved = store.transaction((tx): TaskCommandExecution | ResolvedInputTarget => {
    assertTaskOpen(task);
    assertTaskInputControlAuthority(tx, options.environment, task.id, role.name);
    const previous = findTaskInterrupt(tx, task.id, operationId);
    if (previous !== undefined) {
      if (previous.payload.fingerprint !== fingerprint) throw usageError("Interrupt requestId already names a different target or then input.");
      return output("Interrupt already recorded; no native request was repeated.\n", {
        taskId: task.id, roleName: role.name, interrupt: {
          state: "idempotent-replay", receipt: taskInterruptReceipt(tx, task.id, previous.payload.receiptId!)
        }
      });
    }
    const resolution = resolveTaskInputControl(tx, task.id, role.name, "interrupt", expectedTarget);
    if (resolution.outcome !== "ready") {
      return output(`Interrupt not delivered (${resolution.code}: ${resolution.detail}).\n`,
        { taskId: task.id, roleName: role.name,
          interrupt: { state: "not-interrupted", code: resolution.code, detail: resolution.detail } });
    }
    const priorTarget = tx.listEvents(task.id).find(event => event.type === "input.interrupt-requested"
      && event.payload.roleName === role.name && event.payload.nativeSessionId === resolution.target.nativeSessionId
      && event.payload.attemptId === resolution.target.attemptId
      && !taskInterruptWasRejected(tx, task.id, event.payload.receiptId!));
    if (priorTarget !== undefined) {
      return output("This exact Turn already has an interrupt request; inspect its original receipt.\n", {
        taskId: task.id, roleName: role.name, interrupt: {
          state: "not-interrupted", code: "DELIVERY_UNKNOWN", receiptId: priorTarget.payload.receiptId
        }
      });
    }
    if (thenMessageRef !== undefined) {
      const claimResult = registerInterruptThen(tx, task.id, role.name, thenMessageRef,
        resolution.target, operationId, options, now);
      if (claimResult !== "claimed") {
        return output(`Interrupt not delivered (${claimResult.code}: ${claimResult.detail}).\n`,
          { taskId: task.id, roleName: role.name,
            interrupt: { state: "not-interrupted", code: claimResult.code, detail: claimResult.detail } });
      }
    }
    receiptId = reserveTaskInterrupt(tx, task.id, operationId, fingerprint, resolution.target, thenMessageRef, now);
    return resolution.target;
  });
  if ("kind" in resolved) return resolved;
  return {
    kind: "input-interrupt",
    taskId: task.id,
    roleName: role.name,
    target: resolved,
    receiptId,
    ...(thenMessageRef === undefined ? {} : {
      thenMessageId: taskRecordReference(thenMessageRef, "message", "Then Message reference", options).localId }),
    output: `Interrupting ${task.id}/${role.name} at Turn ${resolved.nativeTurnId ?? resolved.attemptId}`
      + `${thenMessageRef === undefined ? "" : `, then delivering ${thenMessageRef} once after a proven terminal`}.\n`
  };
}

/**
 * Bind a saved Message as the one continuation of a target AgentRun. The target
 * run is the exact interrupted Turn's durable AgentRun; the claim is refused
 * when the target has no AgentRun (a native-only Turn cannot prove its terminal
 * for a later same-Session delivery), when the Message is unknown or not a
 * legal saved input to reuse, or when another continuation already claims that
 * run.
 *
 * The Message being reused must be a legal handoff for this exact interrupt: it
 * must belong to this Role's current Assignment, must not already have been
 * delivered or marked undeliverable, and must not still be a live control op.
 * Its original input identity is preserved as `interruptThen.reusedInput`
 * provenance rather than erased, so a replay of that requestId keeps resolving
 * to this same Message and never creates a second input (decision-3 §3).
 */
function registerInterruptThen(
  store: TaskWorkflowStore, taskId: string, roleName: string, thenMessageRef: string,
  target: ResolvedInputTarget, requestId: string | undefined, options: TaskCommandOptions, now: Date
): "claimed" | Readonly<{ code: "DELIVERY_UNKNOWN" | "TARGET_CHANGED"; detail: string }> {
  const targetAttemptId = target.attemptId;
  const ref = taskRecordReference(thenMessageRef, "message", "Then Message reference", options);
  if (ref.taskId !== taskId) {
    return { code: "TARGET_CHANGED", detail: "The then-Message belongs to another Task." };
  }
  const message = store.listMessages(taskId).find((entry) => entry.id === ref.localId);
  if (message === undefined) {
    return { code: "TARGET_CHANGED", detail: `Then-Message ${thenMessageRef} is unknown.` };
  }
  // The claim is keyed on the exact interrupted native Turn (targetAttemptId),
  // which the resolution proved present under the current Session. An AgentRun
  // owns the Turn for a Worker/Reviewer Assignment; a Leader's own management or
  // Draft planning Turn is a real native Turn with NO AgentRun (decision-3 §9,
  // message-5 gap B). The claim never invents a Run to prove a terminal — the
  // native Turn is the primary proof, and targetRunId is recorded only when a Run
  // actually owns the Turn.
  const active = store.getActiveRun(taskId, roleName);
  // A synthesized fallback id is an opaque idempotency key (compared only for
  // equality, never parsed), so it must satisfy the same safe-identity rule as a
  // caller-supplied requestId: no path separators. Use `:` as the field joiner —
  // the receiptId carries the `/`-shaped human receipt, this key stays slash-free.
  const claimRequestId = requestId ?? `interrupt:${taskId}:${roleName}:${targetAttemptId}`;
  // Idempotent per interrupt requestId: an exact repeat of the same claim (same
  // request, same native Turn) is a no-op that still authorizes the live cancel.
  if (message.interruptThen !== undefined) {
    const prior = findTaskInterrupt(store, taskId, message.interruptThen.requestId);
    const canReferenceClaim = message.interruptThen.requestId === claimRequestId
      || (prior !== undefined && taskInterruptWasRejected(store, taskId, prior.payload.receiptId!));
    if (canReferenceClaim && message.interruptThen.notDeliveredReason === undefined
      && message.interruptThen.targetAttemptId === targetAttemptId
      && message.interruptThen.targetNativeSessionId === target.nativeSessionId
      && message.interruptThen.targetAgentId === target.agentId
      && message.interruptThen.targetAdapterId === target.adapterId
      && message.interruptThen.targetRoleName === roleName
      && message.interruptThen.targetAuthorityEpoch === target.authority.epoch
      && message.interruptThen.targetAuthorityHolderId === target.authority.holderId) return "claimed";
    return { code: "TARGET_CHANGED",
      detail: `Message ${thenMessageRef} already claims a continuation of Turn ${message.interruptThen.targetAttemptId}.` };
  }
  const inputState = taskMessageInputControlState(message);
  if (inputState === "accepted" || inputState === "pending" || inputState === "delivery-unknown") {
    return {
      code: inputState === "accepted" ? "TARGET_CHANGED" : "DELIVERY_UNKNOWN",
      detail: `Message ${thenMessageRef} has steer disposition ${inputState}; it cannot be submitted again.`
    };
  }
  // The reused Message must be a legal handoff for this exact interrupt. A
  // Worker/Reviewer handoff must be addressed to the interrupted Assignment; a
  // no-Run Leader handoff (its own management/Draft turn) reuses a Leader input,
  // which is never addressed to a Worker Assignment (no ownerRunId).
  if (roleName !== LEADER_ROLE) {
    if (active === null || message.recipient?.roleName !== roleName || message.recipient.ownerRunId !== active.id) {
      return { code: "TARGET_CHANGED",
        detail: `Message ${thenMessageRef} is not addressed to the current execution Assignment.` };
    }
  } else if (message.recipient?.ownerRunId !== undefined) {
    return { code: "TARGET_CHANGED",
      detail: `Message ${thenMessageRef} is addressed to an execution Assignment and cannot be a no-Run ${roleName} handoff.` };
  }
  // A Message that already delivered, or was already ruled undeliverable, is not
  // a fresh input to reuse; reusing it would replay or resurrect a settled fact.
  if (message.continuation?.runId !== undefined) {
    return { code: "TARGET_CHANGED", detail: `Message ${thenMessageRef} was already delivered by ${message.continuation.runId}.` };
  }
  if (message.continuation?.notDeliveredReason !== undefined) {
    return { code: "TARGET_CHANGED",
      detail: `Message ${thenMessageRef} was already settled not-delivered (${message.continuation.notDeliveredReason}).` };
  }
  // Only one continuation may claim a given target native Turn.
  const existing = store.listMessages(taskId).find((entry) =>
    entry.interruptThen?.targetAttemptId === targetAttemptId && entry.id !== message.id);
  if (existing !== undefined) {
    return { code: "TARGET_CHANGED",
      detail: `Turn ${targetAttemptId} is already the terminal target of Message ${existing.id}.` };
  }
  // Reference the new op without rewriting the original input facts: keep the
  // Message's history, move any steer identity into reusedInput provenance (so a
  // replay of that requestId still resolves here, never a second input), and
  // clear only the live steer action so the handoff is deliverable by the queued
  // continuation path after a proven terminal.
  const { inputControl, ...rest } = message;
  store.updateMessage(taskId, { ...rest,
    interruptThen: { requestId: claimRequestId, targetAttemptId,
      targetRoleName: roleName, targetNativeSessionId: target.nativeSessionId,
      targetAgentId: target.agentId, targetAdapterId: target.adapterId,
      targetAuthorityEpoch: target.authority.epoch, targetAuthorityHolderId: target.authority.holderId,
      ...(target.nativeTurnId === undefined ? {} : { targetNativeTurnId: target.nativeTurnId }),
      ...(active === null ? {} : { targetRunId: active.id }),
      ...(inputControl === undefined ? {} : { reusedInput: inputControl }) } });
  recordTaskEvent(store, taskId, "message.interrupt-then-claimed", {
    messageId: message.id, roleName, targetAttemptId,
    ...(active === null ? {} : { targetRunId: active.id }),
    ...(inputControl === undefined ? {} : { reusedRequestId: inputControl.requestId })
  }, now);
  // Release trigger for a no-Run Leader handoff (decision-3 §4/§9). A
  // Worker/Reviewer claim (active !== null) is released by the reconcile loop's
  // unconditional prepareMessageContinuations pass, driven by the owning
  // AgentRun's terminal — no extra wake is needed. A no-Run Leader turn owns no
  // AgentRun and is never surfaced by that push path; it is delivered only by
  // being woken to read its own Context. The interrupt itself (and, when the
  // handoff reuses a Leader self-steer, wakePolicy "none") enqueues no wake, so
  // without this the claim would be structurally unreleasable: listPendingWakeups
  // never selects the Task and the busy-gated leader mailbox is never consulted.
  // Enqueue that wake now, keyed to the claimed Message so an idempotent repeat of
  // the same claim does not stack a second one; claimLeaderNotification holds it
  // until the interrupted native Turn reaches its proven terminal, and only then
  // does the Leader read the Context that surfaces this handoff.
  if (roleName === LEADER_ROLE) {
    enqueueWork(store, leaderMailbox(taskId), "interrupt-then", now,
      [messageRef(taskId, message.id)],
      { source: "interrupt-then", dedupeKey: `interrupt-then:${taskId}:${message.id}` });
  }
  return "claimed";
}

function taskRoleSessionCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "retry") {
    const [taskId, roleName, action = "show", ...extra] = rest;
    if (extra.length > 0 || !["show", "cancel", "disable", "enable"].includes(action)) {
      throw usageError("Usage: yui task role session retry <task> <role> [show|cancel|disable|enable]");
    }
    return store.transaction(tx => {
      const task = requireTask(tx, taskId);
      const role = requireRole(tx, task.id, roleName);
      if (action !== "show") taskActor(tx, options, task.id);
      else {
        const reader = resolveManagedTaskReader(tx, options.environment);
        if (reader === undefined) taskActor(tx, options, task.id);
        else if (reader.taskId !== task.id || reader.roleName !== "leader" && reader.roleName !== role.name) {
          throw usageError("Provider retry read is outside the caller's Task/Role.");
        }
      }
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      let binding = sessions?.providerBinding ?? null;
      if (action !== "show") {
        if (task.status === "archived" || sessions === null || binding === null) throw usageError("No writable Provider Session.");
        binding = controlProviderRetry(binding, action as "cancel" | "disable" | "enable", clock(options).getTime());
        tx.saveTaskRoleSessionSet({ ...sessions, providerBinding: binding });
        recordTaskEvent(tx, task.id, "provider.retry-control", { roleName: role.name, action }, clock(options));
      }
      return output(`${renderProviderRetry(binding)}\n`, {
        roleName: role.name, retry: providerRetryProjection(binding), disabled: binding?.retryDisabled ?? false
      });
    });
  }
  if (command === "inspect") {
    exactPositionals(
      rest,
      2,
      "Task Role Session inspect usage: yui task role session inspect <task> <role>."
    );
    const task = requireTask(store, rest[0]);
    const role = requireRole(store, task.id, rest[1]);
    const reader = resolveManagedTaskReader(store, options.environment);
    if (reader === undefined) taskActor(store, options, task.id);
    else if (reader.taskId !== task.id || (reader.roleName !== "leader" && reader.roleName !== role.name)) {
      throw usageError("Session inspection is outside the caller's Task/Role.");
    }
    const sessions = store.getTaskRoleSessionSet(task.id, role.name);
    const active = sessions?.sessions[sessions.activeAgentId] ?? null;
    const binding = sessions?.providerBinding ?? null;
    // The live reading, when the CLI took one. Rendered under the persisted
    // facts rather than merged into them: the Session's own record is what Yui
    // launched, and this is what the Agent says about it now. An empty render
    // means there was nothing an Agent reported, and the one-line label above
    // still states which of the "no value" cases applies.
    const runConfiguration = active === null ? undefined : options.liveRunConfiguration;
    const host = options.liveHostObservations?.[role.name];
    const runConfigurationDetail = renderAgentRunConfiguration(runConfiguration);
    return output(
      active === null
        ? `No attached Session exists for ${task.id}/${role.name}.\n`
          + (binding === null ? "" : `Retained native execution: ${currentProviderConversation(binding).conversationId}; input=${binding.run?.status ?? "none"}. Use session new to replace from durable context.\n`)
        : [
            `Session ${task.id}/${role.name}`,
            // The component, not just the connection plan: several products are
            // reached over `acp`, and the plan alone cannot say which one ran.
            `Agent: ${active.agentId}/${agentExecutionComponentLabel(active.effective.component)}`
              + ` (${active.adapterId} plan)`,
            `Native id: ${active.nativeSessionId}`,
            `Session: ${active.status}${active.endReason === undefined ? "" : `/${active.endReason}`}`,
            `AgentRun: ${binding?.run?.status ?? "none"}`,
            renderProviderRetry(binding),
            ...(host === undefined ? [] : [`Host reporting: ${taskRoleHostDiagnostic(host)}`]),
            `Run configuration: ${agentRunConfigurationLabel(runConfiguration)}`
          ].join("\n") + "\n"
          + `\n${renderRoleLaunchComparison(role, active.effective)}\n`
          + (runConfigurationDetail === "" ? "" : `\n${runConfigurationDetail}\n`),
      {
        task,
        role,
        session: active,
        providerBinding: binding,
        retry: providerRetryProjection(binding),
        ...(host === undefined ? {} : { host }),
        ...(runConfiguration === undefined ? {} : { runConfiguration })
      }
    );
  }
  if (command === "new") {
    const usage = "Task Role Session new usage: yui task role session new <task> <role> --reason <text>.";
    const parsed = parseTail(rest, new Set(["--reason"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const reason = requiredOption(parsed.options, "--reason");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      if (task.status === "archived") throw usageError("An archived Task cannot select a new Session.", usage);
      const actor = taskActor(tx, options, task.id);
      const role = requireRole(tx, task.id, parsed.positionals[1]);
      const current = tx.getTaskRoleSessionSet(task.id, role.name);
      const previous = current?.sessions[current.activeAgentId];
      const target = runtimeLifecycleTarget({ scope: "task", taskId: task.id, roleName: role.name });
      const mailbox = tx.getWorkMailbox(target);
      if ([...(mailbox?.pending?.reasons ?? []), ...(mailbox?.processing?.batch.reasons ?? [])]
        .includes(RUNTIME_SESSION_REPLACE_REQUIRED_REASON)) return { taskId: task.id, roleName: role.name, target, alreadyRequested: true };
      recordTaskEvent(tx, task.id, "runtime.session-replacement-requested", {
        roleName: role.name, agentId: current?.activeAgentId ?? role.activeAgentId,
        ...(previous === undefined ? {} : { nativeSessionId: previous.nativeSessionId }),
        reason, requestedBy: actor
      }, now);
      enqueueWork(tx, target, RUNTIME_SESSION_REPLACE_REQUIRED_REASON, now, [{ type: "task", id: task.id }]);
      return { taskId: task.id, roleName: role.name, target, alreadyRequested: false };
    });
    notifyMailbox(options.runtime, result.target);
    return output(`Requested Session replacement for ${result.taskId}/${result.roleName}. `
      + "Yui will stop the old execution, retain its history and workspaces, and select a fresh Session. "
      + "If replacing your own Session, end this turn; the successor reads durable Task context.\n", result);
  }
  if (command === "stop") {
    const usage = "Task Role Session stop usage: yui task role session stop <task> <role> --reason <text>.";
    const parsed = parseTail(rest, new Set(["--reason"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const reason = requiredOption(parsed.options, "--reason");
    const now = clock(options);
    const request = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      const actor = taskActor(tx, options, task.id);
      const role = requireRole(tx, task.id, parsed.positionals[1]);
      if (actor === "leader" && role.name === LEADER_ROLE) {
        throw usageError("Use task role session new to request your own replacement and end this turn; synchronous self-stop cannot return.", usage);
      }
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      const session = taskRoleControlTarget(sessions);
      if (session === undefined || session.adapterId === undefined) {
        throw usageError(`Task Role has no active Session: ${task.id}/${role.name}.`, usage);
      }
      // A repeated stop is a recovery request, not contention with its own
      // earlier cleanup obligation.
      recordTaskEvent(tx, task.id, "runtime.session-stop-requested", {
        roleName: role.name,
        agentId: session.agentId,
        adapterId: session.adapterId,
        nativeSessionId: session.nativeSessionId,
        reason,
        requestedBy: actor
      }, now);
      return {
        taskId: task.id,
        roleName: role.name,
        agentId: session.agentId,
        adapterId: session.adapterId,
        nativeSessionId: session.nativeSessionId,
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
  if (hasAgentConfigOptions(parsed) && agentId === undefined) {
    throw usageError(
      "Task role add Agent settings require --agent so a complete binding is validated atomically.",
      usage
    );
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
    const profileId = parsed.one("--profile");
    const agentProfile = profileId === undefined
      ? undefined
      : requireAgentProfile(tx, profileId);
    const bindingUpdate = resolveTaskRoleAgentBindingAdd(parsed, agentProfile, tx);
    let created = bindingUpdate === undefined
      ? createTaskRole(tx, task, roleName, undefined, now)
      : createTaskRoleFromAgentBinding(tx, task, roleName, bindingUpdate.binding, now);
    if (agentProfile !== undefined) {
      created = applyWorkerAgentProfileBehavior(created, agentProfile, now);
    }
    const rolePatch = roleProfilePatch(parsed);
    if (Object.keys(rolePatch).length > 0) created = updateRole(created, rolePatch, now);
    validateTaskRoleAgentBinding(created, created.activeAgentId, options);
    validateConfiguredRoleSkills(options.yuiHome, created.skills ?? []);
    tx.saveRole(task.id, created);
    enqueueWork(tx, taskMailbox(task.id), "role-added", now, [taskRef(task.id)]);
    const binding = created.agentBindings[created.activeAgentId];
    const runtimeSource = profileId !== undefined
      ? `Agent Profile ${profileId}`
      : agentId !== undefined
        ? `Explicit Agent ${agentId}`
        : "Global Role worker";
    recordTaskEvent(tx, task.id, "role.added", {
      role: created.name,
      runtimeSource,
      agent: `${created.activeAgentId}/${binding.adapterId}`,
      model: binding.config.model ?? "CLI default",
      effort: binding.config.effort ?? "CLI default",
      permissionStrategy: binding.config.permission.strategy,
      ...roleLaunchEventPayload(created, null)
    }, now);
    return { role: created, binding };
  });
  notifyMailbox(options.runtime, taskMailbox(result.role.taskId));
  const profileId = parsed.one("--profile");
  const runtimeSource = profileId !== undefined
    ? `Agent Profile ${profileId}`
    : agentId !== undefined
      ? `Explicit Agent ${agentId}`
      : "Global Role worker";
  return [
    `Added role ${result.role.name} to ${result.role.taskId}`,
    `Runtime source: ${runtimeSource}`,
    `Agent: ${result.role.activeAgentId}/${result.binding.adapterId}`,
    `Model: ${result.binding.config.model ?? "CLI default"}; effort: ${result.binding.config.effort ?? "CLI default"}; permission: ${result.binding.config.permission.strategy}`,
    "Next: dispatch an assigned WorkItem, or request a Task-final Review with this Role; a Review needs no WorkItem."
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
  ).map(status => withTaskRoleHostObservation(status, options.liveHostObservations?.[status.roleName]));
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
  const observed = withTaskRoleHostObservation(status, options.liveHostObservations?.[role.name]);
  return output(renderTaskRoleRuntimeStatus(observed), { role: observed });
}

function showTaskRole(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  exactPositionals(args, 2, "Task role show usage: yui task role show <task> <role>.");
  const task = requireTask(store, args[0]);
  const role = requireRole(store, task.id, args[1]);
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  return output(renderRoleDetails(`Task Role: ${role.name}`, role, {
    kind: "task",
    sessions
  }), {
    role,
    sessions,
    runs: store.listRuns(task.id).filter((run) => run.roleName === role.name)
      .map((run) => ({ id: run.id, status: run.status, effective: run.effective }))
  });
}

function updateTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task role update usage: yui task role update <task> <role> [Role and Agent settings].";
  const [taskId, roleName, ...tail] = args;
  if (taskId === undefined || roleName === undefined || taskId.startsWith("--") || roleName.startsWith("--")) {
    throw usageError("Task id and Role name are required.", usage);
  }
  const parsed = parseRoleOptions(tail, new Map([
    ...roleOptionSpecs({ update: true, includeAgent: true }),
    ["--profile", "value" as const],
    ["--environment", "value" as const],
    ["--managed-environment", "flag" as const]
  ]), usage);
  validateTaskRoleEnvironmentOptions(parsed, usage);
  if (parsed.has("--agent") && (parsed.one("--agent")?.trim().length ?? 0) === 0) {
    throw usageError("--agent is required.", usage);
  }
  if (hasNoRoleMutation(parsed)) {
    throw usageError("At least one role update option is required.", usage);
  }
  const now = clock(options);
  const updated = store.transaction((tx) => {
    const task = requireTask(tx, taskId);
    assertTaskOpen(task);
    taskActor(tx, options, task.id);
    const role = requireRole(tx, task.id, roleName);
    const changesEnvironment = parsed.has("--environment") || parsed.has("--managed-environment");
    const changesLaunchContext = hasRoleLaunchContextOptions(parsed) || parsed.has("--profile")
      || changesEnvironment;
    const changesAgentConfig = hasAgentConfigOptions(parsed);
    if (changesLaunchContext || changesAgentConfig) {
      assertRoleRuntimeMutationAllowed(tx, {
        scope: "task",
        taskId: task.id,
        roleName: role.name
      }, "desired launch configuration update");
    }
    const profileId = parsed.one("--profile");
    const agentProfile = profileId === undefined
      ? undefined
      : requireAgentProfile(tx, profileId);
    const bindingUpdate = resolveTaskRoleAgentBindingUpdate(
      parsed,
      role,
      agentProfile,
      tx
    );
    const withProfileBehavior = agentProfile === undefined
      ? role
      : applyWorkerAgentProfileBehavior(role, agentProfile, now);
    const withBinding = bindingUpdate === undefined
      ? withProfileBehavior
      : updateRole(withProfileBehavior, {
        agentBindings: {
          ...withProfileBehavior.agentBindings,
          [bindingUpdate.agentId]: bindingUpdate.binding
        }
      }, now);
    let next = updateRole(withBinding, {
      ...roleProfilePatch(parsed)
    }, now);
    if (bindingUpdate !== undefined) {
      validateTaskRoleAgentBinding(next, bindingUpdate.agentId, options);
    }
    if (changesLaunchContext) {
      validateConfiguredRoleSkills(options.yuiHome, next.skills ?? []);
    }
    if (changesEnvironment) {
      next = updateRole(next, {
        executionEnvironment: parsed.has("--managed-environment")
          ? null
          : createProjectResources(tx, () => now).resolveExecutionEnvironment(task.id, parsed.one("--environment")!)
      }, now);
    }
    saveTaskRoleUpdate(tx, role, next, now, {
      source: "task.role.update", actor: taskActor(tx, options, task.id)
    });
    return next;
  });
  notifyMailbox(options.runtime, taskMailbox(updated.taskId));
  const sessions = store.getTaskRoleSessionSet(updated.taskId, updated.name);
  return output(renderRoleDetails(`Updated Task Role: ${updated.name}`, updated, {
    kind: "task",
    sessions
  }), { role: updated, sessions });
}

function validateTaskRoleEnvironmentOptions(
  parsed: ReturnType<typeof parseRoleOptions>,
  usage: string
): void {
  if (parsed.has("--environment") && parsed.has("--managed-environment")) {
    throw usageError("--environment and --managed-environment are mutually exclusive.", usage);
  }
  if (parsed.has("--environment") && (parsed.one("--environment")?.trim().length ?? 0) === 0) {
    throw usageError("--environment requires an adopted preparation id.", usage);
  }
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
    if (tx.getActiveRun(task.id, role.name) !== null) {
      throw usageError(`Task Role has an active AgentRun and cannot be removed: ${task.id}/${role.name}.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    if (Object.values(sessions?.sessions ?? {}).some(({ status }) => status === "active")) {
      throw usageError(`Task Role has a running native Agent and cannot be removed: ${task.id}/${role.name}.`);
    }
    if (!tx.removeTaskRole(task.id, role.name)) throw roleNotFound(role.name);
    enqueueWork(tx, taskMailbox(task.id), "role-removed", now, [taskRef(task.id)]);
    return role;
  });
  notifyMailbox(options.runtime, taskMailbox(removed.taskId));
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
      ?? createRoleAgentBinding(agent);
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
          activeRun: tx.getActiveRun(task.id, role.name) !== null,
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
      // Re-selecting an Agent must not revive its old management entrance.
      // This revokes authority, not the Session's independent execution fact.
      ...(role.name === LEADER_ROLE && currentSession?.nativeSessionId !== undefined
        ? { revokedNativeSessionId: currentSession.nativeSessionId } : {}),
      ...roleLaunchEventPayload(switched.role, switched.sessions)
    }, now);
    return { role: switched.role, mode: switched.mode };
  });
  notifyMailbox(options.runtime, taskMailbox(result.role.taskId));
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
      if (sessions === null || sessions === undefined || session === undefined || binding === null || binding === undefined || session.status === "ended") {
        throw new Error(`Task Role has no live managed Provider: ${task.id}/${role.name}.`);
      }
      if (action === "takeover") {
        const activeRun = tx.getActiveRun(task.id, role.name);
        if (activeRun === null) {
          throw new Error(`Task Role has no active managed AgentRun for takeover: ${task.id}/${role.name}.`);
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
            holderId: action === "takeover" ? `human:${randomUUID()}` : "controller",
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
  if (command === "synthesize") return synthesizeRuns(rest, "workItem", store, options);
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
    assertTaskOpen(task);
    if (task.status === "draft") assertDraftTaskExecutionFree(tx, task);
    const actor = taskActor(tx, options, task.id);
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
    const updated = editWorkItemDefinition(item, {
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
    if (task.status === "draft") validateDraftWorkItemEdit(tx, task, updated);
    else {
      // Requirements can evolve while a frozen Assignment continues. Resource
      // scope and ownership changes still require an explicit idle boundary.
      if ((projects !== undefined || baseRefs !== undefined || assignee !== undefined)
        && tx.listRuns(task.id).some((run) => run.workItemId === item.id && run.status === "active")) {
        throw usageError(`Stop the active Work Item AgentRun before changing ownership or workspace scope: ${item.id}.`);
      }
      for (const dependencyId of updated.dependsOn) {
        if (tx.getWorkItem(task.id, dependencyId) === null) {
          throw usageError(`Work Item dependency not found: ${dependencyId}.`);
        }
      }
    }
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
      previous: editedFieldValues(item, changedFields),
      current: editedFieldValues(updated, changedFields),
      editedBy: actor
    }, now);
    if (actor !== "leader") {
      enqueueWork(tx, leaderMailbox(task.id), actor === "operator" ? "operator-input" : "user-message",
        now, [workItemRef(task.id, updated.id)], { source: actor });
    }
    return { task, item: updated };
  });
  options.runtime?.notifyMailboxChanged({ kind: "task", taskId: result.task.id });
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
    return created;
  });
  notifyMailbox(options.runtime, taskMailbox(item.taskId));
  return output(
    `Created work item ${item.id} for ${item.taskId}\n`,
    { workItem: item }
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
    if (tx.getActiveRun(task.id, item.assignee ?? "") !== null) {
      throw usageError(`Stop the active Work Item AgentRun before changing scope: ${item.id}.`);
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
    notifyMailbox(options.runtime, taskMailbox(updated.item.taskId));
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
  const usage = "Task work update usage: yui task work update <task>/<work> <todo|running|done|failed> [--summary <text>] [--artifact-ref git:<commit>:<relative-path> ...].";
  const parsed = parseMultiValueTail(args, new Set(["--summary"]), new Set(["--artifact-ref"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const requested = parsed.positionals[1];
  const status = parseWorkStatus(requested);
  const summary = trimmed(parsed.options.get("--summary"));
  const artifactIds = parsed.multiOptions.get("--artifact-ref") ?? [];
  if (artifactIds.length > 0 && status !== "completed") {
    throw usageError("--artifact-ref is only valid when submitting a done Candidate.");
  }
  if (["completed", "failed"].includes(status)
    && summary === undefined) {
    throw usageError(`--summary is required when work becomes ${requested}.`);
  }
  const now = clock(options);
  const result = store.transaction((tx) => {
    const current = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, current.taskId);
    assertTaskOpen(task);
    const artifactRefs = artifactIds.length === 0 ? undefined : fixedArtifactRefs(task.id, artifactIds);
    if (current.assignee === undefined) {
      taskActor(tx, options, task.id);
      if (status === "running") {
        assertWorkItemDependenciesCompletedForCommand(tx, current);
      }
      const configuredReview = status === "completed" && !isTerminalWorkItemStatus(current.status)
        ? tx.getReviewConfig()
        : null;
      const taskFinalContract = status === "completed" && current.status === "open"
        ? taskFinalReviewContractForMutation(tx, task.id, options)
        : undefined;
      const candidatePolicy = taskFinalContract === undefined
        ? workItemReviewConfig(configuredReview)
        : taskFinalReviewConfig(taskFinalContract);
      const projectDelivery = task.projectBindings.length > 0
        && current.writeProjectIds.length > 0;
      const metadataOnlyTaskFinalDelivery = taskFinalContract !== undefined
        && current.assignee === undefined;
      const candidateRequired = status === "completed" && current.status === "open";
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
            ...(artifactRefs === undefined ? {} : { artifactRefs }),
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
        : updateWorkItemStatus(
            current,
            "open",
            now
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
    if (status !== "completed" || current.status !== "open") {
      throw usageError(
        `Assigned Work Item ${current.id} can only submit a completed direct AgentRun from running; `
        + "use dispatch, task run retry, or task work retire for other transitions."
      );
    }
    if (tx.getActiveRun(task.id, current.assignee) !== null) {
      throw usageError(`Work Item main AgentRun is still active: ${current.id}/${current.assignee}.`);
    }
    const sourceGroup = currentWorkItemExecutionGroup(current);
    const mainRun = tx.listRuns(task.id).filter((run) => (
      run.purpose === "execution"
      && run.workItemId === current.id
      && run.roleName === current.assignee
      && run.executionGroupId === undefined
      && run.executionLaneId === undefined
      && run.sourceExecutionGroupId === sourceGroup?.id
      && run.status === "completed"
      && run.result !== undefined
    )).at(-1);
    if (mainRun === undefined) {
      throw usageError(
        sourceGroup === undefined
          ? `Work Item ${current.id} has no completed direct main AgentRun.`
          : `Work Item ${current.id} has no completed main AgentRun for ExecutionGroup ${sourceGroup.id}.`
      );
    }
    if (mainRun.result === undefined) {
      throw dataError(`Completed WorkItem main AgentRun has no result: ${mainRun.id}.`);
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
      summary: `Result from AgentRun ${mainRun.id}.`,
      source: { type: "run", runId: mainRun.id },
      ...(artifactRefs === undefined ? {} : { artifactRefs }),
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
      runId: mainRun.id,
      ...leaderActionEventPayload(tx, task.id, options)
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "work-updated", now, [
      workItemRef(task.id, updated.id),
      runRef(task.id, mainRun.id)
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
  notifyMailbox(options.runtime, taskMailbox(result.item.taskId));
  if ((result.item.status === "open" && result.item.candidates.length > 0) && status === "completed") {
    const failure = result.reviewDispatch?.round.status === "failed"
      ? `Review could not start: ${
          result.reviewDispatch.round.failure?.message ?? result.reviewDispatch.round.id
        }\n`
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

/** Shared with CLI preflight so a refused dispatch cannot prepare workspaces. */
export function requireWorkItemAssignee(item: WorkItem): string {
  if (item.assignee === undefined) {
    throw usageError(
      `Work Item has no Task Role assignee: ${item.id}. `
      + `The Task Leader can execute it directly without dispatch: `
      + `yui task work update ${item.taskId}/${item.id} running. `
      + (item.writeProjectIds.length === 0 ? "" :
        `For code, first use yui task work isolate ${item.taskId}/${item.id}.`)
    );
  }
  return item.assignee;
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
    const assignee = requireWorkItemAssignee(item);
    const lanePlan = planReplicatedWorkItemLanes(
      assignee,
      requestedLaneRoles,
      `execution-group-${tx.peekNextRunId(task.id)}`
    );
    const currentGroup = currentWorkItemExecutionGroup(item);
    if (item.status !== "open") {
      throw usageError(`Work item ${item.id} cannot be dispatched from ${item.status}.`);
    }
    if (currentGroup !== undefined && !workItemExecutionGroupSettled(currentGroup)) {
      throw usageError(
        `Work Item ${item.id} retains open ExecutionGroup ${currentGroup.id}; retry or settle its exact Lane AgentRuns.`
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
      if (tx.getActiveRun(task.id, role.name) !== null) {
        throw usageError(`${task.id}/${role.name} already has an active run.`);
      }
    }
    const rawInput = trimmed(parsed.options.get("--input")) ?? item.objective;
    let workItemForDispatch = prepareWorkItemDispatch(item, now);
    if (lanePlan.roles.length === 0) {
      const role = requireRole(tx, task.id, assignee);
      if (tx.getActiveRun(task.id, role.name) !== null) {
        throw usageError(`${task.id}/${role.name} already has an active run.`);
      }
      const effective = resolveEffectiveLaunch({
        role,
        purpose: "execution",
        workspace,
        workItemWriteProjectIds: item.writeProjectIds
      });
      const runId = tx.nextRunId(task.id);
      const run = createRun(
        runId,
        task.id,
        role.name,
        roleAgentSessionResumeMode(
          tx.getTaskRoleSessionSet(task.id, role.name),
          effective.agentId,
          effective
        ),
        createRunInput({
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
      const snapshot = freezeRunContextSnapshot(tx, {
        taskId: task.id,
        roleName: run.roleName,
        purpose: "execution",
        workItemId: item.id
      }, now, "controller");
      const withContext = withRunContextSnapshot(
        run,
        contextSnapshotRef(snapshot),
        contextSnapshotDeltaRefIds(tx, snapshot)
      );
      if (workItemForDispatch.status !== "open") {
        workItemForDispatch = updateWorkItemStatus(workItemForDispatch, "open", now);
      }
      tx.saveWorkItem(task.id, workItemForDispatch);
      tx.saveRun(withContext);
      tx.saveActiveRun(withContext);
      enqueueRoleRunDispatch(tx, {
        taskId: task.id,
        roleName: role.name,
        runId: withContext.id,
        reason: "turn-dispatched",
        occurredAt: now
      });
      recordTaskEvent(tx, task.id, "run.dispatched", runLaunchEventPayload(withContext), now);
      return { kind: "direct" as const, runs: [withContext] };
    }
    const groupId = `execution-group-${tx.peekNextRunId(task.id)}`;
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
        runId: tx.nextRunId(task.id),
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
        currentRunId: string;
      }> => ({
        roleName: plan.role.name,
        effective: plan.effective,
        workspace: {
          root: plan.managedWorkspace.root,
          writableProjectIds: [...item.writeProjectIds]
        },
        currentRunId: plan.runId
      })),
      now
    );
    workItemForDispatch = attachWorkItemExecutionGroup(workItemForDispatch, group, now);
    if (workItemForDispatch.status !== "open") {
      workItemForDispatch = updateWorkItemStatus(workItemForDispatch, "open", now);
    }
    tx.saveWorkItem(task.id, workItemForDispatch);
    const runs = plans.map((plan, index) => {
      const run = createRun(
        plan.runId,
        task.id,
        plan.role.name,
        plan.dispatchMode,
        createRunInput({
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
      const snapshot = freezeRunContextSnapshot(tx, {
        taskId: task.id,
        roleName: run.roleName,
        purpose: "execution",
        workItemId: item.id
      }, now, "controller", assignment.contextSnapshotRef);
      const withContext = withRunContextSnapshot(
        run,
        contextSnapshotRef(snapshot),
        contextSnapshotDeltaRefIds(tx, snapshot)
      );
      const prepared = options.executionLaneWorkspaces?.get(group.lanes[index]!.id);
      if (prepared !== undefined && tx.getManagedWorkspace(prepared.owner) === null) {
        tx.saveManagedWorkspace(prepared);
      }
      tx.saveRun(withContext);
      tx.saveActiveRun(withContext);
      enqueueRoleRunDispatch(tx, {
        taskId: task.id,
        roleName: plan.role.name,
        runId: withContext.id,
        reason: "turn-dispatched",
        occurredAt: now
      });
      recordTaskEvent(tx, task.id, "run.dispatched", runLaunchEventPayload(withContext), now);
      return withContext;
    });
    return { kind: "replicated" as const, runs };
  });
  for (const run of dispatch.runs) {
    notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName));
  }
  return dispatch.kind === "direct"
    ? `Direct WorkItem AgentRun queued as ${dispatch.runs[0]!.id}\n`
    : `Dispatch queued for ${dispatch.runs.length} replicated Lanes\n`;
}

function replicatedProducerAssignmentInput(input: string, requiresCodeRef: boolean): string {
  return [
    input,
    "",
    "Return one complete original result in clear Markdown or JSON.",
    "Recommended sections are Outcome, Changes, Verification, Risks or blockers, and Recommended next action.",
    "Yui preserves the result verbatim and does not parse or validate those sections.",
    requiresCodeRef
      ? "Commit the Lane's final code and leave its managed workspace clean; Yui observes the exact Git snapshot independently."
      : "For a Gitless or read-only Lane, report the result without inventing Git evidence."
  ].join("\n");
}



function acceptWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work accept usage: yui task work accept <task>/<work> --summary <text>.";
  const parsed = parseTail(args, new Set(["--summary", "--candidate"]), usage);
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
    if ((item.status !== "open" || item.candidates.length === 0)) {
      throw usageError(`Work Item is not awaiting acceptance: ${item.id}/${item.status}.`);
    }
    if (options.workItemIntegrationProof?.workspace.owner.type === "review-round") {
      throw usageError(
        "A ReviewRound-owned workspace cannot be used for WorkItem acceptance."
      );
    }
    const candidateId = parsed.options.get("--candidate");
    const candidate = candidateId === undefined ? requireWorkItemCandidate(item)
      : item.candidates.find(({ id }) => id === candidateId);
    if (candidate === undefined) throw usageError(`Work Item Candidate not found: ${candidateId}.`);
    // A Candidate's artifact references are commit-pinned (git:<commit>:<path>):
    // the commit self-certifies the frozen bytes, so they cannot drift and are
    // re-validated for shape whenever the Candidate is loaded. Their bytes are
    // resolved lazily on the async read/context path, never re-derived from a DB
    // mirror here.
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
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
      for (const proof of options.workItemIntegrationProof!.projects) {
        const candidateCommit = candidate.gitSnapshot?.projects
          .find(({ projectId }) => projectId === proof.projectId)?.commit;
        if (candidateCommit === undefined || candidateCommit !== proof.headCommit) {
          throw usageError(`Selected Candidate ${candidate.id} does not match the integrated result for ${proof.projectId}.`);
        }
      }
    }
    const completed = updateWorkItemStatus(item, "accepted", now, summary, candidate.id);
    tx.saveWorkItem(item.taskId, completed);
    recordTaskEvent(tx, item.taskId, "work.accepted", {
      workItemId: item.id,
      candidateId: candidate.id,
      ...(candidate.source.type === "run"
        ? { runId: candidate.source.runId }
        : { workItemRevision: String(candidate.workItemRevision) }),
      acceptedBy: actor,
      summary,
      ...(latestReview === undefined ? {} : { reviewRoundId: latestReview.id }),
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
    if (item.status === "retired" || item.candidates.length === 0) {
      throw usageError(`Work Item is not awaiting acceptance: ${item.id}/${item.status}.`);
    }
    const candidate = requireWorkItemCandidate(item);
    const activeReview = activeReviewRoundForCandidate(tx, item, candidate);
    if (activeReview !== undefined) {
      throw usageError(`ReviewRound is still active: ${activeReview.id}/${activeReview.status}.`);
    }
    const { currentCandidateId: _declinedCandidate, ...failed } = updateWorkItemStatus(item, "open", now);
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
      for (const run of tx.listRuns(task.id).filter((candidate) => (
        candidate.status === "active" && candidate.workItemId === item.id
      ))) {
        const terminal = terminalizeExactTaskRun(tx, {
          taskId: task.id,
          roleName: run.roleName,
          agentId: run.effective.agentId,
          runId: run.id,
          outcome: {
            status: "failed",
            diagnostic: `Work Item retired: ${summary}`,
            failureReason: "cancelled"
          }
        }, now);
        if (terminal.disposition !== "applied") {
          throw usageError(
            `Work Item AgentRun changed during retirement: ${run.id}/${terminal.reason ?? "obsolete"}.`
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
  options.runtime?.notifyMailboxChanged({ kind: "task", taskId: retired.taskId });
  return output(`Retired Work Item ${retired.id}\n`, { workItem: retired });
}

function listWork(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  exactPositionals(args, 1, "Task work list usage: yui task work list <task>.");
  const task = requireTask(store, args[0]);
  const items = store.listWorkItems(task.id);
  const runs = store.listRuns(task.id);
  const sessionSets = store.listRoleSessionSets(task.id);
  const executions = items.map((item) => projectWorkItemExecution(item, runs, sessionSets, store));
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
    store.listRuns(item.taskId),
    store.listRoleSessionSets(item.taskId),
    store
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
  if (projection.shape === "direct") return `main=${projection.mainRun.status}`;
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
            + `run=${lane.currentRunId ?? "unknown"}; session=${lane.session}; `
            + `retry=${lane.retryRunId ?? "none"}; settle=${lane.settleRunId ?? "none"}`
          ))
        ]),
    `Synthesis: ${projection.synthesis.status}; successful=${projection.synthesis.successfulLaneCount}; sources selected by Leader`,
    `Main AgentRun: ${projection.mainRun.runId ?? "unobserved"} [${projection.mainRun.status}]; role=${projection.mainRun.roleName ?? "unobserved"}; session=${projection.mainRun.session}; retry=${projection.mainRun.retryRunId ?? "none"}`,
    `Candidate Source: ${projection.candidate.candidateId ?? "none"} [${projection.candidate.status}]; source=${projection.candidate.sourceType ?? "unobserved"}; main=${projection.candidate.mainRunId ?? "unobserved"}`,
    ...(projection.candidate.sourceExecutionGroupId === undefined
      ? []
      : [
          `Candidate Provenance: main ${projection.candidate.mainRunId ?? "unobserved"} -> group ${projection.candidate.sourceExecutionGroupId} -> ${projection.candidate.successfulLaneRuns.map(({ laneId, successfulRunId }) => `${laneId} -> ${successfulRunId}`).join(", ") || "unobserved"}`
        ]),
    `Next Action: ${projection.nextAction.kind}; owner=${projection.nextAction.owners.join(", ") || "none"}; target=${projection.nextAction.targetIds.join(", ") || "none"}`
  ];
}

function reviewWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work review usage: yui task work review <task>/<work> "
    + "[--lane-role <producer-role> ...].";
  const parsed = parseMultiValueTail(
    args,
    new Set(),
    new Set(["--lane-role"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const requestedLaneRoles = parsed.multiOptions.get("--lane-role") ?? [];
  if (requestedLaneRoles.length === 1) {
    throw usageError("Replicated Review requires zero or at least two --lane-role values.");
  }
  if (new Set(requestedLaneRoles).size !== requestedLaneRoles.length) {
    throw usageError("Each Review Producer Lane must use a distinct Task Role.");
  }
  const now = clock(options);
  const result = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0], options);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    const requestedBy = taskActor(tx, options, task.id);
    if ((item.status !== "open" || item.candidates.length === 0)) {
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
    const laneRoles = validateReviewProducerRoles(config.roleName, requestedLaneRoles);
    const activeRound = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((round) => (
        round.workItemId === item.id
        && round.candidateId === candidate.id
        && (round.status === "pending" || round.status === "running")
      ))).at(-1);
    if (activeRound !== undefined) {
      const producerDispatchPending = activeRound.executionGroup?.lanes.some((lane) => (
        lane.disposition === "open"
        && (lane.currentRunId === undefined
          || tx.getRun(task.id, lane.currentRunId)?.status === "failed")
      )) === true;
      if ((activeRound.status === "pending" && activeRound.reviewerRunId === undefined)
        || (activeRound.status === "running" && producerDispatchPending)) {
        const persistedRoles = activeRound.executionGroup?.lanes
          .map(({ roleName }) => roleName) ?? [];
        if (!isDeepStrictEqual(persistedRoles, laneRoles)) {
          throw usageError(`ReviewRound ${activeRound.id} has a different frozen execution shape.`);
        }
        return { kind: "round" as const, round: activeRound, resumed: true as const };
      }
      throw usageError(`ReviewRound is already active: ${activeRound.id}/${activeRound.status}.`);
    }
    const producerRoles = workItemCandidateProducerRoles(tx, item, candidate);
    assertCandidateReviewRoleIsolation(
      producerRoles,
      config.roleName,
      laneRoles
    );
    for (const roleName of [config.roleName, ...laneRoles]) {
      if (tx.getRole(task.id, roleName) === null && tx.getGlobalRole(roleName) === null) {
        throw usageError(`Global Role not found: ${roleName}.`);
      }
      const availability = projectReviewerAvailability(tx, task.id, roleName);
      if (availability.kind === "busy") {
        return { kind: "busy" as const, availability };
      }
    }
    for (const roleName of [config.roleName, ...laneRoles]) {
      if (tx.getRole(task.id, roleName) === null) {
        tx.saveRole(task.id, createTaskRole(
          tx,
          task,
          roleName,
          undefined,
          now,
          roleName
        ));
      }
    }
    const queued = queueReviewRound(
      tx,
      item,
      config,
      requestedBy,
      now,
      laneRoles
    );
    return { kind: "round" as const, ...queued, resumed: false as const };
  });
  if (result.kind === "busy") {
    const busy = result.availability;
    return output(
      `Reviewer ${busy.reviewerRoleName} is busy (${busy.phase}`
        + `${busy.activeRunId === undefined ? "" : `; AgentRun ${busy.activeRunId}`}); `
        + `${busy.activeReviewRoundId === undefined
          ? ""
          : `active ReviewRound ${busy.activeReviewRoundId}; `}`
        + `retry after ${busy.retryAfterSeconds}s or choose another Reviewer.\n`,
      { reviewRequest: busy }
    );
  }
  if (result.resumed) {
    return output(
      `Review request ${result.round.id} has pending execution; resuming dispatch.\n`,
      { reviewRound: result.round }
    );
  }
  return result.round.status === "failed"
    ? output(
        `Review could not start for ${result.round.workItemId}: ${
          result.round.failure?.message ?? result.round.id
        }\n`,
        { reviewRound: result.round }
      )
    : output(`Review requested as ${result.round.id}\n`, { reviewRound: result.round });
}

/**
 * Task-control recovery for a failed Task-final ReviewRound that never
 * created a Reviewer AgentRun. This is deliberately separate from `task run retry`:
 * that command requires an exact failed AgentRun and remains the only retry
 * path for a failed provider execution. Here the old terminal Round is an
 * immutable anchor and one fresh Round is created only after the same frozen
 * committed Integration/ChangeSet provenance and Reviewer independence fences
 * pass again.
 */
function synthesizeRuns(
  args: string[],
  kind: "workItem" | "reviewRound",
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const subject = kind === "workItem" ? "work" : "review";
  const usage = `Usage: yui task ${subject} synthesize <task>/<${subject}> --source-run <task>/<run> ...`;
  const parsed = parseMultiValueTail(args, new Set(), new Set(["--source-run"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const reference = taskRecordReference(parsed.positionals[0], kind, "Synthesis target", options);
  const sources = parsed.multiOptions.get("--source-run") ?? [];
  const sourceRunIds = sources.map((value) => {
    const source = taskRecordReference(value, "run", "Source AgentRun", options);
    if (source.taskId !== reference.taskId) throw usageError("Synthesis sources must belong to the same Task.");
    return source.localId;
  });
  const now = clock(options);
  const run = store.transaction((tx) => {
    const actor = taskActor(tx, options, reference.taskId);
    const created = kind === "workItem"
      ? dispatchWorkItemSynthesis(tx, reference.taskId, reference.localId, sourceRunIds, now)
      : dispatchReviewSynthesis(tx, reference.taskId, reference.localId, sourceRunIds, now);
    recordTaskEvent(tx, reference.taskId, "run.synthesis-requested", {
      runId: created.id,
      requestedBy: actor,
      sourceRunIds: sourceRunIds.join(","),
      ...(actor === "leader" ? leaderActionEventPayload(tx, reference.taskId, options) : {})
    }, now);
    return created;
  });
  notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName));
  return output(`Dispatched synthesis AgentRun ${run.taskId}/${run.id}\n`, { run });
}

function taskReviewCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "request") return requestTaskReviewRound(rest, store, options);
  if (command === "synthesize") return synthesizeRuns(rest, "reviewRound", store, options);
  if (command === "retry") return retryFailedTaskReviewRound(rest, store, options);
  throw usageError(command === undefined
    ? "Task review command is required."
    : `Unknown command: task review ${command}`);
}

function requestTaskReviewRound(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task review request usage: yui task review request <task> --role <reviewer-role> "
    + "[--lane-role <producer-role> ...] [--delta-recheck].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--role"]),
    new Set(["--lane-role"]),
    usage,
    new Set(["--delta-recheck"])
  );
  exactPositionals(parsed.positionals, 1, usage);
  const reviewerRoleName = requiredOption(parsed.options, "--role");
  const requestedLaneRoles = validateReviewProducerRoles(
    reviewerRoleName,
    parsed.multiOptions.get("--lane-role") ?? []
  );
  const deltaRecheckRequested = parsed.options.has("--delta-recheck");
  if (deltaRecheckRequested && requestedLaneRoles.length > 0) {
    throw usageError("Delta-recheck supports only direct Review.");
  }
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
    if (tx.getRole(task.id, reviewerRoleName) === null && tx.getGlobalRole(reviewerRoleName) === null) {
      throw usageError(`Reviewer Role not found in this Task or global templates: ${reviewerRoleName}.`);
    }

    const provenance = taskReviewProvenance(tx, task, options);
    const producerCollision = taskReviewProducerCollision(provenance, reviewerRoleName);
    if (producerCollision !== null) {
      throw usageError(producerCollision);
    }
    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id))
      .filter((entry) => entry.scope === "task");
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
      const persistedRoles = exact.executionGroup?.lanes.map(({ roleName }) => roleName) ?? [];
      if (!isDeepStrictEqual(persistedRoles, requestedLaneRoles)) {
        throw usageError(`ReviewRound ${exact.id} has a different frozen execution shape.`);
      }
      assertTaskReviewRequestLane(tx, task.id, reviewerRoleName, exact);
      return exact;
    }
    const primaryAvailability = projectReviewerAvailability(tx, task.id, reviewerRoleName);
    if (primaryAvailability.kind === "busy") return primaryAvailability;
    for (const laneRoleName of requestedLaneRoles) {
      if (tx.getGlobalRole(laneRoleName) === null && tx.getRole(task.id, laneRoleName) === null) {
        throw usageError(`Global Role not found: ${laneRoleName}.`);
      }
      const availability = projectReviewerAvailability(tx, task.id, laneRoleName);
      if (availability.kind === "busy") return availability;
      if (taskReviewProducerCollision(provenance, laneRoleName) !== null) {
        throw usageError(`Reviewer Role must be separate from the Candidate producer: ${laneRoleName}.`);
      }
    }
    for (const laneRoleName of [reviewerRoleName, ...requestedLaneRoles]) {
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
    tx.saveReviewRound(task.id, created);
    if (requestedLaneRoles.length > 0) {
      const groupId = `execution-group-${created.id}`;
      const baseline = freezeReviewStageContextSnapshot(tx, {
        taskId: task.id,
        reviewRoundId: created.id,
        executionGroupId: groupId
      }, now);
      const assignment = createReviewExecutionAssignment({
        input: `Review the frozen Task candidate for ReviewRound ${created.id}.`,
        objective: task.title,
        acceptance: [
          "Inspect every bound Project at the frozen Task heads.",
          "Report only reachable, material, actionable findings or bounded verification gaps.",
          "Return one complete original result for the main Reviewer to read."
        ],
        contextSnapshotRef: contextSnapshotRef(baseline),
        taskId: task.id,
        reviewRoundId: created.id,
        reviewBaseCommit: created.reviewBaseCommit,
        scope: "task",
        projects: created.taskCandidate!.projects.map(({ projectId, commit }) => ({
          projectId,
          baseCommit: commit
        }))
      });
      const group = createExecutionGroup(
        groupId,
        task.id,
        assignment,
        requestedLaneRoles.map((roleName) => ({ roleName })),
        now
      );
      created = attachReviewExecutionGroup(created, group);
      tx.saveReviewRound(task.id, created);
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
        + `${round.activeRunId === undefined ? "" : `; AgentRun ${round.activeRunId}`}); `
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

/**
 * Issue 07: re-validates the CLI-computed delta preflight inside the store
 * transaction.  The previous Round must be a completed acceptance (a full
 * Review or a completed delta) so a delta never extends missing execution
 * evidence.
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
    || !isCompletedTaskReviewEvidence(store, previous)) {
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
  const activePointer = store.getActiveRun(taskId, reviewerRoleName);
  if (reusableRound === undefined || reusableRound.status === "completed") {
    assertReviewerAvailable(store, taskId, reviewerRoleName);
    return;
  }
  if (reusableRound.status === "pending") {
    if (activePointer !== null) {
      throw usageError(`Reviewer Role already has an active AgentRun: ${reviewerRoleName}.`);
    }
    assertReviewerAvailable(store, taskId, reviewerRoleName, reusableRound);
    return;
  }
  const reviewerRunId = reusableRound.reviewerRunId;
  if (reviewerRunId === undefined
    && reusableRound.executionGroup?.lanes.some(({ disposition }) => disposition === "open")) {
    assertReviewerAvailable(store, taskId, reviewerRoleName, reusableRound);
    return;
  }
  const activeMatches = reviewerRunId !== undefined
    && activePointer?.id === reviewerRunId
    && activePointer.status === "active";
  if (!activeMatches) {
    throw usageError(
      `Existing Task-final ReviewRound ${reusableRound.id} is running without its exact Reviewer execution.`
    );
  }
  assertReviewerAvailable(store, taskId, reviewerRoleName, reusableRound);
}

function assertReviewerAvailable(
  store: TaskWorkflowStore,
  taskId: string,
  reviewerRoleName: string,
  reusableRound?: ReviewRound
): void {
  const availability = projectReviewerAvailability(store, taskId, reviewerRoleName);
  if (availability.kind === "available") return;
  if (reusableRound !== undefined && reviewerBusyBelongsToRound(availability, reusableRound)) {
    return;
  }
  throw usageError(
    `Reviewer ${reviewerRoleName} is busy (${availability.phase}`
      + `${availability.activeRunId === undefined ? "" : `; AgentRun ${availability.activeRunId}`}`
      + `${availability.activeReviewRoundId === undefined
        ? ""
        : `; ReviewRound ${availability.activeReviewRoundId}`}).`
  );
}

function reviewerBusyBelongsToRound(
  busy: ReviewerBusy,
  round: ReviewRound
): boolean {
  if (busy.activeReviewRoundId !== round.id) return false;
  if (busy.phase === "review-slot") return true;
  if (busy.phase !== "active-turn" || busy.activeRunId === undefined) return false;
  return round.reviewerRunId === busy.activeRunId
    || round.executionGroup?.lanes.some(({ currentRunId }) => (
      currentRunId === busy.activeRunId
    )) === true;
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
    if (round.scope !== "task") {
      throw usageError(`ReviewRound ${round.id} is not a failed Task-final ReviewRound.`);
    }
    if (round.reviewerRunId !== undefined) {
      if (round.status === "completed") {
        throw usageError(`ReviewRound ${round.id} is not retryable from ${round.status}.`);
      }
      throw usageError(
        `ReviewRound ${round.id} has Reviewer AgentRun ${round.reviewerRunId}; use task run retry instead.`
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

    const activePointer = tx.getActiveRun(task.id, reviewer.name);
    if (activePointer !== null) {
      throw usageError(`Reviewer Role already has an active AgentRun: ${reviewer.name}.`);
    }
    assertReviewerAvailable(tx, task.id, reviewer.name, round);

    // Issue 06: an already-pending Round is the idempotent retry result.
    if (round.status === "pending") {
      return { round, created: false } as const;
    }

    // Issue 06: infra retry resets the same semantic Round to pending instead
    // of manufacturing a new Round, so Round count and finding identity stay
    // stable across execution-attempt failures.
    const resetRound = retryTaskReviewRound(round, requestedBy, now);
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
  if (command === "settle") return settleRun(rest, store, options);
  if (command === "checkpoint") return output(checkpointRun(rest, store, options));
  if (command === "retire") return retireRun(rest, store, options);
  throw usageError(command === undefined
    ? "Task turn command is required."
    : `Unknown command: task run ${command}`);
}

function settleRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task turn settle usage: yui task run settle <task>/<run>.");
  const previous = store.transaction((tx) => requireRun(tx, args[0], options));
  if (previous.purpose === "review") {
    if (previous.executionGroupId !== undefined
      && previous.executionLaneId !== undefined) {
      return settleFailedReviewExecutionLaneRun(previous, store, options);
    }
    return settleStaleFinalReviewRun(args, store, options);
  }
  return settleFailedExecutionLaneRun(previous, store, options);
}

function settleFailedReviewExecutionLaneRun(
  previous: AgentRun,
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const now = clock(options);
  const result = store.transaction((tx) => {
    const run = tx.getRun(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "review") {
      throw usageError(`AgentRun ${previous.id} is not a failed review AgentRun.`);
    }
    if (run.reviewRoundId === undefined
      || run.executionGroupId === undefined
      || run.executionLaneId === undefined
      || run.sourceExecutionGroupId !== undefined) {
      throw usageError(`AgentRun ${run.id} is not a failed Review Producer Lane AgentRun.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const actor = taskActor(tx, options, task.id);
    const round = tx.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) {
      throw dataError(`ReviewRound not found for AgentRun ${run.id}: ${run.reviewRoundId}.`);
    }
    const group = round.executionGroup;
    if (group === undefined || group.id !== run.executionGroupId) {
      throw usageError(`AgentRun ${run.id} no longer belongs to the Review ExecutionGroup.`);
    }
    const lane = group.lanes.find(({ id }) => id === run.executionLaneId);
    if (lane === undefined || lane.currentRunId !== run.id || lane.roleName !== run.roleName) {
      throw usageError(`AgentRun ${run.id} no longer owns its Review Producer Lane.`);
    }
    if (lane.disposition === "failed") {
      return {
        run: run,
        reviewRound: round,
        changed: false,
        mainRuns: [] as readonly AgentRun[]
      } as const;
    }
    if (round.status !== "running" || lane.disposition !== "open") {
      throw usageError(
        `AgentRun ${run.id} cannot settle ${round.id}/${group.id}/${lane.id} from `
        + `${round.status}/${lane.disposition}.`
      );
    }
    const validation = validateExactRunReviewRound(tx, run, { allowTerminal: true });
    if (validation.disposition !== "applied") {
      throw usageError(
        `Review AgentRun ${run.id} no longer matches its frozen Review Lane: `
        + `${validation.reason ?? "mismatch"}.`
      );
    }
    if (tx.getActiveExecutionLaneRun(task.id, group.id, lane.id) !== null) {
      throw usageError(`Review Producer Lane still has an active AgentRun: ${group.id}/${lane.id}.`);
    }
    const settledGroup = updateUnifiedExecutionLane(group, lane.id, {
      currentRunId: run.id,
      disposition: "failed"
    }, now);
    tx.saveReviewRound(task.id, updateReviewExecutionGroup(round, settledGroup));
    recordTaskEvent(tx, task.id, "run.review-settled", {
      runId: run.id,
      reviewRoundId: round.id,
      executionGroupId: group.id,
      executionLaneId: lane.id,
      settledBy: actor,
      ...(actor === "leader" ? leaderActionEventPayload(tx, task.id, options) : {})
    }, now);
    return {
      run: run,
      reviewRound: tx.getReviewRound(task.id, round.id)!,
      changed: true,
      mainRuns: [] as readonly AgentRun[]
    } as const;
  });
  for (const run of result.mainRuns) {
    notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName));
  }
  return output(
    result.changed
      ? `Settled failed Review Producer Lane from AgentRun ${result.run.id}\n`
      : `Failed Review Producer Lane already settled from AgentRun ${result.run.id}\n`,
    {
      run: result.run,
      reviewRound: result.reviewRound,
      ...(result.mainRuns.length === 0 ? {} : { mainRuns: result.mainRuns })
    }
  );
}

function settleFailedExecutionLaneRun(
  previous: AgentRun,
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const now = clock(options);
  const result = store.transaction((tx) => {
    const run = tx.getRun(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "execution") {
      throw usageError(`AgentRun ${previous.id} is not a failed execution AgentRun.`);
    }
    if (run.workItemId === undefined
      || run.executionGroupId === undefined
      || run.executionLaneId === undefined
      || run.sourceExecutionGroupId !== undefined) {
      throw usageError(`AgentRun ${run.id} is not a failed WorkItem Execution Lane AgentRun.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const actor = taskActor(tx, options, task.id);
    const item = tx.getWorkItem(task.id, run.workItemId);
    if (item === null) throw dataError(`Work item not found for AgentRun ${run.id}: ${run.workItemId}.`);
    const group = currentWorkItemExecutionGroup(item);
    if (group === undefined || group.id !== run.executionGroupId) {
      throw usageError(`AgentRun ${run.id} no longer belongs to the current ExecutionGroup.`);
    }
    const lane = group.lanes.find(({ id }) => id === run.executionLaneId);
    if (lane === undefined || lane.currentRunId !== run.id) {
      throw usageError(`AgentRun ${run.id} no longer owns its Execution Lane.`);
    }
    if (lane.disposition === "failed") {
      return {
        run: run,
        workItem: item,
        changed: false,
        mainRuns: [] as readonly AgentRun[]
      } as const;
    }
    if (item.status !== "open" || lane.disposition !== "open") {
      throw usageError(
        `AgentRun ${run.id} cannot settle ${item.id}/${group.id}/${lane.id} from `
        + `${item.status}/${lane.disposition}.`
      );
    }
    if (tx.getActiveExecutionLaneRun(task.id, group.id, lane.id) !== null) {
      throw usageError(`Execution Lane still has an active AgentRun: ${group.id}/${lane.id}.`);
    }
    const settledGroup = updateWorkItemExecutionLane(group, lane.id, {
      currentRunId: run.id,
      disposition: "failed"
    }, now);
    const settledItem = updateWorkItemExecutionGroup(item, settledGroup, now);
    tx.saveWorkItem(task.id, settledItem);
    recordTaskEvent(tx, task.id, "run.execution-settled", {
      runId: run.id,
      workItemId: item.id,
      executionGroupId: group.id,
      executionLaneId: lane.id,
      settledBy: actor,
      ...(actor === "leader" ? leaderActionEventPayload(tx, task.id, options) : {})
    }, now);
    return {
      run: run,
      workItem: tx.getWorkItem(task.id, item.id) ?? settledItem,
      changed: true,
      mainRuns: [] as readonly AgentRun[]
    } as const;
  });
  for (const run of result.mainRuns) {
    notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName));
  }
  return output(
    result.changed
      ? `Settled failed Execution Lane from AgentRun ${result.run.id}\n`
      : `Failed Execution Lane already settled from AgentRun ${result.run.id}\n`,
    {
      run: result.run,
      workItem: result.workItem,
      ...(result.mainRuns.length === 0 ? {} : { mainRuns: result.mainRuns })
    }
  );
}

function retireRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task turn retire usage: yui task run retire <task>/<run> --reason <text> [--expected-progress-at <timestamp>] [--agent-id <id>] [--adapter-id <id>] [--native-session-id <id>].";
  const parsed = parseTail(args, new Set([
    "--reason",
    "--expected-progress-at",
    "--progress-at",
    "--agent-id",
    "--adapter-id",
    "--native-session-id"
  ]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const reason = requiredOption(parsed.options, "--reason");
  const reference = taskRecordReference(
    parsed.positionals[0],
    "run",
    "AgentRun reference",
    options
  );
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, reference.taskId);
    assertTaskOpen(task);
    const actor = taskActor(tx, options, task.id);
    let run = tx.getRun(task.id, reference.localId);
    if (run === null) throw dataError(`AgentRun not found: ${task.id}/${reference.localId}.`);
    const events = tx.listEvents(task.id);
    if (isTaskRecordRetired(events, "run", run.id)) {
      return { task, run: run, changed: false } as const;
    }
    if (run.status === "active") {
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
      const sessions = tx.getTaskRoleSessionSet(task.id, run.roleName);
      const session = sessions?.sessions[run.effective.agentId];
      if (session?.nativeSessionId !== undefined && nativeSessionId === undefined) {
        throw usageError("--native-session-id is required for this active AgentRun.", usage);
      }
      const terminal = retireExactActiveRun(tx, {
        taskId: task.id,
        roleName: run.roleName,
        runId: run.id,
        agentId,
        adapterId,
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
        expectedProgressAt,
        reason: `AgentRun retired: ${reason}`
      }, now);
      if (terminal.disposition !== "applied" || terminal.run === null) {
        throw usageError(
          terminal.disposition === "blocked"
            ? `AgentRun retirement is blocked: ${run.id}/${terminal.reason ?? "unsafe"}.`
            : `AgentRun changed during retirement: ${run.id}/${terminal.reason ?? "obsolete"}.`
        );
      }
      run = terminal.run;
    }
    recordTaskEvent(tx, task.id, "run.retired", {
      runId: run.id,
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
      ...(actor === "leader"
        ? leaderActionEventPayload(tx, task.id, options)
        : { retiredBy: actor })
    }, now);
    tx.saveEvent(task.id, createTaskRecordRetirement({
      eventId: tx.nextEventId(task.id),
      taskId: task.id,
      recordKind: "run",
      recordId: run.id,
      reason,
      retiredBy: actor
    }, now));
    return { task, run: run, changed: true } as const;
  });
  if (result.changed) options.runtime?.notifyMailboxChanged({ kind: "task", taskId: result.task.id });
  return output(`Retired AgentRun ${result.task.id}/${result.run.id}\n`, {
    run: result.run,
    retired: true
  });
}

function runContextCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [first, ...rest] = args;
  if (first === "expand") {
    const usage = "Task turn context expand usage: yui task run context expand <task>/<run> <ref-id> [--store <store>] [--mode full].";
    const parsed = parseTail(rest, new Set(["--store", "--mode"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const mode = parsed.options.get("--mode");
    if (mode !== undefined && mode !== "full") {
      throw usageError("AgentRun Context expansion mode must be full.", usage);
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
        "Task turn context delta usage: yui task run context delta <task>/<run> --after <cursor>."
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
    throw usageError("Task turn context usage: yui task run context <task>/<run>.");
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
    throw usageError(`AgentRun context reference is invalid: ${value}.`);
  }
  return { taskId, runId };
}

/**
 * A AgentRun Context Pack is information the Role's own runtime reads in order to
 * work. Authorization is therefore scope-shaped, not schedule-shaped: the
 * caller must be the current runtime of the Task Role that owns the AgentRun,
 * proven by its per-Session caller key against durable state.
 *
 * It deliberately does not require the AgentRun to still be the active one. An
 * Agent whose AgentRun has advanced must still be able to read the context it was
 * given; losing read access to its own Role's history is what forces an
 * otherwise healthy Agent to stop and escalate to a human.
 */
function authorizeRunContext(
  store: TaskWorkflowStore,
  taskId: string,
  runId: string,
  environment: NodeJS.ProcessEnv | undefined
): void {
  const managed = environment?.YUI_SESSION_SCOPE !== undefined
    || environment?.YUI_TASK_ID !== undefined
    || environment?.YUI_ROLE !== undefined;
  if (!managed) return;
  const run = store.getRun(taskId, runId);
  if (run === null) {
    throw usageError(`AgentRun Context access is not authorized: ${taskId}/${runId}.`);
  }
  if (currentManagedRuntime(store, environment, taskId, run.roleName) === undefined) {
    throw usageError(
      `AgentRun Context access requires the current runtime of ${taskId}/${run.roleName}.`
    );
  }
}

function listRuns(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task turn list usage: yui task run list <task|task/work>.";
  exactPositionals(args, 1, usage);
  const reference = args[0]!;
  const task = store.getTask(reference);
  const item = task === null ? requireWorkItem(store, reference, options) : null;
  const taskId = task?.id ?? item!.taskId;
  const runs = store.listRuns(taskId).filter((run) => (
    item === null || run.workItemId === item.id
  ));
  if (runs.length === 0) return "No AgentRuns found.\n";
  const events = store.listEvents(taskId);
  return `${renderTable(
    `AgentRuns: ${item?.id ?? taskId}`,
    [
      { header: "AgentRun", minWidth: 6, maxWidth: 20 },
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
    runs.map((run) => [
      run.id,
      run.roleName,
      run.workItemId ?? (run.reviewRoundId === undefined ? "task" : `review:${run.reviewRoundId}`),
      run.purpose,
      run.mode,
      `${run.effective.agentId}/${run.effective.adapterId} r${run.effective.sourceDesiredRevision}`,
      run.effective.profileAccess,
      run.effective.permission.strategy,
      run.status,
      isTaskRecordRetired(events, "run", run.id) ? "retired" : "active",
      run.result?.output ?? run.result?.diagnostic ?? "-"
    ]),
    defaultTableWidth()
  )}\n`;
}

/**
 * Settles only the known bootstrap split where a failed Task-final AgentRun
 * still owns a running ReviewRound, but the committed Task heads have moved
 * on. This is deliberately narrower than retry: it cannot manufacture a
 * review or fail an arbitrary Round, and every identity/mailbox fence is
 * checked before the old Round changes. The next normal Task completion then
 * creates one fresh Round over the newer frozen Task heads.
 */
function settleStaleFinalReviewRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task turn settle usage: yui task run settle <task>/<run>.");
  const now = clock(options);
  const previous = store.transaction((tx) => requireRun(tx, args[0], options));
  const result = store.transaction((tx) => {
    const run = tx.getRun(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "review") {
      throw usageError(`AgentRun ${previous.id} is not a failed review AgentRun.`);
    }
    if (run.reviewRoundId === undefined) {
      throw usageError(`Review AgentRun ${run.id} has no ReviewRound.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const actor = taskActor(tx, options, task.id);
    const round = tx.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) {
      throw dataError(`ReviewRound not found for AgentRun ${run.id}: ${run.reviewRoundId}.`);
    }
    if (round.scope !== "task") {
      throw usageError(
        `Review AgentRun ${run.id} is not a Task-final review; request a new WorkItem review `
        + "for a new Candidate."
      );
    }
    const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
    if (!sameTaskFinalReviewContract(round.taskFinalReviewContract, taskFinalContract)) {
      throw usageError(`Task final-review contract does not match ReviewRound ${round.id}.`);
    }
    // This read-only compare-and-swap fence covers the exact AgentRun/Round,
    // Candidate, stored Review workspace, frozen Project scope, and frozen
    // Project heads before any mailbox or Round write.
    const validation = validateExactRunReviewRound(tx, run, { allowTerminal: true });
    if (validation.disposition !== "applied" || validation.round === null) {
      throw usageError(
        `Review AgentRun ${run.id} identity does not match its ReviewRound or frozen Task state changed: ${validation.reason ?? "mismatch"}.`
      );
    }
    const activeRoleRun = tx.getActiveRun(task.id, round.reviewerRoleName);
    if (activeRoleRun !== null) {
      throw usageError(
        `${task.id}/${round.reviewerRoleName} already has active AgentRun ${activeRoleRun.id}.`
      );
    }

    const taskRounds = reviewRoundsByIdentity(tx.listReviewRounds(task.id)
      .filter((entry) => entry.scope === "task"));
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
      if (round.failure?.kind === "execution") {
        return { run: run, round, changed: false } as const;
      }
      throw usageError(`Final ReviewRound is already terminal: ${round.id}/${round.status}.`);
    }
    if (round.status !== "running") {
      throw usageError(`Final ReviewRound is not stranded running: ${round.id}/${round.status}.`);
    }

    assertReviewerAvailable(tx, task.id, round.reviewerRoleName, round);

    const summary = `Review AgentRun ${run.id} failed before delivery; committed Task heads changed.`;
    const terminal = finishReviewRound(
      round,
      "failed",
      now,
      { kind: "execution", message: summary }
    );
    tx.saveReviewRound(task.id, terminal);
    recordTaskEvent(tx, task.id, "run.review-stale-settled", {
      runId: run.id,
      reviewRoundId: round.id,
      previousTaskCandidate: JSON.stringify(round.taskCandidate),
      currentTaskCandidate: JSON.stringify(currentTaskCandidate),
      settledBy: actor,
      ...(actor === "leader" ? leaderActionEventPayload(tx, task.id, options) : {})
    }, now);
    return { run: run, round: terminal, changed: true } as const;
  });
  return output(
    result.changed
      ? `Settled obsolete final Review ${result.round.id} from failed AgentRun ${result.run.id}\n`
      : `Obsolete final Review already settled: ${result.round.id}/${result.run.id}\n`,
    { reviewRound: result.round, reviewRun: result.run }
  );
}

function retryRun(
  args: string[], store: TaskWorkflowStore, options: TaskCommandOptions
): TaskCommandExecution {
  return store.transaction(tx => {
    const previous = requireRun(tx, args[0], options);
    const existing = tx.listEvents(previous.taskId).find(event => event.type === "run.retried"
      && event.payload.previousRunId === previous.id);
    if (existing !== undefined) {
      return output(`Retry already recorded as ${existing.payload.runId}; retry that exact successor if needed.\n`);
    }
    const sessions = tx.getTaskRoleSessionSet(previous.taskId, previous.roleName);
    const retry = sessions?.providerBinding?.retry;
    if (options.providerRetryChainId !== undefined
      && (retry?.chainId !== options.providerRetryChainId || retry.status !== "waiting"
        || retry.previousRunId !== previous.id || clock(options).getTime() < Date.parse(retry.nextEligibleAt)
        || clock(options).getTime() >= Date.parse(retry.deadline))) {
      throw usageError("Provider recovery intent is no longer eligible.");
    }
    const result = retryRunOperation(args, tx, options);
    if (retry !== undefined && retry.status !== "recovered" && retry.previousRunId === previous.id && sessions?.providerBinding != null) {
      const successor = tx.getActiveRun(previous.taskId, previous.roleName);
      tx.saveTaskRoleSessionSet({
        ...sessions, providerBinding: {
          ...sessions.providerBinding, retry: {
            ...retry, status: "waiting", successorAutomatic: options.providerRetryChainId !== undefined,
            ...(options.providerRetryChainId === undefined ? {
              intentAt: clock(options).toISOString(),
              // An explicit manual attempt does not inherit automatic jitter,
              // but cannot shorten a trusted server minimum.
              nextEligibleAt: new Date(Math.max(clock(options).getTime(),
                retry.error.retryAfterMs === undefined ? 0
                  : Date.parse(sessions.providerBinding.run!.updatedAt) + retry.error.retryAfterMs + 1)).toISOString()
            } : {}),
            ...(successor === null ? {} : { successorRunId: successor.id }),
            ...(previous.reviewRoundId === undefined ? {} : { successorReviewRoundId: previous.reviewRoundId })
          }
        }
      });
    }
    return result;
  });
}

function retryRunOperation(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task turn retry usage: yui task run retry <task>/<run>.");
  const now = clock(options);
  const previous = store.transaction((tx) => requireRun(tx, args[0], options));
  if (previous.purpose === "review") {
    return retryFailedReviewRun(previous, store, options, now);
  }
  const retried = store.transaction((tx) => {
    if (previous.status !== "failed") {
      throw usageError(`AgentRun ${previous.id} is not retryable from ${previous.status}.`);
    }
    const task = requireTask(tx, previous.taskId);
    assertTaskExecutionEnabled(task, "retrying a AgentRun");
    if (!runPurposeAdmitsTaskState(previous.purpose, task)) {
      throw usageError(`Task does not admit ${previous.purpose} retry: ${task.id}/${task.status}.`);
    }
    const role = requireRole(tx, task.id, previous.roleName);
    if (tx.getActiveRun(task.id, role.name) !== null) {
      throw usageError(`${task.id}/${role.name} already has an active run.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const retryItem = previous.workItemId === undefined
      ? null
      : tx.getWorkItem(task.id, previous.workItemId);
    if (previous.workItemId !== undefined && retryItem === null) {
      throw dataError(`Work item not found for AgentRun ${previous.id}: ${previous.workItemId}.`);
    }
    const retriesSynthesisMain = previous.sourceExecutionGroupId !== undefined;
    if (retriesSynthesisMain
      && (previous.executionGroupId !== undefined || previous.executionLaneId !== undefined)) {
      throw dataError(`AgentRun ${previous.id} has conflicting execution lineage.`);
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
      && retryLaneBefore.currentRunId === previous.id
    );
    if (!exactCurrentLane) {
      throw usageError(
        `AgentRun ${previous.id} no longer owns the current failed Execution Lane.`
      );
    }
    const sourceGroup = !retriesSynthesisMain || retryItem === null
      ? undefined
      : workItemExecutionGroupById(retryItem, previous.sourceExecutionGroupId!);
    const sourceMainRuns = retriesSynthesisMain
      ? chronologicalRuns(tx.listRuns(task.id).filter((run) => (
          run.purpose === "execution"
          && run.workItemId === previous.workItemId
          && run.sourceExecutionGroupId === previous.sourceExecutionGroupId
        )))
      : [];
    const exactSourceMain = !retriesSynthesisMain || (
      retryItem !== null
      && retryItem.status === "open"
      && retryItem.assignee === previous.roleName
      && sourceGroup !== undefined
      && currentRetryGroup?.id === sourceGroup.id
      && selectedWorkItemSynthesisProducers(
        tx, retryItem, sourceGroup, synthesisSourceRunIds(tx, previous)
      ).length > 0
      && sourceMainRuns.at(-1)?.id === previous.id
    );
    if (!exactSourceMain) {
      throw usageError(
        `AgentRun ${previous.id} no longer owns the current WorkItem main synthesis.`
      );
    }
    const directMainRuns = retryItem === null
      ? []
      : chronologicalRuns(tx.listRuns(task.id).filter((run) => (
          run.purpose === "execution"
          && run.workItemId === retryItem.id
          && run.executionGroupId === undefined
          && run.executionLaneId === undefined
          && run.sourceExecutionGroupId === undefined
        )));
    const retriesDirectMain = retryItem !== null
      && !retriesExecutionLane
      && !retriesSynthesisMain;
    const exactDirectMain = !retriesDirectMain || (
      retryItem.status === "open"
      && retryItem.assignee === previous.roleName
      && directMainRuns.at(-1)?.id === previous.id
    );
    if (!exactDirectMain) {
      throw usageError(
        `AgentRun ${previous.id} no longer owns the current direct WorkItem execution.`
      );
    }
    const groupedRunningRetry = retryItem?.status === "open"
      && retriesExecutionLane
      && exactCurrentLane;
    const synthesisRunningRetry = retryItem?.status === "open"
      && retriesSynthesisMain
      && exactSourceMain;
    const directRunningRetry = retryItem?.status === "open"
      && retriesDirectMain
      && exactDirectMain;
    if (retryItem !== null
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
      throw dataError(`AgentRun ${previous.id} execution lineage no longer matches its Work Item.`);
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
        throw dataError(`AgentRun ${previous.id} Lane workspace is missing or has drifted.`);
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
        throw dataError(`AgentRun ${previous.id} WorkItem main workspace is missing or has drifted.`);
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
        throw dataError(`AgentRun ${previous.id} direct WorkItem workspace is missing or has drifted.`);
      }
    }
    const effective = retryLane?.effective ?? resolveEffectiveLaunch({
      role,
      purpose: previous.purpose,
      ...(retryManagedWorkspace === undefined ? {} : { workspace: retryManagedWorkspace }),
      ...(retryItem === null ? {} : { workItemWriteProjectIds: retryItem.writeProjectIds })
    });
    const runId = tx.nextRunId(task.id);
    const runningGroup = retryGroup === undefined || retryLane === undefined
      ? undefined
      : updateWorkItemExecutionLane(retryGroup, retryLane.id, {
          currentRunId: runId
        }, now);
    // Restart the bound lane and reopen the failed WorkItem as two ordered
    // single-step record revisions, matching the dispatch path. Folding both
    // transforms into one save would move the WorkItem two revisions at once,
    // which the store's one-step transition guard rejects.
    const laneRestartedItem = retryItem === null || runningGroup === undefined
      ? retryItem
      : updateWorkItemExecutionGroup(retryItem, runningGroup, now);
    const retriedItemWithGroup = laneRestartedItem;
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
          const retrySnapshot = freezeRunContextSnapshot(tx, {
            taskId: task.id,
            roleName: role.name,
            purpose: previous.purpose,
            ...(previous.workItemId === undefined ? {} : { workItemId: previous.workItemId })
          }, now, "controller", retryGroup?.assignment.contextSnapshotRef);
          return createRunInput({
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
    const created = createRun(
      runId!,
      task.id,
      role.name,
      roleAgentSessionResumeMode(sessions, effective.agentId, effective),
      input,
      now,
      {
        purpose: previous.purpose,
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
    tx.saveRun(created);
    tx.saveActiveRun(created);
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
    enqueueRoleRunDispatch(tx, {
      taskId: task.id,
      roleName: role.name,
      runId: created.id,
      reason: "turn-retried",
      occurredAt: now
    });
    recordTaskEvent(tx, task.id, "run.retried", {
      ...runLaunchEventPayload(created),
      previousRunId: previous.id
    }, now);
    return { kind: "run" as const, run: created };
  });
  notifyMailbox(
    options.runtime,
    roleMailbox(retried.run.taskId, retried.run.roleName)
  );
  return output(
    `Retry queued as ${retried.run.id} for ${retried.run.taskId}/${retried.run.roleName}\n`
  );
}

function actualTaskReviewCandidateForMutation(
  _store: TaskWorkflowStore,
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
 * head. Drift fails closed before a Reviewer AgentRun is created.
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
      const sourceRun = store.getRun(task.id, sourceCandidate.source.runId);
      if (sourceRun === null
        || sourceRun.workItemId !== item.id
        || sourceRun.purpose !== "execution"
        || sourceRun.status !== "completed") {
        throw dataError(
          `Committed producer Candidate AgentRun is unavailable: `
          + `${item.id}/${sourceCandidate.source.runId}.`
        );
      }
      recordProducer(sourceRun.roleName, item.id);
      if (sourceRun.sourceExecutionGroupId !== undefined) {
        const executionGroup = workItemExecutionGroupById(
          item,
          sourceRun.sourceExecutionGroupId
        );
        if (executionGroup === undefined) {
          throw dataError(
            `Committed producer ExecutionGroup is unavailable: `
            + `${item.id}/${sourceRun.sourceExecutionGroupId}.`
          );
        }
        for (const producer of selectedWorkItemSynthesisProducers(
          store,
          item,
          executionGroup,
          synthesisSourceRunIds(store, sourceRun)
        )) {
          recordProducer(producer.roleName, item.id);
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
    && entry.scope === "task"
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
 * failed ReviewRound.
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
        + `${availability.activeRunId === undefined ? "" : `; AgentRun ${availability.activeRunId}`}); `
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
      round.scope === "task"
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
  if (taskRounds.some((round) => isCompletedTaskReviewEvidence(store, round))) {
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
    return isCompletedTaskReviewEvidence(store, latest) ? null : latest;
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
  _taskCandidate: TaskReviewCandidate,
  taskFinalContract: TaskFinalReviewContract | undefined,
  _options: TaskCommandOptions
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
      `Pending final ReviewRound already records Reviewer AgentRun ${round.reviewerRunId}: ${round.id}.`
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
  if (store.getActiveRun(task.id, reviewer.name) !== null) {
    throw usageError(`Reviewer Role already has an active AgentRun: ${reviewer.name}.`);
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
 * Task-control retry of an exact failed review AgentRun. The old failed AgentRun
 * remains the attempt trail, while the ReviewRound is reset to pending under
 * its existing identity. Every identity and frozen-head fence is
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
    const run = tx.getRun(previous.taskId, previous.id);
    if (run === null || run.status !== "failed" || run.purpose !== "review") {
      throw usageError(`AgentRun ${previous.id} is not a failed review AgentRun.`);
    }
    if (run.reviewRoundId === undefined) {
      throw usageError(`Review AgentRun ${run.id} has no ReviewRound.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const requestedBy = options.providerRetryChainId === undefined ? taskActor(tx, options, task.id) : "policy";
    const round = tx.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) {
      throw dataError(`ReviewRound not found for run ${run.id}: ${run.reviewRoundId}.`);
    }
    const taskScope = round.scope === "task";
    const retryLane = run.executionLaneId === undefined
      ? undefined
      : round.executionGroup?.lanes.find(({ id }) => id === run.executionLaneId);
    if (run.executionGroupId !== undefined && (
      round.executionGroup?.id !== run.executionGroupId
      || retryLane === undefined
      || retryLane.currentRunId !== run.id
      || retryLane.roleName !== run.roleName
    )) {
      throw usageError(
        `Review AgentRun ${run.id} no longer owns its exact Review Lane attempt.`
      );
    }
    const panelGroup = round.executionGroup !== undefined;
    const runningPanelLaneRetry = round.status === "running"
      && panelGroup
      && retryLane?.disposition === "open";
    if (round.status === "running" && panelGroup && !runningPanelLaneRetry) {
      throw usageError(
        `Review AgentRun ${run.id} is not the current failed Lane attempt in running Round ${round.id}.`
      );
    }
    const retryReviewerRoleName = retryLane?.roleName ?? round.reviewerRoleName;
    if (round.status !== "failed"
      && round.status !== "running"
      && round.status !== "pending"
      && round.status !== "completed") {
      throw usageError(`ReviewRound ${round.id} is not retryable from ${round.status}.`);
    }
    const allRounds = tx.listReviewRounds(task.id);
    if (taskScope) {
      const taskFinalContract = taskFinalReviewContractForMutation(tx, task.id, options);
      if (!sameTaskFinalReviewContract(round.taskFinalReviewContract, taskFinalContract)) {
        throw usageError(`Task final-review contract does not match ReviewRound ${round.id}.`);
      }
      const currentTaskCandidate = actualTaskReviewCandidateForMutation(tx, task, options);
      if (!isSameTaskReviewCandidate(currentTaskCandidate, round.taskCandidate!)) {
        throw usageError(
          `Task-final ReviewRound ${round.id} no longer matches the frozen Task heads.`
        );
      }
      const taskRounds = reviewRoundsByIdentity(allRounds
        .filter((entry) => entry.scope === "task"));
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
      assertNoConflictingTaskReviewRound(
        allRounds,
        round.id,
        retryReviewerRoleName
      );
    } else {
      if (round.workItemId === undefined || round.candidateId === undefined) {
        throw dataError(`WorkItem ReviewRound has no Candidate anchor: ${round.id}.`);
      }
      if (run.workItemId !== round.workItemId) {
        throw usageError(`Review AgentRun ${run.id} does not match WorkItem ${round.workItemId}.`);
      }
      const item = tx.getWorkItem(task.id, round.workItemId);
      if (item === null || (item.status !== "open" || item.candidates.length === 0)) {
        throw usageError(
          `WorkItem ReviewRound ${round.id} no longer has an awaiting Candidate.`
        );
      }
      const candidate = currentWorkItemCandidate(item);
      if (candidate === undefined || candidate.id !== round.candidateId) {
        throw usageError(
          `WorkItem ReviewRound ${round.id} no longer matches the current Candidate.`
        );
      }
      if (candidate.gitSnapshot?.reviewBaseCommit !== round.reviewBaseCommit) {
        throw usageError(`ReviewRound Candidate snapshot changed: ${round.id}.`);
      }
      if (candidate.reviewPolicy === undefined
        || candidate.reviewPolicy.trigger === "final"
        || candidate.reviewPolicy.roleName !== round.reviewerRoleName) {
        throw usageError(`Candidate review policy no longer matches ReviewRound ${round.id}.`);
      }
      const candidateRounds = reviewRoundsByIdentity(allRounds.filter((entry) => (
        entry.workItemId === round.workItemId
        && entry.candidateId === round.candidateId
      )));
      const roundIndex = candidateRounds.findIndex(({ id }) => id === round.id);
      if (roundIndex < 0) {
        throw dataError(`ReviewRound is not in Candidate history: ${round.id}.`);
      }
      const laterRound = candidateRounds[roundIndex + 1];
      if (laterRound !== undefined) {
        throw usageError(
          `A newer ReviewRound already exists for Candidate ${round.candidateId}: `
          + `${laterRound.id}.`
        );
      }
      const activeCandidateRound = candidateRounds.find((entry) => (
        entry.id !== round.id
        && (entry.status === "pending" || entry.status === "running")
      ));
      if (activeCandidateRound !== undefined) {
        throw usageError(
          `Candidate already has an active ReviewRound: ${activeCandidateRound.id}.`
        );
      }
    }
    const allReviewerRounds = reviewRoundsByIdentity(
      allRounds.filter((entry) => (
        entry.reviewerRoleName === retryReviewerRoleName
      ))
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

    const reviewer = requireRole(tx, task.id, retryReviewerRoleName);
    const activePointer = tx.getActiveRun(task.id, reviewer.name);

    // Issue 06: a completed same-Round retry is a no-write idempotent result.
    if (round.status === "completed") {
      assertReviewerAvailable(tx, task.id, reviewer.name);
      return { round, previousRun: run, created: false };
    }

    // Issue 06: a running same Round is reusable only with its exact active
    // AgentRun. A stranded AgentRun (no active pointer) falls through and resets the
    // Round after the identity fences below.
    if (round.status === "running" && !runningPanelLaneRetry) {
      const reviewerRunId = round.reviewerRunId;
      const activeMatches = reviewerRunId !== undefined
        && activePointer !== null
        && activePointer.id === reviewerRunId
        && activePointer.status === "active";
      if (activePointer !== null && !activeMatches) {
        throw usageError(
          `Existing running ReviewRound ${round.id} lacks its exact active Reviewer execution.`
        );
      }
      if (activeMatches) {
        assertReviewerAvailable(tx, task.id, reviewer.name, round);
        return { round, previousRun: run, created: false };
      }
    }

    // Issue 06: an already-pending Round is the idempotent retry result.
    if (round.status === "pending") {
      if (activePointer !== null) {
        throw usageError(`Reviewer Role already has an active AgentRun: ${reviewer.name}.`);
      }
      assertReviewerAvailable(tx, task.id, reviewer.name, round);
      return { round, previousRun: run, created: false };
    }

    if (activePointer !== null) {
      throw usageError(`Reviewer Role already has an active AgentRun: ${reviewer.name}.`);
    }
    assertReviewerAvailable(tx, task.id, reviewer.name, round);

    const validation = validateExactRunReviewRound(tx, run, { allowTerminal: true });
    if (validation.disposition !== "applied" || validation.round === null) {
      throw usageError(
        `Review AgentRun ${run.id} identity does not match its ReviewRound or frozen Task state changed: ${validation.reason ?? "mismatch"}.`
      );
    }

    if (run.sourceExecutionGroupId !== undefined) {
      assertTaskExecutionEnabled(task, "retrying Review synthesis");
      const group = round.executionGroup;
      if (round.status !== "failed" || round.reviewerRunId !== run.id
        || group?.id !== run.sourceExecutionGroupId
        || run.workspace === undefined) {
        throw usageError(`Review AgentRun ${run.id} no longer owns the current main synthesis.`);
      }
      selectedReviewSynthesisProducers(tx, round, group, synthesisSourceRunIds(tx, run));
      const effective = resolveEffectiveLaunch({
        role: reviewer,
        purpose: "review",
        workspace: run.workspace,
        reviewRoundId: round.id,
        reviewBaseCommit: round.reviewBaseCommit
      });
      const created = createRun(
        tx.nextRunId(task.id),
        task.id,
        reviewer.name,
        roleAgentSessionResumeMode(
          tx.getTaskRoleSessionSet(task.id, reviewer.name), effective.agentId, effective
        ),
        run.inputs[0]!.input,
        now,
        {
          purpose: "review",
          ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId }),
          reviewRoundId: round.id,
          sourceExecutionGroupId: group.id,
          workspace: run.workspace,
          effective
        }
      );
      const restarted = startReviewRound(retryReviewRound(round, requestedBy, now), created.id);
      tx.saveReviewRound(task.id, restarted);
      tx.saveRun(created);
      tx.saveActiveRun(created);
      enqueueRoleRunDispatch(tx, {
        taskId: task.id,
        roleName: reviewer.name,
        runId: created.id,
        reason: "turn-retried",
        occurredAt: now
      });
      recordTaskEvent(tx, task.id, "run.review-retried", {
        ...runLaunchEventPayload(created),
        previousRunId: run.id
      }, now);
      return { round: restarted, previousRun: run, created: true, run: created };
    }

    if (runningPanelLaneRetry) {
      const resetRound = retryRunningReviewExecutionLane(
        round,
        retryLane!.id,
        run.id
      );
      tx.saveReviewRound(task.id, resetRound);
      recordTaskEvent(tx, task.id, "run.review-retried", {
        runId: run.id,
        reviewRoundId: round.id,
        executionLaneId: retryLane!.id
      }, now);
      return { round: resetRound, previousRun: run, created: true };
    }
    // Terminalize the old stranded Round only after every identity and mailbox
    // fence has passed. The outer transaction rolls back if Round creation fails.
    let roundToReset = round;
    if (round.status !== "failed") {
      const summary = `Review AgentRun ${run.id} failed before delivery.`;
      roundToReset = finishReviewRound(
        round,
        "failed",
        now,
        { kind: "execution", message: summary }
      );
      tx.saveReviewRound(task.id, roundToReset);
    }
    // Issue 06: infra retry resets the same semantic Round to pending instead
    // of manufacturing a new Round, so Round count and finding identity stay
    // stable across execution-attempt failures.
    const resetRound = retryReviewRound(roundToReset, requestedBy, now);
    tx.saveReviewRound(task.id, resetRound);
    recordTaskEvent(tx, task.id, "run.review-retried", {
      runId: run.id,
      reviewRoundId: round.id
    }, now);
    return { round: resetRound, previousRun: run, created: true };
  });
  if ("run" in result && result.run !== undefined) {
    notifyMailbox(options.runtime, roleMailbox(result.run.taskId, result.run.roleName));
  }
  return output(
    result.created
      ? `Review retry requested as ${result.round.id}\n`
      : `Review retry already requested as ${result.round.id} (${result.round.status})\n`,
    { reviewRound: result.round, ...("run" in result ? { run: result.run } : {}) }
  );
}

/** AgentRun details are retained audit evidence; continuation uses durable Task state. */
function showRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task turn show usage: yui task run show <task>/<run> [--json].";
  const asJson = args.includes("--json");
  const positionals = args.filter((arg) => arg !== "--json");
  exactPositionals(positionals, 1, usage);
  const data = store.transaction((tx) => {
    const run = requireRun(tx, positionals[0], options);
    const retirement = tx.listEvents(run.taskId)
      .map(taskRecordRetirement)
      .find((entry) => entry?.recordKind === "run" && entry.recordId === run.id) ?? null;
    return { run: run, retirement, execution: runExecutionObservation(run,
      tx.getTaskRoleSessionSet(run.taskId, run.roleName)?.providerBinding, tx.listEvents(run.taskId)) };
  });
  if (asJson) {
    return { kind: "output" as const, output: `${JSON.stringify(data, null, 2)}\n`, data };
  }
  return {
    kind: "output" as const,
    output: `Delivery observation: ${data.execution.delivery}\n` + renderRunShow(
      data.run,
      data.retirement
    ),
    data
  };
}

function renderRunShow(
  run: AgentRun,
  retirement: ReturnType<typeof taskRecordRetirement>
): string {
  const lines = [
    `AgentRun: ${run.id}`,
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
    ...(run.result?.output === undefined
      ? []
      : [`Result: ${run.result.output}`]),
    ...(run.result?.diagnostic === undefined
      ? []
      : [`Failure: ${run.result.diagnostic}`])
  ];
  return `${lines.join("\n")}\n`;
}


/**
 * Records a structured progress checkpoint for an active AgentRun. This is a durable
 * AgentRun fact, not a Task Message: it advances the AgentRun's durable-progress clock so
 * a healthy but long-running AgentRun keeps proving it is alive without adding
 * collaboration-narrative noise. It never completes, mutates the AgentRun, or wakes the
 * Leader.
 */
function checkpointRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task turn checkpoint usage: yui task run checkpoint <run> (--note <text>|--note-file <path|->).";
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
      throw usageError(`AgentRun ${run.id} is already terminal: ${run.status}.`);
    }
    const task = requireTask(tx, run.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "checkpointing a AgentRun"));
    const pointer = activeRunPointer(tx, run);
    if (pointer?.id !== run.id) {
      throw usageError(`AgentRun is not active for ${task.id}/${run.roleName}: ${run.id}.`);
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
    return progress;
  });
  return `Checkpoint recorded for ${parsed.positionals[0]} (${event.id}).\n`;
}

export function queueReviewRound(
  store: TaskWorkflowStore,
  item: WorkItem,
  config: ReviewConfig,
  requestedBy: ReviewRequestSource,
  now: Date,
  requestedLaneRoles: readonly string[] = []
): Readonly<{ round: ReviewRound }> {
  const candidate = requireWorkItemCandidate(item);
  if (candidate.gitSnapshot === undefined) {
    throw usageError(`Candidate has no frozen managed Git snapshot: ${candidate.id}.`);
  }
  const gitSnapshot = candidate.gitSnapshot;
  const laneRoles = validateReviewProducerRoles(config.roleName, requestedLaneRoles);
  const producerRoles = workItemCandidateProducerRoles(store, item, candidate);
  const collidingLane = laneRoles.find((roleName) => producerRoles.has(roleName));
  const collision = producerRoles.has(config.roleName)
    ? `Reviewer Role must be separate from the Candidate producer: ${config.roleName}.`
    : collidingLane === undefined
      ? null
      : `Review Producer Role must be separate from the Candidate producer: `
        + `${collidingLane}.`;
  const createPending = (): ReviewRound => createReviewRound(
    store.nextReviewRoundId(item.taskId),
    item.taskId,
    item.id,
    candidate.id,
    config.roleName,
    requestedBy,
    gitSnapshot.reviewBaseCommit,
    now
  );
  if (collision !== null) {
    const pending = createPending();
    store.saveReviewRound(item.taskId, pending);
    const failed = finishReviewRound(
      pending,
      "failed",
      now,
      { kind: "dispatch", message: collision }
    );
    store.saveReviewRound(item.taskId, failed);
    return { round: failed };
  }
  for (const roleName of [config.roleName, ...laneRoles]) {
    let reviewer = store.getRole(item.taskId, roleName);
    if (reviewer === null) {
      const globalRole = store.getGlobalRole(roleName);
      if (globalRole === null) {
        const pending = createPending();
        store.saveReviewRound(item.taskId, pending);
        const failed = finishReviewRound(
          pending,
          "failed",
          now,
          { kind: "dispatch", message: `Global Role not found: ${roleName}.` }
        );
        store.saveReviewRound(item.taskId, failed);
        return { round: failed };
      }
      const task = requireTask(store, item.taskId);
      reviewer = createTaskRole(store, task, roleName, undefined, now, roleName);
      store.saveRole(task.id, reviewer);
    }
    if (store.getActiveRun(item.taskId, reviewer.name) !== null) {
      const pending = createPending();
      store.saveReviewRound(item.taskId, pending);
      const failed = finishReviewRound(
        pending,
        "failed",
        now,
        {
          kind: "dispatch",
          message: `Reviewer Role already has an active AgentRun: ${reviewer.name}.`
        }
      );
      store.saveReviewRound(item.taskId, failed);
      return { round: failed };
    }
  }
  let pending = createPending();
  store.saveReviewRound(item.taskId, pending);
  if (laneRoles.length > 0) {
    const groupId = `execution-group-${pending.id}`;
    const baseline = freezeReviewStageContextSnapshot(store, {
      taskId: item.taskId,
      reviewRoundId: pending.id,
      executionGroupId: groupId
    }, now);
    const assignment = createReviewExecutionAssignment({
      input: `Review the frozen WorkItem Candidate for ReviewRound ${pending.id}.`,
      objective: item.objective,
      acceptance: item.acceptance,
      contextSnapshotRef: contextSnapshotRef(baseline),
      taskId: item.taskId,
      reviewRoundId: pending.id,
      reviewBaseCommit: pending.reviewBaseCommit,
      scope: "work-item",
      workItemId: item.id,
      candidateId: candidate.id,
      projects: gitSnapshot.projects.map(({ projectId, commit }) => ({
        projectId,
        baseCommit: commit
      }))
    });
    pending = attachReviewExecutionGroup(
      pending,
      createExecutionGroup(
        groupId,
        item.taskId,
        assignment,
        laneRoles.map((roleName) => ({ roleName })),
        now
      )
    );
    store.saveReviewRound(item.taskId, pending);
  }
  return { round: pending };
}

function requireIsolatedReviewLaneWorkspaces(
  store: TaskWorkflowStore,
  round: ReviewRound,
  lanes: readonly Readonly<{ id: string }>[],
  workspaces: ReadonlyMap<string, ManagedWorkspace> | undefined
): ReadonlyMap<string, ManagedWorkspace> {
  const prepared = new Map<string, ManagedWorkspace>();
  const frozenProjects = new Map(
    round.executionGroup?.assignment.projects.map(({ projectId, baseCommit }) => (
      [projectId, baseCommit]
    )) ?? []
  );
  const durableByRoot = new Map(
    store.listManagedWorkspaces(round.taskId).map((workspace) => (
      [workspace.root, managedWorkspaceKey(workspace.owner)]
    ))
  );
  const preparedByRoot = new Map<string, string>();
  for (const lane of lanes) {
    const workspace = workspaces?.get(lane.id);
    if (workspace === undefined) {
      throw usageError(
        `Review Lane workspace preflight is missing: `
        + `${round.executionGroup?.id ?? "unknown"}/${lane.id}.`
      );
    }
    const ownerKey = managedWorkspaceKey(workspace.owner);
    if (workspace.owner.type !== "execution-lane"
      || workspace.owner.taskId !== round.taskId
      || workspace.owner.purpose !== "review"
      || workspace.owner.reviewRoundId !== round.id
      || workspace.owner.executionGroupId !== round.executionGroup?.id
      || workspace.owner.executionLaneId !== lane.id) {
      throw usageError(
        `Review Lane workspace identity does not match dispatch: `
        + `${round.executionGroup?.id ?? "unknown"}/${lane.id}.`
      );
    }
    if (workspace.entries.length !== frozenProjects.size
      || workspace.entries.some((entry) => (
        entry.access !== "write"
        || frozenProjects.get(entry.projectId) !== entry.baseCommit
        || entry.baseRef !== entry.baseCommit
      ))) {
      throw usageError(
        `Review Lane workspace does not match the frozen Assignment: `
        + `${round.executionGroup?.id ?? "unknown"}/${lane.id}.`
      );
    }
    const preparedOwner = preparedByRoot.get(workspace.root);
    if (preparedOwner !== undefined && preparedOwner !== ownerKey) {
      throw usageError(`Review Producer workspaces collide at ${workspace.root}.`);
    }
    const durableOwner = durableByRoot.get(workspace.root);
    if (durableOwner !== undefined && durableOwner !== ownerKey) {
      throw usageError(`Review Producer workspace collides with ${durableOwner}.`);
    }
    preparedByRoot.set(workspace.root, ownerKey);
    prepared.set(lane.id, workspace);
  }
  return prepared;
}

export function dispatchPreparedReviewRound(
  taskId: string,
  reviewRoundId: string,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): AgentRun | null {
  const now = clock(options);
  const runs = store.transaction((tx) => {
    const round = tx.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw usageError(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    if (round.status !== "pending" && round.status !== "running") {
      throw usageError(`ReviewRound is not dispatchable: ${round.id}/${round.status}.`);
    }
    if (round.workspace === undefined) {
      if (round.scope === "task") {
        throw new TaskFinalReviewDispatchDriftError(
          `ReviewRound workspace is not ready: ${round.id}.`
        );
      }
      throw usageError(`ReviewRound workspace is not ready: ${round.id}.`);
    }
    const taskScope = round.scope === "task";
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
    if (round.scope === "task") {
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
          `Pending final ReviewRound already records Reviewer AgentRun ${round.reviewerRunId}: `
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
      if (round.scope === "task") {
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
      if (round.scope === "task") {
        throw new TaskFinalReviewDispatchDriftError(message);
      }
      throw usageError(message);
    }
    if (taskScope) {
      const requestedReviewers = new Set(
        [
          round.reviewerRoleName,
          ...(round.executionGroup?.lanes.map(({ roleName }) => roleName) ?? [])
        ]
      );
      const conflicting = tx.listReviewRounds(task.id).find((entry) => (
        entry.id !== round.id
        && entry.scope === "task"
        && (entry.status === "pending" || entry.status === "running")
        && (requestedReviewers.has(entry.reviewerRoleName)
          || entry.executionGroup?.lanes.some(({ roleName }) => (
            requestedReviewers.has(roleName)
          )) === true)
        && !(entry.status === "running"
          && entry.reviewerRunId !== undefined
          && tx.getRun(task.id, entry.reviewerRunId)?.status === "failed")
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
      : candidate!.source.type === "run"
        ? `candidate AgentRun ${candidate!.source.runId}`
        : `revision ${candidate!.workItemRevision}`;
    const frozenHeads = taskScope
      ? round.taskCandidate!.projects
        .map(({ projectId, commit }) => `${projectId}@${commit}`)
        .join(", ")
      : `candidate@${round.reviewBaseCommit}`;
    let deltaContext = "";
    if (taskScope && round.deltaRecheck !== undefined) {
      const previousRound = tx.getReviewRound(taskId, round.deltaRecheck.previousReviewRoundId);
      if (previousRound === null || !isCompletedTaskReviewEvidence(tx, previousRound)) {
        throw new TaskFinalReviewDispatchDriftError(
          `Delta-recheck accepted baseline is unavailable: ${round.deltaRecheck.previousReviewRoundId}.`
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
        diffByProject
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
      ...(taskScope && deltaContext !== "" ? [deltaContext] : []),
      "Start from the user's core outcome and the WorkItem intent. The candidate summary is a pointer, not proof: inspect the complete relevant change, callers, and proportionate checks.",
      "Keep Yui Core lifecycle safety, generic Reviewer behavior, Project Policy/Knowledge, and the Task Contract separate. Follow Project Policy pointers from the dispatch context for project-specific checks.",
      ...(round.scope === "task" && round.deltaRecheck === undefined
        ? ["This is a full Task Review: inspect every bound Project at the frozen Task heads, and report only reachable, material, actionable P1/P2 findings or bounded verification gaps."]
        : []),
      "You may freely edit source/tests, run local build or test commands, and optionally commit diagnostic evidence only inside this stable Reviewer workspace at the exact ReviewRound snapshot.",
      "Do not push, integrate, mutate Task state, touch the Candidate or Worker workspace, another Task/workspace, a stable checkout, or the real Yui control-plane home.",
      "End the Provider turn with one complete original result in clear Markdown or JSON. Recommended sections are conclusion, material findings, checks actually run, uncertainty, and next actions. Yui preserves the text verbatim and does not parse or validate those sections.",
      "Report reviewBaseCommit, exact checks/results, material findings, and uncertainty. This AgentRun result completes only the Round and creates no Candidate or ChangeSet.",
      "The Leader alone interprets and routes evidence: original Worker when open, a small Repair WorkItem when needed, or Leader/Integration for merge and local fixes; never merge review evidence yourself."
    ].join("\n");
    const createdRuns: AgentRun[] = [];
    if (round.executionGroup === undefined) {
      if (round.status !== "pending") return createdRuns;
      if (tx.getActiveRun(taskId, reviewer.name) !== null) {
        throw usageError(`Reviewer Role already has an active AgentRun: ${reviewer.name}.`);
      }
      const runId = tx.nextRunId(taskId);
      const effective = resolveEffectiveLaunch({
        role: reviewer,
        purpose: "review",
        workspace: round.workspace,
        reviewRoundId: round.id,
        reviewBaseCommit: round.reviewBaseCommit
      });
      const snapshot = freezeRunContextSnapshot(tx, {
        taskId,
        roleName: reviewer.name,
        purpose: "review",
        ...(item === undefined ? {} : { workItemId: item.id }),
        reviewRoundId: round.id
      }, now, "controller");
      const created = createRun(
        runId,
        taskId,
        reviewer.name,
        roleAgentSessionResumeMode(
          tx.getTaskRoleSessionSet(taskId, reviewer.name),
          effective.agentId,
          effective
        ),
        createRunInput({
          source: {
            type: "yui",
            channel: item === undefined ? "task-dispatch" : "workitem-dispatch"
          },
          directive: rawInput,
          contextSnapshotRef: contextSnapshotRef(snapshot),
          deltaRefIds: contextSnapshotDeltaRefIds(tx, snapshot)
        }),
        now,
        {
          ...(item === undefined ? {} : { workItemId: item.id }),
          purpose: "review",
          reviewRoundId: round.id,
          workspace: round.workspace,
          effective
        }
      );
      tx.saveRun(created);
      tx.saveReviewRound(taskId, startReviewRound(round, created.id));
      tx.saveActiveRun(created);
      enqueueRoleRunDispatch(tx, {
        taskId,
        roleName: reviewer.name,
        runId: created.id,
        reason: "review-requested",
        occurredAt: now
      });
      recordTaskEvent(tx, taskId, "run.review-dispatched", runLaunchEventPayload(created), now);
      createdRuns.push(created);
      return createdRuns;
    }

    let runningGroup = round.executionGroup;
    const dispatchLanes = runningGroup.lanes.filter((lane) => {
      if (lane.disposition !== "open") return false;
      if (lane.currentRunId === undefined) return true;
      return tx.getRun(taskId, lane.currentRunId)?.status === "failed";
    });
    const preparedLaneWorkspaces = requireIsolatedReviewLaneWorkspaces(
      tx,
      round,
      dispatchLanes,
      options.executionLaneWorkspaces
    );
    for (const lane of dispatchLanes) {
      const laneReviewer = tx.getRole(taskId, lane.roleName);
      if (laneReviewer === null) {
        throw usageError(`Review Producer Role not found: ${taskId}/${lane.roleName}.`);
      }
      if (tx.getActiveRun(taskId, lane.roleName) !== null) {
        throw usageError(`Review Producer Role already has an active AgentRun: ${lane.roleName}.`);
      }
      const laneManagedWorkspace = preparedLaneWorkspaces.get(lane.id)!;
      const effective = lane.effective ?? resolveEffectiveLaunch({
        role: laneReviewer,
        purpose: "review",
        workspace: laneManagedWorkspace,
        reviewRoundId: round.id,
        reviewBaseCommit: round.reviewBaseCommit
      });
      const runId = tx.nextRunId(taskId);
      const input = createRunInput({
        source: {
          type: "yui",
          channel: item === undefined ? "task-dispatch" : "workitem-dispatch"
        },
        directive: [
          rawInput,
          "",
          "You are a non-authoritative Review Producer.",
          "Return one complete original result in clear Markdown or JSON for the main Reviewer to read.",
          "Recommended sections are conclusion, findings, verification, uncertainty, and next action; Yui does not parse or validate them.",
          "Do not create a Candidate, ChangeSet, integration, or any acceptance decision.",
          JSON.stringify({
            schemaVersion: 1,
            executionGroupId: runningGroup.id,
            executionLaneId: lane.id,
            assignment: runningGroup.assignment
          }, null, 2)
        ].join("\n"),
        deltaRefIds: []
      });
      runningGroup = updateUnifiedExecutionLane(runningGroup, lane.id, {
        currentRunId: runId,
        effective,
        workspace: {
          root: laneManagedWorkspace.root,
          writableProjectIds: laneManagedWorkspace.entries
            .filter(({ access }) => access === "write")
            .map(({ projectId }) => projectId)
        }
      }, now);
      createdRuns.push(createRun(
        runId,
        taskId,
        laneReviewer.name,
        roleAgentSessionResumeMode(
          tx.getTaskRoleSessionSet(taskId, laneReviewer.name),
          effective.agentId,
          effective
        ),
        input,
        now,
        {
          ...(item === undefined ? {} : { workItemId: item.id }),
          purpose: "review",
          reviewRoundId: round.id,
          executionGroupId: runningGroup.id,
          executionLaneId: lane.id,
          workspace: laneManagedWorkspace,
          effective
        }
      ));
    }
    const roundWithGroup = updateReviewExecutionGroup(round, runningGroup);
    const persistedRound = round.status === "pending"
      ? startReplicatedReviewRound(roundWithGroup)
      : roundWithGroup;
    tx.saveReviewRound(taskId, persistedRound);
    for (const lane of runningGroup.lanes) {
      const prepared = preparedLaneWorkspaces.get(lane.id);
      if (prepared !== undefined) {
        if (tx.getManagedWorkspace(prepared.owner) === null) tx.saveManagedWorkspace(prepared);
      }
    }
    for (let index = 0; index < createdRuns.length; index += 1) {
      const unboundRun = createdRuns[index]!;
      const snapshot = freezeRunContextSnapshot(tx, {
        taskId,
        roleName: unboundRun.roleName,
        purpose: "review",
        ...(item === undefined ? {} : { workItemId: item.id }),
        reviewRoundId: round.id
      }, now, "controller", runningGroup.assignment.contextSnapshotRef);
      const created = withRunContextSnapshot(
        unboundRun,
        contextSnapshotRef(snapshot),
        contextSnapshotDeltaRefIds(tx, snapshot)
      );
      createdRuns[index] = created;
      const laneReviewer = requireRole(tx, taskId, unboundRun.roleName);
      tx.saveRun(created);
      tx.saveActiveRun(created);
      enqueueRoleRunDispatch(tx, {
        taskId,
        roleName: laneReviewer.name,
        runId: created.id,
        reason: "review-requested",
        occurredAt: now
      });
      recordTaskEvent(tx, taskId, "run.review-dispatched", runLaunchEventPayload(created), now);
    }
    return createdRuns;
  });
  for (const run of runs) {
    notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName));
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
    const terminal = finishReviewRound(
      round,
      "failed",
      now,
      { kind: "dispatch", message: summary }
    );
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
  notifyMailbox(options.runtime, leaderMailbox(taskId));
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

/**
 * Parse `--artifact-ref git:<commit>:<relativePath>` selectors into canonical
 * commit-pinned references for the given Task. This is a PURE shape check with
 * no Git or DB I/O: the commit self-certifies the frozen bytes, so a valid
 * pinned reference is complete evidence. The bytes are proven to exist lazily
 * when they are resolved on the async read/context path.
 */
function fixedArtifactRefs(taskId: string, refs: readonly string[]): readonly GitArtifactRef[] {
  if (new Set(refs).size !== refs.length) throw usageError("Artifact references must be unique.");
  return refs.map((ref) => {
    if (!isGitArtifactRefString(ref)) {
      throw usageError("Artifact reference must be a commit-pinned git:<commit>:<relativePath> reference.");
    }
    try { return parseGitArtifactRef(ref, taskId); }
    catch (error) { throw usageError(`Artifact reference is invalid: ${messageOf(error)}`); }
  });
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
  const workspace = task.status === "draft"
    ? planningRuntimeCwd(store.rootDirectory(), task.id)
    : task.cwd ?? store.getConfig().defaultWorkspace ?? process.cwd();
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
  const binding = createRoleAgentBinding(agent);
  return createRole(task.id, roleName, [binding], agent.id, workspace, now);
}

function requireAgentProfile(store: TaskWorkflowStore, id: string): AgentProfile {
  const profile = store.getAgentProfile(id);
  if (profile === null) throw usageError(`Agent Profile not found: ${id}.`);
  return profile;
}

function createTaskRoleFromAgentBinding(
  store: TaskWorkflowStore,
  task: Task,
  roleName: string,
  binding: RoleAgentBinding,
  now: Date
): Role {
  const workspace = task.status === "draft"
    ? planningRuntimeCwd(store.rootDirectory(), task.id)
    : task.cwd ?? store.getConfig().defaultWorkspace ?? process.cwd();
  return createRole(
    task.id,
    roleName,
    [binding],
    binding.agentId,
    workspace,
    now
  );
}

function resolvedAgentProfileRuntime(
  profile: AgentProfile,
  store: TaskWorkflowStore
): Extract<ResolvedAgentProfileRuntime, { status: "resolved" }> {
  try {
    return requireResolvedAgentProfileRuntime(profile, store);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

type TaskRoleAgentBindingUpdate = Readonly<{
  agentId: string;
  binding: RoleAgentBinding;
}>;

function resolveTaskRoleAgentBindingAdd(
  parsed: ParsedRoleOptions,
  profile: AgentProfile | undefined,
  store: TaskWorkflowStore
): TaskRoleAgentBindingUpdate | undefined {
  const explicitAgentId = parsed.one("--agent")?.trim();
  let binding: RoleAgentBinding;
  if (profile !== undefined) {
    const profileRuntime = resolvedAgentProfileRuntime(profile, store);
    if (explicitAgentId !== undefined
      && profileRuntime.binding.agentId !== explicitAgentId) {
      throw usageError(
        `Agent Profile ${profile.id} resolves to Agent ${profileRuntime.binding.agentId}, `
        + `but Task Role creation targets --agent ${explicitAgentId}. Use --agent `
        + `${profileRuntime.binding.agentId}, or omit --profile to create an explicit binding.`
      );
    }
    binding = profileRuntime.binding;
  } else {
    if (explicitAgentId === undefined) return undefined;
    const agent = requireAgent(store, explicitAgentId);
    binding = createRoleAgentBinding(agent);
  }
  if (hasAgentConfigOptions(parsed)) {
    binding = patchRoleAgentBinding(binding, parsed);
  }
  return { agentId: binding.agentId, binding };
}

function resolveTaskRoleAgentBindingUpdate(
  parsed: ParsedRoleOptions,
  role: Role,
  profile: AgentProfile | undefined,
  store: TaskWorkflowStore
): TaskRoleAgentBindingUpdate | undefined {
  const changesAgentConfig = hasAgentConfigOptions(parsed);
  const explicitAgentId = parsed.one("--agent")?.trim();
  const targetAgentId = explicitAgentId || role.activeAgentId;

  let binding: RoleAgentBinding;
  if (profile !== undefined) {
    const profileRuntime = resolvedAgentProfileRuntime(profile, store);
    if (profileRuntime.binding.agentId !== targetAgentId) {
      const target = explicitAgentId === undefined
        ? `active Agent ${role.activeAgentId}`
        : `--agent ${explicitAgentId}`;
      throw usageError(
        `Agent Profile ${profile.id} resolves to Agent ${profileRuntime.binding.agentId}, `
        + `but Task Role update targets ${target}. Use --agent ${profileRuntime.binding.agentId} `
        + "to update that binding, or task role bind to activate it."
      );
    }
    binding = profileRuntime.binding;
  } else {
    if (!changesAgentConfig) return undefined;
    const agent = requireAgent(store, targetAgentId);
    binding = role.agentBindings[targetAgentId]
      ?? createRoleAgentBinding(agent);
  }
  if (changesAgentConfig) {
    binding = patchRoleAgentBinding(binding, parsed);
  }
  return { agentId: targetAgentId, binding };
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

function applyWorkerAgentProfileBehavior(
  role: Role,
  profile: AgentProfile,
  now: Date
): Role {
  return updateRole(role, workerProfileRolePatch(profile), now);
}

function validateTaskRoleAgentBinding(
  role: Role,
  agentId: string,
  options: TaskCommandOptions
): void {
  const binding = role.agentBindings[agentId];
  if (binding === undefined) throw usageError(`Role Agent is not bound: ${agentId}.`);
  options.validateAgentConfiguration?.({
    agentId,
    config: binding.config,
    cwd: role.workspace
  });
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

/** Keeps a free-text AgentRun-fact note bounded so an event payload stays compact. */
function truncateEventNote(note: string): string {
  const normalized = note.trim();
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 279)}…`;
}

function runLaunchEventPayload(run: AgentRun): TaskEventPayload {
  return {
    runId: run.id,
    role: run.roleName,
    purpose: run.purpose,
    mode: run.mode,
    agent: `${run.effective.agentId}/${run.effective.adapterId}`,
    component: run.effective.component,
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
    "run",
    "AgentRun reference",
    options
  );
  const run = store.getRun(reference.taskId, reference.localId);
  if (run === null) {
    throw usageError(`AgentRun not found: ${reference.taskId}/${reference.localId}.`);
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
    : store.getActiveRun(run.taskId, run.roleName);
}


function taskRecordReference(
  value: string | undefined,
  kind: "workItem" | "run" | "reviewRound" | "message",
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

function chronologicalRuns(runs: readonly AgentRun[]): AgentRun[] {
  return [...runs].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
  ));
}

function isTerminalWorkItemStatus(status: WorkItemStatus): boolean {
  return ["accepted", "retired"].includes(status);
}

function assertTaskExecutionEnabled(task: Task, action: string): void {
  if (task.executionGate.state === "enabled") return;
  throw usageError(
    `Task execution is stopped: ${task.id}. Run "yui task execution start ${task.id}" before ${action}.`
  );
}

function inactiveTaskMessage(task: Task, action: string): string {
  if (task.status === "draft") {
    return `Task ${task.id} is a Draft; activate it before ${action}.`;
  }
  if (task.status === "completed") {
    return `Task ${task.id} is completed; reopen it before ${action}.`;
  }
  if (task.status === "cancelled") return `Task ${task.id} is retired; it cannot resume ${action}.`;
  return `Task is archived: ${task.id}.`;
}

function requireRuntime(options: TaskCommandOptions): TaskWorkflowRuntimePort {
  if (options.runtime === undefined) throw runtimeError("Task workflow runtime is not configured.");
  return options.runtime;
}

function parseWorkStatus(value: string): "pending" | "running" | "completed" | "failed" {
  if (value === "todo") return "pending";
  if (value === "running") return "running";
  if (value === "done") return "completed";
  if (value === "failed") return "failed";
  throw usageError(`Invalid work item status: ${value}.`);
}

function presentWorkStatus(status: WorkItemStatus): string {
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

/** Persist only edited fields, not another copy of aggregate execution history.
 * Null records an absent optional field so clearing it remains observable. */
function editedFieldValues(record: object, fields: readonly string[]): string {
  const values = record as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field, values[field] ?? null])));
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
        entry.continuationId === identity.continuationId && entry.reportId === report.reportId
      ));
    return Object.freeze({
      continuationId: identity.continuationId,
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
  reportId: string;
}>[] {
  const result: {
    event: TaskEvent;
    continuationId: string;
    reportId: string;
  }[] = [];
  for (const event of events) {
    const observation = runtimeObservationFromTaskEvent(event);
    if (observation !== null && observation.kind === "continuation.reported") {
      const continuationId = observation.fence.continuationId;
      const reportId = observation.payload?.reportId;
      if (continuationId !== undefined && reportId !== undefined) {
        result.push({ event, continuationId, reportId });
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
  if (subcommand === "resolve") {
    const usage = "Task wake resolve usage: yui task wake resolve <task> <wake> --reason <quiescence-evidence>.";
    const parsed = parseTail(args.slice(1), new Set(["--reason"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const reason = requiredOption(parsed.options, "--reason");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      taskActor(tx, options, task.id);
      const wakeId = parsed.positionals[1];
      const wake = tx.getTaskWake(task.id, wakeId);
      if (wake === null) throw usageError("Wake is unavailable.");
      const target = leaderMailbox(task.id);
      const mailbox = tx.getWorkMailbox(target);
      const claim = mailbox?.processing;
      if (claim === undefined || claim === null || claim.owner !== `leader-notification:${wake.id}`) {
        throw usageError("This wake has no unresolved notification claim.");
      }
      const previous = tx.listEvents(task.id).filter((event) =>
        event.type === "notification.delivery" && event.payload.attemptId === claim.batchId).at(-1);
      const sessions = tx.getTaskRoleSessionSet(task.id, "leader");
      const provider = sessions?.providerBinding;
      if (previous?.payload.outcome !== "unknown") throw usageError("Only an unknown notification can be resolved.");
      if (tx.getActiveRun(task.id, "leader") !== null
        || provider?.authority.owner === "human" || provider?.authority.owner === "unknown"
        || (provider?.run !== undefined && provider.run !== null
          && ["submitting", "accepted", "delivery-unknown"].includes(provider.run.status))) {
        throw usageError("Shared native execution is not proven quiescent; resolve that exact runtime boundary first.");
      }
      // Preserve the original unknown outcome and the unconsumed fixed wake.
      // This releases only the scheduling claim; it never replays, claims
      // acceptance, or asserts that Message requirements were implemented.
      recordTaskEvent(tx, task.id, "notification.resolved", {
        wakeId: wake.id, attemptId: claim.batchId, reason, outcome: "released-without-replay"
      }, now);
      tx.saveWorkMailbox(completeProcessing(mailbox!, claim.batchId));
      return { taskId: task.id, wakeId: wake.id, outcome: "released-without-replay" };
    });
    notifyMailbox(options.runtime, leaderMailbox(result.taskId));
    return output(`Released ${result.wakeId} without replay; original acceptance remains unknown.\n`, result);
  }
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
        { header: "Dispatched", minWidth: 10, maxWidth: 28 }
      ],
      wakes.map((wake) => [
        wake.id,
        wake.status,
        wake.reasons.map(renderWakeReason).join(", "),
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
    const allEvents = store.listEvents(task.id);
    const deliveryEvents = allEvents.filter((event) =>
      (event.type === "notification.delivery" || event.type === "notification.resolved")
      && (event.payload.wakeId === wake.id
        || event.payload.attemptId?.startsWith(`notification:${task.id}/${wake.id}/`)));
    const referenced = (type: MailboxEntityRef["type"], id: string) =>
      wake.refs?.some(ref => ref.type === type && ref.id === id
        && (!("taskId" in ref) || ref.taskId === task.id)) === true;
    const events = allEvents.filter((e) => inWindow(e.createdAt) || referenced("event", e.id));
    const messages = store.listMessages(task.id).filter((m) => inWindow(m.createdAt) || referenced("message", m.id));
    const allRuns = store.listRuns(task.id);
    const referencedRunIds = new Set(referencedWakeRunIds(allRuns, allEvents, events));
    for (const run of allRuns) if (referenced("run", run.id)) referencedRunIds.add(run.id);
    for (const message of messages) if (message.resultRef?.type === "agent-run-result") referencedRunIds.add(message.resultRef.runId);
    const runs = operationalTaskRecords(allRuns, allEvents, "run").filter((run) => (
      inWindow(run.createdAt) || referencedRunIds.has(run.id)
    ));
    const lines: string[] = [
      `Wake: ${wake.id}`,
      `Task: ${task.id}`,
      `Status: ${wake.status}`,
      `Notification: ${deliveryEvents.at(-1)?.payload.outcome ?? "unobserved"}`,
      `Reasons: ${wake.reasons.map(renderWakeReason).join(", ")}`,
      `Delta window: ${wake.fromCursor} → ${wake.toCursor}`,
      `Dispatched: ${presentTime(wake.createdAt, timeZone)}`,
      ...(wake.consumedAt === undefined
        ? []
        : [`Consumed: ${presentTime(wake.consumedAt, timeZone)}`]),
      `Events (${events.length}):`,
      ...events.map((e) => `  ${e.id} ${e.type} ${presentTime(e.createdAt, timeZone)}`),
      `Messages (${messages.length}):`,
      ...messages.map((m) => `  ${m.id} [${taskMessageAuthorLabel(m.author)}] ${presentTime(m.createdAt, timeZone)}`),
      `AgentRuns (${runs.length}):`,
      ...runs.map((run) => (
        `  ${run.id} [${run.status}/${run.purpose}] ${run.roleName} `
        + `${presentTime(run.createdAt, timeZone)}`
        + `${referencedRunIds.has(run.id)
          ? ` → yui task run show ${task.id}/${run.id}`
          : ""}`
      ))
    ];
    return output(lines.join("\n").concat("\n"), {
      taskId: task.id,
      deliveryEvents,
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


function titleFrom(body: string): string {
  const oneLine = requiredText(body, "Message body").replace(/\s+/g, " ");
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
