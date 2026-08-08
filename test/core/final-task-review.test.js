import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createIntegrationAttempt, updateIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { createProject } from "../../dist/repository/project.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { finishReviewRound } from "../../dist/review/reviewRound.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { submitWorkItemCandidate, updateWorkItemStatus } from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-08-08T00:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-final-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: codex.id,
      defaultWorkspace: root,
      review: { roleName: "reviewer", trigger: "final" }
    });
    tx.saveConfiguredAgent(codex);
    tx.saveGlobalRole(createGlobalRole(
      "leader", [createRoleAgentBinding(codex)], codex.id, root, NOW
    ));
    tx.saveGlobalRole(createGlobalRole(
      "reviewer", [createRoleAgentBinding(codex)], codex.id, root, NOW
    ));
    for (const [id, name] of [["project-1", "one"], ["project-2", "two"]]) {
      const projectPath = join(root, name);
      mkdirSync(projectPath, { recursive: true });
      tx.saveProject(createProject(id, name, projectPath, { stable: "main", development: "main" }, NOW));
    }
  });
  runTaskCommand([
    "create", "delivery", "--project", "project-1", "--project", "project-2",
    "--require-integration"
  ], store, { now: () => NOW });
  const task = store.getTask("task-1");
  runTaskCommand(["activate", task.id], store, { now: () => NOW });
  runTaskCommand(["work", "create", task.id, "change"], store, { now: () => NOW });
  const item = store.getWorkItem(task.id, "work-item-1");
  const leaderOptions = {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  runTaskCommand(["work", "update", item.id, "running"], store, leaderOptions);
  store.transaction((tx) => {
    const running = tx.getWorkItem(task.id, item.id);
    const candidate = submitWorkItemCandidate(running, {
      summary: "integrated candidate",
      source: { type: "direct" }
    }, NOW);
    tx.saveWorkItem(task.id, candidate);
    tx.saveWorkItem(task.id, updateWorkItemStatus(candidate, "completed", NOW, "accepted"));
    for (const [index, projectId] of ["project-1", "project-2"].entries()) {
      const baseCommit = String.fromCharCode(97 + index).repeat(40);
      const headCommit = String.fromCharCode(99 + index).repeat(40);
      const changeSetId = `change-set-${index + 1}`;
      tx.saveChangeSet(task.id, createWorkItemChangeSet({
        id: changeSetId,
        taskId: task.id,
        projectId,
        workItemId: item.id,
        baseCommit,
        headCommit,
        branch: `yui/task-11/work-item-1-${index + 1}`,
        changedPaths: [`${projectId}/change.ts`]
      }, NOW));
      const attempt = createIntegrationAttempt({
        id: `integration-${index + 1}`,
        taskId: task.id,
        projectId,
        targetRef: `yui/task-11/main-${index + 1}`,
        expectedHead: baseCommit,
        changeSetIds: [changeSetId],
        checkCommands: []
      }, NOW);
      tx.saveIntegrationAttempt(task.id, updateIntegrationAttempt(
        attempt, { status: "committed", candidateCommit: headCommit }, NOW
      ));
    }
  });
  return { store, task, item, leaderOptions };
}

test("final policy queues one Task Review over all committed Project heads", (t) => {
  const { store, task, item, leaderOptions } = fixture(t);
  const first = runTaskCommand(
    ["complete", task.id, "--summary", "finish"], store, leaderOptions
  );
  assert.equal(first.kind, "output");
  assert.match(first.output, /Final Task Review requested/);
  const rounds = store.listReviewRounds(task.id);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].scope, "task");
  assert.deepEqual(rounds[0].taskCandidate.projects.map(({ projectId }) => projectId), [
    "project-1", "project-2"
  ]);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.at(-1).reviewPolicy, undefined);
  assert.equal(store.getTask(task.id).status, "active");
  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions),
    /Final Task Review is still active/
  );
});

test("a changed integrated head creates a fresh final ReviewRound and keeps prior evidence", (t) => {
  const { store, task, item, leaderOptions } = fixture(t);
  runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions);
  const first = store.listReviewRounds(task.id)[0];
  store.saveReviewRound(task.id, finishReviewRound(first, "failed", "reviewer unavailable", NOW));
  store.transaction((tx) => {
    const baseCommit = "d".repeat(40);
    const headCommit = "e".repeat(40);
    tx.saveChangeSet(task.id, createWorkItemChangeSet({
      id: "change-set-3",
      taskId: task.id,
      projectId: "project-2",
      workItemId: item.id,
      baseCommit,
      headCommit,
      branch: "yui/task-11/work-item-2",
      changedPaths: ["project-2/fix.ts"]
    }, NOW));
    const attempt = createIntegrationAttempt({
      id: "integration-3",
      taskId: task.id,
      projectId: "project-2",
      targetRef: "yui/task-11/main-2",
      expectedHead: baseCommit,
      changeSetIds: ["change-set-3"],
      checkCommands: []
    }, NOW);
    tx.saveIntegrationAttempt(task.id, updateIntegrationAttempt(
      attempt, { status: "committed", candidateCommit: headCommit }, NOW
    ));
  });
  runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions);
  const rounds = store.listReviewRounds(task.id);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].status, "failed");
  assert.equal(rounds[1].status, "pending");
  assert.notDeepEqual(rounds[0].taskCandidate, rounds[1].taskCandidate);
});

test("an unchanged failed final ReviewRound does not duplicate or unblock completion", (t) => {
  const { store, task, leaderOptions } = fixture(t);
  runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions);
  const first = store.listReviewRounds(task.id)[0];
  store.saveReviewRound(task.id, finishReviewRound(first, "failed", "reviewer unavailable", NOW));

  const second = runTaskCommand(
    ["complete", task.id, "--summary", "finish again"],
    store,
    leaderOptions
  );

  assert.equal(second.kind, "output");
  assert.match(second.output, /Final Task Review is blocked/);
  assert.equal(store.listReviewRounds(task.id).length, 1);
  assert.equal(store.getTask(task.id).status, "active");
});
