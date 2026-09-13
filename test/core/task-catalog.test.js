import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, archiveTask, completeTask, createTask } from "../../dist/task/task.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { inspectTaskContext } from "../../dist/context/taskContext.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { createTaskBrief } from "../../dist/brief/taskBrief.js";
import { createProject } from "../../dist/repository/project.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

test("compact discovery is bounded, paged before detail, and does not hide off-page attention", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-catalog-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-13T00:00:00Z");
  const emptyCatalog = runTaskCommand(["list", "--view", "compact"], store, { environment: {} }).data;
  assert.equal(emptyCatalog.total, 0);
  assert.equal(emptyCatalog.nextCursor, null);
  for (let i = 1; i <= 5; i++) {
    store.saveTask(createTask(`task-${i}`, `Task ${i}`, now, {
      description: "Large original intent. ".repeat(2000)
    }));
  }
  store.saveInputRequest("task-5", createInputRequest("input-1", "task-5",
    { taskId: "task-5", roleName: "leader", agentId: "codex", nativeSessionId: "leader-5" },
    { question: "Choose the product behavior", choices: [], blockedRefs: [] }, now));
  const originalGet = store.getTask.bind(store);
  const originalEvents = store.listEvents.bind(store);
  const reads = [];
  store.getTask = (id) => { reads.push(id); return originalGet(id); };
  for (const name of ["listTasks", "listRuns", "listEvents", "listWorkItems", "listContextSnapshots"]) {
    store[name] = () => assert.fail(`compact must not enumerate ${name}`);
  }
  const read = (...args) => runTaskCommand(["list", "--view", "compact", ...args],
    store, { environment: {} }).data;
  const first = read("--limit", "2");
  assert.equal(first.total, 5);
  assert.equal(first.tasks.length, 2);
  assert.equal(first.attention.openInputs.count, 1);
  assert.equal(first.attention.openInputs.refs[0].taskId, "task-5");
  assert.ok(!reads.includes("task-3"));
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: first })) <= first.limits.pageBytes);
  assert.equal(first.tasks[0].description, undefined);
  store.saveTask(createTask("task-99", "Created after enumeration began",
    new Date("2026-09-13T00:01:00Z")));
  const second = read("--limit", "2", "--cursor", first.nextCursor);
  const last = read("--limit", "2", "--cursor", second.nextCursor);
  assert.equal(last.nextCursor, null);
  assert.deepEqual([...first.tasks, ...second.tasks, ...last.tasks].map(task => task.id),
    ["task-1", "task-2", "task-3", "task-4", "task-5"]);
  const empty = read("--search", "no match");
  assert.equal(empty.total, 0);
  assert.equal(empty.attention.openInputs.count, 1);
  assert.equal(read("--attention", "openInputs").tasks[0].id, "task-5");
  assert.throws(() => read("--search", "changed", "--cursor", first.nextCursor), /cursor/i);
  assert.throws(() => read("--limit", "0"), /limit/i);
  const ref = first.tasks[0].ref;
  store.listEvents = originalEvents;
  const detail = inspectTaskContext(store, ref.taskId, ref);
  assert.ok(detail.value.description.length > 10000);
  const archived = archiveTask(completeTask(activateTask(createTask("task-6", "Archived evidence", now), now),
    now, { by: "operator", summary: "Retained evidence" }), now);
  store.saveTask(archived);
  store.saveInputRequest(archived.id, createInputRequest("input-1", archived.id,
    { taskId: archived.id, roleName: "leader", agentId: "codex", nativeSessionId: "historical" },
    { question: "Retained open input", choices: [], blockedRefs: [] }, now));
  assert.equal(read().attention.openInputs.count, 1);
  const all = read("--status", "archived");
  assert.equal(all.total, 1);
  assert.equal(all.attention.openInputs.count, 2);
  assert.equal(all.attention.openInputs.query.all, true);
  assert.equal(read("--all", "--attention", "openInputs").tasks.length, 2);
});

test("catalog scope, cursor and exact refs cannot widen a Session or Assignment", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-catalog-scope-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-13T00:00:00Z");
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  for (let i = 1; i <= 2; i++) {
    store.saveProject(createProject(`project-${i}`, `Project ${i}`, join(home, `project-${i}`),
      { stable: "main", development: "main" }, now));
    store.saveTask(createTask(`task-${i}`, `task-${i}`, now, {
      projectBindings: [{ projectId: `project-${i}`, directory: `project-${i}`, baseRef: "main" }]
    }));
  }
  store.saveWorkItem("task-2", createWorkItem("work-item-1", "task-2", { title: "Private work" }, now));
  for (const name of ["leader", "worker"]) {
    const role = createRole("task-1", name, [createRoleAgentBinding(agent)], agent.id, home, now);
    store.saveRole("task-1", role);
    store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: name }, agent.id, now
    ), {
      agentId: agent.id, adapterId: "codex", nativeSessionId: name,
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
    }, now));
  }
  const env = { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "leader",
    YUI_NATIVE_SESSION_ID: "leader", YUI_WORKSPACE: home };
  const read = (environment, ...args) => runTaskCommand(["list", "--view", "compact", "--limit", "1", ...args],
    store, { environment }).data;
  const global = read({});
  const before = store.getStateRevision();
  const scoped = read(env);
  assert.equal(scoped.total, 1);
  assert.equal(scoped.nextCursor, null);
  assert.equal(scoped.attention.executionSignals.count, 0);
  assert.equal(global.attention.executionSignals.count, 1);
  assert.equal(read(env, "--project", "project-2").total, 0);
  assert.equal(read({}, "--project", "project-2").tasks[0].id, "task-2");
  assert.equal(store.getStateRevision(), before);
  assert.throws(() => read(env, "--cursor", global.nextCursor), /cursor/i);
  assert.throws(() => read({ ...env, YUI_ROLE: "worker", YUI_NATIVE_SESSION_ID: "worker" }), /Assignment/i);
  assert.throws(() => read({ YUI_SESSION_SCOPE: "global", YUI_ROLE: "reviewer" }), /Operator/i);
  assert.throws(() => read({ YUI_ROLE: "leader" }), /identity/i);
  assert.throws(() => inspectTaskContext(store, "task-2", global.tasks[0].ref, env), /outside/i);
  const old = scoped.tasks[0].ref;
  store.saveTask({ ...store.getTask("task-1"), title: "Changed" });
  assert.throws(() => inspectTaskContext(store, "task-1", old, env), /changed/i);
});

test("catalog byte budget includes escaped Unicode and continues; HTTP preserves detail consumers", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-catalog-web-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-13T00:00:00Z");
  store.transaction(() => {
    for (let i = 1; i <= 60; i++) {
      const id = `task-${i}`;
      store.saveTask(createTask(id, `任务😀 ${i} ` + "長".repeat(300), now));
      store.saveTaskBrief(id, createTaskBrief({ objective: "Catalog budget", boundaries: [],
        currentFocus: "Verify", leaderSummary: '字😀"\\\n'.repeat(400), updatedBy: "leader" }, now));
    }
  });
  const read = cursor => runTaskCommand(["list", "--view", "compact", "--limit", "100",
    ...(cursor ? ["--cursor", cursor] : [])], store, { environment: {} }).data;
  let page = read();
  const ids = [];
  do {
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, data: page })) + 1 <= 32768);
    assert.ok(page.tasks.length > 0);
    assert.ok(page.tasks.every(task => task.omitted.summary && !task.summary.includes("\uFFFD")));
    ids.push(...page.tasks.map(task => task.id));
    if (!page.nextCursor) break;
    page = read(page.nextCursor);
  } while (true);
  assert.equal(new Set(ids).size, 60);
  assert.equal(ids.length, 60);
  assert.equal(store.listTaskChoices().length, 60);
  const server = createYuiWebServer(store, { token: "catalog-test" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(base + path, { headers: { "x-yui-web-token": "catalog-test" } });
  const compact = await get("/api/dashboard?view=compact&limit=2");
  assert.equal(compact.status, 200);
  assert.equal((await compact.json()).tasks.length, 2);
  assert.equal((await get("/api/dashboard?view=compact&limit=0")).status, 400);
  const legacy = runTaskCommand(["list"], store, { environment: {} }).data;
  assert.ok(legacy.tasks[0].execution.observability);
  assert.ok(legacy.tasks[0].remoteDelivery);
  const detail = await (await get("/api/tasks/task-60")).json();
  assert.ok(detail.execution.observability);
  assert.ok(detail.remoteDelivery);
});
