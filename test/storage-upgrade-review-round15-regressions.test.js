import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  ensureStorageSchema,
  inspectStorageSchema
} from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";
import { runUpdate } from "../dist/cli/updateOrchestrator.js";
import { callController, ControllerClientError } from "../dist/core/controllerClient.js";

function isolatedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("YUI_"))
  );
}

function tempHome() {
  const base = mkdtempSync(join(tmpdir(), "yui-review15-old-schema-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

async function startIsolatedController(home, t) {
  const controllerPath = join(process.cwd(), "dist/controller/controllerMain.js");
  const environment = { ...isolatedEnvironment(), YUI_HOME: home };
  const child = spawn(process.execPath, [controllerPath], {
    cwd: process.cwd(),
    env: environment,
    stdio: "ignore"
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const status = await callController(home, "controller.status", {});
      if (status.running === true) return child;
    } catch (error) {
      if (!(error instanceof ControllerClientError)
        || !["CONTROLLER_NOT_RUNNING", "CONTROLLER_UNAVAILABLE"].includes(error.code)) {
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error("isolated Controller did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("parent update stops a running Controller on an old aggregate Home through its internal path", async (t) => {
  assert.equal(CURRENT_AGGREGATE_SCHEMA_VERSION, 17);
  const fixture = tempHome();
  t.after(() => rmSync(fixture.base, { recursive: true, force: true }));
  await startIsolatedController(fixture.home, t);

  const manifestPath = join(fixture.home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.aggregateSchemaVersion = CURRENT_AGGREGATE_SCHEMA_VERSION - 1;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const schema = inspectStorageSchema(fixture.home);
  assert.equal(schema.status, "unsupported");
  assert.equal(schema.currentAggregateSchemaVersion, 16);

  const environment = isolatedEnvironment();
  const publicStop = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist/cli.js"), "--json", "controller", "stop"],
    { cwd: process.cwd(), env: { ...environment, YUI_HOME: fixture.home }, shell: false }
  );
  assert.notEqual(
    publicStop.status,
    0,
    "public controller stop must reject storage that requires offline migration"
  );
  assert.match(
    `${publicStop.stdout.toString("utf8")}\n${publicStop.stderr.toString("utf8")}`,
    /requires an offline migration/i
  );

  const realPorts = createUpdatePorts(environment, spawnSync);
  const events = [];
  const ports = {
    ...realPorts,
    stage: () => {
      events.push("stage");
      return { binaryPath: "/tmp/staged/yui", version: "9.9.9" };
    },
    preflight: () => {
      events.push("preflight");
      return { status: "migratable", summary: "aggregate 16 -> 17" };
    },
    controllerStatus: (home) => {
      events.push("status");
      return realPorts.controllerStatus(home);
    },
    stopController: (home, expectedPid) => {
      events.push("stop");
      return realPorts.stopController(home, expectedPid);
    },
    activateStorage: (_staged, home) => {
      events.push("activate-storage");
      return { status: "migrated", backupPath: join(fixture.base, "home.backup") };
    },
    activateBinary: () => { events.push("activate-binary"); },
    verify: () => { events.push("verify"); },
    startController: () => { events.push("start"); },
    cleanup: () => { events.push("cleanup"); }
  };

  const result = runUpdate(ports, { home: fixture.home });
  assert.equal(result.outcome, "updated");
  assert.deepEqual(events, [
    "stage", "preflight", "status", "stop", "activate-storage",
    "activate-binary", "verify", "start", "cleanup"
  ]);
  await assert.rejects(
    () => callController(fixture.home, "controller.status", {}),
    (error) => error instanceof ControllerClientError && error.code === "CONTROLLER_NOT_RUNNING"
  );
});
