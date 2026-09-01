import assert from "node:assert/strict";
import test from "node:test";

import { planReplicatedWorkItemLanes } from "../../dist/commands/taskCommands.js";
import { projectWorkItemExecution } from "../../dist/execution/workItemExecutionProjection.js";

const at = "2026-09-02T00:00:00.000Z";
const effective = {
  schemaVersion: 3,
  sourceDesiredRevision: 1,
  agentId: "codex",
  adapterId: "codex",
  profileAccess: "write",
  search: false,
  writeProjectIds: [],
  workspace: { root: "/tmp/yui-projection", entries: [] },
  context: { instructions: [], skills: [] },
  contextProtocolVersion: 1,
  sessionManifestCompatibilityDigest: "0".repeat(64),
  permission: { strategy: "default" }
};

function workItem(overrides = {}) {
  return {
    schemaVersion: 14,
    id: "work-item-1",
    taskId: "task-1",
    title: "Projection contract",
    objective: "Project exact WorkItem facts",
    acceptance: [],
    dependsOn: [],
    writeProjectIds: [],
    executionGroups: [],
    revision: 1,
    assignee: "implementer",
    status: "running",
    candidates: [],
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

function turn(id, roleName, status, lineage = {}, producer = false) {
  return {
    schemaVersion: 3,
    id,
    taskId: "task-1",
    roleName,
    mode: "new",
    inputs: [{
      sequence: 1,
      submittedAt: at,
      input: { schemaVersion: 1, source: { type: "yui", channel: "workitem-dispatch" }, directive: "Do it" }
    }],
    purpose: "execution",
    workItemId: "work-item-1",
    ...lineage,
    effective,
    status,
    ...(status === "active" ? {} : {
      result: {
        schemaVersion: 1,
        output: status === "completed" ? "done" : "failed",
        completedAt: at,
        ...(status === "failed" ? { failureReason: "runtime-failed" } : {}),
        ...(producer ? {
          producer: {
            schemaVersion: 1,
            summary: "producer result",
            checks: [],
            findings: [],
            evidence: [],
            codeRefs: []
          }
        } : {})
      }
    }),
    createdAt: at,
    updatedAt: at
  };
}

function replicatedGroup(dispositions) {
  const roles = ["producer-a", "producer-b", "producer-c"];
  return {
    schemaVersion: 2,
    id: "execution-group-1",
    taskId: "task-1",
    assignment: {
      schemaVersion: 1,
      input: "Do it",
      objective: "Project exact WorkItem facts",
      acceptance: [],
      contextSnapshotRef: {
        schemaVersion: 1,
        id: "context-snapshot-1",
        taskId: "task-1",
        scope: "task",
        sequence: 1,
        digest: "0".repeat(64)
      },
      taskId: "task-1",
      workItemId: "work-item-1",
      workItemRevision: 1,
      projects: [],
      dependencyFacts: []
    },
    lanes: dispositions.map((disposition, index) => ({
      schemaVersion: 2,
      id: `execution-group-1-lane-${index + 1}`,
      groupId: "execution-group-1",
      ordinal: index + 1,
      roleName: roles[index],
      effective,
      workspace: { root: `/tmp/yui-projection-${index + 1}`, writableProjectIds: [] },
      currentTurnId: `producer-turn-${index + 1}`,
      ...(disposition === "succeeded" ? { successfulTurnId: `producer-turn-${index + 1}` } : {}),
      disposition,
      createdAt: at,
      updatedAt: at,
      ...(disposition === "open" ? {} : { endedAt: at })
    })),
    createdAt: at,
    updatedAt: at
  };
}

test("WorkItem lane preflight has one deterministic direct or replicated shape", () => {
  assert.deepEqual(planReplicatedWorkItemLanes("main", [], "execution-group-1"), {
    roles: [],
    laneIds: []
  });
  assert.throws(
    () => planReplicatedWorkItemLanes("main", ["producer-a"], "execution-group-1"),
    /Exactly one --lane-role is invalid/u
  );
  assert.deepEqual(
    planReplicatedWorkItemLanes("main", ["producer-a", "producer-b"], "execution-group-1").laneIds,
    ["execution-group-1-lane-1", "execution-group-1-lane-2"]
  );
  assert.equal(
    planReplicatedWorkItemLanes("main", ["producer-a", "producer-b", "producer-c"], "execution-group-1").roles.length,
    3
  );
  assert.throws(
    () => planReplicatedWorkItemLanes("main", ["producer-a", "producer-a"], "execution-group-1"),
    /distinct Task Role/u
  );
  assert.throws(
    () => planReplicatedWorkItemLanes("main", ["main", "producer-a"], "execution-group-1"),
    /cannot be the WorkItem assignee/u
  );
});

test("the shared projection exposes direct main Turn recovery without inventing Session facts", () => {
  const active = turn("main-turn-1", "implementer", "active");
  let projection = projectWorkItemExecution(workItem(), [active]);
  assert.equal(projection.shape, "direct");
  assert.equal(projection.mainTurn.status, "running");
  assert.equal(projection.mainTurn.session, "unobserved");
  assert.equal(projection.nextAction.kind, "wait-for-main");

  const failed = turn("main-turn-1", "implementer", "failed");
  projection = projectWorkItemExecution(workItem(), [failed]);
  assert.equal(projection.mainTurn.status, "needs-attention");
  assert.equal(projection.nextAction.kind, "retry-main");
  assert.deepEqual(projection.nextAction.targetIds, ["main-turn-1"]);

  const completed = turn("main-turn-1", "implementer", "completed");
  projection = projectWorkItemExecution(workItem(), [completed]);
  assert.equal(projection.mainTurn.status, "succeeded");
  assert.equal(projection.nextAction.kind, "submit-candidate");
});

test("replicated projection blocks early synthesis and preserves exact Candidate provenance", () => {
  const producers = [
    turn("producer-turn-1", "producer-a", "completed", {
      executionGroupId: "execution-group-1",
      executionLaneId: "execution-group-1-lane-1"
    }, true),
    turn("producer-turn-2", "producer-b", "completed", {
      executionGroupId: "execution-group-1",
      executionLaneId: "execution-group-1-lane-2"
    }, true),
    turn("producer-turn-3", "producer-c", "active", {
      executionGroupId: "execution-group-1",
      executionLaneId: "execution-group-1-lane-3"
    })
  ];
  let group = replicatedGroup(["succeeded", "succeeded", "open"]);
  let item = workItem({ executionGroups: [group], currentExecutionGroupId: group.id });
  let projection = projectWorkItemExecution(item, producers);
  assert.equal(projection.shape, "replicated");
  assert.equal(projection.synthesis.status, "blocked-by-open-lanes");
  assert.equal(projection.nextAction.kind, "wait-for-lanes");

  const failedProducer = turn("producer-turn-3", "producer-c", "failed", {
    executionGroupId: "execution-group-1",
    executionLaneId: "execution-group-1-lane-3"
  });
  projection = projectWorkItemExecution(item, [...producers.slice(0, 2), failedProducer]);
  assert.equal(projection.lanes[2].status, "needs-attention");
  assert.equal(projection.nextAction.kind, "retry-or-settle-lanes");
  assert.deepEqual(projection.nextAction.targetIds, ["producer-turn-3"]);

  group = replicatedGroup(["succeeded", "succeeded", "failed"]);
  item = workItem({ executionGroups: [group], currentExecutionGroupId: group.id });
  projection = projectWorkItemExecution(item, [...producers.slice(0, 2), failedProducer]);
  assert.equal(projection.synthesis.status, "eligible");
  assert.equal(projection.nextAction.kind, "await-main-dispatch");

  const failedMain = turn("main-turn-1", "implementer", "failed", {
    sourceExecutionGroupId: group.id
  });
  projection = projectWorkItemExecution(item, [...producers, failedMain]);
  assert.equal(projection.synthesis.status, "main-needs-attention");
  assert.equal(projection.nextAction.kind, "retry-main");

  const successfulMain = turn("main-turn-2", "implementer", "completed", {
    sourceExecutionGroupId: group.id
  });
  item = workItem({
    executionGroups: [group],
    currentExecutionGroupId: group.id,
    status: "awaiting_acceptance",
    candidates: [{
      schemaVersion: 3,
      id: "candidate-1",
      taskId: "task-1",
      workItemId: "work-item-1",
      sequence: 1,
      workItemRevision: 2,
      summary: "main result",
      source: { type: "turn", turnId: successfulMain.id },
      createdAt: at
    }]
  });
  projection = projectWorkItemExecution(item, [...producers, failedMain, successfulMain]);
  assert.equal(projection.synthesis.status, "complete");
  assert.equal(projection.candidate.status, "observed");
  assert.equal(projection.candidate.mainTurnId, successfulMain.id);
  assert.deepEqual(projection.candidate.successfulLaneTurns, [
    { laneId: "execution-group-1-lane-1", successfulTurnId: "producer-turn-1" },
    { laneId: "execution-group-1-lane-2", successfulTurnId: "producer-turn-2" }
  ]);

  const missingProducer = { ...producers[0], result: { ...producers[0].result, producer: undefined } };
  projection = projectWorkItemExecution(item, [missingProducer, producers[1], successfulMain]);
  assert.equal(projection.candidate.status, "unknown");

  item.candidates = [{ ...item.candidates[0], source: { type: "turn", turnId: "producer-turn-1" } }];
  projection = projectWorkItemExecution(item, [...producers, successfulMain]);
  assert.equal(projection.candidate.status, "unknown");
  assert.equal(projection.candidate.observation, "unobserved");
});
