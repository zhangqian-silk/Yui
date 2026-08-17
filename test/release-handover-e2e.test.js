/**
 * Isolated Integration E2E for immutable releases and atomic Controller
 * handover (Issue 02).
 *
 * Real old/new Controller processes run inside a disposable Home with its own
 * socket, token, and tmux namespace. The test assembles a runtime package
 * from the current build, installs it as an immutable release, activates it,
 * then assembles a second build (same semantic version, different content)
 * and drives a real handover. No real model or Provider is involved.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildReleaseManifest, RELEASE_MANIFEST_FILE } from "../scripts/lib/runtime-package.mjs";
import { createIsolatedRuntime } from "./helpers/isolatedRuntime.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devCli = join(repoRoot, "dist", "cli.js");
const assembler = join(repoRoot, "scripts", "assemble-runtime-package.mjs");
const launcherShim = join(repoRoot, "scripts", "yui-release-shim");
const stageRootParent = join(repoRoot, "tmp");

function createStageRoot(prefix) {
  mkdirSync(stageRootParent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(stageRootParent, prefix));
}

function runYui(args, environment) {
  const result = spawnSync(process.execPath, [devCli, ...args], {
    env: environment,
    encoding: "utf8",
    timeout: 180_000
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function runYuiJson(args, environment) {
  const result = runYui([...args, "--json"], environment);
  if (result.status !== 0) {
    throw new Error(
      `yui ${args.join(" ")} exited ${result.status}:\n${result.stderr}\n${result.stdout}`
    );
  }
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  return parsed.data;
}

/** Runs a CLI command expected to abort with exit code 5 and returns its JSON payload. */
function runYuiJsonAborted(args, environment) {
  const result = runYui([...args, "--json"], environment);
  assert.equal(result.status, 5, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  return parsed.data;
}

function releaseDir(home, releaseId) {
  return join(home, "runtime", "releases", releaseId);
}

/** Assembles a runtime package from the current dist into an output directory. */
function assembleRelease(outputDir) {
  mkdirSync(dirname(outputDir), { recursive: true, mode: 0o700 });
  const result = spawnSync(process.execPath, [assembler, "--output", outputDir], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`assemble-runtime-package exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(readFileSync(join(outputDir, RELEASE_MANIFEST_FILE), "utf8"));
}

function releaseIdOf(manifest) {
  return `${manifest.version}-${manifest.packageDigest}`;
}

test("release handover E2E: immutable releases, atomic handover, launcher shim", async (t) => {
  const runtime = createIsolatedRuntime(t);
  const stageRoot = createStageRoot("release-e2e-");
  try {
    // 1. Assemble release A from the current build and install it.
    const stageA = join(stageRoot, "release-a");
    const manifestA = assembleRelease(stageA);
    const releaseIdA = releaseIdOf(manifestA);

    const installA = runYuiJson(["release", "install", stageA], runtime.environment);
    assert.equal(installA.outcome, "installed");
    assert.equal(installA.releaseId, releaseIdA);
    assert.equal(installA.buildId, manifestA.buildId);

    // 2. Activate release A with no Controller running: pointer switch plus a
    //    Controller started from the immutable release directory.
    const activateA = runYuiJson(["release", "activate", releaseIdA], runtime.environment);
    assert.equal(activateA.outcome, "activated");

    const identityA = runYuiJson(["controller", "identity"], runtime.environment);
    assert.equal(identityA.buildId, manifestA.buildId);
    assert.equal(identityA.packageDigest, manifestA.packageDigest);
    assert.equal(identityA.mode, "primary");
    assert.equal(identityA.dualOwner, false);
    assert.equal(identityA.storageBackend, "file");
    assert.equal(typeof identityA.workerEnabled, "boolean");
    assert.ok(
      identityA.controllerRealpath.startsWith(
        join(releaseDir(runtime.home, releaseIdA), "dist")
      ),
      `Controller realpath must be inside the immutable release: ${identityA.controllerRealpath}`
    );
    assert.ok(!identityA.controllerRealpath.includes(".codex"));

    // 3. Assemble release B: same semantic version, one drifted docs file, a
    //    regenerated manifest, and therefore a different package digest.
    const stageB = join(stageRoot, "release-b");
    cpSync(stageA, stageB, { recursive: true });
    writeFileSync(
      join(stageB, "README.md"),
      `${readFileSync(join(stageB, "README.md"), "utf8")}\n<!-- release-b drift -->\n`,
      { mode: 0o644 }
    );
    const manifestB = buildReleaseManifest(stageB, {
      version: manifestA.version,
      ...(manifestA.sourceCommit === undefined ? {} : { sourceCommit: manifestA.sourceCommit })
    });
    writeFileSync(
      join(stageB, RELEASE_MANIFEST_FILE),
      `${JSON.stringify(manifestB, null, 2)}\n`,
      { mode: 0o644 }
    );
    const releaseIdB = releaseIdOf(manifestB);
    assert.notEqual(releaseIdA, releaseIdB);
    assert.equal(manifestA.version, manifestB.version);

    // 4. Install and activate release B: a real old/new Controller handover.
    const installB = runYuiJson(["release", "install", stageB], runtime.environment);
    assert.equal(installB.outcome, "installed");

    const activateB = runYuiJson(["release", "activate", releaseIdB], runtime.environment);
    assert.equal(activateB.outcome, "activated");
    assert.equal(activateB.releaseId, releaseIdB);

    // 5. The new Controller runs from release B; the handover completed with
    //    no dual-write window and no leftover fence.
    const identityB = runYuiJson(["controller", "identity"], runtime.environment);
    assert.equal(identityB.buildId, manifestB.buildId);
    assert.equal(identityB.packageDigest, manifestB.packageDigest);
    assert.equal(identityB.mode, "primary");
    assert.equal(identityB.dualOwner, false);
    assert.ok(
      identityB.controllerRealpath.startsWith(
        join(releaseDir(runtime.home, releaseIdB), "dist")
      ),
      `Controller realpath must be inside release B: ${identityB.controllerRealpath}`
    );

    const receipt = JSON.parse(
      readFileSync(join(runtime.home, "runtime", "handover.json"), "utf8")
    );
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.activatedReleaseId, releaseIdB);
    assert.equal(receipt.previousReleaseId, releaseIdA);
    assert.equal(existsSync(join(runtime.home, "runtime", "handover-fence.json")), false);

    // 6. The stable launcher shim resolves the active release, never a
    //    worktree or npm link.
    const shimResult = spawnSync(
      "sh",
      [launcherShim, "controller", "identity", "--json"],
      { env: runtime.environment, encoding: "utf8", timeout: 60_000 }
    );
    assert.equal(shimResult.status, 0, shimResult.stderr);
    const shimIdentity = JSON.parse(shimResult.stdout).data;
    assert.equal(shimIdentity.buildId, manifestB.buildId);
    assert.ok(
      shimIdentity.cliRealpath.startsWith(
        join(releaseDir(runtime.home, releaseIdB), "dist")
      ),
      `Shim must resolve the release CLI: ${shimIdentity.cliRealpath}`
    );
    assert.ok(!shimIdentity.cliRealpath.includes(".codex"));

    // 7. `release list` reports both builds with B active; both carry smoke
    //    receipts from install time.
    const list = runYuiJson(["release", "list"], runtime.environment);
    assert.equal(list.active, releaseIdB);
    assert.equal(list.releases.length, 2);
    assert.ok(list.releases.every((release) => release.smoke === true));
    const listedB = list.releases.find((release) => release.releaseId === releaseIdB);
    assert.equal(listedB.buildId, manifestB.buildId);
  } finally {
    await runtime.teardown();
    rmSync(stageRoot, { recursive: true, force: true });
  }
});

test("release install rejects a drifted or worktree-linked package", async (t) => {
  const runtime = createIsolatedRuntime(t);
  const stageRoot = createStageRoot("release-e2e-reject-");
  try {
    const stage = join(stageRoot, "release-drift");
    assembleRelease(stage);

    // Content drift after assembly fails closed.
    writeFileSync(
      join(stage, "README.md"),
      `${readFileSync(join(stage, "README.md"), "utf8")}\n<!-- drift -->\n`,
      { mode: 0o644 }
    );
    const drifted = runYuiJsonAborted(["release", "install", stage], runtime.environment);
    assert.equal(drifted.outcome, "aborted");
    assert.ok(drifted.message.includes("integrity"));

    // A Git worktree marker fails closed.
    const stage2 = join(stageRoot, "release-worktree");
    assembleRelease(stage2);
    writeFileSync(join(stage2, ".git"), "gitdir: /tmp/worktree", { mode: 0o644 });
    const worktree = runYuiJsonAborted(["release", "install", stage2], runtime.environment);
    assert.equal(worktree.outcome, "aborted");
    assert.ok(worktree.message.includes("integrity"));
  } finally {
    await runtime.teardown();
    rmSync(stageRoot, { recursive: true, force: true });
  }
});
