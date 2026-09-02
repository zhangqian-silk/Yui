import type { Project } from "../repository/project.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "./task.js";
import type { WorkItem } from "../workItem/workItem.js";

type DraftPlanFacts = Readonly<{
  task: Task;
  workItems: readonly WorkItem[];
  roleNames: ReadonlySet<string>;
  projects: ReadonlyMap<string, Project>;
}>;

export type DraftWorkItemDependencyIssue = Readonly<{
  kind: "missing-or-retired" | "cycle";
  workItemId: string;
  dependencyId: string;
}>;

export function assertDraftTaskExecutionFree(store: TaskStore, task: Task): void {
  if (task.status !== "draft") {
    throw new Error(`Task is not a Draft: ${task.id}/${task.status}.`);
  }
  const executionFact = firstDraftExecutionFact(store, task);
  if (executionFact !== undefined) {
    throw new Error(
      `Draft Task ${task.id} has execution facts (${executionFact}); `
      + "retire it and create a clean Draft instead of editing runtime history."
    );
  }
}

export function validateDraftWorkItemEdit(
  store: TaskStore,
  task: Task,
  candidate: WorkItem
): void {
  assertDraftTaskExecutionFree(store, task);
  const workItems = store.listWorkItems(task.id).map((item) => (
    item.id === candidate.id ? candidate : item
  ));
  const facts = draftPlanFacts(store, task, workItems);
  validateWorkItemReferences(facts, candidate);
  assertDraftWorkItemDependencyGraph(facts.workItems, candidate);
}

export function validateDraftTaskForActivation(store: TaskStore, task: Task): void {
  assertDraftTaskExecutionFree(store, task);
  const facts = draftPlanFacts(store, task, store.listWorkItems(task.id));
  const current = facts.workItems.filter(({ status }) => status !== "retired");
  for (const item of current) validateWorkItemReferences(facts, item);
  assertDraftWorkItemDependencyGraph(current);
}

/** Derive the first invalid edge in the current Draft dependency graph. */
export function draftWorkItemDependencyIssue(
  workItems: readonly WorkItem[],
  onlyItem?: WorkItem
): DraftWorkItemDependencyIssue | undefined {
  const current = workItems.filter(({ status }) => status !== "retired");
  const byId = new Map(current.map((item) => [item.id, item] as const));
  for (const item of onlyItem === undefined ? current : [onlyItem]) {
    const dependencyId = item.dependsOn.find((id) => !byId.has(id));
    if (dependencyId !== undefined) {
      return { kind: "missing-or-retired", workItemId: item.id, dependencyId };
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (item: WorkItem): DraftWorkItemDependencyIssue | undefined => {
    visiting.add(item.id);
    for (const dependencyId of item.dependsOn) {
      if (visiting.has(dependencyId)) {
        return { kind: "cycle", workItemId: item.id, dependencyId };
      }
      if (visited.has(dependencyId)) continue;
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) continue;
      const issue = visit(dependency);
      if (issue !== undefined) return issue;
    }
    visiting.delete(item.id);
    visited.add(item.id);
    return undefined;
  };
  for (const item of current) {
    if (visited.has(item.id)) continue;
    const issue = visit(item);
    if (issue !== undefined) return issue;
  }
  return undefined;
}

function draftPlanFacts(
  store: TaskStore,
  task: Task,
  workItems: readonly WorkItem[]
): DraftPlanFacts {
  const projects = new Map<string, Project>();
  for (const binding of task.projectBindings) {
    const project = store.getProject(binding.projectId);
    if (project === null) {
      throw new Error(`Task Project not found: ${binding.projectId}.`);
    }
    if (project.status !== "active") {
      throw new Error(`Task Project is not active: ${project.id}/${project.status}.`);
    }
    projects.set(project.id, project);
  }
  return {
    task,
    workItems,
    roleNames: new Set(store.listRoles(task.id).map(({ name }) => name)),
    projects
  };
}

function validateWorkItemReferences(facts: DraftPlanFacts, item: WorkItem): void {
  if (item.assignee !== undefined && !facts.roleNames.has(item.assignee)) {
    throw new Error(`Work Item assignee Role not found: ${item.id}/${item.assignee}.`);
  }
  for (const projectId of item.writeProjectIds) {
    if (!facts.projects.has(projectId)) {
      throw new Error(`Work Item writable Project is not bound: ${item.id}/${projectId}.`);
    }
  }
  for (const baseRef of item.baseRefs ?? []) {
    if (!item.writeProjectIds.includes(baseRef.projectId)) {
      throw new Error(
        `Work Item base-ref Project is not writable: ${item.id}/${baseRef.projectId}.`
      );
    }
  }
}

function assertDraftWorkItemDependencyGraph(
  workItems: readonly WorkItem[],
  onlyItem?: WorkItem
): void {
  const issue = draftWorkItemDependencyIssue(workItems, onlyItem);
  if (issue === undefined) return;
  if (issue.kind === "missing-or-retired") {
    throw new Error(
      `Work Item dependency is missing or retired: ${issue.workItemId}/${issue.dependencyId}.`
    );
  }
  throw new Error(
    `Work Item dependency cycle detected: ${issue.workItemId}/${issue.dependencyId}.`
  );
}

function firstDraftExecutionFact(store: TaskStore, task: Task): string | undefined {
  if (task.workspaceIdentity !== undefined || task.cwd !== undefined) return "Task workspace";
  const hostOwner = store.listSessionOwners().find(({ owner }) => (
    owner.scope === "task" && owner.taskId === task.id
  ));
  if (hostOwner !== undefined) return `Host owner (${hostOwner.launchId})`;
  if (store.listTurns(task.id).length > 0) return "Turn";
  if (store.listRoleSessionSets(task.id).length > 0) return "Role Session";
  if (store.listDurableJobs(task.id).length > 0) return "DurableJob";
  if (store.listManagedWorkspaces(task.id).length > 0) return "managed Workspace";
  if (store.listReviewRounds(task.id).length > 0) return "ReviewRound";
  if (store.listIntegrationAttempts(task.id).length > 0) return "Integration Attempt";
  if (store.listChangeSets(task.id).length > 0) return "ChangeSet";
  const itemWithExecution = store.listWorkItems(task.id).find((item) => (
    item.executionGroups.length > 0
    || item.currentExecutionGroupId !== undefined
    || item.candidates.length > 0
    || item.workspaceDisposition !== undefined
    || !["pending", "retired"].includes(item.status)
  ));
  if (itemWithExecution !== undefined) {
    return `Work Item execution (${itemWithExecution.id})`;
  }
  const runtimeEvent = store.listEvents(task.id).find(({ type }) => (
    type.startsWith("runtime.")
    || type.startsWith("turn.")
    || type.startsWith("review.")
    || type.startsWith("integration.")
  ));
  return runtimeEvent === undefined ? undefined : `event ${runtimeEvent.id}/${runtimeEvent.type}`;
}
