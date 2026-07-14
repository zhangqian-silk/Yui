import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import { createRole } from "../dist/role/role.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const cli = join(process.cwd(), "dist", "cli.js");
const SESSION_FINGERPRINT = "a".repeat(64);

function runTaskmux(args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_CONTROLLER_MODE: "direct", ...env }
  });
}

function runTaskmuxFailure(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_CONTROLLER_MODE: "direct", ...env }
  });
}

function createConfiguredHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-maintenance-cli-"));
  t.after(() => {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" });
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(join(home, "schema.json"), `${JSON.stringify({
    schemaVersion: 1,
    storageVersion: 4,
    updatedAt: "2026-07-14T00:00:00.000Z"
  }, null, 2)}\n`);
  runTaskmux(["agent", "add", "codex", "--command", "codex"], { TASKMUX_HOME: home });
  runTaskmux(["role", "add", "leader", "--agent", "codex"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-agent", "codex"], { TASKMUX_HOME: home });
  return home;
}

function createBackedUpTask(t) {
  const home = createConfiguredHome(t);
  runTaskmux(["task", "create", "backup value"], { TASKMUX_HOME: home });
  const output = runTaskmux(["backup"], { TASKMUX_HOME: home });
  const path = output.match(/Created backup (.+)/)?.[1]?.trim();
  assert.ok(path);
  return { home, backupId: basename(path) };
}

function taskTitle(home) {
  return JSON.parse(readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8")).title;
}

function changeTaskTitle(home, title) {
  writeFileSync(
    join(home, "tasks", "task-1", "info.json"),
    `${JSON.stringify({ schemaVersion: 1, title }, null, 2)}\n`
  );
}

function transactionIds(home) {
  const directory = join(home, "runtime", "domain-transactions");
  if (!existsSync(directory)) return [];
  return [...new Set(readdirSync(directory).flatMap((name) => {
    const match = /^([A-Za-z0-9_-]+)\.(?:json|receipt-[0-9]{12}-[a-f0-9]{64}\.json)$/.exec(name);
    return match?.[1] === undefined ? [] : [match[1]];
  }))].sort();
}

function stagingDirectories(home) {
  const directory = join(home, "runtime", "domain-staging");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function createTrashedRoleTask(home, taskId, nativeSessionId) {
  const now = new Date();
  const store = new FileTaskStore(home);
  store.saveTask(createTask(taskId, taskId, now));
  store.saveRole(taskId, createRole(
    taskId,
    "leader",
    [{ agentId: "codex", adapterId: "codex", config: { adapterId: "codex" } }],
    "codex",
    "/repo",
    now
  ));
  store.saveRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet({ scope: "task", taskId, roleName: "leader" }, "codex", now),
    {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId,
      policy: "fixed",
      status: "ready",
      sessionRoot: `/sessions/${nativeSessionId}`,
      worktreeRoot: "/repo",
      configFingerprint: {
        overall: SESSION_FINGERPRINT,
        replayable: SESSION_FINGERPRINT,
        permission: SESSION_FINGERPRINT,
        sessionBound: SESSION_FINGERPRINT
      },
      permissionEnvelope: { adapterId: "codex" }
    },
    now
  ));
  assert.equal(store.deleteTask(taskId), true);
}

function nativeIdentityState(home, nativeSessionId) {
  const ledger = JSON.parse(readFileSync(
    join(home, "runtime", "native-session-identities.json"),
    "utf8"
  ));
  const [key] = Object.keys(ledger.identities)
    .filter((candidate) => JSON.parse(candidate)[2] === nativeSessionId);
  assert.ok(key, `missing native session identity: ${nativeSessionId}`);
  return ledger.identities[key].state;
}

test("catalog and doctor expose complete physical maintenance closure", (t) => {
  const rootHelp = runTaskmux(["help"]);
  const restoreHelp = runTaskmux(["help", "restore"]);
  const pruneHelp = runTaskmux(["help", "prune"]);

  assert.match(rootHelp, /\brestore\b/);
  assert.match(restoreHelp, /taskmux restore <backup-id> \[--force\]/);
  assert.match(pruneHelp, /--dry-run/);
  assert.match(pruneHelp, /--keep-trash-days/);
  assert.match(pruneHelp, /--transactions/);

  const home = createConfiguredHome(t);
  const doctor = runTaskmux(["doctor"], { TASKMUX_HOME: home });
  assert.match(doctor, /physical maintenance\s+\| ok/);
  assert.match(doctor, /backup\/restore\/rollback\/prune registry/);
});

test("direct restore requires force, creates rollback state, and preserves JSON parity", (t) => {
  const { home, backupId } = createBackedUpTask(t);
  changeTaskTitle(home, "current value");

  const refused = runTaskmuxFailure(["restore", backupId], { TASKMUX_HOME: home });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /requires interactive confirmation or --force/);
  assert.equal(taskTitle(home), "current value");

  const restored = runTaskmux(["restore", backupId, "--force"], { TASKMUX_HOME: home });
  assert.match(restored, new RegExp(`Restored backup ${backupId}`));
  assert.match(restored, /Rollback backup: backup-/);
  assert.equal(taskTitle(home), "backup value");

  changeTaskTitle(home, "changed again");
  const json = JSON.parse(runTaskmux(
    ["restore", backupId, "--force", "--json"],
    { TASKMUX_HOME: home }
  ));
  assert.equal(json.ok, true);
  assert.match(json.output, new RegExp(`Restored backup ${backupId}`));
  assert.equal(taskTitle(home), "backup value");
});

test("Controller backup, restore, and prune return the same maintenance output contracts", (t) => {
  const home = createConfiguredHome(t);
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };
  runTaskmux(["task", "create", "controller backup"], env);

  const backupOutput = runTaskmux(["backup"], env);
  const backupPath = backupOutput.match(/Created backup (.+)/)?.[1]?.trim();
  assert.ok(backupPath);
  const backupId = basename(backupPath);
  changeTaskTitle(home, "controller changed");

  const restoreOutput = runTaskmux(["restore", backupId, "--force"], env);
  assert.match(restoreOutput, new RegExp(`Restored backup ${backupId}`));
  assert.equal(taskTitle(home), "controller backup");

  const pruneJson = JSON.parse(runTaskmux(
    ["prune", "--backups", "--keep-backups", "1", "--dry-run", "--json"],
    env
  ));
  assert.equal(pruneJson.ok, true);
  assert.match(pruneJson.output, /Dry run/);
});

test("CLI trash retention selects source ages, retires only expired identities, and recovers staged pruning", (t) => {
  const home = createConfiguredHome(t);
  createTrashedRoleTask(home, "task-1", "expired-native");
  createTrashedRoleTask(home, "task-2", "recent-native");
  const now = Date.now();
  const expired = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const recent = new Date(now);
  utimesSync(join(home, "trash", "tasks", "task-1"), expired, expired);
  utimesSync(join(home, "trash", "tasks", "task-2"), recent, recent);

  const interrupted = runTaskmuxFailure(
    ["prune", "--trash", "--keep-trash-days", "1"],
    {
      TASKMUX_HOME: home,
      NODE_ENV: "test",
      TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage"
    }
  );
  assert.equal(interrupted.status, 5, interrupted.stderr);
  assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), true);
  assert.equal(existsSync(join(home, "trash", "tasks", "task-2")), true);
  assert.equal(nativeIdentityState(home, "expired-native"), "owned");
  assert.equal(nativeIdentityState(home, "recent-native"), "owned");
  assert.equal(transactionIds(home).length, 1);

  const recovered = runTaskmux(["prune", "--trash", "--keep-trash-days", "1"], {
    TASKMUX_HOME: home
  });
  assert.match(recovered, /Pruned trash tasks: 0/);
  assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), false);
  assert.equal(existsSync(join(home, "trash", "tasks", "task-2")), true);
  assert.equal(nativeIdentityState(home, "expired-native"), "retired");
  assert.equal(nativeIdentityState(home, "recent-native"), "owned");
  assert.deepEqual(transactionIds(home), []);
});

test("restore failure rolls back automatically while a simulated crash replays on restart", (t) => {
  const { home, backupId } = createBackedUpTask(t);
  changeTaskTitle(home, "must survive failed restore");
  const failed = runTaskmuxFailure(["restore", backupId, "--force"], {
    TASKMUX_HOME: home,
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_RESTORE_FAILPOINT: "after-stage"
  });

  assert.equal(failed.status, 5);
  assert.match(failed.stderr, /automatically rolled back/);
  assert.equal(taskTitle(home), "must survive failed restore");
  assert.deepEqual(transactionIds(home), []);

  const crashed = runTaskmuxFailure(["restore", backupId, "--force"], {
    TASKMUX_HOME: home,
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_RESTORE_FAILPOINT: "crash-after-stage"
  });
  assert.equal(crashed.status, 5);
  assert.equal(taskTitle(home), "must survive failed restore");
  assert.equal(transactionIds(home).length, 1);

  runTaskmux(["controller", "start"], { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" });
  assert.equal(taskTitle(home), "backup value");
  assert.deepEqual(transactionIds(home), []);
});

test("transaction prune dry-runs and safely clears terminal private staging", (t) => {
  const { home } = createBackedUpTask(t);
  assert.ok(stagingDirectories(home).length > 0);

  const dryRun = runTaskmux(["prune", "--transactions", "--dry-run"], { TASKMUX_HOME: home });
  assert.match(dryRun, /Would prune private transaction staging: [1-9]/);
  assert.ok(stagingDirectories(home).length > 0);

  const applied = runTaskmux(["prune", "--transactions"], { TASKMUX_HOME: home });
  assert.match(applied, /Pruned private transaction staging: [1-9]/);
  assert.deepEqual(stagingDirectories(home), []);
});

test("transaction prune replays recoverable pending work before clearing terminal staging", (t) => {
  const home = createConfiguredHome(t);
  runTaskmux(["task", "create", "pending prune fixture"], { TASKMUX_HOME: home });
  const terminalStages = stagingDirectories(home);
  assert.ok(terminalStages.length > 0);

  const interrupted = runTaskmuxFailure(
    ["task", "update", "task-1", "--title", "pending replacement"],
    {
      TASKMUX_HOME: home,
      NODE_ENV: "test",
      TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-operation:1-always"
    }
  );
  assert.equal(interrupted.status, 5);
  const [pendingId] = transactionIds(home);
  assert.ok(pendingId);
  const pendingStage = stagingDirectories(home).find((name) => name.startsWith(`${pendingId}.stage-`));
  assert.ok(pendingStage, JSON.stringify({ pendingId, stages: stagingDirectories(home) }));

  const output = runTaskmux(["prune", "--transactions"], { TASKMUX_HOME: home });
  assert.match(output, /Pruned private transaction staging: [1-9]/);
  assert.deepEqual(transactionIds(home), []);
  assert.equal(stagingDirectories(home).includes(pendingStage), false);
  assert.equal(taskTitle(home), "pending replacement");
  for (const terminal of terminalStages) {
    assert.equal(stagingDirectories(home).includes(terminal), false, terminal);
  }
});
