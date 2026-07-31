import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  activateTask,
  archiveTask,
  completeTask,
  createTask
} from "../../dist/task/task.js";

const NOW = new Date("2026-07-21T10:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-knowledge-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const task = activateTask(createTask("task-1", "Knowledge CLI", NOW), NOW);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, createRole(
      task.id,
      "leader",
      [createRoleAgentBinding(agent)],
      agent.id,
      root,
      NOW
    ));
  });
  const runtime = {
    notifyStateChanged() {},
    reconcileTask() {},
    prepareTaskRoleEnter() {}
  };
  return { root, store, runtime };
}

function options(runtime, actor) {
  const environment = actor === "leader"
    ? {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: "task-1",
        YUI_ROLE: "leader"
      }
    : actor === "operator"
      ? { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator" }
      : {};
  return { runtime, now: () => new Date(NOW), environment };
}

function run(args, store, commandOptions) {
  const result = runTaskCommand(args, store, commandOptions);
  assert.equal(result.kind, "output");
  return result;
}

test("Task knowledge writes respect lifecycle, provenance, and Leader self-wake boundaries", (t) => {
  const { store, runtime } = fixture(t);
  const leader = options(runtime, "leader");

  run([
    "brief", "update", "task-1",
    "--objective", "Keep the task model small",
    "--approach", "Keep one Task-level plan and Project-scoped execution evidence",
    "--focus", "Knowledge CLI",
    "--leader-summary", "Implementation in progress"
  ], store, leader);
  assert.equal(store.getTaskBrief("task-1")?.updatedBy, "leader");
  assert.equal(
    store.getTaskBrief("task-1")?.technicalApproach,
    "Keep one Task-level plan and Project-scoped execution evidence"
  );
  assert.equal(store.getPendingWakeup("task-1"), null);

  run([
    "decision", "record", "task-1",
    "--title", "Keep the file store",
    "--rationale", "It is sufficient for one local user"
  ], store, leader);
  assert.equal(store.getPendingWakeup("task-1"), null);

  assert.throws(
    () => run([
      "milestone", "add", "task-1",
      "--title", "Spoofed milestone",
      "--summary", "A normal shell must not claim Leader authorship"
    ], store, options(runtime, "user")),
    /Leader.*Milestone/i
  );
  run([
    "milestone", "add", "task-1",
    "--title", "Knowledge connected",
    "--summary", "The Leader recorded the durable checkpoint"
  ], store, leader);
  assert.equal(store.getPendingWakeup("task-1"), null);

  run(["brief", "update", "task-1", "--focus", "External review"], store, options(runtime, "user"));
  assert.equal(store.getTaskBrief("task-1")?.updatedBy, "user");
  assert.deepEqual(store.getPendingWakeup("task-1")?.reasons, ["brief-updated"]);

  store.clearPendingWakeup("task-1");
  run([
    "decision", "record", "task-1",
    "--title", "Operator decision",
    "--rationale", "The operator supplied new durable direction"
  ], store, options(runtime, "operator"));
  assert.deepEqual(store.getPendingWakeup("task-1")?.reasons, ["decision-recorded"]);

  assert.throws(
    () => run(["brief", "update", "task-1", "--updated-by", "someone"], store, leader),
    /Unsupported option: --updated-by/i
  );

  store.clearPendingWakeup("task-1");
  store.saveTask(completeTask(store.getTask("task-1"), NOW, { by: "leader", summary: "Done" }));
  const activeDecision = store.listDecisions("task-1").find(({ status }) => status === "active");
  for (const command of [
    ["brief", "update", "task-1", "--focus", "Too late"],
    ["decision", "record", "task-1", "--title", "Too late", "--rationale", "Completed"],
    ["decision", "supersede", "task-1", activeDecision.id, "--reason", "Too late"],
    ["milestone", "add", "task-1", "--title", "Too late", "--summary", "Completed"]
  ]) {
    assert.throws(() => run(command, store, leader), /completed.*reopen/i);
  }

  store.saveTask(archiveTask(store.getTask("task-1"), NOW, { by: "leader" }));
  assert.throws(
    () => run(["brief", "update", "task-1", "--focus", "Archived"], store, leader),
    /archived/i
  );
});

test("Task knowledge reads expose structured top-level JSON data", (t) => {
  const { root, store, runtime } = fixture(t);
  const leader = options(runtime, "leader");
  run([
    "brief", "update", "task-1",
    "--objective", "Structured reads",
    "--focus", "JSON",
    "--leader-summary", "Ready"
  ], store, leader);
  run([
    "decision", "record", "task-1",
    "--title", "Use data",
    "--rationale", "Agents should not parse terminal output"
  ], store, leader);
  run([
    "milestone", "add", "task-1",
    "--title", "JSON ready",
    "--summary", "Knowledge records exist"
  ], store, leader);
  const decisionId = store.listDecisions("task-1")[0].id;
  const milestoneId = store.listMilestones("task-1")[0].id;
  const eventId = store.listEvents("task-1").at(-1).id;
  const runCli = (...args) => JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", ...args],
    { encoding: "utf8", env: { ...process.env, YUI_HOME: root } }
  ));

  const reads = [
    ["brief", "show", "task-1"],
    ["decision", "list", "task-1"],
    ["decision", "show", "task-1", decisionId],
    ["milestone", "list", "task-1"],
    ["milestone", "show", "task-1", milestoneId],
    ["event", "list", "task-1"],
    ["event", "show", "task-1", eventId]
  ];
  for (const args of reads) {
    const result = runCli("task", ...args);
    assert.equal(result.ok, true, args.join(" "));
    assert.equal(typeof result.data, "object", args.join(" "));
    assert.equal("output" in result, false, args.join(" "));
  }
});
