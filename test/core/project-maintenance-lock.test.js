import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireProjectMaintenanceLock,
  acquireProjectMaintenanceLocks,
  isProjectMaintenanceFenced,
  projectMaintenanceLockPath,
  ProjectMaintenanceLockedError,
  ProjectMaintenanceLockCancelledError
} from "../../dist/repository/projectMaintenanceLock.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

function newHome(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-maintenance-lock-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("a maintenance waiter yields so the same process can release its lock", async (t) => {
  const home = newHome(t);
  const release = await acquireProjectMaintenanceLock(home, "project-1");
  t.after(release);
  let responsive = false;
  const timer = setImmediate(() => {
    responsive = true;
    release();
  });
  t.after(() => clearImmediate(timer));
  const releaseNext = await acquireProjectMaintenanceLock(home, "project-1");
  t.after(releaseNext);
  assert.equal(responsive, true);
  assert.equal(isProjectMaintenanceFenced(home, "project-1"), true);
  release(); // An old handle cannot release its successor.
  assert.equal(isProjectMaintenanceFenced(home, "project-1"), true);
  releaseNext();
  assert.equal(isProjectMaintenanceFenced(home, "project-1"), false);
});

test("immediate acquisition and deterministic jitter honor the full monotonic deadline", async (t) => {
  const home = newHome(t);
  const release = await acquireProjectMaintenanceLock(home, "project-1", {
    timeoutMs: 0,
    wait: () => assert.fail("uncontended acquisition must not wait"),
    random: () => assert.fail("uncontended acquisition must not draw jitter")
  });
  t.after(release);
  let clock = 0;
  let draws = 0;
  const samples = [0, 0.5, 0.999];
  const sleeps = [];
  await assert.rejects(acquireProjectMaintenanceLock(home, "project-1", {
    now: () => clock,
    random: () => samples[draws++ % samples.length],
    wait: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      // Even a holder releasing exactly at the deadline cannot admit a late retry.
      if (clock === 60_000) release();
    }
  }), (error) => error instanceof ProjectMaintenanceLockedError && error.timeoutMs === 60_000);
  assert.equal(clock, 60_000);
  assert.equal(draws, sleeps.length);
  assert.deepEqual(sleeps.slice(0, 3), [200, 350, 499.7]);
  assert.ok(sleeps.length > 100); // No low attempt cap truncates a minute's budget.
  assert.ok(sleeps.at(-1) <= 500);
  assert.equal(existsSync(projectMaintenanceLockPath(home, "project-1")), false);
});

test("sorted multi-Project acquisition shares one budget and releases partial acquisition", async (t) => {
  const home = newHome(t);
  const releaseA = await acquireProjectMaintenanceLock(home, "a");
  const releaseB = await acquireProjectMaintenanceLock(home, "b");
  t.after(releaseA);
  t.after(releaseB);
  let clock = 0;
  const sleeps = [];
  await assert.rejects(acquireProjectMaintenanceLocks(home, ["b", "a", "a"], {
    timeoutMs: 550,
    now: () => clock,
    random: () => 0,
    wait: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      releaseA();
    }
  }), (error) => error instanceof ProjectMaintenanceLockedError && error.projectId === "b");
  assert.deepEqual(sleeps, [200, 200, 150]);
  assert.equal(clock, 550);
  assert.equal(isProjectMaintenanceFenced(home, "a"), false);
  assert.equal(isProjectMaintenanceFenced(home, "b"), true);
});

test("cancellation interrupts the timer and releases only the waiter's partial locks", async (t) => {
  const home = newHome(t);
  const release = await acquireProjectMaintenanceLock(home, "b");
  t.after(release);
  const controller = new AbortController();
  const reason = new Error("stop");
  const pending = acquireProjectMaintenanceLocks(home, ["a", "b"], { signal: controller.signal });
  const timer = setImmediate(() => {
    assert.equal(isProjectMaintenanceFenced(home, "a"), true);
    controller.abort(reason);
  });
  t.after(() => clearImmediate(timer));
  await assert.rejects(pending, (error) =>
    error instanceof ProjectMaintenanceLockCancelledError
    && error.projectId === "b" && error.cause === reason);
  assert.equal(isProjectMaintenanceFenced(home, "a"), false);
  assert.equal(isProjectMaintenanceFenced(home, "b"), true);
  await assert.rejects(acquireProjectMaintenanceLock(home, "c", {
    signal: controller.signal
  }), ProjectMaintenanceLockCancelledError);
  assert.equal(existsSync(projectMaintenanceLockPath(home, "c")), false);
});

test("a separate process excludes contenders until its exact release", async (t) => {
  const home = newHome(t);
  const module = new URL("../../dist/repository/projectMaintenanceLock.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { acquireProjectMaintenanceLock } from ${JSON.stringify(module)};
    const release = await acquireProjectMaintenanceLock(${JSON.stringify(home)}, "project-1");
    process.on("message", () => {
      release();
      process.send("released", () => process.disconnect());
    });
    process.send("held");
  `], { env: sanitizedTestEnv(), stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  assert.deepEqual(await once(child, "message"), ["held", undefined]);
  await assert.rejects(acquireProjectMaintenanceLock(home, "project-1", { timeoutMs: 0 }),
    ProjectMaintenanceLockedError);
  const released = once(child, "message");
  const pending = acquireProjectMaintenanceLock(home, "project-1", {
    // A controlled wake after the real child release avoids testing timer luck.
    wait: async () => {
      child.send("release");
      assert.deepEqual(await released, ["released", undefined]);
    }
  });
  const release = await pending;
  t.after(release);
  assert.equal(isProjectMaintenanceFenced(home, "project-1"), true);
  release();
  await exited;
});

test("dead exact owners are reclaimed, live holders and replacement locks are preserved", async (t) => {
  const home = newHome(t);
  const lock = projectMaintenanceLockPath(home, "project-1");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), `${process.pid}:not-this-process-start\n`);
  const old = new Date(Date.now() - 2_000);
  utimesSync(lock, old, old);
  assert.equal(isProjectMaintenanceFenced(home, "project-1"), false);
  const release = await acquireProjectMaintenanceLock(home, "project-1", { wait: async () => {} });
  t.after(release);
  utimesSync(lock, old, old);
  await assert.rejects(acquireProjectMaintenanceLock(home, "project-1", { timeoutMs: 0 }),
    ProjectMaintenanceLockedError);
  assert.equal(isProjectMaintenanceFenced(home, "project-1"), true);
  const replacementOwner = `${process.pid}:replacement\n`;
  writeFileSync(join(lock, "owner"), replacementOwner);
  release();
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), replacementOwner);
});
