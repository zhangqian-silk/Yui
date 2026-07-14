import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeRestoreCommand,
  runPruneCommand
} from "../dist/commands/maintenanceCommands.js";
import { backupAuthoritativeStoragePaths } from "../dist/storage/authoritativeStorage.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { DomainTransactionRecoveryError } from "../dist/storage/recoveryJournal.js";
import { selectTerminalTransactionStageNames } from "../dist/storage/transactionStagingPrune.js";
import {
  createStorageBackup,
  restoreStorageBackupInWorkingRoot
} from "../dist/storage/storageBackup.js";

const FIRST = new Date("2026-07-01T00:00:00.000Z");
const SECOND = new Date("2026-07-02T00:00:00.000Z");
const THIRD = new Date("2026-07-03T00:00:00.000Z");

function createHome(t) {
  const root = mkdtempSync(join(tmpdir(), "taskmux-maintenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "agents", "codex"), { recursive: true });
  mkdirSync(join(root, "roles", "operator"), { recursive: true });
  mkdirSync(join(root, "tasks", "task-1"), { recursive: true });
  mkdirSync(join(root, "trash", "tasks"), { recursive: true });
  mkdirSync(join(root, "runtime", "role-sessions", "task-1"), { recursive: true });
  mkdirSync(join(root, "runtime", "domain-transactions"), { recursive: true });
  mkdirSync(join(root, "runtime", "domain-staging", "old.stage-11111111-1111-4111-8111-111111111111"), { recursive: true });
  writeJson(join(root, "schema.json"), {
    schemaVersion: 1,
    storageVersion: 4,
    updatedAt: FIRST.toISOString()
  });
  writeJson(join(root, "config.json"), { schemaVersion: 1, defaultAgent: "codex" });
  writeJson(join(root, "agents", "codex", "agent.json"), {
    schemaVersion: 1,
    id: "codex",
    command: "codex",
    args: [],
    env: {}
  });
  writeJson(join(root, "roles", "operator", "role.json"), {
    fixture: "opaque physical role authority",
    deliberatelySchemaIndependent: true
  });
  writeJson(join(root, "tasks", "task-1", "task.json"), {
    schemaVersion: 1,
    id: "task-1",
    archived: false,
    createdAt: FIRST.toISOString(),
    updatedAt: FIRST.toISOString()
  });
  writeJson(join(root, "tasks", "task-1", "info.json"), {
    schemaVersion: 1,
    title: "before"
  });
  writeJson(join(root, "runtime", "role-sessions", "task-1", "leader.json"), {
    schemaVersion: 1,
    taskId: "task-1",
    roleName: "leader",
    nativeSessionId: "native-before"
  });
  writeJson(join(root, "runtime", "native-session-identities.json"), {
    schemaVersion: 1,
    identities: []
  });
  writeFileSync(join(root, "runtime", "controller.lock"), "lock\n");
  writeFileSync(join(root, "runtime", "controller.sock"), "socket fixture\n");
  writeFileSync(join(root, "runtime", "index.sqlite"), "derived-before\n");
  writeFileSync(join(root, "runtime", "domain-transactions", "pending.json"), "{}\n");
  writeFileSync(
    join(root, "runtime", "domain-staging", "old.stage-11111111-1111-4111-8111-111111111111", "retired-0"),
    "private staging\n"
  );
  return root;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("the unified registry backs up host-bound authority but excludes operational and derived paths", (t) => {
  const root = createHome(t);
  const paths = backupAuthoritativeStoragePaths();

  assert.deepEqual(paths, [
    "config.json",
    "schema.json",
    "agents",
    "roles",
    "tasks",
    "trash",
    "runtime/pending-wakeups",
    "runtime/leader-failures",
    "runtime/operator-notifications",
    "runtime/operator-deliveries",
    "runtime/offline-resolution-clocks",
    "runtime/input-resolution-wakeups",
    "runtime/role-sessions",
    "runtime/native-session-identities.json",
    "runtime/active-runs",
    "runtime/role-runtime-operations",
    "runtime/git-lifecycle",
    "runtime/launch-reservations",
    "runtime/rpc-intents",
    "runtime/rpc-results",
    "runtime/rpc-tombstones.jsonl"
  ]);

  const backup = createStorageBackup(root, FIRST);
  assert.equal(readJson(join(backup.path, "schema.json")).storageVersion, 4);
  assert.equal(
    readJson(join(backup.path, "runtime", "role-sessions", "task-1", "leader.json")).nativeSessionId,
    "native-before"
  );
  for (const excluded of [
    "backups",
    "runtime/controller.lock",
    "runtime/controller.sock",
    "runtime/index.sqlite",
    "runtime/domain-transactions",
    "runtime/domain-staging"
  ]) {
    assert.equal(existsSync(join(backup.path, excluded)), false, excluded);
  }
});

test("restore creates a rollback snapshot before replacing physical authoritative state", (t) => {
  const root = createHome(t);
  const backup = createStorageBackup(root, FIRST);
  writeJson(join(root, "config.json"), { schemaVersion: 1, defaultAgent: "changed" });
  writeJson(join(root, "tasks", "task-1", "info.json"), { schemaVersion: 1, title: "changed" });
  writeJson(join(root, "runtime", "role-sessions", "task-1", "leader.json"), {
    schemaVersion: 1,
    taskId: "task-1",
    roleName: "leader",
    nativeSessionId: "native-changed"
  });
  writeFileSync(join(root, "runtime", "index.sqlite"), "derived-changed\n");

  const restored = restoreStorageBackupInWorkingRoot(root, backup.id, SECOND);

  assert.equal(restored.backupId, backup.id);
  assert.notEqual(restored.rollbackId, backup.id);
  assert.equal(readJson(join(root, "config.json")).defaultAgent, "codex");
  assert.equal(readJson(join(root, "tasks", "task-1", "info.json")).title, "before");
  assert.equal(
    readJson(join(root, "runtime", "role-sessions", "task-1", "leader.json")).nativeSessionId,
    "native-before"
  );
  assert.equal(readFileSync(join(root, "runtime", "index.sqlite"), "utf8"), "derived-changed\n");
  assert.equal(
    readJson(join(root, "backups", restored.rollbackId, "tasks", "task-1", "info.json")).title,
    "changed"
  );
});

test("restore rejects a changed backup identity before creating rollback state", (t) => {
  const root = createHome(t);
  const backup = createStorageBackup(root, FIRST);
  const taskInfo = join(backup.path, "tasks", "task-1", "info.json");
  rmSync(taskInfo);
  symlinkSync(join(root, "tasks", "task-1", "info.json"), taskInfo);
  writeJson(join(root, "tasks", "task-1", "info.json"), { schemaVersion: 1, title: "current" });
  const backupsBefore = new Set([backup.id]);

  assert.throws(
    () => restoreStorageBackupInWorkingRoot(root, backup.id, SECOND),
    /unsupported|symbolic|identity/i
  );
  assert.equal(readJson(join(root, "tasks", "task-1", "info.json")).title, "current");
  assert.deepEqual(new Set(listBackupIds(root)), backupsBefore);
  assert.equal(lstatSync(taskInfo).isSymbolicLink(), true);
});

test("a controlled non-crash recovery error replays restore and atomically rolls back", (t) => {
  const root = createHome(t);
  rmSync(join(root, "runtime", "domain-transactions"), { recursive: true, force: true });
  const backup = createStorageBackup(root, FIRST);
  writeJson(join(root, "tasks", "task-1", "info.json"), {
    schemaVersion: 1,
    title: "must remain current"
  });

  assert.throws(
    () => executeRestoreCommand(
      root,
      "controlled-restore-recovery",
      [backup.id, "--force"],
      undefined,
      { executeTransaction: interruptAfterTransactionStage }
    ),
    /automatically rolled back/
  );
  assert.equal(readJson(join(root, "tasks", "task-1", "info.json")).title, "must remain current");
  assert.deepEqual(listTransactionReceipts(root), []);
});

test("restore replay failure keeps its journal and remains fail-closed", (t) => {
  const root = createHome(t);
  rmSync(join(root, "runtime", "domain-transactions"), { recursive: true, force: true });
  const backup = createStorageBackup(root, FIRST);
  writeJson(join(root, "tasks", "task-1", "info.json"), {
    schemaVersion: 1,
    title: "must survive replay failure"
  });
  const replayFailure = new DomainTransactionRecoveryError(
    "controlled-restore-recovery-failure",
    new Error("controlled replay failure"),
    new Error("controlled replay failure")
  );

  assert.throws(
    () => executeRestoreCommand(
      root,
      "controlled-restore-replay-failure",
      [backup.id, "--force"],
      undefined,
      {
        executeTransaction: interruptAfterTransactionStage,
        replayPending: () => { throw replayFailure; }
      }
    ),
    (error) => error === replayFailure && !/automatically rolled back/.test(error.message)
  );
  assert.equal(
    readJson(join(root, "tasks", "task-1", "info.json")).title,
    "must survive replay failure"
  );
  assert.ok(listTransactionReceipts(root).length > 0);
});

test("terminal staging selection skips every transaction id with a receipt", () => {
  assert.deepEqual(
    selectTerminalTransactionStageNames(
      [
        "pending.stage-11111111-1111-4111-8111-111111111111",
        "unexpected-receipt.stage-33333333-3333-4333-8333-333333333333",
        "completed.stage-22222222-2222-4222-8222-222222222222",
        "not-a-stage"
      ],
      [
        "pending.json",
        "pending.receipt-000000000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
        "unexpected-receipt.unparseable-receipt.json"
      ]
    ),
    ["completed.stage-22222222-2222-4222-8222-222222222222"]
  );
});

test("prune retention supports dry-run and deletes only expired trash and surplus backups", (t) => {
  const root = createHome(t);
  const first = createStorageBackup(root, FIRST);
  const second = createStorageBackup(root, SECOND);
  const third = createStorageBackup(root, THIRD);
  const expiredTrash = join(root, "trash", "tasks", "expired");
  const recentTrash = join(root, "trash", "tasks", "recent");
  mkdirSync(expiredTrash, { recursive: true });
  mkdirSync(recentTrash, { recursive: true });
  utimesSync(expiredTrash, FIRST, FIRST);
  utimesSync(recentTrash, THIRD, THIRD);

  const args = [
    "--backups",
    "--trash",
    "--keep-backups", "2",
    "--keep-trash-days", "1",
    "--dry-run"
  ];
  const dryRun = runPruneCommand(args, root, new Date("2026-07-03T12:00:00.000Z"));
  assert.match(dryRun, /Dry run/);
  assert.deepEqual(listBackupIds(root), [first.id, second.id, third.id]);
  assert.equal(existsSync(expiredTrash), true);
  assert.equal(existsSync(recentTrash), true);

  const applied = runPruneCommand(args.filter((arg) => arg !== "--dry-run"), root,
    new Date("2026-07-03T12:00:00.000Z"));
  assert.match(applied, /Pruned trash tasks: 1/);
  assert.match(applied, /Pruned backups: 1/);
  assert.deepEqual(listBackupIds(root), [second.id, third.id]);
  assert.equal(existsSync(expiredTrash), false);
  assert.equal(existsSync(recentTrash), true);
});

function listBackupIds(root) {
  const backups = join(root, "backups");
  if (!existsSync(backups)) return [];
  return readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("backup-"))
    .map((entry) => entry.name)
    .sort();
}

function listTransactionReceipts(root) {
  const transactions = join(root, "runtime", "domain-transactions");
  return existsSync(transactions) ? readdirSync(transactions).sort() : [];
}

function interruptAfterTransactionStage(rootDir, id, execute, extraOperations, options) {
  return executeDomainTransaction(
    rootDir,
    id,
    execute,
    extraOperations,
    { ...options, testFailAfterStage: true }
  );
}
