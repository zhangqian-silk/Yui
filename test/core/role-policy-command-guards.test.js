import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  createRoleSessionSet,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import {
  claimPending,
  createWorkMailbox,
  enqueueSignal
} from "../../dist/coordination/workMailbox.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_LAUNCH_RESERVED_REASON,
  runtimeLifecycleTarget
} from "../../dist/runtime/lifecycleReservation.js";
import { createAgentRun, recordRoleAgentSession } from "../helpers/effectiveLaunch.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-07-24T04:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-role-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: codex.id,
      defaultWorkspace: root
    });
    tx.saveConfiguredAgent(codex);
    tx.saveConfiguredAgent(claude);
    tx.saveGlobalRole(createGlobalRole(
      "worker",
      [createRoleAgentBinding(codex)],
      codex.id,
      root,
      NOW
    ));
  });
  const options = { now: () => new Date(NOW), yuiHome: root };
  return { root, store, options };
}

function runTask(args, store, options) {
  const result = runTaskCommand(args, store, options);
  assert.equal(result.kind, "output");
  return result.output;
}

function createTask(store, options) {
  runTask(["create", "Guard Role launch policy"], store, options);
  return store.listTasks()[0];
}

function runningSession(owner, agentId = "codex") {
  let sessions = createRoleSessionSet(owner, agentId, NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId,
    adapterId: "codex",
    nativeSessionId: `native-${owner.roleName}`,
    policy: "fixed",
    status: "ready"
  }, NOW);
  return sessions;
}

function dormantSession(owner, status) {
  let sessions = createRoleSessionSet(owner, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: `native-${owner.roleName}-claude`,
    policy: "fixed",
    status
  }, NOW);
  return sessions;
}

function lifecycleMailbox(owner, mode) {
  const target = runtimeLifecycleTarget(owner);
  const reason = mode === "processing"
    ? RUNTIME_LAUNCH_RESERVED_REASON
    : RUNTIME_CLEANUP_REQUIRED_REASON;
  const pending = enqueueSignal(createWorkMailbox(target), {
    reason,
    refs: [],
    occurredAt: NOW.toISOString()
  });
  return mode === "processing"
    ? claimPending(pending, {
        batchId: "launch-1",
        owner: "runtime-lifecycle",
        startedAt: NOW.toISOString()
      })
    : pending;
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

test("Global Role update checks runtime state and saves the Role in one transaction", (t) => {
  const { root, store } = fixture(t);
  const options = { yuiHome: root };
  runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store, options);
  const observed = observeTransactions(store);

  runGlobalRoleCommand([
    "update", "reviewer", "--description", "Review atomically"
  ], observed.store, options);

  assert.equal(
    observed.events.filter(({ method }) => method === "transaction").length,
    1
  );
  assert.deepEqual(
    observed.events.filter(({ method }) => (
      method === "getGlobalRole" || method === "saveGlobalRole"
    )),
    [
      { method: "getGlobalRole", insideTransaction: true },
      { method: "saveGlobalRole", insideTransaction: true }
    ]
  );
  assert.deepEqual(
    observed.events
      .filter(({ method }) => method === "getGlobalRoleSessionSet")
      .map(({ insideTransaction }) => insideTransaction),
    [false]
  );
  assert.ok(observed.events.some(({ method, insideTransaction }) =>
    method === "getWorkMailbox" && insideTransaction));
});

test("Global Role desired launch context changes without mutating a running Session", (t) => {
  const { root, store } = fixture(t);
  const options = { yuiHome: root };
  runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store, options);
  store.saveGlobalRoleSessionSet(runningSession({
    scope: "global",
    roleName: "reviewer"
  }));
  const before = store.getGlobalRole("reviewer");
  const effectiveBefore = structuredClone(
    store.getGlobalRoleSessionSet("reviewer").sessions.codex.effective
  );

  runGlobalRoleCommand([
    "update", "reviewer", "--constraint", "Never write outside the workspace"
  ], store, options);
  runGlobalRoleCommand([
    "update", "reviewer", "--workspace", join(root, "replacement")
  ], store, options);

  const desired = store.getGlobalRole("reviewer");
  const session = store.getGlobalRoleSessionSet("reviewer").sessions.codex;
  assert.equal(desired.launchRevision, before.launchRevision + 2);
  assert.deepEqual(desired.constraints, ["Never write outside the workspace"]);
  assert.equal(desired.workspace, join(root, "replacement"));
  assert.deepEqual(session.effective, effectiveBefore);
  assert.equal(session.status, "ready");
});

test("Task Role desired launch context changes without mutating an active Run or Session", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options);
  const before = store.getRole(task.id, "leader");
  store.saveActiveAgentRun(createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Keep working",
    NOW
  ));

  const runBefore = structuredClone(store.getActiveAgentRun(task.id, "leader"));
  runTaskCommand([
    "role", "update", task.id, "leader", "--system-prompt", "New policy"
  ], store, options);
  assert.equal(store.getRole(task.id, "leader").launchRevision, before.launchRevision + 1);
  assert.equal(store.getRole(task.id, "leader").systemPrompt, "New policy");
  assert.deepEqual(store.getActiveAgentRun(task.id, "leader"), runBefore);

  store.clearActiveAgentRun(task.id, "leader");
  store.saveTaskRoleSessionSet(runningSession({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }));
  const sessionBefore = structuredClone(store.getTaskRoleSessionSet(task.id, "leader"));
  runTaskCommand([
    "role", "update", task.id, "leader", "--responsibility", "New responsibility"
  ], store, options);
  assert.equal(store.getRole(task.id, "leader").launchRevision, before.launchRevision + 2);
  assert.deepEqual(
    store.getTaskRoleSessionSet(task.id, "leader"),
    sessionBefore
  );
});

test("successive desired Agent switches preserve the live Session identity", (t) => {
  const { root, store, options } = fixture(t);
  store.saveConfiguredAgent(createConfiguredAgent(
    "claude-alt",
    "claude",
    "claude-alt",
    [],
    [],
    NOW
  ));

  runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store, { yuiHome: root });
  store.saveGlobalRoleSessionSet(runningSession({
    scope: "global",
    roleName: "reviewer"
  }));
  const globalEffective = structuredClone(
    store.getGlobalRoleSessionSet("reviewer").sessions.codex.effective
  );
  runGlobalRoleCommand(["bind", "reviewer", "claude"], store, { yuiHome: root });
  runGlobalRoleCommand(["bind", "reviewer", "claude-alt"], store, { yuiHome: root });
  assert.equal(store.getGlobalRole("reviewer").activeAgentId, "claude-alt");
  assert.equal(store.getGlobalRoleSessionSet("reviewer").activeAgentId, "codex");
  assert.deepEqual(
    store.getGlobalRoleSessionSet("reviewer").sessions.codex.effective,
    globalEffective
  );

  const task = createTask(store, options);
  store.saveTaskRoleSessionSet(runningSession({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }));
  const taskEffective = structuredClone(
    store.getTaskRoleSessionSet(task.id, "leader").sessions.codex.effective
  );
  runTask(["role", "bind", task.id, "leader", "claude"], store, options);
  runTask(["role", "bind", task.id, "leader", "claude-alt"], store, options);
  assert.equal(store.getRole(task.id, "leader").activeAgentId, "claude-alt");
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader").activeAgentId, "codex");
  assert.deepEqual(
    store.getTaskRoleSessionSet(task.id, "leader").sessions.codex.effective,
    taskEffective
  );
});

test("Role updates are next-launch-only for ready and stopped dormant sessions", (t) => {
  const { root, store, options } = fixture(t);
  runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store, options);
  runGlobalRoleCommand(["bind", "reviewer", "claude"], store, options);
  runGlobalRoleCommand(["bind", "reviewer", "codex"], store, options);
  store.saveGlobalRoleSessionSet(dormantSession({
    scope: "global",
    roleName: "reviewer"
  }, "ready"));

  const readyGlobal = structuredClone(store.getGlobalRoleSessionSet("reviewer"));
  runGlobalRoleCommand([
    "update", "reviewer", "--description", "New shared context"
  ], store, options);
  runGlobalRoleCommand([
    "update", "reviewer", "--agent", "claude", "--model", "claude-next"
  ], store, options);
  assert.deepEqual(store.getGlobalRoleSessionSet("reviewer"), readyGlobal);

  store.saveGlobalRoleSessionSet(dormantSession({
    scope: "global",
    roleName: "reviewer"
  }, "stopped"));
  runGlobalRoleCommand([
    "update", "reviewer", "--agent", "claude", "--model", "claude-next"
  ], store, options);

  const task = createTask(store, options);
  runTask(["role", "bind", task.id, "leader", "claude"], store, options);
  runTask(["role", "bind", task.id, "leader", "codex"], store, options);
  store.saveTaskRoleSessionSet(dormantSession({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }, "ready"));
  const readyTask = structuredClone(store.getTaskRoleSessionSet(task.id, "leader"));
  runTaskCommand([
    "role", "update", task.id, "leader", "--agent", "claude", "--model", "claude-next"
  ], store, options);
  assert.deepEqual(store.getTaskRoleSessionSet(task.id, "leader"), readyTask);
  store.saveTaskRoleSessionSet(dormantSession({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }, "stopped"));
  runTask([
    "role", "update", task.id, "leader", "--agent", "claude", "--model", "claude-next"
  ], store, options);
});

test("Role identity and launch mutations are fenced by lifecycle mailboxes", (t) => {
  const { store, options } = fixture(t);
  runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store, options);
  store.saveWorkMailbox(lifecycleMailbox({
    scope: "global",
    roleName: "reviewer"
  }, "pending"));
  for (const command of [
    ["update", "reviewer", "--description", "blocked"],
    ["bind", "reviewer", "claude"],
    ["remove", "reviewer"]
  ]) {
    assert.throws(
      () => runGlobalRoleCommand(command, store, options),
      /lifecycle transition/i
    );
  }
  store.saveWorkMailbox(lifecycleMailbox({
    scope: "global",
    roleName: "retired"
  }, "pending"));
  assert.throws(
    () => runGlobalRoleCommand(["add", "retired", "--agent", "codex"], store, options),
    /lifecycle transition/i
  );

  runGlobalRoleCommand(["add", "processing", "--agent", "codex"], store, options);
  store.saveWorkMailbox(lifecycleMailbox({
    scope: "global",
    roleName: "processing"
  }, "processing"));
  assert.throws(
    () => runGlobalRoleCommand([
      "update", "processing", "--system-prompt", "blocked"
    ], store, options),
    /lifecycle transition/i
  );

  const task = createTask(store, options);
  runTask(["role", "add", task.id, "reviewer"], store, options);
  store.saveWorkMailbox(lifecycleMailbox({
    scope: "task",
    taskId: task.id,
    roleName: "reviewer"
  }, "pending"));
  for (const command of [
    ["role", "update", task.id, "reviewer", "--description", "blocked"],
    ["role", "bind", task.id, "reviewer", "claude"],
    ["role", "remove", task.id, "reviewer"]
  ]) {
    assert.throws(
      () => runTaskCommand(command, store, options),
      /lifecycle transition/i
    );
  }
  store.saveWorkMailbox(lifecycleMailbox({
    scope: "task",
    taskId: task.id,
    roleName: "retired"
  }, "pending"));
  assert.throws(
    () => runTaskCommand(["role", "add", task.id, "retired"], store, options),
    /lifecycle transition/i
  );
  runTask(["role", "add", task.id, "processing"], store, options);
  store.saveWorkMailbox(lifecycleMailbox({
    scope: "task",
    taskId: task.id,
    roleName: "processing"
  }, "processing"));
  assert.throws(
    () => runTaskCommand([
      "role", "bind", task.id, "processing", "claude"
    ], store, options),
    /lifecycle transition/i
  );
});

test("manual Global Role session record and replace are fenced by lifecycle work", (t) => {
  const { store, options } = fixture(t);
  runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store, options);
  const owner = { scope: "global", roleName: "reviewer" };
  const target = runtimeLifecycleTarget(owner);

  store.saveWorkMailbox(lifecycleMailbox(owner, "processing"));
  assert.throws(
    () => runGlobalRoleCommand([
      "session", "record", "reviewer", "--native-id", "native-1"
    ], store, { ...options, env: {} }),
    /lifecycle transition/i
  );
  assert.equal(store.getGlobalRoleSessionSet("reviewer"), null);

  store.removeWorkMailbox(target);
  runGlobalRoleCommand([
    "session", "record", "reviewer", "--native-id", "native-1"
  ], store, { ...options, env: {} });
  const recorded = store.getGlobalRoleSessionSet("reviewer");
  assert.notEqual(recorded, null);
  store.saveGlobalRoleSessionSet(
    updateRoleAgentSessionStatus(recorded, "codex", "stopped", NOW)
  );
  store.saveWorkMailbox(lifecycleMailbox(owner, "pending"));

  assert.throws(
    () => runGlobalRoleCommand([
      "session", "replace", "reviewer",
      "--native-id", "native-2", "--reason", "manual rotation"
    ], store, { ...options, env: {} }),
    /lifecycle transition/i
  );
  assert.equal(
    store.getGlobalRoleSessionSet("reviewer").sessions.codex.nativeSessionId,
    "native-1"
  );
});

test("manual Global Role session reads, guards, and writes share one transaction", (t) => {
  const { store, options } = fixture(t);
  runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store, options);
  const recordObserved = observeTransactions(store);

  runGlobalRoleCommand([
    "session", "record", "reviewer", "--native-id", "native-1"
  ], recordObserved.store, { ...options, env: {} });

  assert.equal(
    recordObserved.events.filter(({ method }) => method === "transaction").length,
    1
  );
  for (const method of [
    "getGlobalRole",
    "getWorkMailbox",
    "getConfiguredAgent",
    "getGlobalRoleSessionSet",
    "saveGlobalRoleSessionSet"
  ]) {
    assert.ok(recordObserved.events.some((event) =>
      event.method === method && event.insideTransaction), method);
  }
  assert.equal(recordObserved.events.some((event) =>
    event.method !== "transaction" && !event.insideTransaction), false);

  const recorded = store.getGlobalRoleSessionSet("reviewer");
  assert.notEqual(recorded, null);
  store.saveGlobalRoleSessionSet(
    updateRoleAgentSessionStatus(recorded, "codex", "stopped", NOW)
  );
  const replaceObserved = observeTransactions(store);

  runGlobalRoleCommand([
    "session", "replace", "reviewer",
    "--native-id", "native-2", "--reason", "manual rotation"
  ], replaceObserved.store, { ...options, env: {} });

  assert.equal(
    replaceObserved.events.filter(({ method }) => method === "transaction").length,
    1
  );
  for (const method of [
    "getGlobalRole",
    "getWorkMailbox",
    "getConfiguredAgent",
    "getGlobalRoleSessionSet",
    "saveGlobalRoleSessionSet"
  ]) {
    assert.ok(replaceObserved.events.some((event) =>
      event.method === method && event.insideTransaction), method);
  }
  assert.equal(replaceObserved.events.some((event) =>
    event.method !== "transaction" && !event.insideTransaction), false);
});

test("Global and Task Role commands validate configured Skills before durable writes", (t) => {
  const { root, store, options } = fixture(t);

  assert.throws(
    () => runGlobalRoleCommand([
      "add", "unsafe", "--agent", "codex", "--skill", "../escape"
    ], store, options),
    /Skill id.*invalid/i
  );
  assert.equal(store.getGlobalRole("unsafe"), null);

  assert.throws(
    () => runGlobalRoleCommand([
      "add", "missing", "--agent", "codex", "--skill", "missing-policy"
    ], store, options),
    /Skill.*not found|unreadable/i
  );
  assert.equal(store.getGlobalRole("missing"), null);

  const task = createTask(store, options);
  assert.throws(
    () => runTaskCommand([
      "role", "add", task.id, "reviewer", "--skill", "missing-policy"
    ], store, options),
    /Skill.*not found|unreadable/i
  );
  assert.equal(store.getRole(task.id, "reviewer"), null);

  const leaderBefore = store.getRole(task.id, "leader");
  assert.throws(
    () => runTaskCommand([
      "role", "update", task.id, "leader", "--skill", "missing-policy"
    ], store, options),
    /Skill.*not found|unreadable/i
  );
  assert.deepEqual(store.getRole(task.id, "leader"), leaderBefore);

  const skillDir = join(root, "skills", "review-policy");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Review policy\n", "utf8");
  runGlobalRoleCommand([
    "add", "valid-global", "--agent", "codex", "--skill", "review-policy"
  ], store, options);
  runTask([
    "role", "add", task.id, "valid-task", "--skill", "review-policy"
  ], store, options);
  assert.deepEqual(store.getGlobalRole("valid-global").skills, ["review-policy"]);
  assert.deepEqual(store.getRole(task.id, "valid-task").skills, ["review-policy"]);

  rmSync(skillDir, { recursive: true });
  const globalBefore = store.getGlobalRole("valid-global");
  assert.throws(
    () => runGlobalRoleCommand([
      "update", "valid-global", "--description", "Still review safely"
    ], store, options),
    /Skill.*not found|unreadable/i
  );
  assert.deepEqual(store.getGlobalRole("valid-global"), globalBefore);
  const taskBefore = store.getRole(task.id, "valid-task");
  assert.throws(
    () => runTaskCommand([
      "role", "update", task.id, "valid-task", "--constraint", "Keep changes focused"
    ], store, options),
    /Skill.*not found|unreadable/i
  );
  assert.deepEqual(store.getRole(task.id, "valid-task"), taskBefore);

  runGlobalRoleCommand([
    "update", "valid-global", "--clear-skills"
  ], store, options);
  runTask([
    "role", "update", task.id, "valid-task", "--clear-skills"
  ], store, options);
  assert.deepEqual(store.getGlobalRole("valid-global").skills, []);
  assert.deepEqual(store.getRole(task.id, "valid-task").skills, []);
});

test("Task list rendering reads presentation configuration once per command", () => {
  let configReads = 0;
  const task = { id: "task-1" };
  const messages = Array.from({ length: 8 }, (_, index) => ({
    id: `message-${index + 1}`,
    author: { type: "user" },
    body: `Message ${index + 1}`,
    createdAt: new Date(NOW.getTime() + index * 1_000).toISOString()
  }));
  const store = {
    getTask: () => task,
    listMessages: () => messages,
    getConfig() {
      configReads += 1;
      return { timeZone: "Asia/Shanghai" };
    }
  };

  const result = runTaskCommand(["message", "list", task.id], store);
  assert.equal(result.kind, "output");
  assert.match(result.output, /2026-07-24 12:00:00 \+08:00/);
  assert.equal(configReads, 1);
});
