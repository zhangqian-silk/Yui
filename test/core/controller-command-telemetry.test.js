import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startFileTaskController } from "../../dist/controller/controller.js";
import { readLinuxProcessStartIdentity } from "../../dist/controller/domainIdentity.js";
import {
  callController,
  readControllerDiscovery
} from "../../dist/core/controllerClient.js";
import {
  FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
  encodeControllerRequest,
  parseControllerResponse
} from "../../dist/core/protocol.js";
import {
  ControllerCommandObserver,
  ControllerEventLoopDelay
} from "../../dist/core/controllerTelemetry.js";
import { YUI_VERSION } from "../../dist/version.js";

// Issue 02: the authenticated identity carries the full release provenance.
// A dev checkout has no release manifest, so the release fields report the
// dev fallback; the process identity is the live owner's.
function expectedDevIdentity() {
  const startIdentity = readLinuxProcessStartIdentity(process.pid);
  return {
    executablePath: process.execPath,
    args: process.argv.slice(1),
    version: YUI_VERSION,
    buildId: "dev",
    packageDigest: null,
    sourceCommit: null,
    cliRealpath: realpathSync(fileURLToPath(new URL("../../dist/cli.js", import.meta.url))),
    controllerRealpath: realpathSync(
      fileURLToPath(new URL("../../dist/core/controllerServer.js", import.meta.url))
    ),
    controllerProtocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
    storageBackend: "file",
    workerEnabled: false,
    mode: "primary",
    dualOwner: false,
    activeRelease: null,
    pid: process.pid,
    ...(startIdentity === undefined ? {} : { processStartIdentity: startIdentity })
  };
}

function emptyStore() {
  return {
    getPresentationContext() { return { timeZone: "Asia/Shanghai" }; },
    listTasks() { return []; },
    getTask() { return null; },
    getTaskWorkspace() { return null; },
    listRoles() { return []; },
    getRole() { return null; },
    getActiveAgentRun() { return null; },
    hasOpenInputRequest() { return false; },
    listOpenInputRequests() { return []; },
    listPendingRuntimeTurnCompletions() { return []; },
    getOperatorDeliveryTarget() { return null; },
    resolveExpiredInputRecommendations() { return []; },
    resolveDueRuntimeTurnCompletions() { return []; },
    getRoleSession() { return null; },
    hasInFlightTurn() { return false; },
    peekNextAgentRunId() { return "agent-run-1"; },
    getWorkMailbox() { return null; },
    listWorkMailboxes() { return []; },
    claimWorkMailbox() { return { status: "empty" }; },
    completeWorkMailbox() { return false; },
    releaseWorkMailbox() { return false; },
    getPendingWakeup() { return null; },
    listPendingWakeups() { return []; },
    savePendingWakeup() {},
    clearPendingWakeup() {},
    getLeaderFailure() { return null; },
    getOperatorNotification() { return null; },
    getTaskBrief() { return null; },
    listDecisions() { return []; },
    listMilestones() { return []; },
    saveLeaderDispatch() {},
    saveRoleRunPrepared() {},
    saveRoleRunDelivery() {},
    saveRoleRunDeliveryFailure() { return "state-changed"; },
    saveLeaderDispatchFailure() {},
    saveExitedRoleRun() {}
  };
}

const noTmux = {
  async prepareRoleSession() { throw new Error("unused"); },
  async waitUntilReady() { throw new Error("unused"); },
  async sendOnce() { throw new Error("unused"); },
  async inspectRole() { throw new Error("unused"); },
  async stopTask() { return false; }
};

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readLineResponse(socket, id) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        resolve(parseControllerResponse(buffer.subarray(0, newline).toString("utf8"), id));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function blockEventLoop(milliseconds) {
  const blockedUntil = performance.now() + milliseconds;
  while (performance.now() < blockedUntil) {
    // Model one synchronous whole-state projection starving the control socket.
  }
}

test("already-written status and dispatcher requests accumulate observable event-loop delay", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-command-telemetry-delay-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dispatcherCalls = [];
  const controller = await startFileTaskController(
    home,
    emptyStore(),
    noTmux,
    async (method) => {
      dispatcherCalls.push(method);
      return { method };
    },
    { intervalMs: 60_000 }
  );
  try {
    const discovery = await readControllerDiscovery(home);
    const statusSocket = await connect(discovery.socketPath);
    const querySocket = await connect(discovery.socketPath);
    const statusResponse = readLineResponse(statusSocket, "queued-status");
    const queryResponse = readLineResponse(querySocket, "queued-query");
    // Both requests are buffered in the kernel before the shared event loop is
    // blocked, so neither can be routed until the block ends.
    statusSocket.write(encodeControllerRequest({
      id: "queued-status",
      token: discovery.token,
      method: "controller.status",
      params: {}
    }));
    querySocket.write(encodeControllerRequest({
      id: "queued-query",
      token: discovery.token,
      method: "task.query",
      params: {}
    }));
    blockEventLoop(250);

    const [status, query] = await Promise.all([statusResponse, queryResponse]);
    assert.equal(status.ok, true);
    assert.equal(query.ok, true);
    assert.deepEqual(dispatcherCalls, ["task.query"]);

    const snapshot = await callController(home, "controller.status", {});
    const commands = snapshot.runtime.commands;
    // The dispatcher ran after the block and returned immediately: its service
    // time must not masquerade as the end-to-end wait the requests endured.
    assert.ok(
      commands.dispatcher.maximumServiceTimeMs < 100,
      `dispatcher service time ${commands.dispatcher.maximumServiceTimeMs}ms must stay below the block`
    );
    // The pre-dispatch/event-loop wait is observable as a bounded lag signal.
    assert.ok(
      commands.eventLoopDelay.maximumLagMs >= 100,
      `expected event-loop lag >= 100ms, got ${commands.eventLoopDelay.maximumLagMs}ms`
    );
    // Both already-written requests were routed exactly once.
    assert.equal(commands.routes.dispatched.completed, 1);
    assert.ok(commands.routes.builtin.completed >= 1);
    assert.equal(commands.routes.failed, 0);
  } finally {
    await controller.close();
  }
});

test("built-in status, identity and stop routes are counted once by core stats", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-command-telemetry-builtin-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const controller = await startFileTaskController(
    home,
    emptyStore(),
    noTmux,
    undefined,
    { intervalMs: 60_000 }
  );
  try {
    assert.deepEqual(await callController(home, "controller.identity", {}), expectedDevIdentity());
    await callController(home, "controller.status", {});

    const snapshot = await callController(home, "controller.status", {});
    const routes = snapshot.runtime.commands.routes;
    // identity + the first status completed; this snapshot's own status is in flight.
    assert.equal(routes.builtin.completed, 2);
    assert.equal(routes.builtin.failed, 0);
    assert.equal(routes.completed, 2);
    assert.equal(routes.inFlight, 1);
    assert.equal(routes.dispatched.completed, 0);

    // A fenced stop that does not own the PID fails without stopping the server.
    await assert.rejects(
      callController(home, "controller.stop", { expectedPid: 1 }),
      (error) => error.code === "CONTROLLER_OWNERSHIP_MISMATCH"
    );
    const after = await callController(home, "controller.status", {});
    assert.equal(after.runtime.commands.routes.builtin.failed, 1);
    assert.equal(after.runtime.commands.routes.builtin.completed, 3);
    assert.equal(after.runtime.commands.routes.completed, 4);
  } finally {
    await callController(home, "controller.stop", {}).catch(() => undefined);
    await controller.closed;
  }
});

test("dispatcher commands are counted once without double-counting service time", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-command-telemetry-dispatch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const controller = await startFileTaskController(
    home,
    emptyStore(),
    noTmux,
    async (method) => {
      if (method === "task.run.yield") {
        const error = new Error("Controller method was not found.");
        error.name = "CoreApplicationError";
        error.code = "METHOD_NOT_FOUND";
        throw error;
      }
      return { method };
    },
    { intervalMs: 60_000 }
  );
  try {
    await callController(home, "task.query", {});
    await callController(home, "task.write", {});
    await assert.rejects(
      callController(home, "task.run.yield", {}),
      (error) => error.code === "METHOD_NOT_FOUND"
    );

    const snapshot = await callController(home, "controller.status", {});
    const commands = snapshot.runtime.commands;
    // Service time is recorded for every dispatcher invocation, including the
    // failed one; the route outcome is observed separately.
    assert.equal(commands.dispatcher.completed, 3);
    assert.equal(commands.dispatcher.inFlight, 0);
    assert.deepEqual(Object.keys(commands.dispatcher.serviceTimeBuckets), [
      "le10ms", "le50ms", "le100ms", "le250ms", "le500ms", "le1000ms", "le3000ms"
    ]);
    assert.equal(commands.routes.dispatched.completed, 2);
    assert.equal(commands.routes.dispatched.failed, 1);
    assert.equal(commands.routes.completed, 3);
    assert.equal(commands.routes.inFlight, 1);
    // The service-time counter and the route counter are distinct observations.
    assert.notEqual(commands.dispatcher, commands.routes.dispatched);
  } finally {
    await controller.close();
  }
});

test("event-loop delay samples lag deterministically through the injected clock", () => {
  let now = 1_000;
  const clock = () => now;
  let intervalCallback = null;
  const scheduler = {
    setInterval: (callback) => {
      intervalCallback = callback;
      return {
        unref() {},
        close() { intervalCallback = null; }
      };
    }
  };
  const delay = new ControllerEventLoopDelay(clock, scheduler, 50);
  delay.start();

  // On-time tick: no lag.
  now = 1_050;
  intervalCallback();
  // Model a blocked event loop: the clock advances 250ms without a tick.
  now = 1_300;
  intervalCallback();

  const snapshot = delay.snapshot();
  assert.equal(snapshot.samples, 2);
  assert.equal(snapshot.maximumLagMs, 200);
  assert.equal(snapshot.lagBuckets.le100ms, 1);
  assert.equal(snapshot.lagBuckets.le250ms, 2);
  assert.equal(snapshot.lagBuckets.le500ms, 2);

  // Stopping clears the interval handle and freezes sampling.
  delay.stop();
  assert.equal(intervalCallback, null);
  now = 2_000;
  assert.equal(delay.snapshot().samples, 2);
  assert.equal(delay.snapshot().maximumLagMs, 200);
});

test("command observer counts each route once without double counting", () => {
  const observer = new ControllerCommandObserver();
  const first = observer.start();
  first.complete("builtin", "success");
  first.complete("builtin", "success"); // idempotent: a route completes once
  const second = observer.start();
  second.complete("dispatched", "failure");

  const snapshot = observer.snapshot();
  assert.equal(snapshot.received, 2);
  assert.equal(snapshot.completed, 2);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.inFlight, 0);
  assert.deepEqual(snapshot.builtin, { completed: 1, failed: 0 });
  assert.deepEqual(snapshot.dispatched, { completed: 0, failed: 1 });
});
