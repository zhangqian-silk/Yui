import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createProject } from "../../dist/repository/project.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { projectCompletionReadiness } from "../../dist/task/completionReadiness.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { planRepairWave } from "../../dist/task/repairWave.js";
import { createTask, taskDeliveryPath } from "../../dist/task/task.js";

const now = new Date("2026-08-24T00:00:00.000Z");
const binding = {
  projectId: "project-1",
  directory: "app",
  baseRef: "master"
};

function nextActionFacts(task) {
  return {
    task,
    workItems: [],
    changeSets: [],
    integrations: [],
    reviewRounds: [],
    reviewConfig: { roleName: "reviewer", trigger: "final" },
    openInputRequests: [],
    activeRuns: [],
    leaderRuns: []
  };
}

function completionFacts(task, overrides = {}) {
  return {
    ...nextActionFacts(task),
    agentRuns: [],
    roleSessionSets: [],
    managedWorkspaces: [],
    durableJobs: [],
    integrationQueueEntries: [],
    reviewFindings: [],
    reviewFindingLedgerMode: "off",
    events: [],
    ...overrides
  };
}

function configuredStore(t, prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveConfiguredAgent(createConfiguredAgent(
    "codex",
    "codex",
    "codex",
    [],
    [],
    now
  ));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "codex" });
  store.saveProject(createProject(
    binding.projectId,
    "app",
    home,
    { stable: "master", development: "master" },
    now
  ));
  return store;
}

test("Project Tasks expose direct and integrated delivery without a schema fork", () => {
  assert.equal(taskDeliveryPath(createTask("task-1", "metadata", now)), "no-project");
  const direct = {
    ...createTask("task-2", "fast fix", now, { projectBindings: [binding] }),
    status: "active"
  };
  assert.equal(taskDeliveryPath(direct), "direct");
  assert.equal(taskDeliveryPath(createTask("task-3", "guarded fix", now, {
    projectBindings: [binding],
    requireIntegration: true
  })), "integrated");

  const action = projectNextAction(nextActionFacts(direct));
  assert.equal(action.kind, "complete-task");
  assert.equal(action.alternatives?.[0]?.kind, "promote-to-integrated-delivery");
  assert.equal(
    action.alternatives?.[0]?.recommendedCommand,
    "yui task update task-2 --delivery integrated"
  );

  const obligated = projectNextAction({
    ...nextActionFacts(direct),
    reviewRounds: [{
      id: "review-round-1",
      taskId: direct.id,
      scope: "task",
      status: "pending",
      reviewerRoleName: "reviewer"
    }]
  });
  assert.equal(obligated.kind, "resume-review");
  assert.equal(obligated.recommendedCommand, "yui task review retry task-2/review-round-1");
});

test("the CLI selects delivery explicitly and never downgrades integrated Tasks", (t) => {
  const store = configuredStore(t, "yui-agile-delivery-");
  assert.throws(() => runTaskCommand([
    "create", "metadata only", "--require-integration"
  ], store, { now: () => now }), /requires at least one --project/u);
  const direct = runTaskCommand([
    "create", "fast fix", "--project", binding.projectId, "--delivery", "direct"
  ], store, { now: () => now });
  assert.equal(direct.data.deliveryPath, "direct");
  const promoted = runTaskCommand([
    "update", direct.data.task.id, "--delivery", "integrated"
  ], store, { now: () => now });
  assert.match(promoted.output, /Delivery: integrated/u);

  const integrated = runTaskCommand([
    "create", "guarded fix", "--project", binding.projectId, "--delivery", "integrated"
  ], store, { now: () => now });
  assert.equal(integrated.data.deliveryPath, "integrated");
  assert.throws(() => runTaskCommand([
    "update", integrated.data.task.id, "--delivery", "direct"
  ], store, { now: () => now }), /cannot be downgraded/u);

  const activeDirect = {
    ...createTask("task-99", "active direct fix", now, { projectBindings: [binding] }),
    status: "active"
  };
  store.saveTask(activeDirect);
  assert.throws(() => runTaskCommand([
    "update", activeDirect.id, "--delivery", "integrated"
  ], store, { now: () => now }), /CLI-verified clean Task-main snapshot/u);
});

test("direct Project completion still requires a CLI-verified committed head", (t) => {
  const store = configuredStore(t, "yui-agile-completion-");
  const task = {
    ...createTask("task-1", "fast fix", now, { projectBindings: [binding] }),
    status: "active"
  };
  store.saveTask(task);
  assert.throws(() => runTaskCommand([
    "complete", task.id, "--summary", "done"
  ], store, { now: () => now }), /Project heads were not verified for delivery/u);

  const commit = "a".repeat(40);
  const completed = runTaskCommand([
    "complete", task.id, "--summary", "verified direct fix"
  ], store, {
    now: () => now,
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: binding.projectId, commit }]
    }
  });
  assert.match(completed.output, /Completed task task-1/u);
  assert.equal(store.getTask(task.id).status, "completed");
  const event = store.listEvents(task.id).find(({ type }) => type === "task.completed");
  assert.equal(event?.payload.deliveryPath, "direct");
  assert.equal(event?.payload.projectHeads, `${binding.projectId}@${commit}`);
});

test("terminal child worktrees advise at completion and repair defaults converge", () => {
  const task = {
    ...createTask("task-1", "guarded fix", now, { projectBindings: [binding] }),
    status: "active"
  };
  const readiness = projectCompletionReadiness(completionFacts(task, {
    workItems: [{ id: "work-item-1", status: "completed" }],
    managedWorkspaces: [{
      schemaVersion: 2,
      owner: { type: "work-item", taskId: task.id, workItemId: "work-item-1" },
      root: "/tmp/work-item-1",
      entries: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    }]
  }));
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.advisories.map(({ code }) => code), [
    "work-item-workspace-undisposed"
  ]);

  const findings = [
    { id: "finding-1", severity: "p1", summary: "first", paths: ["src/one.ts"], source: "structured" },
    { id: "finding-2", severity: "p2", summary: "second", paths: ["src/two.ts"], source: "structured" }
  ];
  assert.equal(planRepairWave("review-round-1", findings).groups.length, 1);
  assert.equal(planRepairWave("review-round-1", findings, "parallel").groups.length, 2);
});
