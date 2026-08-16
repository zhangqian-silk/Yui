import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskIntegrationCommand } from "../../dist/commands/taskIntegrationCommands.js";
import { createProject } from "../../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createAgentRun, testEffectiveLaunch } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem, submitWorkItemCandidate, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";
import { stopFileTaskController } from "../../dist/controller/clientRuntime.js";
import { createControllerIntegrationJobPort } from "../../dist/controller/jobClient.js";
import { bindTaskRoleRun, createRoleSessionSet } from "../../dist/executor/agentExecutor.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const HEAD_40 = "0123456789abcdef0123456789abcdef01234567";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/**
 * rr13: Save an active in-flight Leader Run + Role Session + caller key hash
 * so a managed Session CLI can be verified against durable Run state. The
 * fixture's own Leader Run is yielded (not active); checks that issue jobs
 * through a CLI subprocess need a live Leader assertion and a caller key.
 * Returns the plaintext caller key so the test can inject it into the CLI
 * subprocess env as YUI_JOB_CALLER_KEY.
 */
function saveActiveLeaderAssertion(store, task, agent, stamp) {
  const run = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Leader turn.",
    stamp,
    { effective: testEffectiveLaunch({ agentId: agent.id, adapterId: agent.adapterId }) }
  );
  store.saveAgentRun(run);
  store.saveActiveAgentRun(run);
  let sessions = store.getTaskRoleSessionSet(task.id, "leader");
  if (sessions === null) {
    sessions = createRoleSessionSet({
      scope: "task",
      taskId: task.id,
      roleName: "leader"
    }, agent.id, stamp);
  }
  sessions = bindTaskRoleRun(sessions, {
    agentId: agent.id,
    runId: run.id,
    receiptId: formatAgentRunReceiptId(task.id, run.id)
  }, stamp);
  store.saveTaskRoleSessionSet(sessions);
  const callerKey = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(callerKey).digest("hex");
  store.setJobCallerKeyHash(task.id, "leader", agent.id, hash);
  return {
    runId: run.id,
    receiptId: formatAgentRunReceiptId(task.id, run.id),
    callerKey
  };
}

/**
 * Fake IntegrationJobPort: records the start input and lets the test decide
 * when the job reaches which terminal state. No Controller, no subprocess.
 */
function fakeJobPort() {
  const calls = { starts: 0, gets: 0, cancels: 0 };
  let lastInput = null;
  let job = null;
  let beforeStartReturn = () => undefined;
  const step = (name, exitCode, extra = {}) => ({
    name,
    exitCode,
    signal: null,
    timedOut: false,
    durationMs: 100,
    logPath: `001-${name}.log`,
    head: lastInput?.head ?? HEAD_40,
    ...extra
  });
  const terminalize = (outcome, result) => {
    if (job === null) throw new Error("job was never started");
    job = { ...job, status: outcome === "succeeded" ? "succeeded" : outcome, result };
  };
  return {
    calls,
    async startCheckJob(input) {
      calls.starts += 1;
      lastInput = input;
      if (job === null) {
        job = {
          id: "job-1",
          taskId: input.taskId,
          head: input.head,
          status: "running",
          artifactsLocator: `artifacts/jobs/${input.taskId}/job-1`,
          result: undefined
        };
      }
      beforeStartReturn();
      return job;
    },
    async getJob() {
      calls.gets += 1;
      return job;
    },
    async cancelJob() {
      calls.cancels += 1;
    },
    get input() {
      return lastInput;
    },
    get job() {
      return job;
    },
    setBeforeStartReturn(callback) {
      beforeStartReturn = callback;
    },
    succeed() {
      terminalize("succeeded", {
        outcome: "succeeded",
        exitCode: 0,
        signal: null,
        steps: [step("check-1", 0), step("check-2", 0), step("check-3", 0)]
      });
    },
    fail() {
      terminalize("failed", {
        outcome: "failed",
        exitCode: 7,
        signal: null,
        failedStep: "check-2",
        steps: [step("check-1", 0), step("check-2", 7)]
      });
    },
    unknown() {
      terminalize("unknown-needs-attention", {
        outcome: "unknown-needs-attention",
        exitCode: null,
        signal: null,
        unknownReason: "runner process exited without writing exit.json",
        steps: [step("check-1", 0)]
      });
    },
    cancelled() {
      terminalize("cancelled", {
        outcome: "cancelled",
        exitCode: null,
        signal: null,
        steps: []
      });
    }
  };
}

async function fixture(t, checkCommands) {
  const root = mkdtempSync(join(tmpdir(), "yui-integration-job-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const repositoryPath = join(root, "repository");
  git(["init", "-b", "master", repositoryPath]);
  git(["-C", repositoryPath, "config", "user.name", "Test"]);
  git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repositoryPath, "shared.txt"), "base\n");
  git(["-C", repositoryPath, "add", "shared.txt"]);
  git(["-C", repositoryPath, "commit", "-m", "base"]);
  const baseCommit = git(["-C", repositoryPath, "rev-parse", "HEAD"]).trim();

  const home = join(root, "home");
  mkdirSync(home);
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: workspaceRoot });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const project = createProject(
    store.nextProjectId(),
    "fixture",
    repositoryPath,
    { stable: "master", development: "master" },
    now
  );
  store.saveProject(project);
  const task = activateTask(createTask(store.nextTaskId(), "Check jobs", now, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "master" }]
  }), now);
  store.saveTask(task);
  store.saveRole(task.id, createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    repositoryPath,
    now
  ));

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => now);
  await preparer.prepareTaskWorkspace(task.id);
  const workItem = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "One edit",
    acceptance: [],
    dependsOn: [],
    assignee: "leader",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, workItem);
  const workspace = await preparer.prepareWorkItemWorkspace(task.id, workItem.id);
  const entry = workspace.entries.find(({ access }) => access === "write");
  writeFileSync(join(entry.path, "shared.txt"), "changed\n");
  git(["-C", entry.path, "add", "shared.txt"]);
  git(["-C", entry.path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "change"]);
  const running = updateWorkItemStatus(workItem, "running", now);
  store.saveWorkItem(task.id, running);
  const run = yieldAgentRun(createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Candidate ready.",
    now,
    { workItemId: workItem.id, workspace }
  ), "Candidate ready.", now);
  store.saveAgentRun(run);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: run.summary,
    source: { type: "run", runId: run.id },
    workspace
  }, now));
  const manager = new WorkItemChangeSetManager(store, () => now);
  const [changeSet] = await manager.capture(task.id, workItem.id);
  assert.notEqual(changeSet, undefined);

  const jobPort = fakeJobPort();
  const options = { now: () => now, jobPort };
  const ref = `${task.id}`;
  return {
    store,
    home,
    task,
    agent,
    project,
    changeSet,
    baseCommit,
    jobPort,
    options,
    ref,
    startIntegration: async () => runTaskIntegrationCommand(
      [
        "start", ref,
        "--change-set", changeSet.id,
        ...checkCommands.flatMap((command) => ["--check", command])
      ],
      store,
      home,
      options
    ),
    continueIntegration: async () => runTaskIntegrationCommand(
      ["continue", `${ref}/${store.listIntegrationAttempts(task.id).at(-1).id}`],
      store,
      home,
      options
    ),
    abortIntegration: async () => runTaskIntegrationCommand(
      ["abort", `${ref}/${store.listIntegrationAttempts(task.id).at(-1).id}`, "--reason", "no longer needed"],
      store,
      home,
      options
    )
  };
}

test("integration start with checks binds a DurableJob and leaves the attempt running", async (t) => {
  const f = await fixture(t, ["true", "printf done", "test 1 = 1"]);
  const result = await f.startIntegration();

  assert.equal(result.data.status, "checks-running");
  assert.match(result.output, /DurableJob job-1/);
  const attempt = f.store.listIntegrationAttempts(f.task.id).at(-1);
  assert.equal(attempt.status, "running");
  assert.equal(attempt.jobId, "job-1");
  assert.equal(f.jobPort.calls.starts, 1);
  assert.equal(f.jobPort.input.taskId, f.task.id);
  assert.equal(f.jobPort.input.integrationId, attempt.id);
  assert.equal(f.jobPort.input.projectId, f.project.id);
  assert.match(f.jobPort.input.head, /^[a-f0-9]{40}$/u);
  assert.equal(f.jobPort.input.workspace, result.data.workspace.path);
  assert.deepEqual(f.jobPort.input.steps.map((step) => step.name), ["check-1", "check-2", "check-3"]);
  assert.equal(f.jobPort.input.steps[0].timeoutMs, 30 * 60_000);
  // The legacy in-process check logs must not appear: checks run in the job.
  assert.equal(
    existsSync(join(f.home, "artifacts", "integration-checks", f.task.id, attempt.id)),
    false
  );
  const shown = await runTaskIntegrationCommand(
    ["show", `${f.ref}/${attempt.id}`],
    f.store,
    f.home
  );
  assert.match(shown.output, /Job: job-1/);
});

test("continue while the check job runs reports checks-running without a duplicate job", async (t) => {
  const f = await fixture(t, ["true"]);
  const started = await f.startIntegration();
  assert.equal(started.data.status, "checks-running");

  const again = await f.continueIntegration();

  assert.equal(again.data.status, "checks-running");
  assert.equal(f.jobPort.calls.starts, 1);
  assert.equal(f.jobPort.calls.gets, 1);
  const attempt = f.store.listIntegrationAttempts(f.task.id).at(-1);
  assert.equal(attempt.status, "running");
  assert.equal(attempt.jobId, "job-1");
});

test("a succeeded check job finalizes the attempt and advances the target ref", async (t) => {
  const f = await fixture(t, ["true", "printf done", "test 1 = 1"]);
  await f.startIntegration();
  f.jobPort.succeed();

  const result = await f.continueIntegration();

  assert.equal(result.data.status, "committed");
  const attempt = result.data.attempt;
  assert.equal(attempt.status, "committed");
  const advanced = git(["-C", f.project.path, "rev-parse", attempt.targetRef]).trim();
  assert.equal(advanced, attempt.candidateCommit);
  assert.notEqual(advanced, f.baseCommit);
  assert.equal(
    git(["-C", f.project.path, "show", `${attempt.targetRef}:shared.txt`]).trim(),
    "changed"
  );
  assert.deepEqual(attempt.checks.map((check) => check.outcome), ["passed", "passed", "passed"]);
  assert.equal(attempt.checks[0].logPath, `artifacts/jobs/${f.task.id}/job-1/logs/001-check-1.log`);
});

test("a failed check job fails the attempt without advancing the target ref", async (t) => {
  const f = await fixture(t, ["true", "exit 7", "false"]);
  await f.startIntegration();
  f.jobPort.fail();

  const result = await f.continueIntegration();

  assert.equal(result.data.status, "failed");
  const attempt = result.data.attempt;
  assert.equal(attempt.status, "failed");
  assert.equal(
    git(["-C", f.project.path, "rev-parse", attempt.targetRef]).trim(),
    f.baseCommit
  );
  assert.deepEqual(attempt.checks.map((check) => check.outcome), ["passed", "failed", "skipped"]);
  assert.match(attempt.checks[1].details, /code 7/);
});

test("an unproven check job fails closed: the attempt fails and the ref stays put", async (t) => {
  const f = await fixture(t, ["true", "printf done", "test 1 = 1"]);
  await f.startIntegration();
  f.jobPort.unknown();

  const result = await f.continueIntegration();

  assert.equal(result.data.status, "failed");
  const attempt = result.data.attempt;
  assert.equal(
    git(["-C", f.project.path, "rev-parse", attempt.targetRef]).trim(),
    f.baseCommit
  );
  // Fail-closed: without an exit record, no unreached step may read as skipped.
  assert.deepEqual(attempt.checks.map((check) => check.outcome), ["passed", "failed", "failed"]);
  assert.match(attempt.checks[1].details, /unknown-needs-attention/);
  assert.match(attempt.checks[1].details, /exit\.json/);
});

test("a cancelled check job fails the attempt without advancing the target ref", async (t) => {
  const f = await fixture(t, ["true"]);
  await f.startIntegration();
  f.jobPort.cancelled();

  const result = await f.continueIntegration();

  assert.equal(result.data.status, "failed");
  assert.equal(
    git(["-C", f.project.path, "rev-parse", result.data.attempt.targetRef]).trim(),
    f.baseCommit
  );
});

test("a succeeded check job cannot commit a workspace head that differs from the checked SHA", async (t) => {
  const f = await fixture(t, ["true"]);
  const started = await f.startIntegration();
  const candidatePath = started.data.workspace.path;
  writeFileSync(join(candidatePath, "unchecked.txt"), "not covered by the job\n");
  git(["-C", candidatePath, "add", "unchecked.txt"]);
  git([
    "-C", candidatePath,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "-m", "unchecked change"
  ]);
  f.jobPort.succeed();

  const result = await f.continueIntegration();

  assert.equal(result.data.status, "failed");
  assert.equal(
    git(["-C", f.project.path, "rev-parse", result.data.attempt.targetRef]).trim(),
    f.baseCommit
  );
});

test("a Leader exit after job acceptance but before attempt binding converges on the terminal retry", async (t) => {
  const f = await fixture(t, ["true"]);
  const statePath = join(f.home, "state.json");
  let beforeBinding;
  f.jobPort.setBeforeStartReturn(() => {
    if (beforeBinding === undefined) beforeBinding = readFileSync(statePath, "utf8");
  });
  await f.startIntegration();
  f.jobPort.succeed();

  // This is the valid durable snapshot at the exact process-loss boundary:
  // the Controller accepted the idempotent Job, while the attempt still has
  // no jobId. The worktree and terminal Controller Job survive the Leader.
  writeFileSync(statePath, beforeBinding);
  const result = await f.continueIntegration();

  assert.equal(result.data.status, "committed");
  assert.equal(f.jobPort.calls.starts, 2);
});

test("abort requests the check job cancel and fails the attempt", async (t) => {
  const f = await fixture(t, ["true"]);
  await f.startIntegration();

  const aborted = await f.abortIntegration();

  assert.match(aborted.output, /Aborted Integration/);
  assert.equal(f.jobPort.calls.cancels, 1);
  const attempt = f.store.listIntegrationAttempts(f.task.id).at(-1);
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.checks.at(-1).name, "aborted");
});

// ─── rr6/f2: Integration commands start a stopped Controller on demand ──────

test("rr6/f2: task integration start starts a stopped Controller on demand", async (t) => {
  const fx = await fixture(t, ["true"]);
  // rr13: Save an active in-flight Leader Run + caller key hash so the
  // managed Session caller can be verified against durable Run state.
  const assertion = saveActiveLeaderAssertion(fx.store, fx.task, fx.agent, now);
  // Stop the auto-started Controller; cleanup regardless of the outcome.
  t.after(async () => {
    await stopFileTaskController(fx.home).catch(() => undefined);
  });
  // No Controller is running. The Controller job port routes through
  // callFileTaskController: on CONTROLLER_NOT_RUNNING it spawns the per-Home
  // Controller and retries job.start. A bare callController would fail here.
  // rr13: Use a managed Session env so the caller resolves as a verified
  // task-scope Leader with the per-Session caller key. The liveness seam
  // keeps the Controller's startup pass from reaping the assertion Run
  // without a real tmux role.
  const managedEnv = {
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: fx.task.id,
    YUI_ROLE: "leader",
    YUI_LEADER_ACTION_RUN_ID: assertion.runId,
    YUI_LEADER_ACTION_RECEIPT_ID: assertion.receiptId,
    YUI_JOB_CALLER_KEY: assertion.callerKey,
    YUI_TEST_ROLE_LIVENESS_PRESENT: "1"
  };
  const jobPort = createControllerIntegrationJobPort(fx.home, {
    environment: managedEnv,
    store: fx.store
  });
  const result = await runTaskIntegrationCommand(
    [
      "start", `${fx.task.id}`,
      "--change-set", fx.changeSet.id,
      "--check", "true"
    ],
    fx.store,
    fx.home,
    { now: () => now, jobPort, environment: managedEnv }
  );
  assert.equal(result.data.status, "checks-running");
  assert.ok(result.data.job.id, "the check job must be started");
  assert.equal(result.data.attempt.status, "running");
  // Stop the Controller inline so the fixture's rmSync cleanup (registered
  // before the t.after safety net above) runs after the Controller has exited,
  // avoiding ENOTEMPTY races on the temp directory.
  await stopFileTaskController(fx.home).catch(() => undefined);
});
