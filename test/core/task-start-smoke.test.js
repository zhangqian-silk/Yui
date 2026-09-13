import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { submitOperatorMessage } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { buildRunContextPack } from "../../dist/context/runContextPack.js";
import { requestTaskActivation } from "../../dist/task/taskActivationService.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { completeTask } from "../../dist/task/task.js";

test("a scratch Task preserves Operator intent through planning, activation and workspace release", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-task-start-smoke-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const now = new Date("2026-09-09T00:00:00Z");
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "codex", [], [], now));
  store.saveGlobalRole(createGlobalRole("leader", [binding], "codex", workspace, now));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "codex", defaultWorkspace: workspace });
  submitOperatorMessage("Produce the requested result and preserve its evidence.", undefined, store, { now: () => now });
  const task = store.getTask("task-1");
  assert.equal(task.status, "draft");
  assert.equal(store.getTaskWorkspace(task.id), null);
  const scheduler = new FileSchedulerStoreAdapter(store);
  assert.equal(scheduler.prepareDraftPlanning(task.id, now), true);
  const run = store.getActiveRun(task.id, "leader");
  const pack = buildRunContextPack(store, task.id, run.id);
  assert.equal(run.purpose, "planning");
  assert.deepEqual(pack.authority.writableProjectIds, []);
  assert.ok(pack.pointers.some(ref => ref.store === "task-message"));
  requestTaskActivation(store, {
    taskId: task.id, requestId: "begin", actorId: `task:${task.id}/role:leader`,
    authorityRef: "core-smoke", environmentPlan: { kind: "scratch" }, callerRunId: run.id
  }, now);
  store.transaction(tx => terminalizeExactTaskRun(tx, {
    taskId: task.id, roleName: "leader", agentId: "codex", runId: run.id,
    outcome: { status: "completed", output: "Planning captured; delivery requested." }
  }, now));
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => now);
  await preparer.activateTaskWorkspace(task.id);
  assert.equal(store.getTask(task.id).status, "active");
  assert.equal(store.getTask(task.id).activationRequest.disposition, "adopted");
  assert.equal(store.getRun(task.id, run.id).effective.executionAuthority, "planning");
  assert.equal(store.listMessages(task.id)[0].body, "Produce the requested result and preserve its evidence.");
  assert.ok(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" })?.pending);
  const active = store.getTask(task.id);
  const scratch = store.getTaskWorkspace(task.id);
  assert.equal(active.workspaceIdentity, undefined, "Scratch environments do not fabricate a Git identity.");
  assert.deepEqual(scratch.entries, []);
  assert.equal(await preparer.inspectTaskMainWorkspace(task.id), "missing");
  store.saveTask(completeTask(active, now, { by: "user", summary: "Scratch work accepted" }));
  assert.equal((await preparer.cleanupTaskForArchive(task.id, "abandoned")).status, "removed");
  assert.equal(store.getTaskWorkspace(task.id), null);
  assert.equal(existsSync(scratch.root), false);
  assert.equal(store.listMessages(task.id)[0].body, "Produce the requested result and preserve its evidence.");
});
