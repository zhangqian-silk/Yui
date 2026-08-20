import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionRegistry,
  planMigration
} from "../../dist/storage/migration/index.js";
import {
  currentRecordVersions,
  latestStorageVersionState
} from "../../dist/storage/upgrade/recordVersions.js";

test("legacy single-lane record families have an explicit upgrade path", () => {
  const current = currentRecordVersions();
  const sourceRecord = Object.fromEntries(
    Object.entries(current).map(([kind, entry]) => [kind, { ...entry }])
  );
  sourceRecord.workItem = { ...sourceRecord.workItem, version: 6 };
  sourceRecord.agentRun = { ...sourceRecord.agentRun, version: 5 };
  sourceRecord.reviewRound = { ...sourceRecord.reviewRound, version: 2 };
  sourceRecord.activeRunPointer = { ...sourceRecord.activeRunPointer, version: 1 };
  sourceRecord.managedWorkspace = { ...sourceRecord.managedWorkspace, version: 1 };

  const source = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 17,
      recordVersions: Object.fromEntries(
        Object.entries(sourceRecord).map(([kind, entry]) => [kind, entry.version])
      )
    },
    state: {
      schemaVersion: 17,
      tasks: {
        "task-1": {
          workItems: { "work-item-1": { schemaVersion: 6 } },
          agentRuns: {
            "agent-run-1": {
              schemaVersion: 5,
              roleName: "leader",
              status: "active",
              executionGroupId: undefined,
              executionLaneId: undefined
            }
          },
          reviewRounds: { "review-round-1": { schemaVersion: 2 } },
          managedWorkspaces: {
            "work-item:task-1:work-item-1": legacyWorkspace("work-item-map")
          },
          activeRuns: { leader: { schemaVersion: 1, runId: "agent-run-1" } }
        }
      }
    }
  };
  const plan = planMigration(
    createProductionRegistry(),
    { layout: 7, aggregate: 17, record: sourceRecord },
    latestStorageVersionState()
  );
  assert.equal(plan.kind, "runnable");
  assert.deepEqual(
    plan.steps.map(({ recordKind, fromVersion, toVersion }) => ({
      recordKind,
      fromVersion,
      toVersion
    })),
    [
      { recordKind: undefined, fromVersion: 17, toVersion: 18 },
      { recordKind: undefined, fromVersion: 18, toVersion: 19 },
      { recordKind: "activeRunPointer", fromVersion: 1, toVersion: 2 },
      { recordKind: "activeRunPointer", fromVersion: 2, toVersion: 3 },
      { recordKind: "agentRun", fromVersion: 5, toVersion: 6 },
      { recordKind: "agentRun", fromVersion: 6, toVersion: 7 },
      { recordKind: "managedWorkspace", fromVersion: 1, toVersion: 2 },
      { recordKind: "reviewRound", fromVersion: 2, toVersion: 3 },
      { recordKind: "reviewRound", fromVersion: 3, toVersion: 4 },
      { recordKind: "workItem", fromVersion: 6, toVersion: 7 },
      { recordKind: "workItem", fromVersion: 7, toVersion: 8 },
      { recordKind: "workItem", fromVersion: 8, toVersion: 9 }
    ]
  );

  let migrated = structuredClone(source);
  for (const planned of plan.steps) {
    planned.step.preconditions(migrated);
    migrated = planned.step.transform(migrated);
  }
  assert.equal(migrated.schemaManifest.recordVersions.workItem, 9);
  assert.equal(migrated.schemaManifest.recordVersions.agentRun, 7);
  assert.equal(migrated.schemaManifest.recordVersions.reviewRound, 4);
  assert.equal(migrated.schemaManifest.recordVersions.activeRunPointer, 3);
  assert.equal(migrated.schemaManifest.recordVersions.managedWorkspace, 2);
  const task = migrated.state.tasks["task-1"];
  assert.equal(task.workItems["work-item-1"].schemaVersion, 9);
  assert.deepEqual(task.workItems["work-item-1"].executionGroups, []);
  assert.equal(task.workItems["work-item-1"].currentExecutionGroupId, undefined);
  assert.equal(task.agentRuns["agent-run-1"].schemaVersion, 7);
  assert.equal(task.reviewRounds["review-round-1"].schemaVersion, 4);
  assert.equal(task.activeRuns.leader.schemaVersion, 3);
  assert.equal(task.managedWorkspaces["work-item:task-1:work-item-1"].schemaVersion, 2);
  assert.equal(source.state.tasks["task-1"].workItems["work-item-1"].schemaVersion, 6);
});

test("managedWorkspace migration advances every embedded lifecycle snapshot", () => {
  const current = currentRecordVersions();
  const sourceRecord = Object.fromEntries(
    Object.entries(current).map(([kind, entry]) => [kind, { ...entry }])
  );
  sourceRecord.managedWorkspace = { ...sourceRecord.managedWorkspace, version: 1 };
  const source = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 17,
      recordVersions: Object.fromEntries(
        Object.entries(sourceRecord).map(([kind, entry]) => [kind, entry.version])
      )
    },
    state: {
      schemaVersion: 17,
      tasks: {
        "task-1": {
          managedWorkspaces: { direct: legacyWorkspace("direct") },
          workItems: {
            "work-item-1": {
              candidates: [{ workspace: legacyWorkspace("candidate") }]
            }
          },
          agentRuns: { "agent-run-1": { workspace: legacyWorkspace("run") } },
          reviewRounds: { "review-round-1": { workspace: legacyWorkspace("review") } }
        }
      }
    }
  };
  const plan = planMigration(
    createProductionRegistry(),
    { layout: 7, aggregate: 17, record: sourceRecord },
    latestStorageVersionState()
  );
  assert.equal(plan.kind, "runnable");
  const step = plan.steps.find(({ recordKind }) => recordKind === "managedWorkspace");
  assert.notEqual(step, undefined);
  step.step.preconditions(source);
  const migrated = step.step.transform(source);
  const task = migrated.state.tasks["task-1"];
  assert.equal(task.managedWorkspaces.direct.schemaVersion, 2);
  assert.equal(task.workItems["work-item-1"].candidates[0].workspace.schemaVersion, 2);
  assert.equal(task.agentRuns["agent-run-1"].workspace.schemaVersion, 2);
  assert.equal(task.reviewRounds["review-round-1"].workspace.schemaVersion, 2);
  assert.equal(source.state.tasks["task-1"].agentRuns["agent-run-1"].workspace.schemaVersion, 1);

  const mixed = structuredClone(source);
  mixed.state.tasks["task-1"].agentRuns["agent-run-1"].workspace.schemaVersion = 2;
  assert.throws(
    () => step.step.preconditions(mixed),
    /agentRuns task-1\/agent-run-1 workspace must use schemaVersion 1/
  );
});

function legacyWorkspace(label) {
  return {
    schemaVersion: 1,
    owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-1" },
    root: `/tmp/${label}`,
    entries: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z"
  };
}

test("workItem v8 migration preserves its current ExecutionGroup as immutable history", () => {
  const current = currentRecordVersions();
  const sourceRecord = Object.fromEntries(
    Object.entries(current).map(([kind, entry]) => [kind, { ...entry }])
  );
  sourceRecord.workItem = { ...sourceRecord.workItem, version: 8 };
  const legacyGroup = {
    schemaVersion: 1,
    id: "execution-group-1",
    taskId: "task-1",
    purpose: "execution",
    target: {
      schemaVersion: 1,
      kind: "work-item",
      taskId: "task-1",
      workItemId: "work-item-1",
      revision: 2,
      projects: [],
      fingerprint: "legacy-group"
    },
    strategy: { mode: "fixed", count: 1 },
    lanes: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
  const source = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 17,
      recordVersions: Object.fromEntries(
        Object.entries(sourceRecord).map(([kind, entry]) => [kind, entry.version])
      )
    },
    state: {
      schemaVersion: 17,
      tasks: {
        "task-1": {
          workItems: {
            "work-item-1": {
              schemaVersion: 8,
              executionGroup: legacyGroup
            }
          }
        }
      }
    }
  };
  const plan = planMigration(
    createProductionRegistry(),
    { layout: 7, aggregate: 17, record: sourceRecord },
    latestStorageVersionState()
  );
  assert.equal(plan.kind, "runnable");
  const step = plan.steps.find(({ recordKind, fromVersion }) => (
    recordKind === "workItem" && fromVersion === 8
  ));
  assert.ok(step);
  step.step.preconditions(source);
  const migrated = step.step.transform(source);
  const item = migrated.state.tasks["task-1"].workItems["work-item-1"];
  assert.equal(item.schemaVersion, 9);
  assert.equal("executionGroup" in item, false);
  assert.deepEqual(item.executionGroups, [legacyGroup]);
  assert.equal(item.currentExecutionGroupId, legacyGroup.id);
  assert.equal(source.state.tasks["task-1"].workItems["work-item-1"].executionGroup, legacyGroup);
});

test("active-lane pointer migration separates a legal Role containing colons", () => {
  const current = currentRecordVersions();
  const sourceRecord = Object.fromEntries(
    Object.entries(current).map(([kind, entry]) => [kind, { ...entry }])
  );
  sourceRecord.activeRunPointer = { ...sourceRecord.activeRunPointer, version: 2 };
  const source = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 17,
      recordVersions: Object.fromEntries(
        Object.entries(sourceRecord).map(([kind, entry]) => [kind, entry.version])
      )
    },
    state: {
      schemaVersion: 17,
      tasks: {
        "task-1": {
          agentRuns: {
            "role-run": {
              schemaVersion: 7,
              roleName: "lane:worker:1",
              status: "active"
            },
            "lane-run": {
              schemaVersion: 7,
              roleName: "worker",
              status: "active",
              executionGroupId: "group-1",
              executionLaneId: "lane-1"
            }
          },
          activeRuns: {
            "lane:worker:1": { schemaVersion: 2, runId: "role-run" },
            "lane:group-1:lane-1": { schemaVersion: 2, runId: "lane-run" }
          }
        }
      }
    }
  };
  const plan = planMigration(
    createProductionRegistry(),
    { layout: 7, aggregate: 17, record: sourceRecord },
    latestStorageVersionState()
  );
  assert.equal(plan.kind, "runnable");
  const step = plan.steps.find(({ recordKind, fromVersion }) => (
    recordKind === "activeRunPointer" && fromVersion === 2
  ));
  assert.ok(step);
  step.step.preconditions(source);
  const migrated = step.step.transform(source);
  const activeRuns = migrated.state.tasks["task-1"].activeRuns;
  assert.ok(activeRuns["lane:worker:1"]);
  assert.ok(activeRuns["/execution-lane/group-1:lane-1"]);
  assert.equal(activeRuns["lane:worker:1"].schemaVersion, 3);
  assert.equal(activeRuns["/execution-lane/group-1:lane-1"].schemaVersion, 3);
});
