import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderUpdateResult } from "../dist/cli/updateCommand.js";
import { runUpdate } from "../dist/cli/updateOrchestrator.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION,
  ensureStorageSchema
} from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { MigrationRegistry } from "../dist/storage/migration/index.js";
import { currentRecordVersions } from "../dist/storage/upgrade/recordVersions.js";
import {
  runStorageUpgrade
} from "../dist/storage/upgrade/upgradeOrchestrator.js";
import { placeUpgradeFence } from "../dist/storage/upgradeFence.js";

const OLD_CONTROLLER = {
  executablePath: "/old/node",
  args: ["/old/controllerMain.js", "--captured"],
  version: "8.8.8"
};

function spawnResult(overrides = {}) {
  return {
    pid: 0,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
    ...overrides
  };
}

function okData(data) {
  return spawnResult({ stdout: Buffer.from(JSON.stringify({ ok: true, data })) });
}

function migratableHome(prefix = "yui-message145-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  const latest = {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    record: currentRecordVersions()
  };
  const registry = new MigrationRegistry();
  registry.register({
    axis: "aggregate",
    fromVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    toVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    preconditions: () => {},
    transform: (snapshot) => ({
      ...snapshot,
      schemaManifest: {
        ...snapshot.schemaManifest,
        aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION
      }
    }),
    declaredEffects: []
  });
  return { base, home, latest, registry };
}

function updateLifecyclePorts(events, overrides = {}) {
  return {
    stage: () => {
      events.push("stage");
      return {
        binaryPath: "/tmp/yui-stage/bin/yui",
        version: "9.9.9",
        stagingPath: "/tmp/yui-stage"
      };
    },
    preflight: () => {
      events.push("preflight");
      return { status: "migratable", summary: "1 step" };
    },
    activateStorage: () => {
      events.push("activate-storage");
      return { status: "migrated", backupPath: "/tmp/yui-home.backup" };
    },
    activateBinary: () => { events.push("activate-binary"); },
    verify: () => { events.push("verify"); },
    cleanup: () => { events.push("cleanup"); },
    controllerStatus: () => {
      events.push("status");
      return { running: true, pid: 41, identity: OLD_CONTROLLER };
    },
    stopController: () => {
      events.push("stop");
      return { stopped: true, pid: 41 };
    },
    startController: () => { events.push("start"); },
    restoreController: (_home, identity) => {
      events.push("restore");
      assert.deepEqual(identity, OLD_CONTROLLER);
    },
    ...overrides
  };
}

test("migratable update parent owns Controller order and starts only after activated verify", () => {
  const events = [];
  const result = runUpdate(updateLifecyclePorts(events), { home: "/tmp/yui-home" });
  assert.equal(result.outcome, "updated");
  assert.deepEqual(events, [
    "stage", "preflight", "status", "stop", "activate-storage",
    "activate-binary", "verify", "start", "cleanup"
  ]);
  assert.equal(events.indexOf("start") > events.indexOf("verify"), true);
  assert.equal(events.includes("restore"), false);
});

test("migratable pre-switch activation refusal restores the exact old Controller", () => {
  const events = [];
  const result = runUpdate(updateLifecyclePorts(events, {
    activateStorage: () => {
      events.push("activate-storage");
      return {
        status: "blocked",
        stage: "validate",
        message: "validation failed",
        action: "inspect the staged Home"
      };
    }
  }), { home: "/tmp/yui-home" });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "activate-storage");
  assert.equal(result.recoverable, true);
  assert.deepEqual(events, [
    "stage", "preflight", "status", "stop", "activate-storage", "restore", "cleanup"
  ]);
});

test("migratable post-cutover failure never restores the old Controller", () => {
  const events = [];
  const result = runUpdate(updateLifecyclePorts(events, {
    activateBinary: () => {
      events.push("activate-binary");
      throw new Error("global activation failed");
    }
  }), { home: "/tmp/yui-home" });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "activate-binary");
  assert.equal(result.recoverable, false);
  assert.deepEqual(events, [
    "stage", "preflight", "status", "stop", "activate-storage", "activate-binary", "cleanup"
  ]);
  assert.equal(events.includes("restore"), false);
});

test("binary activation failure before Home switch is not reported as a usable current install", () => {
  const result = runUpdate({
    stage: () => ({ binaryPath: "/tmp/yui-stage/bin/yui", version: "9.9.9" }),
    preflight: () => ({ status: "already-current" }),
    activateStorage: () => ({ status: "already-current" }),
    activateBinary: () => { throw new Error("npm activation outcome unknown"); },
    verify: () => {},
    cleanup: () => {}
  }, { home: "/tmp/yui-home" });

  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "activate-binary");
  assert.equal(result.recoverable, false);
  const rendered = renderUpdateResult(result);
  assert.match(rendered, /Home was not migrated/);
  assert.match(rendered, /binary health is unknown/);
  assert.match(rendered, /reinstall Yui/i);
  assert.doesNotMatch(rendered, /current install and Home remain usable/);
});

test("pre-switch activation/post-verify failure preserves binary uncertainty when restore also fails", () => {
  for (const [phase, failureKey, failureMessage] of [
    ["activate-binary", "activateBinary", "npm activation outcome unknown"],
    ["post-verify", "verify", "activated doctor failed"]
  ]) {
    const events = [];
    const result = runUpdate(updateLifecyclePorts(events, {
      activateStorage: () => {
        events.push("activate-storage");
        return { status: "already-current" };
      },
      ...(failureKey === "activateBinary"
        ? { activateBinary: () => { events.push("activate-binary"); throw new Error(failureMessage); } }
        : { verify: () => { events.push("verify"); throw new Error(failureMessage); } }),
      restoreController: () => {
        events.push("restore");
        throw new Error("restore blocker");
      }
    }), { home: "/tmp/yui-home" });
    assert.equal(result.outcome, "aborted");
    assert.equal(result.phase, phase);
    assert.equal(result.recoverable, false);
    assert.match(result.message, new RegExp(failureMessage));
    assert.match(result.message, /restore blocker/);
    assert.match(result.action, /Home was not migrated/i);
    assert.match(result.action, /binary|health|unknown/i);
    assert.match(result.action, /reinstall Yui|version|doctor|retry/i);
    assert.match(result.action, /old Controller restore also failed|restore blocker/i);
    assert.deepEqual(events, [
      "stage", "preflight", "status", "stop", "activate-storage",
      ...(failureKey === "activateBinary" ? ["activate-binary"] : ["activate-binary", "verify"]),
      "restore", "cleanup"
    ]);
  }
});

test("unknown-active replacement failure blocks restore and write-resume claims", () => {
  const events = [];
  const result = runUpdate(updateLifecyclePorts(events, {
    activateStorage: () => {
      events.push("activate-storage");
      return { status: "already-current" };
    },
    startController: () => {
      events.push("start");
      const error = new Error("PID ownership unavailable");
      error.code = "UPDATE_CONTROLLER_UNKNOWN_ACTIVE";
      throw error;
    }
  }), { home: "/tmp/yui-home" });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "post-verify");
  assert.equal(result.recoverable, false);
  assert.match(result.message, /unknown-active|ownership unavailable/i);
  assert.match(result.action, /unknown ownership|do not resume writes|quiesced/i);
  assert.equal(events.includes("restore"), false);
});

test("staged storage activation marks the child externally quiesced", () => {
  let captured;
  const ports = createUpdatePorts(process.env, (_command, _args, options) => {
    captured = options;
    return okData({ outcome: "blocked", stage: "active-runtime", message: "busy", action: "stop" });
  });
  ports.activateStorage({ binaryPath: "/tmp/staged/yui", version: "9.9.9" }, "/tmp/yui-home");
  assert.equal(captured.env.YUI_UPDATE_EXTERNALLY_QUIESCED, "1");
  assert.equal(captured.env.YUI_HOME, "/tmp/yui-home");
});

test("replacement Controller carries authenticated PID and starts through the verified global binary", () => {
  const base = mkdtempSync(join(tmpdir(), "yui-message145-global-"));
  const binDir = join(base, "bin");
  const globalBinary = join(binDir, "yui");
  const controllerEntrypoint = join(binDir, "controller", "controllerMain.js");
  mkdirSync(join(binDir, "controller"), { recursive: true });
  writeFileSync(globalBinary, "#!/bin/sh\n", { mode: 0o755 });
  const calls = [];
  const replacementPid = 42;
  let controllerArgs = [controllerEntrypoint];
  let controllerVersion = "9.9.9";
  const spawn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (command === "npm" && args[0] === "prefix") {
      return spawnResult({ stdout: Buffer.from(base) });
    }
    if (command === globalBinary && args.includes("doctor")) {
      return okData({
        checks: [
          { name: "storage schema", status: "ok", detail: "current" },
          { name: "storage compatibility", status: "ok", detail: "USABLE" },
          { name: "storage state", status: "ok", detail: "readable" }
        ],
        storage: { healthy: true, blocking: [] }
      });
    }
    if (command === globalBinary && args.includes("version")) {
      return okData({ version: "9.9.9" });
    }
    if (command === globalBinary && args.includes("restart")) {
      return spawnResult({
        stdout: Buffer.from(JSON.stringify({
          ok: true,
          output: "Controller restarted.",
          data: { restarted: true, previousPid: 41, pid: replacementPid }
        }))
      });
    }
    if (command === globalBinary && args.includes("status")) {
      return okData({
        resources: [{
          kind: "controller",
          state: "current",
          yuiHome: "/tmp/yui-home",
          processes: [{ pid: replacementPid }]
        }],
        warnings: []
      });
    }
    if (command === globalBinary && args.includes("identity")) {
      return okData({
        executablePath: process.execPath,
        args: controllerArgs,
        version: controllerVersion
      });
    }
    return spawnResult();
  };

  try {
    const ports = createUpdatePorts(process.env, spawn);
    const staged = { binaryPath: "/tmp/staged/yui", version: "9.9.9" };
    ports.verify(staged, "/tmp/yui-home");
    ports.startController("/tmp/yui-home");

    const restart = calls.find((call) => call.args.includes("restart"));
    const identity = calls.find((call) => call.args.includes("identity"));
    assert.equal(restart.command, globalBinary);
    assert.equal(identity.command, globalBinary);
    assert.equal(calls.some((call) => call.command === process.execPath
      && call.args.includes("controller") && call.args.includes("restart")), false);

    controllerArgs = ["/wrong/controllerMain.js"];
    controllerVersion = "8.8.8";
    // The replacement PID is still the one authenticated by restart/readiness,
    // so the fenced cleanup is allowed to stop it and no foreign process is
    // touched.
    const stopResult = okData({ stopped: true, pid: replacementPid });
    const originalSpawn = spawn;
    // The test seam receives the internal PID-fenced stop helper as a Node -e
    // invocation. Return its structured confirmation deterministically.
    let stopInvocations = 0;
    const stopAwareSpawn = (command, args, options) => {
      if (command === process.execPath && args[0] === "-e") {
        stopInvocations += 1;
        return stopResult;
      }
      return originalSpawn(command, args, options);
    };
    const stopAwarePorts = createUpdatePorts(process.env, stopAwareSpawn);
    stopAwarePorts.verify({ binaryPath: "/tmp/staged/yui", version: "9.9.9" }, "/tmp/yui-home");
    // Reuse the same activated-binary seam and deliberately mismatch both argv
    // and version; the PID fence must run before the failure is surfaced.
    assert.throws(
      () => stopAwarePorts.startController("/tmp/yui-home"),
      /Replacement Controller (?:version|launch identity)/i
    );
    assert.equal(stopInvocations, 1, "mismatch cleanup must use exactly one PID-fenced stop");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("replacement identity mismatch with unproven PID returns an unknown-active blocker", () => {
  const base = mkdtempSync(join(tmpdir(), "yui-message145-unknown-active-"));
  const binDir = join(base, "bin");
  const globalBinary = join(binDir, "yui");
  const controllerEntrypoint = join(binDir, "controller", "controllerMain.js");
  mkdirSync(join(binDir, "controller"), { recursive: true });
  writeFileSync(globalBinary, "#!/bin/sh\n", { mode: 0o755 });
  let controllerPid = 99;
  let stopCalls = 0;
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "prefix") return spawnResult({ stdout: Buffer.from(base) });
    if (command === globalBinary && args.includes("doctor")) {
      return okData({
        checks: [
          { name: "storage schema", status: "ok", detail: "current" },
          { name: "storage compatibility", status: "ok", detail: "USABLE" },
          { name: "storage state", status: "ok", detail: "readable" }
        ],
        storage: { healthy: true, blocking: [] }
      });
    }
    if (command === globalBinary && args.includes("version")) return okData({ version: "9.9.9" });
    if (command === globalBinary && args.includes("restart")) {
      return spawnResult({ stdout: Buffer.from(JSON.stringify({
        ok: true,
        output: "Controller restarted.",
        data: { restarted: true, pid: 42 }
      })) });
    }
    if (command === globalBinary && args.includes("status")) {
      return okData({
        resources: [{
          kind: "controller",
          state: "current",
          yuiHome: "/tmp/yui-home",
          processes: [{ pid: controllerPid }]
        }],
        warnings: []
      });
    }
    if (command === globalBinary && args.includes("identity")) {
      return okData({ executablePath: process.execPath, args: [controllerEntrypoint], version: "8.8.8" });
    }
    if (command === process.execPath && args[0] === "-e") {
      stopCalls += 1;
      return okData({ stopped: true, pid: 42 });
    }
    return spawnResult();
  };
  try {
    const ports = createUpdatePorts(process.env, spawn);
    ports.verify({ binaryPath: "/tmp/staged/yui", version: "9.9.9" }, "/tmp/yui-home");
    assert.throws(
      () => ports.startController("/tmp/yui-home"),
      /unknown-active/i
    );
    assert.equal(stopCalls, 0, "a PID mismatch must not stop a foreign/unknown process");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("externally-quiesced storage upgrade never probes or starts a Controller", async () => {
  const fixture = migratableHome("yui-message145-external-");
  try {
    const events = [];
    const result = await runStorageUpgrade({
      home: fixture.home,
      latest: fixture.latest,
      registry: fixture.registry,
      mode: "execute",
      controllerLifecycle: "externally-quiesced",
      controllerStatus: async () => { events.push("status"); throw new Error("must not probe"); },
      stopController: async () => { events.push("stop"); throw new Error("must not stop"); },
      startController: async () => { events.push("start"); throw new Error("must not start"); }
    });
    assert.equal(result.outcome, "upgraded");
    assert.deepEqual(events, []);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("upgraded activation requires a non-empty absolute backupPath", () => {
  for (const backupPath of [undefined, "", "relative/backup", " /tmp/backup"]) {
    const ports = createUpdatePorts(process.env, () => okData({
      outcome: "upgraded",
      ...(backupPath === undefined ? {} : { backupPath })
    }));
    const result = ports.activateStorage(
      { binaryPath: "/tmp/staged/yui", version: "9.9.9" },
      "/tmp/yui-home"
    );
    assert.equal(result.status, "ambiguous", `backupPath=${String(backupPath)}`);
  }
  const valid = createUpdatePorts(process.env, () => okData({
    outcome: "upgraded",
    backupPath: "/tmp/yui-home.backup"
  })).activateStorage(
    { binaryPath: "/tmp/staged/yui", version: "9.9.9" },
    "/tmp/yui-home"
  );
  assert.deepEqual(valid, { status: "migrated", backupPath: "/tmp/yui-home.backup" });
});

test("live upgrade fence contention is a structured coordination blocker", async () => {
  const fixture = migratableHome("yui-message145-fence-");
  const release = placeUpgradeFence(fixture.home, {
    reason: "foreign live upgrade",
    createdAt: "2026-08-07T00:00:00.000Z",
    ownerPid: process.pid
  });
  try {
    const result = await runStorageUpgrade({
      home: fixture.home,
      latest: fixture.latest,
      registry: fixture.registry,
      mode: "execute",
      callerPid: process.pid + 100_000
    });
    assert.equal(result.outcome, "blocked");
    assert.equal(result.stage, "coordination");
    assert.match(result.message, /fenced|coordination/i);
    assert.match(result.action, /wait|retry/i);
  } finally {
    release();
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("cleanup failure preserves the determined update and exposes a warning", () => {
  const result = runUpdate(updateLifecyclePorts([], {
    cleanup: () => { throw new Error("permission denied"); },
    preflight: () => ({ status: "already-current" })
  }), { home: "/tmp/yui-home" });
  assert.equal(result.outcome, "updated");
  assert.match(result.cleanupWarning, /permission denied/);
  assert.match(renderUpdateResult(result), /Warning:.*permission denied/);
});
