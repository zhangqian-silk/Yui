import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { createTaskComment } from "../dist/comment/comment.js";
import {
  runExportCommand,
  runImportCommand
} from "../dist/commands/maintenanceCommands.js";
import { createCycle, endCycle } from "../dist/cycle/cycle.js";
import { createDecision } from "../dist/decision/decision.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import {
  readRoleRuntimeOperationClaim,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim
} from "../dist/executor/roleRuntimeOperationClaim.js";
import { createTaskEvent } from "../dist/event/taskEvent.js";
import { createTaskInputDraft } from "../dist/input/taskInput.js";
import { createMilestone } from "../dist/milestone/milestone.js";
import { createChildRole } from "../dist/role/childRole.js";
import { createRole } from "../dist/role/role.js";
import { createAgentRun, yieldAgentRun } from "../dist/run/agentRun.js";
import { createTaskSchedule } from "../dist/scheduler/taskSchedule.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";
import { createCustomTopic } from "../dist/topic/topic.js";
import { createWorkItem, updateWorkItemStatus } from "../dist/workItem/workItem.js";

const startedAt = new Date("2026-07-15T00:00:00.000Z");
const updatedAt = new Date("2026-07-15T00:01:00.000Z");
const SESSION_FINGERPRINT = "a".repeat(64);

function configuredAgent() {
  return createConfiguredAgent("codex", "codex", "codex", [], [], startedAt);
}

function binding() {
  return { agentId: "codex", adapterId: "codex", config: { adapterId: "codex" } };
}

function seedDeletedTask(store) {
  store.saveConfiguredAgent(configuredAgent());
  store.saveConfig({
    schemaVersion: 1,
    defaultAgent: "codex",
    defaultWorkspace: "/host/source-workspace"
  });
  store.saveTask(createTask("task-1", "Deleted portable task", startedAt, {
    description: "Carry the complete semantic history.",
    priority: "high",
    tags: ["portable", "trash"]
  }));
  store.saveTaskTopics("task-1", {
    schemaVersion: 1,
    customTopics: [
      createCustomTopic({
        id: "portable-history",
        name: "Portable history",
        description: "History that must survive deletion.",
        createdBy: "leader"
      }, startedAt)
    ]
  });
  store.saveTaskInputDraft("task-1", createTaskInputDraft(
    "task-1",
    "Draft input for the deleted task.",
    startedAt
  ));

  const leader = createRole(
    "task-1",
    "leader",
    [binding()],
    "codex",
    "/host/source-workspace",
    startedAt
  );
  store.saveRole("task-1", leader);
  store.saveChildRole("task-1", createChildRole("reviewer", "leader", {
    description: "Review portable lifecycle behavior.",
    responsibilities: ["Inspect history"],
    constraints: ["Do not use host state"],
    expectedOutput: "A lifecycle review."
  }, startedAt));
  store.saveTranscript("task-1", "leader", "leader transcript\n");
  store.saveTaskSchedule("task-1", createTaskSchedule(
    15,
    5,
    undefined,
    { everyMinutes: 60, nextAt: updatedAt.toISOString() },
    startedAt
  ));

  const cycle = endCycle(createCycle(
    "cycle-1",
    "task-1",
    "task-created",
    "Initial semantic history.",
    startedAt,
    ["portable-history"]
  ), "Cycle completed.", updatedAt);
  store.saveCycle("task-1", cycle);
  const workItem = updateWorkItemStatus(createWorkItem("work-1", "task-1", {
    title: "Preserve deleted history",
    assignee: "leader",
    topics: ["portable-history"],
    cycleId: "cycle-1"
  }, startedAt), "completed", "Preserved.", updatedAt);
  store.saveWorkItem("task-1", workItem);
  const run = yieldAgentRun(createAgentRun(
    "run-1",
    "task-1",
    "leader",
    "new",
    "Preserve semantic state",
    startedAt,
    { workItemId: "work-1", topics: ["portable-history"] }
  ), "History recorded.", updatedAt);
  store.saveAgentRun(run);

  store.saveTaskBrief("task-1", "Deleted task brief\n");
  store.appendTaskTopicSummary("task-1", "Deleted topic summary\n");
  store.appendTaskTimeline("task-1", "Deleted timeline\n");
  store.saveMilestone("task-1", createMilestone(
    "milestone-1",
    "task-1",
    "Preserve history",
    "The deleted Task retains semantic history.",
    ["portable-history"],
    startedAt
  ));
  store.saveDecision("task-1", createDecision(
    "decision-1",
    "task-1",
    "Use portable trash lifecycle",
    "Deleted Task data must stay deleted after import.",
    ["portable-history"],
    startedAt
  ));
  store.saveComment("task-1", createTaskComment(
    "comment-1",
    "Portable trash comment",
    startedAt,
    "leader",
    ["portable-history"]
  ));
  store.saveEvent("task-1", createTaskEvent(
    "event-1",
    "task.deleted",
    { reason: "completed" },
    updatedAt
  ));
  assert.equal(store.deleteTask("task-1"), true);

  // This is host/runtime-only state. A portable export must never include it.
  store.saveActiveAgentRun(createAgentRun(
    "active-ignored",
    "task-1",
    "leader",
    "resume",
    "Host runtime state",
    updatedAt
  ));
}

function configureTarget(store) {
  store.saveConfiguredAgent(configuredAgent());
  store.saveConfig({
    schemaVersion: 1,
    defaultAgent: "codex",
    defaultWorkspace: "/host/target-workspace"
  });
}

function importPortable(target, input, transactionId) {
  return executeDomainTransaction(
    target.rootDirectory(),
    transactionId,
    (workingRoot) => runImportCommand(
      [input, "--workspace-map", "default=default"],
      new FileTaskStore(workingRoot)
    )
  );
}

function trashedSessionPath(store, taskId = "task-1") {
  return join(store.rootDirectory(), "trash", "tasks", taskId, "role-sessions", "leader.json");
}

function nativeIdentityState(store, nativeSessionId) {
  const identity = [...store.nativeSessionIdentityClaims().entries()]
    .find(([key]) => JSON.parse(key)[2] === nativeSessionId)?.[1];
  assert.ok(identity, `missing native identity ${nativeSessionId}`);
  return identity.state;
}

function seedTrashedRoleSession(store, nativeSessionId) {
  assert.equal(store.restoreTask("task-1"), true);
  store.saveRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet({ scope: "task", taskId: "task-1", roleName: "leader" }, "codex", updatedAt),
    {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId,
      policy: "fixed",
      status: "ready",
      sessionRoot: `/sessions/${nativeSessionId}`,
      worktreeRoot: "/host/source-workspace",
      configFingerprint: {
        overall: SESSION_FINGERPRINT,
        replayable: SESSION_FINGERPRINT,
        permission: SESSION_FINGERPRINT,
        sessionBound: SESSION_FINGERPRINT
      },
      permissionEnvelope: { adapterId: "codex" }
    },
    updatedAt
  ));
  assert.equal(store.deleteTask("task-1"), true);
  assert.equal(existsSync(trashedSessionPath(store)), true);
  assert.equal(nativeIdentityState(store, nativeSessionId), "owned");
}

function seedOrphanRoleOperationClaim(store) {
  const snapshot = {
    role: null,
    sessionSet: null,
    activeRun: null,
    selectedWorkItem: null,
    pendingRun: null
  };
  const claim = {
    schemaVersion: 1,
    scope: "task-role",
    kind: "launch",
    token: "00000000-0000-4000-8000-000000000041",
    taskId: "task-1",
    roleName: "leader",
    operation: "dispatch",
    ownerPid: process.pid,
    preparedSession: null,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(snapshot),
    recoveryToken: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    leaseExpiresAt: "2026-07-15T00:02:00.000Z"
  };
  writeRoleRuntimeOperationClaim(store.rootDirectory(), claim, claim.expectedStateDigest);
  return claim;
}

function semanticIdentity(record) {
  return `${record.lifecycle}\0${record.authority}\0${record.key}`;
}

test("deleted Task portable round-trip preserves task-scoped semantic history in trash only", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-trash-output-"));
  const output = join(outputDir, "deleted-task.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  seedDeletedTask(source);
  configureTarget(target);
  assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);
  target.saveActiveAgentRun(createAgentRun(
    "orphaned-target-active-run",
    "task-1",
    "leader",
    "new",
    "This target runtime must not survive imported trash history.",
    updatedAt
  ));

  const manifest = JSON.parse(readFileSync(output, "utf8"));
  const deleted = manifest.semantic.filter((record) => record.key === "task-1" ||
    record.key.startsWith("task-1/"));
  assert.ok(deleted.length > 12);
  assert.ok(deleted.every((record) => record.lifecycle === "trash"));
  assert.deepEqual(
    new Set(deleted.map((record) => record.authority)),
    new Set([
      "task",
      "task-topics",
      "task-input-draft",
      "task-role",
      "child-role",
      "transcript",
      "task-schedule",
      "cycle",
      "work-item",
      "agent-run-history",
      "task-brief",
      "task-topic-summary",
      "task-timeline",
      "milestone",
      "decision",
      "comment",
      "event"
    ])
  );
  assert.doesNotMatch(JSON.stringify(manifest), /host\/source|host-native|active-ignored|runtime|role-sessions/i);

  assert.match(importPortable(target, output, "portable-trash-roundtrip"), /Created:/);
  assert.equal(target.getTask("task-1"), null);
  assert.deepEqual(target.listTrashedTaskIds(), ["task-1"]);
  assert.equal(target.getActiveAgentRun("task-1", "leader"), null);

  const trash = new FileTaskStore(join(target.rootDirectory(), "trash"));
  assert.equal(trash.getTask("task-1")?.title, "Deleted portable task");
  assert.deepEqual(trash.getTaskTopics("task-1").customTopics.map((topic) => topic.id), ["portable-history"]);
  assert.equal(trash.getTaskInputDraft("task-1")?.body, "Draft input for the deleted task.");
  assert.deepEqual(trash.listRoles("task-1").map((role) => role.name), ["leader"]);
  assert.deepEqual(trash.listChildRoles("task-1").map((role) => role.name), ["reviewer"]);
  assert.equal(trash.readTranscript("task-1", "leader"), "leader transcript\n");
  assert.equal(trash.getTaskSchedule("task-1")?.recurring?.everyMinutes, 60);
  assert.equal(trash.getCycle("task-1", "cycle-1")?.status, "ended");
  assert.equal(trash.getWorkItem("task-1", "work-1")?.status, "completed");
  assert.equal(trash.getAgentRun("task-1", "run-1")?.status, "yielded");
  assert.equal(trash.readTaskBrief("task-1"), "Deleted task brief\n");
  assert.equal(trash.readTaskTopicSummaries("task-1"), "Deleted topic summary\n");
  assert.equal(trash.readTaskTimeline("task-1"), "Deleted timeline\n");
  assert.equal(trash.getMilestone("task-1", "milestone-1")?.title, "Preserve history");
  assert.equal(trash.getDecision("task-1", "decision-1")?.title, "Use portable trash lifecycle");
  assert.equal(trash.listComments("task-1")[0]?.body, "Portable trash comment");
  assert.equal(trash.listEvents("task-1")[0]?.type, "task.deleted");
  assert.equal(existsSync(join(target.rootDirectory(), "runtime", "role-sessions", "tasks", "task-1")), false);
  assert.equal(target.restoreTask("task-1"), true);
  assert.equal(target.getActiveAgentRun("task-1", "leader"), null);
  assert.equal(target.getRoleSessionSet("task-1", "leader"), null);
});

test("semantic no-op trash import scrubs target host sessions and retires their identities", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-session-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-session-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-trash-session-output-"));
  const output = join(outputDir, "deleted-task.json");
  const nativeSessionId = "target-trash-native";
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  seedDeletedTask(source);
  configureTarget(target);
  runExportCommand(["--output", output], source);
  assert.match(importPortable(target, output, "portable-trash-session-create"), /Created:/);
  seedTrashedRoleSession(target, nativeSessionId);

  assert.match(importPortable(target, output, "portable-trash-session-noop"), /No-op:/);
  assert.equal(existsSync(trashedSessionPath(target)), false);
  assert.equal(nativeIdentityState(target, nativeSessionId), "retired");
  assert.equal(target.restoreTask("task-1"), true);
  assert.equal(target.getRoleSessionSet("task-1", "leader"), null);
});

test("semantic no-op trash import respects an orphaned operation fence without mutation", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-fence-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-fence-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-trash-fence-output-"));
  const output = join(outputDir, "deleted-task.json");
  const nativeSessionId = "target-trash-fence-native";
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  seedDeletedTask(source);
  configureTarget(target);
  runExportCommand(["--output", output], source);
  importPortable(target, output, "portable-trash-fence-create");
  seedTrashedRoleSession(target, nativeSessionId);
  const claim = seedOrphanRoleOperationClaim(target);

  assert.throws(
    () => importPortable(target, output, "portable-trash-fence-noop"),
    /Portable import transaction is invalid|Portable import failed/
  );
  assert.equal(existsSync(trashedSessionPath(target)), true);
  assert.equal(nativeIdentityState(target, nativeSessionId), "owned");
  assert.equal(readRoleRuntimeOperationClaim(target.rootDirectory(), "task-1", "leader")?.token, claim.token);
});

test("semantic no-op trash import rolls back host session scrubbing after apply failure", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-session-rollback-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-session-rollback-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-trash-session-rollback-output-"));
  const output = join(outputDir, "deleted-task.json");
  const nativeSessionId = "target-trash-rollback-native";
  const previousFailpoint = process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
  const previousNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    if (previousFailpoint === undefined) {
      delete process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
    } else {
      process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = previousFailpoint;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  seedDeletedTask(source);
  configureTarget(target);
  runExportCommand(["--output", output], source);
  importPortable(target, output, "portable-trash-session-rollback-create");
  seedTrashedRoleSession(target, nativeSessionId);
  process.env.NODE_ENV = "test";
  process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = "after-apply";

  assert.throws(
    () => importPortable(target, output, "portable-trash-session-rollback-noop"),
    /Portable import failed/
  );
  assert.equal(existsSync(trashedSessionPath(target)), true);
  assert.equal(nativeIdentityState(target, nativeSessionId), "owned");
});

test("portable import rejects a manifest containing both live and trash lifecycles for one Task id", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-collision-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-collision-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-trash-collision-output-"));
  const output = join(outputDir, "deleted-task.json");
  const collision = join(outputDir, "live-trash-collision.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  seedDeletedTask(source);
  configureTarget(target);
  runExportCommand(["--output", output], source);
  const manifest = JSON.parse(readFileSync(output, "utf8"));
  const duplicateLive = manifest.semantic
    .filter((record) => record.lifecycle === "trash" && (
      record.key === "task-1" || record.key.startsWith("task-1/")
    ))
    .map((record) => ({
      ...record,
      lifecycle: "live",
      references: record.references.map((reference) => ({
        ...reference,
        lifecycle: reference.lifecycle === "trash" ? "live" : reference.lifecycle
      }))
    }));
  manifest.semantic.push(...duplicateLive);
  manifest.semantic.sort((left, right) => semanticIdentity(left).localeCompare(semanticIdentity(right)));
  writeFileSync(collision, JSON.stringify(manifest));

  assert.throws(
    () => importPortable(target, collision, "portable-trash-lifecycle-collision"),
    /Portable import failed|snapshot is invalid/i
  );
  assert.equal(target.getTask("task-1"), null);
  assert.deepEqual(target.listTrashedTaskIds(), []);
});

test("portable import rejects a trash Task id that is already live in the target", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-target-collision-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-target-collision-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-trash-target-collision-output-"));
  const output = join(outputDir, "deleted-task.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  seedDeletedTask(source);
  configureTarget(target);
  target.saveTask(createTask("task-1", "Existing live task", startedAt));
  runExportCommand(["--output", output], source);

  assert.throws(
    () => importPortable(target, output, "portable-trash-target-collision"),
    /Portable import failed|Portable import transaction is invalid/
  );
  assert.equal(target.getTask("task-1")?.title, "Existing live task");
  assert.deepEqual(target.listTrashedTaskIds(), []);
});

test("portable schema rejects config pointers to a trash Task", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-config-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-config-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-trash-config-output-"));
  const output = join(outputDir, "deleted-task.json");
  const invalid = join(outputDir, "trash-config-pointer.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  seedDeletedTask(source);
  configureTarget(target);
  runExportCommand(["--output", output], source);
  const manifest = JSON.parse(readFileSync(output, "utf8"));
  const config = manifest.semantic.find((record) => record.authority === "config");
  assert.ok(config);
  config.payload.currentTaskId = "task-1";
  config.references.push({ lifecycle: "live", authority: "task", key: "task-1" });
  manifest.semantic.sort((left, right) => semanticIdentity(left).localeCompare(semanticIdentity(right)));
  writeFileSync(invalid, JSON.stringify(manifest));

  assert.throws(
    () => importPortable(target, invalid, "portable-trash-config-pointer"),
    /Portable import failed|snapshot is invalid/i
  );
  assert.equal(target.getTask("task-1"), null);
  assert.deepEqual(target.listTrashedTaskIds(), []);
});

test("portable trash import rolls back atomically after apply failure", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-rollback-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-trash-rollback-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-trash-rollback-output-"));
  const output = join(outputDir, "deleted-task.json");
  const previousFailpoint = process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
  const previousNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    if (previousFailpoint === undefined) {
      delete process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
    } else {
      process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = previousFailpoint;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  seedDeletedTask(source);
  configureTarget(target);
  runExportCommand(["--output", output], source);
  process.env.NODE_ENV = "test";
  process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = "after-apply";

  assert.throws(
    () => importPortable(target, output, "portable-trash-after-apply"),
    /Portable import failed/
  );
  assert.equal(target.getTask("task-1"), null);
  assert.deepEqual(target.listTrashedTaskIds(), []);
  assert.equal(existsSync(join(target.rootDirectory(), "trash", "tasks", "task-1")), false);
});
