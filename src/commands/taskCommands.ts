import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createTaskComment } from "../comment/comment.js";
import { createTaskBrief, renderTaskBrief } from "../brief/taskBrief.js";
import { CYCLE_CAUSES, createCycle, endCycle, type CycleCause } from "../cycle/cycle.js";
import { createDecision, renderDecisionTimelineEntry, supersedeDecision } from "../decision/decision.js";
import { compileDispatchInput } from "../context/dispatchContext.js";
import { roleConflict, roleNotFound, runtimeError, taskNotFound, usageError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { createTaskInputDraft } from "../input/taskInput.js";
import { createMilestone, renderMilestoneTimelineEntry } from "../milestone/milestone.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession,
  sameNativeSessionIdentity,
  updateRoleAgentSessionStatus,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { resolveAgentAdapter } from "../executor/agentAdapter.js";
import {
  isCanonicalNativeSessionId,
  isCanonicalNativeSessionRoot
} from "../executor/nativeSessionIdentity.js";
import {
  claimRoleRuntimeOperation,
  claimRuntimeOperationRecovery,
  clearRoleRuntimeOperationClaim,
  clearRuntimeOperationClaim,
  createRoleRuntimeOperationLease,
  executePostCommitRoleDispatch,
  executeReplayableRoleRuntimeOperation,
  isRuntimeOperationRecoverable,
  markRoleRuntimeOperationEffectStarted,
  markTaskLifecycleOperationEffectStarted,
  permissionEnvelopeForBinding,
  listRuntimeOperationClaims,
  readRoleRuntimeOperationClaim,
  readTaskRuntimeOperationClaim,
  readRoleRuntimeStateSnapshot,
  recoverAbandonedRoleRuntimeOperations,
  releaseRoleRuntimeOperationClaim,
  releaseRuntimeOperationClaim,
  reserveInitialAgentSession,
  resolveAgentExecutor,
  resolveAgentLaunchEnvironment,
  resolveAgentSessionRoot,
  roleRuntimeStateDigest,
  type RoleLaunchRuntimeOperationClaim,
  type RoleRuntimeOperationClaim,
  type RoleStopRuntimeOperationClaim,
  type TaskLifecycleEffectPlan,
  type TaskLifecyclePreparedState,
  type TaskLifecycleRuntimeOperationClaim
} from "../executor/executorRegistry.js";
import type { DispatchMode } from "../executor/launchPlan.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { activeRoleAgentBinding, copyGlobalRoleToTaskRole, createRole, createRoleAgentBinding, switchActiveRoleAgent, updateRole, updateRoleStatus } from "../role/role.js";
import { createChildRole } from "../role/childRole.js";
import { createAgentRun, failAgentRun, yieldAgentRun } from "../run/agentRun.js";
import { SYSTEM_LEADER_ROLE } from "../role/systemRoles.js";
import { resolveAgent, supportedAgentIds } from "../agent/agentRegistry.js";
import { mergePendingWakeup } from "../scheduler/pendingWakeup.js";
import { leaderRecoveryNotificationId } from "../scheduler/operatorNotification.js";
import { createTaskSchedule } from "../scheduler/taskSchedule.js";
import { createTask, updateTaskArchived, updateTaskMetadata } from "../task/task.js";
import { BUILTIN_TOPICS, createCustomTopic, usesConventionalTopicId } from "../topic/topic.js";
import { createWorkItem, updateWorkItemStatus, type WorkItem, type WorkItemStatus } from "../workItem/workItem.js";
import type { RoleWorktree } from "../worktree/worktree.js";
import { GitWorktreeManager } from "../worktree/gitWorktreeManager.js";
import type { TaskComment } from "../comment/comment.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { Role } from "../role/role.js";
import type { RoleAgentSession } from "../executor/agentExecutor.js";
import type { ChildRole } from "../role/childRole.js";
import type { AgentRun } from "../run/agentRun.js";
import { FileTaskStore, type TaskReader, type TaskStore } from "../storage/taskStore.js";
import { resolveTaskmuxHome } from "../storage/taskStore.js";
import {
  executeDomainTransaction,
  hasActiveDomainTransactionAuthority
} from "../storage/domainTransaction.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import {
  assertPathOutsideTaskmuxHome,
  canonicalProspectivePath
} from "../storage/storagePathBoundary.js";
import { lowerUnknownInertData, stringifyCanonicalInertData } from "../storage/inertData.js";
import type { Task, TaskMetadata, TaskPriority } from "../task/task.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import {
  ROLE_EXPECT_UPDATED_AT_OPTION,
  ROLE_PROFILE_INHERITABLE_FIELDS
} from "../cli/roleOptionCatalog.js";
import { parseRoleCommandOptions, type ParsedRoleCommandOptions } from "./roleAgentOptions.js";
import type { ManualSessionRegistration } from "./sessionRegistration.js";

const BUILTIN_LEADER_ROLE = SYSTEM_LEADER_ROLE;

function transactionTaskStore(
  workingRoot: string,
  runtimeOperationToken?: string,
  runtimeRecoveryToken?: string
): FileTaskStore {
  if (!hasActiveDomainTransactionAuthority(workingRoot)) {
    throw runtimeError("Task storage mutation requires an active domain transaction.");
  }
  return FileTaskStore.forDomainTransactionWorkspace(
    workingRoot,
    runtimeOperationToken,
    runtimeRecoveryToken
  );
}

const STORAGE_ONLY_TASK_COMMANDS = new Set([
  "create", "show", "current", "clone", "update", "unarchive", "open", "context", "restore",
  "assign", "bind", "assign-many", "comment", "topic", "input", "cycle", "work-item", "wake",
  "yield", "schedule", "brief", "milestone", "decision", "session", "status", "refresh", "cleanup"
]);

function taskCommandUsesStorageTransaction(args: readonly string[]): boolean {
  const command = args[0] ?? "";
  return STORAGE_ONLY_TASK_COMMANDS.has(command) ||
    (command === "role" && ["child", "update"].includes(args[1] ?? ""));
}

export function taskCommandHasExternalMutation(args: readonly string[]): boolean {
  const command = args[0] ?? "";
  if (["archive", "delete", "detach", "worktree"].includes(command)) {
    return true;
  }
  return command === "role" && ["rename", "remove"].includes(args[1] ?? "");
}

export function isTaskRoleRuntimeControlCommand(args: readonly string[]): boolean {
  return ["stop", "kill", "restart"].includes(args[0] ?? "");
}

const TASK_ASSIGN_OPTIONS = [
  { option: "--agent" },
  { option: "--workspace" },
  { option: "--as" },
  { option: "--system-prompt" }
] as const;

const TASK_BIND_OPTIONS = [
  { option: "--workspace" },
  { option: "--as" }
] as const;

const TASK_ASSIGN_MANY_OPTIONS = [
  { option: "--role", repeatable: true },
  { option: "--agent" },
  { option: "--workspace" },
  { option: "--system-prompt" }
] as const;

const TASK_ROLE_UPDATE_OPTIONS = [
  { option: ROLE_EXPECT_UPDATED_AT_OPTION },
  { option: "--agent" },
  { option: "--active-agent" },
  { option: "--workspace" },
  { option: "--system-prompt" }
] as const;

export function runTaskCommand(
  args: string[],
  store: TaskStore,
  tmux?: TmuxManager,
  options: {
    persistAttachStatus?: boolean;
    rememberTaskReads?: boolean;
    environment?: NodeJS.ProcessEnv;
    sessionRegistration?: ManualSessionRegistration;
    requireManualSessionRegistration?: boolean;
    onRoleLaunchStarted?: (session: RoleAgentSession | null) => void;
  } = {}
): string {
  if (taskCommandIsReadOnlyAggregate(args)) {
    const output = store.runReadSnapshot((snapshot) => runTaskReadSnapshot(args, snapshot));
    if (options.rememberTaskReads !== false && ["show", "open", "context"].includes(args[0] ?? "")) {
      rememberTask(store, args[1] ?? "");
    }
    return output;
  }

  const [command, ...rest] = args;
  if (
    store instanceof FileTaskStore &&
    hasActiveDomainTransactionAuthority(store.rootDirectory()) &&
    taskCommandHasExternalMutation(args)
  ) {
    throw runtimeError("Task lifecycle effects must run through a post-commit coordinator.");
  }
  if (
    store instanceof FileTaskStore &&
    !hasActiveDomainTransactionAuthority(store.rootDirectory()) &&
    command !== undefined &&
    taskCommandUsesStorageTransaction(args)
  ) {
    return executeDomainTransaction(store.rootDirectory(), `task-command-${randomUUID()}`, (workingRoot) => runTaskCommand(
      args,
      transactionTaskStore(workingRoot),
      tmux,
      options
    ));
  }
  assertTaskCommandRuntimeAuthority(command, rest, store);

  switch (command) {
    case "create":
      return createTaskCommand(rest, store);
    case "list":
      return listTaskCommand(rest, store);
    case "board":
      return boardTaskCommand(rest, store);
    case "show":
      return showTaskCommand(rest, store, options.rememberTaskReads !== false);
    case "current":
      return currentTaskCommand(rest, store);
    case "last":
      return lastTaskCommand(store);
    case "clone":
      return cloneTaskCommand(rest, store);
    case "update":
      return updateTaskCommand(rest, store);
    case "archive":
      return updateTaskArchivedCommand(rest, store, true, tmux);
    case "unarchive":
      return updateTaskArchivedCommand(rest, store, false);
    case "open":
      return openTaskCommand(rest, store, options.rememberTaskReads !== false);
    case "context":
      return contextTaskCommand(rest, store, options.rememberTaskReads !== false);
    case "delete":
      return deleteTaskCommand(rest, store, tmux);
    case "restore":
      return restoreTaskCommand(rest, store);
    case "role":
      return taskRoleCommand(rest, store, tmux);
    case "assign":
      return assignTaskRoleCommand(rest, store);
    case "bind":
      return bindTaskRoleCommand(rest, store);
    case "assign-many":
      return assignManyTaskRolesCommand(rest, store);
    case "roles":
      return listTaskRolesCommand(rest, store);
    case "enter":
      return enterTaskRoleCommand(
        rest,
        store,
        tmux,
        options.persistAttachStatus !== false,
        options.onRoleLaunchStarted
      );
    case "tail":
      return tailTaskRoleCommand(rest, store, tmux);
    case "detail":
      return detailTaskRoleCommand(rest, store);
    case "status":
      return statusTaskRoleCommand(rest, store, tmux);
    case "refresh":
      return refreshTaskRolesCommand(rest, store, tmux, "Refreshed");
    case "transcript":
      return transcriptTaskRoleCommand(rest, store, tmux);
    case "detach":
      return detachTaskRoleCommand(rest, store, tmux);
    case "stop":
      return stopTaskRoleCommand(rest, store, tmux);
    case "kill":
      return killTaskRoleCommand(rest, store, tmux);
    case "restart":
      return restartTaskRoleCommand(rest, store, tmux);
    case "cleanup":
      return refreshTaskRolesCommand(rest, store, tmux, "Cleaned");
    case "comment":
      return addTaskCommentCommand(rest, store);
    case "comments":
      return listTaskCommentsCommand(rest, store);
    case "events":
      return listTaskEventsCommand(rest, store);
    case "activity":
      return taskActivityCommand(rest, store);
    case "timeline":
      return taskTimelineCommand(rest, store);
    case "topic":
      return taskTopicCommand(rest, store);
    case "input":
      return taskInputCommand(rest, store);
    case "cycle":
      return taskCycleCommand(rest, store);
    case "work-item":
      return taskWorkItemCommand(rest, store);
    case "wake":
      return wakeTaskCommand(rest, store);
    case "session":
      return taskSessionCommand(
        rest,
        store,
        options.environment ?? process.env,
        tmux,
        options.sessionRegistration,
        options.requireManualSessionRegistration === true
      );
    case "dispatch":
      return dispatchTaskRoleCommand(rest, store, tmux);
    case "yield":
      return yieldTaskRoleCommand(rest, store);
    case "schedule":
      return taskScheduleCommand(rest, store);
    case "brief":
      return taskBriefCommand(rest, store);
    case "milestone":
      return taskMilestoneCommand(rest, store);
    case "decision":
      return taskDecisionCommand(rest, store);
    case "worktree":
      return taskWorktreeCommand(rest, store, tmux);
    default:
      throw usageError(command === undefined ? "Task command is required." : `Unknown command: task ${command}`);
  }
}

export function runTaskReadSnapshot(args: string[], store: TaskReader): string {
  const [command, ...rest] = args;
  switch (command) {
    case "list":
      return listTaskCommand(rest, store);
    case "board":
      return boardTaskCommand(rest, store);
    case "show":
      return showTaskSnapshot(rest, store);
    case "open":
      return openTaskSnapshot(rest, store);
    case "context":
      return contextTaskSnapshot(rest, store);
    case "current":
      return renderTaskPointer("Current task", store.getConfig().currentTaskId, store);
    case "last":
      return lastTaskCommand(store);
    case "roles":
      return listTaskRolesCommand(rest, store);
    case "detail":
      return detailTaskRoleCommand(rest, store);
    case "comments":
      return listTaskCommentsCommand(rest, store);
    case "events":
      return listTaskEventsCommand(rest, store);
    case "activity":
      return taskActivityCommand(rest, store);
    case "timeline":
      return taskTimelineCommand(rest, store);
    case "topic":
      return listTaskTopicsCommand(rest, store);
    default:
      throw usageError(`Task command is not a read-only aggregate: ${command ?? "(missing)"}.`);
  }
}

function taskCommandIsReadOnlyAggregate(args: readonly string[]): boolean {
  const command = args[0] ?? "";
  return [
    "list", "board", "show", "open", "context", "last", "roles",
    "detail", "comments", "events", "activity", "timeline"
  ].includes(command) ||
    (command === "current" && args.length === 1) ||
    (command === "topic" && args[1] === "list");
}

function taskWorktreeCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  return runTaskLifecycleOperation(prepareTaskWorktreeOperation(args, store), store, tmux);
}

function prepareTaskWorktreeOperation(
  args: string[],
  store: TaskStore
): TaskLifecycleRuntimeOperationClaim {
  const [command, taskId, roleName, ...rest] = args;
  if (!["create", "remove"].includes(command ?? "") || taskId === undefined || roleName === undefined) {
    throw usageError("Worktree usage: taskmux task worktree create <task-id> <role> --path <path> --branch <branch> [--base <ref>] | taskmux task worktree remove <task-id> <role>.");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }
  if (roleName === BUILTIN_LEADER_ROLE) {
    throw usageError("The Leader owns the primary workspace and does not use a TaskMux worktree.");
  }

  const role = store.getRole(taskId, roleName);
  if (role === null) throw roleNotFound(roleName);
  if (store.getActiveAgentRun(taskId, roleName) !== null) {
    throw usageError(`Role has an active AgentRun: ${taskId}/${roleName}.`);
  }
  const existing = store.getRoleWorktree(taskId, roleName);
  if (command === "remove") {
    if (rest.length > 0) throw usageError("Worktree remove accepts only a task id and role.");
    if (existing === null) throw usageError(`Role has no managed worktree: ${taskId}/${roleName}.`);
    return prepareTaskLifecycleOperation("worktree-remove", taskId, store, {
      targetRoleName: roleName,
      worktreeRequest: { roleName, path: null, branch: null, base: null }
    });
  }
  if (existing !== null) throw usageError(`Role already has a managed worktree: ${taskId}/${roleName}.`);
  assertKnownOptions(rest, new Set(["--path", "--branch", "--base"]));
  const path = readOption(rest, "--path").trim();
  const branch = readOption(rest, "--branch").trim();
  const base = readOptionalOption(rest, "--base")?.trim() ?? null;
  return prepareTaskLifecycleOperation("worktree-create", taskId, store, {
    targetRoleName: roleName,
    worktreeRequest: { roleName, path, branch, base }
  });
}

function taskBriefCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;
  if (command !== "update" || taskId === undefined) {
    throw usageError("Brief usage: taskmux task brief update <task-id> --objective <body> [--boundary <body> ...] --focus <body> --leader-summary <body>.");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const brief = createTaskBrief({
    objective: readOption(rest, "--objective"),
    boundaries: readRepeatedOption(rest, "--boundary"),
    currentFocus: readOption(rest, "--focus"),
    leaderSummary: readOption(rest, "--leader-summary")
  }, new Date());
  store.saveTaskBrief(taskId, renderTaskBrief(brief));
  recordTaskEvent(store, taskId, "task.brief_updated", {});
  return `Updated brief for task ${taskId}\n`;
}

function taskMilestoneCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;
  if (command !== "add" || taskId === undefined) {
    throw usageError("Milestone usage: taskmux task milestone add <task-id> --title <title> --summary <body> [--topic <topic> ...].");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const topics = readRepeatedOption(rest, "--topic").map((topic) => topic.trim());
  const knownTopics = new Set([
    ...BUILTIN_TOPICS.map(({ id }) => id),
    ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
  ]);
  const unknownTopic = topics.find((topic) => !knownTopics.has(topic));
  if (unknownTopic !== undefined) {
    throw usageError(`Topic not found: ${unknownTopic}.`);
  }

  const milestone = createMilestone(
    store.nextMilestoneId(taskId),
    taskId,
    readOption(rest, "--title"),
    readOption(rest, "--summary"),
    topics,
    new Date()
  );
  store.saveMilestone(taskId, milestone);
  store.appendTaskTimeline(taskId, renderMilestoneTimelineEntry(milestone));
  recordTaskEvent(store, taskId, "milestone.added", { milestone: milestone.id });
  return `Added milestone ${milestone.id} to task ${taskId}\n`;
}

function taskDecisionCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;
  if (taskId === undefined || store.getTask(taskId) === null) {
    if (taskId !== undefined) {
      throw taskNotFound(taskId);
    }
    throw usageError("Decision usage: taskmux task decision record|supersede <task-id> ...");
  }

  if (command === "record") {
    const topics = readRepeatedOption(rest, "--topic").map((topic) => topic.trim());
    const knownTopics = new Set([
      ...BUILTIN_TOPICS.map(({ id }) => id),
      ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
    ]);
    const unknownTopic = topics.find((topic) => !knownTopics.has(topic));
    if (unknownTopic !== undefined) {
      throw usageError(`Topic not found: ${unknownTopic}.`);
    }
    const decision = createDecision(
      store.nextDecisionId(taskId),
      taskId,
      readOption(rest, "--title"),
      readOption(rest, "--rationale"),
      topics,
      new Date()
    );
    store.saveDecision(taskId, decision);
    store.appendTaskTimeline(taskId, renderDecisionTimelineEntry(decision));
    recordTaskEvent(store, taskId, "decision.recorded", { decision: decision.id });
    return `Recorded decision ${decision.id} for task ${taskId}\n`;
  }

  if (command === "supersede") {
    const [decisionId, ...options] = rest;
    if (decisionId === undefined) {
      throw usageError("Decision id is required.");
    }
    const decision = store.getDecision(taskId, decisionId);
    if (decision === null) {
      throw usageError(`Decision not found: ${decisionId}.`);
    }
    const updated = supersedeDecision(decision, readOption(options, "--reason"), new Date());
    store.saveDecision(taskId, updated);
    recordTaskEvent(store, taskId, "decision.superseded", { decision: decision.id });
    return `Superseded decision ${decision.id} for task ${taskId}\n`;
  }

  throw usageError("Decision usage: taskmux task decision record|supersede <task-id> ...");
}

function taskScheduleCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;

  if (command !== "set" || taskId === undefined) {
    throw usageError("Schedule usage: taskmux task schedule set <task-id> --inactivity-minutes <minutes> --cooldown-minutes <minutes> [--review-at <iso>].");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const inactivityMinutes = Number(readOption(rest, "--inactivity-minutes"));
  const cooldownMinutes = Number(readOption(rest, "--cooldown-minutes"));
  const reviewAt = readOptionalOption(rest, "--review-at")?.trim();
  const everyMinutesValue = readOptionalOption(rest, "--every-minutes")?.trim();
  const nextAt = readOptionalOption(rest, "--next-at")?.trim();
  if ((everyMinutesValue === undefined) !== (nextAt === undefined)) {
    throw usageError("--every-minutes and --next-at must be provided together.");
  }
  const recurring = everyMinutesValue === undefined || nextAt === undefined
    ? undefined
    : { everyMinutes: Number(everyMinutesValue), nextAt };
  const schedule = createTaskSchedule(
    inactivityMinutes,
    cooldownMinutes,
    reviewAt,
    recurring,
    new Date()
  );
  store.saveTaskSchedule(taskId, schedule);
  recordTaskEvent(store, taskId, "task.schedule_updated", {});
  return `Updated schedule for task ${taskId}\n`;
}

function yieldTaskRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || roleName === undefined) {
    throw usageError("Yield usage: taskmux task yield <task-id> <role> --summary <summary>.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);
  if (role === null) {
    throw roleNotFound(roleName);
  }
  const activeRun = store.getActiveAgentRun(taskId, roleName);
  if (activeRun === null) {
    throw usageError(`No active agent run exists for ${taskId}/${roleName}.`);
  }

  const binding = activeRoleAgentBinding(role);
  if (
    binding.adapterId === "codex" &&
    store.getRoleSessionSet(taskId, roleName)?.sessions[role.activeAgentId] === undefined
  ) {
    throw usageError("Codex must register its native session identity before the AgentRun can yield.");
  }

  const run = yieldAgentRun(activeRun, readOption(rest, "--summary"), new Date());
  store.saveAgentRun(run);
  store.clearActiveAgentRun(taskId, roleName);
  store.saveRole(taskId, updateRoleStatus(role, "idle", new Date()));
  const sessionSet = store.getRoleSessionSet(taskId, roleName);
  if (sessionSet !== null && sessionSet.sessions[role.activeAgentId] !== undefined) {
    store.saveRoleSessionSet(updateRoleAgentSessionStatus(sessionSet, role.activeAgentId, "ready", new Date()));
  }
  if (run.workItemId !== undefined) {
    const workItem = store.getWorkItem(taskId, run.workItemId);
    if (workItem !== null && workItem.status === "running") {
      store.saveWorkItem(taskId, updateWorkItemStatus(workItem, "completed", run.summary, new Date()));
    }
  }
  recordTaskEvent(store, taskId, "agent-run.yielded", { run: run.id, role: roleName });
  if (roleName !== BUILTIN_LEADER_ROLE) {
    queueLeaderWakeup(store, taskId, "role-result");
  }

  return `Yielded ${run.id} from ${taskId}/${roleName}\n`;
}

export type PreparedTaskRoleDispatch = {
  taskId: string;
  role: Role;
  expectedStateDigest: string;
  run: AgentRun;
  workItem: WorkItem | null;
  expectedWorkItemUpdatedAt: string | null;
  sessionSet: TaskRoleSessionSet | null;
  session: RoleAgentSession | null;
  launch: import("../executor/launchPlan.js").AgentLaunchPlan;
  input: string;
  mode: DispatchMode;
};

function dispatchTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }
  const fileStore = store instanceof FileTaskStore ? store : null;
  if (fileStore !== null && hasActiveDomainTransactionAuthority(fileStore.rootDirectory())) {
    throw runtimeError("Role dispatch must run as a post-commit effect.");
  }
  if (fileStore !== null) {
    const rootDir = fileStore.rootDirectory();
    recoverTaskRoleRuntimeOperations(rootDir, tmux);
  }
  const prepared = prepareTaskRoleDispatch(args, store);
  const intent: RoleLaunchRuntimeOperationClaim | null = fileStore !== null ? {
    schemaVersion: 1 as const,
    scope: "task-role" as const,
    kind: "launch" as const,
    token: randomUUID(),
    taskId: prepared.taskId,
    roleName: prepared.role.name,
    operation: "dispatch" as const,
    ownerPid: process.pid,
    preparedSession: prepared.session,
    selectedWorkItem: prepared.workItem,
    pendingRun: {
      id: prepared.run.id,
      taskId: prepared.taskId,
      roleName: prepared.role.name
    },
    expectedStateDigest: prepared.expectedStateDigest,
    recoveryToken: null,
    ...createRoleRuntimeOperationLease()
  } : null;
  const intentHooks = fileStore === null || intent === null ? {} : {
    claim: () => claimRoleRuntimeOperation(
      fileStore.rootDirectory(),
      `task-dispatch-claim-${randomUUID()}`,
      intent,
      (workingRoot) => roleRuntimeStateDigest(readRoleRuntimeStateSnapshot(
        transactionTaskStore(workingRoot),
        intent.taskId,
        intent.roleName,
        {
          workItemId: intent.selectedWorkItem?.id,
          pendingRunId: intent.pendingRun?.id
        }
      ))
    ),
    release: () => releaseRoleRuntimeOperationClaim(
      fileStore.rootDirectory(),
      `task-dispatch-release-${randomUUID()}`,
      intent
    )
  };
  return executePostCommitRoleDispatch(tmux, {
    taskId: prepared.taskId,
    role: prepared.role,
    launch: prepared.launch,
    input: prepared.input,
    replaceExisting: prepared.mode === "new",
    launchToken: intent?.token ?? randomUUID()
  }, () => fileStore !== null && intent !== null
    ? executeDomainTransaction(fileStore.rootDirectory(), `task-dispatch-${randomUUID()}`, (workingRoot) => {
        const output = persistTaskRoleDispatch(
          prepared,
          transactionTaskStore(workingRoot, intent.token)
        );
        clearRoleRuntimeOperationClaim(
          workingRoot,
          intent.taskId,
          intent.roleName,
          intent.token
        );
        return output;
      })
    : persistTaskRoleDispatch(prepared, store), intentHooks);
}

export function prepareTaskRoleDispatch(args: string[], store: TaskStore): PreparedTaskRoleDispatch {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || roleName === undefined) {
    throw usageError("Dispatch usage: taskmux task dispatch <task-id> <role> --mode new|resume --input <input>.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);
  if (role === null) {
    throw roleNotFound(roleName);
  }

  if (roleName !== BUILTIN_LEADER_ROLE) {
    const leader = store.getRole(taskId, BUILTIN_LEADER_ROLE);
    const worktree = store.getRoleWorktree(taskId, roleName);
    if (leader !== null && existsSync(join(leader.workspace, ".git")) && worktree === null) {
      throw usageError(`Independent role ${roleName} requires an explicit worktree before dispatch.`);
    }
    if (worktree !== null && (!existsSync(worktree.path) || role.workspace !== worktree.path)) {
      throw usageError(`Role worktree is missing or does not match the configured workspace: ${roleName}.`);
    }
  }

  const observedActiveRun = store.getActiveAgentRun(taskId, roleName);
  if (observedActiveRun !== null) {
    throw usageError(`${taskId}/${roleName} already has an active agent run.`);
  }

  const mode = readOption(rest, "--mode");
  if (mode !== "new" && mode !== "resume") {
    throw usageError("--mode must be new or resume.");
  }

  const input = readOption(rest, "--input").trim();
  if (input.length === 0) {
    throw usageError("Dispatch input is required.");
  }

  const observedSessionSet = store.getRoleSessionSet(taskId, roleName);
  let sessionSet = observedSessionSet;
  let session = sessionSet?.sessions[role.activeAgentId] ?? null;
  if (
    roleName === BUILTIN_LEADER_ROLE &&
    session !== null &&
    session.status !== "reserved" &&
    mode === "new"
  ) {
    throw usageError("The Leader must resume its fixed session; replace it explicitly if irrecoverable.");
  }

  const workItemId = readOptionalOption(rest, "--work-item")?.trim();
  const workItem = workItemId === undefined ? null : store.getWorkItem(taskId, workItemId);
  if (workItemId !== undefined && workItem === null) {
    throw usageError(`Work item not found: ${workItemId}.`);
  }
  if (workItem !== null && workItem.assignee !== roleName) {
    throw usageError(`Work item ${workItem.id} is assigned to ${workItem.assignee}, not ${roleName}.`);
  }
  if (workItem !== null && ["completed", "failed", "cancelled", "superseded"].includes(workItem.status)) {
    throw usageError(`Work item ${workItem.id} is already ${workItem.status}.`);
  }
  const topics = [...new Set([
    ...(workItem?.topics ?? []),
    ...readRepeatedOption(rest, "--topic").map((topic) => topic.trim())
  ])];
  const knownTopics = new Set([
    ...BUILTIN_TOPICS.map(({ id }) => id),
    ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
  ]);
  const unknownTopic = topics.find((topic) => !knownTopics.has(topic));
  if (unknownTopic !== undefined) {
    throw usageError(`Topic not found: ${unknownTopic}.`);
  }
  const scopedInput = workItem === null
    ? input
    : [
        `WorkItem ${workItem.id}: ${workItem.title}`,
        ...(topics.length === 0 ? [] : [`Topics: ${topics.join(", ")}`]),
        input
      ].join("\n");
  const run = createAgentRun(
    store.nextAgentRunId(taskId),
    taskId,
    roleName,
    mode as DispatchMode,
    scopedInput,
    new Date(),
    { workItemId, topics }
  );
  const compiledInput = compileDispatchInput(store, taskId, role, scopedInput);
  const binding = activeRoleAgentBinding(role);
  if (
    mode === "new" &&
    session === null &&
    binding.adapterId === "codex" &&
    store.listAgentRuns(taskId).some((candidate) => candidate.roleName === roleName)
  ) {
    throw usageError("Codex has an unregistered prior AgentRun; record its native session identity before continuing.");
  }
  const agent = resolveAgent(binding.agentId, store.listConfiguredAgents());
  if (agent === null) throwUnsupportedAgent(binding.agentId, store);
  const executor = resolveAgentExecutor(binding.adapterId);
  if (mode === "new" && session === null) {
    const reservation = reserveInitialAgentSession(
      taskId,
      role,
      agent,
      new Date(),
      store.getRoleWorktree(taskId, roleName)?.path,
      process.env
    );
    if (reservation !== null) {
      sessionSet = reservation;
      session = reservation.sessions[role.activeAgentId] ?? null;
    }
  }
  const dispatchInput = {
    taskmuxHome: resolveTaskmuxHome(process.env),
    taskId,
    role,
    agent,
    run,
    session,
    input: compiledInput,
    now: new Date(),
    worktreeRoot: store.getRoleWorktree(taskId, roleName)?.path
  };
  const prepared = executor.plan(dispatchInput);
  const storedRun = { ...run, input: compiledInput };
  const pendingRunExisting = store.getAgentRun(taskId, run.id);
  if (pendingRunExisting !== null) {
    throw usageError(`AgentRun id was allocated concurrently: ${taskId}/${run.id}.`);
  }
  return {
    taskId,
    role,
    expectedStateDigest: roleRuntimeStateDigest({
      role,
      sessionSet: observedSessionSet,
      activeRun: observedActiveRun,
      selectedWorkItem: workItem,
      pendingRun: { id: run.id, existing: pendingRunExisting }
    }),
    run: storedRun,
    workItem,
    expectedWorkItemUpdatedAt: workItem?.updatedAt ?? null,
    sessionSet,
    session: prepared.session,
    launch: prepared.launch,
    input: compiledInput,
    mode
  };
}

export function persistTaskRoleDispatch(
  prepared: PreparedTaskRoleDispatch,
  store: TaskStore,
  options: { recordAcceptedEvent?: boolean } = {}
): string {
  const { taskId, role, run, workItem, session, mode } = prepared;
  const currentState = readRoleRuntimeStateSnapshot(store, taskId, role.name, {
    workItemId: prepared.workItem?.id,
    pendingRunId: prepared.run.id
  });
  const currentRole = currentState.role;
  const currentSessionSet = currentState.sessionSet;
  if (currentRole === null || roleRuntimeStateDigest(currentState) !== prepared.expectedStateDigest) {
    throw roleConflict(`${taskId}/${role.name}`);
  }
  if (currentState.activeRun !== null || currentState.pendingRun?.existing !== null) {
    throw usageError(`${taskId}/${role.name} already has an active agent run.`);
  }
  const currentWorkItem = workItem === null ? null : store.getWorkItem(taskId, workItem.id);
  if (
    workItem !== null &&
    (currentWorkItem === null || currentWorkItem.updatedAt !== prepared.expectedWorkItemUpdatedAt)
  ) {
    throw usageError(`Work item changed while launching: ${workItem.id}.`);
  }

  const now = new Date();
  const effectiveSessionSet = session === null
    ? prepared.sessionSet
    : {
        ...(prepared.sessionSet ?? createRoleSessionSet(
          { scope: "task" as const, taskId, roleName: role.name },
          role.activeAgentId,
          now
        )),
        activeAgentId: role.activeAgentId,
        sessions: {
          ...(prepared.sessionSet?.sessions ?? {}),
          [role.activeAgentId]: { ...session, status: "running" as const, updatedAt: now.toISOString() }
        },
        updatedAt: now.toISOString()
      };
  store.saveRoleWithSessionSet(taskId, updateRoleStatus(currentRole, "running", now), effectiveSessionSet);
  store.saveAgentRun(run);
  store.saveActiveAgentRun(run);
  if (currentWorkItem !== null) {
    store.saveWorkItem(taskId, updateWorkItemStatus(currentWorkItem, "running", undefined, now));
  }
  if (options.recordAcceptedEvent !== false) {
    recordTaskEvent(store, taskId, "role.dispatch_accepted", { role: role.name, mode });
  }
  return `Dispatch accepted for ${taskId}/${role.name} (${mode})\n`;
}

function taskSessionCommand(
  args: string[],
  store: TaskStore,
  environment: NodeJS.ProcessEnv,
  tmux?: TmuxManager,
  sessionRegistration?: ManualSessionRegistration,
  requireManualSessionRegistration = false
): string {
  const [command, taskId, roleName, ...rest] = args;

  if (taskId === undefined || roleName === undefined) {
    throw usageError("Session usage: taskmux task session record|replace <task-id> <role> --native-id <id> [--reason <reason>].");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);
  if (role === null) {
    throw roleNotFound(roleName);
  }
  const nativeSessionId = readOption(rest, "--native-id");
  if (!isCanonicalNativeSessionId(nativeSessionId)) {
    throw usageError("Native session id must not contain surrounding whitespace.");
  }
  assertSessionRegistrationProvenance(command, taskId, roleName, nativeSessionId, role, store, environment);
  const binding = activeRoleAgentBinding(role);
  const existingSet = store.getRoleSessionSet(taskId, roleName) ??
    createRoleSessionSet({ scope: "task", taskId, roleName }, role.activeAgentId, new Date());
  const existing = existingSet.sessions[role.activeAgentId] ?? null;
  const adapter = resolveAgentAdapter(binding.adapterId);
  const configuredAgent = resolveAgent(binding.agentId, store.listConfiguredAgents());
  if (configuredAgent === null) throwUnsupportedAgent(binding.agentId, store);
  const fingerprint = adapter.fingerprint(binding.config, {
    workspace: role.workspace,
    systemPrompt: role.systemPrompt,
    agent: configuredAgent
  });
  const ownedWorktree = store.getRoleWorktree(taskId, roleName)?.path;
  if (requireManualSessionRegistration && sessionRegistration === undefined) {
    throw usageError("Controller session registration provenance is required.");
  }
  if (sessionRegistration !== undefined && (
    sessionRegistration.scope !== "task" ||
    sessionRegistration.taskId !== taskId ||
    sessionRegistration.roleName !== roleName ||
    sessionRegistration.agentId !== binding.agentId ||
    sessionRegistration.adapterId !== binding.adapterId ||
    sessionRegistration.agentDefinitionUpdatedAt !== configuredAgent.updatedAt
  )) {
    throw usageError("Controller session registration provenance does not match the active Role binding.");
  }
  const sessionRoot = sessionRegistration === undefined
    ? resolveAgentSessionRoot(binding.adapterId, {
        ...environment,
        ...resolveAgentLaunchEnvironment(configuredAgent, environment)
      })
    : sessionRegistration.sessionRoot;
  if (!isCanonicalNativeSessionRoot(sessionRoot)) {
    throw usageError("Native session registration root is invalid.");
  }
  const provenanceSessionRoot = environment.TASKMUX_NATIVE_SESSION_ROOT?.trim();
  if (provenanceSessionRoot !== undefined && provenanceSessionRoot !== sessionRoot) {
    throw usageError("Native session registration root does not match the Agent environment.");
  }
  const sessionInput = (replacementReason?: string) => ({
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    nativeSessionId,
    policy: roleName === BUILTIN_LEADER_ROLE ? "fixed" as const : "leader-controlled" as const,
    status: "ready" as const,
    sessionRoot,
    ...(replacementReason === undefined && existing?.worktreeRoot !== undefined
      ? { worktreeRoot: existing.worktreeRoot }
      : ownedWorktree === undefined ? {} : { worktreeRoot: ownedWorktree }),
    configFingerprint: fingerprint,
    permissionEnvelope: permissionEnvelopeForBinding(binding),
    ...(replacementReason === undefined ? {} : { replacementReason })
  });

  if (command === "record") {
    const candidateIdentity = { adapterId: binding.adapterId, sessionRoot, nativeSessionId };
    if (existing !== null && !sameNativeSessionIdentity(existing, candidateIdentity)) {
      throw usageError(`${roleName === BUILTIN_LEADER_ROLE ? "Leader" : "Role"} session replacement must be explicit.`);
    }

    const sessions = recordRoleAgentSession(existingSet, sessionInput(), new Date());
    store.saveRoleSessionSet(sessions);
    if (roleName === BUILTIN_LEADER_ROLE) {
      store.clearLeaderFailure(taskId);
      store.clearOperatorNotification(taskId);
    }
    return `Recorded native session for ${taskId}/${roleName}\n`;
  }

  if (command === "replace") {
    if (existing === null) {
      throw usageError("Native session replacement requires an existing native session.");
    }
    const candidateIdentity = { adapterId: binding.adapterId, sessionRoot, nativeSessionId };
    if (sameNativeSessionIdentity(existing, candidateIdentity)) {
      throw usageError("Native session replacement requires a different native session identity.");
    }
    if (existing.previousIdentities.some((identity) => sameNativeSessionIdentity(identity, candidateIdentity))) {
      throw usageError("A historical native session identity cannot be reused.");
    }
    if (store.getActiveAgentRun(taskId, roleName) !== null) {
      throw usageError("Native session replacement requires the Role AgentRun to be idle.");
    }
    if (tmux === undefined) throw runtimeError("Tmux manager is not configured.");
    if (tmux.probeRoleStatus(taskId, roleName) === "running") {
      throw usageError("Native session replacement is blocked while the native Agent process is running.");
    }
    const reason = readOption(rest, "--reason").trim();
    if (reason.length === 0) {
      throw usageError("Session replacement reason is required.");
    }

    const sessions = recordRoleAgentSession(existingSet, sessionInput(reason), new Date());
    store.saveRoleSessionSet(sessions);
    if (roleName === BUILTIN_LEADER_ROLE) {
      store.clearLeaderFailure(taskId);
      store.clearOperatorNotification(taskId);
    }
    recordTaskEvent(store, taskId, "role.session_replaced", { role: roleName, reason });
    return `Replaced native session for ${taskId}/${roleName}\n`;
  }

  throw usageError("Session usage: taskmux task session record|replace <task-id> <role> --native-id <id> [--reason <reason>].");
}

function assertSessionRegistrationProvenance(
  command: string | undefined,
  taskId: string,
  roleName: string,
  nativeSessionId: string,
  role: Role,
  store: TaskStore,
  env: NodeJS.ProcessEnv
): void {
  const provenanceValues = [
    env.TASKMUX_TASK_ID,
    env.TASKMUX_ROLE,
    env.TASKMUX_RUN_ID,
    env.TASKMUX_AGENT_ID,
    env.TASKMUX_ADAPTER_ID,
    env.TASKMUX_NATIVE_SESSION_ROOT
  ];
  if (provenanceValues.every((value) => value === undefined)) return;
  if (provenanceValues.some((value) => value === undefined || value.trim().length === 0)) {
    throw usageError("Native session registration provenance is incomplete.");
  }
  if (command !== "record") {
    throw usageError("A running Agent may record only its current native session.");
  }
  if (env.TASKMUX_TASK_ID !== taskId || env.TASKMUX_ROLE !== roleName) {
    throw usageError("Native session registration target does not match the active AgentRun owner.");
  }
  const binding = activeRoleAgentBinding(role);
  if (env.TASKMUX_AGENT_ID !== binding.agentId || env.TASKMUX_ADAPTER_ID !== binding.adapterId) {
    throw usageError("Native session registration Agent does not match the active Role binding.");
  }
  if (env.TASKMUX_NATIVE_SESSION_ROOT === undefined ||
      env.TASKMUX_NATIVE_SESSION_ROOT.trim().length === 0 ||
      !isAbsolute(env.TASKMUX_NATIVE_SESSION_ROOT) ||
      resolve(env.TASKMUX_NATIVE_SESSION_ROOT) !== env.TASKMUX_NATIVE_SESSION_ROOT) {
    throw usageError("Native session registration root is missing or invalid.");
  }
  const activeRun = store.getActiveAgentRun(taskId, roleName);
  if (activeRun === null || activeRun.id !== env.TASKMUX_RUN_ID) {
    throw usageError("Native session registration does not match the active AgentRun.");
  }
  if (binding.adapterId === "codex" && (env.CODEX_THREAD_ID === undefined || env.CODEX_THREAD_ID.trim().length === 0)) {
    throw usageError("Codex native session registration requires CODEX_THREAD_ID.");
  }
  if (env.CODEX_THREAD_ID !== undefined && env.CODEX_THREAD_ID.trim() !== nativeSessionId) {
    throw usageError("Native session id does not match CODEX_THREAD_ID.");
  }
}

function wakeTaskCommand(args: string[], store: TaskStore): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  if (task.archived) {
    throw usageError(`Cannot wake archived task: ${taskId}.`);
  }

  const reason = readOption(rest, "--reason").trim();
  queueLeaderWakeup(store, taskId, reason);
  recordTaskEvent(store, taskId, "leader.wakeup_requested", { reason });
  return `Queued leader wakeup for task ${taskId}\n`;
}

function taskCycleCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;

  if (command === "end" && taskId !== undefined) {
    const [cycleId, ...options] = rest;
    if (store.getTask(taskId) === null) {
      throw taskNotFound(taskId);
    }
    if (cycleId === undefined) {
      throw usageError("Cycle id is required.");
    }
    const cycle = store.getCycle(taskId, cycleId);
    if (cycle === null) {
      throw usageError(`Cycle not found: ${cycleId}.`);
    }
    if (cycle.status === "ended") {
      throw usageError(`Cycle is already ended: ${cycleId}.`);
    }
    const ended = endCycle(cycle, readOption(options, "--summary"), new Date());
    store.saveCycle(taskId, ended);
    recordTaskEvent(store, taskId, "cycle.ended", { cycle: cycle.id });
    return `Ended cycle ${cycle.id} for task ${taskId}\n`;
  }

  if (command !== "create" || taskId === undefined || store.getTask(taskId) === null) {
    if (taskId !== undefined && store.getTask(taskId) === null) {
      throw taskNotFound(taskId);
    }
    throw usageError("Cycle usage: taskmux task cycle create <task-id> --cause <cause> --summary <summary>.");
  }

  const cause = readOption(rest, "--cause");
  const topics = readRepeatedOption(rest, "--topic").map((topic) => topic.trim());
  validateTopicIds(store, taskId, topics);
  if (!CYCLE_CAUSES.includes(cause as CycleCause)) {
    throw usageError(`Invalid cycle cause: ${cause}.`);
  }

  const cycle = createCycle(
    store.nextCycleId(taskId),
    taskId,
    cause as CycleCause,
    readOption(rest, "--summary"),
    new Date(),
    topics
  );
  store.saveCycle(taskId, cycle);
  recordTaskEvent(store, taskId, "cycle.created", { cycle: cycle.id, cause: cycle.cause });
  return `Created cycle ${cycle.id} for task ${taskId}\n`;
}

function taskWorkItemCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...commandArgs] = args;

  if (taskId !== undefined && store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (command === "update" && taskId !== undefined) {
    const [workItemId, ...rest] = commandArgs;
    if (workItemId === undefined) {
      throw usageError("Work item id is required.");
    }
    const workItem = store.getWorkItem(taskId, workItemId);
    if (workItem === null) {
      throw usageError(`Work item not found: ${workItemId}.`);
    }
    const status = readOption(rest, "--status");
    const allowed = ["pending", "running", "completed", "failed", "cancelled", "superseded"];
    if (!allowed.includes(status)) {
      throw usageError(`Invalid work item status: ${status}.`);
    }
    const updated = updateWorkItemStatus(
      workItem,
      status as WorkItemStatus,
      readOptionalOption(rest, "--outcome"),
      new Date()
    );
    store.saveWorkItem(taskId, updated);
    recordTaskEvent(store, taskId, "work-item.updated", { workItem: updated.id, status });
    return `Updated work item ${updated.id} for task ${taskId}\n`;
  }

  if (command !== "create" || taskId === undefined) {
    throw usageError("Work item usage: taskmux task work-item create <task-id> --title <title> [--cycle <cycle>] [--assignee <role>] [--topic <topic> ...].");
  }

  const rest = commandArgs;

  const cycleId = readOptionalOption(rest, "--cycle")?.trim();
  const assignee = readOptionalOption(rest, "--assignee")?.trim() ?? BUILTIN_LEADER_ROLE;
  const topics = readRepeatedOption(rest, "--topic").map((topic) => topic.trim());
  const knownTopicIds = new Set([
    ...BUILTIN_TOPICS.map(({ id }) => id),
    ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
  ]);

  if (cycleId !== undefined && store.getCycle(taskId, cycleId) === null) {
    throw usageError(`Cycle not found: ${cycleId}.`);
  }

  if (store.getRole(taskId, assignee) === null) {
    throw roleNotFound(assignee);
  }

  const unknownTopic = topics.find((topic) => !knownTopicIds.has(topic));
  if (unknownTopic !== undefined) {
    throw usageError(`Topic not found: ${unknownTopic}.`);
  }

  const workItem = createWorkItem(
    store.nextWorkItemId(taskId),
    taskId,
    {
      title: readOption(rest, "--title"),
      assignee,
      topics,
      ...(cycleId === undefined ? {} : { cycleId })
    },
    new Date()
  );
  store.saveWorkItem(taskId, workItem);
  recordTaskEvent(store, taskId, "work-item.created", { workItem: workItem.id, assignee });
  return `Created work item ${workItem.id} for task ${taskId}\n`;
}

function taskInputCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (command === "draft") {
    const body = rest.join(" ").trim();
    const draft = createTaskInputDraft(taskId, body, new Date(), store.getTaskInputDraft(taskId) ?? undefined);
    store.saveTaskInputDraft(taskId, draft);
    return `Saved input draft for task ${taskId}\n`;
  }

  if (command === "submit" && rest.length === 0) {
    const draft = store.getTaskInputDraft(taskId);

    if (draft === null) {
      throw usageError(`No input draft exists for task ${taskId}.`);
    }

    const comment = createTaskComment(store.nextCommentId(taskId), draft.body, new Date(), "operator");
    store.saveComment(taskId, comment);
    recordTaskEvent(store, taskId, "task.input_submitted", { comment: comment.id });
    queueLeaderWakeup(store, taskId, "operator-input");
    store.clearTaskInputDraft(taskId);
    return `Submitted input draft for task ${taskId}\n`;
  }

  throw usageError("Input usage: taskmux task input draft <task-id> <body> | taskmux task input submit <task-id>.");
}

type TaskLifecycleOperation = TaskLifecycleRuntimeOperationClaim["operation"];

type TaskLifecyclePreparationOptions = {
  targetRoleName?: string;
  newRoleName?: string;
  archiveMetadata?: {
    by: "user" | "operator" | "leader";
    reason?: string | null;
    summary?: string | null;
  };
  worktreeRequest?: {
    roleName: string;
    path: string | null;
    branch: string | null;
    base: string | null;
  };
};

export function readTaskLifecyclePreparedState(
  store: TaskStore,
  taskId: string
): TaskLifecyclePreparedState {
  const task = store.getTask(taskId);
  if (task === null) throw taskNotFound(taskId);
  const roles = store.listRoles(taskId).sort((left, right) => left.name.localeCompare(right.name));
  const sessionSets = store.listRoleSessionSets(taskId)
    .sort((left, right) => left.owner.roleName.localeCompare(right.owner.roleName));
  const activeRuns = roles
    .map((role) => store.getActiveAgentRun(taskId, role.name))
    .filter((run): run is AgentRun => run !== null)
    .sort((left, right) => left.roleName.localeCompare(right.roleName));
  const pendingRuns = store.listAgentRuns(taskId)
    .filter((run) => run.status === "active")
    .sort((left, right) => left.id.localeCompare(right.id));
  const workItems = store.listWorkItems(taskId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const worktrees = store.listRoleWorktrees(taskId);
  const dependencyGraphDigest = roleRuntimeStateDigest({
    roles: roles.map((role) => role.name),
    childRoles: store.listChildRoles(taskId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((role) => ({ name: role.name, parentRole: role.parentRole, updatedAt: role.updatedAt })),
    workItems: workItems.map((item) => ({
      id: item.id,
      assignee: item.assignee,
      status: item.status,
      updatedAt: item.updatedAt
    })),
    activeRuns: activeRuns.map((run) => ({ id: run.id, roleName: run.roleName, updatedAt: run.updatedAt })),
    pendingRuns: pendingRuns.map((run) => ({ id: run.id, roleName: run.roleName, updatedAt: run.updatedAt })),
    worktrees: worktrees.map((worktree) => ({
      roleName: worktree.roleName,
      ownerToken: worktree.ownerToken,
      repositoryFingerprint: worktree.repositoryFingerprint,
      path: worktree.path
    }))
  });
  const prepared = {
    task,
    roles,
    sessionSets,
    activeRuns,
    pendingRuns,
    workItems,
    worktrees,
    dependencyGraphDigest
  };
  const inert = lowerUnknownInertData(prepared);
  const serialized = inert === null ? null : stringifyCanonicalInertData(inert);
  if (serialized === null) throw runtimeError(`Task lifecycle state is not serializable: ${taskId}.`);
  return JSON.parse(serialized) as TaskLifecyclePreparedState;
}

export function prepareTaskLifecycleOperation(
  operation: TaskLifecycleOperation,
  taskId: string,
  store: TaskStore,
  options: TaskLifecyclePreparationOptions = {},
  now = new Date()
): TaskLifecycleRuntimeOperationClaim {
  const preparedState = readTaskLifecyclePreparedState(store, taskId);
  const targetRoleName = options.targetRoleName?.trim() || null;
  const newRoleName = options.newRoleName?.trim() || null;
  if (
    ["role-detach", "role-remove", "role-rename", "worktree-create", "worktree-remove"].includes(operation) &&
    targetRoleName === null
  ) {
    throw usageError("Task lifecycle Role target is required.");
  }
  if (targetRoleName !== null && preparedState.roles.every((role) => role.name !== targetRoleName)) {
    throw roleNotFound(targetRoleName);
  }
  if (operation === "role-rename") {
    if (newRoleName === null) throw usageError("New Role name is required.");
    if (
      preparedState.roles.some((role) => role.name === newRoleName) ||
      store.getChildRole(taskId, newRoleName) !== null
    ) {
      throw usageError(`Role name is already owned: ${taskId}/${newRoleName}.`);
    }
  }
  if (
    operation === "role-remove" &&
    preparedState.worktrees.some((worktree) => worktree.roleName === targetRoleName)
  ) {
    throw usageError(`Remove the managed worktree before removing Role ${targetRoleName}.`);
  }
  const archiveMetadata = operation === "archive"
    ? {
        by: options.archiveMetadata?.by ?? "user",
        reason: options.archiveMetadata?.reason?.trim() || null,
        summary: options.archiveMetadata?.summary?.trim() || null
      }
    : null;
  return {
    schemaVersion: 1,
    scope: "task",
    kind: "task-lifecycle",
    token: randomUUID(),
    taskId,
    roleName: null,
    operation,
    ownerPid: process.pid,
    preparedSession: null,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(preparedState),
    recoveryToken: null,
    ...createRoleRuntimeOperationLease(now),
    phase: "prepared",
    preparedState,
    effectPlan: null,
    targetRoleName,
    newRoleName,
    archiveMetadata,
    worktreeRequest: options.worktreeRequest ?? null
  };
}

type TaskLifecycleRuntime = Pick<
  TmuxManager,
  "probeRoleStatus" | "roleLaunchToken" | "roleOperationToken" |
  "detachRole" | "killRoleForRestartWithOperationToken" | "renameRoleWithOperationToken"
>;

export type TaskLifecycleEffectReceipt =
  | { kind: "git-worktree-created"; record: RoleWorktree }
  | { kind: "git-worktree-removed" };

export function probeTaskLifecycleEffectPlan(
  claim: TaskLifecycleRuntimeOperationClaim,
  runtime: Pick<TaskLifecycleRuntime, "probeRoleStatus" | "roleLaunchToken">,
  gitWorktrees = new GitWorktreeManager(),
  taskmuxHome?: string
): TaskLifecycleEffectPlan {
  if (claim.phase !== "prepared") {
    if (claim.effectPlan === null) throw runtimeError("Task lifecycle effect plan is missing.");
    return claim.effectPlan;
  }
  if (claim.operation === "worktree-create" || claim.operation === "worktree-remove") {
    if (claim.targetRoleName === null || claim.worktreeRequest === null) {
      throw runtimeError("Task worktree lifecycle plan is incomplete.");
    }
    if (runtime.probeRoleStatus(claim.taskId, claim.targetRoleName) === "running") {
      throw usageError(`Role native process is running: ${claim.taskId}/${claim.targetRoleName}.`);
    }
    if (claim.operation === "worktree-remove") {
      const record = claim.preparedState.worktrees.find((item) => item.roleName === claim.targetRoleName);
      if (record === undefined) throw usageError(`Role has no managed worktree: ${claim.taskId}/${claim.targetRoleName}.`);
      return gitWorktrees.probeRemove(record);
    }
    if (taskmuxHome === undefined) throw runtimeError("TaskMux home is required for worktree planning.");
    const role = claim.preparedState.roles.find((item) => item.name === claim.targetRoleName);
    if (role === undefined) throw roleNotFound(claim.targetRoleName);
    const path = claim.worktreeRequest.path;
    const branch = claim.worktreeRequest.branch;
    if (path === null || branch === null) throw runtimeError("Task worktree creation request is incomplete.");
    return gitWorktrees.probeCreate({
      roleName: claim.targetRoleName,
      repository: role.workspace,
      path,
      branch,
      ...(claim.worktreeRequest.base === null ? {} : { base: claim.worktreeRequest.base }),
      ownerToken: claim.token,
      taskmuxHome
    });
  }
  if (claim.operation === "role-rename") {
    if (claim.targetRoleName === null || claim.newRoleName === null) {
      throw runtimeError("Task Role rename plan is incomplete.");
    }
    return {
      kind: "rename-role",
      oldName: claim.targetRoleName,
      newName: claim.newRoleName,
      launchToken: probeExactLaunchToken(runtime, claim.taskId, claim.targetRoleName)
    };
  }
  if (claim.operation === "role-detach") {
    if (claim.targetRoleName === null) {
      throw runtimeError("Task Role detach plan is incomplete.");
    }
    return { kind: "detach-role", roleName: claim.targetRoleName };
  }
  const roleNames = claim.operation === "role-remove"
    ? [claim.targetRoleName!]
    : claim.preparedState.roles.map((role) => role.name);
  return {
    kind: "stop-roles",
    windows: roleNames.sort((left, right) => left.localeCompare(right)).map((roleName) => ({
      roleName,
      launchToken: probeExactLaunchToken(runtime, claim.taskId, roleName)
    }))
  };
}

function probeExactLaunchToken(
  runtime: Pick<TaskLifecycleRuntime, "probeRoleStatus" | "roleLaunchToken">,
  taskId: string,
  roleName: string
): string | null {
  if (runtime.probeRoleStatus(taskId, roleName) === "exited") return null;
  const launchToken = runtime.roleLaunchToken(taskId, roleName);
  if (launchToken === null) {
    throw runtimeError(`Task lifecycle requires a durable launch identity: ${taskId}/${roleName}.`);
  }
  return launchToken;
}

export function replayTaskLifecycleEffectPlan(
  claim: TaskLifecycleRuntimeOperationClaim,
  runtime: TaskLifecycleRuntime,
  gitWorktrees = new GitWorktreeManager(),
  now = new Date()
): TaskLifecycleEffectReceipt | null {
  if (claim.phase !== "effect-started" || claim.effectPlan === null) {
    throw runtimeError(`Task lifecycle effect has not started: ${claim.taskId}.`);
  }
  if (claim.effectPlan.kind === "detach-role") {
    runtime.detachRole(claim.taskId);
    return null;
  }
  if (claim.effectPlan.kind === "rename-role") {
    replayTaskRoleRenameEffect(claim, claim.effectPlan, runtime);
    return null;
  }
  if (claim.effectPlan.kind === "git-worktree-create") {
    return {
      kind: "git-worktree-created",
      record: gitWorktrees.applyCreate(claim.effectPlan, claim.taskId, now)
    };
  }
  if (claim.effectPlan.kind === "git-worktree-remove") {
    gitWorktrees.applyRemove(claim.effectPlan);
    return { kind: "git-worktree-removed" };
  }
  for (const window of claim.effectPlan.windows) {
    if (runtime.probeRoleStatus(claim.taskId, window.roleName) === "exited") continue;
    const operationToken = runtime.roleOperationToken(claim.taskId, window.roleName);
    const launchToken = runtime.roleLaunchToken(claim.taskId, window.roleName);
    if (operationToken !== null && operationToken !== claim.token) {
      throw runtimeError(`Task lifecycle encountered a foreign operation: ${window.roleName}.`);
    }
    if (launchToken !== window.launchToken) {
      throw runtimeError(`Task lifecycle target changed before recovery: ${window.roleName}.`);
    }
    runtime.killRoleForRestartWithOperationToken(claim.taskId, window.roleName, claim.token);
    if (runtime.probeRoleStatus(claim.taskId, window.roleName) !== "exited") {
      throw runtimeError(`Task lifecycle could not confirm stopped Role: ${window.roleName}.`);
    }
  }
  return null;
}

function replayTaskRoleRenameEffect(
  claim: TaskLifecycleRuntimeOperationClaim,
  plan: Extract<TaskLifecycleEffectPlan, { kind: "rename-role" }>,
  runtime: TaskLifecycleRuntime
): void {
  const oldStatus = runtime.probeRoleStatus(claim.taskId, plan.oldName);
  const newStatus = runtime.probeRoleStatus(claim.taskId, plan.newName);
  if (oldStatus === "running" && newStatus === "running") {
    throw runtimeError(`Task Role rename found both source and destination windows: ${plan.oldName}.`);
  }
  if (oldStatus === "exited" && newStatus === "exited") {
    if (plan.launchToken === null) return;
    throw runtimeError(`Task Role rename lost its token-owned window: ${plan.oldName}.`);
  }
  if (newStatus === "running") {
    if (
      runtime.roleLaunchToken(claim.taskId, plan.newName) !== plan.launchToken ||
      runtime.roleOperationToken(claim.taskId, plan.newName) !== claim.token
    ) {
      throw runtimeError(`Task Role rename destination is foreign: ${plan.newName}.`);
    }
    return;
  }
  const operationToken = runtime.roleOperationToken(claim.taskId, plan.oldName);
  if (
    (operationToken !== null && operationToken !== claim.token) ||
    runtime.roleLaunchToken(claim.taskId, plan.oldName) !== plan.launchToken
  ) {
    throw runtimeError(`Task Role rename source changed before recovery: ${plan.oldName}.`);
  }
  runtime.renameRoleWithOperationToken(claim.taskId, plan.oldName, plan.newName, claim.token);
  if (
    runtime.probeRoleStatus(claim.taskId, plan.oldName) !== "exited" ||
    runtime.probeRoleStatus(claim.taskId, plan.newName) !== "running" ||
    runtime.roleOperationToken(claim.taskId, plan.newName) !== claim.token
  ) {
    throw runtimeError(`Task Role rename could not be confirmed: ${plan.oldName}.`);
  }
}

export function finalizeTaskLifecycleOperation(
  claim: TaskLifecycleRuntimeOperationClaim,
  store: TaskStore,
  now = new Date(),
  receipt: TaskLifecycleEffectReceipt | null = null
): string {
  if (claim.phase !== "effect-started") {
    throw runtimeError(`Task lifecycle effect has not started: ${claim.taskId}.`);
  }
  const current = readTaskLifecyclePreparedState(store, claim.taskId);
  if (roleRuntimeStateDigest(current) !== claim.expectedStateDigest) {
    throw roleConflict(claim.taskId);
  }
  if (claim.operation === "worktree-create") {
    if (
      claim.targetRoleName === null ||
      claim.effectPlan?.kind !== "git-worktree-create" ||
      receipt?.kind !== "git-worktree-created" ||
      receipt.record.ownerToken !== claim.token ||
      receipt.record.roleName !== claim.targetRoleName
    ) {
      throw runtimeError("Task worktree creation receipt is invalid.");
    }
    const role = store.getRole(claim.taskId, claim.targetRoleName);
    if (role === null) throw roleNotFound(claim.targetRoleName);
    store.saveRoleWorktree(claim.taskId, receipt.record);
    store.saveRole(claim.taskId, updateRole(role, { workspace: receipt.record.path }, now));
    recordTaskEvent(store, claim.taskId, "role.worktree_created", {
      role: claim.targetRoleName,
      branch: receipt.record.branchRef
    });
    return `Created worktree for ${claim.taskId}/${claim.targetRoleName}: ${receipt.record.path}\n`;
  }
  if (claim.operation === "worktree-remove") {
    if (
      claim.targetRoleName === null ||
      claim.effectPlan?.kind !== "git-worktree-remove" ||
      receipt?.kind !== "git-worktree-removed"
    ) {
      throw runtimeError("Task worktree removal receipt is invalid.");
    }
    const role = store.getRole(claim.taskId, claim.targetRoleName);
    if (role === null) throw roleNotFound(claim.targetRoleName);
    let sessions = store.getRoleSessionSet(claim.taskId, claim.targetRoleName);
    if (sessions !== null) {
      for (const [agentId, session] of Object.entries(sessions.sessions)) {
        if (session.worktreeRoot === claim.effectPlan.targetPath) {
          sessions = updateRoleAgentSessionStatus(sessions, agentId, "broken", now);
        }
      }
    }
    store.saveRoleWithSessionSet(
      claim.taskId,
      updateRole(role, { workspace: claim.effectPlan.repositoryRoot }, now),
      sessions
    );
    store.removeRoleWorktree(claim.taskId, claim.targetRoleName);
    recordTaskEvent(store, claim.taskId, "role.worktree_removed", { role: claim.targetRoleName });
    return `Removed worktree for ${claim.taskId}/${claim.targetRoleName}\n`;
  }
  if (claim.operation === "role-rename") {
    if (claim.targetRoleName === null || claim.newRoleName === null) {
      throw runtimeError("Task Role rename plan is incomplete.");
    }
    const role = store.getRole(claim.taskId, claim.targetRoleName);
    if (role === null) throw roleNotFound(claim.targetRoleName);
    store.renameRole(claim.taskId, claim.targetRoleName, updateRole(role, { name: claim.newRoleName }, now));
    recordTaskEvent(store, claim.taskId, "role.renamed", {
      from: claim.targetRoleName,
      to: claim.newRoleName
    });
    return `Renamed role ${claim.targetRoleName} to ${claim.newRoleName} for ${claim.taskId}\n`;
  }
  if (claim.operation === "role-detach") {
    if (
      claim.targetRoleName === null ||
      claim.effectPlan?.kind !== "detach-role" ||
      claim.effectPlan.roleName !== claim.targetRoleName
    ) {
      throw runtimeError("Task Role detach plan is incomplete.");
    }
    const role = store.getRole(claim.taskId, claim.targetRoleName);
    if (role === null) throw roleNotFound(claim.targetRoleName);
    store.saveRole(
      claim.taskId,
      updateRoleStatus(role, "detached", now)
    );
    return `Detached role ${claim.targetRoleName} for ${claim.taskId}\n`;
  }
  const stoppedRoleNames = claim.operation === "role-remove"
    ? [claim.targetRoleName!]
    : current.roles.map((role) => role.name);
  for (const roleName of stoppedRoleNames) {
    finalizeStoppedTaskRole(claim.taskId, roleName, store, lifecycleFailureReason(claim), now);
  }
  if (claim.operation === "role-remove") {
    const childNames = store.listChildRoles(claim.taskId)
      .filter((child) => child.parentRole === claim.targetRoleName)
      .map((child) => child.name);
    for (const item of store.listWorkItems(claim.taskId)) {
      if (
        ![claim.targetRoleName, ...childNames].includes(item.assignee) ||
        ["completed", "failed", "cancelled", "superseded"].includes(item.status)
      ) {
        continue;
      }
      store.saveWorkItem(
        claim.taskId,
        updateWorkItemStatus(item, "cancelled", `Role ${claim.targetRoleName} was removed.`, now)
      );
    }
    const result = store.removeTaskRole(claim.taskId, claim.targetRoleName!);
    if (!result.removed) throw roleNotFound(claim.targetRoleName!);
    recordTaskEvent(store, claim.taskId, "role.removed", {
      role: claim.targetRoleName!,
      childCount: String(result.childCount)
    });
    return `Removed role ${claim.targetRoleName} and ${result.childCount} child role${result.childCount === 1 ? "" : "s"}\n`;
  }
  clearTaskRuntimePointers(store, claim.taskId);
  if (claim.operation === "delete") {
    recordTaskEvent(store, claim.taskId, "task.deleted", { task: claim.taskId });
    if (!store.deleteTask(claim.taskId)) throw taskNotFound(claim.taskId);
    return `Deleted task ${claim.taskId}\n`;
  }
  const metadata = claim.archiveMetadata;
  if (metadata === null) throw runtimeError("Task archive metadata is missing.");
  store.saveTask(updateTaskArchived(current.task, true, now, {
    by: metadata.by,
    ...(metadata.reason === null ? {} : { reason: metadata.reason }),
    ...(metadata.summary === null ? {} : { summary: metadata.summary })
  }));
  recordTaskEvent(store, claim.taskId, "task.archived", {
    ...(metadata.reason === null ? {} : { reason: metadata.reason })
  });
  return `Archived task ${claim.taskId}\n`;
}

function lifecycleFailureReason(claim: TaskLifecycleRuntimeOperationClaim): string {
  if (claim.operation === "archive") return "Task was archived.";
  if (claim.operation === "delete") return "Task was deleted.";
  return "Task Role was removed.";
}

function finalizeStoppedTaskRole(
  taskId: string,
  roleName: string,
  store: TaskStore,
  reason: string,
  now: Date
): void {
  const role = store.getRole(taskId, roleName);
  if (role === null) throw roleNotFound(roleName);
  const activeRun = store.getActiveAgentRun(taskId, roleName);
  if (activeRun !== null) {
    store.saveAgentRun(failAgentRun(activeRun, reason, now));
    store.clearActiveAgentRun(taskId, roleName);
  }
  const sessionSet = store.getRoleSessionSet(taskId, roleName);
  const stoppedSessions = sessionSet !== null && sessionSet.sessions[role.activeAgentId] !== undefined
    ? updateRoleAgentSessionStatus(sessionSet, role.activeAgentId, "stopped", now)
    : sessionSet;
  store.saveRoleWithSessionSet(taskId, updateRoleStatus(role, "exited", now), stoppedSessions);
}

function clearTaskRuntimePointers(store: TaskStore, taskId: string): void {
  store.clearTaskInputDraft(taskId);
  store.clearPendingWakeup(taskId);
  store.clearLeaderFailure(taskId);
  const notification = store.getOperatorNotification(taskId);
  if (notification !== null) store.clearOperatorNotification(taskId);
}

function prepareArchiveTaskOperation(
  args: string[],
  store: TaskStore
): TaskLifecycleRuntimeOperationClaim {
  const [taskId, ...rest] = args;
  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task archive requires a task id.");
  }
  assertKnownOptions(rest, new Set(["--reason", "--summary"]));
  const actor = process.env.TASKMUX_ROLE === "leader"
    ? "leader"
    : process.env.TASKMUX_ROLE === "operator" ? "operator" : "user";
  return prepareTaskLifecycleOperation("archive", taskId, store, {
    archiveMetadata: {
      by: actor,
      reason: readOptionalOption(rest, "--reason") ?? null,
      summary: readOptionalOption(rest, "--summary") ?? null
    }
  });
}

export function executeTaskLifecycleOperation(
  rootDir: string,
  prepared: TaskLifecycleRuntimeOperationClaim,
  tmux: TmuxManager,
  finalize: (
    claim: TaskLifecycleRuntimeOperationClaim,
    receipt: TaskLifecycleEffectReceipt | null
  ) => string,
  gitWorktrees = new GitWorktreeManager()
): string {
  claimRoleRuntimeOperation(
    rootDir,
    `task-lifecycle-claim-${randomUUID()}`,
    prepared,
    (workingRoot) => roleRuntimeStateDigest(readTaskLifecyclePreparedState(
      transactionTaskStore(workingRoot),
      prepared.taskId
    ))
  );
  let started: TaskLifecycleRuntimeOperationClaim;
  try {
    const effectPlan = probeTaskLifecycleEffectPlan(prepared, tmux, gitWorktrees, rootDir);
    started = markTaskLifecycleOperationEffectStarted(
      rootDir,
      `task-lifecycle-effect-${randomUUID()}`,
      prepared,
      effectPlan
    );
  } catch (error) {
    const current = readTaskRuntimeOperationClaim(rootDir, prepared.taskId);
    if (current?.token === prepared.token && current.phase === "prepared" && current.recoveryToken === null) {
      releaseRuntimeOperationClaim(rootDir, `task-lifecycle-release-${randomUUID()}`, prepared);
    }
    throw error;
  }
  const receipt = replayTaskLifecycleEffectPlan(started, tmux, gitWorktrees);
  if (
    process.env.NODE_ENV === "test" &&
    process.env.TASKMUX_TEST_ONLY_TASK_LIFECYCLE_FAILPOINT === "after-effect"
  ) {
    throw new Error("Task lifecycle stopped after its external effect.");
  }
  return finalize(started, receipt);
}

export function runTaskLifecycleOperation(
  prepared: TaskLifecycleRuntimeOperationClaim,
  store: TaskStore,
  tmux?: TmuxManager
): string {
  if (tmux === undefined) throw runtimeError("Tmux manager is not configured.");
  if (!(store instanceof FileTaskStore)) {
    throw runtimeError("Task lifecycle operations require the canonical FileTaskStore coordinator.");
  }
  const rootDir = store.rootDirectory();
  if (hasActiveDomainTransactionAuthority(rootDir)) {
    throw runtimeError("Task lifecycle effects must run after the prepare transaction commits.");
  }
  recoverTaskLifecycleRuntimeOperations(rootDir, tmux);
  return executeTaskLifecycleOperation(rootDir, prepared, tmux, (started, receipt) =>
    executeDomainTransaction(rootDir, `task-lifecycle-finalize-${randomUUID()}`, (workingRoot) => {
      const current = readTaskRuntimeOperationClaim(workingRoot, started.taskId);
      if (
        current === null ||
        current.token !== started.token ||
        current.recoveryToken !== null ||
        current.phase !== "effect-started" ||
        roleRuntimeStateDigest(current.effectPlan) !== roleRuntimeStateDigest(started.effectPlan)
      ) {
        throw runtimeError(`Task lifecycle lost operation ownership: ${started.taskId}.`);
      }
      const output = finalizeTaskLifecycleOperation(
        current,
        transactionTaskStore(workingRoot, current.token),
        new Date(),
        receipt
      );
      clearRuntimeOperationClaim(
        workingRoot,
        { scope: "task", taskId: current.taskId },
        current.token
      );
      return output;
    })
  );
}

export function recoverTaskLifecycleRuntimeOperations(
  rootDir: string,
  tmux: TmuxManager,
  now = new Date()
): string[] {
  const recoveredTokens: string[] = [];
  for (const observed of listRuntimeOperationClaims(rootDir)) {
    if (observed.scope !== "task" || !isRuntimeOperationRecoverable(observed, now)) continue;
    const recoveryToken = randomUUID();
    const claimed = claimRuntimeOperationRecovery(
      rootDir,
      `task-lifecycle-recover-${randomUUID()}`,
      observed,
      recoveryToken,
      now
    );
    if (claimed === null || claimed.scope !== "task") continue;
    if (claimed.phase === "prepared") {
      releaseRuntimeOperationClaim(
        rootDir,
        `task-lifecycle-prepared-release-${randomUUID()}`,
        claimed,
        recoveryToken
      );
      recoveredTokens.push(claimed.token);
      continue;
    }
    const receipt = replayTaskLifecycleEffectPlan(claimed, tmux, new GitWorktreeManager(), now);
    executeDomainTransaction(rootDir, `task-lifecycle-recovery-finalize-${randomUUID()}`, (workingRoot) => {
      const current = readTaskRuntimeOperationClaim(workingRoot, claimed.taskId);
      if (
        current === null ||
        current.token !== claimed.token ||
        current.recoveryToken !== recoveryToken ||
        current.phase !== "effect-started"
      ) {
        throw runtimeError(`Task lifecycle recovery lost ownership: ${claimed.taskId}.`);
      }
      finalizeTaskLifecycleOperation(
        current,
        transactionTaskStore(workingRoot, current.token, recoveryToken),
        now,
        receipt
      );
      clearRuntimeOperationClaim(
        workingRoot,
        { scope: "task", taskId: current.taskId },
        current.token,
        recoveryToken
      );
    });
    recoveredTokens.push(claimed.token);
  }
  return recoveredTokens;
}

export function prepareTaskLifecycleCommand(
  args: string[],
  store: TaskStore
): TaskLifecycleRuntimeOperationClaim | null {
  if (args[0] === "archive") return prepareArchiveTaskOperation(args.slice(1), store);
  if (args[0] === "delete") return prepareDeleteTaskOperation(args.slice(1), store);
  if (args[0] === "role" && args[1] === "remove") {
    return prepareRemoveTaskRoleOperation(args.slice(2), store);
  }
  if (args[0] === "role" && args[1] === "rename") {
    return prepareRenameTaskRoleOperation(args.slice(2), store);
  }
  if (args[0] === "detach") {
    return prepareDetachTaskRoleOperation(args.slice(1), store);
  }
  if (args[0] === "worktree") return prepareTaskWorktreeOperation(args.slice(1), store);
  return null;
}

function updateTaskArchivedCommand(
  args: string[],
  store: TaskStore,
  archived: boolean,
  tmux?: TmuxManager
): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError(`Task ${archived ? "archive" : "unarchive"} requires a task id.`);
  }
  if (archived) {
    return runTaskLifecycleOperation(prepareArchiveTaskOperation(args, store), store, tmux);
  }
  if (archived) {
    assertKnownOptions(rest, new Set(["--reason", "--summary"]));
  } else if (rest.length > 0) {
    throw usageError("Task unarchive requires exactly one task id.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  const actor = process.env.TASKMUX_ROLE === "leader"
    ? "leader"
    : process.env.TASKMUX_ROLE === "operator" ? "operator" : "user";
  const reason = archived ? readOptionalOption(rest, "--reason") : undefined;
  const summary = archived ? readOptionalOption(rest, "--summary") : undefined;
  const updatedTask = updateTaskArchived(task, archived, new Date(), { by: actor, reason, summary });
  store.saveTask(updatedTask);
  if (archived) {
    store.clearPendingWakeup(taskId);
  }
  recordTaskEvent(store, taskId, archived ? "task.archived" : "task.unarchived", {
    ...(reason === undefined ? {} : { reason })
  });
  return `${archived ? "Archived" : "Unarchived"} task ${taskId}\n`;
}

function taskTopicCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (command === "create") {
    const topics = store.getTaskTopics(taskId);
    const topic = createCustomTopic(
      {
        id: readOption(rest, "--id"),
        name: readOption(rest, "--name"),
        description: readOption(rest, "--description"),
        createdBy: "user"
      },
      new Date()
    );

    if (BUILTIN_TOPICS.some(({ id }) => id === topic.id) || topics.customTopics.some(({ id }) => id === topic.id)) {
      throw usageError(`Topic already exists: ${topic.id}`);
    }

    store.saveTaskTopics(taskId, {
      ...topics,
      customTopics: [...topics.customTopics, topic]
    });
    const warning = usesConventionalTopicId(topic.id)
      ? ""
      : "Warning: topic ids conventionally use lower-case kebab-case.\n";
    return `Created topic ${topic.id} for task ${taskId}\n${warning}`;
  }

  if (command === "list" && rest.length === 0) {
    return listTaskTopicsCommand(args, store);
  }

  if (command === "summarize") {
    const topic = readOption(rest, "--topic").trim();
    validateTopicIds(store, taskId, [topic]);
    const summary = readOption(rest, "--summary").trim();
    if (summary.length === 0) {
      throw usageError("Topic summary is required.");
    }
    store.appendTaskTopicSummary(
      taskId,
      `## ${topic}\n\n${summary}\n\n_Updated ${new Date().toISOString()}_\n\n`
    );
    recordTaskEvent(store, taskId, "topic.summary_updated", { topic });
    return `Updated Topic summary ${topic} for task ${taskId}\n`;
  }

  throw usageError("Topic usage: taskmux task topic create|list|summarize <task-id>.");
}

function listTaskTopicsCommand(args: string[], store: TaskReader): string {
  const [command, taskId, ...rest] = args;
  if (command !== "list" || taskId === undefined || rest.length !== 0) {
    throw usageError("Topic usage: taskmux task topic list <task-id>.");
  }
  if (taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const customTopics = store.getTaskTopics(taskId).customTopics;
  const rows = [
    ...BUILTIN_TOPICS.map((topic) => [topic.id, topic.name, "built-in", topic.description]),
    ...customTopics.map((topic) => [topic.id, topic.name, "custom", topic.description])
  ];

  return `${renderTable(
    `Task topics: ${taskId}`,
    [
      { header: "Topic", minWidth: 8, maxWidth: 24 },
      { header: "Name", minWidth: 4, maxWidth: 16 },
      { header: "Scope", minWidth: 7, maxWidth: 8 },
      { header: "Description", minWidth: 11, maxWidth: 44 }
    ],
    rows,
    defaultTableWidth()
  )}\n`;
}

function createTaskCommand(args: string[], store: TaskStore): string {
  const input = parseTaskBoardInput(args, {
    requireTitle: true,
    extraKnownOptions: new Set(["--template", "--agent", "--workspace"])
  });
  const title = input.title ?? "";

  if (title.length === 0) {
    throw usageError("Task title is required.");
  }

  const template = parseTaskTemplate(readOptionalOption(args, "--template"));
  const metadata = template === undefined ? input.metadata : mergeTemplateMetadata(input.metadata, template);
  const task = createTask(store.nextTaskId(), title, new Date(), metadata);
  const config = store.getConfig();
  const explicitAgent = readOptionalOption(args, "--agent")?.trim();
  const defaultAgent = explicitAgent ?? config.defaultAgent;
  const explicitWorkspace = readOptionalOption(args, "--workspace")?.trim();
  const workspace = explicitWorkspace ?? config.defaultWorkspace ?? process.cwd();
  const assignedRoles = uniqueStrings([BUILTIN_LEADER_ROLE, ...(template?.roles ?? [])])
    .map((roleName) => createRoleFromGlobalOrAgent(task.id, roleName, {
      agent: explicitAgent,
      fallbackAgent: defaultAgent,
      workspace,
      workspaceOverride: explicitWorkspace
    }, store));

  store.saveTask(task);
  rememberTask(store, task.id);
  recordTaskEvent(store, task.id, "task.created", { title: task.title });
  assignedRoles.forEach((role) => saveRoleAndRecordEvent(task.id, role, store));
  const leader = assignedRoles.find((role) => role.name === BUILTIN_LEADER_ROLE);
  if (leader !== undefined) {
    const agent = resolveAgent(leader.activeAgentId, store.listConfiguredAgents());
    if (agent === null) throwUnsupportedAgent(leader.activeAgentId, store);
    const reservation = reserveInitialAgentSession(task.id, leader, agent, new Date());
    if (reservation !== null) {
      store.saveRoleSessionSet(reservation);
    }
  }
  if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
    queueLeaderWakeup(store, task.id, "task-created");
  }

  if (template === undefined) {
    return [
      `Created task ${task.id}: ${task.title}`,
      `Assigned roles: ${assignedRoles.map((role) => role.name).join(", ")}`
    ].join("\n").concat("\n");
  }

  return [
    `Created task ${task.id}: ${task.title}`,
    `Template: ${template.name}`,
    `Assigned roles: ${assignedRoles.map((role) => role.name).join(", ")}`
  ].join("\n").concat("\n");
}

function listTaskCommand(args: string[], store: TaskReader): string {
  const filters = parseTaskListFilters(args);
  const tasks = store.listTasks().filter((task) => taskMatchesFilters(task, filters));

  if (tasks.length === 0) {
    return "No tasks found.\n";
  }

  return `${renderTaskListTable(tasks)}\n`;
}

function boardTaskCommand(args: string[], store: TaskReader): string {
  const options = parseTaskBoardViewOptions(args);
  const tasks = store.listTasks().filter((task) => taskMatchesFilters(task, options.filters));

  return renderTaskBoard(tasks, store, options.withRoles);
}

function showTaskCommand(args: string[], store: TaskStore, remember: boolean): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  if (remember) {
    rememberTask(store, task.id);
  }

  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Archived: ${task.archived ? "yes" : "no"}`,
    ...renderTaskMetadataLines(task),
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`
  ].join("\n").concat("\n");
}

function showTaskSnapshot(args: string[], store: TaskReader): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Archived: ${task.archived ? "yes" : "no"}`,
    ...renderTaskMetadataLines(task),
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`
  ].join("\n").concat("\n");
}

function currentTaskCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined) {
    return renderTaskPointer("Current task", store.getConfig().currentTaskId, store);
  }

  if (taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  rememberTask(store, task.id, { current: true });

  return `Current task: ${task.id} ${task.title}\n`;
}

function lastTaskCommand(store: TaskReader): string {
  return renderTaskPointer("Last task", store.getConfig().lastTaskId, store);
}

function cloneTaskCommand(args: string[], store: TaskStore): string {
  const [sourceTaskId, ...rest] = args;

  if (sourceTaskId === undefined || sourceTaskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const sourceTask = store.getTask(sourceTaskId);

  if (sourceTask === null) {
    throw taskNotFound(sourceTaskId);
  }

  assertKnownOptions(rest, new Set(["--title"]));

  const title = readOptionalOption(rest, "--title")?.trim() ?? `${sourceTask.title} copy`;
  const clonedTask = createTask(store.nextTaskId(), title, new Date(), {
    description: sourceTask.description,
    priority: sourceTask.priority,
    tags: sourceTask.tags,
    dueAt: sourceTask.dueAt
  });

  store.saveTask(clonedTask);
  rememberTask(store, clonedTask.id);
  recordTaskEvent(store, clonedTask.id, "task.created", { title: clonedTask.title });
  recordTaskEvent(store, clonedTask.id, "task.cloned", { from: sourceTask.id });

  const roles = store.listRoles(sourceTask.id).map((role) => {
    const clonedRole = createRole(
      clonedTask.id,
      role.name,
      Object.values(role.agentBindings),
      role.activeAgentId,
      role.workspace,
      new Date(),
      {
        description: role.description,
        responsibilities: role.responsibilities,
        constraints: role.constraints,
        expectedOutput: role.expectedOutput,
        systemPrompt: role.systemPrompt,
        skills: role.skills
      }
    );

    store.saveRole(clonedTask.id, clonedRole);
    recordTaskEvent(store, clonedTask.id, "role.assigned", { role: clonedRole.name, agent: clonedRole.activeAgentId });
    return clonedRole.name;
  });

  return [
    `Cloned task ${sourceTask.id} -> ${clonedTask.id}`,
    `Title: ${clonedTask.title}`,
    `Roles: ${roles.length === 0 ? "none" : roles.join(", ")}`
  ].join("\n").concat("\n");
}

function updateTaskCommand(args: string[], store: TaskStore): string {
  const [id, ...rest] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  const input = parseTaskBoardInput(rest, { requireTitle: false, allowTitleOption: true, allowClear: true });
  const patch = input.title === undefined ? input.metadata : { title: input.title, ...input.metadata };

  if (Object.keys(patch).length === 0) {
    throw usageError("At least one task update option is required.");
  }

  const updatedTask = updateTaskMetadata(task, patch, new Date());
  store.saveTask(updatedTask);
  recordTaskEvent(store, updatedTask.id, "task.updated", { title: updatedTask.title });

  return `Updated task ${updatedTask.id}\n`;
}

function openTaskCommand(args: string[], store: TaskStore, remember: boolean): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  if (remember) {
    rememberTask(store, task.id);
  }

  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Archived: ${task.archived ? "yes" : "no"}`,
    ...renderTaskMetadataLines(task),
    `Roles: ${store.listRoles(task.id).length}`,
    `Comments: ${store.listComments(task.id).length}`,
    `Next: taskmux task enter ${task.id} <role>`
  ].join("\n").concat("\n");
}

function openTaskSnapshot(args: string[], store: TaskReader): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Archived: ${task.archived ? "yes" : "no"}`,
    ...renderTaskMetadataLines(task),
    `Roles: ${store.listRoles(task.id).length}`,
    `Comments: ${store.listComments(task.id).length}`,
    `Next: taskmux task enter ${task.id} <role>`
  ].join("\n").concat("\n");
}

function contextTaskCommand(args: string[], store: TaskStore, remember: boolean): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  if (remember) {
    rememberTask(store, task.id);
  }

  const options = parseTaskContextOptions(rest);
  const context = buildTaskContext(task, store, options.includeTranscripts);

  if (options.format === "json") {
    return `${JSON.stringify(context, null, 2)}\n`;
  }

  return renderTaskContextText(context, options.includeTranscripts);
}

function contextTaskSnapshot(args: string[], store: TaskReader): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  const options = parseTaskContextOptions(rest);
  const context = buildTaskContext(task, store, options.includeTranscripts);

  if (options.format === "json") {
    return `${JSON.stringify(context, null, 2)}\n`;
  }

  return renderTaskContextText(context, options.includeTranscripts);
}

function deleteTaskCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  return runTaskLifecycleOperation(prepareDeleteTaskOperation(args, store), store, tmux);
}

function prepareDeleteTaskOperation(
  args: string[],
  store: TaskStore
): TaskLifecycleRuntimeOperationClaim {
  const [taskId, ...rest] = args;
  if (taskId === undefined || taskId.trim().length === 0 || rest.length > 0) {
    throw usageError("Task delete requires exactly one task id.");
  }
  return prepareTaskLifecycleOperation("delete", taskId, store);
}

function restoreTaskCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (!store.restoreTask(taskId)) {
    throw taskNotFound(taskId);
  }

  recordTaskEvent(store, taskId, "task.restored", { task: taskId });

  return `Restored task ${taskId}\n`;
}

function taskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const [command, ...rest] = args;

  switch (command) {
    case "child":
      return createTaskChildRoleCommand(rest, store);
    case "update":
      return updateTaskRoleCommand(rest, store, tmux);
    case "rename":
      return renameTaskRoleCommand(rest, store, tmux);
    case "remove":
      return removeTaskRoleCommand(rest, store, tmux);
    default:
      throw usageError(command === undefined ? "Task role command is required." : `Unknown command: task role ${command}`);
  }
}

function removeTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  return runTaskLifecycleOperation(prepareRemoveTaskRoleOperation(args, store), store, tmux);
}

function prepareRemoveTaskRoleOperation(
  args: string[],
  store: TaskStore
): TaskLifecycleRuntimeOperationClaim {
  const [taskId, roleName, ...rest] = args;
  if (taskId === undefined || roleName === undefined || rest.length > 0) {
    throw usageError("Role remove usage: taskmux task role remove <task-id> <role>.");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }
  if (roleName === BUILTIN_LEADER_ROLE) {
    throw usageError("The task leader role cannot be removed.");
  }
  if (roleName === BUILTIN_LEADER_ROLE) {
    throw usageError("The task leader role cannot be removed.");
  }
  if (store.getRole(taskId, roleName) === null) throw roleNotFound(roleName);
  return prepareTaskLifecycleOperation("role-remove", taskId, store, { targetRoleName: roleName });
}

function createTaskChildRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (roleName === undefined || roleName.trim().length === 0) {
    throw usageError("Child role name is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  assertKnownOptions(rest, new Set([
    "--parent",
    "--description",
    "--responsibility",
    "--constraint",
    "--expected-output"
  ]));

  const parentRole = readOptionalOption(rest, "--parent")?.trim() ?? BUILTIN_LEADER_ROLE;

  if (store.getRole(taskId, parentRole) === null) {
    throw roleNotFound(parentRole);
  }

  if (store.getRole(taskId, roleName) !== null || store.getChildRole(taskId, roleName) !== null) {
    throw usageError(`Role already exists: ${roleName}.`);
  }

  const childRole = createChildRole(
    roleName,
    parentRole,
    {
      description: readOption(rest, "--description"),
      responsibilities: readRepeatedOption(rest, "--responsibility"),
      constraints: readRepeatedOption(rest, "--constraint"),
      expectedOutput: readOption(rest, "--expected-output")
    },
    new Date()
  );
  store.saveChildRole(taskId, childRole);
  recordTaskEvent(store, taskId, "child-role.created", {
    role: childRole.name,
    parent: childRole.parentRole
  });

  return `Created child role ${childRole.name} for parent ${childRole.parentRole}\n`;
}

function assignTaskRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (roleName === undefined || roleName.trim().length === 0) {
    throw usageError("Role name is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const parsed = parseRoleCommandOptions(rest, TASK_ASSIGN_OPTIONS, {
    profileInheritableFields: ROLE_PROFILE_INHERITABLE_FIELDS
  });
  assertRoleSystemPromptSelection(parsed);
  const agent = requiredRoleOption(parsed.value("--agent"), "--agent");
  const workspace = requireWorkspace(
    parsed.value("--workspace")?.trim() ?? store.getConfig().defaultWorkspace
  );
  const targetName = parsed.value("--as")?.trim() ?? roleName;
  assertTaskRoleAssignable(taskId, targetName, store);
  const resolvedAgent = resolveAgent(agent, store.listConfiguredAgents());
  if (resolvedAgent === null) throwUnsupportedAgent(agent, store);
  const binding = parsed.createBinding(resolvedAgent, workspace);
  const role = createRole(taskId, targetName, [binding], binding.agentId, workspace, new Date(), {
    ...(parsed.value("--system-prompt") === undefined
      ? {}
      : { systemPrompt: parsed.value("--system-prompt")?.trim() })
  });

  saveRoleAndRecordEvent(taskId, role, store);

  return [
    `Assigned role ${role.name} to ${taskId}`,
    `Agent: ${agent}`,
    `Workspace: ${role.workspace}`
  ].join("\n").concat("\n");
}

function bindTaskRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;
  if (taskId === undefined || taskId.trim().length === 0) throw usageError("Task id is required.");
  if (roleName === undefined || roleName.trim().length === 0) throw usageError("Role name is required.");
  if (store.getTask(taskId) === null) throw taskNotFound(taskId);

  const parsed = parseRoleCommandOptions(rest, TASK_BIND_OPTIONS, { allowStructured: false });
  const workspace = parsed.value("--workspace")?.trim();
  const targetName = parsed.value("--as")?.trim() ?? roleName;
  const role = copyGlobalRole(taskId, roleName, store, { name: targetName, workspaceOverride: workspace });
  saveRoleAndRecordEvent(taskId, role, store);
  return [
    `Bound role ${role.name} to ${taskId}`,
    `Source role: ${roleName}`,
    `Agent: ${role.activeAgentId}`,
    `Workspace: ${role.workspace}`
  ].join("\n").concat("\n");
}

function assignManyTaskRolesCommand(args: string[], store: TaskStore): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const parsed = parseRoleCommandOptions(rest, TASK_ASSIGN_MANY_OPTIONS, {
    profileInheritableFields: ROLE_PROFILE_INHERITABLE_FIELDS
  });
  assertRoleSystemPromptSelection(parsed);
  const roleNames = parsed.values("--role").map((role) => role.trim()).filter((role) => role.length > 0);

  if (roleNames.length === 0) {
    throw usageError("At least one --role is required.");
  }
  if (new Set(roleNames).size !== roleNames.length) {
    throw usageError("Role names in assign-many must be unique.");
  }
  const existingRole = roleNames.find((roleName) =>
    store.getRole(taskId, roleName) !== null || store.getChildRole?.(taskId, roleName) != null);
  if (existingRole !== undefined) {
    throw roleConflict(existingRole);
  }

  const requestedRoleNames = new Set<string>();
  roleNames.forEach((roleName) => {
    if (requestedRoleNames.has(roleName)) {
      throwTaskRoleAlreadyExists(taskId, roleName);
    }
    requestedRoleNames.add(roleName);
    assertTaskRoleAssignable(taskId, roleName, store);
  });
  const agentId = requiredRoleOption(parsed.value("--agent"), "--agent");
  const workspace = requireWorkspace(
    parsed.value("--workspace")?.trim() ?? store.getConfig().defaultWorkspace
  );
  const agent = resolveAgent(agentId, store.listConfiguredAgents());
  if (agent === null) throwUnsupportedAgent(agentId, store);
  const binding = parsed.createBinding(agent, workspace);
  const roles = roleNames.map((roleName) => createRole(
    taskId,
    roleName,
    [createRoleAgentBinding(agent, binding.config)],
    agent.id,
    workspace,
    new Date(),
    {
      ...(parsed.value("--system-prompt") === undefined
        ? {}
        : { systemPrompt: parsed.value("--system-prompt")?.trim() })
    }
  ));

  for (const role of roles) saveRoleAndRecordEvent(taskId, role, store);

  return `Assigned roles to ${taskId}: ${roles.map((role) => role.name).join(", ")}\n`;
}

function updateTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (roleName === undefined || roleName.trim().length === 0) {
    throw usageError("Role name is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }
  const parsed = parseRoleCommandOptions(rest, TASK_ROLE_UPDATE_OPTIONS, {
    profileInheritableFields: ROLE_PROFILE_INHERITABLE_FIELDS
  });
  assertExpectedRoleRevision(role, parsed.value(ROLE_EXPECT_UPDATED_AT_OPTION));
  assertRoleSystemPromptSelection(parsed);
  const agent = parsed.value("--agent")?.trim();
  const activeAgentId = parsed.value("--active-agent")?.trim();
  const workspace = parsed.value("--workspace")?.trim();
  const patch: Partial<Pick<Role, "activeAgentId" | "agentBindings" | "workspace">> = {};
  let switchedSessions: TaskRoleSessionSet | null = null;
  let expectedSessionSet: TaskRoleSessionSet | null = null;
  const profileChanged = parsed.has("--system-prompt") || parsed.inherits("systemPrompt");
  let nextBindings = role.agentBindings;

  if (agent !== undefined) {
    if (agent.length === 0) {
      throw usageError("--agent is required.");
    }
    const resolvedAgent = resolveAgent(agent, store.listConfiguredAgents());

    if (resolvedAgent === null) {
      throw usageError(`Unsupported agent: ${agent}\nSupported agents: ${supportedAgentIds(store.listConfiguredAgents()).join(", ")}`);
    }

    nextBindings = {
      ...role.agentBindings,
      [resolvedAgent.id]: parsed.createBinding(
        resolvedAgent,
        workspace ?? role.workspace,
        role.agentBindings[resolvedAgent.id]
      )
    };
    patch.agentBindings = nextBindings;
    patch.activeAgentId = resolvedAgent.id;
  } else if (parsed.hasStructuredChanges) {
    const targetAgentId = activeAgentId ?? role.activeAgentId;
    if (role.agentBindings[targetAgentId] === undefined) {
      throw usageError(`Role agent is not bound: ${targetAgentId}.`);
    }
    const activeAgent = resolveAgent(targetAgentId, store.listConfiguredAgents());
    if (activeAgent === null) throwUnsupportedAgent(targetAgentId, store);
    nextBindings = {
      ...nextBindings,
      [activeAgent.id]: parsed.createBinding(
        activeAgent,
        workspace ?? role.workspace,
        role.agentBindings[activeAgent.id]
      )
    };
    patch.agentBindings = nextBindings;
  }

  if (activeAgentId !== undefined) {
    if (nextBindings[activeAgentId] === undefined) throw usageError(`Role agent is not bound: ${activeAgentId}.`);
    patch.activeAgentId = activeAgentId;
  }

  if (workspace !== undefined) {
    if (workspace.length === 0) {
      throw usageError("--workspace is required.");
    }

    patch.workspace = workspace;
  }

  if (Object.keys(patch).length === 0 && !profileChanged) {
    throw usageError("At least one role update option is required.");
  }

  const profiledRole = applyRoleSystemPrompt(
    role,
    parsed.value("--system-prompt"),
    parsed.inherits("systemPrompt")
  );
  let updatedRole = updateRole(profiledRole, { ...patch, activeAgentId: role.activeAgentId }, new Date());
  const targetAgentId = patch.activeAgentId;
  let switchEvent: ReturnType<typeof switchActiveRoleAgent>["event"] | null = null;
  if (targetAgentId !== undefined && targetAgentId !== role.activeAgentId) {
    if (tmux === undefined) {
      throw usageError("Tmux manager is required to switch a TaskRole Agent.");
    }
    try {
      expectedSessionSet = store.getRoleSessionSet(taskId, roleName);
      const switched = switchActiveRoleAgent(
        updatedRole,
        expectedSessionSet ?? createRoleSessionSet(
          { scope: "task", taskId, roleName },
          role.activeAgentId,
          new Date()
        ),
        targetAgentId,
        {
          activeRun: store.getActiveAgentRun(taskId, roleName) !== null,
          nativeProcessRunning: tmux.probeRoleStatus(taskId, roleName) === "running"
        },
        new Date()
      );
      updatedRole = switched.role;
      if (switched.sessions.owner.scope !== "task") {
        throw new Error(`Role session owner is not task-scoped: ${roleName}.`);
      }
      switchedSessions = switched.sessions as TaskRoleSessionSet;
      switchEvent = switched.event;
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
  }
  const storedRole = switchedSessions === null
    ? store.compareAndSwapRole(taskId, role.updatedAt, updatedRole)
    : store.compareAndSwapRoleWithSessionSet(
        taskId,
        role.updatedAt,
        expectedSessionSet,
        updatedRole,
        switchedSessions
      );
  if (storedRole === null) throw roleConflict(role.name);
  if (switchEvent !== null) recordTaskEvent(store, taskId, switchEvent.type, switchEvent.payload);
  recordTaskEvent(store, taskId, "role.updated", { role: storedRole.name });

  return `Updated role ${storedRole.name} for ${taskId}\n`;
}

function assertExpectedRoleRevision(role: Role, expected: string | undefined): void {
  if (expected !== undefined && role.updatedAt !== expected) {
    throw roleConflict(role.name);
  }
}

function assertNoRoleRuntimeOperationClaim(store: TaskStore, taskId: string, roleName: string): void {
  if (typeof store.rootDirectory !== "function") return;
  if (readRoleRuntimeOperationClaim(store.rootDirectory(), taskId, roleName) !== null) {
    throw usageError(`${taskId}/${roleName} is owned by a durable Role runtime operation claim.`);
  }
}

function assertTaskCommandRuntimeAuthority(
  command: string | undefined,
  args: string[],
  store: TaskStore
): void {
  const taskWideCommands = new Set(["archive", "unarchive", "delete", "refresh", "cleanup"]);
  if (command !== undefined && taskWideCommands.has(command)) {
    const taskId = args[0];
    if (taskId === undefined || store.getTask(taskId) === null) return;
    for (const role of store.listRoles(taskId)) {
      assertNoRoleRuntimeOperationClaim(store, taskId, role.name);
    }
    return;
  }

  let taskId: string | undefined;
  let roleName: string | undefined;
  if (["enter", "status", "detach", "stop", "kill", "restart", "dispatch", "yield"].includes(command ?? "")) {
    [taskId, roleName] = args;
  } else if (command === "session") {
    [, taskId, roleName] = args;
  } else if (command === "worktree") {
    [, taskId, roleName] = args;
  } else if (command === "role" && ["update", "rename", "remove"].includes(args[0] ?? "")) {
    [, taskId, roleName] = args;
  }
  if (
    taskId === undefined || roleName === undefined ||
    store.getTask(taskId) === null || store.getRole(taskId, roleName) === null
  ) {
    return;
  }
  assertNoRoleRuntimeOperationClaim(store, taskId, roleName);
}

function renameTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  return runTaskLifecycleOperation(prepareRenameTaskRoleOperation(args, store), store, tmux);
}

function prepareRenameTaskRoleOperation(
  args: string[],
  store: TaskStore
): TaskLifecycleRuntimeOperationClaim {
  const [taskId, oldName, newName] = args;
  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }
  if (oldName === undefined || oldName.trim().length === 0) {
    throw usageError("Role name is required.");
  }
  if (newName === undefined || newName.trim().length === 0) {
    throw usageError("New role name is required.");
  }
  if (oldName === BUILTIN_LEADER_ROLE || newName.trim() === BUILTIN_LEADER_ROLE) {
    throw usageError("Built-in leader role cannot be renamed.");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }
  if (oldName === BUILTIN_LEADER_ROLE || newName.trim() === BUILTIN_LEADER_ROLE) {
    throw usageError("Built-in leader role cannot be renamed.");
  }
  if (store.getTask(taskId) === null) throw taskNotFound(taskId);
  if (store.getRole(taskId, oldName) === null) throw roleNotFound(oldName);
  return prepareTaskLifecycleOperation("role-rename", taskId, store, {
    targetRoleName: oldName,
    newRoleName: newName
  });
}

function stopTaskRuntime(
  taskId: string,
  store: TaskStore,
  tmux: TmuxManager | undefined,
  reason: string
): void {
  for (const role of store.listRoles(taskId)) {
    stopRoleRuntime(taskId, role, store, tmux, reason);
  }
}

function stopRoleRuntime(
  taskId: string,
  role: Role,
  store: TaskStore,
  tmux: TmuxManager | undefined,
  reason: string
): void {
  if (tmux === undefined) throw runtimeError("Tmux manager is not configured.");
  tmux.killRoleAndConfirmStopped(taskId, role.name);
  const now = new Date();
  const activeRun = store.getActiveAgentRun(taskId, role.name);
  if (activeRun !== null) {
    store.saveAgentRun(failAgentRun(activeRun, reason, now));
    store.clearActiveAgentRun(taskId, role.name);
  }
  store.saveRole(taskId, updateRoleStatus(role, "exited", now));
  const sessionSet = store.getRoleSessionSet(taskId, role.name);
  if (sessionSet !== null && sessionSet.sessions[role.activeAgentId] !== undefined) {
    store.saveRoleSessionSet(updateRoleAgentSessionStatus(sessionSet, role.activeAgentId, "stopped", now));
  }
}

function listTaskRolesCommand(args: string[], store: TaskReader): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const roles = store.listRoles(taskId);

  if (roles.length === 0) {
    return "No roles assigned.\n";
  }

  return `${renderRoleTable(`Task roles: ${taskId}`, roles)}\n`;
}

function enterTaskRoleCommand(
  args: string[],
  store: TaskStore,
  tmux: TmuxManager | undefined,
  persistStatus: boolean,
  onRoleLaunchStarted?: (session: RoleAgentSession | null) => void
): string {
  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }
  if (store instanceof FileTaskStore && hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    throw runtimeError("Role attach must run as a post-commit effect.");
  }

  const prepared = prepareTaskRoleEnter(args, store);
  if (!(store instanceof FileTaskStore)) {
    tmux.ensureRoleWindow(prepared.taskId, prepared.role, prepared.launch, {
      onStarted: () => {
        if (persistStatus) {
          persistPreparedRoleLaunch(prepared.taskId, prepared.role, prepared.session, store);
        }
        onRoleLaunchStarted?.(prepared.session);
      }
    });
    tmux.attachRole(prepared.taskId, prepared.role.name);
    return `Attached role ${prepared.role.name} for ${prepared.taskId}\n`;
  }

  const rootDir = store.rootDirectory();
  recoverTaskRoleRuntimeOperations(rootDir, tmux);
  const claim = createTaskRoleEnterRuntimeClaim(prepared);
  claimPreparedTaskRoleEnter(rootDir, prepared, claim);
  let created = false;
  try {
    created = tmux.ensureRoleWindow(prepared.taskId, prepared.role, prepared.launch, {
      launchToken: claim.token
    });
    if (created) {
      commitPreparedTaskRoleEnter(rootDir, prepared, claim);
      onRoleLaunchStarted?.(prepared.session);
    } else {
      releaseRoleRuntimeOperationClaim(
        rootDir,
        `task-enter-existing-release-${randomUUID()}`,
        claim
      );
    }
  } catch (error) {
    const outcome = reconcilePreparedTaskRoleEnter(prepared, claim, new FileTaskStore(rootDir), tmux);
    if (outcome !== "committed") {
      if (created) {
        tmux.killRoleLaunchAndConfirmStopped(prepared.taskId, prepared.role.name, claim.token);
      }
      const currentClaim = readRoleRuntimeOperationClaim(rootDir, prepared.taskId, prepared.role.name);
      if (currentClaim?.token === claim.token && currentClaim.recoveryToken === null) {
        releaseRoleRuntimeOperationClaim(
          rootDir,
          `task-enter-failed-release-${randomUUID()}`,
          claim
        );
      }
    }
    throw error;
  }
  tmux.attachRole(prepared.taskId, prepared.role.name);

  return `Attached role ${prepared.role.name} for ${prepared.taskId}\n`;
}

export type PreparedTaskRoleEnter = {
  taskId: string;
  role: Role;
  launch: import("../executor/launchPlan.js").AgentLaunchPlan;
  session: RoleAgentSession | null;
  sessionSet: TaskRoleSessionSet | null;
  activeRun: AgentRun | null;
  expectedStateDigest: string;
};

export function prepareTaskRoleEnter(args: string[], store: TaskStore): PreparedTaskRoleEnter {
  const roleLookup = findRole(args, store);
  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }
  const sessionSet = store.getRoleSessionSet(roleLookup.taskId, roleLookup.role.name);
  const activeRun = store.getActiveAgentRun(roleLookup.taskId, roleLookup.role.name);
  const prepared = prepareRoleWindowLaunch(roleLookup.taskId, roleLookup.role, store, sessionSet);
  return {
    taskId: roleLookup.taskId,
    role: roleLookup.role,
    launch: prepared.launch,
    session: prepared.session,
    sessionSet,
    activeRun,
    expectedStateDigest: roleRuntimeStateDigest({
      role: roleLookup.role,
      sessionSet,
      activeRun,
      selectedWorkItem: null,
      pendingRun: null
    })
  };
}

export function createTaskRoleEnterRuntimeClaim(
  prepared: PreparedTaskRoleEnter,
  now = new Date()
): RoleLaunchRuntimeOperationClaim {
  return {
    schemaVersion: 1,
    scope: "task-role",
    kind: "launch",
    token: randomUUID(),
    taskId: prepared.taskId,
    roleName: prepared.role.name,
    operation: "enter",
    ownerPid: process.pid,
    preparedSession: prepared.session,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: prepared.expectedStateDigest,
    recoveryToken: null,
    ...createRoleRuntimeOperationLease(now)
  };
}

export function claimPreparedTaskRoleEnter(
  rootDir: string,
  prepared: PreparedTaskRoleEnter,
  claim: RoleLaunchRuntimeOperationClaim
): void {
  claimRoleRuntimeOperation(
    rootDir,
    `task-enter-claim-${randomUUID()}`,
    claim,
    (workingRoot) => roleRuntimeStateDigest(readRoleRuntimeStateSnapshot(
      transactionTaskStore(workingRoot),
      prepared.taskId,
      prepared.role.name
    ))
  );
}

export function commitPreparedTaskRoleEnter(
  rootDir: string,
  prepared: PreparedTaskRoleEnter,
  claim: RoleLaunchRuntimeOperationClaim,
  transactionId = `task-enter-commit-${randomUUID()}`,
  extraResultOperations: (result: void) => import("../storage/recoveryJournal.js").DomainTransactionOperation[] = () => []
): void {
  executeDomainTransaction(rootDir, transactionId, (workingRoot) => {
    const transactionStore = transactionTaskStore(workingRoot, claim.token);
    if (
      roleRuntimeStateDigest(readRoleRuntimeStateSnapshot(
        transactionStore,
        prepared.taskId,
        prepared.role.name
      )) !== prepared.expectedStateDigest
    ) {
      throw roleConflict(`${prepared.taskId}/${prepared.role.name}`);
    }
    recordTaskRoleAttached(
      prepared.taskId,
      prepared.role.name,
      transactionStore,
      claim.preparedSession
    );
    clearRoleRuntimeOperationClaim(
      workingRoot,
      claim.taskId,
      claim.roleName,
      claim.token
    );
  }, extraResultOperations);
}

export function reconcilePreparedTaskRoleEnter(
  prepared: PreparedTaskRoleEnter,
  claim: RoleLaunchRuntimeOperationClaim,
  store: TaskStore,
  tmux: Pick<TmuxManager, "roleLaunchToken">
): "committed" | "pending" | "recovering" | "uncommitted" {
  const currentClaim = store instanceof FileTaskStore
    ? readRoleRuntimeOperationClaim(store.rootDirectory(), prepared.taskId, prepared.role.name)
    : null;
  if (currentClaim?.token === claim.token) {
    return currentClaim.recoveryToken === null ? "pending" : "recovering";
  }
  const currentState = readRoleRuntimeStateSnapshot(store, prepared.taskId, prepared.role.name);
  const currentRole = currentState.role;
  if (currentRole === null || tmux.roleLaunchToken(prepared.taskId, prepared.role.name) !== claim.token) {
    return "uncommitted";
  }
  const committedAt = new Date(currentRole.updatedAt);
  if (!Number.isFinite(committedAt.getTime())) return "uncommitted";
  const expected = buildPreparedRoleLaunchState(
    prepared.role,
    prepared.session,
    prepared.sessionSet,
    prepared.activeRun,
    committedAt
  );
  return roleRuntimeStateDigest(currentState) === roleRuntimeStateDigest(expected)
    ? "committed"
    : "uncommitted";
}

export function recordTaskRoleAttached(
  taskId: string,
  roleName: string,
  store: TaskStore,
  preparedSession: RoleAgentSession | null = null
): void {
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }
  const role = store.getRole(taskId, roleName);
  if (role === null) {
    throw roleNotFound(roleName);
  }
  if (preparedSession !== null) {
    const binding = activeRoleAgentBinding(role);
    if (preparedSession.agentId !== role.activeAgentId || preparedSession.adapterId !== binding.adapterId) {
      throw usageError("Prepared Role Agent session does not match the active Role binding.");
    }
    const existing = store.getRoleSessionSet(taskId, roleName)?.sessions[role.activeAgentId];
    if (existing !== undefined && existing.nativeSessionId !== preparedSession.nativeSessionId) {
      throw usageError("Prepared Role Agent session does not match the owned native session.");
    }
  }
  persistPreparedRoleLaunch(taskId, role, preparedSession, store);
}

function tailTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  return tmux.captureRole(roleLookup.taskId, roleLookup.role.name);
}

function transcriptTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  if (args[0] === "export") {
    return exportTranscriptCommand(args.slice(1), store);
  }

  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  const transcript = tmux.captureRole(roleLookup.taskId, roleLookup.role.name);
  store.saveTranscript(roleLookup.taskId, roleLookup.role.name, transcript);

  return transcript;
}

function exportTranscriptCommand(args: string[], store: TaskStore): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  const rest = args.slice(2);
  assertKnownOptions(rest, new Set(["--format", "--output"]));

  const format = parseTranscriptExportFormat(readOptionalOption(rest, "--format"));
  const transcript = store.readTranscript(roleLookup.taskId, roleLookup.role.name);

  if (transcript === null) {
    return "No transcript captured.\n";
  }

  const rendered = renderTranscriptExport(roleLookup.taskId, roleLookup.role.name, transcript, format);
  const output = readOptionalOption(rest, "--output")?.trim();

  if (output !== undefined && output.length > 0) {
    if (store instanceof FileTaskStore) {
      assertPathOutsideTaskmuxHome(
        output,
        store.rootDirectory(),
        "Transcript export output"
      );
    }
    writeTextFileAtomically(canonicalProspectivePath(output), rendered);
    return `Exported transcript ${roleLookup.taskId} ${roleLookup.role.name} to ${output}\n`;
  }

  return rendered;
}

function detailTaskRoleCommand(args: string[], store: TaskReader): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  const role = roleLookup.role;

  return [
    `Task: ${roleLookup.taskId}`,
    `Role: ${role.name}`,
    `Agent: ${role.activeAgentId}`,
    `Workspace: ${role.workspace}`,
    `Status: ${role.status}`,
    `Tmux: taskmux-${roleLookup.taskId}:${role.name}`,
    `Created: ${role.createdAt}`,
    `Updated: ${role.updatedAt}`
  ].join("\n").concat("\n");
}

function refreshTaskRolesCommand(
  args: string[],
  store: TaskStore,
  tmux: TmuxManager | undefined,
  action: string
): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  const roles = store.listRoles(taskId);

  if (roles.length === 0) {
    return `${action} task ${taskId} roles\nNo roles assigned.\n`;
  }

  const currentRoles = roles.map((role) => {
    const status = tmux.detectRoleStatus(taskId, role.name, role.status);
    const currentRole = status === role.status ? role : updateRoleStatus(role, status, new Date());

    if (currentRole !== role) {
      store.saveRole(taskId, currentRole);
    }

    return currentRole;
  });

  return `${renderTable(
    `${action} task ${taskId} roles`,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Status", minWidth: 6, maxWidth: 12 }
    ],
    currentRoles.map((role) => [role.name, role.status]),
    defaultTableWidth()
  )}\n`;
}

function statusTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  const role = roleLookup.role;
  const status = tmux?.detectRoleStatus(roleLookup.taskId, role.name, role.status) ?? role.status;
  const currentRole = status === role.status ? role : updateRoleStatus(role, status, new Date());

  if (currentRole !== role) {
    store.saveRole(roleLookup.taskId, currentRole);
  }

  return [
    `Task: ${roleLookup.taskId}`,
    `Role: ${currentRole.name}`,
    `Agent: ${currentRole.activeAgentId}`,
    `Workspace: ${currentRole.workspace}`,
    `Status: ${currentRole.status}`,
    `Tmux: taskmux-${roleLookup.taskId}:${currentRole.name}`,
    `Created: ${currentRole.createdAt}`,
    `Updated: ${currentRole.updatedAt}`
  ].join("\n").concat("\n");
}

function detachTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  return runTaskLifecycleOperation(prepareDetachTaskRoleOperation(args, store), store, tmux);
}

function prepareDetachTaskRoleOperation(
  args: string[],
  store: TaskStore
): TaskLifecycleRuntimeOperationClaim {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  return prepareTaskLifecycleOperation("role-detach", roleLookup.taskId, store, {
    targetRoleName: roleLookup.role.name
  });
}

function restartTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  return runTaskRoleControlCommand("restart", args, store, tmux);
}

function stopTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  return runTaskRoleControlCommand("stop", args, store, tmux);
}

function killTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  return runTaskRoleControlCommand("kill", args, store, tmux);
}

export type PreparedTaskRoleControl = {
  action: "stop" | "kill" | "restart";
  taskId: string;
  role: Role;
  sessionSet: TaskRoleSessionSet | null;
  activeRun: AgentRun | null;
  expectedStateDigest: string;
  launch: import("../executor/launchPlan.js").AgentLaunchPlan | null;
  preparedSession: RoleAgentSession | null;
};

export function prepareTaskRoleControl(
  action: PreparedTaskRoleControl["action"],
  args: string[],
  store: TaskStore
): PreparedTaskRoleControl {
  const roleLookup = findRole(args, store);
  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }
  const sessionSet = store.getRoleSessionSet(roleLookup.taskId, roleLookup.role.name);
  const activeRun = store.getActiveAgentRun(roleLookup.taskId, roleLookup.role.name);
  const restart = action === "restart"
    ? prepareRoleWindowLaunch(roleLookup.taskId, roleLookup.role, store, sessionSet)
    : null;
  return {
    action,
    taskId: roleLookup.taskId,
    role: roleLookup.role,
    sessionSet,
    activeRun,
    expectedStateDigest: roleRuntimeStateDigest({
      role: roleLookup.role,
      sessionSet,
      activeRun,
      selectedWorkItem: null,
      pendingRun: null
    }),
    launch: restart?.launch ?? null,
    preparedSession: restart?.session ?? null
  };
}

export function createTaskRoleControlClaim(
  prepared: PreparedTaskRoleControl,
  targetLaunchToken: string | null = null,
  now = new Date()
): RoleStopRuntimeOperationClaim {
  return {
    schemaVersion: 1,
    scope: "task-role",
    kind: prepared.action === "restart" ? "restart" : "stop",
    token: randomUUID(),
    taskId: prepared.taskId,
    roleName: prepared.role.name,
    operation: prepared.action === "restart"
      ? "manual-restart"
      : prepared.action === "kill" ? "manual-kill" : "manual-stop",
    ownerPid: process.pid,
    preparedSession: prepared.action === "restart" ? prepared.preparedSession : null,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: prepared.expectedStateDigest,
    recoveryToken: null,
    ...createRoleRuntimeOperationLease(now),
    phase: "prepared",
    targetLaunchToken,
    preparedRole: prepared.role,
    restartLaunch: prepared.action === "restart" ? prepared.launch : null
  };
}

export function claimPreparedTaskRoleControl(
  rootDir: string,
  prepared: PreparedTaskRoleControl,
  claim: RoleStopRuntimeOperationClaim
): void {
  claimRoleRuntimeOperation(
    rootDir,
    `task-${prepared.action}-claim-${randomUUID()}`,
    claim,
    (workingRoot) => roleRuntimeStateDigest(readRoleRuntimeStateSnapshot(
      transactionTaskStore(workingRoot),
      prepared.taskId,
      prepared.role.name
    ))
  );
}

export function executeTaskRoleControlEffect(
  prepared: PreparedTaskRoleControl,
  claim: RoleStopRuntimeOperationClaim,
  tmux: TmuxManager
): boolean {
  return replayTaskRoleControlEffect(claim, tmux) === "replacement-ready";
}

export function replayTaskRoleControlEffect(
  claim: RoleStopRuntimeOperationClaim,
  tmux: Pick<
    TmuxManager,
    "probeRoleStatus" | "roleLaunchToken" | "roleOperationToken" |
    "stopRoleWithOperationToken" | "killRoleWithOperationToken" |
    "killRoleForRestartWithOperationToken" | "ensureRoleWindow"
  >
): "stopped" | "replacement-ready" {
  const status = tmux.probeRoleStatus(claim.taskId, claim.roleName);
  if (claim.kind === "stop") {
    if (status === "exited") return "stopped";
    const operationToken = tmux.roleOperationToken(claim.taskId, claim.roleName);
    const launchToken = tmux.roleLaunchToken(claim.taskId, claim.roleName);
    if (operationToken !== null && operationToken !== claim.token) {
      throw runtimeError(`Role control encountered a window owned by another operation: ${claim.roleName}.`);
    }
    if (operationToken !== claim.token && launchToken !== claim.targetLaunchToken) {
      throw runtimeError(`Role control target window changed before recovery: ${claim.roleName}.`);
    }
    if (claim.operation === "manual-stop") {
      tmux.stopRoleWithOperationToken(claim.taskId, claim.roleName, claim.token);
    } else {
      tmux.killRoleWithOperationToken(claim.taskId, claim.roleName, claim.token);
    }
    return "stopped";
  }

  if (status === "running") {
    const launchToken = tmux.roleLaunchToken(claim.taskId, claim.roleName);
    if (launchToken === claim.token) return "replacement-ready";
    const operationToken = tmux.roleOperationToken(claim.taskId, claim.roleName);
    if (operationToken !== null && operationToken !== claim.token) {
      throw runtimeError(`Role restart encountered a window owned by another operation: ${claim.roleName}.`);
    }
    if (operationToken !== claim.token && launchToken !== claim.targetLaunchToken) {
      throw runtimeError(`Role restart target window changed before recovery: ${claim.roleName}.`);
    }
    tmux.killRoleForRestartWithOperationToken(claim.taskId, claim.roleName, claim.token);
  }
  if (claim.restartLaunch === null) throw runtimeError("Restart launch plan is missing.");
  const created = tmux.ensureRoleWindow(claim.taskId, claim.preparedRole, claim.restartLaunch, {
    launchToken: claim.token
  });
  if (!created && tmux.roleLaunchToken(claim.taskId, claim.roleName) !== claim.token) {
    throw runtimeError(`Role restart could not establish a token-owned replacement window: ${claim.roleName}.`);
  }
  return "replacement-ready";
}

export function recoverTaskRoleControlOperation(
  recovered: RoleStopRuntimeOperationClaim,
  tmux: Pick<
    TmuxManager,
    "probeRoleStatus" | "roleLaunchToken" | "roleOperationToken" |
    "stopRoleWithOperationToken" | "killRoleWithOperationToken" |
    "killRoleForRestartWithOperationToken" | "ensureRoleWindow"
  >,
  finalize: (claim: RoleStopRuntimeOperationClaim) => void
): "release" | "finalized" {
  if (recovered.recoveryToken === null) {
    throw runtimeError(`Recovered Role control is missing recovery ownership: ${recovered.roleName}.`);
  }
  if (recovered.phase === "prepared") return "release";
  replayTaskRoleControlEffect(recovered, tmux);
  finalize(recovered);
  return "finalized";
}

export function recoverTaskRoleRuntimeOperation(
  recovered: RoleRuntimeOperationClaim,
  tmux: Pick<
    TmuxManager,
    "killRoleLaunchAndConfirmStopped" | "probeRoleStatus" | "roleLaunchToken" |
    "roleOperationToken" | "stopRoleWithOperationToken" | "killRoleWithOperationToken" |
    "killRoleForRestartWithOperationToken" | "ensureRoleWindow"
  >,
  finalize: (claim: RoleStopRuntimeOperationClaim) => void
): "release" | "finalized" {
  if (recovered.kind === "launch") {
    tmux.killRoleLaunchAndConfirmStopped(recovered.taskId, recovered.roleName, recovered.token);
    return "release";
  }
  return recoverTaskRoleControlOperation(recovered, tmux, finalize);
}

export function recoverTaskRoleRuntimeOperations(
  rootDir: string,
  tmux: TmuxManager,
  now = new Date()
): string[] {
  return recoverAbandonedRoleRuntimeOperations(rootDir, (recovered) => {
    const outcome = recoverTaskRoleRuntimeOperation(recovered, tmux, (ownedClaim) => {
      const recoveryToken = ownedClaim.recoveryToken;
      if (recoveryToken === null) {
        throw runtimeError(`Recovered Role control is missing recovery ownership: ${ownedClaim.roleName}.`);
      }
      executeDomainTransaction(rootDir, `task-control-recovery-finalize-${randomUUID()}`, (workingRoot) => {
        const currentClaim = readRoleRuntimeOperationClaim(
          workingRoot,
          ownedClaim.taskId,
          ownedClaim.roleName
        );
        if (
          currentClaim === null ||
          currentClaim.kind === "launch" ||
          currentClaim.token !== ownedClaim.token ||
          currentClaim.recoveryToken !== recoveryToken ||
          currentClaim.phase !== "effect-started"
        ) {
          throw runtimeError(`Role control recovery lost ownership: ${ownedClaim.taskId}/${ownedClaim.roleName}.`);
        }
        const transactionStore = transactionTaskStore(
          workingRoot,
          ownedClaim.token,
          recoveryToken
        );
        const snapshot = readRoleRuntimeStateSnapshot(
          transactionStore,
          ownedClaim.taskId,
          ownedClaim.roleName
        );
        if (snapshot.role === null || roleRuntimeStateDigest(snapshot) !== ownedClaim.expectedStateDigest) {
          throw roleConflict(`${ownedClaim.taskId}/${ownedClaim.roleName}`);
        }
        const action: PreparedTaskRoleControl["action"] = ownedClaim.kind === "restart"
          ? "restart"
          : ownedClaim.operation === "manual-stop" ? "stop" : "kill";
        persistTaskRoleControl({
          action,
          taskId: ownedClaim.taskId,
          role: ownedClaim.preparedRole,
          sessionSet: snapshot.sessionSet,
          activeRun: snapshot.activeRun,
          expectedStateDigest: ownedClaim.expectedStateDigest,
          launch: ownedClaim.restartLaunch,
          preparedSession: ownedClaim.preparedSession
        }, transactionStore);
        clearRoleRuntimeOperationClaim(
          workingRoot,
          ownedClaim.taskId,
          ownedClaim.roleName,
          ownedClaim.token,
          recoveryToken
        );
      });
    });
    return outcome === "finalized" ? "finalized" : undefined;
  }, { now });
}

export function persistTaskRoleControl(
  prepared: PreparedTaskRoleControl,
  store: TaskStore
): string {
  const current = readRoleRuntimeStateSnapshot(store, prepared.taskId, prepared.role.name);
  if (roleRuntimeStateDigest(current) !== prepared.expectedStateDigest || current.role === null) {
    throw roleConflict(`${prepared.taskId}/${prepared.role.name}`);
  }
  if (prepared.action === "restart") {
    persistPreparedRoleLaunch(prepared.taskId, current.role, prepared.preparedSession, store);
    return `Restarted role ${prepared.role.name} for ${prepared.taskId}\n`;
  }
  const now = new Date();
  if (current.activeRun !== null) {
    store.saveAgentRun(failAgentRun(
      current.activeRun,
      `The Role was manually ${prepared.action === "stop" ? "stopped" : "killed"}.`,
      now
    ));
    store.clearActiveAgentRun(prepared.taskId, prepared.role.name);
  }
  const stoppedSessions = current.sessionSet !== null &&
      current.sessionSet.sessions[current.role.activeAgentId] !== undefined
    ? updateRoleAgentSessionStatus(current.sessionSet, current.role.activeAgentId, "stopped", now)
    : current.sessionSet;
  store.saveRoleWithSessionSet(
    prepared.taskId,
    updateRoleStatus(current.role, "exited", now),
    stoppedSessions
  );
  return `${prepared.action === "stop" ? "Stopped" : "Killed"} role ${prepared.role.name} for ${prepared.taskId}\n`;
}

export function executePreparedTaskRoleControl<T>(
  rootDir: string,
  prepared: PreparedTaskRoleControl,
  tmux: TmuxManager,
  finalize: (claim: RoleStopRuntimeOperationClaim) => T
): T {
  const targetStatus = tmux.probeRoleStatus(prepared.taskId, prepared.role.name);
  const targetLaunchToken = targetStatus === "running"
    ? tmux.roleLaunchToken(prepared.taskId, prepared.role.name)
    : null;
  if (targetStatus === "running" && targetLaunchToken === null) {
    throw runtimeError(
      `Role control requires a durable launch identity for the running window: ${prepared.role.name}.`
    );
  }
  const claim = createTaskRoleControlClaim(prepared, targetLaunchToken);
  const claimOperation = (): void => {
    claimPreparedTaskRoleControl(rootDir, prepared, claim);
  };
  const beginEffect = (): void => markRoleRuntimeOperationEffectStarted(
      rootDir,
      `task-${prepared.action}-effect-${randomUUID()}`,
      claim
    );

  const result = executeReplayableRoleRuntimeOperation(
    () => { executeTaskRoleControlEffect(prepared, claim, tmux); },
    () => finalize(claim),
    { claim: claimOperation, beginEffect }
  );

  if (prepared.action === "restart") {
    tmux.attachRole(prepared.taskId, prepared.role.name);
  }
  return result;
}

function runTaskRoleControlCommand(
  action: PreparedTaskRoleControl["action"],
  args: string[],
  store: TaskStore,
  tmux: TmuxManager | undefined
): string {
  if (tmux === undefined) throw runtimeError("Tmux manager is not configured.");
  if (!(store instanceof FileTaskStore)) {
    const prepared = prepareTaskRoleControl(action, args, store);
    if (action === "stop") tmux.stopRole(prepared.taskId, prepared.role.name);
    else if (action === "kill") tmux.killRole(prepared.taskId, prepared.role.name);
    else {
      if (prepared.launch === null) throw runtimeError("Restart launch plan is missing.");
      tmux.restartRole(prepared.taskId, prepared.role, prepared.launch);
    }
    return persistTaskRoleControl(prepared, store);
  }
  if (hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    throw runtimeError("Role runtime control must run as a post-commit effect.");
  }
  recoverTaskRoleRuntimeOperations(store.rootDirectory(), tmux);
  const prepared = prepareTaskRoleControl(action, args, store);
  return executePreparedTaskRoleControl(
    store.rootDirectory(),
    prepared,
    tmux,
    (claim) => executeDomainTransaction(store.rootDirectory(), `task-${action}-commit-${randomUUID()}`, (workingRoot) => {
      const transactionStore = transactionTaskStore(workingRoot, claim.token);
      const output = persistTaskRoleControl(prepared, transactionStore);
      clearRoleRuntimeOperationClaim(workingRoot, claim.taskId, claim.roleName, claim.token);
      return output;
    })
  );
}

function addTaskCommentCommand(args: string[], store: TaskStore): string {
  const [taskId, ...bodyParts] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const topics = readRepeatedOption(bodyParts, "--topic").map((topic) => topic.trim());
  validateTopicIds(store, taskId, topics);
  const body = stripRepeatedOption(bodyParts, "--topic").join(" ").trim();

  if (body.length === 0) {
    throw usageError("Comment body is required.");
  }

  const comment = createTaskComment(store.nextCommentId(taskId), body, new Date(), "user", topics);
  store.saveComment(taskId, comment);
  recordTaskEvent(store, taskId, "comment.added", { comment: comment.id });
  queueLeaderWakeup(store, taskId, "user-comment");

  return `Added comment to ${taskId}: ${comment.body}\n`;
}

function listTaskCommentsCommand(args: string[], store: TaskReader): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const comments = store.listComments(taskId);

  if (comments.length === 0) {
    return "No comments found.\n";
  }

  return `${renderTable(
    `Task comments: ${taskId}`,
    [
      { header: "Comment", minWidth: 7, maxWidth: 16 },
      { header: "Created", minWidth: 10, maxWidth: 28 },
      { header: "Body", minWidth: 8, maxWidth: 76 }
    ],
    comments.map((comment) => [comment.id, comment.createdAt, comment.body]),
    defaultTableWidth()
  )}\n`;
}

function listTaskEventsCommand(args: string[], store: TaskReader): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const events = store.listEvents(taskId);

  if (events.length === 0) {
    return "No events found.\n";
  }

  return `${renderEventTable(`Task events: ${taskId}`, events)}\n`;
}

function taskActivityCommand(args: string[], store: TaskReader): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const roles = store.listRoles(taskId);

  if (roles.length === 0) {
    return `Task activity: ${taskId}\nNo roles assigned.\n`;
  }

  return `${renderTable(
    `Task activity: ${taskId}`,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "Transcript", minWidth: 10, maxWidth: 18 },
      { header: "Updated", minWidth: 10, maxWidth: 28 }
    ],
    roles.map((role) => {
      const transcript = store.readTranscript(taskId, role.name);

      return [
        role.name,
        role.activeAgentId,
        role.status,
        String(countTranscriptLines(transcript)),
        role.updatedAt
      ];
    }),
    defaultTableWidth()
  )}\n`;
}

function taskTimelineCommand(args: string[], store: TaskReader): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const lines = [
    ...store.listEvents(taskId).map((event) => ({
      createdAt: event.createdAt,
      row: [event.createdAt, "event", event.type, renderEventPayload(event.payload)]
    })),
    ...store.listComments(taskId).map((comment) => ({
      createdAt: comment.createdAt,
      row: [comment.createdAt, "comment", comment.id, comment.body]
    }))
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (lines.length === 0) {
    return `Task timeline: ${taskId}\nNo timeline entries.\n`;
  }

  return `${renderTable(
    `Task timeline: ${taskId}`,
    [
      { header: "Created", minWidth: 10, maxWidth: 28 },
      { header: "Kind", minWidth: 5, maxWidth: 10 },
      { header: "Type", minWidth: 4, maxWidth: 24 },
      { header: "Detail", minWidth: 8, maxWidth: 76 }
    ],
    lines.map((entry) => entry.row),
    defaultTableWidth()
  )}\n`;
}

type TaskContextFormat = "text" | "json";

type TaskContextOptions = {
  format: TaskContextFormat;
  includeTranscripts: boolean;
};

type TaskContextRole = Role & {
  transcript?: string | null;
};

type TaskContext = {
  task: Task;
  brief: string | null;
  topicSummaries: string | null;
  roles: TaskContextRole[];
  childRoles: ChildRole[];
  topics: {
    builtIn: typeof BUILTIN_TOPICS;
    custom: ReturnType<TaskStore["getTaskTopics"]>["customTopics"];
  };
  activeRuns: AgentRun[];
  schedule: ReturnType<TaskStore["getTaskSchedule"]>;
  cycles: ReturnType<TaskStore["listCycles"]>;
  workItems: ReturnType<TaskStore["listWorkItems"]>;
  milestones: ReturnType<TaskStore["listMilestones"]>;
  decisions: ReturnType<TaskStore["listDecisions"]>;
  sessions: Record<string, NonNullable<ReturnType<TaskStore["getRoleSessionSet"]>>>;
  pendingWakeup: ReturnType<TaskStore["getPendingWakeup"]>;
  leaderFailure: ReturnType<TaskStore["getLeaderFailure"]>;
  comments: TaskComment[];
  events: TaskEvent[];
};

function parseTaskContextOptions(args: string[]): TaskContextOptions {
  assertKnownOptions(args, new Set(["--format", "--include-transcripts"]));

  const format = parseTaskContextFormat(readOptionalOption(args, "--format"));

  return {
    format,
    includeTranscripts: hasFlag(args, "--include-transcripts")
  };
}

function parseTaskContextFormat(value: string | undefined): TaskContextFormat {
  if (value === undefined) {
    return "text";
  }

  if (value !== "text" && value !== "json") {
    throw usageError("--format must be one of text, json.");
  }

  return value;
}

function buildTaskContext(task: Task, store: TaskReader, includeTranscripts: boolean): TaskContext {
  return {
    task,
    brief: store.readTaskBrief(task.id),
    topicSummaries: store.readTaskTopicSummaries(task.id),
    roles: store.listRoles(task.id).map((role) => includeTranscripts
      ? { ...role, transcript: store.readTranscript(task.id, role.name) }
      : role),
    childRoles: store.listChildRoles(task.id),
    topics: {
      builtIn: BUILTIN_TOPICS,
      custom: store.getTaskTopics(task.id).customTopics
    },
    activeRuns: store.listRoles(task.id)
      .map((role) => store.getActiveAgentRun(task.id, role.name))
      .filter((run): run is AgentRun => run !== null),
    schedule: store.getTaskSchedule(task.id),
    cycles: store.listCycles(task.id),
    workItems: store.listWorkItems(task.id),
    milestones: store.listMilestones(task.id),
    decisions: store.listDecisions(task.id),
    sessions: Object.fromEntries(store.listRoles(task.id)
      .map((role) => [role.name, store.getRoleSessionSet(task.id, role.name)] as const)
      .filter((entry): entry is readonly [string, NonNullable<ReturnType<TaskStore["getRoleSessionSet"]>>] => entry[1] !== null)),
    pendingWakeup: store.getPendingWakeup(task.id),
    leaderFailure: store.getLeaderFailure(task.id),
    comments: store.listComments(task.id),
    events: store.listEvents(task.id)
  };
}

function renderTaskContextText(context: TaskContext, includeTranscripts: boolean): string {
  return [
    "Task Context",
    ...renderTaskContextTaskLines(context.task),
    ...(context.brief === null ? [] : ["", context.brief.trimEnd()]),
    ...(context.topicSummaries === null ? [] : ["", context.topicSummaries.trimEnd()]),
    "",
    renderTaskContextRoles(context.roles, includeTranscripts),
    ...(context.childRoles.length === 0
      ? []
      : ["", "Child role constraints", ...context.childRoles.map((role) =>
        `${role.name} -> ${role.parentRole}: ${role.description}; expected: ${role.expectedOutput}`
      )]),
    "",
    renderTaskContextComments(context.comments),
    "",
    renderTaskContextEvents(context.events)
  ].join("\n").concat("\n");
}

function renderTaskContextTaskLines(task: Task): string[] {
  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Archived: ${task.archived ? "yes" : "no"}`,
    ...renderTaskMetadataLines(task),
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`
  ];
}

function renderTaskContextRoles(roles: TaskContextRole[], includeTranscripts: boolean): string {
  const columns = [
    { header: "Role", minWidth: 4, maxWidth: 24 },
    { header: "Agent", minWidth: 5, maxWidth: 20 },
    { header: "Status", minWidth: 6, maxWidth: 12 },
    { header: "Workspace", minWidth: 9, maxWidth: 48 },
    ...(includeTranscripts ? [{ header: "Transcript", minWidth: 10, maxWidth: 54 }] : [])
  ];
  const rows = roles.map((role) => [
    role.name,
    role.activeAgentId,
    role.status,
    role.workspace,
    ...(includeTranscripts ? [role.transcript === undefined || role.transcript === null ? "not captured" : role.transcript.trimEnd()] : [])
  ]);

  return renderTable("Roles", columns, rows, defaultTableWidth());
}

function renderTaskContextComments(comments: TaskComment[]): string {
  return renderTable(
    "Comments",
    [
      { header: "Comment", minWidth: 7, maxWidth: 16 },
      { header: "Body", minWidth: 8, maxWidth: 76 }
    ],
    comments.map((comment) => [comment.id, comment.body]),
    defaultTableWidth()
  );
}

function renderTaskContextEvents(events: TaskEvent[]): string {
  return renderEventTable("Events", events);
}

function recordTaskEvent(
  store: TaskStore,
  taskId: string,
  type: string,
  payload: Record<string, string>
): void {
  store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), type, payload, new Date()));
}

function queueLeaderWakeup(store: TaskStore, taskId: string, reason: string): void {
  if (store.getTask(taskId)?.archived === true) {
    return;
  }
  store.savePendingWakeup(
    mergePendingWakeup(taskId, reason, new Date(), store.getPendingWakeup(taskId))
  );
}

function validateTopicIds(store: TaskStore, taskId: string, topics: string[]): void {
  const knownTopics = new Set([
    ...BUILTIN_TOPICS.map(({ id }) => id),
    ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
  ]);
  const unknownTopic = topics.find((topic) => !knownTopics.has(topic));
  if (unknownTopic !== undefined) {
    throw usageError(`Topic not found: ${unknownTopic}.`);
  }
}

function stripRepeatedOption(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      index += 1;
      continue;
    }
    result.push(args[index] ?? "");
  }
  return result;
}

function createResolvedRole(
  taskId: string,
  roleName: string,
  agent: string,
  workspace: string,
  store: TaskStore
): Role {
  const resolvedAgent = resolveAgent(agent, store.listConfiguredAgents());

  if (resolvedAgent === null) {
    throwUnsupportedAgent(agent, store);
  }

  return createRole(taskId, roleName, [createRoleAgentBinding(resolvedAgent)], resolvedAgent.id, workspace, new Date());
}

function prepareRoleWindowLaunch(
  taskId: string,
  role: Role,
  store: TaskStore,
  sessionSet: TaskRoleSessionSet | null = store.getRoleSessionSet(taskId, role.name)
) {
  const binding = activeRoleAgentBinding(role);
  const agent = resolveAgent(binding.agentId, store.listConfiguredAgents());
  if (agent === null) throwUnsupportedAgent(binding.agentId, store);
  const session = sessionSet?.sessions[role.activeAgentId] ?? null;
  const mode: DispatchMode = session === null || session.status === "reserved" ? "new" : "resume";
  if (mode === "new" && binding.adapterId === "codex") {
    throw usageError("A Codex Role must establish its native session through task dispatch before task enter.");
  }
  const prepared = resolveAgentExecutor(binding.adapterId).prepare({
    taskId,
    role,
    agent,
    mode,
    session,
    now: new Date(),
    worktreeRoot: store.getRoleWorktree(taskId, role.name)?.path
  });
  return prepared;
}

function persistPreparedRoleLaunch(
  taskId: string,
  role: Role,
  preparedSession: RoleAgentSession | null,
  store: TaskStore
): void {
  const now = new Date();
  const existing = store.getRoleSessionSet(taskId, role.name);
  const state = buildPreparedRoleLaunchState(role, preparedSession, existing, null, now);
  store.saveRoleWithSessionSet(taskId, state.role!, state.sessionSet);
}

function buildPreparedRoleLaunchState(
  role: Role,
  preparedSession: RoleAgentSession | null,
  existing: TaskRoleSessionSet | null,
  activeRun: AgentRun | null,
  now: Date
): import("../executor/executorRegistry.js").RoleRuntimeStateSnapshot {
  const sessionSet = preparedSession === null
    ? existing
    : updateRoleAgentSessionStatus({
        ...(existing ?? createRoleSessionSet(
          { scope: "task", taskId: role.taskId, roleName: role.name },
          role.activeAgentId,
          now
        )),
        activeAgentId: role.activeAgentId,
        sessions: {
          ...(existing?.sessions ?? {}),
          [role.activeAgentId]: preparedSession
        },
        updatedAt: now.toISOString()
      }, role.activeAgentId, "running", now);
  return {
    role: updateRoleStatus(role, "running", now),
    sessionSet,
    activeRun,
    selectedWorkItem: null,
    pendingRun: null
  };
}

function createRoleFromGlobalOrAgent(
  taskId: string,
  roleName: string,
  options: {
    agent: string | undefined;
    fallbackAgent: string | undefined;
    workspace: string | undefined;
    workspaceOverride?: string;
  },
  store: TaskStore
): Role {
  if (options.agent === undefined) {
    const globalRole = store.getGlobalRole(roleName);

    if (globalRole !== null) {
      return copyGlobalRole(taskId, roleName, store, {
        workspaceOverride: options.workspaceOverride
      });
    }
  }

  const agent = options.agent ?? options.fallbackAgent;

  if (agent === undefined || agent.length === 0) {
    throw usageError(`Role ${roleName} requires an agent or a configured global role. Run taskmux role add ${roleName} --agent <agent-id>.`);
  }

  return createResolvedRole(taskId, roleName, agent, requireWorkspace(options.workspace), store);
}

function copyGlobalRole(
  taskId: string,
  roleName: string,
  store: TaskStore,
  options: { name?: string; workspaceOverride?: string } = {}
): Role {
  const globalRole = store.getGlobalRole(roleName);

  if (globalRole === null) {
    throw roleNotFound(roleName);
  }

  const role = copyGlobalRoleToTaskRole(globalRole, taskId, new Date(), options.name ?? globalRole.name);

  if (options.workspaceOverride !== undefined) {
    if (options.workspaceOverride.length === 0) {
      throw usageError("--workspace is required.");
    }

    return updateRole(role, { workspace: options.workspaceOverride }, new Date());
  }

  return role;
}

function saveRoleAndRecordEvent(taskId: string, role: Role, store: TaskStore): void {
  assertTaskRoleAssignable(taskId, role.name, store);
  const created = store.createRoleIfAbsent(taskId, role);
  if (created === null) throw roleConflict(role.name);
  recordTaskEvent(store, taskId, "role.assigned", { role: created.name, agent: created.activeAgentId });
}

function assertTaskRoleAssignable(taskId: string, roleName: string, store: TaskStore): void {
  if (store.getChildRole(taskId, roleName) !== null) {
    throw usageError([
      `Role name conflict: ${roleName} is already used by a child role in ${taskId}.`,
      `Remove it with taskmux task role remove ${taskId} ${roleName} before assigning an independent role.`
    ].join("\n"));
  }

  if (store.getRole(taskId, roleName) !== null) {
    throwTaskRoleAlreadyExists(taskId, roleName);
  }
}

function throwTaskRoleAlreadyExists(taskId: string, roleName: string): never {
  throw usageError([
    `Role already exists: ${roleName}.`,
    `Use taskmux task role update ${taskId} ${roleName} [--agent <agent-id>] [--workspace <path>] to change it.`
  ].join("\n"));
}

function throwUnsupportedAgent(agent: string, store: TaskStore): never {
  const supportedAgents = supportedAgentIds(store.listConfiguredAgents());
  const supportedText = supportedAgents.length === 0
    ? "none configured. Run taskmux setup, then add an agent."
    : supportedAgents.join(", ");

  throw usageError(`Unsupported agent: ${agent}\nSupported agents: ${supportedText}`);
}

function requireWorkspace(workspace: string | undefined): string {
  if (workspace !== undefined && workspace.length > 0) {
    return workspace;
  }

  throw usageError("--workspace is required.");
}

export function rememberTask(store: TaskStore, taskId: string, options: { current?: boolean } = {}): void {
  const config = store.getConfig();

  store.saveConfig({
    ...config,
    lastTaskId: taskId,
    currentTaskId: options.current === true ? taskId : config.currentTaskId
  });
}

function renderTaskPointer(label: string, taskId: string | undefined, store: TaskReader): string {
  if (taskId === undefined) {
    return `${label}: (none)\n`;
  }

  const task = store.getTask(taskId);

  if (task === null) {
    return `${label}: ${taskId} missing\n`;
  }

  return `${label}: ${task.id} ${task.title}\n`;
}

function renderEventPayload(payload: Record<string, string>): string {
  return Object.entries(payload)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function renderRoleTable(title: string, roles: Role[]): string {
  return renderTable(
    title,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "Workspace", minWidth: 9, maxWidth: 54 }
    ],
    roles.map((role) => [role.name, role.activeAgentId, role.status, role.workspace]),
    defaultTableWidth()
  );
}

function renderEventTable(title: string, events: TaskEvent[]): string {
  return renderTable(
    title,
    [
      { header: "Event", minWidth: 6, maxWidth: 16 },
      { header: "Created", minWidth: 10, maxWidth: 28 },
      { header: "Type", minWidth: 8, maxWidth: 24 },
      { header: "Payload", minWidth: 8, maxWidth: 76 }
    ],
    events.map((event) => [event.id, event.createdAt, event.type, renderEventPayload(event.payload)]),
    defaultTableWidth()
  );
}

function findRole(
  args: string[],
  store: TaskReader
): { taskId: string; role: NonNullable<ReturnType<TaskStore["getRole"]>> } | string {
  const [taskId, roleName] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    return "Task id is required.\n";
  }

  if (roleName === undefined || roleName.trim().length === 0) {
    return "Role name is required.\n";
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }

  return { taskId, role };
}

function readOption(args: string[], name: string): string {
  const index = args.indexOf(name);

  if (index === -1 || args[index + 1] === undefined) {
    throw usageError(`${name} is required.`);
  }

  return args[index + 1];
}

type TaskBoardInput = {
  title?: string;
  metadata: TaskMetadata;
};

type TaskTemplateName = "feature" | "bug" | "review";

type TaskTemplate = {
  name: TaskTemplateName;
  metadata: TaskMetadata;
  roles: string[];
};

type TranscriptExportFormat = "text" | "json" | "markdown";

type TaskListFilters = {
  archived?: boolean;
  tag?: string;
  priority?: TaskPriority;
  search?: string;
};

type TaskBoardViewOptions = {
  filters: TaskListFilters;
  withRoles: boolean;
};

function parseTaskBoardInput(
  args: string[],
  options: { requireTitle: boolean; allowTitleOption?: boolean; allowClear?: boolean; extraKnownOptions?: Set<string> }
): TaskBoardInput {
  const optionStart = args.findIndex((arg) => arg.startsWith("--"));
  const titleParts = optionStart === -1 ? args : args.slice(0, optionStart);
  const optionArgs = optionStart === -1 ? [] : args.slice(optionStart);
  const titleFromOption = options.allowTitleOption === true ? readOptionalOption(optionArgs, "--title")?.trim() : undefined;
  const title = (titleFromOption ?? titleParts.join(" ")).trim();
  const metadata: TaskMetadata = {};
  const description = readOptionalOption(optionArgs, "--description")?.trim();
  const priority = parseTaskPriority(readOptionalOption(optionArgs, "--priority"));
  const tags = readRepeatedOption(optionArgs, "--tag").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  const dueAt = readOptionalOption(optionArgs, "--due")?.trim();

  const knownOptions = new Set(["--title", "--description", "--priority", "--tag", "--due"]);

  for (const option of options.extraKnownOptions ?? []) {
    knownOptions.add(option);
  }

  if (options.allowClear === true) {
    knownOptions.add("--clear-description");
    knownOptions.add("--clear-priority");
    knownOptions.add("--clear-tags");
    knownOptions.add("--clear-due");
  }

  assertKnownOptions(optionArgs, knownOptions);

  if (options.requireTitle && title.length === 0) {
    throw usageError("Task title is required.");
  }

  if (description !== undefined && description.length > 0) {
    metadata.description = description;
  }

  if (priority !== undefined) {
    metadata.priority = priority;
  }

  if (tags.length > 0) {
    metadata.tags = tags;
  }

  if (dueAt !== undefined && dueAt.length > 0) {
    assertDueAt(dueAt);
    metadata.dueAt = dueAt;
  }

  if (options.allowClear === true) {
    if (hasFlag(optionArgs, "--clear-description")) {
      metadata.description = undefined;
    }

    if (hasFlag(optionArgs, "--clear-priority")) {
      metadata.priority = undefined;
    }

    if (hasFlag(optionArgs, "--clear-tags")) {
      metadata.tags = undefined;
    }

    if (hasFlag(optionArgs, "--clear-due")) {
      metadata.dueAt = undefined;
    }
  }

  return {
    title: title.length === 0 ? undefined : title,
    metadata
  };
}

function parseTaskTemplate(value: string | undefined): TaskTemplate | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "feature") {
    return {
      name: value,
      metadata: { priority: "medium", tags: ["feature"] },
      roles: ["rd", "reviewer"]
    };
  }

  if (value === "bug") {
    return {
      name: value,
      metadata: { priority: "high", tags: ["bug"] },
      roles: ["rd", "tester"]
    };
  }

  if (value === "review") {
    return {
      name: value,
      metadata: { priority: "medium", tags: ["review"] },
      roles: ["reviewer"]
    };
  }

  throw usageError("--template must be one of feature, bug, review.");
}

function mergeTemplateMetadata(input: TaskMetadata, template: TaskTemplate): TaskMetadata {
  return {
    ...template.metadata,
    ...input,
    tags: uniqueStrings([...(template.metadata.tags ?? []), ...(input.tags ?? [])])
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function parseTranscriptExportFormat(value: string | undefined): TranscriptExportFormat {
  if (value === undefined) {
    return "text";
  }

  if (value !== "text" && value !== "json" && value !== "markdown") {
    throw usageError("--format must be one of text, json, markdown.");
  }

  return value;
}

function renderTranscriptExport(
  taskId: string,
  roleName: string,
  transcript: string,
  format: TranscriptExportFormat
): string {
  if (format === "json") {
    return `${JSON.stringify({ taskId, role: roleName, transcript }, null, 2)}\n`;
  }

  if (format === "markdown") {
    return `# Transcript ${taskId} ${roleName}\n\n\`\`\`text\n${transcript.trimEnd()}\n\`\`\`\n`;
  }

  return transcript;
}

function countTranscriptLines(transcript: string | null): number {
  if (transcript === null || transcript.trimEnd().length === 0) {
    return 0;
  }

  return transcript.trimEnd().split("\n").length;
}

function parseTaskListFilters(args: string[]): TaskListFilters {
  assertKnownOptions(args, new Set(["--archived", "--tag", "--priority", "--search"]));

  return {
    archived: parseBooleanOption(readOptionalOption(args, "--archived"), "--archived"),
    tag: readOptionalOption(args, "--tag")?.trim(),
    priority: parseTaskPriority(readOptionalOption(args, "--priority")),
    search: readOptionalOption(args, "--search")?.trim().toLowerCase()
  };
}

function parseTaskBoardViewOptions(args: string[]): TaskBoardViewOptions {
  assertKnownOptions(args, new Set(["--archived", "--tag", "--priority", "--search", "--with-roles"]));

  return {
    filters: {
      archived: parseBooleanOption(readOptionalOption(args, "--archived"), "--archived"),
      tag: readOptionalOption(args, "--tag")?.trim(),
      priority: parseTaskPriority(readOptionalOption(args, "--priority")),
      search: readOptionalOption(args, "--search")?.trim().toLowerCase()
    },
    withRoles: hasFlag(args, "--with-roles")
  };
}

function taskMatchesFilters(task: Task, filters: TaskListFilters): boolean {
  if (filters.archived !== undefined && task.archived !== filters.archived) {
    return false;
  }

  if (filters.tag !== undefined && !(task.tags ?? []).includes(filters.tag)) {
    return false;
  }

  if (filters.priority !== undefined && task.priority !== filters.priority) {
    return false;
  }

  if (filters.search !== undefined && !taskSearchText(task).includes(filters.search)) {
    return false;
  }

  return true;
}

function renderTaskListTable(tasks: Task[]): string {
  return renderTable(
    "Tasks",
    [
      { header: "Task", minWidth: 6, maxWidth: 14 },
      { header: "State", minWidth: 7, maxWidth: 10 },
      { header: "Title", minWidth: 10, maxWidth: 48 },
      { header: "Metadata", minWidth: 8, maxWidth: 58 }
    ],
    tasks.map((task) => [task.id, task.archived ? "archived" : "ongoing", task.title, renderTaskMetadataSummary(task)]),
    defaultTableWidth()
  );
}

function renderTaskBoard(tasks: Task[], store: TaskReader, withRoles: boolean): string {
  const groups = [
    { archived: false, title: "Ongoing" },
    { archived: true, title: "Archived" }
  ];
  const rows = groups.flatMap((group) => {
    const groupTasks = tasks.filter((task) => task.archived === group.archived);

    if (groupTasks.length === 0) {
      return [[group.title, "", "(none)", "", "", ""]];
    }

    return groupTasks.map((task) => [
        group.title,
        task.id,
        task.title,
        renderTaskMetadataSummary(task),
        renderTaskProgressSummary(task.id, store),
        withRoles ? renderTaskRoleSummary(store.listRoles(task.id)) : ""
      ]);
  });

  return `${renderTable(
    "Task board",
    [
      { header: "Status", minWidth: 6, maxWidth: 10 },
      { header: "Task", minWidth: 6, maxWidth: 14 },
      { header: "Title", minWidth: 10, maxWidth: 44 },
      { header: "Metadata", minWidth: 8, maxWidth: 44 },
      { header: "Progress", minWidth: 8, maxWidth: 54 },
      { header: "Roles", minWidth: 6, maxWidth: 42 }
    ],
    rows,
    defaultTableWidth()
  )}\n`;
}

function renderTaskProgressSummary(taskId: string, store: TaskReader): string {
  const brief = store.readTaskBrief(taskId);
  const focus = brief?.match(/## Current focus\s+([^\n]+)/)?.[1]?.trim();
  const workCounts = store.listWorkItems(taskId).reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const work = Object.entries(workCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(" ");

  return [
    focus === undefined ? null : `focus=${focus}`,
    work.length === 0 ? null : `work ${work}`,
    store.listMilestones(taskId).length === 0 ? null : `milestones=${store.listMilestones(taskId).length}`,
    store.getLeaderFailure(taskId) === null ? null : "leader-failed"
  ].filter((value): value is string => value !== null).join(" ");
}

function renderTaskRoleSummary(roles: Role[]): string {
  if (roles.length === 0) {
    return "roles none";
  }

  const counts = roles.reduce<Record<string, number>>((result, role) => {
    result[role.status] = (result[role.status] ?? 0) + 1;
    return result;
  }, {});

  return `roles ${["idle", "running", "detached", "exited", "failed"]
    .filter((status) => counts[status] !== undefined)
    .map((status) => `${status}=${counts[status]}`)
    .join(" ")}`;
}

function renderTaskMetadataLines(task: Task): string[] {
  const lines: string[] = [];

  if (task.description !== undefined) {
    lines.push(`Description: ${task.description}`);
  }

  if (task.priority !== undefined) {
    lines.push(`Priority: ${task.priority}`);
  }

  if (task.tags !== undefined && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(", ")}`);
  }

  if (task.dueAt !== undefined) {
    lines.push(`Due: ${task.dueAt}`);
  }

  return lines;
}

function renderTaskMetadataSummary(task: Task): string {
  return [
    task.priority === undefined ? null : `priority=${task.priority}`,
    task.tags === undefined || task.tags.length === 0 ? null : `tags=${task.tags.join(",")}`,
    task.dueAt === undefined ? null : `due=${task.dueAt}`
  ]
    .filter((item): item is string => item !== null)
    .join(" ");
}

function taskSearchText(task: Task): string {
  return [
    task.title,
    task.description,
    task.priority,
    task.dueAt,
    ...(task.tags ?? [])
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
}

function readOptionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  if (args[index + 1] === undefined || args[index + 1].startsWith("--")) {
    throw usageError(`${name} is required.`);
  }

  return args[index + 1];
}

function requiredRoleOption(value: string | undefined, option: string): string {
  if (value === undefined || value.trim().length === 0) throw usageError(`${option} is required.`);
  return value.trim();
}

function assertRoleSystemPromptSelection(parsed: ParsedRoleCommandOptions): void {
  if (parsed.has("--system-prompt") && parsed.inherits("systemPrompt")) {
    throw usageError("Role field cannot be set and inherited together: systemPrompt.");
  }
}

function applyRoleSystemPrompt(role: Role, value: string | undefined, inherit: boolean): Role {
  if (inherit) {
    const { systemPrompt: _removed, ...remaining } = role;
    return remaining;
  }
  return value === undefined ? role : { ...role, systemPrompt: value.trim() };
}

function readRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }

    if (args[index + 1] === undefined || args[index + 1].startsWith("--")) {
      throw usageError(`${name} is required.`);
    }

    values.push(args[index + 1]);
    index += 1;
  }

  return values;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function assertKnownOptions(args: string[], knownOptions: Set<string>): void {
  for (const arg of args) {
    if (arg.startsWith("--") && !knownOptions.has(arg)) {
      throw usageError(`Unsupported option: ${arg}`);
    }
  }
}

function parseTaskPriority(value: string | undefined): TaskPriority | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!["low", "medium", "high", "urgent"].includes(value)) {
    throw usageError("--priority must be one of low, medium, high, urgent.");
  }

  return value as TaskPriority;
}

function parseBooleanOption(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "true" && value !== "false") {
    throw usageError(`${name} must be true or false.`);
  }

  return value === "true";
}

function assertDueAt(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw usageError("--due must use YYYY-MM-DD.");
  }
}
