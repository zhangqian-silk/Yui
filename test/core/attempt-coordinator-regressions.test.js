import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createTaskBrief } from "../../dist/brief/taskBrief.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  AttemptCoordinator,
  selectExecutor
} from "../../dist/execution/attemptCoordinator.js";
import {
  completeExecutionAttempt,
  createExecutionAttempt,
  interruptExecutionAttempt
} from "../../dist/execution/executionAttempt.js";
import { createTaskMessage } from "../../dist/message/message.js";
import {
  createAgentProfile,
  updateAgentProfile
} from "../../dist/profile/agentProfile.js";
import { createProject } from "../../dist/repository/project.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  retryFailedWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

const now = new Date("2026-07-26T00:00:00.000Z");

test("Project read Attempts execute in the Project checkout", async () => {
  const fixture = createFixture({ access: "read", repository: true });
  let cwd;
  const coordinator = new AttemptCoordinator(fixture.home, fixture.store, {
    async execute(request) {
      cwd = request.cwd;
      return { result: { summary: "inspected" } };
    },
    async interrupt() {}
  }, () => now);

  await coordinator.dispatch({
    workItemId: fixture.work.id,
    executor: "session",
    sessionReason: "Test fixture"
  });
  assert.equal(cwd, fixture.repositoryPath);
});

test("Attempt dispatch resolves and validates configured Profile Skills before execution", async () => {
  const fixture = createFixture({ access: "read" });
  const skillPath = join(fixture.home, "skills", "custom-review");
  mkdirSync(skillPath, { recursive: true });
  writeFileSync(join(skillPath, "SKILL.md"), "# Custom review\n\nInspect the requested evidence.\n");
  fixture.store.saveAgentProfile(updateAgentProfile(
    fixture.store.getAgentProfile("worker"),
    { skills: ["custom-review"] },
    new Date("2026-07-26T00:01:00.000Z")
  ));
  let skills;
  const coordinator = new AttemptCoordinator(fixture.home, fixture.store, {
    async execute(request) {
      skills = request.skills;
      return { result: { summary: "inspected" } };
    },
    async interrupt() {}
  }, () => now);

  await coordinator.dispatch({
    workItemId: fixture.work.id,
    executor: "session",
    sessionReason: "Test fixture"
  });
  assert.equal(skills[0].id, "yui-worker");
  assert.deepEqual(skills[1], {
    id: "custom-review",
    path: skillPath,
    content: "# Custom review\n\nInspect the requested evidence."
  });
});

test("Attempt input points Workers to authoritative Yui context instead of copying mutable context", async () => {
  const fixture = createFixture({ access: "read", repository: true });
  fixture.store.saveTaskBrief(fixture.task.id, createTaskBrief({
    objective: "BRIEF-MUST-NOT-BE-COPIED",
    boundaries: ["MESSAGE-MUST-NOT-BE-COPIED"],
    currentFocus: "Keep context authoritative",
    leaderSummary: "Read through Yui",
    updatedBy: "leader"
  }, now));
  fixture.store.saveMessage(fixture.task.id, createTaskMessage(
    fixture.store.nextMessageId(fixture.task.id),
    "MESSAGE-MUST-NOT-BE-COPIED",
    "user",
    { type: "user" },
    now
  ));
  let input;
  const coordinator = new AttemptCoordinator(fixture.home, fixture.store, {
    async execute(request) {
      input = request.input;
      return { result: { summary: "inspected" } };
    },
    async interrupt() {}
  }, () => now);

  await coordinator.dispatch({
    workItemId: fixture.work.id,
    executor: "session",
    sessionReason: "Context boundary test",
    input: "Inspect the current records."
  });

  assert.match(input, new RegExp(`yui task context ${fixture.task.id}`));
  assert.match(input, new RegExp(`yui project show ${fixture.task.projectId}`));
  assert.match(input, new RegExp(`yui project knowledge list ${fixture.task.projectId}`));
  assert.match(input, /Inspect the current records/);
  assert.doesNotMatch(input, /BRIEF-MUST-NOT-BE-COPIED/);
  assert.doesNotMatch(input, /MESSAGE-MUST-NOT-BE-COPIED/);
});

test("Attempt execution receives only operational and explicitly bound Agent environment", async () => {
  const fixture = createFixture({
    access: "read",
    environmentBindings: [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "WORKER_OPENAI_KEY",
      required: true
    }]
  });
  let environment;
  const source = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/yui-agent-home",
    CODEX_HOME: "/tmp/codex-home",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    WORKER_OPENAI_KEY: "bound-secret",
    ARBITRARY_SECRET: "must-not-leak",
    YUI_HOME: "/forged/yui-home",
    YUI_TASK_ID: fixture.task.id,
    YUI_ROLE: "leader"
  };
  const coordinator = new AttemptCoordinator(fixture.home, fixture.store, {
    async execute(request) {
      environment = request.environment;
      return { result: { summary: "inspected" } };
    },
    async interrupt() {}
  }, () => now, source);

  await coordinator.dispatch({
    workItemId: fixture.work.id,
    executor: "session",
    sessionReason: "Environment boundary test"
  });
  assert.equal(environment.OPENAI_API_KEY, "bound-secret");
  assert.equal(environment.CODEX_HOME, "/tmp/codex-home");
  assert.equal(environment.PATH, "/usr/bin:/bin");
  assert.equal(environment.ARBITRARY_SECRET, undefined);
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
  assert.equal(environment.WORKER_OPENAI_KEY, undefined);
  assert.equal(environment.YUI_HOME, fixture.home);
  assert.equal(environment.YUI_TASK_ID, undefined);
  assert.equal(environment.YUI_ROLE, undefined);
});

test("a failed executor check fails both the Attempt and Work Item and remains retryable", async () => {
  const fixture = createFixture({ access: "read" });
  const inputs = [];
  const revisions = [];
  const coordinator = new AttemptCoordinator(fixture.home, fixture.store, {
    async execute(request) {
      inputs.push(request.input);
      revisions.push(request.profile.revision);
      return {
        result: {
          summary: "implementation produced a regression",
          checks: [{ name: "npm test", outcome: "failed", details: "1 failed" }]
        }
      };
    },
    async interrupt() {}
  }, () => now);

  const first = await coordinator.dispatch({
    workItemId: fixture.work.id,
    executor: "session",
    sessionReason: "Test fixture"
  });
  assert.equal(first.attempt.state, "failed");
  assert.equal(first.workItem.status, "failed");
  assert.equal(first.attempt.result.checks[0].outcome, "failed");
  fixture.store.saveAgentProfile(updateAgentProfile(
    fixture.store.getAgentProfile("worker"),
    { description: "A newer Profile revision that the retry must not adopt." },
    new Date("2026-07-26T00:01:00.000Z")
  ));

  const second = await coordinator.dispatch({
    workItemId: fixture.work.id,
    profileRevision: first.attempt.profileRevision,
    exactInput: first.attempt.input,
    executor: "session",
    sessionReason: "Retry test fixture"
  });
  assert.equal(inputs[1], inputs[0]);
  assert.deepEqual(revisions, [1, 1]);
  assert.equal(second.attempt.state, "failed");
});

test("one Work Item cannot be dispatched twice while its first Attempt is running", async () => {
  const fixture = createFixture({ access: "read" });
  let finish;
  let executionStarted;
  const started = new Promise((resolve) => {
    executionStarted = resolve;
  });
  const first = new AttemptCoordinator(fixture.home, fixture.store, {
    execute() {
      return new Promise((resolve) => {
        finish = () => resolve({ result: { summary: "done" } });
        executionStarted();
      });
    },
    async interrupt() {}
  }, () => now).dispatch({
    workItemId: fixture.work.id,
    executor: "session",
    sessionReason: "First test fixture"
  });
  await started;

  await assert.rejects(
    new AttemptCoordinator(fixture.home, fixture.store, {
      async execute() {
        throw new Error("must not execute");
      },
      async interrupt() {}
    }, () => now).dispatch({
      workItemId: fixture.work.id,
      executor: "session",
      sessionReason: "Second test fixture"
    }),
    /cannot dispatch from running/
  );
  finish();
  await first;
  assert.equal(fixture.store.listExecutionAttempts(fixture.task.id).length, 1);
});

test("an externally interrupted Attempt remains interrupted when its executor settles", async () => {
  const fixture = createFixture({ access: "read" });
  const coordinator = new AttemptCoordinator(fixture.home, fixture.store, {
    async execute(_request, started) {
      started({
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1"
      });
      const running = fixture.store.listExecutionAttempts(fixture.task.id)[0];
      const interrupted = interruptExecutionAttempt(running, "Interrupted by user.", now);
      fixture.store.transaction((tx) => {
        tx.saveExecutionAttempt(fixture.task.id, interrupted);
        tx.saveWorkItem(
          fixture.task.id,
          updateWorkItemStatus(
            tx.getWorkItem(fixture.task.id, fixture.work.id),
            "failed",
            now,
            "Interrupted by user."
          )
        );
      });
      return { result: { summary: "late result" } };
    },
    async interrupt() {}
  }, () => now);

  const result = await coordinator.dispatch({
    workItemId: fixture.work.id,
    executor: "session",
    sessionReason: "Interruption test fixture"
  });
  assert.equal(result.attempt.state, "interrupted");
  assert.equal(result.workItem.status, "failed");
});

test("Leader acceptance uses the most recently completed successful Attempt", () => {
  const fixture = createFixture({ access: "read" });
  const profile = fixture.store.getAgentProfile("worker");
  let commandNow = new Date("2026-07-26T00:01:30.000Z");
  const leaderOptions = {
    now: () => commandNow,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: fixture.task.id,
      YUI_ROLE: "leader"
    }
  };
  let oldAttempt = createExecutionAttempt({
    id: "attempt-z-old",
    taskId: fixture.task.id,
    workItemId: fixture.work.id,
    profileId: profile.id,
    profileRevision: profile.revision,
    executor: "session",
    access: "read",
    input: "Old result",
    sessionReason: "Old result fixture"
  }, now);
  fixture.store.saveExecutionAttempt(fixture.task.id, oldAttempt);
  fixture.store.saveWorkItem(
    fixture.task.id,
    updateWorkItemStatus(fixture.work, "running", now)
  );
  oldAttempt = completeExecutionAttempt(
    oldAttempt,
    { summary: "Old successful result" },
    new Date("2026-07-26T00:01:00.000Z")
  );
  fixture.store.saveExecutionAttempt(fixture.task.id, oldAttempt);
  fixture.store.saveWorkItem(
    fixture.task.id,
    updateWorkItemStatus(
      fixture.store.getWorkItem(fixture.task.id, fixture.work.id),
      "awaiting_acceptance",
      new Date("2026-07-26T00:01:00.000Z")
    )
  );
  runTaskCommand(
    ["work", "reject", fixture.work.id, "--summary", "Retry with newer evidence."],
    fixture.store,
    leaderOptions
  );

  fixture.store.saveWorkItem(
    fixture.task.id,
    retryFailedWorkItem(
      fixture.store.getWorkItem(fixture.task.id, fixture.work.id),
      new Date("2026-07-26T00:02:00.000Z")
    )
  );
  let newAttempt = createExecutionAttempt({
    id: "attempt-a-new",
    taskId: fixture.task.id,
    workItemId: fixture.work.id,
    profileId: profile.id,
    profileRevision: profile.revision,
    executor: "session",
    access: "read",
    input: "New result",
    sessionReason: "New result fixture"
  }, new Date("2026-07-26T00:02:00.000Z"));
  fixture.store.saveExecutionAttempt(fixture.task.id, newAttempt);
  newAttempt = completeExecutionAttempt(
    newAttempt,
    { summary: "New successful result" },
    new Date("2026-07-26T00:03:00.000Z")
  );
  fixture.store.saveExecutionAttempt(fixture.task.id, newAttempt);
  fixture.store.saveWorkItem(
    fixture.task.id,
    updateWorkItemStatus(
      fixture.store.getWorkItem(fixture.task.id, fixture.work.id),
      "awaiting_acceptance",
      new Date("2026-07-26T00:03:00.000Z")
    )
  );

  commandNow = new Date("2026-07-26T00:04:00.000Z");
  runTaskCommand(
    ["work", "accept", fixture.work.id, "--summary", "Latest evidence accepted."],
    fixture.store,
    leaderOptions
  );
  const accepted = fixture.store.listEvents(fixture.task.id)
    .findLast((event) => event.type === "work.accepted");
  assert.equal(accepted.payload.attemptId, newAttempt.id);
});

test("unsupported inline execution is rejected", () => {
  assert.throws(
    () => selectExecutor("inline", { parentThreadId: "leader-thread" }),
    /Unsupported Attempt execution mode/
  );
});

test("canonical runtime ids stay unique across simultaneous store instances", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-id-"));
  ensureStorageSchema(home, now);
  const first = new FileTaskStore(home);
  const second = new FileTaskStore(home);

  assert.notEqual(first.nextExecutionAttemptId("task-1"), second.nextExecutionAttemptId("task-1"));
  assert.notEqual(first.nextChangeSetId("task-1"), second.nextChangeSetId("task-1"));
  assert.notEqual(first.nextIntegrationAttemptId("task-1"), second.nextIntegrationAttemptId("task-1"));
});

function createFixture({
  access,
  repository = false,
  adapterId = "codex",
  environmentBindings = []
}) {
  const root = mkdtempSync(join(tmpdir(), "yui-attempt-regression-"));
  const home = join(root, "home");
  mkdirSync(home);
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: workspace });
  const agentId = adapterId;
  store.saveConfiguredAgent(createConfiguredAgent(
    agentId,
    adapterId,
    adapterId === "codex" ? "codex" : "claude",
    [],
    environmentBindings,
    now
  ));
  store.saveAgentProfile(profileFixture("worker", access, adapterId));
  let projectId;
  let repositoryPath;
  if (repository) {
    repositoryPath = join(root, "repository");
    execFileSync("git", ["init", "-b", "master", repositoryPath]);
    execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repositoryPath, "config", "user.email", "test@example.com"]);
    writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repositoryPath, "add", "README.md"]);
    execFileSync("git", ["-C", repositoryPath, "commit", "-m", "fixture"]);
    const project = createProject(
      store.nextProjectId(),
      "fixture",
      repositoryPath,
      { stable: "master", development: "master" },
      now
    );
    store.saveProject(project);
    projectId = project.id;
  }
  const task = activateTask(createTask(store.nextTaskId(), "Attempt regressions", now, {
    ...(projectId === undefined ? {} : { projectId, baseRef: "master" })
  }), now);
  store.saveTask(task);
  const work = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Execute work",
    objective: "Produce a validated result.",
    acceptance: [],
    dependsOn: []
  }, now);
  store.saveWorkItem(task.id, work);
  return { home, store, task, work, repositoryPath };
}

function profileFixture(id, access, adapterId) {
  return createAgentProfile({
    id,
    agentId: adapterId,
    defaultAccess: access,
  }, now);
}
