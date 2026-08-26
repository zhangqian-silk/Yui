import test from "node:test";
import assert from "node:assert/strict";

import { buildTaskObservabilityProjection } from "../../dist/scheduler/taskObservabilityProjection.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

const now = new Date("2026-08-26T00:00:00.000Z");

test("Task observability projects ready and failed dependency paths without writes", () => {
  const root = createWorkItem("work-item-1", "task-1", { title: "Root" }, now);
  const failed = {
    ...createWorkItem("work-item-2", "task-1", { title: "Failed" }, now),
    status: "failed",
    outcome: "verification failed"
  };
  const blocked = {
    ...createWorkItem("work-item-3", "task-1", {
      title: "Blocked",
      dependsOn: [failed.id]
    }, now)
  };
  const ready = {
    ...createWorkItem("work-item-4", "task-1", {
      title: "Ready"
    }, now)
  };

  const projection = buildTaskObservabilityProjection({
    workItems: [root, failed, blocked, ready],
    executionGroups: [],
    runs: [],
    events: [],
    now
  });

  assert.deepEqual(projection.dag.readyIds, [root.id, ready.id]);
  assert.deepEqual(projection.dag.blockedIds, [blocked.id]);
  assert.deepEqual(
    projection.dag.edges.find((edge) => edge.from === failed.id && edge.to === blocked.id),
    { from: failed.id, to: blocked.id, status: "failed-open" }
  );
  assert.deepEqual(
    projection.dag.nodes.find((node) => node.id === blocked.id)?.rootCauseIds,
    [failed.id]
  );
});
