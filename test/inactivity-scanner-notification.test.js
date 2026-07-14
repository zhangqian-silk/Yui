import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentRun } from "../dist/run/agentRun.js";
import { createRole, updateRoleStatus } from "../dist/role/role.js";
import {
  prepareStaleAgentRunExpirations,
  processRoleRuntimeStopClaim
} from "../dist/scheduler/inactivityScanner.js";
import {
  createRoleExpiryNotification,
  roleExpiryNotificationId
} from "../dist/scheduler/operatorNotification.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const startedAt = new Date("2026-07-14T00:00:00.000Z");
const expiredAt = new Date("2026-07-14T00:01:00.000Z");

function binding(agentId) {
  return { agentId, adapterId: "codex", config: { adapterId: "codex" } };
}

function saveActiveRoleRun(store, roleName, agentId, runId) {
  const role = updateRoleStatus(
    createRole("task-1", roleName, [binding(agentId)], agentId, "/repo", startedAt),
    "running",
    startedAt
  );
  const run = createAgentRun(runId, "task-1", roleName, "resume", "Continue", startedAt);
  store.saveRole("task-1", role);
  store.saveAgentRun(run);
  store.saveActiveAgentRun(run);
}

function saveIdleRole(store, roleName, agentId) {
  store.saveRole(
    "task-1",
    createRole("task-1", roleName, [binding(agentId)], agentId, "/repo", startedAt)
  );
}

function prepareRoleClaim(store, roleName) {
  const claim = prepareStaleAgentRunExpirations(store, expiredAt, 1)
    .find((candidate) => candidate.roleName === roleName);
  assert.ok(claim, `expected TTL stop claim for ${roleName}`);
  return claim;
}

test("TTL finalization preserves another Role's expiry-stop failure notification", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-ttl-notification-exact-clear-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  store.saveTask(createTask("task-1", "Independent Role expiry alerts", startedAt));
  saveIdleRole(store, "leader", "leader-agent");
  saveActiveRoleRun(store, "reviewer", "reviewer-agent", "reviewer-run");

  const leaderFailure = createRoleExpiryNotification(
    "task-1",
    "leader",
    "leader-agent",
    "leader-run",
    "role-expiry-stop-failed",
    startedAt,
    null
  );
  store.saveOperatorNotification(leaderFailure);

  assert.equal(
    processRoleRuntimeStopClaim(
      store,
      { killRoleAndConfirmStopped() {} },
      prepareRoleClaim(store, "reviewer"),
      expiredAt
    ),
    "expired"
  );

  assert.deepEqual(store.getOperatorNotification("task-1"), leaderFailure);
});

test("TTL finalization clears its own exact identity-drift notification", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-ttl-notification-exact-clear-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  store.saveTask(createTask("task-1", "Exact Role expiry alert", startedAt));
  saveActiveRoleRun(store, "reviewer", "reviewer-agent", "reviewer-run");

  const reviewerDrift = createRoleExpiryNotification(
    "task-1",
    "reviewer",
    "reviewer-agent",
    "reviewer-run",
    "role-expiry-identity-drift",
    startedAt,
    null
  );
  assert.equal(
    reviewerDrift.id,
    roleExpiryNotificationId(
      "role-expiry-identity-drift",
      "reviewer",
      "reviewer-agent",
      "reviewer-run"
    )
  );
  store.saveOperatorNotification(reviewerDrift);

  assert.equal(
    processRoleRuntimeStopClaim(
      store,
      { killRoleAndConfirmStopped() {} },
      prepareRoleClaim(store, "reviewer"),
      expiredAt
    ),
    "expired"
  );

  assert.equal(store.getOperatorNotification("task-1"), null);
});
