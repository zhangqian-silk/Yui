import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FileRuntimeEventInbox } from "../dist/controller/runtimeEventInbox.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import {
  upgradeCoordinationLockPath,
  withUpgradeCoordinationLock
} from "../dist/storage/upgradeCoordination.js";
import { UpgradeFenceError } from "../dist/storage/upgradeFence.js";
import { switchProgressPath } from "../dist/storage/upgrade/switchProgress.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(ROOT, "test", "helpers", "inbox-cutover-runner.mjs");

function currentHome() {
  const base = mkdtempSync(join(tmpdir(), "yui-coordination-"));
  const home = join(base, "home");
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

function startRunner(mode, home, barrier, resultPath) {
  return spawn(
    process.execPath,
    [RUNNER, mode, home, barrier, resultPath],
    { cwd: ROOT, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }
  );
}

async function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function readResult(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function killIfRunning(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("shared coordination preserves a hook admitted before the fence", async () => {
  const { base, home } = currentHome();
  const barrier = join(base, "barrier");
  const publisherResultPath = join(base, "publisher.json");
  const upgradeResultPath = join(base, "upgrade.json");
  const publisher = startRunner("publisher", home, barrier, publisherResultPath);
  let upgrade;
  try {
    await waitForFile(`${barrier}.admitted`);
    upgrade = startRunner("upgrade", home, barrier, upgradeResultPath);
    await waitForFile(`${barrier}.upgrade-started`);

    // The hook already passed admission and holds the shared lock. Let it finish;
    // the upgrade must wait for that lock before taking its final snapshot.
    writeFileSync(`${barrier}.release-publisher`, "1");
    await waitForFile(publisherResultPath);
    assert.equal(readResult(publisherResultPath).ok, true);
    await waitForFile(`${barrier}.upgrade-locked`);

    writeFileSync(`${barrier}.release-to-switch`, "1");
    await waitForFile(`${barrier}.cutover-done`);

    // The fence is deliberately still held while we inspect the promoted Home.
    // The event must be present in the promoted copy, not only in the backup.
    const promoted = new FileRuntimeEventInbox(home).list();
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].turnId, "turn-coordination");

    writeFileSync(`${barrier}.allow-fence-release`, "1");
    const [publisherExit, upgradeExit] = await Promise.all([
      waitForExit(publisher),
      waitForExit(upgrade)
    ]);
    assert.equal(publisherExit.code, 0);
    assert.equal(upgradeExit.code, 0);
    assert.equal(readResult(upgradeResultPath).ok, true);
  } finally {
    killIfRunning(publisher);
    if (upgrade !== undefined) killIfRunning(upgrade);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a hook arriving during the protected cutover gets explicit fence failure", async () => {
  const { base, home } = currentHome();
  const barrier = join(base, "barrier");
  const publisherResultPath = join(base, "publisher.json");
  const upgradeResultPath = join(base, "upgrade.json");
  const upgrade = startRunner("upgrade", home, barrier, upgradeResultPath);
  let publisher;
  try {
    await waitForFile(`${barrier}.upgrade-locked`);
    publisher = startRunner("publisher", home, barrier, publisherResultPath);
    await waitForFile(`${barrier}.publisher-started`);

    // Cutover owns the lock and keeps its fence after releasing it. The waiting
    // hook therefore acquires the lock only to receive UpgradeFenceError and can
    // safely re-deliver later; it never creates an event in the new Home.
    writeFileSync(`${barrier}.release-to-switch`, "1");
    await waitForFile(`${barrier}.cutover-done`);
    await waitForFile(publisherResultPath);
    const rejected = readResult(publisherResultPath);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errorName, "UpgradeFenceError");
    assert.match(rejected.error, /fenced|coordination|upgrade/i);
    assert.deepEqual(new FileRuntimeEventInbox(home).list(), []);

    writeFileSync(`${barrier}.allow-fence-release`, "1");
    const [publisherExit, upgradeExit] = await Promise.all([
      waitForExit(publisher),
      waitForExit(upgrade)
    ]);
    assert.equal(publisherExit.code, 0);
    assert.equal(upgradeExit.code, 0);
    assert.equal(readResult(upgradeResultPath).ok, true);
  } finally {
    killIfRunning(upgrade);
    if (publisher !== undefined) killIfRunning(publisher);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a crashed coordination owner is reclaimed without orphaning admission", () => {
  const { base, home } = currentHome();
  try {
    const lock = upgradeCoordinationLockPath(home);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), "999999999\n");
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    assert.equal(withUpgradeCoordinationLock(home, () => "acquired"), "acquired");
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a stale marker beside an intact Home does not deadlock normal hooks", () => {
  const { base, home } = currentHome();
  try {
    writeFileSync(switchProgressPath(home), "{ malformed marker\n");
    const result = new FileRuntimeEventInbox(home).enqueueTurnCompleted({
      scope: "task",
      taskId: "task-marker",
      roleName: "leader",
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "native-marker",
      turnId: "turn-marker",
      summary: "intact Home remains writable"
    });
    assert.equal(result.created, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a marker with a missing Home fails hook admission closed", () => {
  const { base, home } = currentHome();
  try {
    rmSync(home, { recursive: true, force: true });
    writeFileSync(switchProgressPath(home), "{ malformed marker\n");
    assert.throws(
      () => new FileRuntimeEventInbox(home).enqueueTurnCompleted({
        scope: "task",
        taskId: "task-marker",
        roleName: "leader",
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "native-marker",
        turnId: "turn-missing-home",
        summary: "must re-deliver"
      }),
      (error) => error instanceof UpgradeFenceError
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
