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
import type { TaskComment } from "../comment/comment.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  validateRoleSessionSet,
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import type { AgentRun } from "../run/agentRun.js";
import {
  validateRepository,
  type Repository
} from "../repository/repository.js";
import {
  validateGlobalRole,
  validateTaskRole,
  type GlobalRole,
  type TaskRole
} from "../role/role.js";
import type { LeaderFailure } from "../scheduler/leaderFailure.js";
import type { OperatorNotification } from "../scheduler/operatorNotification.js";
import type { PendingWakeup } from "../scheduler/pendingWakeup.js";
import type { Task } from "../task/task.js";
import type { WorkItem } from "../workItem/workItem.js";
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
export type TaskmuxConfig = Readonly<{
  schemaVersion: 1;
  defaultAgent?: string;
  defaultWorkspace?: string;
  currentTaskId?: string;
  lastTaskId?: string;
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
  schemaVersion: 1;
  task: Task;
  roles: Record<string, TaskRole>;
  roleSessionSets: Record<string, TaskRoleSessionSet>;
  workItems: Record<string, WorkItem>;
  agentRuns: Record<string, AgentRun>;
  activeRuns: Record<string, ActiveRunPointer>;
  comments: Record<string, TaskComment>;
  events: Record<string, TaskEvent>;
  pendingWakeup: PendingWakeup | null;
  leaderFailure: LeaderFailure | null;
  operatorNotification: OperatorNotification | null;
};

type StorageState = {
  schemaVersion: 1;
  revision: number;
  config: TaskmuxConfig;
  configuredAgents: Record<string, ConfiguredAgent>;
  repositories: Record<string, Repository>;
  globalRoles: Record<string, GlobalRole>;
  globalRoleSessionSets: Record<string, GlobalRoleSessionSet>;
  tasks: Record<string, StoredTask>;
};

export type TaskStore = {
  rootDirectory(): string;
  transaction<T>(execute: (store: TaskStore) => T): T;
  getConfig(): TaskmuxConfig;
  saveConfig(config: TaskmuxConfig): void;
  saveConfiguredAgent(agent: ConfiguredAgent): void;
  createConfiguredAgentIfAbsent(agent: ConfiguredAgent): ConfiguredAgent | null;
  updateConfiguredAgent(id: string, patch: ConfiguredAgentPatch, now: Date): ConfiguredAgentUpdateResult | null;
  listConfiguredAgents(): ConfiguredAgent[];
  getConfiguredAgent(id: string): ConfiguredAgent | null;
  removeConfiguredAgent(id: string): boolean;
  nextRepositoryId(): string;
  saveRepository(repository: Repository): void;
  createRepositoryIfAbsent(repository: Repository): Repository | null;
  listRepositories(): Repository[];
  getRepository(id: string): Repository | null;
  removeRepository(id: string): boolean;
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
  saveRole(taskId: string, role: TaskRole): void;
  listRoles(taskId: string): TaskRole[];
  getRole(taskId: string, name: string): TaskRole | null;
  saveTaskRoleWithSessionSet(role: TaskRole, sessions: TaskRoleSessionSet): void;
  removeTaskRole(taskId: string, name: string): boolean;
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
  nextCommentId(taskId: string): string;
  saveComment(taskId: string, comment: TaskComment): void;
  listComments(taskId: string): TaskComment[];
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
  listEvents(taskId: string): TaskEvent[];
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

  getConfig(): TaskmuxConfig { return clone(this.#state().config); }
  saveConfig(config: TaskmuxConfig): void {
    const stored = versioned<TaskmuxConfig>(config, 1, "TaskMux config");
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

  nextRepositoryId(): string {
    return this.#nextGlobalId("repository", (state) => Object.keys(state.repositories));
  }
  saveRepository(repository: Repository): void {
    const stored = identified<Repository>(
      repository,
      1,
      "id",
      repository.id,
      "Repository"
    );
    validateRepository(stored);
    this.#mutate((state) => { state.repositories[stored.id] = stored; });
  }
  createRepositoryIfAbsent(repository: Repository): Repository | null {
    return this.transaction((store) => {
      if (store.getRepository(repository.id) !== null) return null;
      if (store.listRepositories().some((entry) => (
        entry.name === repository.name || entry.path === repository.path
      ))) return null;
      store.saveRepository(repository);
      return clone(repository);
    });
  }
  listRepositories(): Repository[] { return values(this.#state().repositories, "id"); }
  getRepository(id: string): Repository | null { return optional(this.#state().repositories[id]); }
  removeRepository(id: string): boolean {
    return this.transaction((store) => {
      if (store.listTasks().some((task) => task.repositoryId === id)) {
        throw new StorageRecordError(`Repository is still used by a Task: ${id}`);
      }
      return this.#remove((state) => state.repositories, id);
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
    const stored = identified<Task>(task, 1, "id", task.id, "Task");
    this.#mutate((state) => {
      if (stored.repositoryId !== undefined && state.repositories[stored.repositoryId] === undefined) {
        throw new StorageRecordError(`Task Repository not found: ${stored.repositoryId}`);
      }
      const aggregate = state.tasks[stored.id] ?? emptyStoredTask(stored);
      aggregate.task = stored;
      state.tasks[stored.id] = aggregate;
    });
  }
  listTasks(): Task[] { return values(this.#state().tasks, (aggregate) => aggregate.task.id).map((entry) => clone(entry.task)); }
  getTask(id: string): Task | null { return optional(this.#state().tasks[id]?.task); }
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
      const removed = this.#remove(() => aggregate.roles, name);
      this.#mutate(() => { delete aggregate.roleSessionSets[name]; delete aggregate.activeRuns[name]; });
      return removed;
    });
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
      store.saveAgentRun(run);
      this.#mutate((state) => {
        state.tasks[run.taskId].activeRuns[run.roleName] = { schemaVersion: 1, runId: run.id };
      });
    });
  }
  clearActiveAgentRun(taskId: string, roleName: string): void {
    this.#mutate((state) => { const task = state.tasks[taskId]; if (task !== undefined) delete task.activeRuns[roleName]; });
  }

  nextCommentId(_taskId: string): string { return this.#nextGlobalId("comment", (state) => allKeys(state, "comments")); }
  saveComment(taskId: string, comment: TaskComment): void { this.#saveTaskRecord(taskId, "comments", comment, "Comment"); }
  listComments(taskId: string): TaskComment[] { return values(this.#requireTask(taskId).comments, "id"); }
  nextEventId(_taskId: string): string { return this.#nextGlobalId("event", (state) => allKeys(state, "events")); }
  saveEvent(taskId: string, event: TaskEvent): void { this.#saveTaskRecord(taskId, "events", event, "Task event"); }
  listEvents(taskId: string): TaskEvent[] { return values(this.#requireTask(taskId).events, "id"); }

  getPendingWakeup(taskId: string): PendingWakeup | null { return optional(this.#state().tasks[taskId]?.pendingWakeup ?? undefined); }
  listPendingWakeups(): PendingWakeup[] {
    return Object.values(this.#state().tasks).flatMap((task) => task.pendingWakeup === null ? [] : [clone(task.pendingWakeup)]).sort((a, b) => numericCompare(a.taskId, b.taskId));
  }
  savePendingWakeup(value: PendingWakeup): void { this.#saveSingleton(value.taskId, "pendingWakeup", value, "Pending wakeup"); }
  clearPendingWakeup(taskId: string): void { this.#clearSingleton(taskId, "pendingWakeup"); }
  getLeaderFailure(taskId: string): LeaderFailure | null { return optional(this.#state().tasks[taskId]?.leaderFailure ?? undefined); }
  saveLeaderFailure(value: LeaderFailure): void { this.#saveSingleton(value.taskId, "leaderFailure", value, "Leader failure"); }
  clearLeaderFailure(taskId: string): void { this.#clearSingleton(taskId, "leaderFailure"); }
  getOperatorNotification(taskId: string): OperatorNotification | null { return optional(this.#state().tasks[taskId]?.operatorNotification ?? undefined); }
  saveOperatorNotification(value: OperatorNotification): void { this.#saveSingleton(value.taskId, "operatorNotification", value, "Operator notification"); }
  clearOperatorNotification(taskId: string): void { this.#clearSingleton(taskId, "operatorNotification"); }

  #saveSingleton<K extends "pendingWakeup" | "leaderFailure" | "operatorNotification">(
    taskId: string, key: K, value: StoredTask[K], label: string
  ): void {
    const stored = identified<StoredTask[K]>(value, 1, "taskId", taskId, label);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { state.tasks[taskId][key] = stored; });
  }
  #clearSingleton(key: string, field: "pendingWakeup" | "leaderFailure" | "operatorNotification"): void {
    this.#mutate((state) => { if (state.tasks[key] !== undefined) state.tasks[key][field] = null; });
  }
  #saveTaskRecord<K extends "comments" | "events">(
    taskId: string, key: K, value: StoredTask[K][string], label: string
  ): void {
    const record = versioned<{ schemaVersion: 1; id: string }>(value, 1, label);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { (state.tasks[taskId][key] as Record<string, typeof value>)[record.id] = clone(value); });
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

export function resolveTaskmuxHome(env: NodeJS.ProcessEnv): string {
  return env.TASKMUX_HOME === undefined || env.TASKMUX_HOME.length === 0
    ? join(homedir(), ".taskmux")
    : resolve(env.TASKMUX_HOME);
}
export function ensureTaskmuxHome(rootDir: string): void { mkdirSync(rootDir, { recursive: true, mode: 0o700 }); }

function emptyState(): StorageState {
  return { schemaVersion: 1, revision: 0, config: { schemaVersion: 1 }, configuredAgents: {}, repositories: {}, globalRoles: {}, globalRoleSessionSets: {}, tasks: {} };
}
function emptyStoredTask(task: Task): StoredTask {
  return { schemaVersion: 1, task, roles: {}, roleSessionSets: {}, workItems: {}, agentRuns: {}, activeRuns: {}, comments: {}, events: {}, pendingWakeup: null, leaderFailure: null, operatorNotification: null };
}

function parseState(raw: string): StorageState {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch (error) { throw new StorageRecordError(`Invalid ${STORAGE_STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`); }
  const state = object(parsed, "Storage state");
  exact(state, ["schemaVersion", "revision", "config", "configuredAgents", "repositories", "globalRoles", "globalRoleSessionSets", "tasks"], "Storage state");
  if (state.schemaVersion !== 1 || !Number.isInteger(state.revision) || (state.revision as number) < 0) throw new StorageRecordError("Storage state schemaVersion/revision is invalid.");
  const result = clone(state) as unknown as StorageState;
  versioned(result.config, 1, "TaskMux config");
  parseMap(result.configuredAgents, (value, key) => {
    const agent = identified<ConfiguredAgent>(value, 2, "id", key, "Configured Agent");
    validateConfiguredAgent(agent);
    return agent;
  }, "configuredAgents");
  parseMap(result.repositories, (value, key) => {
    const repository = identified<Repository>(value, 1, "id", key, "Repository");
    validateRepository(repository);
    return repository;
  }, "repositories");
  parseMap(result.globalRoles, (value, key) => {
    const role = identified<GlobalRole>(value, 2, "name", key, "Global Role");
    validateGlobalRole(role);
    return role;
  }, "globalRoles");
  parseMap(result.globalRoleSessionSets, (value, key) => { const set = globalSessions(value); if (set.owner.roleName !== key) throw new StorageRecordError(`Global Role session set identity is inconsistent: ${key}`); return set; }, "globalRoleSessionSets");
  parseMap(result.tasks, (value, key) => parseStoredTask(value, key), "tasks");
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
    if (aggregate.task.repositoryId !== undefined
      && result.repositories[aggregate.task.repositoryId] === undefined) {
      throw new StorageRecordError(
        `Task Repository not found: ${aggregate.task.id}/${aggregate.task.repositoryId}`
      );
    }
    for (const [name, role] of Object.entries(aggregate.roles)) {
      const sessions = aggregate.roleSessionSets[name];
      if (sessions !== undefined) assertSessionsMatchRole(sessions, role);
    }
    for (const name of Object.keys(aggregate.roleSessionSets)) {
      if (aggregate.roles[name] === undefined) {
        throw new StorageRecordError(`Task Role session set has no Role: ${aggregate.task.id}/${name}`);
      }
    }
  }
  return result;
}
function parseStoredTask(value: unknown, taskId: string): StoredTask {
  const aggregate = object(value, `Task aggregate ${taskId}`) as unknown as StoredTask;
  exact(aggregate as unknown as Record<string, unknown>, ["schemaVersion", "task", "roles", "roleSessionSets", "workItems", "agentRuns", "activeRuns", "comments", "events", "pendingWakeup", "leaderFailure", "operatorNotification"], `Task aggregate ${taskId}`);
  versioned(aggregate, 1, `Task aggregate ${taskId}`);
  identified(aggregate.task, 1, "id", taskId, "Task");
  parseMap(aggregate.roles, (record, key) => { const role = identified<TaskRole>(record, 2, "name", key, "Task Role"); if (role.taskId !== taskId) throw new StorageRecordError(`Task Role belongs to another Task: ${role.taskId}`); validateTaskRole(role); return role; }, "roles");
  parseMap(aggregate.roleSessionSets, (record, key) => { const set = taskSessions(record); if (set.owner.taskId !== taskId || set.owner.roleName !== key) throw new StorageRecordError(`Task Role session set identity is inconsistent: ${taskId}/${key}`); return set; }, "roleSessionSets");
  parseMap(aggregate.workItems, (record, key) => { const item = identified<WorkItem>(record, 1, "id", key, "Work item"); if (item.taskId !== taskId) throw new StorageRecordError(`Work item belongs to another Task: ${item.taskId}`); return item; }, "workItems");
  parseMap(aggregate.agentRuns, (record, key) => { const run = identified<AgentRun>(record, 1, "id", key, "Agent run"); if (run.taskId !== taskId) throw new StorageRecordError(`Agent run belongs to another Task: ${run.taskId}`); return run; }, "agentRuns");
  parseMap(aggregate.activeRuns, (record, key) => { const pointer = versioned<ActiveRunPointer>(record, 1, `Active run ${key}`); if (typeof pointer.runId !== "string" || aggregate.agentRuns[pointer.runId] === undefined) throw new StorageRecordError(`Active run pointer is invalid: ${taskId}/${key}`); return pointer; }, "activeRuns");
  parseMap(aggregate.comments, (record, key) => identified(record, 1, "id", key, "Comment"), "comments");
  parseMap(aggregate.events, (record, key) => identified(record, 1, "id", key, "Task event"), "events");
  for (const [key, label] of [["pendingWakeup", "Pending wakeup"], ["leaderFailure", "Leader failure"], ["operatorNotification", "Operator notification"]] as const) {
    const record = aggregate[key];
    if (record !== null) identified(record, 1, "taskId", taskId, label);
  }
  return aggregate;
}

function globalSessions(value: unknown): GlobalRoleSessionSet {
  const set = versioned<GlobalRoleSessionSet>(value, 1, "Global Role session set");
  if (set.owner?.scope !== "global" || typeof set.owner.roleName !== "string") throw new StorageRecordError("Global Role session owner is invalid.");
  validateSessions(set.sessions);
  validateRoleSessionSet(set);
  return set;
}
function taskSessions(value: unknown): TaskRoleSessionSet {
  const set = versioned<TaskRoleSessionSet>(value, 1, "Task Role session set");
  if (set.owner?.scope !== "task" || typeof set.owner.taskId !== "string" || typeof set.owner.roleName !== "string") throw new StorageRecordError("Task Role session owner is invalid.");
  validateSessions(set.sessions);
  validateRoleSessionSet(set);
  return set;
}
function validateSessions(sessions: Record<string, RoleAgentSession>): void {
  parseMap(sessions, (record, key) => identified(record, 1, "agentId", key, "Role Agent session"), "sessions");
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
function allKeys<K extends "workItems" | "agentRuns" | "comments" | "events">(state: StorageState, key: K): string[] { return Object.values(state.tasks).flatMap((task) => Object.keys(task[key])); }
function findUnique(state: StorageState, key: "workItems", id: string, label: string): WorkItem | null;
function findUnique(state: StorageState, key: "agentRuns", id: string, label: string): AgentRun | null;
function findUnique(state: StorageState, key: "workItems" | "agentRuns", id: string, label: string): WorkItem | AgentRun | null {
  const matches = Object.values(state.tasks).flatMap((task) => task[key][id] === undefined ? [] : [task[key][id]]);
  if (matches.length > 1) throw new StorageRecordError(`${label} id is ambiguous: ${id}`);
  return matches[0] === undefined ? null : clone(matches[0]);
}
function synchronousResult<T>(value: T): T { if (typeof value === "object" && value !== null && "then" in value) throw new StorageRecordError("FileTaskStore transactions must be synchronous."); return value; }

function acquireStorageLock(rootDir: string): () => void {
  ensureTaskmuxHome(rootDir);
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
