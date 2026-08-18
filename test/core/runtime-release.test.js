import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ACTIVE_RELEASE_POINTER_PATH,
  HANDOVER_FENCE_PATH,
  RUNTIME_IDENTITY_PATH,
  assertReleaseIsNotWorktreeOrLinked,
  computePackageDigest,
  readActiveReleasePointer,
  readHandoverFence,
  readRuntimeIdentity,
  removeHandoverFence,
  resolveActiveRelease,
  releaseDirectoryName,
  verifyReleaseIntegrity,
  writeActiveReleasePointer,
  writeHandoverFence,
  writeRuntimeIdentity
} from "../../dist/release/runtimeRelease.js";
import { createReleaseActivatePorts } from "../../dist/commands/releaseCommands.js";

function makeRelease(root, { version = "0.6.0", content = "#!/usr/bin/env node\n", extra = {} } = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "dist"), { recursive: true, mode: 0o755 });
  writeFileSync(join(root, "dist", "cli.js"), content, { mode: 0o755 });
  const cliPath = join(root, "dist", "cli.js");
  const hash = createHash("sha256").update(readFileSync(cliPath)).digest("hex");
  const stat = statSync(cliPath);
  const files = [{ path: "dist/cli.js", sha256: hash, bytes: stat.size }];
  const packageDigest = computePackageDigest(files);
  const manifest = {
    schemaVersion: 1,
    version,
    buildId: `${version}-${packageDigest.slice(0, 12)}`,
    packageDigest,
    files,
    assembledAt: "2026-08-17T00:00:00.000Z",
    ...extra
  };
  writeFileSync(join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

test("release directory name is version plus full package digest", () => {
  const manifest = makeRelease(mkdtempSync(join(tmpdir(), "yui-release-")));
  assert.equal(
    releaseDirectoryName(manifest),
    `0.6.0-${manifest.packageDigest}`
  );
});

test("same semantic version with different package digest is a different build", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-release-"));
  const a = makeRelease(join(root, "a"));
  const b = makeRelease(join(root, "b"), { content: "#!/usr/bin/env node\n// build b\n" });
  assert.equal(a.version, b.version);
  assert.notEqual(a.packageDigest, b.packageDigest);
  assert.notEqual(a.buildId, b.buildId);
  assert.notEqual(releaseDirectoryName(a), releaseDirectoryName(b));
});

test("verifyReleaseIntegrity accepts a clean release and rejects drift", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-release-"));
  const manifest = makeRelease(root);
  // The manifest lists the cli.js file with its exact digest.
  assert.equal(verifyReleaseIntegrity(root).packageDigest, manifest.packageDigest);

  // Drift: add an unlisted file.
  writeFileSync(join(root, "dist", "extra.js"), "drift");
  assert.throws(() => verifyReleaseIntegrity(root), /drifted/);
});

test("verifyReleaseIntegrity fails closed on content drift", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-release-"));
  const manifest = makeRelease(root);
  // The manifest already lists cli.js; change its content.
  const cliPath = join(root, "dist", "cli.js");
  assert.equal(verifyReleaseIntegrity(root).packageDigest, manifest.packageDigest);

  writeFileSync(cliPath, "#!/usr/bin/env node\n// drifted\n");
  assert.throws(() => verifyReleaseIntegrity(root), /drifted/);
});

test("assertReleaseIsNotWorktreeOrLinked rejects .git and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-release-"));
  makeRelease(root);
  assertReleaseIsNotWorktreeOrLinked(root); // clean

  writeFileSync(join(root, ".git"), "gitdir: /tmp/worktree");
  assert.throws(
    () => assertReleaseIsNotWorktreeOrLinked(root),
    /Git worktree/
  );
  rmSync(join(root, ".git"));

  symlinkSync("/tmp", join(root, "dist", "linked"));
  assert.throws(
    () => assertReleaseIsNotWorktreeOrLinked(root),
    /symbolic links/
  );
});

test("active release pointer round-trips and resolves the release", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-home-"));
  assert.equal(readActiveReleasePointer(home), null);

  const pointer = Object.freeze({
    schemaVersion: 1,
    releaseId: "0.6.0-" + "a".repeat(64),
    version: "0.6.0",
    buildId: "0.6.0-" + "a".repeat(12),
    packageDigest: "a".repeat(64),
    activatedAt: "2026-08-17T00:00:00.000Z"
  });
  writeActiveReleasePointer(home, pointer);
  assert.deepEqual(readActiveReleasePointer(home), pointer);
  assert.ok(existsSync(join(home, ACTIVE_RELEASE_POINTER_PATH)));
});

test("active release pointer fails closed on a missing release", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-home-"));
  writeActiveReleasePointer(home, Object.freeze({
    schemaVersion: 1,
    releaseId: "0.6.0-" + "a".repeat(64),
    version: "0.6.0",
    buildId: "0.6.0-" + "a".repeat(12),
    packageDigest: "a".repeat(64),
    activatedAt: "2026-08-17T00:00:00.000Z"
  }));
  // resolveActiveRelease throws because the release directory is absent.
  assert.throws(() => resolveActiveRelease(home), /not installed/);
});

test("runtime identity receipt round-trips", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-home-"));
  assert.equal(readRuntimeIdentity(home), null);
  const receipt = Object.freeze({
    schemaVersion: 1,
    version: "0.6.0",
    executablePath: "/usr/bin/node",
    args: ["/opt/yui/releases/0.6.0-" + "a".repeat(64) + "/dist/controller/controllerMain.js"],
    buildId: "0.6.0-" + "a".repeat(12),
    packageDigest: "a".repeat(64),
    sourceCommit: null,
    cliRealpath: "/opt/yui/releases/0.6.0-" + "a".repeat(64) + "/dist/cli.js",
    controllerRealpath: "/opt/yui/releases/0.6.0-" + "a".repeat(64) + "/dist/core/controllerServer.js",
    controllerProtocolVersion: 3,
    storageLayoutVersion: 7,
    aggregateSchemaVersion: 18,
    storageBackend: "file",
    workerEnabled: false,
    pid: 12345,
    processStartIdentity: "12345",
    mode: "primary",
    dualOwner: false,
    activeRelease: null,
    writtenAt: "2026-08-17T00:00:00.000Z"
  });
  writeRuntimeIdentity(home, receipt);
  assert.deepEqual(readRuntimeIdentity(home), receipt);
  assert.ok(existsSync(join(home, RUNTIME_IDENTITY_PATH)));
});

test("handover fence round-trips and is removable", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-home-"));
  assert.equal(readHandoverFence(home), null);
  const fence = Object.freeze({
    schemaVersion: 1,
    handoverId: "handover-test",
    phase: "fenced",
    old: Object.freeze({
      pid: 100,
      processStartIdentity: "100",
      buildId: "0.6.0-old",
      version: "0.6.0"
    }),
    candidate: null,
    fromReleaseId: null,
    toReleaseId: "0.6.0-" + "b".repeat(64),
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z"
  });
  writeHandoverFence(home, fence);
  assert.deepEqual(readHandoverFence(home), fence);
  assert.ok(existsSync(join(home, HANDOVER_FENCE_PATH)));

  removeHandoverFence(home);
  assert.equal(readHandoverFence(home), null);
});

test("spawnCandidate fails closed on a drifted release before spawning", () => {
  const releaseDir = mkdtempSync(join(tmpdir(), "yui-release-drift-"));
  makeRelease(releaseDir);
  // Drift the release after installation: the manifest still lists the
  // original digest, but the file content changed on disk.
  writeFileSync(join(releaseDir, "dist", "cli.js"), "#!/usr/bin/env node\n// drifted\n", {
    mode: 0o755
  });
  const home = mkdtempSync(join(tmpdir(), "yui-release-drift-home-"));
  try {
    const ports = createReleaseActivatePorts();
    assert.throws(
      () => ports.spawnCandidate(home, releaseDir, "drift-test-handover"),
      /drifted|manifest/i
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(releaseDir, { recursive: true, force: true });
  }
});
