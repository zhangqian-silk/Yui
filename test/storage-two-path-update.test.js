import assert from "node:assert/strict";
import test from "node:test";

import { runUpdate } from "../dist/cli/updateOrchestrator.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";

const OLD_CONTROLLER = {
  executablePath: "/old/node",
  args: ["/old/controllerMain.js"],
  version: "1.0.0"
};

function basePorts(events, preflight) {
  return {
    stage: () => {
      events.push("stage");
      return { binaryPath: "/staged/yui", version: "2.0.0" };
    },
    preflight: () => {
      events.push("preflight");
      return preflight;
    },
    controllerStatus: () => {
      events.push("controller-status");
      return { running: true, pid: 41, identity: OLD_CONTROLLER };
    },
    stopController: (_home, expectedPid) => {
      events.push("controller-stop");
      assert.equal(expectedPid, 41);
      return { stopped: true, pid: 41 };
    },
    stopReplacementController: () => ({ stopped: true }),
    restoreController: () => events.push("controller-restore"),
    startController: () => events.push("controller-start"),
    activateStorage: () => {
      events.push("activate-storage");
      return { status: "migrated", backupPath: "/tmp/home.backup" };
    },
    activateBinary: () => events.push("activate-binary"),
    verify: () => events.push("verify"),
    probeStorage: () => ({ switched: false, schemaCurrent: false }),
    cleanup: () => events.push("cleanup")
  };
}

test("compatible-old takes the fast path without copying or activating storage", () => {
  const events = [];
  const result = runUpdate(
    basePorts(events, { status: "compatible", summary: "2 compatible normalization(s)" }),
    { home: "/isolated/home" }
  );

  assert.equal(result.outcome, "updated");
  assert.equal(result.path, "compatible-fast");
  assert.deepEqual(events, [
    "stage",
    "preflight",
    "controller-status",
    "controller-stop",
    "activate-binary",
    "verify",
    "controller-start",
    "cleanup"
  ]);
});

test("migration blockers return exact identities before Controller or Home changes", () => {
  const events = [];
  const blocker = {
    taskId: "task-8",
    roleName: "worker",
    runId: "agent-run-3",
    nativeSessionId: "native-9",
    reason: "active-run"
  };
  const result = runUpdate(
    basePorts(events, {
      status: "blocked",
      stage: "active-sessions",
      message: "Offline migration blocked by 1 active runtime item.",
      action: "Keep working; when it clears, re-run `yui update`.",
      blockers: [blocker],
      retryCommand: "yui update",
      sceneUnchanged: true
    }),
    { home: "/isolated/home" }
  );

  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "preflight");
  assert.deepEqual(result.blockers, [blocker]);
  assert.equal(result.retryCommand, "yui update");
  assert.equal(result.sceneUnchanged, true);
  assert.deepEqual(events, ["stage", "preflight", "cleanup"]);
});

test("migration-required retains the recoverable offline switch", () => {
  const events = [];
  const result = runUpdate(
    basePorts(events, { status: "migration-required", summary: "1 offline step" }),
    { home: "/isolated/home" }
  );
  assert.equal(result.outcome, "updated");
  assert.equal(result.path, "offline-migration");
  assert.equal(result.storageBackupPath, "/tmp/home.backup");
  assert.deepEqual(events, [
    "stage",
    "preflight",
    "controller-status",
    "controller-stop",
    "activate-storage",
    "activate-binary",
    "verify",
    "controller-start",
    "cleanup"
  ]);
});

test("an activation-time race blocker preserves exact identity through the parent update", () => {
  const events = [];
  const blocker = {
    taskId: "task-12",
    roleName: "reviewer",
    runId: "agent-run-14",
    nativeSessionId: "native-14",
    launchId: "launch-14",
    reason: "active-run"
  };
  const ports = {
    ...basePorts(events, { status: "migration-required", summary: "1 offline step" }),
    activateStorage: () => {
      events.push("activate-storage");
      return {
        status: "blocked",
        stage: "active-sessions",
        message: "A Run appeared after preflight.",
        action: "Let it settle and re-run yui update.",
        blockers: [blocker],
        retryCommand: "yui update"
      };
    }
  };

  const result = runUpdate(ports, { home: "/isolated/home" });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "activate-storage");
  assert.deepEqual(result.blockers, [blocker]);
  assert.equal(result.retryCommand, "yui update");
  assert.deepEqual(events, [
    "stage", "preflight", "controller-status", "controller-stop",
    "activate-storage", "controller-restore", "cleanup"
  ]);
});

test("staged preflight preserves the shared compatible/migration/blocker classification", () => {
  const response = (data, status = 0) => ({
    pid: 1,
    output: [],
    stdout: Buffer.from(JSON.stringify({ ok: true, data })),
    stderr: Buffer.from(""),
    status,
    signal: null
  });
  const staged = { binaryPath: "/staged/yui", version: "2.0.0" };

  const current = createUpdatePorts({}, () => response({
    outcome: "update-preflight",
    status: "already-current",
    stepCount: 0,
    classification: {
      classification: { verdict: "USABLE", status: "current" }
    }
  }));
  assert.equal(current.preflight(staged, "/home").status, "already-current");

  const compatible = createUpdatePorts({}, () => response({
    outcome: "update-preflight",
    status: "compatible",
    stepCount: 1,
    classification: {
      classification: { verdict: "COMPATIBLE", status: "compatible-old", stepCount: 1 }
    }
  }));
  const compatibleResult = compatible.preflight(staged, "/home");
  assert.equal(compatibleResult.status, "compatible");
  assert.match(compatibleResult.summary, /compatible source validated in memory/i);
  assert.match(compatibleResult.summary, /No staged Home or staged-output loader validation/i);

  const migration = createUpdatePorts({}, () => response({
    outcome: "update-preflight",
    status: "migration-required",
    stepCount: 1,
    classification: {
      classification: { verdict: "MIGRATABLE", status: "migration-required", stepCount: 1 }
    }
  }));
  assert.equal(migration.preflight(staged, "/home").status, "migration-required");

  const blocker = {
    taskId: "task-1", roleName: "leader", runId: "agent-run-1",
    nativeSessionId: "native-1", reason: "active-run"
  };
  const blocked = createUpdatePorts({}, () => response({
    outcome: "blocked",
    stage: "active-sessions",
    message: "blocked",
    action: "re-run",
    blockers: [blocker],
    retryCommand: "yui update",
    sceneUnchanged: true
  }, 5)).preflight(staged, "/home");
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockers, [blocker]);
  assert.equal(blocked.sceneUnchanged, true);
});

test("staged update fails closed on malformed or contradictory preflight states", () => {
  const malformed = [
    {
      outcome: "update-preflight",
      status: "migration-required",
      stepCount: 1
    },
    {
      outcome: "update-preflight",
      status: "migration-required",
      stepCount: -1,
      classification: {
        classification: { verdict: "MIGRATABLE", status: "migration-required", stepCount: -1 }
      }
    },
    {
      outcome: "update-preflight",
      status: "migration-required",
      stepCount: 1,
      classification: {
        classification: { verdict: "COMPATIBLE", status: "compatible-old", stepCount: 1 }
      }
    },
    {
      outcome: "update-preflight",
      status: "already-current",
      stepCount: 1,
      classification: {
        classification: { verdict: "USABLE", status: "current" }
      }
    }
  ];
  const staged = { binaryPath: "/staged/yui", version: "2.0.0" };

  for (const data of malformed) {
    const response = {
      pid: 1,
      output: [],
      stdout: Buffer.from(JSON.stringify({ ok: true, data })),
      stderr: Buffer.from(""),
      status: 0,
      signal: null
    };
    const preflight = createUpdatePorts({}, () => response).preflight(staged, "/home");
    assert.equal(preflight.status, "blocked");
    assert.match(preflight.message, /malformed/i);
  }
});

test("staged update uses the internal path-specific preflight contract", () => {
  const calls = [];
  const response = {
    pid: 1,
    output: [],
    stdout: Buffer.from(JSON.stringify({
      ok: true,
      data: {
        outcome: "update-preflight",
        status: "migration-required",
        stepCount: 1,
        classification: {
          classification: { verdict: "MIGRATABLE", status: "migration-required", stepCount: 1 }
        }
      }
    })),
    stderr: Buffer.from(""),
    status: 0,
    signal: null
  };
  const ports = createUpdatePorts({}, (command, args) => {
    calls.push({ command, args });
    return response;
  });

  const preflight = ports.preflight(
    { binaryPath: "/staged/yui", version: "2.0.0" },
    "/home"
  );

  assert.equal(preflight.status, "migration-required");
  assert.deepEqual(calls, [{
    command: "/staged/yui",
    args: ["--json", "upgrade", "--update-preflight"]
  }]);
});

test("staged update fails closed on a user dry-run outcome", () => {
  const response = {
    pid: 1,
    output: [],
    stdout: Buffer.from(JSON.stringify({
      ok: true,
      data: { outcome: "dry-run", report: { outcome: "dry-run", steps: [{}] } }
    })),
    stderr: Buffer.from(""),
    status: 0,
    signal: null
  };
  const ports = createUpdatePorts({}, () => response);
  const preflight = ports.preflight(
    { binaryPath: "/staged/yui", version: "2.0.0" },
    "/home"
  );

  assert.equal(preflight.status, "blocked");
  assert.match(preflight.message, /unexpected|preflight contract/i);
});
