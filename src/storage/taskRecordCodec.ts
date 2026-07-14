import { dataError } from "../errors/cliError.js";
import type { Role, RoleProfile } from "../role/role.js";
import type { RoleAgentBinding } from "../role/role.js";
import type { Task, TaskPriority } from "../task/task.js";
import { isRoleProfileRecord, isTaskRoleRecord } from "./recordValidation.js";

export type TaskInfoRecord = {
  schemaVersion: 1;
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
};

export type TaskRuntimeRecord = {
  schemaVersion: 1;
  id: string;
  archived: boolean;
  archivedAt?: string;
  archivedBy?: Task["archivedBy"];
  archiveReason?: string;
  archiveSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export type RoleInfoRecord = RoleProfile & {
  schemaVersion: 1;
  name: string;
};

export type RoleRuntimeRecord = {
  schemaVersion: 2;
  taskId: string;
  activeAgentId: string;
  agentBindings: Record<string, RoleAgentBinding>;
  workspace: string;
  status: Role["status"];
  createdAt: string;
  updatedAt: string;
};

export type EncodedTaskRecord = {
  runtime: TaskRuntimeRecord;
  info: TaskInfoRecord;
};

export type EncodedRoleRecord = {
  runtime: RoleRuntimeRecord;
  info: RoleInfoRecord;
};

export class TaskRecordCodec {
  encodeTask(task: Task): EncodedTaskRecord {
    return {
      runtime: {
        schemaVersion: task.schemaVersion,
        id: task.id,
        archived: task.archived,
        archivedAt: task.archivedAt,
        archivedBy: task.archivedBy,
        archiveReason: task.archiveReason,
        archiveSummary: task.archiveSummary,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
      },
      info: {
        schemaVersion: 1,
        title: task.title,
        description: task.description,
        priority: task.priority,
        tags: task.tags,
        dueAt: task.dueAt
      }
    };
  }

  decodeTask(id: string, runtimeRaw: string, infoRaw: string | null): Task {
    const runtime = this.parseTaskRuntime(id, runtimeRaw);

    if (infoRaw === null) {
      throw dataError(`Invalid task info record: ${id}`);
    }

    const info = this.parseTaskInfo(id, infoRaw);

    return {
      ...runtime,
      title: info.title,
      description: info.description,
      priority: info.priority,
      tags: info.tags,
      dueAt: info.dueAt
    };
  }

  encodeRole(role: Role): EncodedRoleRecord {
    return {
      runtime: {
        schemaVersion: role.schemaVersion,
        taskId: role.taskId,
        activeAgentId: role.activeAgentId,
        agentBindings: role.agentBindings,
        workspace: role.workspace,
        status: role.status,
        createdAt: role.createdAt,
        updatedAt: role.updatedAt
      },
      info: {
        schemaVersion: 1,
        name: role.name,
        description: role.description,
        responsibilities: role.responsibilities,
        constraints: role.constraints,
        expectedOutput: role.expectedOutput,
        systemPrompt: role.systemPrompt,
        skills: role.skills
      }
    };
  }

  decodeRole(taskId: string, name: string, runtimeRaw: string, infoRaw: string | null): Role {
    const runtime = this.parseRoleRuntime(taskId, name, runtimeRaw);

    if (infoRaw === null) {
      throw dataError(`Invalid role info record: ${name}`);
    }

    const info = this.parseRoleInfo(name, infoRaw);

    const { schemaVersion: _infoSchemaVersion, ...profile } = info;
    return { ...runtime, ...profile };
  }

  private parseTaskRuntime(id: string, raw: string): TaskRuntimeRecord {
    const value = parseJson(raw, `Invalid task record: ${id}`);

    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "schemaVersion", "id", "archived", "createdAt", "updatedAt"
      ], ["archivedAt", "archivedBy", "archiveReason", "archiveSummary"]) ||
      value.schemaVersion !== 1 ||
      value.id !== id ||
      "title" in value ||
      "status" in value ||
      typeof value.archived !== "boolean" ||
      (value.archivedAt !== undefined && typeof value.archivedAt !== "string") ||
      (value.archivedBy !== undefined && !["user", "operator", "leader"].includes(String(value.archivedBy))) ||
      (value.archiveReason !== undefined && typeof value.archiveReason !== "string") ||
      (value.archiveSummary !== undefined && typeof value.archiveSummary !== "string") ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw dataError(`Invalid task record: ${id}`);
    }

    return {
      schemaVersion: 1,
      id: value.id,
      archived: value.archived,
      ...(value.archivedAt === undefined ? {} : { archivedAt: value.archivedAt as string }),
      ...(value.archivedBy === undefined ? {} : { archivedBy: value.archivedBy as Task["archivedBy"] }),
      ...(value.archiveReason === undefined ? {} : { archiveReason: value.archiveReason as string }),
      ...(value.archiveSummary === undefined ? {} : { archiveSummary: value.archiveSummary as string }),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt
    };
  }

  private parseTaskInfo(id: string, raw: string): TaskInfoRecord {
    const value = parseJson(raw, `Invalid task info record: ${id}`);

    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["schemaVersion", "title"], ["description", "priority", "tags", "dueAt"]) ||
      value.schemaVersion !== 1 ||
      typeof value.title !== "string" || value.title.trim().length === 0 ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.priority !== undefined && !isTaskPriority(value.priority)) ||
      (value.tags !== undefined && !isStringArray(value.tags)) ||
      (value.dueAt !== undefined && typeof value.dueAt !== "string")
    ) {
      throw dataError(`Invalid task info record: ${id}`);
    }

    return value as TaskInfoRecord;
  }

  private parseRoleRuntime(taskId: string, name: string, raw: string): RoleRuntimeRecord {
    const value = parseJson(raw, `Invalid role record: ${name}`);

    if (!isRecord(value) || !hasExactKeys(value, [
      "schemaVersion", "taskId", "activeAgentId", "agentBindings", "workspace", "status", "createdAt", "updatedAt"
    ])) {
      throw dataError(`Invalid role record: ${name}`);
    }
    const candidate = { ...value, name };
    if (!isTaskRoleRecord(candidate, taskId, name)) {
      throw dataError(`Invalid role record: ${name}`);
    }

    return value as unknown as RoleRuntimeRecord;
  }

  private parseRoleInfo(name: string, raw: string): RoleInfoRecord {
    const value = parseJson(raw, `Invalid role info record: ${name}`);

    if (!isRoleProfileRecord(value, name)) {
      throw dataError(`Invalid role info record: ${name}`);
    }

    return value as RoleInfoRecord;
  }
}

export const taskRecordCodec = new TaskRecordCodec();

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw dataError(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isTaskPriority(priority: unknown): priority is TaskPriority {
  return ["low", "medium", "high", "urgent"].includes(String(priority));
}
