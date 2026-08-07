import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";
import { runUpdate } from "../dist/cli/updateOrchestrator.js";
import {
  FileRuntimeEventInbox
} from "../dist/controller/runtimeEventInbox.js";
import { runSessionNotifyCommand } from "../dist/controller/sessionNotify.js";
import {
  placeUpgradeFence,
  UpgradeFenceError,
  UPGRADE_FENCE_FILE
} from "../dist/storage/upgradeFence.js";

// ---------------------------------------------------------------------------
// Isolation: every fixture Home lives under the OS temp dir.
// ---------------------------------------------------------------------------

function tempHome(prefix = "yui-rr4-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const home = join(base, "home");
  assert.ok(home.startsWith(tmpdir()), `test Home must be under the temp dir, got ${home}`);
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

// --- fake spawn plumbing ----------------------------------------------------

function spawnResult(overrides) {
  return {
    pid: 0, output: [],
    stdout: Buffer.from(""), stderr: Buffer.from(""),
    status: 0, signal: null, ...overrides
  };
}
function okData(data, status = 0) {
  return spawnResult({ status, stdout: Buffer.from(JSON.stringify({ ok: true, data })) });
}
function rawOut(text, status = 0) {
  return spawnResult({ status, stdout: Buffer.from(text) });
}
function healthyDoctorData() {
  return {
    checks: [
      { name: "storage schema", status: "ok", detail: "current" },
      { name: "storage compatibility", status: "ok", detail: "USABLE" },
      { name: "storage state", status: "ok", detail: "readable" }
    ],
    storage: { healthy: true, blocking: [] }
  };
}
function fakeGlobalInstall() {
  const globalPrefix = mkdtempSync(join(tmpdir(), "yui-rr4-global-"));
  mkdirSync(join(globalPrefix, "bin"), { recursive: true });
  writeFileSync(join(globalPrefix, "bin", "yui"), "#!/bin/sh\n", { mode: 0o755 });
  return { globalPrefix, globalBinary: join(globalPrefix, "bin", "yui") };
}

// ===========================================================================
// R4-F1 — a top-level `null`/array/primitive JSON body must map to
// blocked/ambiguous, never crash with a TypeError.
// ===========================================================================

test("R4-F1 red/green: a staged binary that prints literal `null` -> preflight BLOCKED, not a crash", () => {
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("upgrade")) return rawOut("null", 0); // JSON.parse("null") === null
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  let preflight;
  assert.doesNotThrow(() => { preflight = ports.preflight(staged, "/home"); },
    "a literal null body must not crash preflight");
  assert.equal(preflight.status, "blocked");
});

test("R4-F1 red/green: activation printing literal `null` -> AMBIGUOUS, not a crash", () => {
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("upgrade")) return rawOut("null", 0);
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  let activation;
  assert.doesNotThrow(() => { activation = ports.activateStorage(staged, "/home"); });
  assert.equal(activation.status, "ambiguous", "a null activation body must be ambiguous, never a crash");
});

test("R4-F1 negative: an array/primitive top-level body is also blocked/ambiguous (not trusted)", () => {
  for (const body of ["[]", "5", "\"a string\"", "true"]) {
    const spawn = (command, args) => {
      if (command === "npm" && args[0] === "install") return spawnResult({});
      if (args.includes("version")) return okData({ version: "9.9.9" });
      if (args.includes("upgrade")) return rawOut(body, 0);
      return spawnResult({});
    };
    const ports = createUpdatePorts(process.env, spawn);
    const staged = ports.stage();
    assert.equal(ports.preflight(staged, "/home").status, "blocked", `body ${body} => preflight blocked`);
    assert.equal(ports.activateStorage(staged, "/home").status, "ambiguous", `body ${body} => activation ambiguous`);
  }
});

test("R4-F1 end-to-end: runUpdate on a null-activation child resolves ambiguous (probes, never crashes)", () => {
  const { home } = tempHome("yui-rr4-f1e-");
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "prefix") return rawOut("");
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("controller") && args.includes("status")) {
      return okData({ resources: [], warnings: [] });
    }
    if (args.includes("controller") && args.includes("identity")) {
      return spawnResult({
        status: 5,
        stderr: Buffer.from(JSON.stringify({ ok: false, code: "CONTROLLER_NOT_RUNNING" }))
      });
    }
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("upgrade") && args.includes("--dry-run")) return okData({ outcome: "dry-run", report: { steps: [{}] } });
    if (args.includes("upgrade")) return rawOut("null", 0); // activation prints null
    if (args.includes("doctor")) return okData(healthyDoctorData());
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  let result;
  assert.doesNotThrow(() => { result = runUpdate(ports, { home }); });
  assert.equal(result.outcome, "ambiguous", "a null activation must resolve ambiguous, never throw");
});

// ===========================================================================
// R4-F2 — missing / wrong-typed / malformed `storage.blocking` must fail
// closed, never be coerced to an empty array.
// ===========================================================================

function verifySpawnWithDoctor(globalPrefix, doctorResult) {
  const globalBinary = join(globalPrefix, "bin", "yui");
  return (command, args) => {
    if (command === "npm" && args[0] === "prefix") return rawOut(globalPrefix);
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("doctor") && command === globalBinary) return doctorResult;
    if (args.includes("doctor")) return okData(healthyDoctorData());
    return spawnResult({});
  };
}

test("R4-F2 red/green: a MISSING storage.blocking fails closed (not coerced to empty)", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const noBlocking = okData({
    checks: [
      { name: "storage schema", status: "ok", detail: "current" },
      { name: "storage compatibility", status: "ok", detail: "USABLE" },
      { name: "storage state", status: "ok", detail: "readable" }
    ],
    storage: { healthy: true } // blocking omitted
  }, 0);
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, noBlocking));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /storage\.blocking is missing or not an array|incomplete/i);
});

test("R4-F2 negative: a string storage.blocking fails closed", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const badType = okData({
    checks: [
      { name: "storage schema", status: "ok", detail: "current" },
      { name: "storage compatibility", status: "ok", detail: "USABLE" },
      { name: "storage state", status: "ok", detail: "readable" }
    ],
    storage: { healthy: true, blocking: "none" } // wrong type
  }, 0);
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, badType));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"), /not an array|incomplete/i);
});

test("R4-F2 negative: a malformed blocking element (missing name/status) fails closed", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const malformed = okData({
    checks: [
      { name: "storage schema", status: "ok", detail: "current" },
      { name: "storage compatibility", status: "ok", detail: "USABLE" },
      { name: "storage state", status: "ok", detail: "readable" }
    ],
    // healthy:false so it is an unhealthy result, but the blocking element is
    // malformed -> must fail closed as unverifiable, not print a vague blocker.
    storage: { healthy: false, blocking: [{ detail: "no name or status" }] }
  }, 5);
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, malformed));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"), /malformed entr|unverifiable/i);
});

test("R4-F2 positive: a well-formed empty blocking array with all checks ok passes", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, okData(healthyDoctorData(), 0)));
  const staged = ports.stage();
  assert.doesNotThrow(() => ports.verify(staged, "/home"));
});

// ===========================================================================
// R4-F3 — durable inbox publish honors the upgrade fence (decision-13, plan B):
// a late native hook enqueue during an upgrade fence is explicitly blocked, not
// silently lost; after the fence releases, publish works normally.
// ===========================================================================

/** Place a LIVE FOREIGN fence (owner pid 1 = init, always alive) to simulate an
 *  in-progress upgrade held by another process. */
function placeForeignFence(home) {
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(home, UPGRADE_FENCE_FILE),
    `${JSON.stringify({ schemaVersion: 1, ownerPid: 1, reason: "storage upgrade in progress", createdAt: "2026-08-06T00:00:00.000Z" }, null, 2)}\n`
  );
}

function turnInput() {
  return {
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    adapterId: "codex",
    nativeSessionId: "thread-native-1",
    turnId: "turn-1",
    summary: "done"
  };
}

test("R4-F3 red/green (direct publish): enqueue during an upgrade fence is BLOCKED, event not silently lost", () => {
  const { home } = tempHome("yui-rr4-f3a-");
  placeForeignFence(home);
  const inbox = new FileRuntimeEventInbox(home);
  // The late hook enqueue must be refused with a fence error — never a silent
  // success that would be dropped by the imminent atomic switch.
  assert.throws(() => inbox.enqueueTurnCompleted(turnInput()),
    (error) => error instanceof UpgradeFenceError || /fenced|in-progress upgrade/i.test(String(error && error.message)));
  // Nothing was written to the durable inbox: no committed event, no temp file.
  const inboxDir = join(home, "runtime", "inbox");
  const entries = existsSync(inboxDir) ? readdirSync(inboxDir) : [];
  assert.deepEqual(entries.filter((e) => e.endsWith(".json") || e.includes(".tmp-")), [],
    "a fenced enqueue must not leave a committed or temp inbox entry");
});

test("R4-F3 red/green (external hook path): sessionNotify during a fence rejects, does not silently enqueue", async () => {
  const { home } = tempHome("yui-rr4-f3b-");
  placeForeignFence(home);
  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: "task-1",
    YUI_ROLE: "leader",
    YUI_AGENT_ID: "codex-personal",
    YUI_ADAPTER_ID: "codex",
    YUI_LAUNCH_ID: "launch-current"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-1",
    cwd: home,
    "input-messages": ["do a thing"],
    "last-assistant-message": "done"
  });
  await assert.rejects(
    () => runSessionNotifyCommand(payload, environment, async () => ({})),
    (error) => error instanceof UpgradeFenceError || /fenced|in-progress upgrade/i.test(String(error && error.message))
  );
  const inboxDir = join(home, "runtime", "inbox");
  const entries = existsSync(inboxDir) ? readdirSync(inboxDir) : [];
  assert.deepEqual(entries.filter((e) => e.endsWith(".json") || e.includes(".tmp-")), [],
    "a fenced sessionNotify must not silently enqueue an event");
});

test("R4-F3 positive: after the fence is released, publish works normally again", () => {
  const { home } = tempHome("yui-rr4-f3c-");
  // Acquire and release a fence owned by THIS process (so release actually clears it).
  const release = placeUpgradeFence(home, {
    reason: "test upgrade", createdAt: "2026-08-06T00:00:00.000Z", ownerPid: process.pid
  });
  const inbox = new FileRuntimeEventInbox(home);
  // While WE hold the fence, our own pid is exempt (assertHomeWritable treats the
  // owner as writable), so a same-process publish is allowed — this documents that
  // the fence blocks FOREIGN writers, not the upgrade orchestrator itself.
  assert.doesNotThrow(() => inbox.enqueueTurnCompleted({ ...turnInput(), turnId: "turn-self" }));
  release();
  // After release, a normal enqueue works and is durably written.
  const result = inbox.enqueueTurnCompleted({ ...turnInput(), turnId: "turn-after" });
  assert.equal(result.created, true);
  assert.ok(inbox.list().length >= 1, "events are durably present after the fence is released");
});

test("R4-F3 negative: with NO fence (normal path) publish is unaffected", () => {
  const { home } = tempHome("yui-rr4-f3d-");
  const inbox = new FileRuntimeEventInbox(home);
  const result = inbox.enqueueTurnCompleted(turnInput());
  assert.equal(result.created, true);
  assert.equal(inbox.list().length, 1);
});

test("R4-F3 boundary: a stale (dead-owner) fence does NOT block publish (reclaimable)", () => {
  const { home } = tempHome("yui-rr4-f3e-");
  // A dead-owner fence is reclaimable, so a crashed upgrade must not permanently
  // block hooks — publish proceeds (assertHomeWritable reclaims the stale fence).
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(home, UPGRADE_FENCE_FILE),
    `${JSON.stringify({ schemaVersion: 1, ownerPid: 999999999, reason: "crashed upgrade", createdAt: "" }, null, 2)}\n`
  );
  const inbox = new FileRuntimeEventInbox(home);
  assert.doesNotThrow(() => inbox.enqueueTurnCompleted(turnInput()));
  assert.equal(inbox.list().length, 1);
});
