import type { TaskStore } from "../storage/taskStore.js";
import type { Task, TaskStatus } from "../task/task.js";
import type { WorkItem, WorkItemStatus } from "../workItem/workItem.js";
import { isRoleRunStalled } from "../scheduler/roleRunStall.js";
import type { TaskEvent } from "../event/taskEvent.js";

export type WebDashboardStore = Pick<TaskStore,
  | "transaction"
  | "listTasks"
  | "getTask"
  | "getTaskBrief"
  | "listRoles"
  | "listWorkItems"
  | "listAgentRuns"
  | "listInputRequests"
  | "listMessages"
  | "listDecisions"
  | "listMilestones"
  | "listProjects"
> & Readonly<{
  listEvents?: (taskId: string) => readonly TaskEvent[];
}>;

type WorkItemCounts = Readonly<{
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}>;

type DashboardTask = Task & Readonly<{
  workItems: WorkItemCounts;
  roleCount: number;
  openInputCount: number;
  needsAttentionCount: number;
  projectNames?: readonly string[];
}>;

export type WebDashboardSnapshot = Readonly<{
  generatedAt: string;
  counts: Readonly<Record<TaskStatus, number> & { total: number; openInputs: number }>;
  tasks: readonly DashboardTask[];
}>;

export function buildWebDashboardSnapshot(
  store: WebDashboardStore,
  now: Date = new Date()
): WebDashboardSnapshot {
  return store.transaction((reader) => {
    const statusCounts: Record<TaskStatus, number> = {
      draft: 0,
      active: 0,
      completed: 0,
      archived: 0
    };
    const projectNames = new Map(reader.listProjects().map((project) => [project.id, project.name]));
    let openInputs = 0;
    const tasks = reader.listTasks().map((task): DashboardTask => {
      statusCounts[task.status] += 1;
      const taskOpenInputs = reader.listInputRequests(task.id)
        .filter((request) => request.status === "open").length;
      openInputs += taskOpenInputs;
      const events = reader.listEvents?.(task.id) ?? [];
      const needsAttentionCount = reader.listAgentRuns(task.id)
        .filter((run) => run.status === "active" && isRoleRunStalled(events, run.id))
        .length;
      const names = task.projectBindings.flatMap(({ projectId }) => {
        const name = projectNames.get(projectId);
        return name === undefined ? [] : [name];
      });
      return {
        ...task,
        ...(names.length === 0 ? {} : { projectNames: names }),
        workItems: countWorkItems(reader.listWorkItems(task.id)),
        roleCount: reader.listRoles(task.id).length,
        openInputCount: taskOpenInputs,
        needsAttentionCount
      };
    }).sort(compareDashboardTasks);

    return {
      generatedAt: now.toISOString(),
      counts: { total: tasks.length, ...statusCounts, openInputs },
      tasks
    };
  });
}

export function buildWebTaskDetail(store: WebDashboardStore, taskId: string): object | null {
  return store.transaction((reader) => {
    const task = reader.getTask(taskId);
    if (task === null) return null;
    const inputs = reader.listInputRequests(taskId);
    const projectNamesById = new Map(
      reader.listProjects().map((project) => [project.id, project.name])
    );
    const projectNames = task.projectBindings.flatMap(({ projectId }) => {
      const name = projectNamesById.get(projectId);
      return name === undefined ? [] : [name];
    });
    const runs = reader.listAgentRuns(taskId);
    const events = reader.listEvents?.(taskId) ?? [];
    const needsAttentionRuns = runs
      .filter((run) => run.status === "active" && isRoleRunStalled(events, run.id))
      .map((run) => ({
        runId: run.id,
        roleName: run.roleName,
        progressAt: latestStallProgress(events, run.id),
        kind: latestStallField(events, run.id, "kind") ?? "execution-stalled",
        classification: latestStallField(events, run.id, "classification") ?? "truly-stalled"
      }));
    return {
      task: projectNames.length === 0 ? task : { ...task, projectNames },
      brief: reader.getTaskBrief(taskId),
      roles: reader.listRoles(taskId),
      workItems: reader.listWorkItems(taskId),
      runs,
      runtimeHealth: { needsAttentionRuns },
      openInputs: inputs.filter((request) => request.status === "open"),
      messages: reader.listMessages(taskId),
      decisions: reader.listDecisions(taskId),
      milestones: reader.listMilestones(taskId)
    };
  });
}

function latestStallProgress(events: readonly TaskEvent[], runId: string): string | undefined {
  return latestStallField(events, runId, "progressAt");
}

function latestStallField(
  events: readonly TaskEvent[],
  runId: string,
  field: string
): string | undefined {
  const stalled = events
    .filter((event) => event.type === "run.stalled" && event.payload.runId === runId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return stalled?.payload[field];
}

function countWorkItems(items: readonly WorkItem[]): WorkItemCounts {
  const counts: WorkItemCounts = { total: items.length, pending: 0, running: 0, completed: 0, failed: 0 };
  const mutable = counts as Record<keyof WorkItemCounts, number>;
  for (const item of items) {
    const key = visibleWorkItemStatus(item.status);
    if (key !== null) mutable[key] += 1;
  }
  return counts;
}

function visibleWorkItemStatus(status: WorkItemStatus): keyof Omit<WorkItemCounts, "total"> | null {
  if (status === "pending" || status === "running" || status === "completed" || status === "failed") {
    return status;
  }
  return null;
}

function compareDashboardTasks(left: DashboardTask, right: DashboardTask): number {
  const statusOrder: Record<TaskStatus, number> = { active: 0, draft: 1, completed: 2, archived: 3 };
  return statusOrder[left.status] - statusOrder[right.status]
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || left.id.localeCompare(right.id);
}
