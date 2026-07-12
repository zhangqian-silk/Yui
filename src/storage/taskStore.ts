import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { TaskComment } from "../comment/comment.js";
import type { Milestone } from "../milestone/milestone.js";
import type { Decision } from "../decision/decision.js";
import type { Cycle } from "../cycle/cycle.js";
import { dataError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { AgentSession } from "../executor/agentExecutor.js";
import type { TaskInputDraft } from "../input/taskInput.js";
import type { InputRequest, InputResolution } from "../input/inputRequest.js";
import { isInputRequestRecord, isInputResolutionRecord } from "../input/inputRecordCodec.js";
import type { GlobalRole, Role } from "../role/role.js";
import type { ChildRole } from "../role/childRole.js";
import type { AgentRun } from "../run/agentRun.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import type { PendingWakeup } from "../scheduler/pendingWakeup.js";
import type { LeaderFailure } from "../scheduler/leaderFailure.js";
import type { OperatorNotification } from "../scheduler/operatorNotification.js";
import type { TaskSchedule } from "../scheduler/taskSchedule.js";
import type { Task } from "../task/task.js";
import { emptyTaskTopics, type TaskTopics } from "../topic/topic.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { RoleWorktree } from "../worktree/worktree.js";
import { taskRecordCodec } from "./taskRecordCodec.js";
import { writeRecoverableSnapshot } from "./recoveryJournal.js";

const INPUT_POINTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type TaskStore = {
  getConfig(): TaskmuxConfig;
  saveConfig(config: TaskmuxConfig): void;
  nextTaskId(): string;
  saveTask(task: Task): void;
  deleteTask(id: string): boolean;
  restoreTask(id: string): boolean;
  listTrashedTaskIds(): string[];
  listTasks(): Task[];
  getTask(id: string): Task | null;
  getTaskTopics(taskId: string): TaskTopics;
  saveTaskTopics(taskId: string, topics: TaskTopics): void;
  getTaskInputDraft(taskId: string): TaskInputDraft | null;
  saveTaskInputDraft(taskId: string, draft: TaskInputDraft): void;
  clearTaskInputDraft(taskId: string): void;
  getInputRequest(taskId: string, requestId: string): InputRequest | null;
  listInputRequests(taskId: string): InputRequest[];
  saveInputRequest(request: InputRequest): void;
  getInputResolution(taskId: string, resolutionId: string): InputResolution | null;
  listInputResolutions(taskId: string): InputResolution[];
  saveInputResolution(resolution: InputResolution): void;
  getPendingWakeup(taskId: string): PendingWakeup | null;
  savePendingWakeup(wakeup: PendingWakeup): void;
  listPendingWakeups(): PendingWakeup[];
  clearPendingWakeup(taskId: string): void;
  getLeaderFailure(taskId: string): LeaderFailure | null;
  saveLeaderFailure(failure: LeaderFailure): void;
  clearLeaderFailure(taskId: string): void;
  getOperatorNotification(taskId: string): OperatorNotification | null;
  saveOperatorNotification(notification: OperatorNotification): void;
  clearOperatorNotification(taskId: string): void;
  getTaskSchedule(taskId: string): TaskSchedule | null;
  saveTaskSchedule(taskId: string, schedule: TaskSchedule): void;
  nextCycleId(taskId: string): string;
  getCycle(taskId: string, cycleId: string): Cycle | null;
  listCycles(taskId: string): Cycle[];
  saveCycle(taskId: string, cycle: Cycle): void;
  nextWorkItemId(taskId: string): string;
  getWorkItem(taskId: string, workItemId: string): WorkItem | null;
  listWorkItems(taskId: string): WorkItem[];
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
  appendTaskTopicSummary(taskId: string, markdown: string): void;
  readTaskTopicSummaries(taskId: string): string | null;
  appendTaskTimeline(taskId: string, markdown: string): void;
  nextMilestoneId(taskId: string): string;
  getMilestone(taskId: string, milestoneId: string): Milestone | null;
  listMilestones(taskId: string): Milestone[];
  saveMilestone(taskId: string, milestone: Milestone): void;
  nextDecisionId(taskId: string): string;
  getDecision(taskId: string, decisionId: string): Decision | null;
  listDecisions(taskId: string): Decision[];
  saveDecision(taskId: string, decision: Decision): void;
  saveRoleWorktree(taskId: string, worktree: RoleWorktree): void;
  getRoleWorktree(taskId: string, roleName: string): RoleWorktree | null;
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
  saveConfiguredAgent(agent: ConfiguredAgent): void;
  listConfiguredAgents(): ConfiguredAgent[];
  getConfiguredAgent(id: string): ConfiguredAgent | null;
  removeConfiguredAgent(id: string): boolean;
};

export type TaskmuxConfig = {
  schemaVersion: 1;
  defaultAgent?: string;
  defaultWorkspace?: string;
  currentTaskId?: string;
  lastTaskId?: string;
  completionInstallations?: Partial<Record<CompletionShell, CompletionInstallation>>;
};

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = typeof COMPLETION_SHELLS[number];
export type CompletionInstallation = {
  scriptPath: string;
  activationPath: string;
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
    this.writeSnapshot(this.configFile(), `${JSON.stringify(config, null, 2)}\n`);
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
    this.writeSnapshot(this.taskFile(task.id), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    this.writeSnapshot(this.taskInfoFile(task.id), `${JSON.stringify(encoded.info, null, 2)}\n`);
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

  listTrashedTaskIds(): string[] {
    return this.directoryNames(this.trashedTasksDir())
      .filter((id) => this.getTask(id) === null)
      .filter((id) => {
        const runtimeRaw = this.readOptionalText(this.trashedTaskFile(id));
        if (runtimeRaw === null) {
          return false;
        }
        const infoRaw = this.readOptionalText(join(this.trashedTaskDir(id), "info.json"));
        taskRecordCodec.decodeTask(id, runtimeRaw, infoRaw);
        return true;
      })
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
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
    this.writeSnapshot(this.topicsFile(taskId), `${JSON.stringify(topics, null, 2)}\n`);
  }

  getTaskInputDraft(taskId: string): TaskInputDraft | null {
    const raw = this.readOptionalText(this.taskInputDraftFile(taskId));

    return raw === null ? null : parseTaskInputDraft(taskId, raw);
  }

  saveTaskInputDraft(taskId: string, draft: TaskInputDraft): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    this.writeSnapshot(this.taskInputDraftFile(taskId), `${JSON.stringify(draft, null, 2)}\n`);
  }

  clearTaskInputDraft(taskId: string): void {
    rmSync(this.taskInputDraftFile(taskId), { force: true });
  }

  getInputRequest(taskId: string, requestId: string): InputRequest | null {
    assertInputPointerId(taskId, "task");
    assertInputPointerId(requestId, "input request");
    const raw = this.readOptionalText(this.inputRequestFile(taskId, requestId));
    return raw === null ? null : parseInputRequest(taskId, requestId, raw);
  }

  listInputRequests(taskId: string): InputRequest[] {
    assertInputPointerId(taskId, "task");
    return this.jsonRecordIds(this.inputRequestsDir(taskId))
      .map((id) => this.getInputRequest(taskId, id))
      .filter((request): request is InputRequest => request !== null);
  }

  saveInputRequest(request: InputRequest): void {
    const pointers = inputRecordPointers(request);
    if (
      pointers === null ||
      !isInputRequestRecord(request, pointers.taskId, pointers.id)
    ) {
      throw dataError("Invalid input request record");
    }
    mkdirSync(this.inputRequestsDir(request.taskId), { recursive: true });
    this.writeSnapshot(this.inputRequestFile(request.taskId, request.id), `${JSON.stringify(request, null, 2)}\n`);
  }

  getInputResolution(taskId: string, resolutionId: string): InputResolution | null {
    assertInputPointerId(taskId, "task");
    assertInputPointerId(resolutionId, "input resolution");
    const raw = this.readOptionalText(this.inputResolutionFile(taskId, resolutionId));
    return raw === null ? null : parseInputResolution(taskId, resolutionId, raw);
  }

  listInputResolutions(taskId: string): InputResolution[] {
    assertInputPointerId(taskId, "task");
    return this.jsonRecordIds(this.inputResolutionsDir(taskId))
      .map((id) => this.getInputResolution(taskId, id))
      .filter((resolution): resolution is InputResolution => resolution !== null);
  }

  saveInputResolution(resolution: InputResolution): void {
    const pointers = inputRecordPointers(resolution);
    if (
      pointers === null ||
      !isInputResolutionRecord(resolution, pointers.taskId, pointers.id)
    ) {
      throw dataError("Invalid input resolution record");
    }
    mkdirSync(this.inputResolutionsDir(resolution.taskId), { recursive: true });
    this.writeSnapshot(
      this.inputResolutionFile(resolution.taskId, resolution.id),
      `${JSON.stringify(resolution, null, 2)}\n`
    );
  }

  getPendingWakeup(taskId: string): PendingWakeup | null {
    const raw = this.readOptionalText(this.pendingWakeupFile(taskId));

    return raw === null ? null : parsePendingWakeup(taskId, raw);
  }

  savePendingWakeup(wakeup: PendingWakeup): void {
    mkdirSync(this.pendingWakeupsDir(), { recursive: true });
    this.writeSnapshot(this.pendingWakeupFile(wakeup.taskId), `${JSON.stringify(wakeup, null, 2)}\n`);
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

  getLeaderFailure(taskId: string): LeaderFailure | null {
    const raw = this.readOptionalText(this.leaderFailureFile(taskId));
    return raw === null ? null : parseLeaderFailure(taskId, raw);
  }

  saveLeaderFailure(failure: LeaderFailure): void {
    mkdirSync(this.leaderFailuresDir(), { recursive: true });
    this.writeSnapshot(this.leaderFailureFile(failure.taskId), `${JSON.stringify(failure, null, 2)}\n`);
  }

  clearLeaderFailure(taskId: string): void {
    rmSync(this.leaderFailureFile(taskId), { force: true });
  }

  getOperatorNotification(taskId: string): OperatorNotification | null {
    const raw = this.readOptionalText(this.operatorNotificationFile(taskId));
    return raw === null ? null : parseOperatorNotification(taskId, raw);
  }

  saveOperatorNotification(notification: OperatorNotification): void {
    mkdirSync(this.operatorNotificationsDir(), { recursive: true });
    this.writeSnapshot(
      this.operatorNotificationFile(notification.taskId),
      `${JSON.stringify(notification, null, 2)}\n`
    );
  }

  clearOperatorNotification(taskId: string): void {
    rmSync(this.operatorNotificationFile(taskId), { force: true });
  }

  getTaskSchedule(taskId: string): TaskSchedule | null {
    const raw = this.readOptionalText(this.taskScheduleFile(taskId));
    return raw === null ? null : parseTaskSchedule(taskId, raw);
  }

  saveTaskSchedule(taskId: string, schedule: TaskSchedule): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    this.writeSnapshot(this.taskScheduleFile(taskId), `${JSON.stringify(schedule, null, 2)}\n`);
  }

  nextCycleId(taskId: string): string {
    return this.nextRecordId("cycle", (id) => this.getCycle(taskId, id));
  }

  getCycle(taskId: string, cycleId: string): Cycle | null {
    const raw = this.readOptionalText(this.cycleFile(taskId, cycleId));

    return raw === null ? null : parseCycle(taskId, cycleId, raw);
  }

  listCycles(taskId: string): Cycle[] {
    return this.jsonRecordIds(this.cyclesDir(taskId))
      .map((id) => this.getCycle(taskId, id))
      .filter((cycle): cycle is Cycle => cycle !== null);
  }

  saveCycle(taskId: string, cycle: Cycle): void {
    mkdirSync(this.cyclesDir(taskId), { recursive: true });
    this.writeSnapshot(this.cycleFile(taskId, cycle.id), `${JSON.stringify(cycle, null, 2)}\n`);
  }

  nextWorkItemId(taskId: string): string {
    return this.nextRecordId("work-item", (id) => this.getWorkItem(taskId, id));
  }

  getWorkItem(taskId: string, workItemId: string): WorkItem | null {
    const raw = this.readOptionalText(this.workItemFile(taskId, workItemId));

    return raw === null ? null : parseWorkItem(taskId, workItemId, raw);
  }

  listWorkItems(taskId: string): WorkItem[] {
    return this.jsonRecordIds(this.workItemsDir(taskId))
      .map((id) => this.getWorkItem(taskId, id))
      .filter((item): item is WorkItem => item !== null);
  }

  saveWorkItem(taskId: string, workItem: WorkItem): void {
    mkdirSync(this.workItemsDir(taskId), { recursive: true });
    this.writeSnapshot(this.workItemFile(taskId, workItem.id), `${JSON.stringify(workItem, null, 2)}\n`);
  }

  getAgentSession(taskId: string, roleName: string): AgentSession | null {
    const raw = this.readOptionalText(this.agentSessionFile(taskId, roleName));

    return raw === null ? null : parseAgentSession(taskId, roleName, raw);
  }

  saveAgentSession(session: AgentSession): void {
    mkdirSync(this.agentSessionsDir(session.taskId), { recursive: true });
    this.writeSnapshot(
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
    this.writeSnapshot(this.agentRunFile(run.taskId, run.id), `${JSON.stringify(run, null, 2)}\n`);
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
    this.writeSnapshot(this.activeAgentRunFile(run.taskId, run.roleName), `${JSON.stringify(run, null, 2)}\n`);
  }

  clearActiveAgentRun(taskId: string, roleName: string): void {
    rmSync(this.activeAgentRunFile(taskId, roleName), { force: true });
  }

  saveTaskBrief(taskId: string, markdown: string): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    this.writeSnapshot(this.taskBriefFile(taskId), markdown);
  }

  readTaskBrief(taskId: string): string | null {
    return this.readOptionalText(this.taskBriefFile(taskId));
  }

  appendTaskTopicSummary(taskId: string, markdown: string): void {
    const existing = this.readOptionalText(this.taskTopicSummariesFile(taskId)) ?? "";
    this.writeSnapshot(this.taskTopicSummariesFile(taskId), `${existing}${markdown}`);
  }

  readTaskTopicSummaries(taskId: string): string | null {
    return this.readOptionalText(this.taskTopicSummariesFile(taskId));
  }

  appendTaskTimeline(taskId: string, markdown: string): void {
    const existing = this.readOptionalText(this.taskTimelineFile(taskId)) ?? "";
    this.writeSnapshot(this.taskTimelineFile(taskId), `${existing}${markdown}`);
  }

  nextMilestoneId(taskId: string): string {
    return this.nextRecordId("milestone", (id) => this.getMilestone(taskId, id));
  }

  getMilestone(taskId: string, milestoneId: string): Milestone | null {
    const raw = this.readOptionalText(this.milestoneFile(taskId, milestoneId));
    return raw === null ? null : parseMilestone(taskId, milestoneId, raw);
  }

  listMilestones(taskId: string): Milestone[] {
    return this.jsonRecordIds(this.milestonesDir(taskId))
      .map((id) => this.getMilestone(taskId, id))
      .filter((milestone): milestone is Milestone => milestone !== null);
  }

  saveMilestone(taskId: string, milestone: Milestone): void {
    mkdirSync(this.milestonesDir(taskId), { recursive: true });
    this.writeSnapshot(this.milestoneFile(taskId, milestone.id), `${JSON.stringify(milestone, null, 2)}\n`);
  }

  nextDecisionId(taskId: string): string {
    return this.nextRecordId("decision", (id) => this.getDecision(taskId, id));
  }

  getDecision(taskId: string, decisionId: string): Decision | null {
    const raw = this.readOptionalText(this.decisionFile(taskId, decisionId));
    return raw === null ? null : parseDecision(taskId, decisionId, raw);
  }

  listDecisions(taskId: string): Decision[] {
    return this.jsonRecordIds(this.decisionsDir(taskId))
      .map((id) => this.getDecision(taskId, id))
      .filter((decision): decision is Decision => decision !== null);
  }

  saveDecision(taskId: string, decision: Decision): void {
    mkdirSync(this.decisionsDir(taskId), { recursive: true });
    this.writeSnapshot(this.decisionFile(taskId, decision.id), `${JSON.stringify(decision, null, 2)}\n`);
  }

  saveRoleWorktree(taskId: string, worktree: RoleWorktree): void {
    mkdirSync(this.roleDir(taskId, worktree.roleName), { recursive: true });
    this.writeSnapshot(
      this.roleWorktreeFile(taskId, worktree.roleName),
      `${JSON.stringify(worktree, null, 2)}\n`
    );
  }

  getRoleWorktree(taskId: string, roleName: string): RoleWorktree | null {
    const raw = this.readOptionalText(this.roleWorktreeFile(taskId, roleName));
    return raw === null ? null : parseRoleWorktree(taskId, roleName, raw);
  }

  saveRole(taskId: string, role: Role): void {
    const storageName = this.resolveRoleStorageName(taskId, role.name) ?? role.name;
    const roleDir = this.roleDir(taskId, storageName);
    const encoded = taskRecordCodec.encodeRole(role);

    mkdirSync(roleDir, { recursive: true });
    this.writeSnapshot(this.roleFile(taskId, storageName), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    this.writeSnapshot(this.roleInfoFile(taskId, storageName), `${JSON.stringify(encoded.info, null, 2)}\n`);
  }

  renameRole(taskId: string, oldName: string, role: Role): void {
    const storageName = this.resolveRoleStorageName(taskId, oldName);

    if (storageName === null) {
      return;
    }

    const encoded = taskRecordCodec.encodeRole(role);
    this.writeSnapshot(this.roleFile(taskId, storageName), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    this.writeSnapshot(this.roleInfoFile(taskId, storageName), `${JSON.stringify(encoded.info, null, 2)}\n`);
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
    this.writeSnapshot(this.roleInfoFile(taskId, role.name), `${JSON.stringify(role, null, 2)}\n`);
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
    this.writeSnapshot(this.globalRoleFile(role.name), `${JSON.stringify(role, null, 2)}\n`);
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
    const existing = this.readOptionalText(this.commentsFile(taskId)) ?? "";
    this.writeSnapshot(this.commentsFile(taskId), `${existing}${JSON.stringify(comment)}\n`);
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
    const existing = this.readOptionalText(this.eventsFile(taskId)) ?? "";
    this.writeSnapshot(this.eventsFile(taskId), `${existing}${JSON.stringify(event)}\n`);
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
    this.writeSnapshot(this.transcriptFile(taskId, storageName), transcript);
  }

  readTranscript(taskId: string, roleName: string): string | null {
    const storageName = this.resolveRoleStorageName(taskId, roleName);

    if (storageName === null) {
      return null;
    }

    return this.readOptionalText(this.transcriptFile(taskId, storageName));
  }

  saveConfiguredAgent(agent: ConfiguredAgent): void {
    const agentDir = this.agentDir(agent.id);
    mkdirSync(agentDir, { recursive: true });
    this.writeSnapshot(this.agentFile(agent.id), `${JSON.stringify(agent, null, 2)}\n`);
  }

  listConfiguredAgents(): ConfiguredAgent[] {
    return this.directoryNames(this.agentsDir())
      .map((name) => this.getConfiguredAgent(name))
      .filter((agent): agent is ConfiguredAgent => agent !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getConfiguredAgent(id: string): ConfiguredAgent | null {
    try {
      return parseConfiguredAgent(id, readFileSync(this.agentFile(id), "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  removeConfiguredAgent(id: string): boolean {
    try {
      rmSync(this.agentDir(id), { recursive: true });
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

  private inputRequestsDir(taskId: string): string {
    return join(this.taskDir(taskId), "input-requests");
  }

  private inputRequestFile(taskId: string, requestId: string): string {
    return join(this.inputRequestsDir(taskId), `${requestId}.json`);
  }

  private inputResolutionsDir(taskId: string): string {
    return join(this.taskDir(taskId), "input-resolutions");
  }

  private inputResolutionFile(taskId: string, resolutionId: string): string {
    return join(this.inputResolutionsDir(taskId), `${resolutionId}.json`);
  }

  private taskScheduleFile(taskId: string): string {
    return join(this.taskDir(taskId), "schedule.json");
  }

  private taskBriefFile(taskId: string): string {
    return join(this.taskDir(taskId), "brief.md");
  }

  private taskTopicSummariesFile(taskId: string): string {
    return join(this.taskDir(taskId), "topic-summaries.md");
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

  private decisionsDir(taskId: string): string {
    return join(this.taskDir(taskId), "decisions");
  }

  private decisionFile(taskId: string, decisionId: string): string {
    return join(this.decisionsDir(taskId), `${decisionId}.json`);
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

  private leaderFailuresDir(): string {
    return join(this.runtimeDir(), "leader-failures");
  }

  private leaderFailureFile(taskId: string): string {
    return join(this.leaderFailuresDir(), `${taskId}.json`);
  }

  private operatorNotificationsDir(): string {
    return join(this.runtimeDir(), "operator-notifications");
  }

  private operatorNotificationFile(taskId: string): string {
    return join(this.operatorNotificationsDir(), `${taskId}.json`);
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

  private agentsDir(): string {
    return join(this.rootDir, "agents");
  }

  private agentDir(id: string): string {
    return join(this.agentsDir(), id);
  }

  private agentFile(id: string): string {
    return join(this.agentDir(id), "agent.json");
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

  private jsonRecordIds(path: string): string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -5))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private writeSnapshot(target: string, content: string): void {
    writeRecoverableSnapshot(this.rootDir, target, content);
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

function parseConfiguredAgent(id: string, raw: string): ConfiguredAgent {
  const value = parseJson(raw, `Invalid agent record: ${id}`);

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
    throw dataError(`Invalid agent record: ${id}`);
  }

  return value as ConfiguredAgent;
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
    !isOptionalString(value.lastTaskId) ||
    !isCompletionInstallations(value.completionInstallations)
  ) {
    throw dataError("Invalid config record");
  }

  return value as TaskmuxConfig;
}

function isCompletionInstallations(value: unknown): value is TaskmuxConfig["completionInstallations"] {
  if (value === undefined) {
    return true;
  }
  if (Array.isArray(value) || !isRecord(value) || Object.keys(value).some((key) => !COMPLETION_SHELLS.includes(key as CompletionShell))) {
    return false;
  }
  return Object.values(value).every((installation) =>
    isRecord(installation) &&
    Object.keys(installation).length === 2 &&
    Object.hasOwn(installation, "scriptPath") &&
    Object.hasOwn(installation, "activationPath") &&
    typeof installation.scriptPath === "string" &&
    installation.scriptPath.length > 0 &&
    isAbsolute(installation.scriptPath) &&
    resolve(installation.scriptPath) === installation.scriptPath &&
    typeof installation.activationPath === "string" &&
    installation.activationPath.length > 0 &&
    isAbsolute(installation.activationPath) &&
    resolve(installation.activationPath) === installation.activationPath
  );
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

function parseInputRequest(taskId: string, requestId: string, raw: string): InputRequest {
  const message = `Invalid input request record: ${taskId}/${requestId}`;
  const value = parseJson(raw, message);
  if (!isInputRequestRecord(value, taskId, requestId)) {
    throw dataError(message);
  }
  return value;
}

function parseInputResolution(taskId: string, resolutionId: string, raw: string): InputResolution {
  const message = `Invalid input resolution record: ${taskId}/${resolutionId}`;
  const value = parseJson(raw, message);
  if (!isInputResolutionRecord(value, taskId, resolutionId)) {
    throw dataError(message);
  }
  return value;
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
    (value.lastLeaderWakeupAt !== undefined && typeof value.lastLeaderWakeupAt !== "string") ||
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

function parseLeaderFailure(taskId: string, raw: string): LeaderFailure {
  const value = parseJson(raw, `Invalid leader failure record: ${taskId}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    typeof value.nativeSessionId !== "string" ||
    typeof value.message !== "string" ||
    typeof value.attemptCount !== "number" ||
    typeof value.firstFailedAt !== "string" ||
    typeof value.lastFailedAt !== "string"
  ) {
    throw dataError(`Invalid leader failure record: ${taskId}`);
  }
  return value as LeaderFailure;
}

function parseOperatorNotification(taskId: string, raw: string): OperatorNotification {
  const value = parseJson(raw, `Invalid Operator notification: ${taskId}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    value.type !== "leader-recovery-failed" ||
    typeof value.message !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid Operator notification: ${taskId}`);
  }
  return value as OperatorNotification;
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
    !["task-created", "user-comment", "schedule", "review-time", "operator-input", "role-result", "inactivity", "explicit-wake"].includes(String(value.cause)) ||
    typeof value.summary !== "string" ||
    (value.topics !== undefined && !isStringArray(value.topics)) ||
    !["active", "ended"].includes(String(value.status)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.endedAt !== undefined && typeof value.endedAt !== "string")
  ) {
    throw dataError(`Invalid cycle record: ${taskId}/${cycleId}`);
  }

  return { ...value, topics: value.topics ?? [] } as Cycle;
}

function parseDecision(taskId: string, decisionId: string, raw: string): Decision {
  const value = parseJson(raw, `Invalid decision record: ${taskId}/${decisionId}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== decisionId ||
    value.taskId !== taskId ||
    typeof value.title !== "string" ||
    typeof value.rationale !== "string" ||
    !isStringArray(value.topics) ||
    !["active", "superseded"].includes(String(value.status)) ||
    (value.supersededReason !== undefined && typeof value.supersededReason !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid decision record: ${taskId}/${decisionId}`);
  }
  return value as Decision;
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
    !["unknown", "reserved", "ready", "running", "stopped", "broken"].includes(String(value.status)) ||
    !isStringArray(value.previousSessionIds) ||
    (value.replacementReason !== undefined && typeof value.replacementReason !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid agent session record: ${taskId}/${roleName}`);
  }

  return value as AgentSession;
}

function parseRoleWorktree(taskId: string, roleName: string, raw: string): RoleWorktree {
  const value = parseJson(raw, `Invalid role worktree: ${taskId}/${roleName}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    value.roleName !== roleName ||
    typeof value.repository !== "string" ||
    typeof value.path !== "string" ||
    typeof value.branch !== "string" ||
    (value.base !== undefined && typeof value.base !== "string") ||
    typeof value.createdAt !== "string"
  ) {
    throw dataError(`Invalid role worktree: ${taskId}/${roleName}`);
  }
  return value as RoleWorktree;
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
    (value.workItemId !== undefined && typeof value.workItemId !== "string") ||
    (value.topics !== undefined && !isStringArray(value.topics)) ||
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
    (value.topics !== undefined && !isStringArray(value.topics)) ||
    (value.author !== undefined && !["user", "operator", "leader"].includes(String(value.author))) ||
    typeof value.createdAt !== "string"
  ) {
    throw dataError(`Invalid comment record: ${id}`);
  }

  return { ...value, topics: value.topics ?? [] } as TaskComment;
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

function assertInputPointerId(value: string, label: string): void {
  if (typeof value !== "string" || !INPUT_POINTER_ID_PATTERN.test(value)) {
    throw dataError(`Invalid ${label} id`);
  }
}

function inputRecordPointers(value: unknown): { taskId: string; id: string } | null {
  if (
    !isRecord(value) ||
    typeof value.taskId !== "string" ||
    typeof value.id !== "string"
  ) {
    return null;
  }
  return { taskId: value.taskId, id: value.id };
}
