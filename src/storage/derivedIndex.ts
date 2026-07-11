import Database from "better-sqlite3";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TaskStore } from "./taskStore.js";

export function rebuildDerivedIndex(rootDir: string, store: TaskStore): void {
  const runtimeDir = join(rootDir, "runtime");
  const indexFile = join(runtimeDir, "index.sqlite");
  mkdirSync(runtimeDir, { recursive: true });

  try {
    rebuild(indexFile, store);
  } catch {
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}-shm`, { force: true });
    rmSync(`${indexFile}-wal`, { force: true });
    rebuild(indexFile, store);
  }
  chmodSync(indexFile, 0o600);
}

function rebuild(indexFile: string, store: TaskStore): void {
  const database = new Database(indexFile);
  try {
    database.pragma("journal_mode = DELETE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roles (
        task_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace TEXT NOT NULL,
        PRIMARY KEY (task_id, name)
      );
      CREATE TABLE IF NOT EXISTS work_items (
        task_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        assignee TEXT NOT NULL,
        status TEXT NOT NULL,
        cycle_id TEXT,
        topics TEXT NOT NULL,
        PRIMARY KEY (task_id, id)
      );
    `);

    const insertTask = database.prepare(
      "INSERT INTO tasks (id, title, archived, updated_at) VALUES (?, ?, ?, ?)"
    );
    const insertRole = database.prepare(
      "INSERT INTO roles (task_id, name, agent, status, workspace) VALUES (?, ?, ?, ?, ?)"
    );
    const insertWorkItem = database.prepare(
      "INSERT INTO work_items (task_id, id, title, assignee, status, cycle_id, topics) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const tasks = store.listTasks();
    database.transaction(() => {
      database.exec("DELETE FROM tasks; DELETE FROM roles; DELETE FROM work_items; DELETE FROM metadata;");
      database.prepare("INSERT INTO metadata (key, value) VALUES ('schemaVersion', '1')").run();
      for (const task of tasks) {
        insertTask.run(task.id, task.title, task.archived ? 1 : 0, task.updatedAt);
        for (const role of store.listRoles(task.id)) {
          insertRole.run(task.id, role.name, role.agent, role.status, role.workspace);
        }
        for (const workItem of store.listWorkItems(task.id)) {
          insertWorkItem.run(
            task.id,
            workItem.id,
            workItem.title,
            workItem.assignee,
            workItem.status,
            workItem.cycleId ?? null,
            JSON.stringify(workItem.topics)
          );
        }
      }
    })();
  } finally {
    database.close();
  }
}
