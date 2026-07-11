import { dataError } from "../errors/cliError.js";
import type { Role } from "../role/role.js";
import type { RunnerEnvironment } from "../runner/runner.js";
import type { Task, TaskPriority, TaskStatus } from "../task/task.js";

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
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type RoleInfoRecord = {
  schemaVersion: 1;
  name: string;
};

export type RoleRuntimeRecord = {
  schemaVersion: 1;
  agent: string;
  command: string;
  args: string[];
  env: RunnerEnvironment;
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
        status: task.status,
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
        agent: role.agent,
        command: role.command,
        args: role.args,
        env: role.env,
        workspace: role.workspace,
        status: role.status,
        createdAt: role.createdAt,
        updatedAt: role.updatedAt
      },
      info: {
        schemaVersion: 1,
        name: role.name
      }
    };
  }

  decodeRole(name: string, runtimeRaw: string, infoRaw: string | null): Role {
    const runtime = this.parseRoleRuntime(name, runtimeRaw);

    if (infoRaw === null) {
      throw dataError(`Invalid role info record: ${name}`);
    }

    const info = this.parseRoleInfo(name, infoRaw);

    return {
      ...runtime,
      name: info.name
    };
  }

  private parseTaskRuntime(id: string, raw: string): TaskRuntimeRecord {
    const value = parseJson(raw, `Invalid task record: ${id}`);

    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.id !== "string" ||
      "title" in value ||
      !isTaskStatus(value.status) ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw dataError(`Invalid task record: ${id}`);
    }

    return {
      ...(value as Omit<TaskRuntimeRecord, "archived">),
      archived: typeof value.archived === "boolean" ? value.archived : value.status === "archived"
    };
  }

  private parseTaskInfo(id: string, raw: string): TaskInfoRecord {
    const value = parseJson(raw, `Invalid task info record: ${id}`);

    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.title !== "string" ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.priority !== undefined && !isTaskPriority(value.priority)) ||
      (value.tags !== undefined && !isStringArray(value.tags)) ||
      (value.dueAt !== undefined && typeof value.dueAt !== "string")
    ) {
      throw dataError(`Invalid task info record: ${id}`);
    }

    return value as TaskInfoRecord;
  }

  private parseRoleRuntime(name: string, raw: string): RoleRuntimeRecord {
    const value = parseJson(raw, `Invalid role record: ${name}`);

    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      "name" in value ||
      typeof value.agent !== "string" ||
      typeof value.command !== "string" ||
      !isStringArray(value.args) ||
      !isStringRecord(value.env) ||
      typeof value.workspace !== "string" ||
      !["idle", "running", "detached", "exited", "failed"].includes(String(value.status)) ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw dataError(`Invalid role record: ${name}`);
    }

    return value as RoleRuntimeRecord;
  }

  private parseRoleInfo(name: string, raw: string): RoleInfoRecord {
    const value = parseJson(raw, `Invalid role info record: ${name}`);

    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.name !== "string") {
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
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isTaskStatus(status: unknown): status is TaskStatus {
  return ["open", "active", "done", "archived"].includes(String(status));
}

function isTaskPriority(priority: unknown): priority is TaskPriority {
  return ["low", "medium", "high", "urgent"].includes(String(priority));
}
