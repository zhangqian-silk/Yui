import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateConfiguredAgent, type ConfiguredAgent } from "../agent/agent.js";
import type { TaskBrief } from "../brief/taskBrief.js";
import { reconciliationIntervalMilliseconds } from "../config/yuiConfig.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import {
  mailboxTargetKey,
  validateWorkMailbox,
  type MailboxEntityRef,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import type { Decision } from "../decision/decision.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  validateInputRequest,
  type InputRequest
} from "../input/inputRequest.js";
import {
  validateRoleSessionSet,
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { validateTaskMessage, type TaskMessage } from "../message/message.js";
import type { Milestone } from "../milestone/milestone.js";
import { validateAgentRun, type AgentRun } from "../run/agentRun.js";
import {
  assertProjectCatalog,
  validateProject,
  type Project
} from "../repository/project.js";
import {
  validateGlobalRole,
  validateTaskRole,
  type GlobalRole,
  type TaskRole
} from "../role/role.js";
import type { LeaderFailure } from "../scheduler/leaderFailure.js";
import type { OperatorNotification } from "../scheduler/operatorNotification.js";
import type { PendingWakeup } from "../scheduler/pendingWakeup.js";
import { validateTask, type Task } from "../task/task.js";
import { validateWorkItem, type WorkItem } from "../workItem/workItem.js";
import {
  validateRoleWorkspace,
  type RoleWorkspace
} from "../worktree/roleWorkspace.js";
import { writeTextFileAtomically } from "./durableFile.js";
import { requireStorageSchema } from "./storageSchema.js";

export const STORAGE_STATE_FILE = "state.json";
const STORAGE_LOCK_DIRECTORY = ".state.lock";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = typeof COMPLETION_SHELLS[number];
export type CompletionInstallation = Readonly<{
  scriptPath: string;
  activationPath: string;
}>;
export type YuiConfig = Readonly<{
  schemaVersion: 1;
  defaultAgent?: string;
  defaultWorkspace?: string;
  timeZone?: string;
  currentTaskId?: string;
  lastTaskId?: string;
  reconciliationIntervalSeconds?: number;
  completionInstallations?: Partial<Record<CompletionShell, CompletionInstallation>>;
}>;
export type ConfiguredAgentPatch = Readonly<Partial<
  Pick<ConfiguredAgent, "adapterId" | "command" | "baseArgs" | "environment">
>>;
export type ConfiguredAgentUpdateResult = Readonly<{
  status: "updated" | "unchanged";
  agent: ConfiguredAgent;
}>;

type ActiveRunPointer = Readonly<{ schemaVersion: 1; runId: string }>;
type StoredTask = {
  schemaVersion: 4;
  task: Task;
  brief: TaskBrief | null;
  roles: Record<string, TaskRole>;
  roleWorkspaces: Record<string, RoleWorkspace>;
  roleSessionSets: Record<string, TaskRoleSessionSet>;
  workItems: Record<string, WorkItem>;
  agentRuns: Record<string, AgentRun>;
  activeRuns: Record<string, ActiveRunPointer>;
  messages: Record<string, TaskMessage>;
  inputRequests: Record<string, InputRequest>;
  decisions: Record<string, Decision>;
  milestones: Record<string, Milestone>;
  events: Record<string, TaskEvent>;
  leaderFailure: LeaderFailure | null;
  operatorNotification: OperatorNotification | null;
};

type StorageState = {
  schemaVersion: 4;
  revision: number;
  config: YuiConfig;
  configuredAgents: Record<string, ConfiguredAgent>;
  projects: Record<string, Project>;
  globalRoles: Record<string, GlobalRole>;
  globalRoleSessionSets: Record<string, GlobalRoleSessionSet>;
  tasks: Record<string, StoredTask>;
  mailboxes: Record<string, WorkMailbox>;
};

export type TaskStore = {
  rootDirectory(): string;
  transaction<T>(execute: (store: TaskStore) => T): T;
  getConfig(): YuiConfig;
  saveConfig(config: YuiConfig): void;
  saveConfiguredAgent(agent: ConfiguredAgent): void;
  createConfiguredAgentIfAbsent(agent: ConfiguredAgent): ConfiguredAgent | null;
  updateConfiguredAgent(id: string, patch: ConfiguredAgentPatch, now: Date): ConfiguredAgentUpdateResult | null;
  listConfiguredAgents(): ConfiguredAgent[];
  getConfiguredAgent(id: string): ConfiguredAgent | null;
  removeConfiguredAgent(id: string): boolean;
  nextProjectId(): string;
  saveProject(project: Project): void;
  createProjectIfAbsent(project: Project): Project | null;
  listProjects(): Project[];
  getProject(id: string): Project | null;
  removeProject(id: string): boolean;
  saveGlobalRole(role: GlobalRole): void;
  saveGlobalRoleWithSessionSet(role: GlobalRole, sessions: GlobalRoleSessionSet | null): void;
  createGlobalRoleIfAbsent(role: GlobalRole): GlobalRole | null;
  listGlobalRoles(): GlobalRole[];
  getGlobalRole(name: string): GlobalRole | null;
  removeGlobalRole(name: string): boolean;
  getGlobalRoleSessionSet(name: string): GlobalRoleSessionSet | null;
  listGlobalRoleSessionSets(): GlobalRoleSessionSet[];
  saveGlobalRoleSessionSet(sessions: GlobalRoleSessionSet): void;
  nextTaskId(): string;
  saveTask(task: Task): void;
  listTasks(): Task[];
  getTask(id: string): Task | null;
  getTaskBrief(taskId: string): TaskBrief | null;
  saveTaskBrief(taskId: string, brief: TaskBrief): void;
  clearTaskBrief(taskId: string): void;
  saveRole(taskId: string, role: TaskRole): void;
  listRoles(taskId: string): TaskRole[];
  getRole(taskId: string, name: string): TaskRole | null;
  saveTaskRoleWithSessionSet(role: TaskRole, sessions: TaskRoleSessionSet): void;
  removeTaskRole(taskId: string, name: string): boolean;
  saveRoleWorkspace(taskId: string, workspace: RoleWorkspace): void;
  listRoleWorkspaces(taskId: string): RoleWorkspace[];
  getRoleWorkspace(taskId: string, roleName: string): RoleWorkspace | null;
  removeRoleWorkspace(taskId: string, roleName: string): boolean;
  getRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null;
  getTaskRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null;
  listRoleSessionSets(taskId: string): TaskRoleSessionSet[];
  saveRoleSessionSet(sessions: TaskRoleSessionSet): void;
  saveTaskRoleSessionSet(sessions: TaskRoleSessionSet): void;
  getRoleSession(taskId: string, roleName: string): RoleAgentSession | null;
  nextWorkItemId(taskId: string): string;
  getWorkItem(taskId: string, workItemId: string): WorkItem | null;
  findWorkItem(workItemId: string): WorkItem | null;
  listWorkItems(taskId: string): WorkItem[];
  saveWorkItem(taskId: string, item: WorkItem): void;
  nextAgentRunId(taskId: string): string;
  getAgentRun(taskId: string, runId: string): AgentRun | null;
  findAgentRun(runId: string): AgentRun | null;
  listAgentRuns(taskId: string): AgentRun[];
  saveAgentRun(run: AgentRun): void;
  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null;
  saveActiveAgentRun(run: AgentRun): void;
  clearActiveAgentRun(taskId: string, roleName: string): void;
  nextMessageId(taskId: string): string;
  saveMessage(taskId: string, message: TaskMessage): void;
  listMessages(taskId: string): TaskMessage[];
  nextInputRequestId(taskId: string): string;
  saveInputRequest(taskId: string, request: InputRequest): void;
  getInputRequest(taskId: string, requestId: string): InputRequest | null;
  findInputRequest(requestId: string): InputRequest | null;
  listInputRequests(taskId: string): InputRequest[];
  listAllInputRequests(): InputRequest[];
  nextDecisionId(taskId: string): string;
  saveDecision(taskId: string, decision: Decision): void;
  listDecisions(taskId: string): Decision[];
  getDecision(taskId: string, decisionId: string): Decision | null;
  nextMilestoneId(taskId: string): string;
  saveMilestone(taskId: string, milestone: Milestone): void;
  listMilestones(taskId: string): Milestone[];
  getMilestone(taskId: string, milestoneId: string): Milestone | null;
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
  listEvents(taskId: string): TaskEvent[];
  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
  listWorkMailboxes(): WorkMailbox[];
  saveWorkMailbox(mailbox: WorkMailbox): void;
  removeWorkMailbox(target: MailboxTarget): boolean;
  /** @deprecated Transitional projection over the Leader Role WorkMailbox. It cannot expose processing batches or refs. */
  getPendingWakeup(taskId: string): PendingWakeup | null;
  listPendingWakeups(): PendingWakeup[];
  savePendingWakeup(wakeup: PendingWakeup): void;
  clearPendingWakeup(taskId: string): void;
  getLeaderFailure(taskId: string): LeaderFailure | null;
  saveLeaderFailure(failure: LeaderFailure): void;
  clearLeaderFailure(taskId: string): void;
  getOperatorNotification(taskId: string): OperatorNotification | null;
  saveOperatorNotification(notification: OperatorNotification): void;
  clearOperatorNotification(taskId: string): void;
};

export class FileTaskStore implements TaskStore {
  #transaction: { state: StorageState; baseRevision: number; dirty: boolean } | null = null;

  constructor(private readonly rootDir: string) {
    requireStorageSchema(rootDir);
  }

  rootDirectory(): string { return this.rootDir; }

  transaction<T>(execute: (store: TaskStore) => T): T {
    if (this.#transaction !== null) return synchronousResult(execute(this));
    return this.#withWriteLock(() => {
      const state = this.#readState();
      this.#transaction = { state, baseRevision: state.revision, dirty: false };
      try {
        const result = synchronousResult(execute(this));
        if (this.#transaction.dirty) this.#commit(state, this.#transaction.baseRevision);
        return result;
      } finally {
        this.#transaction = null;
      }
    });
  }

  getConfig(): YuiConfig { return clone(this.#state().config); }
  saveConfig(config: YuiConfig): void {
    const stored = versioned<YuiConfig>(config, 1, "Yui config");
    validateYuiConfig(stored);
    this.#mutate((state) => { state.config = stored; });
  }

  saveConfiguredAgent(agent: ConfiguredAgent): void {
    const stored = identified<ConfiguredAgent>(agent, 2, "id", agent.id, "Configured Agent");
    validateConfiguredAgent(stored);
    this.#mutate((state) => { state.configuredAgents[stored.id] = stored; });
  }
  createConfiguredAgentIfAbsent(agent: ConfiguredAgent): ConfiguredAgent | null {
    return this.transaction((store) => {
      if (store.getConfiguredAgent(agent.id) !== null) return null;
      store.saveConfiguredAgent(agent);
      return clone(agent);
    });
  }
  updateConfiguredAgent(
    id: string,
    patch: ConfiguredAgentPatch,
    now: Date
  ): ConfiguredAgentUpdateResult | null {
    return this.transaction((store) => {
      const existing = store.getConfiguredAgent(id);
      if (existing === null) return null;
      const candidate = versioned<ConfiguredAgent>({
        ...existing,
        ...clone(patch),
        updatedAt: now.toISOString()
      }, 2, "Configured Agent");
      const unchanged = isDeepStrictEqual(
        { ...existing, updatedAt: candidate.updatedAt },
        candidate
      );
      if (unchanged) return { status: "unchanged", agent: existing };
      store.saveConfiguredAgent(candidate);
      return { status: "updated", agent: candidate };
    });
  }
  listConfiguredAgents(): ConfiguredAgent[] { return values(this.#state().configuredAgents, "id"); }
  getConfiguredAgent(id: string): ConfiguredAgent | null { return optional(this.#state().configuredAgents[id]); }
  removeConfiguredAgent(id: string): boolean {
    return this.#remove((state) => state.configuredAgents, id);
  }

  nextProjectId(): string {
    return this.#nextGlobalId("project", (state) => Object.keys(state.projects));
  }
  saveProject(project: Project): void {
    const stored = identified<Project>(
      project,
      2,
      "id",
      project.id,
      "Project"
    );
    validateProject(stored);
    this.#mutate((state) => {
      assertProjectCatalog([
        ...Object.values(state.projects).filter(({ id }) => id !== stored.id),
        stored
      ]);
      state.projects[stored.id] = stored;
    });
  }
  createProjectIfAbsent(project: Project): Project | null {
    validateProject(project);
    return this.transaction((store) => {
      if (store.getProject(project.id) !== null) return null;
      try {
        assertProjectCatalog([...store.listProjects(), project]);
      } catch {
        return null;
      }
      store.saveProject(project);
      return clone(project);
    });
  }
  listProjects(): Project[] { return values(this.#state().projects, "id"); }
  getProject(id: string): Project | null { return optional(this.#state().projects[id]); }
  removeProject(id: string): boolean {
    return this.transaction((store) => {
      if (store.listTasks().some((task) => task.projectId === id)) {
        throw new StorageRecordError(`Project is still used by a Task: ${id}`);
      }
      return this.#remove((state) => state.projects, id);
    });
  }

  saveGlobalRole(role: GlobalRole): void {
    const stored = identified<GlobalRole>(role, 2, "name", role.name, "Global Role");
    validateGlobalRole(stored);
    const sessions = this.getGlobalRoleSessionSet(stored.name);
    if (sessions !== null) assertSessionsMatchRole(sessions, stored);
    this.#mutate((state) => { state.globalRoles[stored.name] = stored; });
  }
  saveGlobalRoleWithSessionSet(role: GlobalRole, sessions: GlobalRoleSessionSet | null): void {
    const storedRole = identified<GlobalRole>(role, 2, "name", role.name, "Global Role");
    validateGlobalRole(storedRole);
    const storedSessions = sessions === null ? null : globalSessions(sessions);
    if (storedSessions !== null) assertSessionsMatchRole(storedSessions, storedRole);
    this.transaction(() => {
      this.#mutate((state) => {
        state.globalRoles[storedRole.name] = storedRole;
        if (storedSessions === null) delete state.globalRoleSessionSets[storedRole.name];
        else state.globalRoleSessionSets[storedRole.name] = storedSessions;
      });
    });
  }
  createGlobalRoleIfAbsent(role: GlobalRole): GlobalRole | null {
    return this.transaction((store) => {
      if (store.getGlobalRole(role.name) !== null) return null;
      store.saveGlobalRole(role);
      return clone(role);
    });
  }
  listGlobalRoles(): GlobalRole[] { return values(this.#state().globalRoles, "name"); }
  getGlobalRole(name: string): GlobalRole | null { return optional(this.#state().globalRoles[name]); }
  removeGlobalRole(name: string): boolean {
    return this.transaction(() => {
      const removed = this.#remove((state) => state.globalRoles, name);
      this.#mutate((state) => { delete state.globalRoleSessionSets[name]; });
      return removed;
    });
  }
  getGlobalRoleSessionSet(name: string): GlobalRoleSessionSet | null {
    return optional(this.#state().globalRoleSessionSets[name]);
  }
  listGlobalRoleSessionSets(): GlobalRoleSessionSet[] {
    return values(this.#state().globalRoleSessionSets, (set) => set.owner.roleName);
  }
  saveGlobalRoleSessionSet(sessions: GlobalRoleSessionSet): void {
    const stored = globalSessions(sessions);
    const role = this.getGlobalRole(stored.owner.roleName);
    if (role === null) throw new StorageRecordError(`Global Role not found: ${stored.owner.roleName}`);
    assertSessionsMatchRole(stored, role);
    this.#mutate((state) => { state.globalRoleSessionSets[stored.owner.roleName] = stored; });
  }

  nextTaskId(): string { return this.#nextGlobalId("task", (state) => Object.keys(state.tasks)); }
  saveTask(task: Task): void {
    const stored = validateTask(identified<Task>(task, 1, "id", task.id, "Task"));
    this.#mutate((state) => {
      if (stored.projectId !== undefined && state.projects[stored.projectId] === undefined) {
        throw new StorageRecordError(`Task Project not found: ${stored.projectId}`);
      }
      const aggregate = state.tasks[stored.id] ?? emptyStoredTask(stored);
      aggregate.task = stored;
      state.tasks[stored.id] = aggregate;
    });
  }
  listTasks(): Task[] { return values(this.#state().tasks, (aggregate) => aggregate.task.id).map((entry) => clone(entry.task)); }
  getTask(id: string): Task | null { return optional(this.#state().tasks[id]?.task); }
  getTaskBrief(taskId: string): TaskBrief | null {
    return optional(this.#state().tasks[taskId]?.brief ?? undefined);
  }
  saveTaskBrief(taskId: string, brief: TaskBrief): void {
    const stored = storedTaskBrief(brief);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { state.tasks[taskId].brief = stored; });
  }
  clearTaskBrief(taskId: string): void {
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { state.tasks[taskId].brief = null; });
  }
  saveRole(taskId: string, role: TaskRole): void {
    const aggregate = this.#requireTaskForWrite(taskId);
    const stored = identified<TaskRole>(role, 2, "name", role.name, "Task Role");
    if (stored.taskId !== taskId) throw new StorageRecordError(`Task Role belongs to another Task: ${stored.taskId}`);
    validateTaskRole(stored);
    const sessions = this.getRoleSessionSet(taskId, stored.name);
    if (sessions !== null) assertSessionsMatchRole(sessions, stored);
    this.#mutate((state) => { state.tasks[aggregate.task.id].roles[stored.name] = stored; });
  }
  listRoles(taskId: string): TaskRole[] { return values(this.#requireTask(taskId).roles, "name"); }
  getRole(taskId: string, name: string): TaskRole | null { return optional(this.#state().tasks[taskId]?.roles[name]); }
  saveTaskRoleWithSessionSet(role: TaskRole, sessions: TaskRoleSessionSet): void {
    const storedRole = identified<TaskRole>(role, 2, "name", role.name, "Task Role");
    validateTaskRole(storedRole);
    const storedSessions = taskSessions(sessions);
    assertSessionsMatchRole(storedSessions, storedRole);
    this.transaction(() => {
      this.#requireTaskForWrite(storedRole.taskId);
      this.#mutate((state) => {
        state.tasks[storedRole.taskId].roles[storedRole.name] = storedRole;
        state.tasks[storedRole.taskId].roleSessionSets[storedRole.name] = storedSessions;
      });
    });
  }
  removeTaskRole(taskId: string, name: string): boolean {
    return this.transaction(() => {
      const aggregate = this.#requireTask(taskId);
      if (aggregate.roleWorkspaces[name] !== undefined) {
        throw new StorageRecordError(`Task Role workspace must be cleaned before removing the Role: ${taskId}/${name}`);
      }
      const removed = this.#remove(() => aggregate.roles, name);
      this.#mutate((state) => {
        delete aggregate.roleSessionSets[name];
        delete aggregate.activeRuns[name];
        delete state.mailboxes[mailboxTargetKey({ kind: "role", taskId, roleName: name })];
      });
      return removed;
    });
  }
  saveRoleWorkspace(taskId: string, workspace: RoleWorkspace): void {
    const aggregate = this.#requireTaskForWrite(taskId);
    const stored = clone(workspace);
    validateRoleWorkspace(stored);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`RoleWorkspace belongs to another Task: ${stored.taskId}`);
    }
    if (aggregate.roles[stored.roleName] === undefined) {
      throw new StorageRecordError(`Task Role not found: ${taskId}/${stored.roleName}`);
    }
    if (aggregate.task.projectId !== stored.projectId) {
      throw new StorageRecordError(`RoleWorkspace Project does not match Task: ${taskId}/${stored.roleName}`);
    }
    this.#mutate((state) => {
      state.tasks[taskId].roleWorkspaces[stored.roleName] = stored;
    });
  }
  listRoleWorkspaces(taskId: string): RoleWorkspace[] {
    return values(this.#requireTask(taskId).roleWorkspaces, "roleName");
  }
  getRoleWorkspace(taskId: string, roleName: string): RoleWorkspace | null {
    return optional(this.#state().tasks[taskId]?.roleWorkspaces[roleName]);
  }
  removeRoleWorkspace(taskId: string, roleName: string): boolean {
    this.#requireTaskForWrite(taskId);
    return this.#remove((state) => state.tasks[taskId].roleWorkspaces, roleName);
  }
  getRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null {
    return optional(this.#state().tasks[taskId]?.roleSessionSets[roleName]);
  }
  getTaskRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null {
    return this.getRoleSessionSet(taskId, roleName);
  }
  listRoleSessionSets(taskId: string): TaskRoleSessionSet[] {
    return values(this.#requireTask(taskId).roleSessionSets, (set) => set.owner.roleName);
  }
  saveRoleSessionSet(sessions: TaskRoleSessionSet): void {
    const stored = taskSessions(sessions);
    const taskId = stored.owner.taskId;
    this.#requireTaskForWrite(taskId);
    const role = this.getRole(taskId, stored.owner.roleName);
    if (role === null) throw new StorageRecordError(`Task Role not found: ${taskId}/${stored.owner.roleName}`);
    assertSessionsMatchRole(stored, role);
    this.#mutate((state) => { state.tasks[taskId].roleSessionSets[stored.owner.roleName] = stored; });
  }
  saveTaskRoleSessionSet(sessions: TaskRoleSessionSet): void { this.saveRoleSessionSet(sessions); }
  getRoleSession(taskId: string, roleName: string): RoleAgentSession | null {
    const set = this.getRoleSessionSet(taskId, roleName);
    return set === null ? null : optional(set.sessions[set.activeAgentId]);
  }

  nextWorkItemId(_taskId: string): string { return this.#nextGlobalId("work-item", (state) => allKeys(state, "workItems")); }
  getWorkItem(taskId: string, id: string): WorkItem | null { return optional(this.#state().tasks[taskId]?.workItems[id]); }
  findWorkItem(id: string): WorkItem | null { return findUnique(this.#state(), "workItems", id, "Work item"); }
  listWorkItems(taskId: string): WorkItem[] { return values(this.#requireTask(taskId).workItems, "id"); }
  saveWorkItem(taskId: string, item: WorkItem): void {
    const stored = identified<WorkItem>(item, 1, "id", item.id, "Work item");
    validateWorkItem(stored);
    if (stored.taskId !== taskId) throw new StorageRecordError(`Work item belongs to another Task: ${stored.taskId}`);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { state.tasks[taskId].workItems[stored.id] = stored; });
  }

  nextAgentRunId(_taskId: string): string { return this.#nextGlobalId("agent-run", (state) => allKeys(state, "agentRuns")); }
  getAgentRun(taskId: string, id: string): AgentRun | null { return optional(this.#state().tasks[taskId]?.agentRuns[id]); }
  findAgentRun(id: string): AgentRun | null { return findUnique(this.#state(), "agentRuns", id, "Agent run"); }
  listAgentRuns(taskId: string): AgentRun[] { return values(this.#requireTask(taskId).agentRuns, "id"); }
  saveAgentRun(run: AgentRun): void {
    const stored = identified<AgentRun>(run, 1, "id", run.id, "Agent run");
    validateAgentRun(stored);
    this.#requireTaskForWrite(stored.taskId);
    this.#mutate((state) => { state.tasks[stored.taskId].agentRuns[stored.id] = stored; });
  }
  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null {
    const aggregate = this.#state().tasks[taskId];
    const pointer = aggregate?.activeRuns[roleName];
    if (aggregate === undefined || pointer === undefined) return null;
    const run = aggregate.agentRuns[pointer.runId];
    if (run === undefined) throw new StorageRecordError(`Active Agent run pointer is dangling: ${taskId}/${roleName}`);
    return clone(run);
  }
  saveActiveAgentRun(run: AgentRun): void {
    if (run.status !== "active") throw new StorageRecordError(`Active Agent run must have active status: ${run.id}`);
    this.transaction((store) => {
      const current = store.getActiveAgentRun(run.taskId, run.roleName);
      if (current !== null && current.id !== run.id) {
        throw new StorageRecordError(`Role already has an active Agent run: ${run.taskId}/${run.roleName}`);
      }
      const sessions = store.getTaskRoleSessionSet(run.taskId, run.roleName);
      if (sessions !== null && sessions.inFlight !== null && sessions.inFlight.runId !== run.id) {
        throw new StorageRecordError(
          `Role still has an in-flight Turn: ${run.taskId}/${run.roleName}/${sessions.inFlight.runId}`
        );
      }
      store.saveAgentRun(run);
      this.#mutate((state) => {
        state.tasks[run.taskId].activeRuns[run.roleName] = { schemaVersion: 1, runId: run.id };
      });
    });
  }
  clearActiveAgentRun(taskId: string, roleName: string): void {
    this.#mutate((state) => { const task = state.tasks[taskId]; if (task !== undefined) delete task.activeRuns[roleName]; });
  }

  nextMessageId(_taskId: string): string { return this.#nextGlobalId("message", (state) => allKeys(state, "messages")); }
  saveMessage(taskId: string, message: TaskMessage): void {
    validateTaskMessage(message);
    this.#saveTaskRecord(taskId, "messages", message, "Message");
  }
  listMessages(taskId: string): TaskMessage[] { return values(this.#requireTask(taskId).messages, "id"); }
  nextInputRequestId(_taskId: string): string {
    return this.#nextGlobalId("input", (state) => allKeys(state, "inputRequests"));
  }
  saveInputRequest(taskId: string, request: InputRequest): void {
    const stored = validateInputRequest(request);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Input request belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      const owner = taskRecordOwner(state, "inputRequests", stored.id);
      if (owner !== null && owner !== taskId) {
        throw new StorageRecordError(`Input request already exists in another Task: ${stored.id}`);
      }
      const existing = aggregate.inputRequests[stored.id];
      if (existing === undefined && stored.status !== "open") {
        throw new StorageRecordError(`Input request must start open: ${stored.id}`);
      }
      if (existing !== undefined && !isValidInputRequestTransition(existing, stored)) {
        throw new StorageRecordError(`Input request cannot be overwritten: ${stored.id}`);
      }
      aggregate.inputRequests[stored.id] = stored;
    });
  }
  getInputRequest(taskId: string, requestId: string): InputRequest | null {
    return optional(this.#state().tasks[taskId]?.inputRequests[requestId]);
  }
  findInputRequest(requestId: string): InputRequest | null {
    return findUnique(this.#state(), "inputRequests", requestId, "Input request");
  }
  listInputRequests(taskId: string): InputRequest[] {
    return values(this.#requireTask(taskId).inputRequests, "id");
  }
  listAllInputRequests(): InputRequest[] {
    return Object.values(this.#state().tasks)
      .flatMap((aggregate) => Object.values(aggregate.inputRequests).map(clone))
      .sort((left, right) => numericCompare(left.id, right.id));
  }
  nextDecisionId(_taskId: string): string {
    return this.#nextGlobalId("decision", (state) => allKeys(state, "decisions"));
  }
  saveDecision(taskId: string, decision: Decision): void {
    const stored = storedDecision(decision);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Decision belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      const owner = taskRecordOwner(state, "decisions", stored.id);
      if (owner !== null && owner !== taskId) {
        throw new StorageRecordError(`Decision already exists in another Task: ${stored.id}`);
      }
      const existing = aggregate.decisions[stored.id];
      if (existing === undefined && stored.status !== "active") {
        throw new StorageRecordError(`Decision must start active: ${stored.id}`);
      }
      if (existing !== undefined && !isValidDecisionSupersession(existing, stored)) {
        throw new StorageRecordError(`Decision cannot be overwritten: ${stored.id}`);
      }
      aggregate.decisions[stored.id] = stored;
    });
  }
  listDecisions(taskId: string): Decision[] {
    return values(this.#requireTask(taskId).decisions, "id");
  }
  getDecision(taskId: string, decisionId: string): Decision | null {
    return this.#requireTask(taskId).decisions[decisionId] ?? null;
  }
  nextMilestoneId(_taskId: string): string {
    return this.#nextGlobalId("milestone", (state) => allKeys(state, "milestones"));
  }
  saveMilestone(taskId: string, milestone: Milestone): void {
    const stored = storedMilestone(milestone);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Milestone belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      if (taskRecordOwner(state, "milestones", stored.id) !== null) {
        throw new StorageRecordError(`Milestone already exists: ${stored.id}`);
      }
      aggregate.milestones[stored.id] = stored;
    });
  }
  listMilestones(taskId: string): Milestone[] {
    return values(this.#requireTask(taskId).milestones, "id");
  }
  getMilestone(taskId: string, milestoneId: string): Milestone | null {
    return this.#requireTask(taskId).milestones[milestoneId] ?? null;
  }
  nextEventId(_taskId: string): string { return this.#nextGlobalId("event", (state) => allKeys(state, "events")); }
  saveEvent(taskId: string, event: TaskEvent): void {
    const stored = storedTaskEvent(event);
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      if (taskRecordOwner(state, "events", stored.id) !== null) {
        throw new StorageRecordError(`Task event already exists: ${stored.id}`);
      }
      aggregate.events[stored.id] = stored;
    });
  }
  listEvents(taskId: string): TaskEvent[] { return values(this.#requireTask(taskId).events, "id"); }

  getWorkMailbox(target: MailboxTarget): WorkMailbox | null {
    return optional(this.#state().mailboxes[mailboxTargetKey(target)]);
  }
  listWorkMailboxes(): WorkMailbox[] {
    return Object.entries(this.#state().mailboxes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, mailbox]) => clone(mailbox));
  }
  saveWorkMailbox(value: WorkMailbox): void {
    let mailbox: WorkMailbox;
    try { mailbox = validateWorkMailbox(value); }
    catch (error) { throw new StorageRecordError(error instanceof Error ? error.message : String(error)); }
    this.#mutate((state) => {
      validateMailboxReferences(state, mailbox);
      state.mailboxes[mailboxTargetKey(mailbox.target)] = clone(mailbox);
    });
  }
  removeWorkMailbox(target: MailboxTarget): boolean {
    return this.#remove((state) => state.mailboxes, mailboxTargetKey(target));
  }

  getPendingWakeup(taskId: string): PendingWakeup | null {
    return pendingWakeupProjection(this.getWorkMailbox({ kind: "role", taskId, roleName: "leader" }));
  }
  listPendingWakeups(): PendingWakeup[] {
    return this.listWorkMailboxes()
      .flatMap((mailbox) => {
        const wakeup = pendingWakeupProjection(mailbox);
        return wakeup === null ? [] : [wakeup];
      })
      .sort((a, b) => numericCompare(a.taskId, b.taskId));
  }
  savePendingWakeup(value: PendingWakeup): void {
    const wakeup = identified<PendingWakeup>(value, 1, "taskId", value.taskId, "Pending wakeup");
    const target: MailboxTarget = { kind: "role", taskId: wakeup.taskId, roleName: "leader" };
    this.transaction(() => {
      const existing = this.getWorkMailbox(target);
      if (existing !== null && existing.pending !== null
        && wakeup.requestCount <= existing.pending.requestCount) {
        throw new StorageRecordError(`Pending wakeup is stale: ${wakeup.taskId}`);
      }
      const fromSequence = existing?.pending?.fromSequence ?? existing?.nextSequence ?? 1;
      const toSequence = fromSequence + wakeup.requestCount - 1;
      this.saveWorkMailbox({
        schemaVersion: 1,
        target,
        nextSequence: Math.max(existing?.nextSequence ?? 1, toSequence + 1),
        processing: existing?.processing ?? null,
        pending: {
          ...existing?.pending,
          fromSequence,
          toSequence,
          reasons: [...wakeup.reasons],
          refs: existing?.pending?.refs ?? [],
          requestCount: wakeup.requestCount,
          firstQueuedAt: wakeup.firstRequestedAt,
          lastQueuedAt: wakeup.lastRequestedAt
        }
      });
    });
  }
  clearPendingWakeup(taskId: string): void {
    this.removeWorkMailbox({ kind: "role", taskId, roleName: "leader" });
  }
  getLeaderFailure(taskId: string): LeaderFailure | null { return optional(this.#state().tasks[taskId]?.leaderFailure ?? undefined); }
  saveLeaderFailure(value: LeaderFailure): void { this.#saveSingleton(value.taskId, "leaderFailure", value, "Leader failure"); }
  clearLeaderFailure(taskId: string): void { this.#clearSingleton(taskId, "leaderFailure"); }
  getOperatorNotification(taskId: string): OperatorNotification | null { return optional(this.#state().tasks[taskId]?.operatorNotification ?? undefined); }
  saveOperatorNotification(value: OperatorNotification): void { this.#saveSingleton(value.taskId, "operatorNotification", value, "Operator notification"); }
  clearOperatorNotification(taskId: string): void { this.#clearSingleton(taskId, "operatorNotification"); }

  #saveSingleton<K extends "leaderFailure" | "operatorNotification">(
    taskId: string, key: K, value: StoredTask[K], label: string
  ): void {
    const stored = identified<StoredTask[K]>(value, 1, "taskId", taskId, label);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { state.tasks[taskId][key] = stored; });
  }
  #clearSingleton(key: string, field: "leaderFailure" | "operatorNotification"): void {
    this.#mutate((state) => { if (state.tasks[key] !== undefined) state.tasks[key][field] = null; });
  }
  #saveTaskRecord<K extends "messages">(
    taskId: string, key: K, value: StoredTask[K][string], label: string
  ): void {
    const record = versioned<{ schemaVersion: 1; id: string }>(value, 1, label);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => {
      if (taskRecordOwner(state, key, record.id) !== null) {
        throw new StorageRecordError(`${label} already exists: ${record.id}`);
      }
      (state.tasks[taskId][key] as Record<string, typeof value>)[record.id] = clone(value);
    });
  }
  #requireTask(taskId: string): StoredTask {
    const aggregate = this.#state().tasks[taskId];
    if (aggregate === undefined) throw new StorageRecordError(`Task not found: ${taskId}`);
    return aggregate;
  }
  #requireTaskForWrite(taskId: string): StoredTask { return this.#requireTask(taskId); }

  #state(): StorageState { return this.#transaction?.state ?? this.#readState(); }
  #mutate(execute: (state: StorageState) => void): void { this.#mutateResult((state) => { execute(state); }); }
  #mutateResult<T>(execute: (state: StorageState) => T): T {
    if (this.#transaction !== null) {
      const result = execute(this.#transaction.state);
      this.#transaction.dirty = true;
      return result;
    }
    return this.#withWriteLock(() => {
      const state = this.#readState();
      const result = execute(state);
      this.#commit(state, state.revision);
      return result;
    });
  }
  #remove<T>(select: (state: StorageState) => Record<string, T>, id: string): boolean {
    return this.#mutateResult((state) => {
      const records = select(state);
      if (records[id] === undefined) return false;
      delete records[id];
      return true;
    });
  }
  #nextGlobalId(prefix: string, collect: (state: StorageState) => string[]): string {
    const pattern = new RegExp(`^${prefix}-(\\d+)$`);
    const maximum = collect(this.#state()).reduce((max, id) => {
      const match = pattern.exec(id);
      return match === null ? max : Math.max(max, Number.parseInt(match[1], 10));
    }, 0);
    return `${prefix}-${maximum + 1}`;
  }

  #readState(): StorageState {
    requireStorageSchema(this.rootDir);
    const path = join(this.rootDir, STORAGE_STATE_FILE);
    if (!existsSync(path)) return emptyState();
    return parseState(readFileSync(path, "utf8"));
  }
  #commit(state: StorageState, expectedRevision: number): void {
    const current = this.#readState();
    if (current.revision !== expectedRevision) {
      throw new StorageConflictError(`Storage changed concurrently (expected revision ${expectedRevision}, found ${current.revision}).`);
    }
    state.revision = expectedRevision + 1;
    const content = `${JSON.stringify(state, null, 2)}\n`;
    parseState(content);
    writeTextFileAtomically(join(this.rootDir, STORAGE_STATE_FILE), content);
  }
  #withWriteLock<T>(execute: () => T): T {
    const release = acquireStorageLock(this.rootDir);
    try { return execute(); } finally { release(); }
  }
}

export class StorageRecordError extends Error { constructor(message: string) { super(message); this.name = "StorageRecordError"; } }
export class StorageConflictError extends Error { constructor(message: string) { super(message); this.name = "StorageConflictError"; } }

export function resolveYuiHome(env: NodeJS.ProcessEnv): string {
  return env.YUI_HOME === undefined || env.YUI_HOME.length === 0
    ? join(homedir(), ".yui")
    : resolve(env.YUI_HOME);
}
export function ensureYuiHome(rootDir: string): void { mkdirSync(rootDir, { recursive: true, mode: 0o700 }); }

function emptyState(): StorageState {
  return { schemaVersion: 4, revision: 0, config: { schemaVersion: 1 }, configuredAgents: {}, projects: {}, globalRoles: {}, globalRoleSessionSets: {}, tasks: {}, mailboxes: {} };
}
function emptyStoredTask(task: Task): StoredTask {
  return {
    schemaVersion: 4,
    task,
    brief: null,
    roles: {},
    roleWorkspaces: {},
    roleSessionSets: {},
    workItems: {},
    agentRuns: {},
    activeRuns: {},
    messages: {},
    inputRequests: {},
    decisions: {},
    milestones: {},
    events: {},
    leaderFailure: null,
    operatorNotification: null
  };
}

function parseState(raw: string): StorageState {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch (error) { throw new StorageRecordError(`Invalid ${STORAGE_STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`); }
  const state = object(parsed, "Storage state");
  exact(state, ["schemaVersion", "revision", "config", "configuredAgents", "projects", "globalRoles", "globalRoleSessionSets", "tasks", "mailboxes"], "Storage state");
  if (state.schemaVersion !== 4 || !Number.isInteger(state.revision) || (state.revision as number) < 0) throw new StorageRecordError("Storage state schemaVersion/revision is invalid.");
  const result = clone(state) as unknown as StorageState;
  result.config = versioned(result.config, 1, "Yui config");
  validateYuiConfig(result.config);
  parseMap(result.configuredAgents, (value, key) => {
    const agent = identified<ConfiguredAgent>(value, 2, "id", key, "Configured Agent");
    validateConfiguredAgent(agent);
    return agent;
  }, "configuredAgents");
  parseMap(result.projects, (value, key) => {
    const project = identified<Project>(value, 2, "id", key, "Project");
    validateProject(project);
    return project;
  }, "projects");
  try {
    assertProjectCatalog(Object.values(result.projects));
  } catch (error) {
    throw new StorageRecordError(error instanceof Error ? error.message : String(error));
  }
  parseMap(result.globalRoles, (value, key) => {
    const role = identified<GlobalRole>(value, 2, "name", key, "Global Role");
    validateGlobalRole(role);
    return role;
  }, "globalRoles");
  parseMap(result.globalRoleSessionSets, (value, key) => { const set = globalSessions(value); if (set.owner.roleName !== key) throw new StorageRecordError(`Global Role session set identity is inconsistent: ${key}`); return set; }, "globalRoleSessionSets");
  parseMap(result.tasks, (value, key) => parseStoredTask(value, key), "tasks");
  parseMap(result.mailboxes, (value, key) => {
    let mailbox: WorkMailbox;
    try { mailbox = validateWorkMailbox(value); }
    catch (error) { throw new StorageRecordError(error instanceof Error ? error.message : String(error)); }
    if (mailboxTargetKey(mailbox.target) !== key) {
      throw new StorageRecordError(`WorkMailbox identity is inconsistent: ${key}`);
    }
    return mailbox;
  }, "mailboxes");
  for (const [name, role] of Object.entries(result.globalRoles)) {
    const sessions = result.globalRoleSessionSets[name];
    if (sessions !== undefined) assertSessionsMatchRole(sessions, role);
  }
  for (const name of Object.keys(result.globalRoleSessionSets)) {
    if (result.globalRoles[name] === undefined) {
      throw new StorageRecordError(`Global Role session set has no Role: ${name}`);
    }
  }
  for (const aggregate of Object.values(result.tasks)) {
    if (aggregate.task.projectId !== undefined
      && result.projects[aggregate.task.projectId] === undefined) {
      throw new StorageRecordError(
        `Task Project not found: ${aggregate.task.id}/${aggregate.task.projectId}`
      );
    }
    for (const [name, role] of Object.entries(aggregate.roles)) {
      const sessions = aggregate.roleSessionSets[name];
      if (sessions !== undefined) assertSessionsMatchRole(sessions, role);
      const workspace = aggregate.roleWorkspaces[name];
      if (workspace !== undefined && workspace.path !== role.workspace) {
        throw new StorageRecordError(`Task Role workspace path is inconsistent: ${aggregate.task.id}/${name}`);
      }
    }
    for (const name of Object.keys(aggregate.roleSessionSets)) {
      if (aggregate.roles[name] === undefined) {
        throw new StorageRecordError(`Task Role session set has no Role: ${aggregate.task.id}/${name}`);
      }
    }
    for (const [name, workspace] of Object.entries(aggregate.roleWorkspaces)) {
      if (aggregate.roles[name] === undefined) {
        throw new StorageRecordError(`RoleWorkspace has no Task Role: ${aggregate.task.id}/${name}`);
      }
      if (aggregate.task.projectId !== workspace.projectId) {
        throw new StorageRecordError(`RoleWorkspace Project does not match Task: ${aggregate.task.id}/${name}`);
      }
    }
  }
  for (const mailbox of Object.values(result.mailboxes)) validateMailboxReferences(result, mailbox);
  assertGloballyUniqueTaskRecordIds(result, "inputRequests", "Input request");
  assertGloballyUniqueTaskRecordIds(result, "decisions", "Decision");
  assertGloballyUniqueTaskRecordIds(result, "milestones", "Milestone");
  assertGloballyUniqueTaskRecordIds(result, "events", "Task event");
  assertGloballyUniqueTaskRecordIds(result, "messages", "Message");
  return result;
}
function parseStoredTask(value: unknown, taskId: string): StoredTask {
  const aggregate = object(value, `Task aggregate ${taskId}`) as unknown as StoredTask;
  exact(aggregate as unknown as Record<string, unknown>, ["schemaVersion", "task", "brief", "roles", "roleWorkspaces", "roleSessionSets", "workItems", "agentRuns", "activeRuns", "messages", "inputRequests", "decisions", "milestones", "events", "leaderFailure", "operatorNotification"], `Task aggregate ${taskId}`);
  versioned(aggregate, 4, `Task aggregate ${taskId}`);
  validateTask(identified(aggregate.task, 1, "id", taskId, "Task"));
  if (aggregate.brief !== null) storedTaskBrief(aggregate.brief);
  parseMap(aggregate.roles, (record, key) => { const role = identified<TaskRole>(record, 2, "name", key, "Task Role"); if (role.taskId !== taskId) throw new StorageRecordError(`Task Role belongs to another Task: ${role.taskId}`); validateTaskRole(role); return role; }, "roles");
  parseMap(aggregate.roleWorkspaces, (record, key) => {
    const workspace = identified<RoleWorkspace>(record, 2, "roleName", key, "Managed worktree");
    if (workspace.taskId !== taskId) {
      throw new StorageRecordError(`RoleWorkspace belongs to another Task: ${workspace.taskId}`);
    }
    validateRoleWorkspace(workspace);
    return workspace;
  }, "roleWorkspaces");
  parseMap(aggregate.roleSessionSets, (record, key) => { const set = taskSessions(record); if (set.owner.taskId !== taskId || set.owner.roleName !== key) throw new StorageRecordError(`Task Role session set identity is inconsistent: ${taskId}/${key}`); return set; }, "roleSessionSets");
  parseMap(aggregate.workItems, (record, key) => {
    const item = identified<WorkItem>(record, 1, "id", key, "Work item");
    validateWorkItem(item);
    if (item.taskId !== taskId) {
      throw new StorageRecordError(`Work item belongs to another Task: ${item.taskId}`);
    }
    return item;
  }, "workItems");
  parseMap(aggregate.agentRuns, (record, key) => { const run = identified<AgentRun>(record, 1, "id", key, "Agent run"); if (run.taskId !== taskId) throw new StorageRecordError(`Agent run belongs to another Task: ${run.taskId}`); validateAgentRun(run); return run; }, "agentRuns");
  parseMap(aggregate.activeRuns, (record, key) => {
    const pointer = versioned<ActiveRunPointer>(record, 1, `Active run ${key}`);
    const run = typeof pointer.runId === "string" ? aggregate.agentRuns[pointer.runId] : undefined;
    if (run === undefined || run.status !== "active" || run.roleName !== key) {
      throw new StorageRecordError(`Active run pointer is invalid: ${taskId}/${key}`);
    }
    return pointer;
  }, "activeRuns");
  parseMap(aggregate.messages, (record, key) => {
    const message = identified<TaskMessage>(record, 1, "id", key, "Message");
    validateTaskMessage(message);
    return message;
  }, "messages");
  parseMap(aggregate.inputRequests, (record, key) => {
    const request = validateInputRequest(record);
    if (request.id !== key) {
      throw new StorageRecordError(`Input request identity is inconsistent: ${key}.`);
    }
    if (request.taskId !== taskId) {
      throw new StorageRecordError(`Input request belongs to another Task: ${request.taskId}`);
    }
    return request;
  }, "inputRequests");
  parseMap(aggregate.decisions, (record, key) => {
    const decision = storedDecision(record);
    if (decision.id !== key) throw new StorageRecordError(`Decision identity is inconsistent: ${key}.`);
    if (decision.taskId !== taskId) {
      throw new StorageRecordError(`Decision belongs to another Task: ${decision.taskId}`);
    }
    return decision;
  }, "decisions");
  parseMap(aggregate.milestones, (record, key) => {
    const milestone = storedMilestone(record);
    if (milestone.id !== key) throw new StorageRecordError(`Milestone identity is inconsistent: ${key}.`);
    if (milestone.taskId !== taskId) {
      throw new StorageRecordError(`Milestone belongs to another Task: ${milestone.taskId}`);
    }
    return milestone;
  }, "milestones");
  parseMap(aggregate.events, (record, key) => {
    const event = storedTaskEvent(record);
    if (event.id !== key) throw new StorageRecordError(`Task event identity is inconsistent: ${key}.`);
    return event;
  }, "events");
  for (const [key, label] of [["leaderFailure", "Leader failure"], ["operatorNotification", "Operator notification"]] as const) {
    const record = aggregate[key];
    if (record !== null) identified(record, 1, "taskId", taskId, label);
  }
  return aggregate;
}

function validateYuiConfig(config: YuiConfig): void {
  try {
    reconciliationIntervalMilliseconds(config.reconciliationIntervalSeconds);
    resolveTimeZone(config.timeZone);
  } catch (error) {
    throw new StorageRecordError(
      error instanceof Error ? error.message : "Yui reconciliation interval is invalid."
    );
  }
}

function globalSessions(value: unknown): GlobalRoleSessionSet {
  const set = versioned<GlobalRoleSessionSet>(value, 2, "Global Role session set");
  if (set.owner?.scope !== "global" || typeof set.owner.roleName !== "string") throw new StorageRecordError("Global Role session owner is invalid.");
  validateSessions(set.sessions);
  validateRoleSessionSet(set);
  return set;
}
function taskSessions(value: unknown): TaskRoleSessionSet {
  const set = versioned<TaskRoleSessionSet>(value, 2, "Task Role session set");
  if (set.owner?.scope !== "task" || typeof set.owner.taskId !== "string" || typeof set.owner.roleName !== "string") throw new StorageRecordError("Task Role session owner is invalid.");
  validateSessions(set.sessions);
  validateRoleSessionSet(set);
  return set;
}
function validateSessions(sessions: Record<string, RoleAgentSession>): void {
  parseMap(sessions, (record, key) => identified(record, 2, "agentId", key, "Role Agent session"), "sessions");
}
function assertSessionsMatchRole(
  sessions: GlobalRoleSessionSet | TaskRoleSessionSet,
  role: GlobalRole | TaskRole
): void {
  validateRoleSessionSet(sessions);
  if (sessions.owner.roleName !== role.name || sessions.activeAgentId !== role.activeAgentId) {
    throw new StorageRecordError(`Role session set does not match Role: ${role.name}`);
  }
  if ("taskId" in role && (sessions.owner.scope !== "task" || sessions.owner.taskId !== role.taskId)) {
    throw new StorageRecordError(`Task Role session owner is inconsistent: ${role.taskId}/${role.name}`);
  }
  if (!("taskId" in role) && sessions.owner.scope !== "global") {
    throw new StorageRecordError(`Global Role session owner is inconsistent: ${role.name}`);
  }
  for (const [agentId, session] of Object.entries(sessions.sessions)) {
    const binding = role.agentBindings[agentId];
    if (binding === undefined || binding.adapterId !== session.adapterId) {
      throw new StorageRecordError(`Role Agent session has no matching binding: ${role.name}/${agentId}`);
    }
  }
}

function storedTaskBrief(value: unknown): TaskBrief {
  const brief = versioned<TaskBrief>(value, 1, "Task Brief");
  exact(
    brief as unknown as Record<string, unknown>,
    ["schemaVersion", "objective", "boundaries", "currentFocus", "leaderSummary", "updatedAt", "updatedBy"],
    "Task Brief"
  );
  requireNormalizedText(brief.objective, "Task Brief objective");
  requireNormalizedText(brief.currentFocus, "Task Brief current focus");
  requireNormalizedText(brief.leaderSummary, "Task Brief leader summary");
  requireNormalizedText(brief.updatedBy, "Task Brief updatedBy");
  if (!Array.isArray(brief.boundaries)) {
    throw new StorageRecordError("Task Brief boundaries must be an array.");
  }
  const boundaries = brief.boundaries.map((boundary) => (
    requireNormalizedText(boundary, "Task Brief boundary")
  ));
  if (new Set(boundaries).size !== boundaries.length) {
    throw new StorageRecordError("Task Brief boundaries must be unique.");
  }
  requireTimestamp(brief.updatedAt, "Task Brief updatedAt");
  return brief;
}

function storedDecision(value: unknown): Decision {
  const decision = versioned<Decision>(value, 1, "Decision");
  const baseFields = [
    "schemaVersion", "id", "taskId", "title", "rationale", "status", "createdAt", "updatedAt"
  ];
  if (decision.status === "active") {
    exact(decision as unknown as Record<string, unknown>, baseFields, "Decision");
  } else if (decision.status === "superseded") {
    exact(
      decision as unknown as Record<string, unknown>,
      [...baseFields, "supersededReason", "supersededAt"],
      "Decision"
    );
    requireNormalizedText(decision.supersededReason, "Decision supersededReason");
    requireTimestamp(decision.supersededAt, "Decision supersededAt");
    if (decision.supersededAt !== decision.updatedAt) {
      throw new StorageRecordError("Decision supersededAt must match updatedAt.");
    }
  } else {
    throw new StorageRecordError(`Decision status is invalid: ${String(decision.status)}.`);
  }
  requireRecordIdentity(decision.id, "Decision id");
  requireRecordIdentity(decision.taskId, "Decision Task id");
  requireNormalizedText(decision.title, "Decision title");
  requireNormalizedText(decision.rationale, "Decision rationale");
  requireTimestamp(decision.createdAt, "Decision createdAt");
  requireTimestamp(decision.updatedAt, "Decision updatedAt");
  if (Date.parse(decision.updatedAt) < Date.parse(decision.createdAt)) {
    throw new StorageRecordError("Decision updatedAt cannot precede createdAt.");
  }
  return decision;
}

function storedMilestone(value: unknown): Milestone {
  const milestone = versioned<Milestone>(value, 1, "Milestone");
  exact(
    milestone as unknown as Record<string, unknown>,
    ["schemaVersion", "id", "taskId", "title", "summary", "createdBy", "createdAt"],
    "Milestone"
  );
  requireRecordIdentity(milestone.id, "Milestone id");
  requireRecordIdentity(milestone.taskId, "Milestone Task id");
  requireNormalizedText(milestone.title, "Milestone title");
  requireNormalizedText(milestone.summary, "Milestone summary");
  if (milestone.createdBy !== "leader") {
    throw new StorageRecordError("Milestone createdBy must be leader.");
  }
  requireTimestamp(milestone.createdAt, "Milestone createdAt");
  return milestone;
}

function storedTaskEvent(value: unknown): TaskEvent {
  const event = versioned<TaskEvent>(value, 1, "Task event");
  exact(
    event as unknown as Record<string, unknown>,
    ["schemaVersion", "id", "type", "payload", "createdAt"],
    "Task event"
  );
  requireRecordIdentity(event.id, "Task event id");
  requireNormalizedText(event.type, "Task event type");
  const payload = object(event.payload, "Task event payload");
  for (const [key, payloadValue] of Object.entries(payload)) {
    requireRecordIdentity(key, "Task event payload key");
    if (typeof payloadValue !== "string" || payloadValue.includes("\0")) {
      throw new StorageRecordError(`Task event payload value is invalid: ${key}.`);
    }
  }
  requireTimestamp(event.createdAt, "Task event createdAt");
  return event;
}

function isValidDecisionSupersession(existing: Decision, candidate: Decision): boolean {
  return existing.status === "active"
    && candidate.status === "superseded"
    && candidate.id === existing.id
    && candidate.taskId === existing.taskId
    && candidate.title === existing.title
    && candidate.rationale === existing.rationale
    && candidate.createdAt === existing.createdAt
    && Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt);
}

function isValidInputRequestTransition(existing: InputRequest, candidate: InputRequest): boolean {
  if (existing.status !== "open" || candidate.status === "open") return false;
  return candidate.id === existing.id
    && candidate.taskId === existing.taskId
    && isDeepStrictEqual(candidate.requester, existing.requester)
    && candidate.question === existing.question
    && isDeepStrictEqual(candidate.choices, existing.choices)
    && isDeepStrictEqual(candidate.blockedRefs, existing.blockedRefs)
    && isDeepStrictEqual(candidate.policy, existing.policy)
    && candidate.createdAt === existing.createdAt
    && Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt);
}

function requireTaskFromState(state: StorageState, taskId: string): StoredTask {
  const aggregate = state.tasks[taskId];
  if (aggregate === undefined) throw new StorageRecordError(`Task not found: ${taskId}`);
  return aggregate;
}

function taskRecordOwner(
  state: StorageState,
  key: "decisions" | "milestones" | "events" | "messages" | "inputRequests",
  id: string
): string | null {
  for (const [taskId, aggregate] of Object.entries(state.tasks)) {
    if (aggregate[key][id] !== undefined) return taskId;
  }
  return null;
}

function assertGloballyUniqueTaskRecordIds(
  state: StorageState,
  key: "decisions" | "milestones" | "events" | "messages" | "inputRequests",
  label: string
): void {
  const owners = new Map<string, string>();
  for (const [taskId, aggregate] of Object.entries(state.tasks)) {
    for (const id of Object.keys(aggregate[key])) {
      const owner = owners.get(id);
      if (owner !== undefined) {
        throw new StorageRecordError(`${label} id is duplicated across Tasks: ${id} (${owner}, ${taskId}).`);
      }
      owners.set(id, taskId);
    }
  }
}

function requireRecordIdentity(value: unknown, label: string): string {
  const normalized = requireNormalizedText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new StorageRecordError(`${label} is invalid.`);
  }
  return normalized;
}

function requireNormalizedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new StorageRecordError(`${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new StorageRecordError(`${label} is required.`);
  if (normalized !== value) throw new StorageRecordError(`${label} must be normalized.`);
  return normalized;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new StorageRecordError(`${label} is invalid.`);
  }
  return value;
}

function parseMap<T>(value: unknown, parse: (entry: unknown, key: string) => T, label: string): asserts value is Record<string, T> {
  const records = object(value, label);
  for (const [key, entry] of Object.entries(records)) parse(entry, key);
}
function versioned<T>(value: unknown, schemaVersion: number, label: string): T {
  assertJsonValue(value, label);
  const record = object(value, label);
  if (record.schemaVersion !== schemaVersion) throw new StorageRecordError(`${label} must use schemaVersion ${schemaVersion}.`);
  return clone(record) as T;
}
function identified<T>(value: unknown, schemaVersion: number, key: string, expected: string, label: string): T {
  const record = versioned<Record<string, unknown>>(value, schemaVersion, label);
  if (record[key] !== expected) throw new StorageRecordError(`${label} identity is inconsistent: ${expected}.`);
  return record as T;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StorageRecordError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new StorageRecordError(`${label} has unknown field: ${unknown}.`);
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new StorageRecordError(`${label} is missing field: ${missing}.`);
}
function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new StorageRecordError(`${label} contains a non-JSON value.`);
  if (seen.has(value)) throw new StorageRecordError(`${label} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) for (const entry of value) assertJsonValue(entry, label, seen);
  else for (const [key, entry] of Object.entries(value)) { if (entry === undefined) throw new StorageRecordError(`${label} contains undefined at ${key}.`); assertJsonValue(entry, label, seen); }
  seen.delete(value);
}
function clone<T>(value: T): T { assertJsonValue(value, "Stored value"); return JSON.parse(JSON.stringify(value)) as T; }
function optional<T>(value: T | undefined): T | null { return value === undefined ? null : clone(value); }
function values<T>(records: Record<string, T>, identity: keyof T | ((value: T) => string)): T[] {
  return Object.values(records).map(clone).sort((left, right) => numericCompare(typeof identity === "function" ? identity(left) : String(left[identity]), typeof identity === "function" ? identity(right) : String(right[identity])));
}
function numericCompare(left: string, right: string): number { return left.localeCompare(right, undefined, { numeric: true }); }
function pendingWakeupProjection(mailbox: WorkMailbox | null): PendingWakeup | null {
  if (mailbox === null || mailbox.target.kind !== "role" || mailbox.target.roleName !== "leader"
    || mailbox.pending === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    taskId: mailbox.target.taskId,
    reasons: [...mailbox.pending.reasons],
    requestCount: mailbox.pending.requestCount,
    firstRequestedAt: mailbox.pending.firstQueuedAt,
    lastRequestedAt: mailbox.pending.lastQueuedAt
  };
}
function validateMailboxReferences(state: StorageState, mailbox: WorkMailbox): void {
  if (
    mailbox.target.kind === "task"
    || mailbox.target.kind === "role"
    || mailbox.target.kind === "role-runtime"
  ) {
    const aggregate = state.tasks[mailbox.target.taskId];
    if (aggregate === undefined) {
      throw new StorageRecordError(`WorkMailbox target Task not found: ${mailbox.target.taskId}`);
    }
    if (mailbox.target.kind === "role" && aggregate.roles[mailbox.target.roleName] === undefined) {
      throw new StorageRecordError(
        `WorkMailbox target Role not found: ${mailbox.target.taskId}/${mailbox.target.roleName}`
      );
    }
  }
  const refs: MailboxEntityRef[] = [];
  if (mailbox.processing !== null) {
    refs.push(...mailbox.processing.batch.refs);
    if (mailbox.processing.executionRef !== undefined) refs.push(mailbox.processing.executionRef);
  }
  if (mailbox.pending !== null) refs.push(...mailbox.pending.refs);
  for (const ref of refs) {
    if (!mailboxReferenceExists(state, ref)) {
      throw new StorageRecordError(`WorkMailbox reference does not exist: ${ref.type}/${ref.id}`);
    }
  }
}
function mailboxReferenceExists(state: StorageState, ref: MailboxEntityRef): boolean {
  switch (ref.type) {
    case "task": return state.tasks[ref.id] !== undefined;
    case "run": return Object.values(state.tasks).some((task) => task.agentRuns[ref.id] !== undefined);
    case "work-item": return Object.values(state.tasks).some((task) => task.workItems[ref.id] !== undefined);
    case "input": return Object.values(state.tasks).some((task) => task.inputRequests[ref.id] !== undefined);
    case "message": return Object.values(state.tasks).some((task) => task.messages[ref.id] !== undefined);
    case "session":
      return [
        ...Object.values(state.globalRoleSessionSets),
        ...Object.values(state.tasks).flatMap((task) => Object.values(task.roleSessionSets))
      ].some((set) => Object.values(set.sessions).some((session) => session.nativeSessionId === ref.id));
  }
}
function allKeys<K extends "workItems" | "agentRuns" | "messages" | "inputRequests" | "decisions" | "milestones" | "events">(state: StorageState, key: K): string[] { return Object.values(state.tasks).flatMap((task) => Object.keys(task[key])); }
function findUnique(state: StorageState, key: "workItems", id: string, label: string): WorkItem | null;
function findUnique(state: StorageState, key: "agentRuns", id: string, label: string): AgentRun | null;
function findUnique(state: StorageState, key: "inputRequests", id: string, label: string): InputRequest | null;
function findUnique(state: StorageState, key: "workItems" | "agentRuns" | "inputRequests", id: string, label: string): WorkItem | AgentRun | InputRequest | null {
  const matches = Object.values(state.tasks).flatMap((task) => task[key][id] === undefined ? [] : [task[key][id]]);
  if (matches.length > 1) throw new StorageRecordError(`${label} id is ambiguous: ${id}`);
  return matches[0] === undefined ? null : clone(matches[0]);
}
function synchronousResult<T>(value: T): T { if (typeof value === "object" && value !== null && "then" in value) throw new StorageRecordError("FileTaskStore transactions must be synchronous."); return value; }

function acquireStorageLock(rootDir: string): () => void {
  ensureYuiHome(rootDir);
  const lock = join(rootDir, STORAGE_LOCK_DIRECTORY);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner"), `${process.pid}\n`, { mode: 0o600 });
      return () => { rmSync(lock, { recursive: true, force: true }); };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      reclaimDeadLock(lock);
      if (Date.now() >= deadline) throw new StorageConflictError(`Timed out waiting for storage lock: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}
function reclaimDeadLock(lock: string): void {
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < 1_000) return;
    const pid = Number.parseInt(readFileSync(join(lock, "owner"), "utf8"), 10);
    if (Number.isInteger(pid) && processIsAlive(pid)) return;
    rmSync(lock, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return;
  }
}
function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; } }
