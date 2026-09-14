import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createTask, activateTask, completeTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createPublicationReference } from "../../dist/task/publicationReference.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { claimPending } from "../../dist/coordination/workMailbox.js";
import { createProject } from "../../dist/repository/project.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor, AsyncRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { queueLeaderWakeup } from "../../dist/scheduler/wakeupQueue.js";
import { routeRoleEvent } from "../../dist/scheduler/operatorEvent.js";
import { recordArchiveCleanup, taskArchiveDiagnostics } from "../../dist/task/archiveDiagnostics.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { bindTaskRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { acceptProviderTurn, beginProviderTurn, createProviderRuntimeBinding } from "../../dist/runtime/providerRuntimeIdentity.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { createDurableJob } from "../../dist/job/durableJob.js";
import { createTaskRemoteDeliveryProof } from "../../dist/task/remoteDeliveryService.js";
import { buildWebTaskCatalog, buildWebTaskDetail } from "../../dist/web/webSnapshot.js";

const now = new Date("2026-09-12T00:00:00Z");
const base = "a".repeat(40);
const head = "b".repeat(40);

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-force-archive-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveProject(createProject("project-1", "lab", join(home, "reference"),
    { stable: "main", development: "main" }, now));
  const task = completeTask(activateTask(createTask("task-1", "Archive independently", now, {
    cwd: join(home, "missing-main"),
    projectBindings: [{ projectId: "project-1", directory: "lab", baseRef: "main", baseCommit: base, currentCommit: head }]
  }), now), now, { by: "user", summary: "Frozen delivery" });
  store.saveTask(task);
  store.saveEvent(task.id, createTaskEvent(store.nextEventId(task.id), task.id, "task.completed",
    { projectHeads: `project-1@${head}`, projectBases: `project-1@${base}` }, now));
  const publication = createPublicationReference("publication-1", task.id, {
    projectId: "project-1", provider: "github", repository: "local/fixture",
    externalKind: "pull-request", externalId: "1", localCommit: base,
    remoteCommit: base, state: "merged", verification: "verified"
  }, now);
  store.savePublicationReference(task.id, publication);
  const workspace = createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: task.cwd, entries: []
  }, now);
  store.saveManagedWorkspace(workspace);
  const target = { kind: "role", taskId: task.id, roleName: "leader" };
  store.saveWorkMailbox(claimPending(enqueueWork(store, target, "original-unknown-input", now), {
    batchId: "unknown-original", owner: "original-session", startedAt: now.toISOString()
  }));
  const command = args => runTaskCommand(args, store, { environment: {}, now: () => now });
  return { home, store, task, publication, workspace, target, command };
}

test("force archive commits despite stale delivery and retained resources, preserving original input and evidence", t => {
  const { store, task, publication, workspace, target, command } = fixture(t);
  const mailbox = store.getWorkMailbox(target);
  assert.throws(() => command(["archive", task.id, "--integrated"]), /proof|required|managed/i);
  const result = command(["archive", task.id, "--integrated", "--force"]);
  assert.equal(result.data.archived, true);
  assert.equal(store.getTask(task.id).status, "archived");
  assert.equal(store.getTask(task.id).executionGate.state, "stopped");
  assert.deepEqual(store.listPublicationReferences(task.id), [publication]);
  assert.deepEqual(store.getTaskWorkspace(task.id), workspace);
  assert.deepEqual(store.getWorkMailbox(target), mailbox);
  assert.ok(result.data.warnings.some(w => /stale|merged/i.test(w.detail)));
  assert.ok(result.data.retainedResources.some(r => r.resource === "task:task-1"));
  assert.equal(command(["list"]).data.tasks.length, 0);
  assert.equal(command(["show", task.id]).data.archive.archived, true);
  const input = { id: "input-1", taskId: task.id, status: "open" };
  const listInputs = store.listInputRequests;
  store.listInputRequests = () => [input];
  const dashboard = buildWebTaskCatalog(store, { all: false, limit: 20 });
  assert.equal(dashboard.attention.openInputs.count, 0);
  assert.deepEqual(dashboard.tasks, []);
  assert.equal(buildWebTaskDetail(store, task.id, now).openInputs.length, 1,
    "explicit archived detail retains unresolved facts");
  store.listInputRequests = listInputs;
  const events = store.listEvents(task.id);
  command(["archive", task.id, "--integrated", "--force"]);
  assert.deepEqual(store.listEvents(task.id), events, "retry must not re-run cleanup or rewrite the audit");
});

test("force does not override lifecycle, independent authority, or an audit commit failure", t => {
  const { store, task, command } = fixture(t);
  store.saveTask(activateTask(createTask("task-2", "Still active", now), now));
  assert.throws(() => command(["archive", "task-2", "--integrated", "--force"]), /completed|retired/);
  const before = store.getTask(task.id);
  const originalSave = store.saveEvent;
  store.saveEvent = function (id, event) {
    if (event.type === "task.archived") throw new Error("audit storage unavailable");
    return originalSave.call(this, id, event);
  };
  assert.throws(() => command(["archive", task.id, "--integrated", "--force"]), /audit storage unavailable/);
  assert.deepEqual(store.getTask(task.id), before);
  store.saveEvent = originalSave;
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createRole(task.id, "leader", [createRoleAgentBinding(agent)], "codex", task.cwd, now);
  store.saveRole(task.id, role);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: task.id, roleName: "leader"
  }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "leader-original",
    policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now));
  assert.throws(() => runTaskCommand(["archive", task.id, "--integrated", "--force"], store, {
    environment: { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: "leader",
      YUI_NATIVE_SESSION_ID: "leader-original", YUI_WORKSPACE: task.cwd }
  }), /independent user or Operator/);
  assert.deepEqual(store.getTask(task.id), before);
});

test("force cleanup records independent failures and successes after archive without discarding retained data", async t => {
  const { home, store, task, command } = fixture(t);
  for (let i = 1; i <= 3; i++) {
    const item = updateWorkItemStatus(createWorkItem(`work-item-${i}`, task.id, { title: `Resource ${i}` }, now),
      "retired", now, "Deliberately retired");
    store.saveWorkItem(task.id, item);
    store.saveManagedWorkspace(createManagedWorkspace({
      owner: { type: "work-item", taskId: task.id, workItemId: item.id },
      root: join(home, item.id), entries: []
    }, now));
  }
  command(["archive", task.id, "--integrated", "--force"]);
  const visited = [];
  const coordinator = new TaskWorkspaceCoordinator(store, {
    home,
    async cleanupWorkItemWorkspace(id, itemId) {
      assert.equal(store.getTask(id).status, "archived", "archive must precede every cleanup side effect");
      visited.push(itemId);
      if (itemId === "work-item-1") return "dirty";
      if (itemId === "work-item-2") throw new Error("EACCES: exact path retained");
      store.removeManagedWorkspace({ type: "work-item", taskId: id, workItemId: itemId });
      return "missing";
    }
  }, {
    async stopTaskRoleSessions() { assert.fail("no Role to stop"); },
    async releaseTaskTerminals() {},
    async assertTaskPhysicalResourcesReleased() {}
  });
  await coordinator.cleanupArchivedTask(task.id, "integrated");
  assert.deepEqual(visited, ["work-item-1", "work-item-2", "work-item-3"]);
  const diagnostics = taskArchiveDiagnostics(store, store.getTask(task.id));
  assert.equal(diagnostics.archived, true);
  assert.equal(diagnostics.cleanupFinished, true);
  assert.ok(diagnostics.warnings.some(w => /Dirty/.test(w.detail)));
  assert.ok(diagnostics.warnings.some(w => /EACCES/.test(w.detail)));
  assert.equal(store.getWorkItemWorkspace(task.id, "work-item-3"), null);
  assert.ok(store.getWorkItemWorkspace(task.id, "work-item-1"));
  assert.ok(diagnostics.cleanupEvents.some(e => e.payload.status === "missing"));
});

test("cleanup persistence failures propagate even when the next audit write could succeed", async t => {
  for (const failure of ["record", "audit"]) await t.test(failure, async t => {
    const { home, store, task, command } = fixture(t);
    const item = updateWorkItemStatus(createWorkItem("work-item-1", task.id, { title: "Partial cleanup" }, now),
      "retired", now, "Retired");
    store.saveWorkItem(task.id, item);
    store.saveManagedWorkspace(createManagedWorkspace({
      owner: { type: "work-item", taskId: task.id, workItemId: item.id }, root: join(home, "work"), entries: []
    }, now));
    command(["archive", task.id, "--integrated", "--force"]);
    const original = store.saveEvent;
    store.saveEvent = function (taskId, event) {
      if (event.type === "task.archive-cleanup" && event.payload.resource === "path:partial") {
        throw Object.assign(new Error("one-off audit write failure"), { code: "SQLITE_BUSY" });
      }
      return original.call(this, taskId, event);
    };
    const coordinator = new TaskWorkspaceCoordinator(store, {
      home, async cleanupWorkItemWorkspace() {
        if (failure === "audit") recordArchiveCleanup(store, task.id,
          { resource: "path:partial", detail: "One path removed" }, "removed", now);
        throw Object.assign(new Error("one-off durable cleanup write failure"), { code: "SQLITE_BUSY" });
      }
    }, { async stopTaskRoleSessions() {}, async releaseTaskTerminals() {}, async assertTaskPhysicalResourcesReleased() {} });
    await assert.rejects(coordinator.cleanupArchivedTask(task.id, "integrated"), /write failure/);
    assert.equal(store.getTask(task.id).status, "archived");
    assert.equal(taskArchiveDiagnostics(store, store.getTask(task.id)).cleanupFinished, false);
    assert.ok(store.getWorkItemWorkspace(task.id, item.id));
  });
});

test("late events retain complete source evidence without replaying or acknowledging original unknown input", async t => {
  const { store, home, task, target, command } = fixture(t);
  command(["archive", task.id, "--integrated", "--force"]);
  const mailbox = store.getWorkMailbox(target);
  const scheduler = new FileSchedulerStoreAdapter(store);
  const inbox = new FileRuntimeEventInbox(home, () => now);
  const terminal = inbox.enqueueRunTerminal({
    scope: "task", taskId: task.id, roleName: "leader", agentId: "codex", adapterId: "codex",
    nativeSessionId: "original-session", nativeTurnId: "original-turn", providerStatus: "completed",
    outcome: { status: "completed", output: "Full original late report\nStill evidence, not acceptance." }
  }).event;
  const processor = new FileRuntimeEventProcessor(inbox, scheduler);
  assert.equal((await new AsyncRuntimeEventProcessor(inbox, scheduler).drainAsync(now)).failed.length, 0);
  const stored = store.listEvents(task.id).find(e => e.payload.eventId === terminal.id);
  assert.deepEqual(JSON.parse(stored.payload.originalEvent), terminal);
  const observation = inbox.enqueueObservation({
    schemaVersion: 4, eventId: "late-acceptance", semanticKey: "late-acceptance",
    kind: "turn.accepted", authority: "provider-structured", receivedAt: now.toISOString(),
    sequence: 1, ordinal: 0, fence: {
      taskId: task.id, roleName: "leader", agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "original-session", nativeTurnId: "original-turn", receiptId: "unknown-original"
    }, payload: {}
  }).event;
  assert.equal(processor.drain(now).failed.length, 0);
  assert.deepEqual(JSON.parse(store.listEvents(task.id).find(e =>
    e.payload.eventId === observation.id).payload.originalEvent), observation);
  routeRoleEvent(store, stored, "leader", "late-result", now);
  routeRoleEvent(store, stored, "worker", "late-result", now);
  queueLeaderWakeup(store, task.id, "late-result", now);
  scheduler.enqueueLeaderWakeup(task.id, "late-result", now);
  assert.equal(scheduler.claimLeaderNotification(task.id, now), null);
  assert.deepEqual(store.getWorkMailbox(target), mailbox);
  assert.equal(store.getWorkMailbox({ kind: "operator" }), null);
  assert.deepEqual(store.listRuns(task.id), []);
  assert.equal(store.getTask(task.id).status, "archived");
});

test("archive racing Host ingress retains the complete envelope without settling unknown input", async t => {
  const { store, home, task, target, command } = fixture(t);
  const originalMailbox = store.getWorkMailbox(target);
  const inbox = new FileRuntimeEventInbox(home, () => now);
  const event = inbox.enqueueObservation({
    schemaVersion: 4, eventId: "late-host-result", semanticKey: "late-host-result",
    kind: "turn.completed", authority: "provider-structured", receivedAt: now.toISOString(),
    sequence: 1, ordinal: 0,
    fence: { taskId: task.id, roleName: "leader", agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "original-session", nativeTurnId: "original-turn", receiptId: "unknown-original" },
    payload: { output: "Original Host result\nRetained without acceptance." }
  }, { protocol: "yui-agent-host-events/v1", adapterId: "codex", workspace: task.cwd }).event;
  const transaction = store.transaction;
  store.transaction = function (fn, options) {
    store.transaction = transaction;
    command(["archive", task.id, "--integrated", "--force"]);
    return transaction.call(this, fn, options);
  };
  const scheduler = new FileSchedulerStoreAdapter(store);
  assert.equal(scheduler.observeAgentHostObservation(event, now), "obsolete");
  const evidence = store.listEvents(task.id).find(e => e.payload.eventId === event.id);
  assert.ok(evidence, "The complete Host envelope must survive even if archive wins the first write.");
  assert.deepEqual(JSON.parse(evidence.payload.originalEvent), event);
  assert.equal(evidence.payload.reason, "task-archived");
  const replay = await new AsyncRuntimeEventProcessor(inbox, scheduler).drainAsync(now);
  assert.deepEqual(replay.failed, []);
  assert.equal(inbox.list().length, 0);
  assert.equal(store.listEvents(task.id).filter(e => e.payload.eventId === event.id).length, 1);
  assert.deepEqual(store.getWorkMailbox(target), originalMailbox);
  assert.deepEqual(store.listRuns(task.id), []);
  assert.equal(store.getTask(task.id).status, "archived");
});

test("force retains active Runs and queued Jobs, while plain settled archive still succeeds", async t => {
  const { home, store, task, command } = fixture(t);
  store.saveTask(activateTask(createTask(task.id, task.title, now, {
    cwd: task.cwd, projectBindings: task.projectBindings
  }), now));
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createRole(task.id, "worker", [createRoleAgentBinding(agent)], "codex", task.cwd, now);
  store.saveRole(task.id, role);
  const run = createRun("turn-1", task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Original execution", deltaRefIds: []
  }), now, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  store.saveActiveRun(run);
  const job = createDurableJob({
    id: "job-1", taskId: task.id, owner: { kind: "task" }, projectId: "project-1",
    head, workspace: home, env: {}, steps: [{ name: "original", command: "true" }], artifactsLocator: "artifacts/job-1"
  }, now);
  store.saveDurableJob(task.id, job);
  store.saveTask(task);
  command(["archive", task.id, "--integrated", "--force"]);
  await new TaskWorkspaceCoordinator(store, { home }, {
    async stopTaskRoleSessions() { assert.fail("An active Run must not be presumed stopped."); },
    async releaseTaskTerminals() { assert.fail("Active execution must retain its terminals."); },
    async assertTaskPhysicalResourcesReleased() { assert.fail("Active execution must retain its resources."); }
  }).cleanupArchivedTask(task.id, "integrated");
  assert.deepEqual(store.getActiveRun(task.id, role.name), run);
  assert.deepEqual(store.getDurableJob(task.id, job.id), job);
  assert.ok(store.getTaskWorkspace(task.id));
  const clean = completeTask(activateTask(createTask("task-2", "No delivery resources", now), now), now,
    { by: "user", summary: "Complete" });
  store.saveTask(clean);
  const result = runTaskCommand(["archive", clean.id, "--integrated"], store, {
    environment: {}, archiveRemoteDeliveryProof: createTaskRemoteDeliveryProof(store, clean)
  });
  assert.equal(result.data.archived, true);
  assert.deepEqual(result.data.warnings, []);
  assert.deepEqual(result.data.retainedResources, []);
});

test("archive committed at observation transaction admission preserves the exact late steer claim", t => {
  const { store, task, target, command } = fixture(t);
  store.saveTask(activateTask(createTask(task.id, task.title, now, {
    cwd: task.cwd, projectBindings: task.projectBindings
  }), now));
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const role = createRole(task.id, "leader", [createRoleAgentBinding(agent)], "codex", task.cwd, now);
  store.saveRole(task.id, role);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const run = createRun("turn-1", task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Original execution", deltaRefIds: []
  }), now, { effective });
  store.saveActiveRun(run);
  const binding = acceptProviderTurn(beginProviderTurn(createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: "original-session",
    startedAt: now.toISOString()
  }), {
    attemptId: "original-attempt", runId: run.id, authorityEpoch: 1, submittedAt: now.toISOString()
  }), { attemptId: "original-attempt", nativeTurnId: "original-turn", acceptedAt: now.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: task.id, roleName: "leader"
  }, "codex", now), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "original-session",
    policy: "fixed", status: "active", effective
  }, now), binding, now));
  const old = store.getWorkMailbox(target);
  store.saveWorkMailbox({ ...old, processing: { ...old.processing, owner: `leader-steer:${run.id}` } });
  store.saveTask(task);
  const claim = store.getWorkMailbox(target);
  const transaction = store.transaction;
  store.transaction = function (fn, options) {
    store.transaction = transaction;
    command(["archive", task.id, "--integrated", "--force"]);
    return transaction.call(this, fn, options);
  };
  const observation = {
    schemaVersion: 4, eventId: "late-steer", semanticKey: "late-steer", kind: "input.accepted",
    authority: "provider-structured", receivedAt: now.toISOString(), sequence: 1, ordinal: 0,
    fence: { taskId: task.id, roleName: "leader", runId: run.id, agentId: "codex", driverId: "openai/codex",
      nativeSessionId: "original-session", nativeTurnId: "original-turn",
      receiptId: `turn-input:${task.id}/${run.id}/${claim.processing.batchId}` },
    payload: { input: "Original uncertain steer" }
  };
  assert.equal(new FileSchedulerStoreAdapter(store).observeRuntimeObservation(observation, now), "obsolete");
  assert.deepEqual(store.getWorkMailbox(target), claim);
  assert.deepEqual(store.getActiveRun(task.id, "leader"), run);
  const evidence = store.listEvents(task.id).find(e => e.payload.eventId === observation.eventId);
  assert.deepEqual(JSON.parse(evidence.payload.originalEvent), observation);
  assert.ok(!store.listEvents(task.id).some(e => e.type === "run.input-submitted"));
});
