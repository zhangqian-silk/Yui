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
  assertAcyclic(facts.workItems.filter(({ status }) => status !== "retired"));
}

export function validateDraftTaskForActivation(store: TaskStore, task: Task): void {
  assertDraftTaskExecutionFree(store, task);
  const facts = draftPlanFacts(store, task, store.listWorkItems(task.id));
  const current = facts.workItems.filter(({ status }) => status !== "retired");
  for (const item of current) validateWorkItemReferences(facts, item);
  assertAcyclic(current);
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
  const currentById = new Map(
    facts.workItems
      .filter(({ status }) => status !== "retired")
      .map((candidate) => [candidate.id, candidate] as const)
  );
  for (const dependencyId of item.dependsOn) {
    if (!currentById.has(dependencyId)) {
      throw new Error(
        `Work Item dependency is missing or retired: ${item.id}/${dependencyId}.`
      );
    }
  }
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

function assertAcyclic(workItems: readonly WorkItem[]): void {
  const byId = new Map(workItems.map((item) => [item.id, item] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Work Item dependency cycle detected at ${id}.`);
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (item === undefined) return;
    visiting.add(id);
    for (const dependencyId of item.dependsOn) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of workItems) visit(item.id);
}

function firstDraftExecutionFact(store: TaskStore, task: Task): string | undefined {
  if (task.workspaceIdentity !== undefined || task.cwd !== undefined) return "Task workspace";
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
