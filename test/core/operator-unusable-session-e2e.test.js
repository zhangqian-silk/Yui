import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { bindExecution, claimPending } from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { stopFileTaskController } from "../../dist/controller/clientRuntime.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered
} from "../../dist/executor/agentExecutor.js";
import { createRole, createRoleAgentBinding, updateRoleStatus } from "../../dist/role/role.js";
import { markAgentRunDelivered } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createAgentRun, recordRoleAgentSession } from "../helpers/effectiveLaunch.js";

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), "dist", "cli.js");
const FIRST = new Date("2026-08-03T01:00:00.000Z");
const SECOND = new Date("2026-08-03T01:00:01.000Z");

test("public Task Role reset derives identities from storage and preserves an auditable history", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-role-reset-cli-"));
  t.after(async () => {
    await stopFileTaskController(home);
    rmSync(home, { recursive: true, force: true });
  });
  ensureStorageSchema(home, FIRST);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex-primary", "codex", "codex", [], [], FIRST);
  const task = activateTask(createTask("task-1", "Reset Leader generation", FIRST), FIRST);
  const leader = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  let run = createAgentRun(
    "agent-run-1",
    task.id,
    leader.name,
    "new",
    "Continue Task control",
    FIRST,
    { purpose: "execution", agent: { agentId: agent.id, adapterId: agent.adapterId } }
  );
  run = markAgentRunDelivered(run, SECOND);
  const roleTarget = { kind: "role", taskId: task.id, roleName: leader.name };
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, updateRoleStatus(leader, "running", FIRST));
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, roleTarget, "leader-recovery", FIRST, [{
      type: "run", taskId: task.id, id: run.id
    }]);
    const claimed = claimPending(tx.getWorkMailbox(roleTarget), {
      batchId: "delivery-1",
      owner: "leader-delivery",
      startedAt: FIRST.toISOString()
    });
    tx.saveWorkMailbox(bindExecution(claimed, "delivery-1", {
      type: "run", taskId: task.id, id: run.id
    }));
    let sessions = createRoleSessionSet(
      { scope: "task", taskId: task.id, roleName: leader.name },
      agent.id,
      FIRST
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId: agent.id,
      adapterId: agent.adapterId,
      nativeSessionId: "native-old",
      launchId: "launch-old",
      policy: "fixed",
      status: "running"
    }, FIRST);
    sessions = bindTaskRoleRun(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${task.id}/${run.id}`
    }, FIRST);
    sessions = markTaskRoleRunDelivered(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${task.id}/${run.id}`
    }, SECOND);
    tx.saveTaskRoleSessionSet(sessions);
  });

  const environment = { ...process.env, YUI_HOME: home };
  for (const name of [
    "YUI_TASK_ID", "YUI_ROLE", "YUI_AGENT_ID", "YUI_AGENT_RUN_ID",
    "YUI_ADAPTER_ID", "YUI_NATIVE_SESSION_ID", "YUI_LAUNCH_ID", "YUI_SESSION_SCOPE"
  ]) delete environment[name];
  const result = await execFileAsync(process.execPath, [
    CLI,
    "--json",
    "task", "role", "reset", task.id, leader.name,
    "--reason", "The current native generation cannot continue."
  ], { cwd: process.cwd(), env: environment });
  assert.equal(JSON.parse(result.stdout).ok, true);

  const verified = new FileTaskStore(home);
  assert.equal(verified.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(verified.getActiveAgentRun(task.id, leader.name), null);
  assert.equal(verified.getRole(task.id, leader.name).status, "failed");
  const sessions = verified.getTaskRoleSessionSet(task.id, leader.name);
  assert.deepEqual(sessions.sessions, {});
  assert.deepEqual(sessions.history.map(({ nativeSessionId, status }) => ({
    nativeSessionId,
    status
  })), [{ nativeSessionId: "native-old", status: "broken" }]);
  assert.equal(verified.getOperatorNotification(task.id).type, "leader-recovery-failed");
  assert.match(verified.listMessages(task.id).at(-1).body, /Reset native Session/u);
});
