import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkMailbox, enqueueSignal } from "../../dist/coordination/workMailbox.js";
import { captureRoleRunDispatch } from "../../dist/coordination/workMailboxQueue.js";
import { readAcpSessionConfiguration } from "../../dist/runtime/acpProtocol.js";
import { acquireHandoverLock, isForeignHandoverLockHeld } from "../../dist/release/runtimeRelease.js";
import { createReleaseWorkflowPorts } from "../../dist/release/releaseWorkflowPorts.js";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { linkDevLauncher, unlinkDevLauncher } from "../../scripts/manage-dev-launcher.mjs";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createTask } from "../../dist/task/task.js";
import { verifyAcpConfiguration } from "../../dist/runtime/acpSessionConfiguration.js";
import { SqliteResourceRegistry } from "../../dist/resources/sqliteResourceRegistry.js";
import { createResourceRecord } from "../../dist/resources/resourceTypes.js";
import { upsertResourceRecord } from "../../dist/resources/resourceRegistry.js";
import { purgeResourceQuarantine, restoreAllResourceGc } from "../../dist/resources/resourceGc.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";

test("only explicit migration normalizes an old dispatch without consuming its input or changing history", t => {
  const mailbox = enqueueSignal(createWorkMailbox({
    kind: "role", taskId: "task-1", roleName: "worker"
  }), {
    reason: "turn-dispatched", refs: [{ type: "run", taskId: "task-1", id: "run-1" }],
    occurredAt: "2026-09-14T00:00:00Z"
  });
  assert.equal(captureRoleRunDispatch(mailbox, {
    taskId: "task-1", roleName: "worker", runId: "run-1"
  }), null, "Only the explicit storage migration may interpret old dedupe keys.");
  const home = mkdtempSync(join(tmpdir(), "yui-contract-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  try {
    store.saveTask(createTask("task-1", "Keep original input", new Date("2026-09-14T00:00:00Z")));
    store.saveWorkMailbox(mailbox);
    assert.throws(() => runTaskCommand(["message", "send", "task-1", "old option", "--wake-policy", "none"],
      store, { environment: {} }), /option|usage/i);
  } finally { store.close(); }
  rebuildHistoricalFixture(home, 27);
  const db = new Database(join(home, "yui.db"));
  try {
    const oldLedger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const facts = db.prepare("SELECT payload FROM task_records").all();
    assert.throws(() => new SqliteTaskStore(home), /upgrade|version|contract/i);
    migrateSqliteSchema(db, { mode: "apply" });
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version <= 27 ORDER BY version").all(), oldLedger);
    assert.deepEqual(db.prepare("SELECT payload FROM task_records").all(), facts);
  } finally { db.close(); }
  const reopened = new SqliteTaskStore(home);
  try {
    const migrated = reopened.getWorkMailbox(mailbox.target);
    assert.deepEqual(migrated.pending.refs, mailbox.pending.refs);
    assert.equal(migrated.pending.requestCount, 1);
    assert.equal(migrated.processing, null);
    assert.deepEqual(captureRoleRunDispatch(migrated, {
      taskId: "task-1", roleName: "worker", runId: "run-1"
    }), { kind: "pending", fromSequence: 1, toSequence: 1 });
  } finally { reopened.close(); }
});

test("local link uses its current registry and leaves unregistered state untouched", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-contract-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const original = "#!/bin/sh\nexit 0\n";
  const launcher = join(bin, "yui");
  writeFileSync(launcher, original, { mode: 0o755 });
  const options = { projectRoot: join(root, "checkout"), globalBinDir: bin,
    registryPath: join(root, "state", "dev-launcher.json") };
  await linkDevLauncher(options);
  assert.equal(unlinkDevLauncher(options).restored, true);
  assert.equal(readFileSync(launcher, "utf8"), original);
  const oldPath = join(bin, ".yui-link-state.json");
  const oldState = JSON.stringify({ schemaVersion: 2, activeProjectRoot: options.projectRoot });
  writeFileSync(oldPath, oldState);
  await assert.rejects(linkDevLauncher(options), /Unregistered/);
  assert.throws(() => unlinkDevLauncher(options), /Unregistered/);
  assert.equal(readFileSync(oldPath, "utf8"), oldState);
  assert.equal(readFileSync(launcher, "utf8"), original);
});

test("ACP requires configOptions and verifies final reported values rather than acknowledgements", () => {
  assert.throws(() => readAcpSessionConfiguration({
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }
  }), /configOptions/);
  const modern = readAcpSessionConfiguration({ configOptions: [{
    id: "model", category: "model", type: "select", name: "Model", currentValue: "selected",
    options: [{ value: "selected", name: "Selected" }, { value: "other", name: "Other" }]
  }] });
  const desired = { model: "selected", permission: { kind: "default" } };
  assert.deepEqual(verifyAcpConfiguration(desired, modern.options, "unknown-acp-agent"), []);
  assert.equal(verifyAcpConfiguration(desired, modern.options.map(option => ({
    ...option, currentValue: "other"
  })), "unknown-acp-agent").length, 1);
});

test("unproven handover lock identity stays fenced and untouched", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-contract-lock-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "runtime"));
  const path = join(home, "runtime", "handover.lock");
  const old = JSON.stringify({ pid: process.pid, createdAt: "2026-09-14T00:00:00Z" });
  writeFileSync(path, old);
  assert.equal(isForeignHandoverLockHeld(home, process.pid), true,
    "A PID-only lock cannot authorize its apparent parent across the handover fence.");
  assert.throws(() => acquireHandoverLock(home), /identity|unsupported/i);
  assert.equal(readFileSync(path, "utf8"), old);
});

test("GC keeps unsupported recovery evidence while current move-based quarantine remains reversible", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-contract-gc-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  const now = new Date("2026-09-14T00:00:00Z");
  const saved = join(home, "quarantine", "preserved");
  mkdirSync(saved, { recursive: true });
  writeFileSync(join(saved, "evidence"), "original");
  const registry = new SqliteResourceRegistry(home);
  const record = createResourceRecord({
    kind: "worktree", path: join(home, "original"),
    owner: { home, basis: "durable-record" }, cleanliness: "clean", activeRefs: [],
    disposition: "quarantined", quarantine: {
      path: saved, originalPath: join(home, "original"), movedAt: now.toISOString(),
      method: "git-worktree-remove", gitRestore: { repositoryPath: join(home, "missing-repo"), head: "a".repeat(40) }
    }
  }, now);
  try {
    const before = registry.load();
    registry.save(upsertResourceRecord(before, record), before);
    const result = await restoreAllResourceGc(home, { now });
    assert.equal(result.restored.length, 0);
    assert.match(result.failed[0].blocker, /Unsupported quarantine/);
    const purge = await purgeResourceQuarantine(home, {
      now: new Date(now.getTime() + 48 * 3_600_000), ttlHours: 1,
      liveReferencePorts: { processCwdRefs: () => new Map(), tmuxPaneCwds: async () => [] }
    });
    assert.equal(purge.purged.length, 0);
    assert.equal(readFileSync(join(saved, "evidence"), "utf8"), "original");
    assert.equal(existsSync(record.path), false);
    assert.deepEqual(registry.load().records[record.id].quarantine, record.quarantine);
    // A current non-Git move is restored by the same public operation.
    const currentPath = join(home, "quarantine", "current");
    mkdirSync(currentPath);
    writeFileSync(join(currentPath, "data"), "current");
    const current = createResourceRecord({
      kind: "runtime-artifact", path: join(home, "current"),
      owner: record.owner, cleanliness: "n/a", activeRefs: [], disposition: "quarantined",
      quarantine: { path: currentPath, originalPath: join(home, "current"), movedAt: now.toISOString(), method: "move" }
    }, now);
    const beforeCurrent = registry.load();
    registry.save(upsertResourceRecord(beforeCurrent, current), beforeCurrent);
    assert.equal((await restoreAllResourceGc(home, { now })).restored.length, 1);
    assert.equal(readFileSync(join(current.path, "data"), "utf8"), "current");
  } finally { registry.close(); }
});

test("release recovery never derives an unpinned identity from the current environment", async () => {
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/yui-no-external-query",
    runCommand: async (...args) => { calls.push(args); return { code: 0, stdout: "/another/prefix", stderr: "" }; }
  });
  const result = await ports.queryStepEffect({
    step: { id: "update", kind: "cli-update", idempotencyKey: "task-1/workflow-1/update", params: { version: "0.16.0" } },
    externalIdentity: { kind: "controller-home", value: "/old/home" }
  });
  assert.equal(result.state, "unknown");
  assert.deepEqual(calls, [], "No npm or alternate installation may attest an old Home-only effect.");
});
