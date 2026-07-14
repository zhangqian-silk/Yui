import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as nativeStorage from "../dist/storage/nativeStorageFs.js";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function exactIdentity(descriptor) {
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

function contendForExclusiveBarrier(path) {
  const script = `
    import { closeSync, constants, fstatSync, openSync } from "node:fs";
    import * as nativeStorage from ${JSON.stringify(
      new URL("../dist/storage/nativeStorageFs.js", import.meta.url).href
    )};
    const descriptor = openSync(${JSON.stringify(path)},
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor, { bigint: true });
    try {
      const barrier = nativeStorage.acquireStableAncestorExclusiveBarrier(descriptor, {
        dev: identity.dev,
        ino: identity.ino,
        uid: identity.uid,
        mode: identity.mode,
        nlink: identity.nlink,
        birthtimeNs: identity.birthtimeNs
      });
      nativeStorage.releaseStableAncestorBarrier(barrier);
      process.stdout.write("acquired");
    } catch (error) {
      process.stdout.write(String(error.code));
    } finally {
      closeSync(descriptor);
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined }
  });
}

function requireOpenat2(t, barrier) {
  try {
    nativeStorage.inspectDirectoryAt(barrier, "taskmux-openat2-probe-missing");
    return true;
  } catch (error) {
    if (error.code === "ENOTSUP") {
      t.skip("kernel does not provide openat2; native authority correctly fails closed");
      return false;
    }
    throw error;
  }
}

test("native storage exposes the final opaque barrier and fd-relative API", () => {
  for (const name of [
    "acquireStableAncestorSharedBarrier",
    "acquireStableAncestorExclusiveBarrier",
    "releaseStableAncestorBarrier",
    "inspectDirectoryDescriptor",
    "inspectDirectoryAt",
    "mkdirExactNoReplace",
    "withPinnedRootAt",
    "publishAnonymousFileNoReplace",
    "linkPreparedFileNoReplace",
    "renameNoReplaceExact",
    "removeExactEntry"
  ]) {
    assert.equal(typeof nativeStorage[name], "function", `${name} must be public`);
  }
  assert.equal("acquireInheritedSharedFlock" in nativeStorage, false);
  assert.equal("acquireInheritedExclusiveFlock" in nativeStorage, false);
  assert.equal("releaseInheritedExclusiveFlock" in nativeStorage, false);
});

test("a shared stable-ancestor barrier blocks cooperative exclusive writers", (t) => {
  const ancestor = mkdtempSync(join(tmpdir(), "taskmux-native-barrier-"));
  const descriptor = openSync(ancestor, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(descriptor);
    rmSync(ancestor, { recursive: true, force: true });
  });

  const barrier = nativeStorage.acquireStableAncestorSharedBarrier(
    descriptor,
    exactIdentity(descriptor)
  );
  assert.deepEqual(Reflect.ownKeys(barrier), []);
  assert.equal(Object.isFrozen(barrier), true);
  assert.equal(contendForExclusiveBarrier(ancestor).stdout, "EWOULDBLOCK");
  nativeStorage.releaseStableAncestorBarrier(barrier);
  assert.equal(contendForExclusiveBarrier(ancestor).stdout, "acquired");
});

test("anchored operations require openat2's full no-escape resolution contract", () => {
  const source = readFileSync(join(process.cwd(), "native", "storage_fs.c"), "utf8");
  assert.match(
    source,
    /RESOLVE_BENEATH \| RESOLVE_NO_MAGICLINKS \|\s+RESOLVE_NO_SYMLINKS \| RESOLVE_NO_XDEV/
  );
  assert.match(
    source,
    /#elif defined\(__x86_64__\) \|\| defined\(__aarch64__\)[\s\S]*#define TASKMUX_OPENAT2_SYSCALL 437/
  );
  assert.match(source, /errno == ENOSYS\) errno = EOPNOTSUPP/);
});

test("pinned-root reads retain the pre-swap directory and reject child symlink replacement", (t) => {
  const ancestor = mkdtempSync(join(tmpdir(), "taskmux-native-pinned-read-"));
  const root = join(ancestor, "root");
  const movedRoot = join(ancestor, "root-moved");
  const evil = join(ancestor, "evil");
  const child = join(root, "child");
  const movedChild = join(root, "child-moved");
  mkdirSync(child, { recursive: true });
  mkdirSync(evil);
  writeFileSync(join(root, "safe.txt"), "safe root bytes\n", { mode: 0o600 });
  writeFileSync(join(child, "safe.txt"), "safe child bytes\n", { mode: 0o600 });
  writeFileSync(join(evil, "safe.txt"), "attacker bytes\n", { mode: 0o600 });

  const ancestorDescriptor = openSync(ancestor, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(ancestorDescriptor);
    rmSync(ancestor, { recursive: true, force: true });
  });

  const barrier = nativeStorage.acquireStableAncestorSharedBarrier(
    ancestorDescriptor,
    exactIdentity(ancestorDescriptor)
  );
  if (!requireOpenat2(t, barrier)) {
    nativeStorage.releaseStableAncestorBarrier(barrier);
    return;
  }
  const rootIdentity = nativeStorage.inspectDirectoryAt(barrier, "root");
  nativeStorage.withPinnedRootAt(
    barrier,
    "root",
    rootIdentity,
    (reader, identity) => {
      assert.notEqual(reader, undefined);
      assert.deepEqual(identity, rootIdentity);

      renameSync(root, movedRoot);
      symlinkSync(evil, root);
      assert.equal(
        reader.readFileExact("safe.txt", 1024).bytes.toString("utf8"),
        "safe root bytes\n"
      );

      renameSync(join(movedRoot, "child"), movedChild);
      symlinkSync(evil, join(movedRoot, "child"));
      assert.throws(
        () => reader.readFileExact("child/safe.txt", 1024),
        (error) => error.code === "ELOOP" || error.code === "ENOTSUP"
      );
    }
  );
  nativeStorage.releaseStableAncestorBarrier(barrier);
});

test("pinned-root absence is a protected snapshot and readers cannot escape a synchronous callback", (t) => {
  const ancestor = mkdtempSync(join(tmpdir(), "taskmux-native-pinned-absent-"));
  const descriptor = openSync(ancestor, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(descriptor);
    rmSync(ancestor, { recursive: true, force: true });
  });

  const barrier = nativeStorage.acquireStableAncestorSharedBarrier(
    descriptor,
    exactIdentity(descriptor)
  );
  if (!requireOpenat2(t, barrier)) {
    nativeStorage.releaseStableAncestorBarrier(barrier);
    return;
  }
  let escaped;
  nativeStorage.withPinnedRootAt(barrier, "missing", undefined, (reader, identity) => {
    assert.equal(reader, undefined);
    assert.equal(identity, undefined);
    mkdirSync(join(ancestor, "missing"));
    writeFileSync(join(ancestor, "missing", "attacker.txt"), "attacker bytes\n");
  });
  const missingIdentity = nativeStorage.inspectDirectoryAt(barrier, "missing");
  nativeStorage.withPinnedRootAt(barrier, "missing", missingIdentity, (reader) => {
    escaped = reader;
    assert.notEqual(reader, undefined);
  });
  assert.throws(() => escaped.readdir(), /pinned root reader is no longer active/i);
  assert.throws(
    () => nativeStorage.withPinnedRootAt(
      barrier,
      "missing",
      missingIdentity,
      async () => {}
    ),
    /must complete synchronously/i
  );
  let threwUndefined = false;
  try {
    nativeStorage.withPinnedRootAt(
      barrier,
      "missing",
      missingIdentity,
      () => {
        throw undefined;
      }
    );
  } catch (error) {
    threwUndefined = true;
    assert.equal(error, undefined);
  }
  assert.equal(threwUndefined, true, "withPinnedRootAt must preserve an intentional throw undefined");
  let thenGetterThrewUndefined = false;
  try {
    nativeStorage.withPinnedRootAt(
      barrier,
      "missing",
      missingIdentity,
      () => Object.defineProperty({}, "then", {
        get() {
          throw undefined;
        }
      })
    );
  } catch (error) {
    thenGetterThrewUndefined = true;
    assert.equal(error, undefined);
  }
  assert.equal(
    thenGetterThrewUndefined,
    true,
    "withPinnedRootAt must preserve an intentional undefined throw from a then getter"
  );
  nativeStorage.releaseStableAncestorBarrier(barrier);
});

test("link and rename produce durable no-replace receipts through exclusive barriers", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-durable-publication-"));
  const sourceParent = join(root, "source");
  const targetParent = join(root, "target");
  mkdirSync(sourceParent);
  mkdirSync(targetParent);
  const rootDescriptor = openSync(root, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(rootDescriptor);
    rmSync(root, { recursive: true, force: true });
  });

  const barrier = nativeStorage.acquireStableAncestorExclusiveBarrier(
    rootDescriptor,
    exactIdentity(rootDescriptor)
  );
  if (!requireOpenat2(t, barrier)) {
    nativeStorage.releaseStableAncestorBarrier(barrier);
    return;
  }
  const sourceIdentity = nativeStorage.inspectDirectoryAt(barrier, "source");
  const targetIdentity = nativeStorage.inspectDirectoryAt(barrier, "target");
  const prepared = nativeStorage.publishAnonymousFileNoReplace(
    barrier,
    "source",
    sourceIdentity,
    "prepared.txt",
    Buffer.from("linked safely\n")
  );
  const linked = nativeStorage.linkPreparedFileNoReplace(
    barrier,
    "source",
    sourceIdentity,
    "prepared.txt",
    prepared,
    "target",
    targetIdentity,
    "linked.txt"
  );
  assert.equal(readFileSync(join(targetParent, "linked.txt"), "utf8"), "linked safely\n");
  assert.equal(linked.size, BigInt("linked safely\n".length));

  const renameSource = nativeStorage.publishAnonymousFileNoReplace(
    barrier,
    "source",
    sourceIdentity,
    "rename.txt",
    Buffer.from("renamed safely\n")
  );
  const renamed = nativeStorage.renameNoReplaceExact(
    barrier,
    "source",
    sourceIdentity,
    "rename.txt",
    renameSource,
    "target",
    targetIdentity,
    "renamed.txt"
  );
  assert.equal(readFileSync(join(targetParent, "renamed.txt"), "utf8"), "renamed safely\n");
  assert.equal(renamed.size, BigInt("renamed safely\n".length));
  const linkedSource = nativeStorage.withPinnedRootAt(
    barrier,
    "source",
    sourceIdentity,
    (reader) => reader.lstat("prepared.txt")
  );
  assert.notEqual(linkedSource, undefined);
  assert.throws(
    () => nativeStorage.renameNoReplaceExact(
      barrier,
      "source",
      sourceIdentity,
      "prepared.txt",
      linkedSource,
      "target",
      targetIdentity,
      "linked.txt"
    ),
    (error) => error.code === "EEXIST" && error.state === "conflict"
  );
  nativeStorage.releaseStableAncestorBarrier(barrier);
});

test("fd-relative publication rejects a prepared-source final-component replacement", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-source-replacement-"));
  const sourceParent = join(root, "source");
  const targetParent = join(root, "target");
  const evil = join(root, "evil.txt");
  mkdirSync(sourceParent);
  mkdirSync(targetParent);
  writeFileSync(evil, "attacker bytes\n", { mode: 0o600 });
  const rootDescriptor = openSync(root, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(rootDescriptor);
    rmSync(root, { recursive: true, force: true });
  });

  const barrier = nativeStorage.acquireStableAncestorExclusiveBarrier(
    rootDescriptor,
    exactIdentity(rootDescriptor)
  );
  if (!requireOpenat2(t, barrier)) {
    nativeStorage.releaseStableAncestorBarrier(barrier);
    return;
  }
  const sourceIdentity = nativeStorage.inspectDirectoryAt(barrier, "source");
  const targetIdentity = nativeStorage.inspectDirectoryAt(barrier, "target");
  const prepared = nativeStorage.publishAnonymousFileNoReplace(
    barrier,
    "source",
    sourceIdentity,
    "prepared.txt",
    Buffer.from("prepared bytes\n")
  );
  renameSync(join(sourceParent, "prepared.txt"), join(sourceParent, "prepared-original.txt"));
  symlinkSync(evil, join(sourceParent, "prepared.txt"));

  assert.throws(
    () => nativeStorage.linkPreparedFileNoReplace(
      barrier,
      "source",
      sourceIdentity,
      "prepared.txt",
      prepared,
      "target",
      targetIdentity,
      "target.txt"
    ),
    (error) => error.code === "ELOOP" || error.code === "ESTALE" || error.code === "ENOTSUP"
  );
  assert.equal(readFileSync(evil, "utf8"), "attacker bytes\n");
  assert.equal(nativeStorage.withPinnedRootAt(
    barrier,
    "target",
    targetIdentity,
    (reader) => reader.lstat("target.txt")
  ), undefined);
  nativeStorage.releaseStableAncestorBarrier(barrier);
});

test("exact native removal rejects final-component replacement for files and directories", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-native-exact-remove-"));
  const parent = join(root, "parent");
  const movedFile = join(root, "moved-file.txt");
  const movedDirectory = join(root, "moved-directory");
  mkdirSync(parent);
  const descriptor = openSync(root, DIRECTORY_FLAGS);
  t.after(() => {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  });

  const barrier = nativeStorage.acquireStableAncestorExclusiveBarrier(
    descriptor,
    exactIdentity(descriptor)
  );
  if (!requireOpenat2(t, barrier)) {
    nativeStorage.releaseStableAncestorBarrier(barrier);
    return;
  }

  const filePath = join(parent, "target.txt");
  writeFileSync(filePath, "original file\n", { mode: 0o600 });
  const parentForFile = nativeStorage.inspectDirectoryAt(barrier, "parent");
  const fileReceipt = nativeStorage.withPinnedRootAt(
    barrier,
    "parent",
    parentForFile,
    (reader) => reader.lstat("target.txt")
  );
  assert.notEqual(fileReceipt, undefined);
  renameSync(filePath, movedFile);
  writeFileSync(filePath, "attacker file\n", { mode: 0o600 });

  assert.throws(
    () => nativeStorage.removeExactEntry(
      barrier,
      "parent",
      parentForFile,
      "target.txt",
      fileReceipt,
      "file",
      parentForFile
    ),
    (error) => error.code === "ESTALE" && error.stage === "openat2-target"
  );
  assert.equal(readFileSync(filePath, "utf8"), "attacker file\n");
  assert.equal(readFileSync(movedFile, "utf8"), "original file\n");

  const directoryPath = join(parent, "target-directory");
  mkdirSync(directoryPath);
  const parentForDirectory = nativeStorage.inspectDirectoryAt(barrier, "parent");
  const directoryReceipt = nativeStorage.withPinnedRootAt(
    barrier,
    "parent",
    parentForDirectory,
    (reader) => reader.lstat("target-directory")
  );
  assert.notEqual(directoryReceipt, undefined);
  renameSync(directoryPath, movedDirectory);
  mkdirSync(directoryPath);

  assert.throws(
    () => nativeStorage.removeExactEntry(
      barrier,
      "parent",
      parentForDirectory,
      "target-directory",
      directoryReceipt,
      "directory",
      parentForDirectory
    ),
    (error) => error.code === "ESTALE" && error.stage === "openat2-target"
  );
  assert.equal(lstatSync(directoryPath).isDirectory(), true);
  assert.equal(lstatSync(movedDirectory).isDirectory(), true);
  nativeStorage.releaseStableAncestorBarrier(barrier);
});

test("native exact retirement restores a foreign final-component swap at rename syscall", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-native-rename-pause-"));
  const preload = join(fixtureRoot, "renameat2-pause.so");
  execFileSync("cc", [
    "-shared",
    "-fPIC",
    "-o",
    preload,
    join(process.cwd(), "test", "fixtures", "renameat2-pause.c"),
    "-ldl"
  ]);
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const kind of ["file", "directory"]) {
    const root = mkdtempSync(join(tmpdir(), `taskmux-native-retirement-${kind}-`));
    const stage = join(root, "stage");
    const source = join(root, `source-${kind}`);
    const original = join(fixtureRoot, `${kind}-original`);
    const marker = join(fixtureRoot, `${kind}.marker`);
    mkdirSync(stage);
    if (kind === "file") {
      writeFileSync(source, "original bytes\n", { mode: 0o600 });
    } else {
      mkdirSync(source);
    }
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const script = `
      import { closeSync, constants, fstatSync, openSync } from "node:fs";
      import * as nativeStorage from ${JSON.stringify(
        new URL("../dist/storage/nativeStorageFs.js", import.meta.url).href
      )};
      const descriptor = openSync(${JSON.stringify(root)},
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const rootIdentity = fstatSync(descriptor, { bigint: true });
      const barrier = nativeStorage.acquireStableAncestorExclusiveBarrier(descriptor, {
        dev: rootIdentity.dev, ino: rootIdentity.ino, uid: rootIdentity.uid,
        mode: rootIdentity.mode, nlink: rootIdentity.nlink, birthtimeNs: rootIdentity.birthtimeNs
      });
      try {
        const stage = nativeStorage.inspectDirectoryAt(barrier, "stage");
        const source = nativeStorage.withPinnedRootAt(
          barrier,
          ".",
          nativeStorage.inspectDirectoryAt(barrier, "."),
          (reader) => reader.lstat(${JSON.stringify(`source-${kind}`)})
        );
        nativeStorage.renameNoReplaceExact(
          barrier,
          ".",
          nativeStorage.inspectDirectoryAt(barrier, "."),
          ${JSON.stringify(`source-${kind}`)},
          source,
          "stage",
          stage,
          "retired"
        );
        process.stdout.write("unexpected-success");
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code, stage: error.stage, state: error.state }));
      } finally {
        nativeStorage.releaseStableAncestorBarrier(barrier);
        closeSync(descriptor);
      }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        LD_PRELOAD: preload,
        TASKMUX_TEST_RENAMEAT2_MARKER: marker,
        TASKMUX_TEST_RENAMEAT2_TARGET: "retired"
      }
    });
    await waitForPath(marker);
    renameSync(source, original);
    if (kind === "file") {
      writeFileSync(source, "attacker bytes\n", { mode: 0o600 });
    } else {
      mkdirSync(source);
    }
    const result = await childResult(child);
    assert.equal(result.code, 0, result.stderr);
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.code, "ESTALE");
    assert.equal(failure.stage, "verify-target");
    assert.equal(failure.state, "source-restored");
    assert.equal(existsSync(join(stage, "retired")), false);
    if (kind === "file") {
      assert.equal(readFileSync(source, "utf8"), "attacker bytes\n");
      assert.equal(readFileSync(original, "utf8"), "original bytes\n");
    } else {
      assert.equal(lstatSync(source).isDirectory(), true);
      assert.equal(lstatSync(original).isDirectory(), true);
    }
  }
});

async function waitForPath(path) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
