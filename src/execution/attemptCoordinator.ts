import { NodeGitWorkspace } from "../repository/gitWorkspace.js";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TaskStore } from "../storage/taskStore.js";
import { configuredAgentLaunchEnvironment } from "../agent/launchEnvironment.js";
import type { AgentProfile, AttemptAccess } from "../profile/agentProfile.js";
import {
  retryFailedWorkItem,
  updateWorkItemStatus,
  type WorkItem
} from "../workItem/workItem.js";
import { AttemptWorkspaceManager } from "../workspace/attemptWorkspaceManager.js";
import {
  attachExecutionProviderRef,
  completeExecutionAttempt,
  createExecutionAttempt,
  failExecutionAttempt,
  type ExecutionAttempt,
  type ExecutorKind
} from "./executionAttempt.js";
import {
  CodexAppServerAttemptExecutor,
  type AttemptExecutionPort
} from "./codexAppServerExecutor.js";
import { loadYuiSkillContexts } from "../context/roleSessionContext.js";

export type AttemptDispatchInput = Readonly<{
  workItemId: string;
  profileId?: string;
  profileRevision?: number;
  executor?: "auto" | ExecutorKind;
  access?: AttemptAccess;
  input?: string;
  exactInput?: string;
  sessionReason?: string;
}>;

export type AttemptDispatchResult = Readonly<{
  attempt: ExecutionAttempt;
  workItem: WorkItem;
}>;

export class AttemptCoordinator {
  readonly workspaceManager: AttemptWorkspaceManager;

  constructor(
    readonly home: string,
    readonly store: TaskStore,
    readonly executor: AttemptExecutionPort = new CodexAppServerAttemptExecutor(),
    readonly now: () => Date = () => new Date(),
    readonly environment: NodeJS.ProcessEnv = process.env
  ) {
    this.workspaceManager = new AttemptWorkspaceManager(home, store);
  }

  async dispatch(input: AttemptDispatchInput): Promise<AttemptDispatchResult> {
    const workItem = requireWorkItem(this.store, input.workItemId);
    const task = this.store.getTask(workItem.taskId);
    if (task === null) throw new Error(`Task not found: ${workItem.taskId}.`);
    if (task.status !== "active") throw new Error(`Task is not active: ${task.id}.`);
    if (workItem.status !== "pending" && workItem.status !== "failed") {
      throw new Error(`Work Item cannot dispatch from ${workItem.status}: ${workItem.id}.`);
    }
    assertDependenciesComplete(this.store, workItem);
    const profile = requireProfile(
      this.store,
      input.profileId ?? "worker",
      input.profileRevision
    );
    const configuredAgent = this.store.getConfiguredAgent(profile.agentId);
    if (configuredAgent === null) {
      throw new Error(`Configured Agent not found for Profile: ${profile.id}.`);
    }
    if (configuredAgent.adapterId !== "codex") {
      throw new Error("Execution Attempts currently require a Codex Agent Profile.");
    }
    const access = input.access ?? profile.defaultAccess;
    assertAccessCanNarrow(profile.defaultAccess, access);
    if (access === "write" && task.projectId === undefined) {
      throw new Error(`Write Attempt requires a Project-backed Task: ${task.id}.`);
    }
    const skills = loadYuiSkillContexts(
      this.home,
      [...new Set(["yui-worker", ...(profile.skills ?? [])])]
    );
    const parentThreadId = compatibleLeaderThreadId(this.store, task.id);
    const selection = selectExecutor(input.executor ?? "auto", {
      parentThreadId,
      sessionReason: input.sessionReason
    });
    const attemptId = this.store.nextExecutionAttemptId(task.id);
    let workspace = access === "write"
      ? await this.workspaceManager.reserve({ id: attemptId, taskId: task.id })
      : undefined;
    const baseCommit = workspace?.baseCommit ?? await inspectTaskBaseCommit(this.store, task.id);
    let attempt = createExecutionAttempt({
      id: attemptId,
      taskId: task.id,
      workItemId: workItem.id,
      profileId: profile.id,
      profileRevision: profile.revision,
      executor: selection.executor,
      access,
      input: input.exactInput ?? compileAttemptInput(this.store, workItem, input.input),
      ...(baseCommit === undefined ? {} : { baseCommit }),
      ...(selection.sessionReason === undefined
        ? {}
        : { sessionReason: selection.sessionReason })
    }, this.now());
    this.store.transaction((tx) => {
      const currentTask = tx.getTask(task.id);
      if (currentTask === null || currentTask.status !== "active") {
        throw new Error(`Task is not active: ${task.id}.`);
      }
      const currentWorkItem = requireWorkItem(tx, workItem.id);
      if (currentWorkItem.status !== "pending" && currentWorkItem.status !== "failed") {
        throw new Error(
          `Work Item cannot dispatch from ${currentWorkItem.status}: ${currentWorkItem.id}.`
        );
      }
      assertDependenciesComplete(tx, currentWorkItem);
      const running = currentWorkItem.status === "failed"
        ? retryFailedWorkItem(currentWorkItem, this.now())
        : updateWorkItemStatus(currentWorkItem, "running", this.now());
      tx.saveExecutionAttempt(task.id, attempt);
      tx.saveWorkItem(task.id, running);
      return running;
    });

    try {
      if (workspace !== undefined) workspace = await this.workspaceManager.activate(workspace);
      const response = await this.executor.execute({
        executor: attempt.executor,
        input: attempt.input,
        cwd: workspace?.path ?? taskProjectPath(this.store, task.id) ?? process.cwd(),
        access,
        profile,
        skills,
        command: configuredAgent.command,
        baseArgs: configuredAgent.baseArgs,
        environment: {
          ...configuredAgentLaunchEnvironment(configuredAgent, this.environment),
          YUI_HOME: resolve(this.home)
        },
        controlSocketPath: attemptControlSocketPath(this.home, attempt.id),
        ...(parentThreadId === undefined ? {} : { parentThreadId })
      }, (providerRef) => {
        attempt = attachExecutionProviderRef(attempt, providerRef, this.now());
        this.store.saveExecutionAttempt(task.id, attempt);
      });
      const externallyFinished = terminalAttemptResult(this.store, attempt);
      if (externallyFinished !== null) return externallyFinished;
      const failedChecks = response.result.checks?.filter(({ outcome }) => outcome === "failed") ?? [];
      if (failedChecks.length > 0) {
        attempt = failExecutionAttempt(attempt, response.result, this.now());
        const failed = updateWorkItemStatus(
          requireWorkItem(this.store, workItem.id),
          "failed",
          this.now(),
          response.result.summary
        );
        this.store.transaction((tx) => {
          tx.saveExecutionAttempt(task.id, attempt);
          tx.saveWorkItem(task.id, failed);
        });
        return { attempt, workItem: failed };
      }
      const changeSet = workspace === undefined
        ? null
        : await this.workspaceManager.captureChangeSet(attempt, workspace);
      attempt = completeExecutionAttempt(attempt, {
        ...response.result,
        ...(changeSet === null ? {} : { changeSetId: changeSet.id })
      }, this.now());
      const awaiting = updateWorkItemStatus(
        requireWorkItem(this.store, workItem.id),
        "awaiting_acceptance",
        this.now()
      );
      this.store.transaction((tx) => {
        tx.saveExecutionAttempt(task.id, attempt);
        tx.saveWorkItem(task.id, awaiting);
      });
      return { attempt, workItem: awaiting };
    } catch (error) {
      const externallyFinished = terminalAttemptResult(this.store, attempt);
      if (externallyFinished !== null) return externallyFinished;
      const summary = error instanceof Error ? error.message : String(error);
      attempt = failExecutionAttempt(attempt, summary, this.now());
      const failed = updateWorkItemStatus(
        requireWorkItem(this.store, workItem.id),
        "failed",
        this.now(),
        summary
      );
      this.store.transaction((tx) => {
        tx.saveExecutionAttempt(task.id, attempt);
        tx.saveWorkItem(task.id, failed);
      });
      throw error;
    }
  }
}

function terminalAttemptResult(
  store: TaskStore,
  local: ExecutionAttempt
): AttemptDispatchResult | null {
  const current = store.getExecutionAttempt(local.taskId, local.id);
  if (current === null || current.state === "running") return null;
  return {
    attempt: current,
    workItem: requireWorkItem(store, current.workItemId)
  };
}

export function selectExecutor(
  requested: "auto" | ExecutorKind,
  context: Readonly<{ parentThreadId?: string; sessionReason?: string }>
): Readonly<{ executor: ExecutorKind; sessionReason?: string }> {
  if (requested === "fork") {
    if (context.parentThreadId === undefined) {
      throw new Error("Fork execution requires a compatible Leader thread.");
    }
    return { executor: "fork" };
  }
  if (requested === "session") {
    if (context.sessionReason === undefined || context.sessionReason.trim().length === 0) {
      throw new Error("Session execution requires --session-reason.");
    }
    return { executor: "session", sessionReason: context.sessionReason.trim() };
  }
  if (requested !== "auto") {
    throw new Error(`Unsupported Attempt execution mode: ${String(requested)}.`);
  }
  if (context.parentThreadId !== undefined) return { executor: "fork" };
  throw new Error(
    "No compatible Task Leader thread is available; resume or start the Task Leader and retry, "
    + "or explicitly choose --mode session with --session-reason."
  );
}

function assertDependenciesComplete(store: TaskStore, item: WorkItem): void {
  for (const dependencyId of item.dependsOn) {
    const dependency = store.getWorkItem(item.taskId, dependencyId);
    if (dependency === null) throw new Error(`Work Item dependency not found: ${dependencyId}.`);
    if (dependency.status !== "completed") {
      throw new Error(`Work Item dependency is not completed: ${dependencyId}.`);
    }
  }
}

function assertAccessCanNarrow(maximum: AttemptAccess, requested: AttemptAccess): void {
  const rank: Readonly<Record<AttemptAccess, number>> = { read: 0, write: 1 };
  if (rank[requested] > rank[maximum]) {
    throw new Error(`Attempt access ${requested} exceeds Profile access ${maximum}.`);
  }
}

function requireProfile(
  store: TaskStore,
  id: string,
  revision?: number
): AgentProfile {
  const profile = revision === undefined
    ? store.getAgentProfile(id)
    : store.getAgentProfileRevision(id, revision);
  if (profile === null) {
    throw new Error(
      revision === undefined
        ? `Agent Profile not found: ${id}.`
        : `Agent Profile revision not found: ${id}/${revision}.`
    );
  }
  return profile;
}

function requireWorkItem(store: TaskStore, id: string): WorkItem {
  const item = store.findWorkItem(id);
  if (item === null) throw new Error(`Work Item not found: ${id}.`);
  return item;
}

function compatibleLeaderThreadId(
  store: TaskStore,
  taskId: string
): string | undefined {
  const sessions = store.getTaskRoleSessionSet(taskId, "leader");
  if (sessions === null) return undefined;
  const role = store.getRole(taskId, "leader");
  if (role === null || role.activeAgentId !== sessions.activeAgentId) return undefined;
  const binding = role.agentBindings[role.activeAgentId];
  const session = sessions.sessions[sessions.activeAgentId];
  if (
    binding?.adapterId !== "codex"
    || session?.adapterId !== "codex"
    || (session.status !== "ready" && session.status !== "running")
  ) {
    return undefined;
  }
  return session.nativeSessionId;
}

export function attemptControlSocketPath(home: string, attemptId: string): string {
  const key = createHash("sha256")
    .update(`${resolve(home)}\0${attemptId}`)
    .digest("hex")
    .slice(0, 32);
  const owner = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `yui-${owner}`, `attempt-${key}.sock`);
}

function compileAttemptInput(
  store: TaskStore,
  item: WorkItem,
  override: string | undefined
): string {
  const task = store.getTask(item.taskId);
  if (task === null) throw new Error(`Task not found: ${item.taskId}.`);
  return [
    `Task: ${task.id} (${task.title})`,
    `WorkItem: ${item.id}`,
    `Objective: ${item.objective}`,
    ...(item.acceptance.length === 0
      ? []
      : ["Acceptance criteria:", ...item.acceptance.map((value) => `- ${value}`)]),
    "Authoritative context (read only when needed):",
    `- yui task context ${task.id}`,
    ...(task.projectId === undefined
      ? []
      : [
          `- yui project show ${task.projectId}`,
          `- yui project knowledge list ${task.projectId}`,
          `- yui project knowledge show ${task.projectId} <knowledge-id>`
        ]),
    "Use Yui CLI reads as the current context authority. Do not mutate Yui records.",
    ...(override === undefined ? [] : ["Additional dispatch input:", override])
  ].join("\n");
}

async function inspectTaskBaseCommit(
  store: TaskStore,
  taskId: string
): Promise<string | undefined> {
  const task = store.getTask(taskId);
  if (task?.projectId === undefined) return undefined;
  const project = store.getProject(task.projectId);
  if (project === null) throw new Error(`Project not found: ${task.projectId}.`);
  return (await new NodeGitWorkspace().inspect(
    task.cwd ?? project.path,
    task.cwd === undefined ? task.baseRef ?? project.developmentBranch : "HEAD"
  )).baseCommit;
}

function taskProjectPath(store: TaskStore, taskId: string): string | undefined {
  const task = store.getTask(taskId);
  if (task?.projectId === undefined) return task?.cwd;
  return task.cwd ?? store.getProject(task.projectId)?.path;
}
