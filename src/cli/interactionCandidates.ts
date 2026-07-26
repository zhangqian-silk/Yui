import type { TableColumn } from "../output/table.js";
import type { ArgumentSelector } from "./interactionPolicy.js";
import { orderRoleOptions } from "./roleOptionCatalog.js";
import type { SelectionPorts } from "./selectionPorts.js";

export type SelectionCandidate = Readonly<{
  value: string;
  cells: readonly string[];
}>;

export type CandidateSet = Readonly<{
  entityLabel: string;
  title: string;
  columns: readonly TableColumn[];
  candidates: readonly SelectionCandidate[];
  defaultValue?: string;
  emptyMessage: string;
  overflowHint: string;
}>;

type Entity = Readonly<Record<string, unknown>>;

export async function getSelectionCandidates(
  selector: ArgumentSelector,
  ports: SelectionPorts,
  args: readonly string[]
): Promise<CandidateSet | null> {
  switch (selector.provider) {
    case "tasks":
      return entities(
        "task",
        "Select task",
        (await list(ports, "task.list", {})).filter((task) =>
          selector.statuses === undefined
          || selector.statuses.includes(stringField(task, "status") ?? "")
        ),
        ["id", "title", "status"]
      );
    case "projects":
      return entities(
        "project",
        "Select Project",
        await list(ports, "project.list", {}),
        ["id", "name", "path"]
      );
    case "configured-agents": {
      const agents = await list(ports, "agent.list", {});
      const config = await optionalEntity(ports, "config.get", {});
      const defaultValue = config === undefined
        ? undefined
        : stringField(config, "defaultAgent");
      const set = entities(
        "agent",
        "Select Agent",
        agents.map((agent) => ({
          ...agent,
          default: stringField(agent, "id") === defaultValue ? "default" : ""
        })),
        ["id", "adapterId", "command", "default"]
      );
      return { ...set, defaultValue };
    }
    case "global-roles":
      return entities(
        "global role",
        "Select global Role",
        await list(ports, "role.list", {}),
        ["name", "activeAgentId", "workspace"]
      );
    case "jobs":
      return entities(
        "job",
        "Select job",
        await list(ports, "jobs.list", {}),
        ["id", "type", "status"]
      );
    case "input-requests": {
      const taskId = dependencyValue(selector, args);
      return entities(
        "input request",
        taskId === undefined ? "Select input request" : `Select input request: ${taskId}`,
        (await list(ports, "task.input.list", {
          ...(taskId === undefined ? {} : { taskId }),
          all: true
        })).filter((request) => selector.statuses === undefined
          || selector.statuses.includes(stringField(request, "status") ?? "")),
        ["id", "taskId", "status", "question"]
      );
    }
    case "task-roles": {
      const taskId = dependencyValue(selector, args);
      if (taskId === undefined) return null;
      const roles = orderRoleOptions(await list(ports, "task.role.list", { taskId }));
      return entities("task role", `Select Task role: ${taskId}`, roles, ["name", "kind", "agentId"]);
    }
    case "task-decisions": {
      const taskId = dependencyValue(selector, args);
      if (taskId === undefined) return null;
      const decisions = (await list(ports, "task.decision.list", { taskId })).filter((decision) =>
        selector.statuses === undefined
        || selector.statuses.includes(stringField(decision, "status") ?? "")
      );
      return entities("decision", `Select Decision: ${taskId}`, decisions, ["id", "status", "title"]);
    }
    case "task-milestones": {
      const taskId = dependencyValue(selector, args);
      if (taskId === undefined) return null;
      return entities(
        "milestone",
        `Select Milestone: ${taskId}`,
        await list(ports, "task.milestone.list", { taskId }),
        ["id", "title", "createdAt"]
      );
    }
    case "task-events": {
      const taskId = dependencyValue(selector, args);
      if (taskId === undefined) return null;
      return entities(
        "event",
        `Select Event: ${taskId}`,
        await list(ports, "task.event.list", { taskId }),
        ["id", "type", "createdAt"]
      );
    }
    case "work-items":
      return entities(
        "work item",
        "Select work item",
        await listAllWorkItems(ports),
        ["id", "title", "status"]
      );
    case "runs":
      return entities(
        "run",
        "Select run",
        await listAllRuns(ports),
        ["id", "status", "workItemId"]
      );
  }
}

async function listAllWorkItems(ports: SelectionPorts): Promise<Entity[]> {
  const tasks = await list(ports, "task.list", {});
  const groups = await Promise.all(tasks.flatMap((task) => {
    const taskId = stringField(task, "id");
    return taskId === undefined ? [] : [list(ports, "task.work.list", { taskId })];
  }));
  return groups.flat();
}

async function listAllRuns(ports: SelectionPorts): Promise<Entity[]> {
  const workItems = await listAllWorkItems(ports);
  const groups = await Promise.all(workItems.flatMap((item) => {
    const workItemId = stringField(item, "id");
    return workItemId === undefined ? [] : [list(ports, "task.run.list", { workItemId })];
  }));
  return groups.flat();
}

async function list(
  ports: SelectionPorts,
  method: string,
  params: Readonly<Record<string, unknown>>
): Promise<Entity[]> {
  const value = await ports.call(method, params);
  return Array.isArray(value)
    ? value.filter((entry): entry is Entity => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

async function optionalEntity(
  ports: SelectionPorts,
  method: string,
  params: Readonly<Record<string, unknown>>
): Promise<Entity | undefined> {
  try {
    const value = await ports.call(method, params);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Entity
      : undefined;
  } catch {
    return undefined;
  }
}

function dependencyValue(selector: ArgumentSelector, args: readonly string[]): string | undefined {
  if (selector.dependsOn === undefined) return undefined;
  const value = args[selector.dependsOn];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function entities(
  label: string,
  title: string,
  input: readonly Entity[],
  fields: readonly string[]
): CandidateSet {
  const valueField = fields[0] ?? "id";
  const candidates = input.flatMap((entity): SelectionCandidate[] => {
    const value = stringField(entity, valueField) ?? stringField(entity, "id");
    if (value === undefined) return [];
    return [{ value, cells: fields.map((field) => displayField(entity[field])) }];
  });
  return {
    entityLabel: label,
    title,
    columns: fields.map((field) => ({
      header: heading(field),
      minWidth: Math.min(12, Math.max(3, field.length)),
      maxWidth: field === "title" || field === "path" ? 48 : 24
    })),
    candidates,
    emptyMessage: `No ${label}s are available.`,
    overflowHint: `Pass the ${label} explicitly.`
  };
}

function stringField(entity: Entity, name: string): string | undefined {
  const value = entity[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function displayField(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function heading(field: string): string {
  return `${field[0]?.toUpperCase() ?? ""}${field.slice(1).replaceAll(/([A-Z])/g, " $1")}`;
}
