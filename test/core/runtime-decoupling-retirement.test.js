import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectTaskActionability } from "../../dist/scheduler/actionability.js";
import { ensureFileTaskController } from "../../dist/controller/clientRuntime.js";
import {
  createExactControlPlaneDescriptor,
  assertExactControlPlanePreflight
} from "../../dist/runtime/exactControlPlane.js";
import {
  materializeSessionBootstrap,
  refreshManagedSessionCliWrappers
} from "../../dist/context/sessionBootstrapManifest.js";
import {
  createTaskRecordRetirement,
  isTaskRecordRetired,
  operationalTaskRecords
} from "../../dist/task/taskRecordRetirement.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { yuiVersionIdentity } from "../../dist/version.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createAgentRun, failAgentRun } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { classifyReviewRoundOutcome } from "../../dist/review/reviewOutcomeClassifier.js";

const now = new Date("2026-08-25T00:00:00.000Z");
const effective = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent",
  adapterId: "codex",
  profileAccess: "write",
  search: false,
  permission: { strategy: "default" },
  writeProjectIds: [],
  workspace: { root: "/tmp/yui-retired-run", entries: [] },
  context: {}
};

test("managed control-plane continuity ignores release build changes", async () => {
  const identity = yuiVersionIdentity();
  const descriptor = createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry: import.meta.filename,
    yuiHome: process.cwd(),
    identity,
    buildId: "old-build",
    activeReleaseDigest: "a".repeat(64)
  });
  await assert.doesNotReject(assertExactControlPlanePreflight({
    serializedDescriptor: JSON.stringify(descriptor),
    digest: (await import("node:crypto")).createHash("sha256")
      .update(JSON.stringify(descriptor)).digest("hex"),
    actualExecutable: process.execPath,
    actualCliEntry: import.meta.filename,
    actualHome: process.cwd()
  }, {
    identity: { ...identity, version: "99.0.0" },
    inspectStorage: () => ({
      status: "current",
      currentLayoutVersion: identity.storageLayoutVersion,
      currentAggregateSchemaVersion: identity.aggregateSchemaVersion
    }),
    checkController: false
  }));
});

test("ordinary CLI calls accept a protocol-compatible Controller from another package version", async () => {
  const identity = yuiVersionIdentity();
  const status = await ensureFileTaskController(process.cwd(), {
    call: async () => ({
      running: true,
      version: "99.0.0",
      protocolVersion: identity.controllerProtocolVersion,
      storageLayoutVersion: identity.storageLayoutVersion,
      aggregateSchemaVersion: identity.aggregateSchemaVersion
    })
  });
  assert.equal(status.version, "99.0.0");
});

test("Session bootstrap invokes the ordinary yui command without a frozen release", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-session-cli-decoupled-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  );
  const bootstrap = materializeSessionBootstrap({
    yuiHome: home,
    role,
    owner: { scope: "global", roleName: "operator" },
    roleKind: "operator",
    skills: [],
    controlPlane: createExactControlPlaneDescriptor({
      executable: process.execPath,
      cliEntry: import.meta.filename,
      yuiHome: home
    })
  });
  const launcher = readFileSync(bootstrap.sessionCliPath, "utf8");
  assert.match(launcher, /exec yui "\$@"/u);
  assert.doesNotMatch(launcher, /--yui-control/u);
});

test("legacy Manifest-referenced Session wrappers are refreshed once and remain usable", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-session-cli-refresh-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  );
  const bootstrap = materializeSessionBootstrap({
    yuiHome: home,
    role,
    owner: { scope: "global", roleName: "operator" },
    roleKind: "operator",
    skills: [],
    controlPlane: createExactControlPlaneDescriptor({
      executable: process.execPath,
      cliEntry: import.meta.filename,
      yuiHome: home
    })
  });
  writeFileSync(
    bootstrap.sessionCliPath,
    `#!/bin/sh\nexec '${process.execPath}' '${import.meta.filename}' '--yui-control' '${"a".repeat(64)}' "$@"\n`
  );

  assert.deepEqual(refreshManagedSessionCliWrappers(home), {
    refreshed: 1,
    current: 0,
    skipped: 0
  });
  assert.equal(readFileSync(bootstrap.sessionCliPath, "utf8"), "#!/bin/sh\nexec yui \"$@\"\n");
  assert.deepEqual(refreshManagedSessionCliWrappers(home), {
    refreshed: 0,
    current: 1,
    skipped: 0
  });
});

test("a managed Session can execute a normal yui command without an exact control argument", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-managed-compatible-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, now);
  new SqliteTaskStore(home).close();
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  );
  const bootstrap = materializeSessionBootstrap({
    yuiHome: home,
    role,
    owner: { scope: "global", roleName: "operator" },
    roleKind: "operator",
    skills: [],
    controlPlane: createExactControlPlaneDescriptor({
      executable: process.execPath,
      cliEntry: import.meta.filename,
      yuiHome: home
    })
  });
  const bin = join(home, "test-bin");
  mkdirSync(bin);
  const yui = join(bin, "yui");
  const cli = join(process.cwd(), "dist", "cli.js");
  writeFileSync(
    yui,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`
  );
  chmodSync(yui, 0o755);
  const envelope = JSON.parse(execFileSync(
    bootstrap.sessionCliPath,
    ["--json", "task", "list"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        YUI_HOME: home,
        YUI_SESSION_SCOPE: "global",
        YUI_ROLE: "operator",
        YUI_AGENT_ID: "codex",
        YUI_ADAPTER_ID: "codex",
        YUI_SESSION_MANIFEST: bootstrap.manifestPath,
        YUI_SESSION_CLI: bootstrap.sessionCliPath
      }
    }
  ));
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.tasks, []);
});

test("retirement events preserve audit records while removing them from operational projections", () => {
  const run = { id: "agent-run-1", status: "active" };
  const message = { id: "message-1", wakePolicy: "leader", createdAt: now.toISOString() };
  const retiredRun = createTaskRecordRetirement({
    eventId: "event-1",
    taskId: "task-1",
    recordKind: "agent-run",
    recordId: run.id,
    reason: "invalid historical run",
    retiredBy: "operator"
  }, now);
  const retiredMessage = createTaskRecordRetirement({
    eventId: "event-2",
    taskId: "task-1",
    recordKind: "message",
    recordId: message.id,
    reason: "incorrect directive",
    retiredBy: "operator"
  }, now);
  const events = [retiredRun, retiredMessage];
  assert.equal(isTaskRecordRetired(events, "agent-run", run.id), true);
  assert.deepEqual(operationalTaskRecords([run], events, "agent-run"), []);
  assert.deepEqual(operationalTaskRecords([message], events, "message"), []);

  const actionability = collectTaskActionability({
    getTask: () => ({ id: "task-1", status: "active" }),
    listAgentRuns: () => [run],
    listMessages: () => [message],
    listEvents: () => events
  }, "task-1");
  assert.deepEqual(actionability.facts, []);

  // The original records and append-only retirement facts remain available
  // to audit/list callers.
  assert.equal(run.status, "active");
  assert.equal(message.wakePolicy, "leader");
  assert.equal(events.length, 2);
});

test("unrelated Task events never hide operational records", () => {
  const unrelated = createTaskEvent(
    "event-1",
    "task-1",
    "task.updated",
    { recordKind: "message", recordId: "message-1" },
    now
  );
  assert.equal(isTaskRecordRetired([unrelated], "message", "message-1"), false);
});

test("retiring a Reviewer Run removes its Round from semantic review evidence", () => {
  const retirement = createTaskRecordRetirement({
    eventId: "event-1",
    taskId: "task-1",
    recordKind: "agent-run",
    recordId: "agent-run-1",
    reason: "invalid review execution",
    retiredBy: "operator"
  }, now);
  const outcome = classifyReviewRoundOutcome({
    id: "review-round-1",
    taskId: "task-1",
    status: "completed",
    reviewerRunId: "agent-run-1"
  }, {
    listAgentRuns: () => [],
    listReviewFindings: () => [],
    listEvents: () => [retirement]
  });
  assert.deepEqual(outcome, {
    kind: "non-semantic",
    infraKind: "run-identity",
    reason: "Reviewer Run agent-run-1 was retired from operational evidence."
  });
});

test("user retirement commands append tombstones and preserve original records", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-record-retirement-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const task = activateTask(createTask("task-1", "repair history", now), now);
  store.saveTask(task);

  runTaskCommand([
    "message", "send", task.id, "incorrect directive", "--wake-policy", "none"
  ], store, { now: () => now });
  const retiredMessage = runTaskCommand([
    "message", "retire", `${task.id}/message-1`, "--reason", "entered by mistake"
  ], store, { now: () => now });
  assert.match(retiredMessage.output, /Retired Task Message task-1\/message-1/u);
  assert.equal(store.listMessages(task.id).length, 1);
  assert.equal(isTaskRecordRetired(store.listEvents(task.id), "message", "message-1"), true);
  assert.match(runTaskCommand([
    "message", "list", task.id
  ], store, { now: () => now }).output, /message-1\s+retired/u);

  const item = createWorkItem("work-item-1", task.id, { title: "wrong work" }, now);
  store.saveWorkItem(task.id, item);
  runTaskCommand([
    "work", "retire", `${task.id}/${item.id}`, "--summary", "duplicate work"
  ], store, { now: () => now });
  assert.equal(store.getWorkItem(task.id, item.id).status, "retired");
  assert.equal(store.getWorkItem(task.id, item.id).disposition.by, "user");
  assert.equal(isTaskRecordRetired(store.listEvents(task.id), "work-item", item.id), true);

  const active = createAgentRun(
    "agent-run-1",
    task.id,
    "leader",
    "new",
    "historical execution",
    now,
    { effective }
  );
  store.saveAgentRun(failAgentRun(active, "bad launch", now));
  const retiredRun = runTaskCommand([
    "run", "retire", `${task.id}/${active.id}`, "--reason", "invalid launch record"
  ], store, { now: () => now });
  assert.match(retiredRun.output, /Retired Agent Run task-1\/agent-run-1/u);
  assert.equal(store.getAgentRun(task.id, active.id).status, "failed");
  assert.equal(isTaskRecordRetired(store.listEvents(task.id), "agent-run", active.id), true);
  assert.deepEqual(store.readNextActionFacts(task.id).leaderRuns, []);
});
