import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  callController,
  ControllerClientError
} from "../../dist/core/controllerClient.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { restartFileTaskController } from "../../dist/controller/clientRuntime.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const LEGACY_CONTROLLER = fileURLToPath(
  new URL("../helpers/legacyControllerV3.mjs", import.meta.url)
);

function initializeControllerHome(home) {
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ schemaVersion: 1 });
}

async function startLegacyController(root, home) {
  const wrapper = join(root, "legacy", "dist", "controller", "controllerMain.js");
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(
    wrapper,
    `import(${JSON.stringify(pathToFileURL(LEGACY_CONTROLLER).href)});\n`
  );
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, YUI_HOME: home },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Legacy Controller did not start: ${stderr}`
    )), 5_000);
    child.once("message", (message) => {
      if (message?.type !== "ready") return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Legacy Controller exited with ${code}: ${stderr}`));
    });
  });
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("a copied live Home cannot route requests to the original Controller", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-controller-copy-fence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalHome = join(root, "home-a");
  const copiedHome = join(root, "home-b");
  initializeControllerHome(originalHome);
  let dispatched = 0;
  const controller = await startControllerServer(originalHome, () => {
    dispatched += 1;
    return { servedBy: "home-a" };
  });
  t.after(() => controller.close());
  cpSync(originalHome, copiedHome, { recursive: true });

  await assert.rejects(
    callController(copiedHome, "task.query", {}),
    (error) => error instanceof ControllerClientError
      && error.code === "CONTROLLER_DISCOVERY_INVALID"
  );
  assert.equal(dispatched, 0);
  assert.deepEqual(await callController(originalHome, "task.query", {}), {
    servedBy: "home-a"
  });
});

test("Controller startup refuses a previous-protocol owner after discovery is lost", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-controller-legacy-orphan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  initializeControllerHome(home);
  const legacy = await startLegacyController(root, home);
  t.after(() => stopChild(legacy));
  rmSync(join(home, "runtime", "controller.json"));

  await startControllerServer(home).then(
    async (unexpected) => {
      await unexpected.close();
      assert.fail("a second Controller started beside the live previous-protocol owner");
    },
    (error) => assert.match(String(error), /Controller is already running/u)
  );
});

test("controller restart performs the bounded v3-to-current Controller handoff", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-controller-v3-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const physicalParent = join(root, "physical");
  const home = join(physicalParent, "home");
  const aliasParent = join(root, "alias");
  mkdirSync(physicalParent);
  symlinkSync(physicalParent, aliasParent, "dir");
  const legacyHomeAlias = join(aliasParent, "home");
  initializeControllerHome(home);
  const legacy = await startLegacyController(root, legacyHomeAlias);
  t.after(() => stopChild(legacy));
  let currentPromise;

  const result = await restartFileTaskController(home, {
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 5_000,
    pollIntervalMs: 10,
    spawnController: () => {
      currentPromise = startControllerServer(home);
    }
  });
  const current = await currentPromise;
  t.after(() => current.close());

  assert.equal(result.restarted, true);
  assert.equal(result.previousPid, legacy.pid);
  assert.equal((await callController(home, "controller.status", {})).running, true);
});
