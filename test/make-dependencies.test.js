import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

function runMake(root, logPath) {
  return spawnSync("make", ["build"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NPM_LOG: logPath,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`
    }
  });
}

test("make build installs npm dependencies only when they are stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-make-deps-"));

  try {
    copyFileSync(join(process.cwd(), "Makefile"), join(root, "Makefile"));
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");

    const bin = join(root, "bin");
    const logPath = join(root, "npm.log");
    const npm = join(bin, "npm");
    mkdirSync(bin);
    writeFileSync(
      npm,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$NPM_LOG"
if [ "$1" = "ci" ]; then
  mkdir -p node_modules
  : > node_modules/.package-lock.json
fi
`
    );
    chmodSync(npm, 0o755);

    let result = runMake(root, logPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), [
      "ci",
      "run build"
    ]);

    result = runMake(root, logPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), [
      "ci",
      "run build",
      "run build"
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(root, "package-lock.json"), '{"changed":true}\n');

    result = runMake(root, logPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), [
      "ci",
      "run build",
      "run build",
      "ci",
      "run build"
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
