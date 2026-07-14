import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createInputResolutionWakeup
} from "../dist/scheduler/inputResolutionWakeup.js";
import {
  createOfflineResolutionClock
} from "../dist/scheduler/offlineResolutionClock.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-input-runtime-"));
  ensureStorageSchema(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("persists offline clocks and exact-origin resolution wakeups inside domain authority", (t) => {
  const home = createHome(t);
  const now = new Date("2026-07-14T07:50:00.000Z");
  const clock = createOfflineResolutionClock("task-1", "input-1", now);
  const wakeup = createInputResolutionWakeup({
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    requestId: "input-1",
    resolutionId: "resolution-1",
    agentRunId: "leader-run-1",
    adapterId: "codex",
    sessionRoot: "/tmp",
    nativeSessionId: "leader-native-1"
  }, now);

  executeDomainTransaction(home, "input-runtime-records-1", (workingRoot) => {
    const store = new FileTaskStore(workingRoot);
    store.saveOfflineResolutionClock(clock);
    store.saveInputResolutionWakeup(wakeup);
  });

  const store = new FileTaskStore(home);
  assert.deepEqual(store.getOfflineResolutionClock("task-1", "input-1"), clock);
  assert.deepEqual(store.listOfflineResolutionClocks(), [clock]);
  assert.deepEqual(store.getInputResolutionWakeup("task-1", "input-1"), wakeup);
  assert.deepEqual(store.listInputResolutionWakeups(), [wakeup]);
  assert.equal("answer" in wakeup, false);
});
