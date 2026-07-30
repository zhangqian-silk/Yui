import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");

test("FileTaskStore persists provider-neutral Agent Profiles without a configured Agent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-profile-adapter-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);

  store.saveAgentProfile(createAgentProfile({
    id: "portable-reviewer",
    defaultAccess: "read",
    instructions: "Review the bounded work and report evidence."
  }, NOW));

  const profile = store.getAgentProfile("portable-reviewer");
  assert.equal(profile?.schemaVersion, 2);
  assert.equal("agentId" in profile, false);
});

test("FileTaskStore rejects WorkItem dependency cycles and illegal lifecycle jumps", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-work-graph-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const task = createTask("task-1", "Graph", NOW);
  store.saveTask(task);
  const first = createWorkItem("work-item-1", task.id, {
    title: "First",
    dependsOn: []
  }, NOW);
  const second = createWorkItem("work-item-2", task.id, {
    title: "Second",
    dependsOn: [first.id]
  }, NOW);
  store.saveWorkItem(task.id, first);
  store.saveWorkItem(task.id, second);

  assert.throws(
    () => store.saveWorkItem(task.id, {
      ...first,
      dependsOn: [second.id],
      revision: 2,
      updatedAt: "2026-07-26T00:01:00.000Z"
    }),
    /dependency cycle/
  );
  assert.throws(
    () => store.saveWorkItem(task.id, {
      ...first,
      status: "completed",
      outcome: "Bypassed required execution.",
      revision: 2,
      updatedAt: "2026-07-26T00:01:00.000Z",
      endedAt: "2026-07-26T00:01:00.000Z"
    }),
    /transition is invalid/
  );
});
