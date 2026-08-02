import type { TaskStore } from "../storage/taskStore.js";
import type { Task, TaskStatus } from "../task/task.js";
import type { WorkItem, WorkItemStatus } from "../workItem/workItem.js";

export type WebDashboardStore = Pick<TaskStore,
  | "transaction"
  | "listTasks"
  | "getTask"
  | "getTaskBrief"
  | "listRoles"
  | "getTaskRoleSessionSet"
  | "listWorkItems"
  | "listAgentRuns"
  | "listInputRequests"
  | "listMessages"
  | "listDecisions"
  | "listMilestones"
  | "listProjects"
>;

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
      const names = task.projectBindings.flatMap(({ projectId }) => {
        const name = projectNames.get(projectId);
        return name === undefined ? [] : [name];
      });
      return {
        ...task,
        ...(names.length === 0 ? {} : { projectNames: names }),
        workItems: countWorkItems(reader.listWorkItems(task.id)),
        roleCount: reader.listRoles(task.id).length,
        openInputCount: taskOpenInputs
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
    const activeRuns = new Map(runs
      .filter((run) => run.status === "active")
      .map((run) => [run.roleName, run]));
    const roles = reader.listRoles(taskId).map((role) => {
      const activeRun = activeRuns.get(role.name);
      const sessions = reader.getTaskRoleSessionSet(taskId, role.name);
      const activeSession = sessions?.sessions[sessions.activeAgentId];
      const effectiveLaunch = activeRun?.effective ?? activeSession?.effective ?? null;
      return {
        ...role,
        effectiveLaunch,
        effectiveLaunchSource: activeRun === undefined
          ? activeSession === undefined ? null : "session"
          : "run",
        launchDrift: effectiveLaunch !== null
          && effectiveLaunch.sourceDesiredRevision !== role.launchRevision
      };
    });
    return {
      task: projectNames.length === 0 ? task : { ...task, projectNames },
      brief: reader.getTaskBrief(taskId),
      roles,
      workItems: reader.listWorkItems(taskId),
      runs,
      openInputs: inputs.filter((request) => request.status === "open"),
      messages: reader.listMessages(taskId),
      decisions: reader.listDecisions(taskId),
      milestones: reader.listMilestones(taskId)
    };
  });
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
