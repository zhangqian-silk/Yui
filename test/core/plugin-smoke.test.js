import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createBuiltinCapabilities } from "../../dist/kernel/builtinCapabilities.js";
import { createCapabilityDispatcher } from "../../dist/controller/capabilityBridge.js";
import { createDurableJobControl } from "../../dist/controller/jobControl.js";
import { InstanceHost } from "../../dist/kernel/instanceHost.js";

// One primary product path. Fault injection, trust-boundary matrices and
// performance regressions remain change-specific development evidence.
test("a Leader uses a Task-local declarative plugin and preserves its result", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-plugin-smoke-"));
  const store = new SqliteTaskStore(home);
  const host = new InstanceHost();
  try {
    const now = new Date();
    const task = activateTask(createTask("task-1", "Plugin smoke", now), now);
    store.saveTask(task);
    const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
    const role = createRole(task.id, "leader", [binding], binding.agentId, home, now);
    store.saveRole(task.id, role);
    store.saveTaskRoleSessionSet(recordRoleAgentSession(
      createRoleSessionSet({ scope: "task", taskId: task.id, roleName: role.name }, binding.agentId, now),
      { agentId: binding.agentId, adapterId: binding.adapterId, nativeSessionId: "plugin-smoke-session",
        policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now));
    store.saveActiveRun(createRun("turn-1", task.id, role.name, "new", createRunInput({
      source: { type: "yui", channel: "leader-wakeup" }, directive: "Use a Task-local plugin.", deltaRefIds: []
    }), now, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }));
    const dispatch = createCapabilityDispatcher(createBuiltinCapabilities(host, store, createDurableJobControl(store)));
    const caller = { scope: "task", taskId: task.id, role: role.name, nativeSessionId: "plugin-smoke-session" };
    let sequence = 0;
    const call = async (name, input, asCaller = caller) => {
      const result = await dispatch("capability.call", {
        taskId: task.id,
        caller: asCaller,
        request: { name, input, requestId: `smoke-${++sequence}` }
      });
      assert.equal(result.kind, "value", JSON.stringify(result));
      return result.value;
    };
    const prepared = await call("environment.prepare", { taskId: task.id, plan: { kind: "scratch" } });
    await call("environment.adopt", { taskId: task.id, preparationId: prepared.id });
    const created = await call("plugin.create", { preparationId: prepared.id, id: "demo", kind: "declarative" });
    const report = await call("plugin.validate", { preparationId: prepared.id, directory: created.directory });
    // Operator remains a supported management caller alongside the Leader.
    const operator = createGlobalRole("operator", [binding], binding.agentId, home, now);
    store.saveGlobalRole(operator);
    store.saveGlobalRoleSessionSet(recordRoleAgentSession(
      createRoleSessionSet({ scope: "global", roleName: operator.name }, binding.agentId, now),
      { agentId: binding.agentId, adapterId: binding.adapterId, nativeSessionId: "plugin-smoke-operator",
        policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role: operator, purpose: "execution" }) }, now));
    const scan = await call("plugin.scan", { preparationId: prepared.id, directory: created.directory },
      { scope: "global", role: operator.name, nativeSessionId: "plugin-smoke-operator" });
    assert.equal(scan.digest, report.sourceDigest);
    await call("plugin.activate", { validationId: report.id });
    const discovered = await dispatch("capability.search", { taskId: task.id, caller, query: "demo.echo" });
    assert.equal(discovered.capabilities.length, 1);
    const result = await call("demo.echo", { text: "hello" });
    assert.deepEqual(result, { text: "hello" });
    // Artifacts are now files in the Task's local Git repo. Save commits exactly
    // one relativePath and returns a self-certifying commit-pinned reference.
    const artifact = await call("artifact.save", { taskId: task.id,
      relativePath: "validation/plugin-result.txt", content: result.text, message: "record plugin result" });
    assert.match(artifact.commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
    assert.equal(artifact.relativePath, "validation/plugin-result.txt");
    const current = await call("plugin.inspect", { id: "demo" });
    assert.equal(current.desired.validationId, report.id);
    assert.equal(current.actual.validationId, report.id);
    assert.equal((await call("plugin.disable", { id: "demo" })).drained, true);
    // Read the file back at its pinned commit (frozen evidence survives plugin disable).
    assert.equal((await call("artifact.read", { taskId: task.id,
      relativePath: "validation/plugin-result.txt", commit: artifact.commit })).content, "hello");
    await host.close();
    store.close();
    const reopened = new SqliteTaskStore(home);
    try {
      assert.equal(reopened.getPluginIntent(task.id, "demo").enabled, false);
      assert.equal(reopened.getPluginValidation(task.id, report.id).package.digest, report.package.digest);
    } finally { reopened.close(); }
  } finally {
    await host.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("replacement preserves the new plugin and records an old generation's cleanup failure", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-plugin-cleanup-"));
  const store = new SqliteTaskStore(home);
  const host = new InstanceHost();
  let failCleanup = () => {};
  t.after(async () => {
    failCleanup(new Error("fixture teardown"));
    await host.close().catch(() => {}); // This fixture deliberately owns one failed disposer.
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const at = new Date("2026-09-15T12:00:00Z");
  const task = activateTask(createTask("task-1", "Plugin cleanup evidence", at), at);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, home, at);
  store.saveRole(task.id, role);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet({ scope: "task", taskId: task.id, roleName: role.name }, binding.agentId, at),
    { agentId: binding.agentId, adapterId: binding.adapterId, nativeSessionId: "cleanup-session",
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, at));
  const attach = host.attach.bind(host);
  const cleanup = new Promise((_, reject) => { failCleanup = reject; });
  void cleanup.catch(() => {});
  let injected = false;
  host.attach = (ref, implementation, disposers = []) => {
    if (ref.id.startsWith("plugin:") && !injected) {
      injected = true;
      return attach(ref, implementation, [...disposers, () => cleanup]);
    }
    return attach(ref, implementation, disposers);
  };
  const dispatch = createCapabilityDispatcher(createBuiltinCapabilities(host, store, createDurableJobControl(store)));
  const caller = { scope: "task", taskId: task.id, role: role.name, nativeSessionId: "cleanup-session" };
  let sequence = 0;
  const call = async (name, input) => {
    const result = await dispatch("capability.call", { taskId: task.id, caller,
      request: { name, input, requestId: `cleanup-${++sequence}` } });
    assert.equal(result.kind, "value", JSON.stringify(result));
    return result.value;
  };
  const environment = await call("environment.prepare", { taskId: task.id, plan: { kind: "scratch" } });
  await call("environment.adopt", { taskId: task.id, preparationId: environment.id });
  const created = await call("plugin.create", { preparationId: environment.id, id: "demo", kind: "declarative" });
  const validation = await call("plugin.validate", { preparationId: environment.id, directory: created.directory });
  const original = await call("plugin.activate", { validationId: validation.id });
  const intermediate = await call("plugin.activate", { validationId: validation.id });
  const replacement = await call("plugin.activate", { validationId: validation.id });
  failCleanup(new Error("owned cleanup failure"));
  await new Promise(setImmediate);
  const current = await call("plugin.inspect", { id: "demo" });
  assert.notEqual(original.provider.generation, replacement.provider.generation);
  assert.notEqual(intermediate.provider.generation, replacement.provider.generation);
  assert.equal(current.actual.provider.generation, replacement.provider.generation);
  assert.match(current.desired.lastFailure?.message ?? "", /cleanup failed/);
  assert.ok(current.desired.lastFailure.message.includes(original.provider.generation));
  assert.deepEqual(await call("demo.echo", { still: "available" }), { still: "available" });
});
