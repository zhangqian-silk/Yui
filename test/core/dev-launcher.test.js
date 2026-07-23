import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installDevLauncher,
  linkDevLauncher,
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

test("global development link replaces yui reversibly and works from other directories", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-global-link-"));
  const projectRoot = join(root, "checkout");
  const globalBinDir = join(root, "global-bin");
  mkdirSync(join(projectRoot, "dist"), { recursive: true });
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "production-yui"), "production-yui\n");
  symlinkSync("production-yui", join(globalBinDir, "yui"));
  writeFileSync(
    join(projectRoot, "dist", "cli.js"),
    "console.log(JSON.stringify({ home: process.env.YUI_HOME, name: process.env.YUI_CLI_NAME }));\n"
  );

  const linked = linkDevLauncher({ projectRoot, globalBinDir });

  assert.equal(linked.backupPath, join(globalBinDir, ".yui-link-original"));
  assert.equal(linked.statePath, join(globalBinDir, ".yui-link-state.json"));
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

  const unlinked = unlinkDevLauncher({ projectRoot, globalBinDir });

  assert.equal(unlinked.restored, true);
  assert.equal(lstatSync(join(globalBinDir, "yui")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(globalBinDir, "yui")), "production-yui");
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(existsSync(linked.backupPath), false);
  assert.equal(existsSync(linked.statePath), false);
});

test("the last development checkout wins and unlink from any checkout restores production", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-dev-global-link-"));
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  const unrelatedRoot = join(root, "unrelated");
  const globalBinDir = join(root, "global-bin");
  mkdirSync(globalBinDir, { recursive: true });
  writeFileSync(join(globalBinDir, "yui"), "production-yui\n");

  const first = linkDevLauncher({ projectRoot: firstRoot, globalBinDir });
  assert.deepEqual(linkDevLauncher({ projectRoot: firstRoot, globalBinDir }), first);
  const second = linkDevLauncher({ projectRoot: secondRoot, globalBinDir });

  assert.equal(readlinkSync(join(globalBinDir, "yui")), second.localLauncherPath);
  assert.equal(readFileSync(second.backupPath, "utf8"), "production-yui\n");
  assert.equal(existsSync(first.localLauncherPath), true);

  const unlinked = unlinkDevLauncher({ projectRoot: unrelatedRoot, globalBinDir });

  assert.equal(unlinked.restored, true);
  assert.equal(readFileSync(join(globalBinDir, "yui"), "utf8"), "production-yui\n");
  assert.equal(existsSync(second.localLauncherPath), false);
  assert.equal(existsSync(second.statePath), false);
  assert.equal(existsSync(second.backupPath), false);
});
