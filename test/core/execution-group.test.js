import assert from "node:assert/strict";
import test from "node:test";

import {
  addExecutionLane,
  assertExecutionGroupTransition,
  assertExecutionTargetUnchanged,
  createExecutionGroup,
  recordExecutionLaneResult,
  restartExecutionLane,
  resolveExecutionGroup,
  summarizeExecutionGroup,
  updateExecutionLane
} from "../../dist/execution/executionGroup.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");
const COMMIT = "a".repeat(40);

function target(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "work-item",
    taskId: "task-23",
    workItemId: "work-item-1",
    revision: 1,
    projects: [{ projectId: "project-1", commit: COMMIT }],
    fingerprint: "target-v1",
    ...overrides
  };
}

test("single execution is the default one-lane group and freezes its target", () => {
  const group = createExecutionGroup("execution-group-1", "task-23", {
    purpose: "execution",
    target: target(),
    roleName: "worker"
  }, NOW);

  assert.equal(group.strategy.mode, "fixed");
  assert.equal(group.strategy.count, 1);
  assert.equal(group.lanes.length, 1);
  assert.equal(group.lanes[0].roleName, "worker");
  assert.doesNotThrow(() => assertExecutionTargetUnchanged(group, target()));
  assert.throws(
    () => assertExecutionTargetUnchanged(group, target({ revision: 2, fingerprint: "target-v2" })),
    /create a new Group/
  );
});

test("adaptive groups add independent lanes but reject writable workspace sharing", () => {
  const group = createExecutionGroup("execution-group-1", "task-23", {
    purpose: "execution",
    strategy: { mode: "adaptive", max: 2 },
    target: target(),
    lanes: [{ roleName: "worker", workspace: { root: "/tmp/lane-1", writableProjectIds: ["project-1"] } }]
  }, NOW);
  const expanded = addExecutionLane(group, {
    roleName: "worker",
    workspace: { root: "/tmp/lane-2", writableProjectIds: ["project-1"] }
  }, NOW);
  assert.equal(expanded.lanes.length, 2);
  assert.notEqual(expanded.lanes[0].workspace.root, expanded.lanes[1].workspace.root);
  assert.throws(
    () => createExecutionGroup("execution-group-2", "task-23", {
      purpose: "execution",
      strategy: { mode: "fixed", count: 2 },
      target: target(),
      lanes: [
        { roleName: "worker", workspace: { root: "/tmp/shared", writableProjectIds: ["project-1"] } },
        { roleName: "worker", workspace: { root: "/tmp/shared", writableProjectIds: ["project-1"] } }
      ]
    }, NOW),
    /workspace is shared/
  );
});

test("Leader aggregation retains every lane and refuses to hide an open high finding", () => {
  let group = createExecutionGroup("execution-group-1", "task-23", {
    purpose: "review",
    strategy: { mode: "fixed", count: 2 },
    target: target({ kind: "task-final-review", workItemId: undefined, candidateId: "candidate-1" }),
    lanes: [
      { roleName: "reviewer", reviewRoundId: "review-round-1" },
      { roleName: "reviewer", id: "two", reviewRoundId: "review-round-2" }
    ]
  }, NOW);
  group = recordExecutionLaneResult(group, group.lanes[0].id, {
    summary: "clean",
    findings: []
  }, "completed", NOW);
  group = recordExecutionLaneResult(group, group.lanes[1].id, {
    summary: "found a reachable defect",
    findings: [{ id: "finding-1", severity: "high", status: "open", summary: "Defect" }]
  }, "completed", NOW);
  const summary = summarizeExecutionGroup(group);
  assert.deepEqual(summary.openHighPriorityFindingIds, ["finding-1"]);
  assert.throws(
    () => resolveExecutionGroup(group, { decision: "accept", summary: "Ship" }, NOW),
    /open high-priority findings/
  );
  const resolved = resolveExecutionGroup(group, {
    decision: "reject",
    summary: "Route defect to repair",
    selectedLaneIds: [group.lanes[1].id]
  }, NOW);
  assert.equal(resolved.resolution.decision, "reject");
  assert.deepEqual(resolved.resolution.unresolvedFindingIds, ["finding-1"]);
});

test("lane status can be advanced before its terminal result is recorded", () => {
  const group = createExecutionGroup("execution-group-1", "task-23", {
    purpose: "execution",
    target: target()
  }, NOW);
  const running = updateExecutionLane(group, group.lanes[0].id, { status: "running" }, NOW);
  assert.equal(running.lanes[0].status, "running");
  const done = recordExecutionLaneResult(running, running.lanes[0].id, { summary: "done" }, "yielded", NOW);
  assert.equal(done.lanes[0].status, "yielded");
  assert.equal(done.lanes[0].result.summary, "done");
});

test("durable group transitions preserve prior lane output and final resolution", () => {
  const created = createExecutionGroup("execution-group-1", "task-23", {
    purpose: "execution",
    target: target()
  }, NOW);
  const running = updateExecutionLane(
    created,
    created.lanes[0].id,
    { status: "running", runId: "agent-run-1" },
    new Date("2026-08-12T00:01:00.000Z")
  );
  const yielded = recordExecutionLaneResult(
    running,
    running.lanes[0].id,
    { summary: "first result" },
    "yielded",
    new Date("2026-08-12T00:02:00.000Z")
  );
  const resolved = resolveExecutionGroup(
    yielded,
    { decision: "accept", summary: "use the first result" },
    new Date("2026-08-12T00:03:00.000Z")
  );

  assert.doesNotThrow(() => assertExecutionGroupTransition(created, running));
  assert.doesNotThrow(() => assertExecutionGroupTransition(running, yielded));
  assert.doesNotThrow(() => assertExecutionGroupTransition(yielded, resolved));
  assert.throws(
    () => assertExecutionGroupTransition(resolved, {
      ...resolved,
      resolution: { ...resolved.resolution, summary: "rewritten" }
    }),
    /immutable/
  );
  assert.throws(
    () => assertExecutionGroupTransition(yielded, {
      ...yielded,
      lanes: [{
        ...yielded.lanes[0],
        result: { summary: "rewritten result" }
      }]
    }),
    /fresh retry Run/
  );
});

test("an explicit retry may reopen a terminal lane only with a fresh Run", () => {
  const created = createExecutionGroup("execution-group-1", "task-23", {
    purpose: "execution",
    target: target()
  }, NOW);
  const firstRun = updateExecutionLane(
    created,
    created.lanes[0].id,
    { status: "running", runId: "agent-run-1" },
    new Date("2026-08-12T00:01:00.000Z")
  );
  const failed = recordExecutionLaneResult(
    firstRun,
    firstRun.lanes[0].id,
    { summary: "retryable failure" },
    "failed",
    new Date("2026-08-12T00:02:00.000Z")
  );
  const retry = restartExecutionLane(
    failed,
    failed.lanes[0].id,
    { runId: "agent-run-2" },
    new Date("2026-08-12T00:03:00.000Z")
  );

  assert.doesNotThrow(() => assertExecutionGroupTransition(failed, retry));
  assert.equal(retry.lanes[0].status, "running");
  assert.equal(retry.lanes[0].result, undefined);
  assert.throws(
    () => assertExecutionGroupTransition(failed, {
      ...retry,
      lanes: [{ ...retry.lanes[0], runId: "agent-run-1" }]
    }),
    /fresh retry Run/
  );
});
