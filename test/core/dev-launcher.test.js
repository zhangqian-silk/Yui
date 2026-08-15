import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  installDevLauncher,
  linkDevLauncher,
  resetDevHome,
  unlinkDevLauncher,
  uninstallDevLauncher
} from "../../scripts/manage-dev-launcher.mjs";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { controllerSocketPath } from "../../dist/core/controllerEndpoint.js";
import { parseControllerDiscovery } from "../../dist/core/protocol.js";

function currentProcessStartIdentity() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u)[19];
}

test("development launcher is local, named yui, and contains no checkout absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-launcher-"));
  const projectRoot = join(root, "checkout with spaces");
  const outputDir = join(projectRoot, "generated output");
  mkdirSync(projectRoot, { recursive: true });

  const installed = installDevLauncher({ projectRoot, outputDir });

  assert.equal(installed.launcherPath, join(outputDir, "bin", "yui"));
  assert.equal(installed.yuiHome, join(outputDir, "home"));

  const launcher = readFileSync(installed.launcherPath, "utf8");

  assert.match(launcher, /YUI_CLI_NAME=yui/);
  assert.match(launcher, /exec node/);
  assert.equal(launcher.includes(projectRoot), false);
});

test("uninstall removes only this checkout's generated local launcher", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-launcher-"));
  const outputDir = join(root, "output");
  const installed = installDevLauncher({ projectRoot: root, outputDir });

  assert.deepEqual(uninstallDevLauncher({ projectRoot: root, outputDir }), {
    launcherPath: installed.launcherPath,
    removed: true
  });
});

test("global development link replaces yui reversibly and works from other directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-global-link-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(join(projectRoot, "dist"), { recursive: true });
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "production-yui"), "production-yui\n");
  symlinkSync("production-yui", join(globalBinDir, "yui"));
  writeFileSync(
    join(projectRoot, "dist", "cli.js"),
    "console.log(JSON.stringify({ home: process.env.YUI_HOME, name: process.env.YUI_CLI_NAME }));\n"
  );

  const linked = await linkDevLauncher({ projectRoot, globalBinDir, registryPath });

  assert.equal(linked.backupPath, join(globalBinDir, ".yui-link-original"));
  assert.equal(linked.statePath, registryPath);
  assert.equal(readlinkSync(join(globalBinDir, "yui")), linked.localLauncherPath);
  assert.equal(existsSync(linked.backupPath), true);
  assert.equal(existsSync(linked.statePath), true);
  assert.deepEqual(
    JSON.parse(execFileSync(join(globalBinDir, "yui"), { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } })),
    { home: join(projectRoot, "output", "dev", "home"), name: "yui" }
  );
  assert.deepEqual(
    JSON.parse(execFileSync(join(globalBinDir, "yui"), {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", YUI_HOME: join(root, "selected-home") }
    })),
    { home: join(root, "selected-home"), name: "yui" }
  );

  const unlinked = unlinkDevLauncher({ projectRoot, globalBinDir, registryPath });

  assert.equal(unlinked.restored, true);
  assert.equal(lstatSync(join(globalBinDir, "yui")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(globalBinDir, "yui")), "production-yui");
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(existsSync(linked.backupPath), false);
  assert.equal(existsSync(linked.statePath), false);
});

test("the last development checkout wins and unlink from any checkout restores production", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-global-link-"));
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  const unrelatedRoot = join(root, "unrelated");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  mkdirSync(join(unrelatedRoot, "output", "dev", "bin"), { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");
  writeFileSync(join(unrelatedRoot, "output", "dev", "bin", "yui"), "unrelated local file\n");

  const first = await linkDevLauncher({ projectRoot: firstRoot, globalBinDir, registryPath });
  assert.deepEqual(await linkDevLauncher({ projectRoot: firstRoot, globalBinDir, registryPath }), first);
  const second = await linkDevLauncher({ projectRoot: secondRoot, globalBinDir, registryPath });

  assert.equal(readlinkSync(join(globalBinDir, "yui")), second.localLauncherPath);
  assert.equal(readFileSync(second.backupPath, "utf8"), "production-yui\n");
  assert.equal(existsSync(first.localLauncherPath), true);

  const unlinked = unlinkDevLauncher({ projectRoot: unrelatedRoot, globalBinDir, registryPath });

  assert.equal(unlinked.restored, true);
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(existsSync(second.localLauncherPath), false);
  assert.equal(existsSync(second.statePath), false);
  assert.equal(existsSync(second.backupPath), false);
  assert.equal(
    readFileSync(join(unrelatedRoot, "output", "dev", "bin", "yui"), "utf8"),
    "unrelated local file\n"
  );
});

test("unlink recovers an active managed launcher when the user registry moved", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-moved-registry-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const previousRegistryPath = join(root, "old-state", "dev-launcher.json");
  const currentRegistryPath = join(root, "new-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");

  const linked = await linkDevLauncher({
    projectRoot,
    globalBinDir,
    registryPath: previousRegistryPath
  });
  rmSync(previousRegistryPath);

  const unlinked = unlinkDevLauncher({
    projectRoot: join(root, "unrelated-checkout"),
    globalBinDir,
    registryPath: currentRegistryPath
  });

  assert.equal(unlinked.restored, true);
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(existsSync(linked.backupPath), false);
  assert.equal(existsSync(linked.localLauncherPath), false);
  assert.equal(existsSync(currentRegistryPath), false);
});

test("unlink refuses an orphan managed launcher when its original backup is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-orphan-missing-backup-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const previousRegistryPath = join(root, "old-state", "dev-launcher.json");
  const currentRegistryPath = join(root, "new-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");

  const linked = await linkDevLauncher({
    projectRoot,
    globalBinDir,
    registryPath: previousRegistryPath
  });
  rmSync(previousRegistryPath);
  rmSync(linked.backupPath);

  assert.throws(
    () => unlinkDevLauncher({
      projectRoot,
      globalBinDir,
      registryPath: currentRegistryPath
    }),
    /cannot safely restore.*backup is missing/is
  );
  assert.equal(readlinkSync(linked.globalLauncherPath), linked.localLauncherPath);
  assert.equal(existsSync(linked.localLauncherPath), true);
  assert.equal(existsSync(currentRegistryPath), false);
});

test("unlink restores a witnessed dangling managed launcher with a custom output directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-orphan-dangling-"));
  const projectRoot = join(root, "checkout");
  const outputDir = join(projectRoot, "custom-generated-output");
  const globalBinDir = join(root, "global-bin");
  const previousRegistryPath = join(root, "old-state", "dev-launcher.json");
  const currentRegistryPath = join(root, "new-state", "dev-launcher.json");
  const recoveryPath = join(globalBinDir, ".yui-link-recovery.json");
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");
  const linked = await linkDevLauncher({
    projectRoot,
    outputDir,
    globalBinDir,
    registryPath: previousRegistryPath
  });
  assert.equal(existsSync(recoveryPath), true);
  rmSync(previousRegistryPath);
  rmSync(linked.localLauncherPath);

  const unlinked = unlinkDevLauncher({
    projectRoot: join(root, "unrelated-checkout"),
    globalBinDir,
    registryPath: currentRegistryPath
  });

  assert.equal(unlinked.restored, true);
  assert.equal(readFileSync(linked.globalLauncherPath, "utf8"), "production-yui\n");
  assert.equal(existsSync(linked.backupPath), false);
  assert.equal(existsSync(recoveryPath), false);
  assert.equal(existsSync(currentRegistryPath), false);
});

test("orphan recovery removes a witnessed dangling launcher when no original command existed", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-orphan-no-original-"));
  const projectRoot = join(root, "checkout");
  const outputDir = join(projectRoot, "custom-generated-output");
  const globalBinDir = join(root, "global-bin");
  const previousRegistryPath = join(root, "old-state", "dev-launcher.json");
  const currentRegistryPath = join(root, "new-state", "dev-launcher.json");
  const recoveryPath = join(globalBinDir, ".yui-link-recovery.json");
  mkdirSync(globalBinDir, { recursive: true });
  const linked = await linkDevLauncher({
    projectRoot,
    outputDir,
    globalBinDir,
    registryPath: previousRegistryPath
  });
  assert.equal(linked.replaced, false);
  rmSync(previousRegistryPath);
  rmSync(linked.localLauncherPath);

  const unlinked = unlinkDevLauncher({
    projectRoot: join(root, "unrelated-checkout"),
    globalBinDir,
    registryPath: currentRegistryPath
  });

  assert.equal(unlinked.restored, true);
  assert.equal(existsSync(linked.globalLauncherPath), false);
  assert.equal(existsSync(linked.backupPath), false);
  assert.equal(existsSync(recoveryPath), false);
  assert.equal(existsSync(currentRegistryPath), false);
});

test("unlink never adopts a dangling symlink without a managed recovery witness", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-third-party-dangling-"));
  const globalBinDir = join(root, "global-bin");
  const globalLauncherPath = join(globalBinDir, "yui");
  const backupPath = join(globalBinDir, ".yui-link-original");
  const thirdPartyTarget = join(root, "third-party", "bin", "yui");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(backupPath, "unrelated-backup\n");
  symlinkSync(thirdPartyTarget, globalLauncherPath);

  const unlinked = unlinkDevLauncher({
    projectRoot: join(root, "unrelated-checkout"),
    globalBinDir,
    registryPath
  });

  assert.equal(unlinked.restored, false);
  assert.equal(readlinkSync(globalLauncherPath), thirdPartyTarget);
  assert.equal(readFileSync(backupPath, "utf8"), "unrelated-backup\n");
  assert.equal(existsSync(registryPath), false);
});

test("unlink discovers an orphan managed launcher in another NVM version", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-orphan-cross-nvm-"));
  const projectRoot = join(root, "checkout");
  const nvmDir = join(root, ".nvm");
  const previousBinDir = join(nvmDir, "versions", "node", "v20.20.2", "bin");
  const currentBinDir = join(nvmDir, "versions", "node", "v22.17.0", "bin");
  const previousRegistryPath = join(root, "old-state", "dev-launcher.json");
  const currentRegistryPath = join(root, "new-state", "dev-launcher.json");
  mkdirSync(previousBinDir, { recursive: true });
  mkdirSync(currentBinDir, { recursive: true });
  writeFileSync(join(previousBinDir, "yui"), "node-20-production-yui\n");

  const linked = await linkDevLauncher({
    projectRoot,
    globalBinDir: previousBinDir,
    registryPath: previousRegistryPath,
    nvmDir
  });
  rmSync(previousRegistryPath);

  const unlinked = unlinkDevLauncher({
    projectRoot: join(root, "unrelated-checkout"),
    globalBinDir: currentBinDir,
    registryPath: currentRegistryPath,
    nvmDir
  });

  assert.equal(unlinked.restored, true);
  assert.equal(unlinked.globalLauncherPath, join(previousBinDir, "yui"));
  assert.equal(readFileSync(join(previousBinDir, "yui"), "utf8"), "node-20-production-yui\n");
  assert.equal(existsSync(linked.backupPath), false);
  assert.equal(existsSync(linked.localLauncherPath), false);
});

test("link finishes activation when state was written before the original command moved", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-interrupted-link-state-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  const localLauncherPath = installDevLauncher({ projectRoot }).launcherPath;
  const globalLauncherPath = join(globalBinDir, "yui");
  const backupPath = join(globalBinDir, ".yui-link-original");
  mkdirSync(globalBinDir, { recursive: true });
  mkdirSync(join(root, "user-state"), { recursive: true });
  writeFileSync(globalLauncherPath, "production-yui\n");
  writeFileSync(registryPath, `${JSON.stringify({
    schemaVersion: 3,
    activeProjectRoot: projectRoot,
    localLauncherPath,
    globalLauncherPath,
    backupPath,
    hadOriginal: true
  })}\n`);

  const linked = await linkDevLauncher({ projectRoot, globalBinDir, registryPath });

  assert.equal(readlinkSync(globalLauncherPath), linked.localLauncherPath);
  assert.equal(readFileSync(backupPath, "utf8"), "production-yui\n");
});

test("link finishes activation when the original command moved before the symlink was created", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-interrupted-link-symlink-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  const localLauncherPath = installDevLauncher({ projectRoot }).launcherPath;
  const globalLauncherPath = join(globalBinDir, "yui");
  const backupPath = join(globalBinDir, ".yui-link-original");
  mkdirSync(globalBinDir, { recursive: true });
  mkdirSync(join(root, "user-state"), { recursive: true });
  writeFileSync(backupPath, "production-yui\n");
  writeFileSync(registryPath, `${JSON.stringify({
    schemaVersion: 3,
    activeProjectRoot: projectRoot,
    localLauncherPath,
    globalLauncherPath,
    backupPath,
    hadOriginal: true
  })}\n`);

  const linked = await linkDevLauncher({ projectRoot, globalBinDir, registryPath });

  assert.equal(readlinkSync(globalLauncherPath), linked.localLauncherPath);
  assert.equal(readFileSync(backupPath, "utf8"), "production-yui\n");
});

test("link adopts the new managed target after interruption before the registry update", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-interrupted-switch-"));
  const firstProjectRoot = join(root, "first-checkout");
  const secondProjectRoot = join(root, "second-checkout");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");
  const first = await linkDevLauncher({
    projectRoot: firstProjectRoot,
    globalBinDir,
    registryPath
  });
  const secondLocalLauncherPath = installDevLauncher({ projectRoot: secondProjectRoot }).launcherPath;
  rmSync(first.globalLauncherPath);
  symlinkSync(secondLocalLauncherPath, first.globalLauncherPath);

  const linked = await linkDevLauncher({
    projectRoot: secondProjectRoot,
    globalBinDir,
    registryPath
  });

  assert.equal(readlinkSync(first.globalLauncherPath), secondLocalLauncherPath);
  assert.equal(linked.localLauncherPath, secondLocalLauncherPath);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).localLauncherPath, secondLocalLauncherPath);
  assert.equal(readFileSync(first.backupPath, "utf8"), "production-yui\n");
});

test("unlink completes cleanup after the original command was already restored", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-interrupted-unlink-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");
  const linked = await linkDevLauncher({ projectRoot, globalBinDir, registryPath });
  rmSync(linked.globalLauncherPath);
  renameSync(linked.backupPath, linked.globalLauncherPath);

  const unlinked = unlinkDevLauncher({
    projectRoot: join(root, "unrelated-checkout"),
    globalBinDir,
    registryPath
  });

  assert.equal(unlinked.restored, true);
  assert.equal(readFileSync(linked.globalLauncherPath, "utf8"), "production-yui\n");
  assert.equal(existsSync(linked.localLauncherPath), false);
  assert.equal(existsSync(registryPath), false);
});

test("linking from another npm global bin restores the previous bin before the last link wins", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-cross-global-bin-"));
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  const firstBin = join(root, "node-20", "bin");
  const secondBin = join(root, "node-22", "bin");
  const unrelatedBin = join(root, "node-24", "bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(firstBin, { recursive: true });
  mkdirSync(secondBin, { recursive: true });
  writeFileSync(join(firstBin, "yui"), "node-20-yui\n");
  writeFileSync(join(secondBin, "yui"), "node-22-yui\n");

  const first = await linkDevLauncher({ projectRoot: firstRoot, globalBinDir: firstBin, registryPath });
  const second = await linkDevLauncher({ projectRoot: secondRoot, globalBinDir: secondBin, registryPath });

  assert.equal(readFileSync(join(firstBin, "yui"), "utf8"), "node-20-yui\n");
  assert.equal(existsSync(first.backupPath), false);
  assert.equal(readlinkSync(join(secondBin, "yui")), second.localLauncherPath);
  assert.equal(readFileSync(second.backupPath, "utf8"), "node-22-yui\n");

  const unlinked = unlinkDevLauncher({
    projectRoot: join(root, "unrelated-checkout"),
    globalBinDir: unrelatedBin,
    registryPath
  });

  assert.equal(unlinked.globalLauncherPath, join(secondBin, "yui"));
  assert.equal(readFileSync(join(secondBin, "yui"), "utf8"), "node-22-yui\n");
  assert.equal(existsSync(registryPath), false);
});

test("a failed cross-bin link leaves the previous development link active", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-cross-global-failure-"));
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  const firstBin = join(root, "node-20", "bin");
  const secondBin = join(root, "node-22", "bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(firstBin, { recursive: true });
  mkdirSync(secondBin, { recursive: true });
  writeFileSync(join(firstBin, "yui"), "node-20-yui\n");
  writeFileSync(join(secondBin, "yui"), "node-22-yui\n");
  writeFileSync(join(secondBin, ".yui-link-original"), "unrelated backup\n");
  const first = await linkDevLauncher({ projectRoot: firstRoot, globalBinDir: firstBin, registryPath });

  await assert.rejects(
    linkDevLauncher({ projectRoot: secondRoot, globalBinDir: secondBin, registryPath }),
    /refusing to overwrite an existing development backup/i
  );

  assert.equal(readlinkSync(join(firstBin, "yui")), first.localLauncherPath);
  assert.equal(readFileSync(first.backupPath, "utf8"), "node-20-yui\n");
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).globalLauncherPath, join(firstBin, "yui"));
  assert.equal(readFileSync(join(secondBin, "yui"), "utf8"), "node-22-yui\n");
  assert.equal(readFileSync(join(secondBin, ".yui-link-original"), "utf8"), "unrelated backup\n");
});

test("a live registry lock prevents concurrent global launcher mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-link-lock-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  mkdirSync(join(root, "user-state"), { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");
  writeFileSync(
    `${registryPath}.lock`,
    `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`
  );

  await assert.rejects(
    linkDevLauncher({ projectRoot, globalBinDir, registryPath }),
    /another yui development link operation is already running/i
  );
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(existsSync(registryPath), false);
});

test("a registry lock left by a dead process fails safely with an exact recovery path", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-stale-link-lock-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  mkdirSync(join(root, "user-state"), { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");
  writeFileSync(
    `${registryPath}.lock`,
    `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", createdAt: "2026-07-24T00:00:00.000Z" })}\n`
  );

  await assert.rejects(
    linkDevLauncher({ projectRoot, globalBinDir, registryPath }),
    /previous yui development link operation left a stale lock.*remove this exact lock file/is
  );
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(existsSync(`${registryPath}.lock`), true);
});

test("an unverifiable registry lock fails safely with an exact recovery path", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-invalid-link-lock-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  mkdirSync(join(root, "user-state"), { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");
  writeFileSync(`${registryPath}.lock`, "partially-written");

  await assert.rejects(
    linkDevLauncher({ projectRoot, globalBinDir, registryPath }),
    new RegExp(`Cannot verify.*remove this exact lock file`, "is")
  );
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(readFileSync(`${registryPath}.lock`, "utf8"), "partially-written");
});

test("link adopts the current bin's previous launcher state into the user registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-legacy-link-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const localLauncherPath = join(projectRoot, "output", "dev", "bin", "yui");
  const globalLauncherPath = join(globalBinDir, "yui");
  const backupPath = join(globalBinDir, ".yui-link-original");
  const legacyStatePath = join(globalBinDir, ".yui-link-state.json");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  installDevLauncher({ projectRoot });
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(backupPath, "production-yui\n");
  symlinkSync(localLauncherPath, globalLauncherPath);
  writeFileSync(legacyStatePath, `${JSON.stringify({
    schemaVersion: 2,
    activeProjectRoot: projectRoot,
    localLauncherPath,
    hadOriginal: true
  })}\n`);

  const linked = await linkDevLauncher({ projectRoot, globalBinDir, registryPath });

  assert.equal(linked.statePath, registryPath);
  assert.equal(existsSync(legacyStatePath), false);
  assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), {
    schemaVersion: 3,
    activeProjectRoot: projectRoot,
    localLauncherPath,
    globalLauncherPath,
    backupPath,
    hadOriginal: true
  });
  unlinkDevLauncher({ projectRoot, globalBinDir, registryPath });
  assert.equal(readFileSync(globalLauncherPath, "utf8"), "production-yui\n");
});

test("unlink can restore the current bin directly from the previous launcher state", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-legacy-unlink-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  const localLauncherPath = installDevLauncher({ projectRoot }).launcherPath;
  const globalLauncherPath = join(globalBinDir, "yui");
  const backupPath = join(globalBinDir, ".yui-link-original");
  const legacyStatePath = join(globalBinDir, ".yui-link-state.json");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(backupPath, "production-yui\n");
  symlinkSync(localLauncherPath, globalLauncherPath);
  writeFileSync(legacyStatePath, `${JSON.stringify({
    schemaVersion: 2,
    activeProjectRoot: projectRoot,
    localLauncherPath,
    hadOriginal: true
  })}\n`);

  const unlinked = unlinkDevLauncher({ projectRoot, globalBinDir, registryPath });

  assert.equal(unlinked.restored, true);
  assert.equal(readFileSync(globalLauncherPath, "utf8"), "production-yui\n");
  assert.equal(existsSync(backupPath), false);
  assert.equal(existsSync(legacyStatePath), false);
  assert.equal(existsSync(registryPath), false);
});

test("unlink discovers and restores a previous launcher state from another NVM version", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-legacy-cross-nvm-unlink-"));
  const projectRoot = join(root, "checkout");
  const nodeVersionsDir = join(root, ".nvm", "versions", "node");
  const legacyBinDir = join(nodeVersionsDir, "v20.20.2", "bin");
  const currentBinDir = join(nodeVersionsDir, "v22.17.0", "bin");
  const localLauncherPath = installDevLauncher({ projectRoot }).launcherPath;
  const globalLauncherPath = join(legacyBinDir, "yui");
  const backupPath = join(legacyBinDir, ".yui-link-original");
  const legacyStatePath = join(legacyBinDir, ".yui-link-state.json");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(legacyBinDir, { recursive: true });
  mkdirSync(currentBinDir, { recursive: true });
  writeFileSync(backupPath, "node-20-production-yui\n");
  symlinkSync(localLauncherPath, globalLauncherPath);
  writeFileSync(legacyStatePath, `${JSON.stringify({
    schemaVersion: 2,
    activeProjectRoot: projectRoot,
    localLauncherPath,
    hadOriginal: true
  })}\n`);

  const unlinked = unlinkDevLauncher({
    projectRoot: join(root, "unrelated-checkout"),
    globalBinDir: currentBinDir,
    registryPath,
    nvmDir: join(root, ".nvm")
  });

  assert.equal(unlinked.restored, true);
  assert.equal(unlinked.globalLauncherPath, globalLauncherPath);
  assert.equal(readFileSync(globalLauncherPath, "utf8"), "node-20-production-yui\n");
  assert.equal(existsSync(backupPath), false);
  assert.equal(existsSync(legacyStatePath), false);
  assert.equal(existsSync(registryPath), false);
});

test("link discovers a previous launcher state from another NVM version before the last link wins", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-legacy-cross-nvm-link-"));
  const firstProjectRoot = join(root, "first-checkout");
  const secondProjectRoot = join(root, "second-checkout");
  const nodeVersionsDir = join(root, ".nvm", "versions", "node");
  const legacyBinDir = join(nodeVersionsDir, "v20.20.2", "bin");
  const currentBinDir = join(nodeVersionsDir, "v22.17.0", "bin");
  const firstLocalLauncherPath = installDevLauncher({ projectRoot: firstProjectRoot }).launcherPath;
  const legacyGlobalLauncherPath = join(legacyBinDir, "yui");
  const legacyBackupPath = join(legacyBinDir, ".yui-link-original");
  const legacyStatePath = join(legacyBinDir, ".yui-link-state.json");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(legacyBinDir, { recursive: true });
  mkdirSync(currentBinDir, { recursive: true });
  writeFileSync(legacyBackupPath, "node-20-production-yui\n");
  writeFileSync(join(currentBinDir, "yui"), "node-22-production-yui\n");
  symlinkSync(firstLocalLauncherPath, legacyGlobalLauncherPath);
  writeFileSync(legacyStatePath, `${JSON.stringify({
    schemaVersion: 2,
    activeProjectRoot: firstProjectRoot,
    localLauncherPath: firstLocalLauncherPath,
    hadOriginal: true
  })}\n`);

  const linked = await linkDevLauncher({
    projectRoot: secondProjectRoot,
    globalBinDir: currentBinDir,
    registryPath,
    nvmDir: join(root, ".nvm")
  });

  assert.equal(readFileSync(legacyGlobalLauncherPath, "utf8"), "node-20-production-yui\n");
  assert.equal(existsSync(legacyBackupPath), false);
  assert.equal(existsSync(legacyStatePath), false);
  assert.equal(readlinkSync(join(currentBinDir, "yui")), linked.localLauncherPath);
  assert.equal(readFileSync(linked.backupPath, "utf8"), "node-22-production-yui\n");
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).globalLauncherPath, join(currentBinDir, "yui"));
});

test("link treats aliased paths to one previous launcher state as one candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-legacy-aliased-nvm-"));
  const firstProjectRoot = join(root, "first-checkout");
  const secondProjectRoot = join(root, "second-checkout");
  const realNvmDir = join(root, "real-nvm");
  const aliasedNvmDir = join(root, "aliased-nvm");
  const nodeVersionsDir = join(realNvmDir, "versions", "node");
  const legacyBinDir = join(nodeVersionsDir, "v20.20.2", "bin");
  const currentBinDir = join(nodeVersionsDir, "v22.17.0", "bin");
  const firstLocalLauncherPath = installDevLauncher({ projectRoot: firstProjectRoot }).launcherPath;
  const legacyGlobalLauncherPath = join(legacyBinDir, "yui");
  const legacyBackupPath = join(legacyBinDir, ".yui-link-original");
  const legacyStatePath = join(legacyBinDir, ".yui-link-state.json");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(legacyBinDir, { recursive: true });
  mkdirSync(currentBinDir, { recursive: true });
  symlinkSync(realNvmDir, aliasedNvmDir, "dir");
  writeFileSync(legacyBackupPath, "node-20-production-yui\n");
  writeFileSync(join(currentBinDir, "yui"), "node-22-production-yui\n");
  symlinkSync(firstLocalLauncherPath, legacyGlobalLauncherPath);
  writeFileSync(legacyStatePath, `${JSON.stringify({
    schemaVersion: 2,
    activeProjectRoot: firstProjectRoot,
    localLauncherPath: firstLocalLauncherPath,
    hadOriginal: true
  })}\n`);

  const linked = await linkDevLauncher({
    projectRoot: secondProjectRoot,
    globalBinDir: currentBinDir,
    registryPath,
    nvmDir: aliasedNvmDir
  });

  assert.equal(readFileSync(legacyGlobalLauncherPath, "utf8"), "node-20-production-yui\n");
  assert.equal(existsSync(legacyBackupPath), false);
  assert.equal(existsSync(legacyStatePath), false);
  assert.equal(readlinkSync(join(currentBinDir, "yui")), linked.localLauncherPath);
});

test("multiple previous launcher states across NVM versions fail without changing any candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-legacy-multiple-nvm-"));
  const nodeVersionsDir = join(root, ".nvm", "versions", "node");
  const firstBinDir = join(nodeVersionsDir, "v20.20.2", "bin");
  const secondBinDir = join(nodeVersionsDir, "v22.17.0", "bin");
  const currentBinDir = join(nodeVersionsDir, "v24.4.1", "bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  const candidates = [
    { projectRoot: join(root, "first-checkout"), globalBinDir: firstBinDir, production: "node-20-yui\n" },
    { projectRoot: join(root, "second-checkout"), globalBinDir: secondBinDir, production: "node-22-yui\n" }
  ];
  for (const candidate of candidates) {
    const localLauncherPath = installDevLauncher({ projectRoot: candidate.projectRoot }).launcherPath;
    mkdirSync(candidate.globalBinDir, { recursive: true });
    writeFileSync(join(candidate.globalBinDir, ".yui-link-original"), candidate.production);
    symlinkSync(localLauncherPath, join(candidate.globalBinDir, "yui"));
    writeFileSync(join(candidate.globalBinDir, ".yui-link-state.json"), `${JSON.stringify({
      schemaVersion: 2,
      activeProjectRoot: candidate.projectRoot,
      localLauncherPath,
      hadOriginal: true
    })}\n`);
  }
  mkdirSync(currentBinDir, { recursive: true });

  assert.throws(
    () => unlinkDevLauncher({
      projectRoot: join(root, "unrelated-checkout"),
      globalBinDir: currentBinDir,
      registryPath,
      nvmDir: join(root, ".nvm")
    }),
    /multiple previous managed global yui states.*refusing to choose or remove any/is
  );

  for (const candidate of candidates) {
    assert.equal(lstatSync(join(candidate.globalBinDir, "yui")).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(candidate.globalBinDir, ".yui-link-original"), "utf8"),
      candidate.production
    );
    assert.equal(existsSync(join(candidate.globalBinDir, ".yui-link-state.json")), true);
  }
  assert.equal(existsSync(registryPath), false);
});

test("unlink rejects registry paths that could overwrite an unrelated file", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-invalid-registry-"));
  const registryPath = join(root, "user-state", "dev-launcher.json");
  const victimPath = join(root, "important-file");
  mkdirSync(join(root, "user-state"), { recursive: true });
  writeFileSync(victimPath, "keep me\n");
  writeFileSync(registryPath, `${JSON.stringify({
    schemaVersion: 3,
    activeProjectRoot: join(root, "checkout"),
    localLauncherPath: join(root, "checkout", "output", "dev", "bin", "yui"),
    globalLauncherPath: join(root, "global-bin", "yui"),
    backupPath: victimPath,
    hadOriginal: true
  })}\n`);

  assert.throws(
    () => unlinkDevLauncher({ projectRoot: join(root, "other"), registryPath }),
    /invalid managed global yui state/i
  );
  assert.equal(readFileSync(victimPath, "utf8"), "keep me\n");
});

test("link refuses an incompatible development home schema and preserves it", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-schema-"));
  const projectRoot = join(root, "checkout");
  const outputDir = join(projectRoot, "output", "dev");
  const home = join(outputDir, "home");
  const globalBinDir = join(root, "global-bin");
  const registryPath = join(root, "user-state", "dev-launcher.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");
  writeFileSync(join(home, "schema.json"), JSON.stringify({
    schemaVersion: 1,
    storageVersion: 5,
    aggregateSchemaVersion: 2,
    updatedAt: "2026-07-24T00:00:00.000Z"
  }));
  writeFileSync(join(home, "state.json"), "important development data\n");

  await assert.rejects(
    linkDevLauncher({ projectRoot, outputDir, globalBinDir, registryPath }),
    /development home schema is incompatible.*make dev-reset/is
  );
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "important development data\n");
  assert.equal(existsSync(registryPath), false);
});

test("development home reset moves the old home aside and treats a missing home as normal", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "recoverable\n");

  const reset = await resetDevHome({ projectRoot: root, outputDir });

  assert.equal(reset.moved, true);
  assert.equal(existsSync(home), false);
  assert.equal(readFileSync(join(reset.backupPath, "state.json"), "utf8"), "recoverable\n");
  assert.match(reset.backupPath, /home\.backup-/);
  assert.deepEqual(await resetDevHome({ projectRoot: root, outputDir }), {
    homePath: home,
    backupPath: null,
    moved: false
  });
  assert.equal(readdirSync(outputDir).filter((name) => name.startsWith("home.backup-")).length, 1);
});

test("reset-home CLI awaits the reset before reporting its backup", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-cli-"));
  const home = join(root, "output", "dev", "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "recoverable\n");

  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../../scripts/manage-dev-launcher.mjs", import.meta.url)), "reset-home"],
    { cwd: root, encoding: "utf8" }
  );

  assert.match(output, /Moved the previous development home to:/);
  assert.equal(existsSync(home), false);
  assert.equal(
    readdirSync(join(root, "output", "dev"))
      .filter((name) => name.startsWith("home.backup-"))
      .length,
    1
  );
});

test("install-local CLI creates only the isolated launcher and never touches global", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-install-local-cli-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(globalBinDir, { recursive: true });
  const sentinel = join(globalBinDir, "yui");
  writeFileSync(sentinel, "#!/bin/sh\necho original\n");

  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../../scripts/manage-dev-launcher.mjs", import.meta.url)), "install-local"],
    { cwd: projectRoot, encoding: "utf8" }
  );

  const launcherPath = join(projectRoot, "output", "dev", "bin", "yui");
  assert.match(output, /global yui unchanged/);
  assert.match(output, new RegExp(launcherPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.equal(existsSync(launcherPath), true);
  assert.equal(lstatSync(launcherPath).isSymbolicLink(), false);
  assert.match(readFileSync(launcherPath, "utf8"), /YUI_CLI_NAME=yui/);
  // A pre-existing unrelated global yui in a separate bin is left untouched.
  assert.equal(readFileSync(sentinel, "utf8"), "#!/bin/sh\necho original\n");
});

test("install-local CLI is idempotent and safe to re-run", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-install-local-idempotent-"));
  const scriptPath = fileURLToPath(new URL("../../scripts/manage-dev-launcher.mjs", import.meta.url));
  execFileSync(process.execPath, [scriptPath, "install-local"], { cwd: root, encoding: "utf8" });
  const launcherPath = join(root, "output", "dev", "bin", "yui");
  const first = readFileSync(launcherPath, "utf8");
  execFileSync(process.execPath, [scriptPath, "install-local"], { cwd: root, encoding: "utf8" });
  assert.equal(readFileSync(launcherPath, "utf8"), first);
});

test("development home reset rejects malformed Controller discovery without moving data", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-invalid-discovery-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const discoveryPath = join(home, "runtime", "controller.json");
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(join(home, "state.json"), "keep me\n");
  writeFileSync(discoveryPath, `${JSON.stringify({
    pid: process.pid,
    socketPath: controllerSocketPath(home),
    token: "0".repeat(64)
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    resetDevHome({ projectRoot: root, outputDir }),
    /cannot verify development Controller state/i
  );
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "keep me\n");
});

test("development home reset accepts a complete stale discovery only when its owner is dead", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-stale-controller-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const discoveryPath = join(home, "runtime", "controller.json");
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(join(home, "state.json"), "recoverable\n");
  writeFileSync(discoveryPath, `${JSON.stringify({
    pid: 2_147_483_647,
    processStartIdentity: "1",
    socketPath: controllerSocketPath(home),
    token: "a".repeat(64)
  })}\n`, { mode: 0o600 });

  const reset = await resetDevHome({ projectRoot: root, outputDir });

  assert.equal(reset.moved, true);
  assert.equal(readFileSync(join(reset.backupPath, "state.json"), "utf8"), "recoverable\n");
});

test("development home reset shares the compact Controller endpoint under a deep TMPDIR", async (t) => {
  const fixtureRoot = mkdtempSync(join("/tmp", "yui-dev-reset-deep-tmp-"));
  const deepTmp = join(
    fixtureRoot,
    "explicitly-long-temporary-root",
    "nested-runtime-boundary",
    "nested-runtime-boundary",
    "nested-runtime-boundary"
  );
  mkdirSync(deepTmp, { recursive: true });
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = deepTmp;
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const root = mkdtempSync(join(deepTmp, "checkout-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const discoveryPath = join(home, "runtime", "controller.json");
  const socketPath = controllerSocketPath(home);
  assert.ok(Buffer.byteLength(join(deepTmp, `yui-${process.getuid()}`, "x".repeat(29))) >= 100);
  assert.match(socketPath, /^\/tmp\/yui-[0-9]+\/[a-f0-9]{24}\.sock$/u);
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(join(home, "state.json"), "recoverable\n");
  writeFileSync(discoveryPath, `${JSON.stringify({
    pid: 2_147_483_647,
    processStartIdentity: "1",
    socketPath,
    token: "d".repeat(64)
  })}\n`, { mode: 0o600 });

  const reset = await resetDevHome({ projectRoot: root, outputDir });

  assert.equal(reset.moved, true);
  assert.equal(readFileSync(join(reset.backupPath, "state.json"), "utf8"), "recoverable\n");
});

test("development home reset recognizes a reused PID from its different process identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-reused-pid-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const discoveryPath = join(home, "runtime", "controller.json");
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(join(home, "state.json"), "keep me\n");
  writeFileSync(discoveryPath, `${JSON.stringify({
    pid: process.pid,
    processStartIdentity: currentProcessStartIdentity() === "1" ? "2" : "1",
    socketPath: controllerSocketPath(home),
    token: "b".repeat(64)
  })}\n`, { mode: 0o600 });

  const reset = await resetDevHome({ projectRoot: root, outputDir });

  assert.equal(reset.moved, true);
  assert.equal(readFileSync(join(reset.backupPath, "state.json"), "utf8"), "keep me\n");
});

test("development home reset fails safely when the same process identity is still alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-live-identity-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const discoveryPath = join(home, "runtime", "controller.json");
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(join(home, "state.json"), "keep me\n");
  writeFileSync(discoveryPath, `${JSON.stringify({
    pid: process.pid,
    processStartIdentity: currentProcessStartIdentity(),
    socketPath: controllerSocketPath(home),
    token: "b".repeat(64)
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    resetDevHome({ projectRoot: root, outputDir }),
    /cannot verify development Controller state/i
  );
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "keep me\n");
});

test("development home reset authenticates and refuses a running Controller", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-live-controller-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "keep me\n");
  const controller = await startControllerServer(home);
  t.after(() => controller.close());
  assert.equal(controller.discovery.processStartIdentity, currentProcessStartIdentity());

  await assert.rejects(
    resetDevHome({ projectRoot: root, outputDir }),
    /refusing to reset.*Controller.*running/is
  );
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "keep me\n");
});

test("Controller discovery protocol requires the Linux process start identity", () => {
  const socketPath = "/tmp/yui-controller-protocol.sock";
  const discovery = {
    pid: process.pid,
    processStartIdentity: currentProcessStartIdentity(),
    socketPath,
    token: "c".repeat(64)
  };

  assert.deepEqual(parseControllerDiscovery(discovery, socketPath), discovery);
  const { processStartIdentity: _removed, ...legacyDiscovery } = discovery;
  assert.throws(
    () => parseControllerDiscovery(legacyDiscovery, socketPath),
    /Controller discovery is invalid/i
  );
});

test("development home reset fails safely when a Controller socket has lost discovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-missing-discovery-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "keep me\n");
  const controller = await startControllerServer(home);
  t.after(() => controller.close());
  rmSync(join(home, "runtime", "controller.json"));

  await assert.rejects(
    resetDevHome({ projectRoot: root, outputDir }),
    /cannot verify development Controller state/i
  );
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "keep me\n");
});

test("Controller startup and development reset honor the same outside-home lifecycle lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-lifecycle-lock-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const lockPath = join(outputDir, ".home.controller-lifecycle.lock");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "keep me\n");
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: "held-by-test",
    createdAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    resetDevHome({ projectRoot: root, outputDir }),
    /home lifecycle operation is already running/i
  );
  await assert.rejects(
    startControllerServer(home),
    /home lifecycle operation is already running/i
  );
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "keep me\n");
  rmSync(lockPath);
});

test("development reset retries when a lifecycle owner releases between EEXIST and read", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-released-lifecycle-lock-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const lockPath = join(outputDir, ".home.controller-lifecycle.lock");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "recoverable\n");
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: "releasing-reset-owner",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`, { mode: 0o600 });

  const originalReadFileSync = fs.readFileSync;
  let releasedBeforeRead = false;
  fs.readFileSync = function readFileAfterSimulatedRelease(path, ...args) {
    if (!releasedBeforeRead && String(path) === lockPath) {
      releasedBeforeRead = true;
      fs.rmSync(lockPath);
    }
    return originalReadFileSync.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  let reset;
  try {
    reset = await resetDevHome({ projectRoot: root, outputDir });
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }

  assert.equal(releasedBeforeRead, true);
  assert.equal(reset.moved, true);
  assert.equal(existsSync(lockPath), false);
  assert.equal(readFileSync(join(reset.backupPath, "state.json"), "utf8"), "recoverable\n");
});

test("Controller startup retries when a lifecycle owner releases between EEXIST and read", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-start-released-lifecycle-lock-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const lockPath = join(outputDir, ".home.controller-lifecycle.lock");
  mkdirSync(home, { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: "releasing-start-owner",
    createdAt: "2026-07-24T00:00:01.000Z"
  })}\n`, { mode: 0o600 });

  const originalReadFile = fs.promises.readFile;
  const originalRm = fs.promises.rm;
  let releasedBeforeRead = false;
  fs.promises.readFile = async function readFileAfterSimulatedRelease(path, ...args) {
    if (!releasedBeforeRead && String(path) === lockPath) {
      releasedBeforeRead = true;
      await originalRm.call(this, lockPath);
    }
    return originalReadFile.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  let controller;
  try {
    controller = await startControllerServer(home);
  } finally {
    fs.promises.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
  t.after(() => controller.close());

  assert.equal(releasedBeforeRead, true);
  assert.equal(controller.discovery.pid, process.pid);
  assert.equal(existsSync(lockPath), false);
});

test("development reset preserves a stale lifecycle lock and every recovery attempt fails safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-stale-lifecycle-lock-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const lockPath = join(outputDir, ".home.controller-lifecycle.lock");
  const createdAt = "2026-07-24T00:00:00.000Z";
  const lockContents = `${JSON.stringify({
    pid: 2_147_483_647,
    token: "dead-reset-owner",
    createdAt
  })}\n`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "recoverable\n");
  writeFileSync(lockPath, lockContents, { mode: 0o600 });

  const isExactStaleLockError = (error) => {
    assert.match(error.message, /previous Yui home lifecycle operation left a stale lock/i);
    assert.match(error.message, /owner PID 2147483647/);
    assert.match(error.message, /createdAt 2026-07-24T00:00:00\.000Z/);
    assert.equal(error.message.includes(lockPath), true);
    assert.match(error.message, /remove this exact lock file and retry/i);
    return true;
  };
  await assert.rejects(
    resetDevHome({ projectRoot: root, outputDir }),
    isExactStaleLockError
  );
  await assert.rejects(
    resetDevHome({ projectRoot: root, outputDir }),
    isExactStaleLockError
  );

  assert.equal(readFileSync(lockPath, "utf8"), lockContents);
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "recoverable\n");
});

test("Controller startup preserves a stale lifecycle lock and every recovery attempt fails safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-start-stale-lifecycle-lock-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const lockPath = join(outputDir, ".home.controller-lifecycle.lock");
  const createdAt = "2026-07-24T00:00:01.000Z";
  const lockContents = `${JSON.stringify({
    pid: 2_147_483_647,
    token: "dead-start-owner",
    createdAt
  })}\n`;
  mkdirSync(home, { recursive: true });
  writeFileSync(lockPath, lockContents, { mode: 0o600 });

  const isExactStaleLockError = (error) => {
    assert.match(error.message, /previous Yui home lifecycle operation left a stale lock/i);
    assert.match(error.message, /owner PID 2147483647/);
    assert.match(error.message, /createdAt 2026-07-24T00:00:01\.000Z/);
    assert.equal(error.message.includes(lockPath), true);
    assert.match(error.message, /remove this exact lock file and retry/i);
    return true;
  };
  await assert.rejects(startControllerServer(home), isExactStaleLockError);
  await assert.rejects(startControllerServer(home), isExactStaleLockError);

  assert.equal(readFileSync(lockPath, "utf8"), lockContents);
  assert.equal(existsSync(join(home, "runtime", "controller.json")), false);
});

test("malformed lifecycle locks fail safely and are never removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-invalid-lifecycle-lock-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  const lockPath = join(outputDir, ".home.controller-lifecycle.lock");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "keep me\n");
  writeFileSync(lockPath, "partially-written");

  await assert.rejects(
    resetDevHome({ projectRoot: root, outputDir }),
    /cannot verify the existing Yui home lifecycle lock/i
  );
  await assert.rejects(
    startControllerServer(home),
    /cannot verify the existing Yui home lifecycle lock/i
  );
  assert.equal(readFileSync(lockPath, "utf8"), "partially-written");
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), "keep me\n");
});
