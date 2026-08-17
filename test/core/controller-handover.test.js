/**
 * Mock-process Controller handover tests (Issue 02).
 *
 * The handover orchestrator (`activateRelease`) is driven against fake ports
 * that simulate the old Controller RPC surface and the candidate process.
 * Liveness still goes through the real `/proc` start-identity check: every
 * "live" owner is a real spawned decoy process, so `isOwnerLive` exercises the
 * same code path as production. The mock candidate implements the real
 * promotion contract (read fence + pointer, write receipt + identity).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { readLinuxProcessStartIdentity } from "../../dist/controller/domainIdentity.js";
import { activateRelease } from "../../dist/release/releaseHandover.js";
import {
  isOwnerLive,
  readActiveReleasePointer,
  readHandoverFence,
  readHandoverReceipt,
  readRuntimeIdentity,
  removeCandidateDiscovery,
  removeHandoverFence,
  writeActiveReleasePointer,
  writeCandidateDiscovery,
  writeHandoverFence,
  writeHandoverReceipt,
  writeRuntimeIdentity
} from "../../dist/release/runtimeRelease.js";

const liveProcesses = [];

after(() => {
  for (const proc of liveProcesses) proc.kill();
  liveProcesses.length = 0;
});

/** Spawns a long-lived decoy process and reads its real /proc start identity. */
function spawnLiveProcess() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3_600_000)"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  let startIdentity;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    startIdentity = readLinuxProcessStartIdentity(child.pid);
    if (startIdentity !== undefined) break;
  }
  if (startIdentity === undefined) {
    child.kill("SIGKILL");
    throw new Error(`Could not read start identity for spawned PID ${child.pid}.`);
  }
  const proc = {
    pid: child.pid,
    startIdentity,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already dead.
      }
    }
  };
  liveProcesses.push(proc);
  return proc;
}

function makeManifest(version, packageDigest) {
  return Object.freeze({
    schemaVersion: 1,
    version,
    buildId: `${version}-${packageDigest.slice(0, 12)}`,
    packageDigest,
    files: [],
    assembledAt: "2026-08-17T00:00:00.000Z"
  });
}

function identityReceipt({ pid, startIdentity, buildId, version, mode, dualOwner }) {
  return Object.freeze({
    schemaVersion: 1,
    version,
    buildId,
    packageDigest: "0".repeat(64),
    sourceCommit: null,
    cliRealpath: `/opt/yui/releases/${version}/dist/cli.js`,
    controllerRealpath: `/opt/yui/releases/${version}/dist/core/controllerServer.js`,
    controllerProtocolVersion: 3,
    storageLayoutVersion: 7,
    aggregateSchemaVersion: 18,
    storageBackend: "file",
    workerEnabled: false,
    pid,
    processStartIdentity: startIdentity,
    mode,
    dualOwner,
    activeRelease: null,
    writtenAt: new Date().toISOString()
  });
}

/**
 * Fake ports simulating the old Controller and the candidate process.
 *
 * - `call` implements the handover RPC surface against the durable fence.
 * - `spawnCandidate` publishes candidate discovery + identity and runs the
 *   real promotion contract in the background.
 */
function createHarness(home, manifest, options = {}) {
  const calls = [];
  const oldProc = options.oldController === null ? null : (options.oldController ?? spawnLiveProcess());
  let oldLive = oldProc !== null;
  const candidateProcs = [];
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const call = async (_home, method, params) => {
    calls.push({ method, params });
    if (method === "controller.identity") {
      if (!oldLive) {
        throw Object.assign(new Error("Controller is not running"), {
          code: "CONTROLLER_NOT_RUNNING"
        });
      }
      return {
        pid: oldProc.pid,
        processStartIdentity: oldProc.startIdentity,
        buildId: "0.6.0-oldbuild0000",
        version: "0.6.0"
      };
    }
    if (method === "controller.begin-handover") {
      const now = new Date().toISOString();
      writeHandoverFence(home, Object.freeze({
        schemaVersion: 1,
        handoverId: params.handoverId,
        phase: "fenced",
        old: {
          pid: oldProc.pid,
          processStartIdentity: oldProc.startIdentity,
          buildId: "0.6.0-oldbuild0000",
          version: "0.6.0"
        },
        candidate: null,
        fromReleaseId: params.fromReleaseId,
        toReleaseId: params.toReleaseId,
        createdAt: now,
        updatedAt: now
      }));
      return { fenced: true };
    }
    if (method === "controller.commit-handover") {
      const existing = readHandoverFence(home);
      if (existing !== null) {
        writeHandoverFence(home, Object.freeze({
          ...existing,
          phase: "committed",
          updatedAt: new Date().toISOString()
        }));
      }
      if (options.stuckOld !== true) {
        oldProc?.kill();
        oldLive = false;
      }
      return { committed: true, pid: oldProc?.pid ?? 0 };
    }
    if (method === "controller.rollback-handover") {
      const existing = readHandoverFence(home);
      if (existing !== null) {
        writeHandoverFence(home, Object.freeze({
          ...existing,
          phase: "rolled-back",
          updatedAt: new Date().toISOString()
        }));
      }
      return { resumed: true, pid: oldProc?.pid ?? 0 };
    }
    throw new Error(`Unexpected Controller RPC: ${method}`);
  };

  const spawnCandidate = (_home, _releaseDir, handoverId) => {
    if (options.candidateNeverReady === true) return;
    const candidateProc = spawnLiveProcess();
    candidateProcs.push(candidateProc);
    writeCandidateDiscovery(home, {
      pid: candidateProc.pid,
      processStartIdentity: candidateProc.startIdentity
    });
    writeRuntimeIdentity(home, identityReceipt({
      pid: candidateProc.pid,
      startIdentity: candidateProc.startIdentity,
      buildId: manifest.buildId,
      version: manifest.version,
      mode: "candidate",
      dualOwner: false
    }));
    const fence = readHandoverFence(home);
    if (fence !== null) {
      writeHandoverFence(home, Object.freeze({
        ...fence,
        phase: "candidate-ready",
        updatedAt: new Date().toISOString()
      }));
    }
    // Delay promotion so the activator reliably enters the recovery path
    // (reads the committed fence) before the candidate promotes itself.
    void runMockCandidate(home, handoverId, manifest, candidateProc, { delayMs: 150 });
  };

  const ports = Object.freeze({
    call,
    spawnCandidate,
    startControllerFromRelease: options.startControllerFromRelease ?? (async () => {}),
    runPreflight: options.runPreflight ?? (() => {}),
    killOwnedProcess: (owner) => {
      const proc = candidateProcs.find((candidate) => candidate.pid === owner.pid);
      proc?.kill();
    },
    sleep,
    now: () => new Date()
  });

  return {
    ports,
    calls,
    cleanup() {
      oldProc?.kill();
      for (const proc of candidateProcs) proc.kill();
    }
  };
}

/** Simulates the candidate process promotion loop against the durable state. */
async function runMockCandidate(home, handoverId, manifest, candidateProc, options = {}) {
  let dualOwnerWritten = false;
  if (options.delayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fence = readHandoverFence(home);
    if (fence === null || fence.handoverId !== handoverId) {
      // The handover was rolled back; the candidate exits.
      return;
    }
    const oldDead = !isOwnerLive(fence.old);
    const pointer = readActiveReleasePointer(home);
    const pointerSwitched = pointer !== null && pointer.releaseId === fence.toReleaseId;
    if (oldDead && pointerSwitched) {
      writeRuntimeIdentity(home, identityReceipt({
        pid: candidateProc.pid,
        startIdentity: candidateProc.startIdentity,
        buildId: manifest.buildId,
        version: manifest.version,
        mode: "primary",
        dualOwner: false
      }));
      writeHandoverReceipt(home, Object.freeze({
        schemaVersion: 1,
        handoverId,
        outcome: "completed",
        old: fence.old,
        candidate: fence.candidate,
        previousReleaseId: fence.fromReleaseId,
        activatedReleaseId: fence.toReleaseId,
        startedAt: fence.createdAt,
        completedAt: new Date().toISOString()
      }));
      removeHandoverFence(home);
      removeCandidateDiscovery(home);
      candidateProc.kill();
      return;
    }
    if (fence.phase === "committed" && !oldDead && !dualOwnerWritten) {
      dualOwnerWritten = true;
      writeRuntimeIdentity(home, identityReceipt({
        pid: candidateProc.pid,
        startIdentity: candidateProc.startIdentity,
        buildId: manifest.buildId,
        version: manifest.version,
        mode: "candidate",
        dualOwner: true
      }));
    }
  }
}

async function runActivation(home, manifest, harness, overrides = {}) {
  return await activateRelease(harness.ports, {
    home,
    releaseDir: join(home, "runtime", "releases", "target"),
    manifest,
    candidateReadyTimeoutMs: 2_000,
    promotionTimeoutMs: 10_000,
    pollIntervalMs: 5,
    dualOwnerGraceMs: 100,
    ...overrides
  });
}

test("happy path: fence, candidate, pointer switch, commit, promote", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-handover-"));
  const manifest = makeManifest("0.6.0", "a".repeat(64));
  const harness = createHarness(home, manifest);
  try {
    const result = await runActivation(home, manifest, harness);
    assert.equal(result.outcome, "activated");
    assert.equal(result.releaseId, `0.6.0-${"a".repeat(64)}`);

    const pointer = readActiveReleasePointer(home);
    assert.equal(pointer.releaseId, result.releaseId);
    assert.equal(pointer.buildId, manifest.buildId);

    assert.equal(readHandoverFence(home), null);
    const receipt = readHandoverReceipt(home);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.activatedReleaseId, result.releaseId);

    const identity = readRuntimeIdentity(home);
    assert.equal(identity.mode, "primary");
    assert.equal(identity.buildId, manifest.buildId);

    assert.deepEqual(
      harness.calls.map((call) => call.method),
      ["controller.identity", "controller.begin-handover", "controller.commit-handover"]
    );
  } finally {
    harness.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("preflight failure leaves the old Controller and pointer untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-handover-"));
  const manifest = makeManifest("0.6.0", "a".repeat(64));
  const harness = createHarness(home, manifest, {
    runPreflight: () => {
      throw new Error("storage is not healthy");
    }
  });
  try {
    const result = await runActivation(home, manifest, harness);
    assert.equal(result.outcome, "aborted");
    assert.equal(result.phase, "preflight");
    assert.equal(readActiveReleasePointer(home), null);
    assert.equal(readHandoverFence(home), null);
    assert.deepEqual(harness.calls, []);
  } finally {
    harness.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("candidate not ready rolls back and the old Controller resumes", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-handover-"));
  const manifest = makeManifest("0.6.0", "a".repeat(64));
  const harness = createHarness(home, manifest, { candidateNeverReady: true });
  try {
    const result = await runActivation(home, manifest, harness, {
      candidateReadyTimeoutMs: 300
    });
    assert.equal(result.outcome, "aborted");
    assert.equal(result.phase, "candidate-ready");

    const fence = readHandoverFence(home);
    assert.equal(fence.phase, "rolled-back");
    const receipt = readHandoverReceipt(home);
    assert.equal(receipt.outcome, "rolled-back");

    // The old Controller is still live and serving; the pointer never moved.
    assert.equal(readActiveReleasePointer(home), null);
    const identity = await harness.ports.call(home, "controller.identity", {});
    assert.equal(identity.buildId, "0.6.0-oldbuild0000");
    assert.ok(
      harness.calls.some((call) => call.method === "controller.rollback-handover")
    );
  } finally {
    harness.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("stuck old Controller after commit reports dual-owner, never dual-write", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-handover-"));
  const manifest = makeManifest("0.6.0", "a".repeat(64));
  const harness = createHarness(home, manifest, { stuckOld: true });
  try {
    const result = await runActivation(home, manifest, harness);
    assert.equal(result.outcome, "dual-owner");

    // The pointer switched but the old owner is still live; the candidate
    // stays read-only and the fence records the committed phase.
    const pointer = readActiveReleasePointer(home);
    assert.equal(pointer.releaseId, result.releaseId);
    const fence = readHandoverFence(home);
    assert.equal(fence.phase, "committed");
    const identity = readRuntimeIdentity(home);
    assert.equal(identity.mode, "candidate");
    assert.equal(identity.dualOwner, true);
    assert.equal(readHandoverReceipt(home), null);
  } finally {
    harness.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("crash recovery: committed fence with a live candidate resumes promotion", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-handover-"));
  const manifest = makeManifest("0.6.0", "a".repeat(64));
  const releaseId = `0.6.0-${"a".repeat(64)}`;
  const candidateProc = spawnLiveProcess();
  const handoverId = "handover-recovery-committed";
  try {
    // Simulate an activator that crashed after the pointer switch and commit.
    const now = new Date().toISOString();
    writeHandoverFence(home, Object.freeze({
      schemaVersion: 1,
      handoverId,
      phase: "committed",
      old: { pid: 999_999, processStartIdentity: "1", buildId: "0.6.0-old", version: "0.6.0" },
      candidate: null,
      fromReleaseId: null,
      toReleaseId: releaseId,
      createdAt: now,
      updatedAt: now
    }));
    writeCandidateDiscovery(home, {
      pid: candidateProc.pid,
      processStartIdentity: candidateProc.startIdentity
    });
    writeActiveReleasePointerFixture(home, releaseId, manifest);
    // The candidate process is still running its promotion loop.
    void runMockCandidate(home, handoverId, manifest, candidateProc);

    const harness = createHarness(home, manifest, { oldController: null });
    const result = await runActivation(home, manifest, harness);
    assert.equal(result.outcome, "activated");
    assert.equal(result.handoverId, handoverId);
    assert.equal(readHandoverFence(home), null);
    const receipt = readHandoverReceipt(home);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.handoverId, handoverId);
  } finally {
    candidateProc.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("crash recovery: fenced fence with a dead candidate rolls back and re-drives", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-handover-"));
  const manifest = makeManifest("0.6.0", "a".repeat(64));
  const oldProc = spawnLiveProcess();
  try {
    // Simulate an activator that crashed after fencing, before the candidate
    // became ready. The candidate is gone; the old Controller is still live.
    const now = new Date().toISOString();
    writeHandoverFence(home, Object.freeze({
      schemaVersion: 1,
      handoverId: "handover-recovery-fenced",
      phase: "fenced",
      old: {
        pid: oldProc.pid,
        processStartIdentity: oldProc.startIdentity,
        buildId: "0.6.0-oldbuild0000",
        version: "0.6.0"
      },
      candidate: null,
      fromReleaseId: null,
      toReleaseId: `0.6.0-${"a".repeat(64)}`,
      createdAt: now,
      updatedAt: now
    }));

    const harness = createHarness(home, manifest, { oldController: oldProc });
    const result = await runActivation(home, manifest, harness);
    assert.equal(result.outcome, "activated");

    // The stale fence was rolled back before the fresh handover ran.
    assert.ok(
      harness.calls.some((call) => call.method === "controller.rollback-handover")
    );
    assert.ok(
      harness.calls.some((call) => call.method === "controller.begin-handover")
    );
    const receipt = readHandoverReceipt(home);
    assert.equal(receipt.outcome, "completed");
    assert.equal(readHandoverFence(home), null);
  } finally {
    oldProc.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("activation with no running Controller switches the pointer and starts it", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-handover-"));
  const manifest = makeManifest("0.6.0", "a".repeat(64));
  const harness = createHarness(home, manifest, { oldController: null });
  try {
    const result = await runActivation(home, manifest, harness);
    assert.equal(result.outcome, "activated");

    const pointer = readActiveReleasePointer(home);
    assert.equal(pointer.releaseId, result.releaseId);
    const receipt = readHandoverReceipt(home);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.old, null);
    assert.equal(readHandoverFence(home), null);
    assert.deepEqual(
      harness.calls.map((call) => call.method),
      ["controller.identity"]
    );
  } finally {
    harness.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("already-active release is a no-op", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-handover-"));
  const manifest = makeManifest("0.6.0", "a".repeat(64));
  const releaseId = `0.6.0-${"a".repeat(64)}`;
  writeActiveReleasePointerFixture(home, releaseId, manifest);
  const harness = createHarness(home, manifest, { oldController: null });
  try {
    const result = await runActivation(home, manifest, harness);
    assert.equal(result.outcome, "already-active");
    assert.equal(result.releaseId, releaseId);
    assert.deepEqual(harness.calls, []);
    assert.equal(readHandoverFence(home), null);
  } finally {
    harness.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

function writeActiveReleasePointerFixture(home, releaseId, manifest) {
  writeActiveReleasePointer(home, Object.freeze({
    schemaVersion: 1,
    releaseId,
    version: manifest.version,
    buildId: manifest.buildId,
    packageDigest: manifest.packageDigest,
    activatedAt: new Date().toISOString()
  }));
}
