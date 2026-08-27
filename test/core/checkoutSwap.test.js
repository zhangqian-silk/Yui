import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  healCheckoutSwap,
  restoreCheckoutSwap,
  swapManagedCheckout
} from "../../dist/repository/checkoutSwap.js";

function newArea(t) {
  const area = mkdtempSync(join(tmpdir(), "yui-checkout-swap-"));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  return area;
}

function makeCheckout(area, name, marker) {
  const path = join(area, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "marker.txt"), `${marker}\n`);
  return path;
}

function readMarker(path) {
  return readFileSync(join(path, "marker.txt"), "utf8").trim();
}

/**
 * Recording ports around the real rename/remove so a single injected failure
 * exercises the rollback paths deterministically.
 */
function recordingPorts({ failRename = null, failRemove = false } = {}) {
  const calls = [];
  return {
    calls,
    ports: {
      rename: async (source, target) => {
        calls.push(["rename", source, target]);
        if (failRename !== null && failRename(source, target)) {
          throw new Error(`injected rename failure: ${source} -> ${target}`);
        }
        renameSync(source, target);
      },
      remove: async (path) => {
        calls.push(["remove", path]);
        if (failRemove) throw new Error(`injected remove failure: ${path}`);
        rmSync(path, { recursive: true, force: true });
      }
    }
  };
}

test("swapManagedCheckout parks the previous checkout and promotes the staging clone", async (t) => {
  const area = newArea(t);
  const current = makeCheckout(area, "current", "old");
  const staging = makeCheckout(area, "staging", "new");
  const backup = join(area, "backup");
  const { ports } = recordingPorts();

  await swapManagedCheckout({ currentPath: current, stagingPath: staging, backupPath: backup }, ports);

  assert.equal(readMarker(current), "new");
  assert.equal(readMarker(backup), "old");
  assert.ok(!existsSync(staging), "the staging path must be gone after promotion");
});

test("swapManagedCheckout rolls back when the promotion rename fails", async (t) => {
  const area = newArea(t);
  const current = makeCheckout(area, "current", "old");
  const staging = makeCheckout(area, "staging", "new");
  const backup = join(area, "backup");
  // Fail only the staging->current promotion; the parked checkout must be
  // restored by the backup->current rollback.
  const { ports } = recordingPorts({
    failRename: (source) => source.endsWith("/staging")
  });

  await assert.rejects(
    swapManagedCheckout({ currentPath: current, stagingPath: staging, backupPath: backup }, ports),
    /injected rename failure/u
  );

  assert.equal(readMarker(current), "old", "the previous checkout must be restored in place");
  assert.ok(!existsSync(backup), "the backup path must be gone after rollback");
  assert.ok(!existsSync(staging), "the staging clone must be removed after rollback");
});

test("swapManagedCheckout reports an incomplete rollback when the restore rename also fails", async (t) => {
  const area = newArea(t);
  const current = makeCheckout(area, "current", "old");
  const staging = makeCheckout(area, "staging", "new");
  const backup = join(area, "backup");
  // Every rename into the registered path fails: the promotion and the
  // rollback restore. The parked checkout must remain recoverable on disk.
  const { ports } = recordingPorts({
    failRename: (_source, target) => target.endsWith("/current")
  });

  await assert.rejects(
    swapManagedCheckout({ currentPath: current, stagingPath: staging, backupPath: backup }, ports),
    /rollback was incomplete[\s\S]*remains parked/u
  );

  assert.ok(!existsSync(current), "the failed promotion leaves no live checkout");
  assert.equal(readMarker(backup), "old", "the previous checkout stays parked for the next run");
  assert.equal(readMarker(staging), "new", "the untouched staging clone stays available");
});

test("swapManagedCheckout leaves staging untouched when the parking rename fails", async (t) => {
  const area = newArea(t);
  const current = makeCheckout(area, "current", "old");
  const staging = makeCheckout(area, "staging", "new");
  const backup = join(area, "backup");
  const { ports } = recordingPorts({
    failRename: (_source, target) => target.endsWith("/backup")
  });

  await assert.rejects(
    swapManagedCheckout({ currentPath: current, stagingPath: staging, backupPath: backup }, ports),
    /injected rename failure/u
  );

  assert.equal(readMarker(current), "old", "the live checkout must be untouched");
  assert.equal(readMarker(staging), "new", "the staging clone must be untouched");
  assert.ok(!existsSync(backup));
});

test("healCheckoutSwap restores a parked checkout after a crashed mid-swap", async (t) => {
  const area = newArea(t);
  const current = join(area, "current");
  const backup = makeCheckout(area, "backup", "parked");
  // State as if the process crashed between the two swap renames: the live
  // path is missing and the previous checkout is parked.
  assert.ok(!existsSync(current));
  const { ports } = recordingPorts();

  await healCheckoutSwap({ currentPath: current, backupPath: backup }, ports);

  assert.equal(readMarker(current), "parked", "the parked checkout must be restored");
  assert.ok(!existsSync(backup));
});

test("healCheckoutSwap removes a stale backup next to a live checkout", async (t) => {
  const area = newArea(t);
  const current = makeCheckout(area, "current", "live");
  const backup = makeCheckout(area, "backup", "stale");
  const { ports } = recordingPorts();

  await healCheckoutSwap({ currentPath: current, backupPath: backup }, ports);

  assert.equal(readMarker(current), "live", "the live checkout must be untouched");
  assert.ok(!existsSync(backup), "the stale backup must be removed");
});

test("healCheckoutSwap is a no-op without a backup", async (t) => {
  const area = newArea(t);
  const current = makeCheckout(area, "current", "live");
  const backup = join(area, "backup");
  const { ports, calls } = recordingPorts();

  await healCheckoutSwap({ currentPath: current, backupPath: backup }, ports);

  assert.equal(calls.length, 0);
  assert.equal(readMarker(current), "live");
});

test("swapManagedCheckout heals a crashed earlier swap before promoting", async (t) => {
  const area = newArea(t);
  const current = join(area, "current");
  makeCheckout(area, "backup", "parked");
  const staging = makeCheckout(area, "staging", "new");
  const backup = join(area, "backup");
  const { ports } = recordingPorts();

  await swapManagedCheckout({ currentPath: current, stagingPath: staging, backupPath: backup }, ports);

  assert.equal(readMarker(current), "new", "the healed run promotes the staging clone");
  assert.equal(readMarker(backup), "parked", "the restored checkout is parked again for the swap");
});

test("restoreCheckoutSwap discards the promoted clone and restores the backup", async (t) => {
  const area = newArea(t);
  const current = makeCheckout(area, "current", "new");
  const backup = makeCheckout(area, "backup", "old");
  const { ports } = recordingPorts();

  await restoreCheckoutSwap({ currentPath: current, backupPath: backup }, ports);

  assert.equal(readMarker(current), "old", "the previous checkout must be restored");
  assert.ok(!existsSync(backup));
});
