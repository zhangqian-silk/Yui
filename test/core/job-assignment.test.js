import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { createDurableJobControl, authorizeJobStart } from "../../dist/controller/jobControl.js";
import { createBuiltinCapabilities } from "../../dist/kernel/builtinCapabilities.js";
import { InstanceHost } from "../../dist/kernel/instanceHost.js";

test("Job admission, management and spawn keep a Worker inside its current Assignment", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-job-assignment-"));
  const store = new SqliteTaskStore(join(root, "home"));
  const host = new InstanceHost();
  t.after(async () => { await host.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const at = new Date("2026-09-15T12:00:00Z");
  const repository = path => {
    mkdirSync(path);
    const git = (...args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "main");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const main = join(root, "main"), worker = join(root, "worker");
  const head = repository(main), workerHead = repository(worker);
  const project = createProject("project-1", "app", join(root, "stable"), { stable: "main", development: "main" }, at);
  store.saveProject(project);
  const task = activateTask(createTask("task-1", "Scoped Jobs", at, {
    projectBindings: [{ projectId: project.id, directory: "app", baseRef: "main", baseCommit: head, currentCommit: head }]
  }), at);
  store.saveTask(task);
  const entry = (path, baseCommit) => ({ projectId: project.id, directory: "app", access: "write", path, branch: "main", baseRef: "main", baseCommit });
  const mainWorkspace = createManagedWorkspace({ owner: { type: "task", taskId: task.id }, root: main, entries: [entry(main, head)] }, at);
  const item = createWorkItem("work-item-1", task.id, { title: "Worker scope", assignee: "worker", writeProjectIds: [project.id] }, at);
  store.saveWorkItem(task.id, item);
  const workspace = createManagedWorkspace({ owner: { type: "work-item", taskId: task.id, workItemId: item.id },
    root: worker, entries: [entry(worker, workerHead)] }, at);
  store.saveManagedWorkspace(mainWorkspace);
  store.saveManagedWorkspace(workspace);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], at);
  store.saveConfiguredAgent(agent);
  for (const [name, space] of [["worker", workspace], ["leader", mainWorkspace]]) {
    const role = createRole(task.id, name, [createRoleAgentBinding(agent)], agent.id, space.root, at);
    store.saveRole(task.id, role);
    const effective = resolveEffectiveLaunch({ role, purpose: "execution", workspace: space, workItemWriteProjectIds: [project.id] });
    store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({ scope: "task", taskId: task.id, roleName: name }, agent.id, at),
      { agentId: agent.id, adapterId: agent.adapterId, nativeSessionId: `session-${name}`, status: "active", policy: "fixed", effective }, at));
    if (name === "worker") store.saveActiveRun(createRun("run-1", task.id, name, "new",
      createRunInput({ source: { type: "yui", channel: "workitem-dispatch" }, directive: "Work only in this Assignment.", deltaRefIds: [] }), at,
      { workItemId: item.id, workspace, effective }));
  }
  const caller = name => ({ scope: "task", taskId: task.id, role: name, nativeSessionId: `session-${name}` });
  const params = { taskId: task.id, requestId: "own-check", owner: { kind: "work-item", workItemId: item.id },
    projectId: project.id, head: workerHead, workspace: worker, env: {}, steps: [{ name: "check", command: "true" }], caller: caller("worker") };
  const control = createDurableJobControl(store);
  const own = control.startJob(params, at);
  assert.equal(own.created, true);
  authorizeJobStart(store, own.job);
  assert.equal(control.startJob(params, at).job.id, own.job.id);
  const outside = { ...params, requestId: "main-check", owner: { kind: "task" }, head, workspace: main };
  assert.throws(() => control.startJob(outside, at),
    error => error.name === "CoreApplicationError" && error.code === "UNAUTHORIZED" && /Assignment/.test(error.message));
  const kernel = createBuiltinCapabilities(host, store, control);
  const { caller: _caller, requestId: _request, ...input } = outside;
  const denied = await kernel.registry.call(kernel.authenticate(caller("worker"), task.id), {
    name: "job.start", requestId: "capability-main-check", input
  });
  assert.equal(denied.kind, "denied");
  assert.equal(denied.effect, "none", "A rejected Assignment must not be reported as an unknown external effect.");
  // An older queued record must also be rejected at the actual spawn boundary.
  assert.throws(() => authorizeJobStart(store, { ...own.job, owner: outside.owner, workspace: main, head }), /[Aa]ssignment/);
  const leaderJob = control.startJob({ ...outside, caller: caller("leader") }, at).job;
  assert.throws(() => control.cancelJob(task.id, leaderJob.id, at, caller("worker")), /[Aa]ssignment/);
  assert.throws(() => control.acknowledgeJob(task.id, leaderJob.id, at, caller("worker")), /[Aa]ssignment/);
  assert.equal(store.getDurableJob(task.id, leaderJob.id).cancelRequestedAt, undefined);
  assert.ok(control.cancelJob(task.id, own.job.id, at, caller("worker")).cancelRequestedAt);
  store.clearActiveRun(task.id, "worker");
  assert.throws(() => authorizeJobStart(store, own.job), /[Aa]ssignment/);
  authorizeJobStart(store, leaderJob);
});
