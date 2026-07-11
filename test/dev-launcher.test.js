import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEV_LAUNCHER_NAME,
  installDevLauncher,
  uninstallDevLauncher
} from "../scripts/manage-dev-launcher.mjs";

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "taskmux-dev-launcher-"));
  const projectRoot = join(root, "project");
  const binDir = join(root, "bin");

  return {
    root,
    projectRoot,
    binDir,
    launcherPath: join(binDir, DEV_LAUNCHER_NAME)
  };
}

test("installs a local dev launcher that forces the project test home", () => {
  const sandbox = createSandbox();

  try {
    installDevLauncher({ projectRoot: sandbox.projectRoot, binDir: sandbox.binDir });
    const launcher = readFileSync(sandbox.launcherPath, "utf8");

    assert.match(launcher, /TASKMUX_HOME=/);
    assert.match(launcher, /output\/taskmux-cli-dev/);
    assert.match(launcher, /dist\/cli\.js/);
    assert.match(launcher, /taskmux-dev-wrapper-project-root:/);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("launcher overrides an inherited TASKMUX_HOME before starting the local CLI", () => {
  const sandbox = createSandbox();

  try {
    mkdirSync(join(sandbox.projectRoot, "dist"), { recursive: true });
    writeFileSync(
      join(sandbox.projectRoot, "dist", "cli.js"),
      "console.log(process.env.TASKMUX_HOME);\n"
    );
    installDevLauncher({ projectRoot: sandbox.projectRoot, binDir: sandbox.binDir });

    const output = execFileSync(sandbox.launcherPath, {
      encoding: "utf8",
      env: { ...process.env, TASKMUX_HOME: "/tmp/not-taskmux-dev" }
    });

    assert.equal(output.trim(), join(sandbox.projectRoot, "output", "taskmux-cli-dev"));
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("does not overwrite an unmanaged taskmux-dev command", () => {
  const sandbox = createSandbox();

  try {
    installDevLauncher({ projectRoot: sandbox.projectRoot, binDir: sandbox.binDir });
    writeFileSync(sandbox.launcherPath, "#!/bin/sh\nexit 0\n");

    assert.throws(
      () => installDevLauncher({ projectRoot: sandbox.projectRoot, binDir: sandbox.binDir }),
      /Refusing to overwrite unmanaged/
    );
    assert.equal(readFileSync(sandbox.launcherPath, "utf8"), "#!/bin/sh\nexit 0\n");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("removes only the launcher managed by the same project", () => {
  const sandbox = createSandbox();

  try {
    installDevLauncher({ projectRoot: sandbox.projectRoot, binDir: sandbox.binDir });
    const result = uninstallDevLauncher({ projectRoot: sandbox.projectRoot, binDir: sandbox.binDir });

    assert.equal(result.removed, true);
    assert.throws(() => readFileSync(sandbox.launcherPath, "utf8"), /ENOENT/);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("does not remove a launcher owned by a different checkout", () => {
  const sandbox = createSandbox();

  try {
    installDevLauncher({ projectRoot: sandbox.projectRoot, binDir: sandbox.binDir });

    assert.throws(
      () =>
        uninstallDevLauncher({
          projectRoot: join(sandbox.root, "other-project"),
          binDir: sandbox.binDir
        }),
      /Refusing to remove launcher not managed/
    );
    assert.match(readFileSync(sandbox.launcherPath, "utf8"), /taskmux-dev-wrapper-project-root:/);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("Makefile manages the dev launcher without publishing it as an npm bin", () => {
  const makefile = readFileSync("Makefile", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

  assert.match(makefile, /link: build\n\tnpm link\n\tnode scripts\/manage-dev-launcher\.mjs install/);
  assert.match(makefile, /unlink:\n\tnpm unlink -g @zq-silk\/taskmux\n\tnode scripts\/manage-dev-launcher\.mjs uninstall/);
  assert.deepEqual(packageJson.bin, { taskmux: "./dist/cli.js" });
  assert.equal(packageJson.files.includes("scripts"), false);
});
