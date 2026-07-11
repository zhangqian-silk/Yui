import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StorageMigration } from "./v0ToV1.js";

export const migrateStorageV1ToV2: StorageMigration = {
  fromVersion: 1,
  toVersion: 2,
  run(rootDir) {
    migrateTasks(rootDir);
    migrateOperatorRole(rootDir);
  }
};

function migrateTasks(rootDir: string): void {
  const tasksDir = join(rootDir, "tasks");
  for (const taskId of directoryNames(tasksDir)) {
    const taskFile = join(tasksDir, taskId, "task.json");
    if (!existsSync(taskFile)) {
      continue;
    }

    const task = JSON.parse(readFileSync(taskFile, "utf8")) as Record<string, unknown>;
    if (typeof task.archived !== "boolean") {
      task.archived = task.status === "archived";
    }
    delete task.status;
    writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`);
  }
}

function migrateOperatorRole(rootDir: string): void {
  const rolesDir = join(rootDir, "roles");
  const assistantDir = join(rolesDir, "assistant");
  const operatorDir = join(rolesDir, "operator");

  if (!existsSync(assistantDir) || existsSync(operatorDir)) {
    return;
  }

  const roleFile = join(assistantDir, "role.json");
  if (existsSync(roleFile)) {
    const role = JSON.parse(readFileSync(roleFile, "utf8")) as Record<string, unknown>;
    if (role.name === "assistant") {
      role.name = "operator";
      writeFileSync(roleFile, `${JSON.stringify(role, null, 2)}\n`);
    }
  }
  renameSync(assistantDir, operatorDir);
}

function directoryNames(path: string): string[] {
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
