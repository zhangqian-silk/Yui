import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { projectWorkItemExecution } from "../../dist/execution/workItemExecutionProjection.js";
import { createProject } from "../../dist/repository/project.js";
import { snapshotWorkItemCandidate } from "../../dist/repository/workItemCandidateSnapshot.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

const now = new Date("2026-09-12T00:00:00.000Z");

test("direct ownership is actionable without dispatch and preserves managed assignments", () => {
  const task = activateTask(createTask("task-1", "One coherent outcome", now), now);
  const item = createWorkItem("work-item-1", task.id, { title: "Independent acceptance" }, now);
  const facts = {
    task, workItems: [item], changeSets: [], integrations: [],
    reviewRounds: [], reviewConfig: null, openInputRequests: [], activeRuns: [], leaderRuns: []
  };
  assert.equal(projectWorkItemExecution(item, []).nextAction.kind, "execute-directly");
  assert.equal(projectNextAction(facts).recommendedCommand,
    "yui task work update task-1/work-item-1 running");
  for (const assignee of ["worker", "leader"]) {
    const managed = { ...item, assignee };
    assert.equal(projectWorkItemExecution(managed, []).nextAction.kind, "dispatch-work");
    assert.equal(projectNextAction({ ...facts, workItems: [managed] }).recommendedCommand,
      "yui task work dispatch task-1/work-item-1");
  }
});

test("a read-only direct Candidate needs no Git workspace or AgentRun; writable work still does", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-direct-work-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveProject(createProject("project-1", "lab", join(home, "reference"),
    { stable: "main", development: "main" }, now));
  const task = activateTask(createTask("task-1", "Bounded direct delivery", now, {
    projectBindings: [{ projectId: "project-1", directory: "lab", baseRef: "main" }]
  }), now);
  store.saveTask(task);
  const item = createWorkItem("work-item-1", task.id, { title: "Read-only finding" }, now);
  store.saveWorkItem(task.id, item);
  const noGit = {
    snapshotCandidateWorkspace() { assert.fail("read-only work must not require Git"); },
    snapshotDirectTaskMain() { assert.fail("read-only work must not require Task main"); }
  };
  const snapshots = await snapshotWorkItemCandidate(store, noGit, task.id, item.id);
  assert.deepEqual(snapshots, {});
  const result = runTaskCommand(
    ["work", "update", "task-1/work-item-1", "done", "--summary", "Finding with evidence"],
    store, { environment: {}, ...snapshots }
  );
  assert.equal(result.data.workItem.candidates[0].source.type, "direct");
  runTaskCommand(["work", "accept", "task-1/work-item-1", "--summary", "Evidence inspected"],
    store, { environment: {} });
  assert.equal(store.getWorkItem(task.id, item.id).status, "accepted");
  assert.deepEqual(store.listRuns(task.id), []);
  assert.deepEqual(store.listManagedWorkspaces(task.id), []);

  const writable = createWorkItem("work-item-2", task.id,
    { title: "Code result", writeProjectIds: ["project-1"] }, now);
  store.saveWorkItem(task.id, writable);
  await assert.rejects(
    snapshotWorkItemCandidate(store, noGit, task.id, writable.id),
    /isolate/u
  );
});
