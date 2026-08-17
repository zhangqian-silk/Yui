import assert from "node:assert/strict";
import test from "node:test";

import { terminateSessionOwners } from "../../dist/runtime/sessionTerminationGuard.js";

function ownerRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "yui-session-owner",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "agent-1",
    adapterId: "codex",
    launchId: "launch-1",
    tmux: {
      serverName: "yui-server",
      socketPath: "/tmp/tmux-1000/yui-server",
      sessionName: "yui-abc-task-1",
      windowName: "leader",
      panePid: 100
    },
    providerRoot: {
      pid: 100,
      startIdentity: "1000",
      processGroupId: 100,
      attribution: "launch-env"
    },
    recordedAt: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

function fakePorts(overrides = {}) {
  const events = [];
  const signals = [];
  const groupSignals = [];
  const live = new Map(overrides.live ?? [[100, "1000"]]);
  const fencedChildren = new Map(overrides.fencedChildren ?? []);
  const killPid = (pid) => {
    live.delete(pid);
    for (const [launchId, pids] of fencedChildren) {
      fencedChildren.set(launchId, pids.filter((candidate) => candidate !== pid));
    }
  };
  return {
    events,
    signals,
    groupSignals,
    ports: {
      gracefulStop: overrides.gracefulStop ?? (async () => true),
      processIdentity: (pid) => {
        const startIdentity = live.get(pid);
        return startIdentity === undefined
          ? undefined
          : { pid, startIdentity, rssBytes: 1024 };
      },
      // Tests use synthetic PIDs; by default the /proc entry is gone once
      // the fake live map drops a pid, which reads as "absent".
      procEntryExists: overrides.procEntryExists ?? (() => false),
      listLaunchFencedProcesses: (launchId) => fencedChildren.get(launchId) ?? [],
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (overrides.dieOnSignal === true || signal === "SIGKILL") {
          killPid(pid);
        }
      },
      signalProcessGroup: (pgid, signal) => {
        groupSignals.push([pgid, signal]);
        if (signal === "SIGKILL") {
          for (const pid of [...live.keys()]) live.delete(pid);
        }
      },
      sleep: overrides.sleep ?? (async () => {}),
      emit: (event) => events.push(event),
      now: () => new Date("2026-08-17T00:00:00.000Z"),
      ...overrides.ports
    },
    setLive(pid, startIdentity) {
      live.set(pid, startIdentity);
    },
    kill: killPid,
    addFencedChild(launchId, pid, startIdentity) {
      const pids = fencedChildren.get(launchId) ?? [];
      fencedChildren.set(launchId, [...pids, pid]);
      live.set(pid, startIdentity);
    }
  };
}

const owner = { scope: "task", taskId: "task-1", roleName: "leader" };

test("graceful stop confirms when the root exits within the grace period", async () => {
  const harness = fakePorts({
    gracefulStop: async () => {
      harness.kill(100);
      return true;
    }
  });
  const result = await terminateSessionOwners(
    owner,
    [ownerRecord()],
    harness.ports,
    { gracefulGraceMs: 500, pollMs: 10 }
  );
  assert.equal(result.outcome, "stop-confirmed");
  assert.deepEqual(result.confirmed.map((record) => record.launchId), ["launch-1"]);
  assert.deepEqual(result.remaining, []);
  const stages = harness.events.map((event) => event.stage);
  assert.deepEqual(stages, ["stop-requested", "graceful-stop", "stop-confirmed"]);
  assert.deepEqual(harness.signals, []);
});

test("a stubborn root is escalated SIGTERM then SIGKILL and confirmed", async () => {
  const harness = fakePorts({ dieOnSignal: false });
  const result = await terminateSessionOwners(
    owner,
    [ownerRecord()],
    harness.ports,
    { gracefulGraceMs: 30, forcedGraceMs: 30, pollMs: 5 }
  );
  assert.equal(result.outcome, "stop-confirmed");
  assert.ok(harness.signals.some(([, signal]) => signal === "SIGTERM"));
  assert.ok(harness.signals.some(([, signal]) => signal === "SIGKILL"));
  const stages = harness.events.map((event) => event.stage);
  assert.deepEqual(stages, ["stop-requested", "graceful-stop", "forced-stop", "stop-confirmed"]);
});

test("a root that survives every signal blocks the stop and preserves the record", async () => {
  const harness = fakePorts({ dieOnSignal: false });
  // Override signalProcess to never kill.
  harness.ports.signalProcess = (pid, signal) => harness.signals.push([pid, signal]);
  harness.ports.signalProcessGroup = (pgid, signal) => harness.groupSignals.push([pgid, signal]);
  const result = await terminateSessionOwners(
    owner,
    [ownerRecord()],
    harness.ports,
    { gracefulGraceMs: 20, forcedGraceMs: 20, pollMs: 5 }
  );
  assert.equal(result.outcome, "stop-blocked");
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].record.launchId, "launch-1");
  assert.match(result.remaining[0].detail, /still live/);
  assert.deepEqual(result.confirmed, []);
  const stages = harness.events.map((event) => event.stage);
  assert.equal(stages[stages.length - 1], "stop-blocked");
});

test("a reused PID with a different start identity is treated as absent", async () => {
  const harness = fakePorts();
  // The PID slot is live, but it is a different process (PID reuse).
  harness.setLive(100, "9999");
  const result = await terminateSessionOwners(
    owner,
    [ownerRecord()],
    harness.ports,
    { gracefulGraceMs: 50, pollMs: 5 }
  );
  assert.equal(result.outcome, "stop-confirmed");
  // The reused PID must never be signaled.
  assert.deepEqual(harness.signals, []);
});

test("an unreadable /proc is a verification gap, not a confirmation", async () => {
  const harness = fakePorts({ procEntryExists: () => true });
  harness.ports.processIdentity = () => undefined;
  // Simulate the /proc entry still existing (unreadable) vs gone.
  const result = await terminateSessionOwners(
    owner,
    [ownerRecord()],
    harness.ports,
    { gracefulGraceMs: 20, pollMs: 5 }
  );
  // processIdentity undefined + entry exists => gap => blocked.
  assert.equal(result.outcome, "stop-blocked");
  assert.ok(result.verificationGap !== undefined || result.remaining.length > 0);
});

test("no owner records falls back to tmux-level confirmation", async () => {
  const harness = fakePorts();
  const result = await terminateSessionOwners(
    owner,
    [],
    harness.ports,
    {}
  );
  assert.equal(result.outcome, "stop-confirmed");
  assert.deepEqual(result.confirmed, []);
});

test("multiple records are confirmed or blocked independently", async () => {
  const harness = fakePorts({ dieOnSignal: false });
  harness.ports.signalProcess = (pid, signal) => {
    harness.signals.push([pid, signal]);
    if (pid === 200) harness.kill(pid);
  };
  harness.ports.signalProcessGroup = () => {};
  const result = await terminateSessionOwners(
    owner,
    [
      ownerRecord(),
      ownerRecord({
        launchId: "launch-2",
        providerRoot: { pid: 200, startIdentity: "2000", attribution: "launch-env" }
      })
    ],
    harness.ports,
    { gracefulGraceMs: 20, forcedGraceMs: 20, pollMs: 5 }
  );
  assert.equal(result.outcome, "stop-blocked");
  assert.deepEqual(result.confirmed.map((record) => record.launchId), ["launch-2"]);
  assert.deepEqual(result.remaining.map(({ record }) => record.launchId), ["launch-1"]);
});

test("a root that exits first still reaps its fenced child", async () => {
  // Race: the Provider root exits during the graceful window (pane gone) but
  // a child carrying the exact launch fence survives. The guard must not
  // confirm on the root alone: it escalates against the fenced child and
  // only confirms once the whole tree is absent.
  const harness = fakePorts({
    gracefulStop: async () => {
      harness.kill(100);
      return true;
    }
  });
  harness.addFencedChild("launch-1", 101, "1010");
  const result = await terminateSessionOwners(
    owner,
    [ownerRecord()],
    harness.ports,
    { gracefulGraceMs: 20, forcedGraceMs: 20, pollMs: 5 }
  );
  assert.equal(result.outcome, "stop-confirmed");
  assert.deepEqual(result.confirmed.map((record) => record.launchId), ["launch-1"]);
  // The child was signaled directly (the group can no longer be proven ours
  // once its leader is gone); the dead root was never signaled.
  assert.ok(harness.signals.some(([pid]) => pid === 101));
  assert.ok(!harness.signals.some(([pid]) => pid === 100));
  const stages = harness.events.map((event) => event.stage);
  assert.deepEqual(stages, ["stop-requested", "graceful-stop", "forced-stop", "stop-confirmed"]);
});

test("a child without the launch fence is unattributed and never signaled", async () => {
  const harness = fakePorts({
    gracefulStop: async () => {
      harness.kill(100);
      return true;
    }
  });
  // A live process that does NOT carry the exact YUI_LAUNCH_ID fence: it is
  // unattributed, so the guard confirms the owned tree and never signals it.
  harness.setLive(101, "1010");
  const result = await terminateSessionOwners(
    owner,
    [ownerRecord()],
    harness.ports,
    { gracefulGraceMs: 20, pollMs: 5 }
  );
  assert.equal(result.outcome, "stop-confirmed");
  assert.ok(!harness.signals.some(([pid]) => pid === 101));
});
