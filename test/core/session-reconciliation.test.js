import assert from "node:assert/strict";
import test from "node:test";

import { reconcileSessionOwners } from "../../dist/runtime/sessionReconciliation.js";

function ownerRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "yui-session-owner",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "agent-1",
    adapterId: "codex",
    launchId: "launch-1",
    nativeSessionId: "native-1",
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

function durableFact(overrides = {}) {
  return {
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "agent-1",
    adapterId: "codex",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    status: "running",
    inHistory: false,
    ...overrides
  };
}

function livePhysical() {
  return {
    alive: true,
    identityConflict: false,
    pid: 100,
    startIdentity: "1000",
    rssBytes: 4096,
    ageMs: 1000,
    childCount: 1
  };
}

function absentPhysical() {
  return {
    alive: false,
    identityConflict: false,
    pid: 100,
    startIdentity: "1000",
    rssBytes: 0,
    ageMs: 0,
    childCount: 0
  };
}

function reconcile(overrides = {}) {
  const record = ownerRecord(overrides.record ?? {});
  return reconcileSessionOwners({
    records: [record],
    durable: [durableFact(overrides.durable ?? {})],
    taskStatus: overrides.taskStatus ?? (() => "archived"),
    observe: overrides.observe ?? (() => livePhysical()),
    inspectPane: overrides.inspectPane ?? (() => ({ target: "yui-abc-task-1:leader", dead: false })),
    lastStopOutcome: overrides.lastStopOutcome ?? (() => undefined),
    now: new Date("2026-08-17T00:00:00.000Z")
  });
}

test("a live root with a terminal durable session is a durable-terminal-physical-live mismatch", () => {
  const report = reconcile({
    durable: { status: "stopped" }
  });
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].mismatch, "durable-terminal-physical-live");
  assert.equal(report.summary.livePhysicalRoots, 1);
});

test("archive is blocked for a terminal-task leak", () => {
  const report = reconcile({
    durable: { status: "stopped" }
  });
  assert.equal(report.entries[0].mismatch, "durable-terminal-physical-live");
  assert.equal(report.entries[0].archiveBlocked, true);
  assert.equal(report.summary.archiveBlockers, 1);
});

test("archive is blocked only for terminal/archived Tasks", () => {
  const archived = reconcileSessionOwners({
    records: [ownerRecord()],
    durable: [durableFact({ status: "stopped" })],
    taskStatus: () => "archived",
    observe: () => livePhysical(),
    inspectPane: () => ({ target: "yui-abc-task-1:leader", dead: true }),
    lastStopOutcome: () => undefined,
    now: new Date("2026-08-17T00:00:00.000Z")
  });
  assert.equal(archived.entries[0].archiveBlocked, true);
  assert.equal(archived.summary.archiveBlockers, 1);

  const active = reconcileSessionOwners({
    records: [ownerRecord()],
    durable: [durableFact({ status: "stopped" })],
    taskStatus: () => "active",
    observe: () => livePhysical(),
    inspectPane: () => ({ target: "yui-abc-task-1:leader", dead: true }),
    lastStopOutcome: () => undefined,
    now: new Date("2026-08-17T00:00:00.000Z")
  });
  assert.equal(active.entries[0].archiveBlocked, false);
});

test("a durable running session whose physical root is absent is durable-live-physical-absent", () => {
  const report = reconcile({
    durable: { status: "running" },
    observe: () => absentPhysical()
  });
  assert.equal(report.entries[0].mismatch, "durable-live-physical-absent");
  assert.equal(report.entries[0].archiveBlocked, false);
});

test("PID reuse (identity conflict) is never a cleanup candidate", () => {
  const report = reconcile({
    durable: { status: "stopped" },
    observe: () => ({
      alive: false,
      identityConflict: true,
      pid: 100,
      startIdentity: "1000",
      rssBytes: 4096,
      ageMs: 1000,
      childCount: 0
    })
  });
  assert.equal(report.entries[0].mismatch, "identity-conflict");
  assert.equal(report.entries[0].archiveBlocked, false);
});

test("a missing durable session map still attributes the physical generation", () => {
  // The audit's exact gap: durable current map is empty, physical process live.
  const report = reconcileSessionOwners({
    records: [ownerRecord()],
    durable: [],
    taskStatus: () => "archived",
    observe: () => livePhysical(),
    inspectPane: () => undefined,
    lastStopOutcome: () => undefined,
    now: new Date("2026-08-17T00:00:00.000Z")
  });
  assert.equal(report.entries[0].durableStatus, "absent");
  assert.equal(report.entries[0].mismatch, "durable-terminal-physical-live");
  assert.equal(report.entries[0].physical.alive, true);
});

test("the last stop outcome is surfaced in the report", () => {
  const report = reconcile({
    durable: { status: "stopped" },
    lastStopOutcome: () => "stop-blocked"
  });
  assert.equal(report.entries[0].lastStopOutcome, "stop-blocked");
});

test("a /proc observation gap is reported as a verification gap", () => {
  const report = reconcile({
    durable: { status: "stopped" },
    observe: () => undefined
  });
  assert.equal(report.entries[0].verificationGap, "/proc identity unavailable");
  assert.equal(report.summary.verificationGaps, 1);
});
