import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runAgentCommand } from "../../dist/commands/agentCommands.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding,
  unbindRoleAgent
} from "../../dist/role/role.js";
import {
  createRoleSessionSet
} from "../../dist/executor/agentExecutor.js";
import { recordRoleAgentSession } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-07-24T05:00:00.000Z");
const LATER = new Date("2026-07-24T05:01:00.000Z");

function binding(agentId, adapterId = agentId) {
  return { agentId, adapterId, config: { adapterId } };
}

function roleSessions(owner, status) {
  let sessions = createRoleSessionSet(owner, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-dormant",
    policy: "fixed",
    status
  }, NOW);
  return { ...sessions, activeAgentId: "codex" };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-role-unbind-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], NOW);
  const bindings = [
    createRoleAgentBinding(codex),
    createRoleAgentBinding(claude)
  ];
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: codex.id,
      defaultWorkspace: root
    });
    tx.saveConfiguredAgent(codex);
    tx.saveConfiguredAgent(claude);
    tx.saveGlobalRole(createGlobalRole(
      "operator", bindings, codex.id, root, NOW
    ));
    tx.saveGlobalRole(createGlobalRole(
      "leader", bindings, codex.id, root, NOW
    ));
  });
  const options = { now: () => new Date(NOW), yuiHome: root };
  const created = runTaskCommand(["create", "Unbind dormant Agents"], store, options);
  assert.equal(created.kind, "output");
  return { root, store, options, task: store.listTasks()[0] };
}

function observeTransactions(store) {
  const events = [];
  const wrap = (target, insideTransaction) => new Proxy(target, {
    get(object, property) {
      if (property === "transaction" && !insideTransaction) {
        return (execute) => {
          events.push({ method: "transaction", insideTransaction: false });
          return object.transaction((tx) => execute(wrap(tx, true)));
        };
      }
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      return (...args) => {
        events.push({ method: String(property), insideTransaction });
        return value.apply(object, args);
      };
    }
  });
  return { store: wrap(store, false), events };
}

test("Role Agent unbind removes a dormant binding and its stopped session immutably", () => {
  const role = createRole(
    "task-1",
    "leader",
    [binding("codex"), binding("claude")],
    "codex",
    "/repo",
    NOW
  );
  const sessions = roleSessions({
    scope: "task",
    taskId: role.taskId,
    roleName: role.name
  }, "stopped");

  const result = unbindRoleAgent(role, sessions, "claude", LATER);

  assert.deepEqual(Object.keys(result.role.agentBindings), ["codex"]);
  assert.equal(result.sessions?.sessions.claude, undefined);
  assert.equal(result.sessions?.activeAgentId, "codex");
  assert.equal(result.role.updatedAt, LATER.toISOString());
  assert.equal(result.sessions?.updatedAt, LATER.toISOString());
  assert.ok(Object.hasOwn(role.agentBindings, "claude"));
  assert.ok(Object.hasOwn(sessions.sessions, "claude"));
});

test("Role Agent unbind accepts no dormant session but rejects active, missing, and non-stopped bindings", () => {
  const role = createGlobalRole(
    "operator",
    [binding("codex"), binding("claude")],
    "codex",
    "/repo",
    NOW
  );

  const withoutSessions = unbindRoleAgent(role, null, "claude", LATER);
  assert.deepEqual(Object.keys(withoutSessions.role.agentBindings), ["codex"]);
  assert.equal(withoutSessions.sessions, null);
  assert.throws(
    () => unbindRoleAgent(role, null, "codex", LATER),
    /active Role Agent/i
  );
  assert.throws(
    () => unbindRoleAgent(role, null, "missing", LATER),
    /not bound/i
  );

  for (const status of ["reserved", "ready", "running", "broken"]) {
    const sessions = roleSessions({
      scope: "global",
      roleName: role.name
    }, status);
    assert.throws(
      () => unbindRoleAgent(role, sessions, "claude", LATER),
      new RegExp(`native session.*${status}`, "i")
    );
    assert.ok(Object.hasOwn(role.agentBindings, "claude"));
    assert.equal(sessions.sessions.claude.status, status);
  }
});

test("Global system Roles and the Task Leader unbind stopped dormant sessions before Agent removal", (t) => {
  const { store, options, task } = fixture(t);
  store.saveGlobalRoleSessionSet(roleSessions({
    scope: "global",
    roleName: "operator"
  }, "stopped"));
  store.saveTaskRoleSessionSet(roleSessions({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }, "stopped"));

  assert.match(
    runGlobalRoleCommand(["unbind", "operator", "claude"], store, options),
    /Unbound.*claude.*operator/i
  );
  assert.match(
    runGlobalRoleCommand(["unbind", "leader", "claude"], store, options),
    /Unbound.*claude.*leader/i
  );
  const taskResult = runTaskCommand([
    "role", "unbind", task.id, "leader", "claude"
  ], store, options);
  assert.equal(taskResult.kind, "output");
  assert.match(taskResult.output, /Unbound.*claude.*leader/i);

  assert.equal(store.getGlobalRole("operator").agentBindings.claude, undefined);
  assert.equal(store.getGlobalRoleSessionSet("operator").sessions.claude, undefined);
  assert.equal(store.getGlobalRole("leader").agentBindings.claude, undefined);
  assert.equal(store.getRole(task.id, "leader").agentBindings.claude, undefined);
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader").sessions.claude, undefined);
  assert.match(runAgentCommand(["remove", "claude"], store), /Removed agent claude/);
  assert.equal(store.getConfiguredAgent("claude"), null);
});

test("Role unbind commands reject active, missing, and every non-stopped dormant session", (t) => {
  const { store, options, task } = fixture(t);

  for (const command of [
    () => runGlobalRoleCommand(["unbind", "operator", "codex"], store, options),
    () => runTaskCommand(["role", "unbind", task.id, "leader", "codex"], store, options)
  ]) {
    assert.throws(command, /active Role Agent/i);
  }
  for (const command of [
    () => runGlobalRoleCommand(["unbind", "operator", "missing"], store, options),
    () => runTaskCommand(["role", "unbind", task.id, "leader", "missing"], store, options)
  ]) {
    assert.throws(command, /not bound/i);
  }

  for (const status of ["reserved", "ready", "running", "broken"]) {
    store.saveGlobalRoleSessionSet(roleSessions({
      scope: "global",
      roleName: "operator"
    }, status));
    store.saveTaskRoleSessionSet(roleSessions({
      scope: "task",
      taskId: task.id,
      roleName: "leader"
    }, status));
    assert.throws(
      () => runGlobalRoleCommand(["unbind", "operator", "claude"], store, options),
      new RegExp(`native session.*${status}`, "i")
    );
    assert.throws(
      () => runTaskCommand([
        "role", "unbind", task.id, "leader", "claude"
      ], store, options),
      new RegExp(`native session.*${status}`, "i")
    );
    assert.ok(Object.hasOwn(store.getGlobalRole("operator").agentBindings, "claude"));
    assert.ok(Object.hasOwn(store.getRole(task.id, "leader").agentBindings, "claude"));
  }
});

test("Global and Task Role unbind perform their Role/session cleanup in one transaction", (t) => {
  const { store, options, task } = fixture(t);
  store.saveGlobalRoleSessionSet(roleSessions({
    scope: "global",
    roleName: "operator"
  }, "stopped"));
  store.saveTaskRoleSessionSet(roleSessions({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }, "stopped"));

  const global = observeTransactions(store);
  runGlobalRoleCommand(["unbind", "operator", "claude"], global.store, options);
  assert.equal(
    global.events.filter(({ method }) => method === "transaction").length,
    1
  );
  for (const method of [
    "getGlobalRole",
    "getGlobalRoleSessionSet",
    "saveGlobalRoleWithSessionSet"
  ]) {
    assert.ok(global.events.some((event) =>
      event.method === method && event.insideTransaction), method);
  }

  const taskObserved = observeTransactions(store);
  runTaskCommand([
    "role", "unbind", task.id, "leader", "claude"
  ], taskObserved.store, options);
  assert.equal(
    taskObserved.events.filter(({ method }) => method === "transaction").length,
    1
  );
  for (const method of [
    "getTask",
    "getRole",
    "getTaskRoleSessionSet",
    "saveTaskRoleWithSessionSet"
  ]) {
    assert.ok(taskObserved.events.some((event) =>
      event.method === method && event.insideTransaction), method);
  }
});

test("Global Role add, bind, and remove keep dependent reads and writes transactional", (t) => {
  const { store, options } = fixture(t);

  const added = observeTransactions(store);
  runGlobalRoleCommand([
    "add", "reviewer", "--agent", "codex"
  ], added.store, options);
  assert.equal(added.events.filter(({ method }) => method === "transaction").length, 1);
  for (const method of [
    "getWorkMailbox",
    "getConfiguredAgent",
    "getConfig",
    "createGlobalRoleIfAbsent"
  ]) {
    assert.ok(added.events.some((event) =>
      event.method === method && event.insideTransaction), method);
  }

  const bound = observeTransactions(store);
  runGlobalRoleCommand(["bind", "reviewer", "claude"], bound.store, options);
  assert.equal(bound.events.filter(({ method }) => method === "transaction").length, 1);
  for (const method of [
    "getGlobalRole",
    "getWorkMailbox",
    "getConfiguredAgent",
    "getGlobalRoleSessionSet",
    "saveGlobalRoleWithSessionSet"
  ]) {
    assert.ok(bound.events.some((event) =>
      event.method === method && event.insideTransaction), method);
  }

  const removed = observeTransactions(store);
  runGlobalRoleCommand(["remove", "reviewer"], removed.store, options);
  assert.equal(removed.events.filter(({ method }) => method === "transaction").length, 1);
  for (const method of [
    "getGlobalRole",
    "getWorkMailbox",
    "getGlobalRoleSessionSet",
    "removeGlobalRole"
  ]) {
    assert.ok(removed.events.some((event) =>
      event.method === method && event.insideTransaction), method);
  }
});
