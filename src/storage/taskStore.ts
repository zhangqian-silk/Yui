import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TaskComment } from "../comment/comment.js";
import type { Milestone } from "../milestone/milestone.js";
import type { Cycle } from "../cycle/cycle.js";
import { dataError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { AgentSession } from "../executor/agentExecutor.js";
import type { TaskInputDraft } from "../input/taskInput.js";
import type { GlobalRole, Role } from "../role/role.js";
import type { ChildRole } from "../role/childRole.js";
import type { AgentRun } from "../run/agentRun.js";
import type { CustomRunner } from "../runner/runner.js";
import type { PendingWakeup } from "../scheduler/pendingWakeup.js";
import type { TaskSchedule } from "../scheduler/taskSchedule.js";
import type { Task } from "../task/task.js";
import { emptyTaskTopics, type TaskTopics } from "../topic/topic.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { RoleWorktree } from "../worktree/worktree.js";
import { taskRecordCodec } from "./taskRecordCodec.js";

export type TaskStore = {
  getConfig(): TaskmuxConfig;
  saveConfig(config: TaskmuxConfig): void;
  nextTaskId(): string;
  saveTask(task: Task): void;
  deleteTask(id: string): boolean;
  restoreTask(id: string): boolean;
  listTasks(): Task[];
  getTask(id: string): Task | null;
  getTaskTopics(taskId: string): TaskTopics;
  saveTaskTopics(taskId: string, topics: TaskTopics): void;
  getTaskInputDraft(taskId: string): TaskInputDraft | null;
  saveTaskInputDraft(taskId: string, draft: TaskInputDraft): void;
  clearTaskInputDraft(taskId: string): void;
  getPendingWakeup(taskId: string): PendingWakeup | null;
  savePendingWakeup(wakeup: PendingWakeup): void;
  listPendingWakeups(): PendingWakeup[];
  clearPendingWakeup(taskId: string): void;
  getTaskSchedule(taskId: string): TaskSchedule | null;
  saveTaskSchedule(taskId: string, schedule: TaskSchedule): void;
  nextCycleId(taskId: string): string;
  getCycle(taskId: string, cycleId: string): Cycle | null;
  saveCycle(taskId: string, cycle: Cycle): void;
  nextWorkItemId(taskId: string): string;
  getWorkItem(taskId: string, workItemId: string): WorkItem | null;
  saveWorkItem(taskId: string, workItem: WorkItem): void;
  getAgentSession(taskId: string, roleName: string): AgentSession | null;
  saveAgentSession(session: AgentSession): void;
  nextAgentRunId(taskId: string): string;
  getAgentRun(taskId: string, runId: string): AgentRun | null;
  saveAgentRun(run: AgentRun): void;
  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null;
  saveActiveAgentRun(run: AgentRun): void;
  clearActiveAgentRun(taskId: string, roleName: string): void;
  saveTaskBrief(taskId: string, markdown: string): void;
  readTaskBrief(taskId: string): string | null;
  appendTaskTimeline(taskId: string, markdown: string): void;
  nextMilestoneId(taskId: string): string;
  getMilestone(taskId: string, milestoneId: string): Milestone | null;
  saveMilestone(taskId: string, milestone: Milestone): void;
  saveRoleWorktree(taskId: string, worktree: RoleWorktree): void;
  saveRole(taskId: string, role: Role): void;
  renameRole(taskId: string, oldName: string, role: Role): void;
  listRoles(taskId: string): Role[];
  getRole(taskId: string, name: string): Role | null;
  saveChildRole(taskId: string, role: ChildRole): void;
  getChildRole(taskId: string, name: string): ChildRole | null;
  listChildRoles(taskId: string): ChildRole[];
  removeTaskRole(taskId: string, name: string): { removed: boolean; childCount: number };
  saveGlobalRole(role: GlobalRole): void;
  listGlobalRoles(): GlobalRole[];
  getGlobalRole(name: string): GlobalRole | null;
  removeGlobalRole(name: string): boolean;
  nextCommentId(taskId: string): string;
  saveComment(taskId: string, comment: TaskComment): void;
  listComments(taskId: string): TaskComment[];
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
  listEvents(taskId: string): TaskEvent[];
  saveTranscript(taskId: string, roleName: string, transcript: string): void;
  readTranscript(taskId: string, roleName: string): string | null;
  saveCustomRunner(runner: CustomRunner): void;
  listCustomRunners(): CustomRunner[];
  getCustomRunner(id: string): CustomRunner | null;
  removeCustomRunner(id: string): boolean;
};

export type TaskmuxConfig = {
  schemaVersion: 1;
  defaultAgent?: string;
  defaultWorkspace?: string;
  currentTaskId?: string;
  lastTaskId?: string;
};

export function resolveTaskmuxHome(env: NodeJS.ProcessEnv): string {
  return env.TASKMUX_HOME === undefined || env.TASKMUX_HOME.length === 0
    ? join(homedir(), ".taskmux")
    : resolve(env.TASKMUX_HOME);
}

export function ensureTaskmuxHome(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true });
}

export class FileTaskStore implements TaskStore {
  constructor(private readonly rootDir: string) {}

  getConfig(): TaskmuxConfig {
    const raw = this.readOptionalText(this.configFile());

    if (raw === null) {
      return { schemaVersion: 1 };
    }

    return parseTaskmuxConfig(raw);
  }

  saveConfig(config: TaskmuxConfig): void {
    mkdirSync(this.rootDir, { recursive: true });
    writeFileSync(this.configFile(), `${JSON.stringify(config, null, 2)}\n`);
  }

  nextTaskId(): string {
    const maxId = this.listTasks().reduce((max, task) => {
      const match = /^task-(\d+)$/.exec(task.id);
      if (match === null) {
        return max;
      }

      return Math.max(max, Number.parseInt(match[1], 10));
    }, 0);

    return `task-${maxId + 1}`;
  }

  saveTask(task: Task): void {
    const taskDir = this.taskDir(task.id);
    const encoded = taskRecordCodec.encodeTask(task);

    mkdirSync(taskDir, { recursive: true });
    writeFileSync(this.taskFile(task.id), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    writeFileSync(this.taskInfoFile(task.id), `${JSON.stringify(encoded.info, null, 2)}\n`);
  }

  deleteTask(id: string): boolean {
    if (this.readOptionalText(this.taskFile(id)) === null) {
      return false;
    }

    const trashDir = this.trashedTaskDir(id);
    mkdirSync(this.trashedTasksDir(), { recursive: true });
    rmSync(trashDir, { recursive: true, force: true });
    renameSync(this.taskDir(id), trashDir);
    return true;
  }

  restoreTask(id: string): boolean {
    if (this.readOptionalText(this.trashedTaskFile(id)) === null) {
      return false;
    }

    if (this.readOptionalText(this.taskFile(id)) !== null) {
      throw dataError(`Cannot restore task because active task already exists: ${id}`);
    }

    mkdirSync(this.tasksDir(), { recursive: true });
    renameSync(this.trashedTaskDir(id), this.taskDir(id));
    return true;
  }

  listTasks(): Task[] {
    return this.directoryNames(this.tasksDir())
      .map((name) => this.getTask(name))
      .filter((task): task is Task => task !== null)
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  }

  getTask(id: string): Task | null {
    const runtimeRaw = this.readOptionalText(this.taskFile(id));

    if (runtimeRaw === null) {
      return null;
    }

    const infoRaw = this.readOptionalText(this.taskInfoFile(id));

    return taskRecordCodec.decodeTask(id, runtimeRaw, infoRaw);
  }

  getTaskTopics(taskId: string): TaskTopics {
    const raw = this.readOptionalText(this.topicsFile(taskId));

    return raw === null ? emptyTaskTopics() : parseTaskTopics(taskId, raw);
  }

  saveTaskTopics(taskId: string, topics: TaskTopics): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    writeFileSync(this.topicsFile(taskId), `${JSON.stringify(topics, null, 2)}\n`);
  }

  getTaskInputDraft(taskId: string): TaskInputDraft | null {
    const raw = this.readOptionalText(this.taskInputDraftFile(taskId));

    return raw === null ? null : parseTaskInputDraft(taskId, raw);
  }

  saveTaskInputDraft(taskId: string, draft: TaskInputDraft): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    writeFileSync(this.taskInputDraftFile(taskId), `${JSON.stringify(draft, null, 2)}\n`);
  }

  clearTaskInputDraft(taskId: string): void {
    rmSync(this.taskInputDraftFile(taskId), { force: true });
  }

  getPendingWakeup(taskId: string): PendingWakeup | null {
    const raw = this.readOptionalText(this.pendingWakeupFile(taskId));

    return raw === null ? null : parsePendingWakeup(taskId, raw);
  }

  savePendingWakeup(wakeup: PendingWakeup): void {
    mkdirSync(this.pendingWakeupsDir(), { recursive: true });
    writeFileSync(this.pendingWakeupFile(wakeup.taskId), `${JSON.stringify(wakeup, null, 2)}\n`);
  }

  listPendingWakeups(): PendingWakeup[] {
    try {
      return readdirSync(this.pendingWakeupsDir(), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -5))
        .map((taskId) => this.getPendingWakeup(taskId))
        .filter((wakeup): wakeup is PendingWakeup => wakeup !== null)
        .sort((left, right) => left.taskId.localeCompare(right.taskId));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  clearPendingWakeup(taskId: string): void {
    rmSync(this.pendingWakeupFile(taskId), { force: true });
  }

  getTaskSchedule(taskId: string): TaskSchedule | null {
    const raw = this.readOptionalText(this.taskScheduleFile(taskId));
    return raw === null ? null : parseTaskSchedule(taskId, raw);
  }

  saveTaskSchedule(taskId: string, schedule: TaskSchedule): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    writeFileSync(this.taskScheduleFile(taskId), `${JSON.stringify(schedule, null, 2)}\n`);
  }

  nextCycleId(taskId: string): string {
    return this.nextRecordId("cycle", (id) => this.getCycle(taskId, id));
  }

  getCycle(taskId: string, cycleId: string): Cycle | null {
    const raw = this.readOptionalText(this.cycleFile(taskId, cycleId));

    return raw === null ? null : parseCycle(taskId, cycleId, raw);
  }

  saveCycle(taskId: string, cycle: Cycle): void {
    mkdirSync(this.cyclesDir(taskId), { recursive: true });
    writeFileSync(this.cycleFile(taskId, cycle.id), `${JSON.stringify(cycle, null, 2)}\n`);
  }

  nextWorkItemId(taskId: string): string {
    return this.nextRecordId("work-item", (id) => this.getWorkItem(taskId, id));
  }

  getWorkItem(taskId: string, workItemId: string): WorkItem | null {
    const raw = this.readOptionalText(this.workItemFile(taskId, workItemId));

    return raw === null ? null : parseWorkItem(taskId, workItemId, raw);
  }

  saveWorkItem(taskId: string, workItem: WorkItem): void {
    mkdirSync(this.workItemsDir(taskId), { recursive: true });
    writeFileSync(this.workItemFile(taskId, workItem.id), `${JSON.stringify(workItem, null, 2)}\n`);
  }

  getAgentSession(taskId: string, roleName: string): AgentSession | null {
    const raw = this.readOptionalText(this.agentSessionFile(taskId, roleName));

    return raw === null ? null : parseAgentSession(taskId, roleName, raw);
  }

  saveAgentSession(session: AgentSession): void {
    mkdirSync(this.agentSessionsDir(session.taskId), { recursive: true });
    writeFileSync(
      this.agentSessionFile(session.taskId, session.roleName),
      `${JSON.stringify(session, null, 2)}\n`
    );
  }

  nextAgentRunId(taskId: string): string {
    return this.nextRecordId("agent-run", (id) => this.getAgentRun(taskId, id));
  }

  getAgentRun(taskId: string, runId: string): AgentRun | null {
    const raw = this.readOptionalText(this.agentRunFile(taskId, runId));
    return raw === null ? null : parseAgentRun(taskId, runId, raw);
  }

  saveAgentRun(run: AgentRun): void {
    mkdirSync(this.agentRunsDir(run.taskId), { recursive: true });
    writeFileSync(this.agentRunFile(run.taskId, run.id), `${JSON.stringify(run, null, 2)}\n`);
  }

  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null {
    const raw = this.readOptionalText(this.activeAgentRunFile(taskId, roleName));
    if (raw === null) {
      return null;
    }

    const value = parseJson(raw, `Invalid active agent run record: ${taskId}/${roleName}`);
    if (!isRecord(value) || typeof value.id !== "string") {
      throw dataError(`Invalid active agent run record: ${taskId}/${roleName}`);
    }
    return parseAgentRun(taskId, value.id, raw);
  }

  saveActiveAgentRun(run: AgentRun): void {
    mkdirSync(this.activeAgentRunsDir(run.taskId), { recursive: true });
    writeFileSync(this.activeAgentRunFile(run.taskId, run.roleName), `${JSON.stringify(run, null, 2)}\n`);
  }

  clearActiveAgentRun(taskId: string, roleName: string): void {
    rmSync(this.activeAgentRunFile(taskId, roleName), { force: true });
  }

  saveTaskBrief(taskId: string, markdown: string): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    writeFileSync(this.taskBriefFile(taskId), markdown);
  }

  readTaskBrief(taskId: string): string | null {
    return this.readOptionalText(this.taskBriefFile(taskId));
  }

  appendTaskTimeline(taskId: string, markdown: string): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    appendFileSync(this.taskTimelineFile(taskId), markdown);
  }

  nextMilestoneId(taskId: string): string {
    return this.nextRecordId("milestone", (id) => this.getMilestone(taskId, id));
  }

  getMilestone(taskId: string, milestoneId: string): Milestone | null {
    const raw = this.readOptionalText(this.milestoneFile(taskId, milestoneId));
    return raw === null ? null : parseMilestone(taskId, milestoneId, raw);
  }

  saveMilestone(taskId: string, milestone: Milestone): void {
    mkdirSync(this.milestonesDir(taskId), { recursive: true });
    writeFileSync(this.milestoneFile(taskId, milestone.id), `${JSON.stringify(milestone, null, 2)}\n`);
  }

  saveRoleWorktree(taskId: string, worktree: RoleWorktree): void {
    mkdirSync(this.roleDir(taskId, worktree.roleName), { recursive: true });
    writeFileSync(
      this.roleWorktreeFile(taskId, worktree.roleName),
      `${JSON.stringify(worktree, null, 2)}\n`
    );
  }

  saveRole(taskId: string, role: Role): void {
    const storageName = this.resolveRoleStorageName(taskId, role.name) ?? role.name;
    const roleDir = this.roleDir(taskId, storageName);
    const encoded = taskRecordCodec.encodeRole(role);

    mkdirSync(roleDir, { recursive: true });
    writeFileSync(this.roleFile(taskId, storageName), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    writeFileSync(this.roleInfoFile(taskId, storageName), `${JSON.stringify(encoded.info, null, 2)}\n`);
  }

  renameRole(taskId: string, oldName: string, role: Role): void {
    const storageName = this.resolveRoleStorageName(taskId, oldName);

    if (storageName === null) {
      return;
    }

    const encoded = taskRecordCodec.encodeRole(role);
    writeFileSync(this.roleFile(taskId, storageName), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    writeFileSync(this.roleInfoFile(taskId, storageName), `${JSON.stringify(encoded.info, null, 2)}\n`);
  }

  listRoles(taskId: string): Role[] {
    return this.directoryNames(this.rolesDir(taskId))
      .map((name) => this.readRoleByStorageName(taskId, name))
      .filter((role): role is Role => role !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getRole(taskId: string, name: string): Role | null {
    try {
      return this.findRoleByInfoName(taskId, name) ?? this.getRoleByStorageName(taskId, name);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  saveChildRole(taskId: string, role: ChildRole): void {
    const roleDir = this.roleDir(taskId, role.name);
    mkdirSync(roleDir, { recursive: true });
    rmSync(this.roleFile(taskId, role.name), { force: true });
    writeFileSync(this.roleInfoFile(taskId, role.name), `${JSON.stringify(role, null, 2)}\n`);
  }

  getChildRole(taskId: string, name: string): ChildRole | null {
    const raw = this.readOptionalText(this.roleInfoFile(taskId, name));

    if (raw === null) {
      return null;
    }

    const value = parseJson(raw, `Invalid child role record: ${name}`);
    if (!isRecord(value) || value.architecture !== "child") {
      return null;
    }

    return parseChildRole(name, raw);
  }

  listChildRoles(taskId: string): ChildRole[] {
    return this.directoryNames(this.rolesDir(taskId))
      .map((name) => this.getChildRole(taskId, name))
      .filter((role): role is ChildRole => role !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  removeTaskRole(taskId: string, name: string): { removed: boolean; childCount: number } {
    const roleDir = this.roleDir(taskId, name);
    const exists = this.readOptionalText(this.roleFile(taskId, name)) !== null ||
      this.readOptionalText(this.roleInfoFile(taskId, name)) !== null;

    if (!exists) {
      return { removed: false, childCount: 0 };
    }

    const childNames = this.directoryNames(this.rolesDir(taskId)).filter((candidate) =>
      this.getChildRole(taskId, candidate)?.parentRole === name
    );
    rmSync(roleDir, { recursive: true, force: true });
    childNames.forEach((childName) => rmSync(this.roleDir(taskId, childName), { recursive: true, force: true }));
    return { removed: true, childCount: childNames.length };
  }

  saveGlobalRole(role: GlobalRole): void {
    const roleDir = this.globalRoleDir(role.name);
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(this.globalRoleFile(role.name), `${JSON.stringify(role, null, 2)}\n`);
  }

  listGlobalRoles(): GlobalRole[] {
    return this.directoryNames(this.globalRolesDir())
      .map((name) => this.getGlobalRole(name))
      .filter((role): role is GlobalRole => role !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getGlobalRole(name: string): GlobalRole | null {
    try {
      return parseGlobalRole(name, readFileSync(this.globalRoleFile(name), "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  removeGlobalRole(name: string): boolean {
    try {
      rmSync(this.globalRoleDir(name), { recursive: true });
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  nextCommentId(taskId: string): string {
    return `comment-${this.listComments(taskId).length + 1}`;
  }

  saveComment(taskId: string, comment: TaskComment): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    appendFileSync(this.commentsFile(taskId), `${JSON.stringify(comment)}\n`);
  }

  listComments(taskId: string): TaskComment[] {
    try {
      return readFileSync(this.commentsFile(taskId), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line, index) => parseComment(`${taskId}:${index + 1}`, line));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  nextEventId(taskId: string): string {
    return `event-${this.listEvents(taskId).length + 1}`;
  }

  saveEvent(taskId: string, event: TaskEvent): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    appendFileSync(this.eventsFile(taskId), `${JSON.stringify(event)}\n`);
  }

  listEvents(taskId: string): TaskEvent[] {
    try {
      return readFileSync(this.eventsFile(taskId), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line, index) => parseEvent(`${taskId}:${index + 1}`, line));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  saveTranscript(taskId: string, roleName: string, transcript: string): void {
    const storageName = this.resolveRoleStorageName(taskId, roleName) ?? roleName;
    const roleDir = this.roleDir(taskId, storageName);
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(this.transcriptFile(taskId, storageName), transcript);
  }

  readTranscript(taskId: string, roleName: string): string | null {
    const storageName = this.resolveRoleStorageName(taskId, roleName);

    if (storageName === null) {
      return null;
    }

    return this.readOptionalText(this.transcriptFile(taskId, storageName));
  }

  saveCustomRunner(runner: CustomRunner): void {
    const runnerDir = this.runnerDir(runner.id);
    mkdirSync(runnerDir, { recursive: true });
    writeFileSync(this.runnerFile(runner.id), `${JSON.stringify(runner, null, 2)}\n`);
  }

  listCustomRunners(): CustomRunner[] {
    return this.directoryNames(this.runnersDir())
      .map((name) => this.getCustomRunner(name))
      .filter((runner): runner is CustomRunner => runner !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getCustomRunner(id: string): CustomRunner | null {
    try {
      return parseCustomRunner(id, readFileSync(this.runnerFile(id), "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  removeCustomRunner(id: string): boolean {
    try {
      rmSync(this.runnerDir(id), { recursive: true });
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  private tasksDir(): string {
    return join(this.rootDir, "tasks");
  }

  private configFile(): string {
    return join(this.rootDir, "config.json");
  }

  private taskDir(id: string): string {
    return join(this.tasksDir(), id);
  }

  private taskFile(id: string): string {
    return join(this.taskDir(id), "task.json");
  }

  private taskInfoFile(id: string): string {
    return join(this.taskDir(id), "info.json");
  }

  private topicsFile(taskId: string): string {
    return join(this.taskDir(taskId), "topics.json");
  }

  private taskInputDraftFile(taskId: string): string {
    return join(this.taskDir(taskId), "input-draft.json");
  }

  private taskScheduleFile(taskId: string): string {
    return join(this.taskDir(taskId), "schedule.json");
  }

  private taskBriefFile(taskId: string): string {
    return join(this.taskDir(taskId), "brief.md");
  }

  private taskTimelineFile(taskId: string): string {
    return join(this.taskDir(taskId), "timeline.md");
  }

  private milestonesDir(taskId: string): string {
    return join(this.taskDir(taskId), "milestones");
  }

  private milestoneFile(taskId: string, milestoneId: string): string {
    return join(this.milestonesDir(taskId), `${milestoneId}.json`);
  }

  private runtimeDir(): string {
    return join(this.rootDir, "runtime");
  }

  private pendingWakeupsDir(): string {
    return join(this.runtimeDir(), "pending-wakeups");
  }

  private pendingWakeupFile(taskId: string): string {
    return join(this.pendingWakeupsDir(), `${taskId}.json`);
  }

  private cyclesDir(taskId: string): string {
    return join(this.taskDir(taskId), "cycles");
  }

  private cycleFile(taskId: string, cycleId: string): string {
    return join(this.cyclesDir(taskId), `${cycleId}.json`);
  }

  private workItemsDir(taskId: string): string {
    return join(this.taskDir(taskId), "work-items");
  }

  private workItemFile(taskId: string, workItemId: string): string {
    return join(this.workItemsDir(taskId), `${workItemId}.json`);
  }

  private roleSessionsDir(): string {
    return join(this.runtimeDir(), "role-sessions");
  }

  private agentSessionsDir(taskId: string): string {
    return join(this.roleSessionsDir(), taskId);
  }

  private agentSessionFile(taskId: string, roleName: string): string {
    return join(this.agentSessionsDir(taskId), `${roleName}.json`);
  }

  private agentRunsDir(taskId: string): string {
    return join(this.taskDir(taskId), "agent-runs");
  }

  private agentRunFile(taskId: string, runId: string): string {
    return join(this.agentRunsDir(taskId), `${runId}.json`);
  }

  private activeRunsDir(): string {
    return join(this.runtimeDir(), "active-runs");
  }

  private activeAgentRunsDir(taskId: string): string {
    return join(this.activeRunsDir(), taskId);
  }

  private activeAgentRunFile(taskId: string, roleName: string): string {
    return join(this.activeAgentRunsDir(taskId), `${roleName}.json`);
  }

  private trashDir(): string {
    return join(this.rootDir, "trash");
  }

  private trashedTasksDir(): string {
    return join(this.trashDir(), "tasks");
  }

  private trashedTaskDir(id: string): string {
    return join(this.trashedTasksDir(), id);
  }

  private trashedTaskFile(id: string): string {
    return join(this.trashedTaskDir(id), "task.json");
  }

  private commentsFile(taskId: string): string {
    return join(this.taskDir(taskId), "comments.jsonl");
  }

  private eventsFile(taskId: string): string {
    return join(this.taskDir(taskId), "events.jsonl");
  }

  private rolesDir(taskId: string): string {
    return join(this.taskDir(taskId), "roles");
  }

  private globalRolesDir(): string {
    return join(this.rootDir, "roles");
  }

  private globalRoleDir(name: string): string {
    return join(this.globalRolesDir(), name);
  }

  private globalRoleFile(name: string): string {
    return join(this.globalRoleDir(name), "role.json");
  }

  private roleDir(taskId: string, name: string): string {
    return join(this.rolesDir(taskId), name);
  }

  private roleFile(taskId: string, name: string): string {
    return join(this.roleDir(taskId, name), "role.json");
  }

  private roleInfoFile(taskId: string, name: string): string {
    return join(this.roleDir(taskId, name), "info.json");
  }

  private roleWorktreeFile(taskId: string, name: string): string {
    return join(this.roleDir(taskId, name), "worktree.json");
  }

  private transcriptFile(taskId: string, name: string): string {
    return join(this.roleDir(taskId, name), "transcript.log");
  }

  private runnersDir(): string {
    return join(this.rootDir, "runners");
  }

  private runnerDir(id: string): string {
    return join(this.runnersDir(), id);
  }

  private runnerFile(id: string): string {
    return join(this.runnerDir(id), "runner.json");
  }

  private getRoleByStorageName(taskId: string, storageName: string): Role | null {
    const role = this.readRoleByStorageName(taskId, storageName);

    return role?.name === storageName ? role : null;
  }

  private readRoleByStorageName(taskId: string, storageName: string): Role | null {
    const runtimeRaw = this.readOptionalText(this.roleFile(taskId, storageName));

    if (runtimeRaw === null) {
      return null;
    }

    const infoRaw = this.readOptionalText(this.roleInfoFile(taskId, storageName));

    return taskRecordCodec.decodeRole(storageName, runtimeRaw, infoRaw);
  }

  private findRoleByInfoName(taskId: string, name: string): Role | null {
    for (const storageName of this.directoryNames(this.rolesDir(taskId))) {
      const role = this.readRoleByStorageName(taskId, storageName);

      if (role !== null && role.name === name) {
        return role;
      }
    }

    return null;
  }

  private resolveRoleStorageName(taskId: string, name: string): string | null {
    if (this.readOptionalText(this.roleFile(taskId, name)) !== null) {
      return name;
    }

    for (const storageName of this.directoryNames(this.rolesDir(taskId))) {
      const role = this.readRoleByStorageName(taskId, storageName);

      if (role !== null && role.name === name) {
        return storageName;
      }
    }

    return null;
  }

  private directoryNames(path: string): string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private readOptionalText(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  private nextRecordId(prefix: string, getRecord: (id: string) => unknown | null): string {
    let number = 1;

    while (getRecord(`${prefix}-${number}`) !== null) {
      number += 1;
    }

    return `${prefix}-${number}`;
  }

}

function parseCustomRunner(id: string, raw: string): CustomRunner {
  const value = parseJson(raw, `Invalid runner record: ${id}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.command !== "string" ||
    !isStringArray(value.args) ||
    !isStringRecord(value.env) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid runner record: ${id}`);
  }

  return value as CustomRunner;
}

function parseGlobalRole(name: string, raw: string): GlobalRole {
  const value = parseJson(raw, `Invalid global role record: ${name}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.name !== "string" ||
    typeof value.agent !== "string" ||
    typeof value.command !== "string" ||
    !isStringArray(value.args) ||
    !isStringRecord(value.env) ||
    typeof value.workspace !== "string" ||
    (value.description !== undefined && typeof value.description !== "string") ||
    (value.responsibilities !== undefined && !isStringArray(value.responsibilities)) ||
    (value.constraints !== undefined && !isStringArray(value.constraints)) ||
    (value.expectedOutput !== undefined && typeof value.expectedOutput !== "string") ||
    (value.systemPrompt !== undefined && typeof value.systemPrompt !== "string") ||
    (value.skills !== undefined && !isStringArray(value.skills)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid global role record: ${name}`);
  }

  return value as GlobalRole;
}

function parseChildRole(name: string, raw: string): ChildRole {
  const value = parseJson(raw, `Invalid child role record: ${name}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.name !== name ||
    value.architecture !== "child" ||
    typeof value.parentRole !== "string" ||
    typeof value.description !== "string" ||
    !isStringArray(value.responsibilities) ||
    !isStringArray(value.constraints) ||
    typeof value.expectedOutput !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid child role record: ${name}`);
  }

  return value as ChildRole;
}

function parseTaskmuxConfig(raw: string): TaskmuxConfig {
  const value = parseJson(raw, "Invalid config record");

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isOptionalString(value.defaultAgent) ||
    !isOptionalString(value.defaultWorkspace) ||
    !isOptionalString(value.currentTaskId) ||
    !isOptionalString(value.lastTaskId)
  ) {
    throw dataError("Invalid config record");
  }

  return value as TaskmuxConfig;
}

function parseTaskTopics(taskId: string, raw: string): TaskTopics {
  const value = parseJson(raw, `Invalid topic record: ${taskId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.customTopics) ||
    !value.customTopics.every((topic) =>
      isRecord(topic) &&
      typeof topic.id === "string" &&
      typeof topic.name === "string" &&
      typeof topic.description === "string" &&
      (topic.createdBy === "user" || topic.createdBy === "operator" || topic.createdBy === "leader") &&
      typeof topic.createdAt === "string"
    )
  ) {
    throw dataError(`Invalid topic record: ${taskId}`);
  }

  return value as TaskTopics;
}

function parseTaskInputDraft(taskId: string, raw: string): TaskInputDraft {
  const value = parseJson(raw, `Invalid input draft record: ${taskId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    typeof value.body !== "string" ||
    value.author !== "operator" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid input draft record: ${taskId}`);
  }

  return value as TaskInputDraft;
}

function parsePendingWakeup(taskId: string, raw: string): PendingWakeup {
  const value = parseJson(raw, `Invalid pending wakeup record: ${taskId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    !isStringArray(value.reasons) ||
    typeof value.requestCount !== "number" ||
    typeof value.firstRequestedAt !== "string" ||
    typeof value.lastRequestedAt !== "string"
  ) {
    throw dataError(`Invalid pending wakeup record: ${taskId}`);
  }

  return value as PendingWakeup;
}

function parseTaskSchedule(taskId: string, raw: string): TaskSchedule {
  const value = parseJson(raw, `Invalid task schedule record: ${taskId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.inactivityMinutes !== "number" ||
    typeof value.cooldownMinutes !== "number" ||
    (value.reviewAt !== undefined && typeof value.reviewAt !== "string") ||
    (value.recurring !== undefined && (
      !isRecord(value.recurring) ||
      typeof value.recurring.everyMinutes !== "number" ||
      typeof value.recurring.nextAt !== "string"
    )) ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid task schedule record: ${taskId}`);
  }

  return value as TaskSchedule;
}

function parseMilestone(taskId: string, milestoneId: string, raw: string): Milestone {
  const value = parseJson(raw, `Invalid milestone record: ${taskId}/${milestoneId}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== milestoneId ||
    value.taskId !== taskId ||
    typeof value.title !== "string" ||
    typeof value.summary !== "string" ||
    !isStringArray(value.topics) ||
    value.createdBy !== "leader" ||
    typeof value.createdAt !== "string"
  ) {
    throw dataError(`Invalid milestone record: ${taskId}/${milestoneId}`);
  }
  return value as Milestone;
}

function parseCycle(taskId: string, cycleId: string, raw: string): Cycle {
  const value = parseJson(raw, `Invalid cycle record: ${taskId}/${cycleId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== cycleId ||
    value.taskId !== taskId ||
    !["schedule", "review-time", "operator-input", "role-result", "inactivity", "explicit-wake"].includes(String(value.cause)) ||
    typeof value.summary !== "string" ||
    !["active", "ended"].includes(String(value.status)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid cycle record: ${taskId}/${cycleId}`);
  }

  return value as Cycle;
}

function parseWorkItem(taskId: string, workItemId: string, raw: string): WorkItem {
  const value = parseJson(raw, `Invalid work item record: ${taskId}/${workItemId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== workItemId ||
    value.taskId !== taskId ||
    (value.cycleId !== undefined && typeof value.cycleId !== "string") ||
    typeof value.title !== "string" ||
    typeof value.assignee !== "string" ||
    !isStringArray(value.topics) ||
    !["pending", "running", "completed", "failed", "cancelled", "superseded"].includes(String(value.status)) ||
    (value.outcome !== undefined && typeof value.outcome !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.endedAt !== undefined && typeof value.endedAt !== "string")
  ) {
    throw dataError(`Invalid work item record: ${taskId}/${workItemId}`);
  }

  return value as WorkItem;
}

function parseAgentSession(taskId: string, roleName: string, raw: string): AgentSession {
  const value = parseJson(raw, `Invalid agent session record: ${taskId}/${roleName}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    value.roleName !== roleName ||
    typeof value.agent !== "string" ||
    typeof value.nativeSessionId !== "string" ||
    !["fixed", "leader-controlled"].includes(String(value.policy)) ||
    !["unknown", "ready", "running", "stopped", "broken"].includes(String(value.status)) ||
    !isStringArray(value.previousSessionIds) ||
    (value.replacementReason !== undefined && typeof value.replacementReason !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid agent session record: ${taskId}/${roleName}`);
  }

  return value as AgentSession;
}

function parseAgentRun(taskId: string, runId: string, raw: string): AgentRun {
  const value = parseJson(raw, `Invalid agent run record: ${taskId}/${runId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== runId ||
    value.taskId !== taskId ||
    typeof value.roleName !== "string" ||
    !["new", "resume"].includes(String(value.mode)) ||
    typeof value.input !== "string" ||
    !["active", "yielded", "failed", "expired"].includes(String(value.status)) ||
    (value.summary !== undefined && typeof value.summary !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.endedAt !== undefined && typeof value.endedAt !== "string")
  ) {
    throw dataError(`Invalid agent run record: ${taskId}/${runId}`);
  }

  return value as AgentRun;
}

function parseComment(id: string, raw: string): TaskComment {
  const value = parseJson(raw, `Invalid comment record: ${id}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.body !== "string" ||
    (value.author !== undefined && !["user", "operator", "leader"].includes(String(value.author))) ||
    typeof value.createdAt !== "string"
  ) {
    throw dataError(`Invalid comment record: ${id}`);
  }

  return value as TaskComment;
}

function parseEvent(id: string, raw: string): TaskEvent {
  const value = parseJson(raw, `Invalid event record: ${id}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    !isStringRecord(value.payload) ||
    typeof value.createdAt !== "string"
  ) {
    throw dataError(`Invalid event record: ${id}`);
  }

  return value as TaskEvent;
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw dataError(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
