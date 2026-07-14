import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishExternalTextFile } from "../dist/storage/externalFilePublisher.js";

test("external file publication exposes one pinned publication boundary", async () => {
  const publisher = await import("../dist/storage/externalFilePublisher.js").catch(() => ({}));

  assert.equal(typeof publisher.publishExternalTextFile, "function");
});

test("external file publication rejects a symbolic-link target without following it", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const storageConfig = join(storageRoot, "config.json");
  const output = join(outputRoot, "snapshot.json");
  writeFileSync(storageConfig, "storage-config\n");
  symlinkSync(storageConfig, output);
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => "external\n"),
    /symbolic link/i
  );
  assert.equal(readFileSync(storageConfig, "utf8"), "storage-config\n");
});

test("external file publication rejects a hard link to TASKMUX_HOME without touching either inode", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const storageConfig = join(storageRoot, "config.json");
  const output = join(outputRoot, "snapshot.json");
  writeFileSync(storageConfig, "storage-config\n");
  fs.linkSync(storageConfig, output);
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => "external\n"),
    /target already exists/i
  );
  assert.equal(readFileSync(storageConfig, "utf8"), "storage-config\n");
  assert.equal(readFileSync(output, "utf8"), "storage-config\n");
});

test("external file publication rejects an existing regular file without producing content", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "snapshot.json");
  writeFileSync(output, "old\n", { mode: 0o644 });
  chmodSync(output, 0o644);
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  let produced = false;
  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => {
      produced = true;
      return "new\n";
    }),
    /target already exists/i
  );

  assert.equal(produced, false);
  assert.equal(readFileSync(output, "utf8"), "old\n");
  assert.equal(statSync(output).mode & 0o777, 0o644);
});

test("external file publication does not overwrite a concurrent symlink at the final publication barrier", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const storageConfig = join(storageRoot, "config.json");
  const output = join(outputRoot, "snapshot.json");
  writeFileSync(storageConfig, "storage-config\n");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  let swapped = false;
  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => {
      swapped = true;
      symlinkSync(storageConfig, output);
      return "new\n";
    }),
    /target changed during publication/i
  );

  assert.equal(swapped, true);
  assert.equal(lstatSync(output).isSymbolicLink(), true);
  assert.equal(readFileSync(storageConfig, "utf8"), "storage-config\n");
  assert.deepEqual(readdirSync(outputRoot), ["snapshot.json"]);
});

test("external file publication does not overwrite a target concurrently created at an absent path", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "snapshot.json");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  let collided = false;
  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => {
      collided = true;
      writeFileSync(output, "concurrent\n");
      return "new\n";
    }),
    /target changed during publication/i
  );

  assert.equal(collided, true);
  assert.equal(readFileSync(output, "utf8"), "concurrent\n");
  assert.deepEqual(readdirSync(outputRoot), ["snapshot.json"]);
});

test("external file publication never delegates source-FD replacement to a child process", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "snapshot.json");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  const originalSpawnSync = childProcess.spawnSync;
  const originalLinkSync = fs.linkSync;
  const originalRenameSync = fs.renameSync;
  let spawnCalls = 0;
  let pathPublicationCalls = 0;
  childProcess.spawnSync = (command, args, options) => {
    spawnCalls += 1;
    const sourceDescriptor = options?.stdio?.[3];
    if (typeof sourceDescriptor === "number") {
      fs.closeSync(sourceDescriptor);
      const attackerDescriptor = fs.openSync(join(outputRoot, "attacker.bin"), "w", 0o600);
      fs.writeSync(attackerDescriptor, "attacker replacement\n");
    }
    throw new Error("External publication must not delegate its source fd.");
  };
  fs.linkSync = () => {
    pathPublicationCalls += 1;
    throw new Error("External publication must not link a JavaScript path.");
  };
  fs.renameSync = () => {
    pathPublicationCalls += 1;
    throw new Error("External publication must not rename a JavaScript path.");
  };
  syncBuiltinESMExports();
  try {
    publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => "safe publication\n");
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    fs.linkSync = originalLinkSync;
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
  }

  assert.equal(spawnCalls, 0);
  assert.equal(pathPublicationCalls, 0);
  assert.equal(readFileSync(output, "utf8"), "safe publication\n");
  assert.deepEqual(readdirSync(outputRoot), ["snapshot.json"]);
});

test("external file publication never exposes a writable source FD to JavaScript", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "snapshot.json");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  const originalSpawnSync = childProcess.spawnSync;
  let spawnCalls = 0;
  childProcess.spawnSync = (command, args, options) => {
    spawnCalls += 1;
    const sourceDescriptor = options?.stdio?.[3];
    if (typeof sourceDescriptor === "number") {
      fs.writeSync(sourceDescriptor, "attacker rewrite\n", 0, "utf8");
    }
    return originalSpawnSync(command, args, options);
  };
  syncBuiltinESMExports();
  try {
    publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => "safe publication\n");
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }

  assert.equal(spawnCalls, 0);
  assert.equal(readFileSync(output, "utf8"), "safe publication\n");
});

test("external file publication creates no destination when production fails", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "snapshot.json");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => {
      throw new Error("producer failed");
    }),
    /producer failed/i
  );
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(outputRoot), []);
});

test("external file publication creates no missing parents when production fails", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const missingParent = join(outputRoot, "missing", "nested");
  const output = join(missingParent, "snapshot.json");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => {
      throw new Error("producer failed");
    }),
    /producer failed/i
  );
  assert.equal(existsSync(join(outputRoot, "missing")), false);
});

test("external file publication preserves the producer error and attempts every descriptor close", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "snapshot.json");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  const originalCloseSync = fs.closeSync;
  const originalOpenSync = fs.openSync;
  const opened = new Set();
  const closeAttempts = new Set();
  fs.openSync = (...args) => {
    const descriptor = originalOpenSync(...args);
    opened.add(descriptor);
    return descriptor;
  };
  fs.closeSync = (descriptor) => {
    closeAttempts.add(descriptor);
    originalCloseSync(descriptor);
    throw new Error(`close failed for ${descriptor}`);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => publishExternalTextFile(output, {
        storageRoot,
        label: "Export output"
      }, () => {
        throw new Error("producer failed");
      }),
      /producer failed/i
    );
  } finally {
    fs.closeSync = originalCloseSync;
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }

  assert.deepEqual([...closeAttempts].sort(), [...opened].sort());
});

test("external file publication reports a close failure when publication has no primary error", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "snapshot.json");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  const originalCloseSync = fs.closeSync;
  const originalOpenSync = fs.openSync;
  let storageDescriptor;
  fs.openSync = (...args) => {
    const descriptor = originalOpenSync(...args);
    if (args[0] === storageRoot && storageDescriptor === undefined) {
      storageDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.closeSync = (descriptor) => {
    originalCloseSync(descriptor);
    if (descriptor === storageDescriptor) throw new Error("storage root close failed");
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => publishExternalTextFile(output, {
        storageRoot,
        label: "Export output"
      }, () => "new\n"),
      /storage root close failed/i
    );
  } finally {
    fs.closeSync = originalCloseSync;
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }

  assert.equal(readFileSync(output, "utf8"), "new\n");
});

test("external file publication preserves a published-not-durable primary error when barrier release also fails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-publisher-dual-failure-"));
  const storageRoot = join(root, "storage");
  const outputRoot = join(root, "output");
  const output = join(outputRoot, "snapshot.json");
  const linkatPreload = join(root, "linkat-success-error.so");
  const flockPreload = join(root, "flock-unlock-error.so");
  mkdirSync(storageRoot);
  mkdirSync(outputRoot);
  childProcess.execFileSync("cc", [
    "-shared",
    "-fPIC",
    "-o",
    linkatPreload,
    join(process.cwd(), "test", "fixtures", "linkat-success-error.c"),
    "-ldl"
  ]);
  childProcess.execFileSync("cc", [
    "-shared",
    "-fPIC",
    "-o",
    flockPreload,
    join(process.cwd(), "test", "fixtures", "flock-unlock-error.c"),
    "-ldl"
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const script = `
    import { publishExternalTextFile } from ${JSON.stringify(
      new URL("../dist/storage/externalFilePublisher.js", import.meta.url).href
    )};
    try {
      publishExternalTextFile(${JSON.stringify(output)}, {
        storageRoot: ${JSON.stringify(storageRoot)},
        label: "Export output"
      }, () => "exact content");
      process.stdout.write("unexpected-success");
    } catch (error) {
      process.stdout.write(JSON.stringify({
        code: error.code, kind: error.kind, stage: error.stage, state: error.state
      }));
    }
  `;
  const child = childProcess.spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      LD_PRELOAD: `${linkatPreload}:${flockPreload}`,
      TASKMUX_TEST_LINKAT_SUCCESS_ERROR: "1",
      TASKMUX_TEST_FLOCK_UNLOCK_ERROR: "1"
    }
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    code: "EIO",
    kind: "external-publication",
    stage: "link-target",
    state: "published-not-durable"
  });
  assert.equal(readFileSync(output, "utf8"), "exact content");
});

test("external file publication closes a newly opened child descriptor when fstat fails", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "missing", "snapshot.json");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  const originalCloseSync = fs.closeSync;
  const originalFstatSync = fs.fstatSync;
  const originalOpenSync = fs.openSync;
  const closeAttempts = new Set();
  let childDescriptor;
  fs.openSync = (...args) => {
    const descriptor = originalOpenSync(...args);
    if (typeof args[0] === "string" && args[0].endsWith("/missing")) {
      childDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.fstatSync = (descriptor, ...args) => {
    if (descriptor === childDescriptor) throw new Error("child fstat failed");
    return originalFstatSync(descriptor, ...args);
  };
  fs.closeSync = (descriptor) => {
    closeAttempts.add(descriptor);
    return originalCloseSync(descriptor);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => publishExternalTextFile(output, {
        storageRoot,
        label: "Export output"
      }, () => "new\n"),
      /child fstat failed/i
    );
  } finally {
    fs.closeSync = originalCloseSync;
    fs.fstatSync = originalFstatSync;
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    if (childDescriptor !== undefined && !closeAttempts.has(childDescriptor)) {
      originalCloseSync(childDescriptor);
    }
  }

  assert.notEqual(childDescriptor, undefined);
  assert.equal(closeAttempts.has(childDescriptor), true);
});

test("external file publication uses a nameless source inode for long valid basenames", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, `${"x".repeat(240)}.json`);
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  publishExternalTextFile(output, {
    storageRoot,
    label: "Export output"
  }, () => "new\n");

  assert.equal(readFileSync(output, "utf8"), "new\n");
  assert.deepEqual(readdirSync(outputRoot).filter((name) => name.startsWith(".taskmux-publish-")), []);
});

test("external file publication rejects an existing non-regular target", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const output = join(outputRoot, "snapshot.json");
  mkdirSync(output);
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => "new\n"),
    /regular file/i
  );
});

test("external file publication rejects lexical TASKMUX_HOME overlap before following parents", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const alias = join(storageRoot, "external-alias");
  const output = join(alias, "snapshot.json");
  symlinkSync(outputRoot, alias);
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => "new\n"),
    /outside TASKMUX_HOME/i
  );
  assert.equal(existsSync(join(outputRoot, "snapshot.json")), false);
});

test("external file publication accepts a stable symbolic-link ancestor after pinning its canonical directory", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const realParent = mkdtempSync(join(tmpdir(), "taskmux-publisher-real-parent-"));
  const alias = join(outputRoot, "alias");
  symlinkSync(realParent, alias);
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(realParent, { recursive: true, force: true });
  });

  publishExternalTextFile(join(alias, "snapshot.json"), {
    storageRoot,
    label: "Export output"
  }, () => "new\n");
  assert.equal(readFileSync(join(realParent, "snapshot.json"), "utf8"), "new\n");
});

test("external file publication rejects a target identity swap during content production", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const storageConfig = join(storageRoot, "config.json");
  const output = join(outputRoot, "snapshot.json");
  writeFileSync(storageConfig, "storage-config\n");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  let swapped = false;
  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => {
      swapped = true;
      symlinkSync(storageConfig, output);
      return "new\n";
    }),
    /target changed during publication/i
  );

  assert.equal(swapped, true);
  assert.equal(lstatSync(output).isSymbolicLink(), true);
  assert.equal(readFileSync(storageConfig, "utf8"), "storage-config\n");
  assert.deepEqual(readdirSync(outputRoot), ["snapshot.json"]);
});

test("external file publication rejects a parent retarget during content production", (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-storage-"));
  const outputRoot = mkdtempSync(join(tmpdir(), "taskmux-publisher-output-"));
  const requestedParent = join(outputRoot, "destination");
  const movedParent = join(outputRoot, "destination-original");
  const storageConfig = join(storageRoot, "config.json");
  const output = join(requestedParent, "config.json");
  mkdirSync(requestedParent);
  writeFileSync(storageConfig, "storage-config\n");
  t.after(() => {
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  });

  let swapped = false;
  assert.throws(
    () => publishExternalTextFile(output, {
      storageRoot,
      label: "Export output"
    }, () => {
      swapped = true;
      renameSync(requestedParent, movedParent);
      symlinkSync(storageRoot, requestedParent);
      return "new\n";
    }),
    /parent changed during publication/i
  );

  assert.equal(swapped, true);
  assert.equal(readFileSync(storageConfig, "utf8"), "storage-config\n");
  assert.equal(existsSync(join(movedParent, "config.json")), false);
  assert.deepEqual(readdirSync(movedParent), []);
});
