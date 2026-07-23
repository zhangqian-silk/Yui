import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installDevLauncher,
  linkDevLauncher,
  resetDevHome,
  unlinkDevLauncher,
  uninstallDevLauncher
} from "../../scripts/manage-dev-launcher.mjs";

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

test("development home reset moves the old home aside and treats a missing home as normal", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-reset-"));
  const outputDir = join(root, "output", "dev");
  const home = join(outputDir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), "recoverable\n");

  const reset = resetDevHome({ projectRoot: root, outputDir });

  assert.equal(reset.moved, true);
  assert.equal(existsSync(home), false);
  assert.equal(readFileSync(join(reset.backupPath, "state.json"), "utf8"), "recoverable\n");
  assert.match(reset.backupPath, /home\.backup-/);
  assert.deepEqual(resetDevHome({ projectRoot: root, outputDir }), {
    homePath: home,
    backupPath: null,
    moved: false
  });
  assert.equal(readdirSync(outputDir).filter((name) => name.startsWith("home.backup-")).length, 1);
});
