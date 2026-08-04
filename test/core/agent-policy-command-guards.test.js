import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createConfiguredAgent
} from "../../dist/agent/agent.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import {
  runAgentCommand
} from "../../dist/commands/agentCommands.js";
import {
  claimPending,
  createWorkMailbox,
  enqueueSignal
} from "../../dist/coordination/workMailbox.js";
import {
  createRoleSessionSet
} from "../../dist/executor/agentExecutor.js";
import { recordRoleAgentSession } from "../helpers/effectiveLaunch.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_LAUNCH_RESERVED_REASON,
  RUNTIME_LIFECYCLE_OWNER,
  runtimeLifecycleTarget
} from "../../dist/runtime/lifecycleReservation.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { createTask } from "../../dist/task/task.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-07-24T04:00:00.000Z");

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "yui-agent-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const primary = createConfiguredAgent(
    "primary",
    "codex",
    "codex",
    ["--verbose", "main"],
    [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "PRIMARY_OPENAI_API_KEY",
      required: true
    }],
    NOW
  );
  const secondary = createConfiguredAgent(
    "secondary",
    "codex",
    "codex",
    [],
    [],
    NOW
  );
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      ...(options.defaultAgent === undefined
        ? {}
        : { defaultAgent: options.defaultAgent })
    });
    tx.saveConfiguredAgent(primary);
    tx.saveConfiguredAgent(secondary);
  });
  return { root, store, primary, secondary };
}

function saveGlobalRole(store, agents, activeAgentId = agents[0].id, name = "operator") {
  const role = createGlobalRole(
    name,
    agents.map((agent) => createRoleAgentBinding(agent)),
    activeAgentId,
    store.rootDirectory(),
    NOW
  );
  store.saveGlobalRole(role);
  return role;
}

function saveTaskRole(store, agents, activeAgentId = agents[0].id, name = "leader") {
  const task = createTask(store.nextTaskId(), `Task for ${name}`, NOW);
  const role = createRole(
    task.id,
    name,
    agents.map((agent) => createRoleAgentBinding(agent)),
    activeAgentId,
    store.rootDirectory(),
    NOW
  );
  store.transaction((tx) => {
    tx.saveTask(task);
    tx.saveRole(task.id, role);
  });
  return { task, role };
}

function sessionSet(owner, agent, status) {
  return recordRoleAgentSession(
    createRoleSessionSet(owner, agent.id, NOW),
    {
      agentId: agent.id,
      adapterId: agent.adapterId,
      nativeSessionId: `native-${owner.roleName}`,
      policy: "fixed",
      status
    },
    NOW
  );
}

function lifecycleMailbox(owner, state) {
  const reason = state === "reserved"
    ? RUNTIME_LAUNCH_RESERVED_REASON
    : RUNTIME_CLEANUP_REQUIRED_REASON;
  const queued = enqueueSignal(createWorkMailbox(runtimeLifecycleTarget(owner)), {
    reason,
    refs: [],
    occurredAt: NOW.toISOString()
  });
  return state === "reserved"
    ? claimPending(queued, {
        batchId: `launch-${owner.roleName}`,
        owner: RUNTIME_LIFECYCLE_OWNER,
        startedAt: NOW.toISOString()
      })
    : queued;
}

function storedAgent(store, id = "primary") {
  const agent = store.getConfiguredAgent(id);
  assert.notEqual(agent, null);
  return agent;
}

test("Agent update rejects a real change used by an active Global Role session without persisting", (t) => {
  const { store, primary } = fixture(t);
  const role = saveGlobalRole(store, [primary]);
  store.saveGlobalRoleSessionSet(sessionSet({
    scope: "global",
    roleName: role.name
  }, primary, "ready"));
  const before = storedAgent(store);

  for (const command of [
    ["update", primary.id, "--command", "codex-next"],
    ["update", primary.id, "--clear-args"],
    ["update", primary.id, "--clear-env"],
    ["update", primary.id, "--adapter", "claude"]
  ]) {
    assert.throws(
      () => runAgentCommand(command, store),
      (error) => error?.code === "USAGE_ERROR"
        && /Global Role operator/u.test(error.message)
        && /active|stop/u.test(error.message)
    );
    assert.deepEqual(storedAgent(store), before);
  }
});

test("Agent update rejects a real change used by an active Task Role session without persisting", (t) => {
  const { store, primary } = fixture(t);
  const { task, role } = saveTaskRole(store, [primary]);
  store.saveTaskRoleSessionSet(sessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, primary, "running"));
  const before = storedAgent(store);

  assert.throws(
    () => runAgentCommand(["update", primary.id, "--clear-env"], store),
    (error) => error?.code === "USAGE_ERROR"
      && new RegExp(`Task ${task.id} Role ${role.name}`, "u").test(error.message)
      && /active|stop/u.test(error.message)
  );
  assert.deepEqual(storedAgent(store), before);
});

test("Agent update rejects dormant live sessions but permits stopped sessions", (t) => {
  const { store, primary, secondary } = fixture(t);
  const globalRole = saveGlobalRole(
    store,
    [primary, secondary],
    secondary.id,
    "reviewer"
  );
  const owner = {
    scope: "global",
    roleName: globalRole.name
  };
  const sessions = recordRoleAgentSession(
    sessionSet(owner, secondary, "ready"),
    {
      agentId: primary.id,
      adapterId: primary.adapterId,
      nativeSessionId: "native-dormant-primary",
      policy: "fixed",
      status: "ready"
    },
    NOW
  );
  store.saveGlobalRoleSessionSet(sessions);

  const beforeDormant = storedAgent(store);
  assert.throws(
    () => runAgentCommand(["update", primary.id, "--command", "codex-next"], store),
    (error) => error?.code === "USAGE_ERROR"
      && /Global Role reviewer/u.test(error.message)
      && /non-stopped|stop/u.test(error.message)
  );
  assert.deepEqual(storedAgent(store), beforeDormant);

  store.saveGlobalRoleSessionSet(recordRoleAgentSession(
    sessions,
    {
      agentId: primary.id,
      adapterId: primary.adapterId,
      nativeSessionId: "native-dormant-primary",
      policy: "fixed",
      status: "stopped"
    },
    NOW
  ));
  assert.match(
    runAgentCommand(["update", primary.id, "--command", "codex-next"], store),
    /Updated agent primary/u
  );
  assert.equal(storedAgent(store).command, "codex-next");

  const { task, role } = saveTaskRole(store, [primary]);
  store.saveTaskRoleSessionSet(sessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, primary, "stopped"));
  assert.match(
    runAgentCommand(["update", primary.id, "--clear-args"], store),
    /Updated agent primary/u
  );
  assert.deepEqual(storedAgent(store).baseArgs, []);

  const beforeAdapter = storedAgent(store);
  assert.throws(
    () => runAgentCommand(["update", primary.id, "--adapter", "claude"], store),
    (error) => error?.code === "USAGE_ERROR"
      && /Global Role reviewer/u.test(error.message)
      && /new Agent ID|bind/u.test(error.message)
  );
  assert.deepEqual(storedAgent(store), beforeAdapter);
});

test("Agent update treats identical settings as unchanged despite an active session and binding", (t) => {
  const { store, primary } = fixture(t);
  const role = saveGlobalRole(store, [primary]);
  store.saveGlobalRoleSessionSet(sessionSet({
    scope: "global",
    roleName: role.name
  }, primary, "running"));
  const before = storedAgent(store);

  assert.equal(
    runAgentCommand([
      "update",
      primary.id,
      "--adapter",
      "codex",
      "--command",
      "codex",
      "--arg",
      "--verbose",
      "--arg",
      "main",
      "--env",
      "OPENAI_API_KEY=PRIMARY_OPENAI_API_KEY"
    ], store),
    "Agent primary unchanged\n"
  );
  assert.deepEqual(storedAgent(store), before);
});

test("Agent update and remove reject a Global Role launch reservation before native session registration", (t) => {
  const { store, primary } = fixture(t);
  const role = saveGlobalRole(store, [primary]);
  store.saveWorkMailbox(lifecycleMailbox({
    scope: "global",
    roleName: role.name
  }, "reserved"));
  const before = storedAgent(store);

  assert.throws(
    () => runAgentCommand(["update", primary.id, "--command", "codex-next"], store),
    (error) => error?.code === "USAGE_ERROR"
      && /Global Role operator/u.test(error.message)
      && /lifecycle|launch|cleanup/iu.test(error.message)
  );
  assert.deepEqual(storedAgent(store), before);

  assert.throws(
    () => runAgentCommand(["remove", primary.id], store),
    (error) => error?.code === "USAGE_ERROR"
      && /Global Role operator/u.test(error.message)
      && /lifecycle|launch|cleanup/iu.test(error.message)
  );
  assert.deepEqual(storedAgent(store), before);
});

test("Agent update and remove reject pending Task Role runtime cleanup", (t) => {
  const { store, primary } = fixture(t);
  const { task, role } = saveTaskRole(store, [primary]);
  store.saveWorkMailbox(lifecycleMailbox({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, "cleanup"));
  const before = storedAgent(store);

  for (const command of [
    ["update", primary.id, "--clear-env"],
    ["remove", primary.id]
  ]) {
    assert.throws(
      () => runAgentCommand(command, store),
      (error) => error?.code === "USAGE_ERROR"
        && new RegExp(`Task ${task.id} Role ${role.name}`, "u").test(error.message)
        && /lifecycle|launch|cleanup/iu.test(error.message)
    );
    assert.deepEqual(storedAgent(store), before);
  }
});

test("adapter changes are rejected for both Global and Task Role bindings, even when inactive", async (t) => {
  await t.test("Global Role binding", (t) => {
    const { store, primary, secondary } = fixture(t);
    saveGlobalRole(store, [primary, secondary], secondary.id, "reviewer");
    const before = storedAgent(store);

    assert.throws(
      () => runAgentCommand(["update", primary.id, "--adapter", "claude"], store),
      (error) => error?.code === "USAGE_ERROR"
        && /Global Role reviewer/u.test(error.message)
    );
    assert.deepEqual(storedAgent(store), before);
  });

  await t.test("Task Role binding", (t) => {
    const { store, primary, secondary } = fixture(t);
    const { task, role } = saveTaskRole(store, [primary, secondary], secondary.id);
    const before = storedAgent(store);

    assert.throws(
      () => runAgentCommand(["update", primary.id, "--adapter", "claude"], store),
      (error) => error?.code === "USAGE_ERROR"
        && new RegExp(`Task ${task.id} Role ${role.name}`, "u").test(error.message)
    );
    assert.deepEqual(storedAgent(store), before);
  });
});

test("Agent update reports an invalid candidate as USAGE_ERROR and rolls the transaction back", (t) => {
  const { store } = fixture(t);
  const incompatible = createConfiguredAgent(
    "incompatible",
    "codex",
    "codex",
    ["--plugin-dir"],
    [],
    NOW
  );
  store.saveConfiguredAgent(incompatible);

  assert.throws(
    () => runAgentCommand([
      "update", incompatible.id, "--adapter", "claude"
    ], store),
    (error) => error?.code === "USAGE_ERROR"
      && /reserved by adapter claude/u.test(error.message)
  );
  assert.deepEqual(store.getConfiguredAgent(incompatible.id), incompatible);
});

test("Agent update permits an adapter change when the Agent has no Role references", (t) => {
  const { store, secondary } = fixture(t);

  assert.match(
    runAgentCommand([
      "update", secondary.id, "--adapter", "claude", "--command", "claude"
    ], store),
    /Updated agent secondary/u
  );
  assert.equal(storedAgent(store, secondary.id).adapterId, "claude");
  assert.equal(storedAgent(store, secondary.id).command, "claude");
});

test("provider-neutral Agent Profiles do not fence Configured Agent changes", (t) => {
  const { store, secondary } = fixture(t);
  store.saveAgentProfile(createAgentProfile({
    id: "reviewer",
    defaultAccess: "read"
  }, NOW));

  assert.match(
    runAgentCommand([
      "update", secondary.id, "--adapter", "claude", "--command", "claude"
    ], store),
    /Updated agent secondary/u
  );
  assert.equal(storedAgent(store, secondary.id).adapterId, "claude");
});

test("Agent remove refuses config and Role references, but removes an unused Agent", async (t) => {
  await t.test("default Agent", (t) => {
    const { store, primary } = fixture(t, { defaultAgent: "primary" });
    assert.throws(
      () => runAgentCommand(["remove", primary.id], store),
      (error) => error?.code === "USAGE_ERROR"
        && /config\.defaultAgent/u.test(error.message)
        && /another default Agent/u.test(error.message)
    );
    assert.notEqual(store.getConfiguredAgent(primary.id), null);
  });

  await t.test("Global Role binding", (t) => {
    const { store, primary } = fixture(t);
    saveGlobalRole(store, [primary]);
    assert.throws(
      () => runAgentCommand(["remove", primary.id], store),
      (error) => error?.code === "USAGE_ERROR"
        && /Global Role operator/u.test(error.message)
        && /remove|recreate|migrate/iu.test(error.message)
    );
    assert.notEqual(store.getConfiguredAgent(primary.id), null);
  });

  await t.test("Task Role binding", (t) => {
    const { store, primary } = fixture(t);
    const { task, role } = saveTaskRole(store, [primary]);
    assert.throws(
      () => runAgentCommand(["remove", primary.id], store),
      (error) => error?.code === "USAGE_ERROR"
        && new RegExp(`Task ${task.id} Role ${role.name}`, "u").test(error.message)
    );
    assert.notEqual(store.getConfiguredAgent(primary.id), null);
  });

  await t.test("unused Agent", (t) => {
    const { store, primary } = fixture(t);
    assert.equal(
      runAgentCommand(["remove", primary.id], store),
      "Removed agent primary\n"
    );
    assert.equal(store.getConfiguredAgent(primary.id), null);
  });
});

test("Agent remove also refuses a non-stopped session reservation without a Role binding", () => {
  const agent = createConfiguredAgent(
    "reserved",
    "codex",
    "codex",
    [],
    [],
    NOW
  );
  let stored = agent;
  let sessions = [sessionSet({
    scope: "global",
    roleName: "orphaned-runtime"
  }, agent, "reserved")];
  const store = {
    transaction(execute) { return execute(this); },
    getConfiguredAgent: () => stored,
    removeConfiguredAgent() {
      stored = null;
      return true;
    },
    getConfig: () => ({}),
    listGlobalRoles: () => [],
    listGlobalRoleSessionSets: () => sessions,
    listTasks: () => [],
    listRoles: () => [],
    listRoleSessionSets: () => []
  };

  assert.throws(
    () => runAgentCommand(["remove", agent.id], store),
    (error) => error?.code === "USAGE_ERROR"
      && /Global Role orphaned-runtime/u.test(error.message)
      && /reserved/u.test(error.message)
  );
  assert.deepEqual(stored, agent);

  sessions = [sessionSet({
    scope: "global",
    roleName: "orphaned-runtime"
  }, agent, "stopped")];
  assert.equal(
    runAgentCommand(["remove", agent.id], store),
    "Removed agent reserved\n"
  );
  assert.equal(stored, null);
});

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

test("Agent reference checks and update execute inside one store transaction", (t) => {
  const { store, primary, secondary } = fixture(t);
  saveGlobalRole(store, [primary]);
  const observed = observeTransactions(store);

  assert.match(
    runAgentCommand(["update", primary.id, "--command", "codex-next"], observed.store),
    /Updated agent primary/u
  );

  assert.equal(
    observed.events.filter(({ method }) => method === "transaction").length,
    1
  );
  for (const method of [
    "getConfiguredAgent",
    "listGlobalRoleSessionSets",
    "listTasks",
    "getWorkMailbox",
    "updateConfiguredAgent"
  ]) {
    assert.ok(
      observed.events.some((event) => event.method === method && event.insideTransaction),
      `${method} should run inside the transaction`
    );
  }
  assert.equal(
    observed.events.some((event) => (
      event.method !== "transaction"
      && event.insideTransaction === false
    )),
    false
  );

  observed.events.length = 0;
  assert.equal(
    runAgentCommand(["remove", secondary.id], observed.store),
    "Removed agent secondary\n"
  );
  assert.equal(
    observed.events.filter(({ method }) => method === "transaction").length,
    1
  );
  for (const method of [
    "getConfiguredAgent",
    "getConfig",
    "listGlobalRoles",
    "listGlobalRoleSessionSets",
    "listTasks",
    "removeConfiguredAgent"
  ]) {
    assert.ok(
      observed.events.some((event) => event.method === method && event.insideTransaction),
      `${method} should run inside the removal transaction`
    );
  }
  assert.equal(
    observed.events.some((event) => (
      event.method !== "transaction"
      && event.insideTransaction === false
    )),
    false
  );
});
