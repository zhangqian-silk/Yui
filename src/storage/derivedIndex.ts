import Database from "better-sqlite3";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TaskReader, TaskStore } from "./taskStore.js";

export function rebuildDerivedIndex(rootDir: string, store: TaskStore): void {
  const snapshot = store.runReadSnapshot((reader) => captureDerivedIndex(reader));
  rebuildDerivedIndexSnapshot(rootDir, snapshot);
}

function captureDerivedIndex(store: TaskReader) {
  return store.listTasks().map((task) => ({
    task,
    roles: store.listRoles(task.id),
    workItems: store.listWorkItems(task.id),
    inputRequests: store.listInputRequests(task.id)
  }));
}

function rebuildDerivedIndexSnapshot(
  rootDir: string,
  snapshot: ReturnType<typeof captureDerivedIndex>
): void {
  const runtimeDir = join(rootDir, "runtime");
  const indexFile = join(runtimeDir, "index.sqlite");
  mkdirSync(runtimeDir, { recursive: true });

  try {
    rebuild(indexFile, snapshot);
  } catch {
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}-shm`, { force: true });
    rmSync(`${indexFile}-wal`, { force: true });
    rebuild(indexFile, snapshot);
  }
  chmodSync(indexFile, 0o600);
}

function rebuild(indexFile: string, snapshot: ReturnType<typeof captureDerivedIndex>): void {
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
      DROP TABLE IF EXISTS input_requests;
      CREATE TABLE input_requests (
        request_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        policy TEXT NOT NULL,
        requester_agent TEXT NOT NULL,
        blocked_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, request_id)
      );
      CREATE INDEX input_requests_by_request_id ON input_requests (request_id);
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
    const insertInputRequest = database.prepare(
      "INSERT INTO input_requests (request_id, task_id, status, policy, requester_agent, blocked_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    database.transaction(() => {
      database.exec("DELETE FROM tasks; DELETE FROM roles; DELETE FROM work_items; DELETE FROM input_requests; DELETE FROM metadata;");
      database.prepare("INSERT INTO metadata (key, value) VALUES ('schemaVersion', '1')").run();
      for (const { task, roles, workItems, inputRequests } of snapshot) {
        insertTask.run(task.id, task.title, task.archived ? 1 : 0, task.updatedAt);
        for (const role of roles) {
          insertRole.run(task.id, role.name, role.agent, role.status, role.workspace);
        }
        for (const workItem of workItems) {
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
        for (const request of inputRequests) {
          insertInputRequest.run(
            request.id,
            request.taskId,
            request.status,
            request.resolutionPolicy.mode,
            request.requester.agentId,
            request.blockedRefs.length,
            request.createdAt,
            request.updatedAt
          );
        }
      }
    })();
  } finally {
    database.close();
  }
}
