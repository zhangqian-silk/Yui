import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runConfigCommand } from "../../dist/commands/configCommands.js";
import {
  installCompletion,
  uninstallCompletion
} from "../../dist/completion/completionInstaller.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const CLI = join(process.cwd(), "dist", "cli.js");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-config-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  return { home, store: new FileTaskStore(home) };
}

function runCli(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, YUI_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function completionStoreWithBarrier(store, barrier) {
  let crossed = false;
  const crossBarrier = () => {
    if (crossed) return;
    crossed = true;
    barrier();
  };
  return {
    transaction(execute) {
      crossBarrier();
      return store.transaction((tx) => execute(tx));
    },
    getConfig() {
      const snapshot = store.getConfig();
      crossBarrier();
      return snapshot;
    },
    saveConfig: (next) => store.saveConfig(next)
  };
}

test("concurrent config set processes preserve independent fields", async (t) => {
  const { home, store } = fixture(t);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    store.saveConfig({ schemaVersion: 1 });
    const [timeZone, reconciliation] = await Promise.all([
      runCli(home, ["config", "set", "--time-zone", "Europe/London"]),
      runCli(home, ["config", "set", "--reconciliation-interval-seconds", "45"])
    ]);
    assert.equal(timeZone.status, 0, timeZone.stderr);
    assert.equal(reconciliation.status, 0, reconciliation.stderr);
    assert.deepEqual(store.getConfig(), {
      schemaVersion: 1,
      reconciliationIntervalSeconds: 45,
      timeZone: "Europe/London"
    });
  }
});

test("invalid config CLI input exits with the stable usage-error contract", (t) => {
  const { home, store } = fixture(t);
  const initial = store.getConfig();

  const text = spawnSync(
    process.execPath,
    [CLI, "config", "set", "--time-zone", "Not/AZone"],
    { encoding: "utf8", env: { ...process.env, YUI_HOME: home } }
  );
  assert.equal(text.status, 2);
  assert.match(text.stderr, /^USAGE_ERROR: timeZone must be a valid IANA timezone\./);

  const json = spawnSync(
    process.execPath,
    [CLI, "--json", "config", "set", "--reconciliation-interval-seconds", "4"],
    { encoding: "utf8", env: { ...process.env, YUI_HOME: home } }
  );
  assert.equal(json.status, 2);
  assert.deepEqual(JSON.parse(json.stderr), {
    ok: false,
    code: "USAGE_ERROR",
    message: "reconciliationIntervalSeconds must be an integer from 5 to 300.",
    details: {}
  });
  assert.deepEqual(store.getConfig(), initial);
});

test("completion install patches the latest config after a concurrent config set", (t) => {
  const { home, store } = fixture(t);
  const installation = {
    scriptPath: join(home, "completion", "yui"),
    activationPath: join(home, ".bashrc")
  };
  const completionStore = completionStoreWithBarrier(store, () => {
    runConfigCommand(
      ["set", "--time-zone", "Europe/London"],
      new FileTaskStore(home)
    );
  });

  installCompletion(
    completionStore,
    "bash",
    installation,
    { HOME: home, SHELL: "/bin/bash" },
    "yui",
    false
  );

  assert.equal(existsSync(installation.scriptPath), true);
  assert.deepEqual(store.getConfig(), {
    schemaVersion: 1,
    timeZone: "Europe/London",
    completionInstallations: { bash: installation }
  });
});

test("completion uninstall patches the latest config after a concurrent config set", (t) => {
  const { home, store } = fixture(t);
  const installation = {
    scriptPath: join(home, "completion", "yui"),
    activationPath: join(home, ".bashrc")
  };
  installCompletion(
    store,
    "bash",
    installation,
    { HOME: home, SHELL: "/bin/bash" },
    "yui",
    false
  );
  const completionStore = completionStoreWithBarrier(store, () => {
    runConfigCommand(
      ["set", "--reconciliation-interval-seconds", "45"],
      new FileTaskStore(home)
    );
  });

  uninstallCompletion(completionStore, "bash", "yui");

  assert.equal(existsSync(installation.scriptPath), false);
  assert.deepEqual(store.getConfig(), {
    schemaVersion: 1,
    reconciliationIntervalSeconds: 45
  });
});
