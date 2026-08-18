import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runConfigCommand } from "../../dist/commands/configCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-next-action-"));
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
    const projectPath = join(root, "one");
    mkdirSync(projectPath, { recursive: true });
    tx.saveProject(createProject(
      "project-1", "one", projectPath, { stable: "main", development: "main" }, NOW
    ));
  });
  runTaskCommand(
    ["create", "delivery", "--project", "project-1", "--require-integration"],
    store,
    { now: () => NOW }
  );
  runTaskCommand(["activate", "task-1"], store, { now: () => NOW });
  return { store, root };
}

function outputOf(execution) {
  if (execution.kind !== "output") {
    throw new Error(`expected output execution, got ${execution.kind}`);
  }
  return execution.output;
}

test("task next-action renders the single protocol action with exact refs", () => {
  const { store } = fixture(test);
  const output = outputOf(runTaskCommand(["next-action", "task-1"], store));
  assert.ok(output.includes("Next action: implement-current-work-item"), output);
  assert.ok(output.includes("Recommended: yui task work create task-1"), output);
  assert.ok(output.includes("Preconditions:"), output);
});

test("task next-action --json returns the structured projection", () => {
  const { store } = fixture(test);
  const execution = runTaskCommand(["next-action", "task-1", "--json"], store);
  assert.equal(execution.kind, "output");
  assert.equal(execution.data.action.kind, "implement-current-work-item");
  assert.equal(execution.data.action.taskId, "task-1");
  assert.ok(execution.data.action.fingerprint.length > 0);
});

test("task context shows the next-action section on the first screen", () => {
  const { store } = fixture(test);
  const output = outputOf(runTaskCommand(["context", "task-1"], store));
  assert.ok(output.includes("Next action:"), output);
  assert.ok(output.includes("implement-current-work-item"), output);
});

test("guard in enforce mode blocks an identical duplicate Work Item", () => {
  const { store } = fixture(test);
  runConfigCommand(["leader-next-action", "set", "enforce"], store);
  const first = outputOf(runTaskCommand(
    ["work", "create", "task-1", "change the parser", "--accept", "parser handles X"],
    store,
    { now: () => NOW }
  ));
  assert.ok(first.includes("Created work item work-item-1"), first);
  assert.throws(
    () => runTaskCommand(
      ["work", "create", "task-1", "change the parser", "--accept", "parser handles X"],
      store,
      { now: () => NOW }
    ),
    /Exact duplicate/
  );
  // The blocked mutation created no new records.
  assert.equal(store.listWorkItems("task-1").length, 1);
});

test("guard in warn mode lets the duplicate through with a warning", () => {
  const { store } = fixture(test);
  runConfigCommand(["leader-next-action", "set", "warn"], store);
  outputOf(runTaskCommand(
    ["work", "create", "task-1", "change the parser", "--accept", "parser handles X"],
    store,
    { now: () => NOW }
  ));
  const second = outputOf(runTaskCommand(
    ["work", "create", "task-1", "change the parser", "--accept", "parser handles X"],
    store,
    { now: () => NOW }
  ));
  assert.ok(second.includes("Warning: Exact duplicate"), second);
  assert.ok(second.includes("Created work item work-item-2"), second);
  assert.equal(store.listWorkItems("task-1").length, 2);
});

test("guard in display mode (default) does not interfere with mutations", () => {
  const { store } = fixture(test);
  const first = outputOf(runTaskCommand(
    ["work", "create", "task-1", "change the parser", "--accept", "parser handles X"],
    store,
    { now: () => NOW }
  ));
  assert.ok(!first.includes("Warning"), first);
  assert.equal(runConfigCommand(["leader-next-action", "show"], store).trim(), "Leader next-action mode: display");
});
