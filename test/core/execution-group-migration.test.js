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
      storageVersion: 6,
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
          activeRuns: { leader: { schemaVersion: 1, runId: "agent-run-1" } }
        }
      }
    }
  };
  const plan = planMigration(
    createProductionRegistry(),
    { layout: 6, aggregate: 17, record: sourceRecord },
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
      { recordKind: "activeRunPointer", fromVersion: 1, toVersion: 2 },
      { recordKind: "activeRunPointer", fromVersion: 2, toVersion: 3 },
      { recordKind: "agentRun", fromVersion: 5, toVersion: 6 },
      { recordKind: "managedWorkspace", fromVersion: 1, toVersion: 2 },
      { recordKind: "reviewRound", fromVersion: 2, toVersion: 3 },
      { recordKind: "workItem", fromVersion: 6, toVersion: 7 }
    ]
  );

  let migrated = structuredClone(source);
  for (const planned of plan.steps) {
    planned.step.preconditions(migrated);
    migrated = planned.step.transform(migrated);
  }
  assert.equal(migrated.schemaManifest.recordVersions.workItem, 7);
  assert.equal(migrated.schemaManifest.recordVersions.agentRun, 6);
  assert.equal(migrated.schemaManifest.recordVersions.reviewRound, 3);
  assert.equal(migrated.schemaManifest.recordVersions.activeRunPointer, 3);
  assert.equal(migrated.schemaManifest.recordVersions.managedWorkspace, 2);
  const task = migrated.state.tasks["task-1"];
  assert.equal(task.workItems["work-item-1"].schemaVersion, 7);
  assert.equal(task.agentRuns["agent-run-1"].schemaVersion, 6);
  assert.equal(task.reviewRounds["review-round-1"].schemaVersion, 3);
  assert.equal(task.activeRuns.leader.schemaVersion, 3);
  assert.equal(source.state.tasks["task-1"].workItems["work-item-1"].schemaVersion, 6);
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
      storageVersion: 6,
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
              schemaVersion: 6,
              roleName: "lane:worker:1",
              status: "active"
            },
            "lane-run": {
              schemaVersion: 6,
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
    { layout: 6, aggregate: 17, record: sourceRecord },
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
