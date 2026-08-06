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

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION,
  ensureStorageSchema
} from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { MigrationRegistry } from "../dist/storage/migration/index.js";
import { currentRecordVersions } from "../dist/storage/upgrade/recordVersions.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";

function currentHome(prefix = "yui-convergence-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

function migratableSetup(home) {
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
    // Keep the real aggregate version in the synthetic output so the fresh
    // loader still exercises the production schema gate.
    transform: (snapshot) => ({
      ...snapshot,
      schemaManifest: {
        ...snapshot.schemaManifest,
        aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION
      }
    }),
    declaredEffects: []
  });
  return { home, latest, registry };
}

function stageRoot() {
  return mkdtempSync(join(tmpdir(), "yui-convergence-stage-root-"));
}

function withStageRoot(run) {
  const root = stageRoot();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stageDirs(root) {
  return new Set(
    readdirSync(root).filter((name) => name.startsWith("yui-update-stage-"))
  );
}

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

function assertNoNewStageDirs(before, root) {
  const leaked = [...stageDirs(root)].filter((name) => !before.has(name));
  assert.deepEqual(leaked, []);
}

test("stage cleans the temporary prefix when npm reports a failure", () => {
  withStageRoot((root) => {
    const before = stageDirs(root);
    const ports = createUpdatePorts(process.env, () => spawnResult({ status: 17 }), root);
    assert.throws(() => ports.stage(), /Failed to stage the new package/);
    assertNoNewStageDirs(before, root);
  });
});

test("stage cleans the temporary prefix when spawn throws a network error", () => {
  withStageRoot((root) => {
    const before = stageDirs(root);
    const ports = createUpdatePorts(process.env, () => {
      throw new Error("network unavailable");
    }, root);
    assert.throws(() => ports.stage(), /network unavailable/);
    assertNoNewStageDirs(before, root);
  });
});

test("stage cleans the temporary prefix when version probing throws", () => {
  withStageRoot((root) => {
    const before = stageDirs(root);
    let installs = 0;
    const ports = createUpdatePorts(process.env, (_command, args) => {
      if (args[0] === "install") {
        installs += 1;
        return spawnResult();
      }
      throw new Error("version probe failed");
    }, root);
    assert.throws(() => ports.stage(), /version probe failed/);
    assert.equal(installs, 1);
    assertNoNewStageDirs(before, root);
  });
});

test("successful stage transfers cleanup ownership to the returned package", () => {
  withStageRoot((root) => {
    const before = stageDirs(root);
    const ports = createUpdatePorts(process.env, (_command, args) => {
      if (args[0] === "install") return spawnResult();
      return spawnResult({
        stdout: Buffer.from(JSON.stringify({ ok: true, data: { version: "9.9.9" } }))
      });
    }, root);
    const staged = ports.stage();
    assert.equal(existsSync(staged.stagingPath), true);
    ports.cleanup(staged);
    assertNoNewStageDirs(before, root);
  });
});

test("blocked upgrade restores a Controller that was running before quiesce", async () => {
  const { home } = currentHome("yui-convergence-restore-");
  const { latest, registry } = migratableSetup(home);
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "1\n");
  const events = [];
  const result = await runStorageUpgrade({
    home,
    latest,
    registry,
    mode: "execute",
    controllerStatus: async () => {
      events.push("status");
      return { running: true, pid: 123 };
    },
    stopController: async () => {
      events.push("stop");
      return { stopped: true, pid: 123 };
    },
    startController: async () => { events.push("start"); }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-runtime");
  assert.deepEqual(events, ["status", "stop", "start"]);
});

test("stop timeout is a structured active-runtime blocker without retry or restore", async () => {
  const { home } = currentHome("yui-convergence-stop-");
  const { latest, registry } = migratableSetup(home);
  const events = [];
  const result = await runStorageUpgrade({
    home,
    latest,
    registry,
    mode: "execute",
    controllerStatus: async () => {
      events.push("status");
      return { running: true, pid: 123 };
    },
    stopController: async () => {
      events.push("stop");
      throw new Error("shutdown timeout");
    },
    startController: async () => { events.push("start"); }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-runtime");
  assert.match(result.message, /shutdown timeout/);
  assert.deepEqual(events, ["status", "stop"]);
});

test("successful switch starts the replacement Controller after verification", async () => {
  const { home } = currentHome("yui-convergence-success-");
  const { latest, registry } = migratableSetup(home);
  const events = [];
  const result = await runStorageUpgrade({
    home,
    latest,
    registry,
    mode: "execute",
    controllerStatus: async () => {
      events.push("status");
      return { running: true, pid: 123 };
    },
    stopController: async () => {
      events.push("stop");
      return { stopped: true, pid: 123 };
    },
    startController: async () => {
      assert.equal(existsSync(home), true);
      events.push("start");
    }
  });
  assert.equal(result.outcome, "upgraded");
  assert.deepEqual(events, ["status", "stop", "start"]);
});

test("ambiguous switch remains fail-closed and does not restore the old Controller", async () => {
  const { home } = currentHome("yui-convergence-ambiguous-");
  const { latest, registry } = migratableSetup(home);
  const events = [];
  const result = await runStorageUpgrade({
    home,
    latest,
    registry,
    mode: "execute",
    controllerStatus: async () => {
      events.push("status");
      return { running: true, pid: 123 };
    },
    stopController: async () => {
      events.push("stop");
      return { stopped: true, pid: 123 };
    },
    startController: async () => { events.push("start"); },
    switchFaultHook: (step) => {
      if (step === "post-backup-fsync") throw new Error("injected switch fault");
    },
    // The first move (Home -> backup) uses the real atomic rename. Both the
    // promotion and rollback are forced to fail, producing the true ambiguous
    // switch outcome without retrying either operation.
    renameImpl: () => { throw new Error("promotion unavailable"); }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "switch-ambiguous");
  assert.deepEqual(events, ["status", "stop"]);
});

test("post-switch receipt failure is structured and never restores the old Controller", async () => {
  const { home } = currentHome("yui-convergence-post-switch-");
  const { latest, registry } = migratableSetup(home);
  const events = [];
  const result = await runStorageUpgrade({
    home,
    latest,
    registry,
    mode: "execute",
    controllerStatus: async () => {
      events.push("status");
      return { running: true, pid: 123 };
    },
    stopController: async () => {
      events.push("stop");
      return { stopped: true, pid: 123 };
    },
    startController: async () => { events.push("restore-or-start"); },
    postSwitchFaultHook: (step) => {
      if (step === "receipt-write") throw new Error("receipt write injected");
    }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "post-verify");
  assert.equal(result.switchCommitted, true);
  assert.match(result.message, /receipt write injected/);
  assert.match(result.action, /upgrade-receipt|upgrade-switch|backup/i);
  assert.deepEqual(events, ["status", "stop"]);
});

test("post-switch receipt-clear failure retains commit guard and recovery evidence", async () => {
  const { home } = currentHome("yui-convergence-receipt-clear-");
  const { latest, registry } = migratableSetup(home);
  const events = [];
  const result = await runStorageUpgrade({
    home,
    latest,
    registry,
    mode: "execute",
    controllerStatus: async () => {
      events.push("status");
      return { running: true, pid: 123 };
    },
    stopController: async () => {
      events.push("stop");
      return { stopped: true, pid: 123 };
    },
    startController: async () => { events.push("start"); },
    postSwitchFaultHook: (step) => {
      if (step === "receipt-clear") throw new Error("receipt clear injected");
    }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "post-verify");
  assert.equal(result.switchCommitted, true);
  assert.match(result.message, /receipt clear injected/);
  assert.match(result.recoveryEvidence.receiptPath, /upgrade-receipt/);
  assert.match(result.recoveryEvidence.progressPath, /upgrade-switch/);
  assert.deepEqual(events, ["status", "stop", "start"]);
});
