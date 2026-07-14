import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  acquireStableAncestorExclusiveBarrier,
  acquireStableAncestorSharedBarrier,
  publishAnonymousFileNoReplace,
  releaseStableAncestorBarrier
} from "../dist/storage/nativeStorageFs.js";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const require = createRequire(import.meta.url);
const rawBinding = require(
  `../prebuilds/linux-${process.arch}-glibc/napi-v8/taskmux_storage_fs.node`
);

function descriptorIdentity(descriptor) {
  const identity = fstatSync(descriptor, { bigint: true });
  return {
    dev: identity.dev,
    ino: identity.ino,
    uid: identity.uid,
    mode: identity.mode,
    nlink: identity.nlink,
    birthtimeNs: identity.birthtimeNs
  };
}

function withExclusiveRootBarrier(descriptor, callback) {
  const barrier = acquireStableAncestorExclusiveBarrier(
    descriptor,
    descriptorIdentity(descriptor)
  );
  try {
    return callback(barrier);
  } finally {
    releaseStableAncestorBarrier(barrier);
  }
}

function publishInRoot(descriptor, name, bytes) {
  return withExclusiveRootBarrier(descriptor, (barrier) => publishAnonymousFileNoReplace(
    barrier,
    ".",
    descriptorIdentity(descriptor),
    name,
    bytes
  ));
}

function contendForLock(path, mode = "exclusive") {
  const script = `
    import { closeSync, constants, fstatSync, openSync } from "node:fs";
    import {
      acquireStableAncestorExclusiveBarrier,
      acquireStableAncestorSharedBarrier,
      releaseStableAncestorBarrier
    } from ${JSON.stringify(new URL("../dist/storage/nativeStorageFs.js", import.meta.url).href)};
    const fd = openSync(${JSON.stringify(path)},
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    try {
      const evidence = ${mode === "shared"
        ? "acquireStableAncestorSharedBarrier"
        : "acquireStableAncestorExclusiveBarrier"}(fd, {
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        mode: stat.mode,
        nlink: stat.nlink,
        birthtimeNs: stat.birthtimeNs
      });
      releaseStableAncestorBarrier(evidence);
      process.stdout.write("acquired");
    } catch (error) {
      process.stdout.write(String(error.code));
    } finally {
      closeSync(fd);
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined }
  });
}

test("native storage authority exports one exact final ABI", () => {
  assert.deepEqual(
    Reflect.ownKeys(rawBinding).sort(),
    [
      "acquireStableAncestorExclusiveBarrier",
      "acquireStableAncestorSharedBarrier",
      "getPinnedDirectoryIdentity",
      "inspectDirectoryDescriptor",
      "inspectDirectoryAt",
      "linkPreparedFileNoReplace",
      "lstatPinnedDirectory",
      "mkdirExactNoReplace",
      "openPinnedRootAt",
      "publishAnonymousFileNoReplace",
      "readPinnedFileExact",
      "readdirPinnedDirectory",
      "releasePinnedDirectory",
      "releaseStableAncestorBarrier",
      "renameNoReplaceExact"
    ].sort()
  );
});

test("native storage authority mints opaque stable barriers only after exact flock", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-flock-"));
  const descriptor = openSync(root, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  });

  const evidence = acquireStableAncestorExclusiveBarrier(
    descriptor,
    descriptorIdentity(descriptor)
  );
  assert.deepEqual(Reflect.ownKeys(evidence), []);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(contendForLock(root).stdout, "EWOULDBLOCK");
  releaseStableAncestorBarrier(evidence);
  releaseStableAncestorBarrier(evidence);
  assert.equal(contendForLock(root).stdout, "acquired");
});

test("native storage authority permits compatible shared barriers and rejects stale identities", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-flock-shared-"));
  const descriptor = openSync(root, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  });

  const expected = descriptorIdentity(descriptor);
  const evidence = acquireStableAncestorSharedBarrier(descriptor, expected);
  assert.equal(contendForLock(root, "shared").stdout, "acquired");
  assert.equal(contendForLock(root, "exclusive").stdout, "EWOULDBLOCK");
  releaseStableAncestorBarrier(evidence);
  assert.throws(
    () => acquireStableAncestorExclusiveBarrier(descriptor, {
      ...expected,
      ino: expected.ino + 1n
    }),
    (error) => error.code === "ESTALE" && error.stage === "verify-ancestor"
  );
  assert.throws(
    () => acquireStableAncestorExclusiveBarrier(1, expected),
    /ancestor descriptor must be an inherited non-stdio/i
  );
});

test("native storage authority fails closed when its exact prebuild is unavailable", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "taskmux-native-unavailable-"));
  const fixtureStorage = join(fixture, "dist", "storage");
  mkdirSync(fixtureStorage, { recursive: true });
  copyFileSync(
    join(process.cwd(), "dist", "storage", "nativeStorageFs.js"),
    join(fixtureStorage, "nativeStorageFs.js")
  );
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  const unavailable = await import(pathToFileURL(
    join(fixtureStorage, "nativeStorageFs.js")
  ).href);
  assert.throws(
    () => unavailable.acquireStableAncestorSharedBarrier(3, {}),
    (error) => {
      assert.equal(error.code, "ENOTSUP");
      assert.equal(error.kind, "native-stable-ancestor-barrier");
      assert.equal(error.stage, "load-binding");
      assert.equal(error.state, "not-acquired");
      return true;
    }
  );
});

test("native storage loader rejects a symlinked prebuild without invoking it", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "taskmux-native-symlinked-"));
  const fixtureStorage = join(fixture, "dist", "storage");
  const fixturePrebuild = join(
    fixture,
    "prebuilds",
    `linux-${process.arch}-glibc`,
    "napi-v8"
  );
  mkdirSync(fixtureStorage, { recursive: true });
  mkdirSync(fixturePrebuild, { recursive: true });
  copyFileSync(
    join(process.cwd(), "dist", "storage", "nativeStorageFs.js"),
    join(fixtureStorage, "nativeStorageFs.js")
  );
  symlinkSync(
    join(process.cwd(), "native", "build", "Release", "taskmux_storage_fs.node"),
    join(fixturePrebuild, "taskmux_storage_fs.node")
  );
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  const symlinked = await import(pathToFileURL(
    join(fixtureStorage, "nativeStorageFs.js")
  ).href);
  assert.throws(
    () => symlinked.acquireStableAncestorSharedBarrier(3, {}),
    (error) => {
      assert.equal(error.code, "ENOTSUP");
      assert.equal(error.stage, "load-binding");
      assert.match(String(error.cause), /symbolic link/i);
      return true;
    }
  );
});

test("native publication creates one private durable receipt from a copied Buffer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-publish-"));
  const descriptor = openSync(root, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  });

  const content = Buffer.from("exact native bytes\n");
  const receipt = publishInRoot(descriptor, "snapshot.json", content);
  const published = statSync(join(root, "snapshot.json"), { bigint: true });
  assert.equal(Object.getPrototypeOf(receipt), null);
  assert.equal(readFileSync(join(root, "snapshot.json"), "utf8"), content.toString("utf8"));
  assert.equal(published.mode & 0o777n, 0o600n);
  assert.equal(receipt.dev, published.dev);
  assert.equal(receipt.ino, published.ino);
  assert.equal(receipt.uid, published.uid);
  assert.equal(receipt.birthtimeNs, published.birthtimeNs);
  assert.equal(receipt.size, BigInt(content.length));
});

test("native publication rejects invalid final names without publishing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-invalid-name-"));
  const descriptor = openSync(root, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  });

  for (const name of ["", ".", "..", "nested/file", "nul\0name"]) {
    assert.throws(
      () => publishInRoot(descriptor, name, Buffer.from("must not publish")),
      /target name must be a basename/i
    );
    if (!["", ".", ".."].includes(name)) {
      assert.equal(lstatSync(join(root, name.replace(/\0/g, "")), {
        throwIfNoEntry: false
      }), undefined);
    }
  }
});

test("native publication result and structured errors ignore poisoned prototype setters", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-inert-result-"));
  const descriptor = openSync(root, DIRECTORY_FLAGS);
  const expected = descriptorIdentity(descriptor);
  const barrier = acquireStableAncestorExclusiveBarrier(descriptor, expected);
  const calls = [];
  Object.defineProperty(Object.prototype, "dev", {
    configurable: true,
    set() {
      calls.push("result");
      throw new Error("poisoned result setter");
    }
  });
  Object.defineProperty(Error.prototype, "kind", {
    configurable: true,
    set() {
      calls.push("error");
      throw new Error("poisoned error setter");
    }
  });
  t.after(() => {
    delete Object.prototype.dev;
    delete Error.prototype.kind;
    releaseStableAncestorBarrier(barrier);
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  });

  const receipt = publishAnonymousFileNoReplace(
    barrier,
    ".",
    expected,
    "snapshot.json",
    Buffer.from("content")
  );
  assert.equal(Object.hasOwn(receipt, "dev"), true);
  assert.throws(
    () => publishAnonymousFileNoReplace(
      barrier,
      ".",
      expected,
      "snapshot.json",
      Buffer.from("collision")
    ),
    (error) => {
      assert.equal(Object.hasOwn(error, "kind"), true);
      assert.equal(error.kind, "external-publication");
      assert.equal(error.stage, "link-target");
      assert.equal(error.state, "conflict");
      return true;
    }
  );
  assert.deepEqual(calls, []);
});

test("native publication reports a post-link syscall error as published-not-durable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-linkat-eio-"));
  const preload = join(root, "linkat-success-error.so");
  execFileSync("cc", [
    "-shared",
    "-fPIC",
    "-o",
    preload,
    join(process.cwd(), "test", "fixtures", "linkat-success-error.c"),
    "-ldl"
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const script = `
    import { closeSync, constants, fstatSync, openSync } from "node:fs";
    import {
      acquireStableAncestorExclusiveBarrier,
      publishAnonymousFileNoReplace,
      releaseStableAncestorBarrier
    } from ${JSON.stringify(new URL("../dist/storage/nativeStorageFs.js", import.meta.url).href)};
    const descriptor = openSync(${JSON.stringify(root)},
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor, { bigint: true });
    const barrier = acquireStableAncestorExclusiveBarrier(descriptor, {
      dev: identity.dev, ino: identity.ino, uid: identity.uid, mode: identity.mode,
      nlink: identity.nlink, birthtimeNs: identity.birthtimeNs
    });
    try {
      publishAnonymousFileNoReplace(barrier, ".", {
        dev: identity.dev, ino: identity.ino, uid: identity.uid, mode: identity.mode,
        nlink: identity.nlink, birthtimeNs: identity.birthtimeNs
      }, "snapshot.json", Buffer.from("exact content"));
      process.stdout.write("unexpected-success");
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code, stage: error.stage, state: error.state }));
    } finally {
      releaseStableAncestorBarrier(barrier);
      closeSync(descriptor);
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      LD_PRELOAD: preload,
      TASKMUX_TEST_LINKAT_SUCCESS_ERROR: "1"
    }
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    code: "EIO",
    stage: "link-target",
    state: "published-not-durable"
  });
  assert.equal(readFileSync(join(root, "snapshot.json"), "utf8"), "exact content");
});

test("native publication atomically preserves every existing target kind", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-conflict-"));
  const descriptor = openSync(root, DIRECTORY_FLAGS);
  writeFileSync(join(root, "regular.txt"), "regular\n");
  writeFileSync(join(root, "source.txt"), "source\n");
  symlinkSync(join(root, "source.txt"), join(root, "symlink.txt"));
  mkdirSync(join(root, "directory"));
  t.after(() => {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  });

  for (const name of ["regular.txt", "symlink.txt", "directory"]) {
    assert.throws(
      () => publishInRoot(descriptor, name, Buffer.from("attacker\n")),
      (error) => error.code === "EEXIST" && error.state === "conflict"
    );
  }
  assert.equal(readFileSync(join(root, "regular.txt"), "utf8"), "regular\n");
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "source\n");
  assert.equal(lstatSync(join(root, "symlink.txt")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(root, "directory")).isDirectory(), true);
});

test("native authority closes anonymous sources on success and conflict", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-fd-ownership-"));
  const descriptor = openSync(root, DIRECTORY_FLAGS);
  publishInRoot(descriptor, "warmup", Buffer.from("warmup"));
  const descriptorsBefore = readdirSync("/proc/self/fd").length;
  t.after(() => {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  });

  for (let index = 0; index < 25; index += 1) {
    const targetName = `snapshot-${index}.txt`;
    publishInRoot(descriptor, targetName, Buffer.from(`content-${index}`));
    assert.throws(
      () => publishInRoot(descriptor, targetName, Buffer.from("collision")),
      (error) => error.code === "EEXIST"
    );
  }
  const descriptorsAfter = readdirSync("/proc/self/fd").length;
  assert.ok(
    descriptorsAfter <= descriptorsBefore + 2,
    `native publication leaked file descriptors: ${descriptorsBefore} -> ${descriptorsAfter}`
  );
});
