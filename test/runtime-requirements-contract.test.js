import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = process.cwd();
const supportedNodeEngine = "^20.17.0 || ^22.9.0 || ^24.0.0";
const nodeBadge =
  "node-20.17%2B%20%2820.x%29%20%7C%2022.9%2B%20%2822.x%29%20%7C%2024.x-brightgreen.svg";

test("release metadata and both READMEs preserve the exact native runtime requirements", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const english = readFileSync(join(root, "README.md"), "utf8");
  const chinese = readFileSync(join(root, "i18n", "README.zh-CN.md"), "utf8");
  const nativeSource = readFileSync(join(root, "native", "storage_fs.c"), "utf8");

  assert.equal(manifest.engines.node, supportedNodeEngine);
  for (const readme of [english, chinese]) {
    assert.equal(readme.includes(nodeBadge), true);
    assert.equal(readme.includes("20 or newer"), false);
    assert.equal(readme.includes("20 或更高版本"), false);
    assert.equal(readme.includes("openat2(2)"), true);
    assert.equal(readme.includes("STATX_BTIME"), true);
    assert.equal(readme.includes("O_TMPFILE"), true);
    assert.equal(readme.includes("/proc/self/fd"), true);
    assert.equal(readme.includes("linkat"), true);
    assert.equal(readme.includes("AT_EMPTY_PATH"), false);
    assert.equal(readme.includes("0700"), true);
    assert.equal(readme.includes("ENOTSUP") && readme.includes("EOPNOTSUPP"), true);
    assert.equal(readme.includes("ENOSYS"), true);
    assert.equal(readme.includes("ENOENT") && readme.includes("EACCES"), true);
    assert.equal(readme.includes("taskmux doctor"), true);
  }
  const linkHelperStart = nativeSource.indexOf("static int link_pinned_fd_no_replace(");
  assert.notEqual(linkHelperStart, -1);
  const linkHelperEnd = nativeSource.indexOf(
    "\nstatic void finalize_stable_ancestor_barrier",
    linkHelperStart
  );
  assert.notEqual(linkHelperEnd, -1);
  const linkHelper = nativeSource.slice(linkHelperStart, linkHelperEnd);
  assert.equal(linkHelper.includes("/proc/self/fd/%d"), true);
  assert.equal(linkHelper.includes("AT_SYMLINK_FOLLOW"), true);
  assert.equal(linkHelper.includes("AT_EMPTY_PATH"), false);
  assert.equal(
    english.includes("Node.js 20.17+ (20.x), 22.9+ (22.x), or 24.x"),
    true
  );
  assert.equal(
    english.includes("an upstream Linux kernel 5.6 or newer, or a compatible vendor backport"),
    true
  );
  assert.equal(english.includes("doctor command is the authoritative runtime probe"), true);
  assert.equal(
    english.includes("upstream Linux kernel 5.6 or newer or a compatible vendor backport"),
    true
  );
  assert.equal(english.includes("existing directory automatically"), true);
  assert.equal(english.includes("filesystem root"), true);
  assert.equal(english.includes("home directory"), true);
  assert.equal(
    chinese.includes("Node.js 20.17+（20.x）、22.9+（22.x）或 24.x"),
    true
  );
  assert.equal(
    chinese.includes("Linux 内核须为上游 5.6 或更高版本，或为兼容的厂商回移版本"),
    true
  );
  assert.equal(chinese.includes("doctor 是权威的运行时探测"), true);
  assert.equal(
    chinese.includes("上游 Linux 内核 5.6 或更高版本或兼容的厂商回移版本"),
    true
  );
  assert.equal(chinese.includes("不会自动修改现有目录"), true);
  assert.equal(chinese.includes("文件系统根目录"), true);
  assert.equal(chinese.includes("操作系统账户主目录"), true);
});

test("doctor enforces the exact supported Node LTS lines", async () => {
  const { isSupportedNodeVersion } = await import(pathToFileURL(
    join(root, "dist", "doctor", "doctor.js")
  ).href);

  assert.equal(isSupportedNodeVersion("v20.16.9"), false);
  assert.equal(isSupportedNodeVersion("v20.17.0"), true);
  assert.equal(isSupportedNodeVersion("v20.17.0-rc.1"), false);
  assert.equal(isSupportedNodeVersion("v21.0.0"), false);
  assert.equal(isSupportedNodeVersion("v22.8.9"), false);
  assert.equal(isSupportedNodeVersion("v22.9.0"), true);
  assert.equal(isSupportedNodeVersion("v24.0.0"), true);
  assert.equal(isSupportedNodeVersion("v24.0.0-nightly"), false);
  assert.equal(isSupportedNodeVersion("v25.0.0"), false);
});

test("doctor probes the native storage primitives on TASKMUX_HOME without leaving probe residue", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { getDoctorChecks } = await import(pathToFileURL(
    join(root, "dist", "doctor", "doctor.js")
  ).href);

  const checks = getDoctorChecks(
    { TASKMUX_HOME: home },
    { run: () => "tmux 3.4\n" }
  );
  assert.deepEqual(
    checks.find((check) => check.name === "native storage"),
    {
      name: "native storage",
      status: "ok",
      detail: `openat2 + statx(STATX_BTIME) + O_TMPFILE + /proc/self/fd linkat verified for ${home}`
    }
  );
  assert.deepEqual(readdirSync(home), []);
});

test("doctor holds the native barrier through each probe cleanup step and durable deletion", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-fixture-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  for (const phase of ["file", "directory", "root-fsync"]) {
    const home = mkdtempSync(join(tmpdir(), `taskmux-doctor-native-storage-lock-${phase}-`));
    const marker = join(fixtureRoot, `unlink-marker-${phase}`);
    const child = spawn(process.execPath, ["--input-type=module", "--eval", doctorChildScript(home)], {
      cwd: root,
      env: {
        ...process.env,
        LD_PRELOAD: preload,
        TASKMUX_TEST_DOCTOR_PROBE_UNLINK: "1",
        TASKMUX_TEST_DOCTOR_PROBE_CLEANUP_PHASE: phase,
        TASKMUX_TEST_DOCTOR_PROBE_MARKER: marker
      }
    });

    try {
      await waitForPath(marker);
      const contender = execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", sharedBarrierContenderScript(home)],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_TEST_CONTEXT: undefined }
        }
      );
      assert.equal(contender, "EWOULDBLOCK", phase);

      const result = await childResult(child);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /"status":"ok"/);
      assert.deepEqual(readdirSync(home), []);
    } finally {
      child.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("doctor classifies only a raw TASKMUX_HOME open ENOENT as setup missing", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-missing-"));
  const home = join(parent, "missing-home");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const { getDoctorChecks } = await import(pathToFileURL(
    join(root, "dist", "doctor", "doctor.js")
  ).href);

  assert.deepEqual(
    getDoctorChecks(
      { TASKMUX_HOME: home },
      { run: () => "tmux 3.4\n" }
    ).find((check) => check.name === "native storage"),
    {
      name: "native storage",
      status: "missing",
      detail: "run taskmux setup"
    }
  );
});

test("doctor reports missing statx birth-time identity support as unsupported", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-statx-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-statx-home-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const check = doctorChildCheck(home, {
    LD_PRELOAD: preload,
    TASKMUX_TEST_DOCTOR_FAIL_STATX_BTIME: "1"
  });

  assert.equal(check.status, "unsupported");
  assert.match(check.detail, /STATX_BTIME/);
  assert.match(check.detail, /ENOTSUP|EOPNOTSUPP/);
  assert.deepEqual(readdirSync(home), []);
});

test("doctor normalizes an unavailable storage syscall from ENOSYS to ENOTSUP", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-enosys-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-enosys-home-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const check = doctorChildCheck(home, {
    LD_PRELOAD: preload,
    TASKMUX_TEST_DOCTOR_FAIL_STATX_ENOSYS: "1"
  });

  assert.equal(check.status, "unsupported");
  assert.match(check.detail, /upstream Linux kernel 5\.6\+ or a compatible vendor backport/);
  assert.match(check.detail, /ENOTSUP/);
  assert.doesNotMatch(check.detail, /run taskmux setup/);
  assert.deepEqual(readdirSync(home), []);
});

test("doctor treats an inaccessible procfd link target as unsupported, not setup missing", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-procfd-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-procfd-home-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const check = doctorChildCheck(home, {
    LD_PRELOAD: preload,
    TASKMUX_TEST_DOCTOR_FAIL_PROCFD_LINK: "1"
  });

  assert.equal(check.status, "unsupported");
  assert.match(check.detail, /\/proc\/self\/fd/);
  assert.match(check.detail, /link-target.*ENOENT|ENOENT.*link-target/);
  assert.deepEqual(readdirSync(home), []);
});

test("doctor classifies procfd descriptor traversal ENOENT and EACCES as unsupported", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-procfd-traversal-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-procfd-traversal-home-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  for (const code of ["ENOENT", "EACCES"]) {
    const checks = doctorChildChecks(home, {
      LD_PRELOAD: preload,
      TASKMUX_TEST_PROCFD_TRAVERSAL_ERROR: code
    });
    for (const name of ["taskmux home", "native storage"]) {
      const check = checks.find((candidate) => candidate.name === name);
      assert.equal(check.status, "unsupported", `${name}: ${code}`);
      assert.match(check.detail, /\/proc\/self\/fd/, `${name}: ${code}`);
      assert.match(check.detail, new RegExp(code), `${name}: ${code}`);
      assert.doesNotMatch(check.detail, /run taskmux setup/, `${name}: ${code}`);
    }
    assert.deepEqual(readdirSync(home), []);
  }
});

test("doctor treats other staged native ENOENT failures as invalid", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-staged-enoent-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-staged-enoent-home-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const check = doctorChildCheck(home, {
    LD_PRELOAD: preload,
    TASKMUX_TEST_DOCTOR_FAIL_STATX_ENOENT: "1"
  });

  assert.equal(check.status, "invalid");
  assert.match(check.detail, /stat-ancestor/);
  assert.doesNotMatch(check.detail, /run taskmux setup/);
  assert.deepEqual(readdirSync(home), []);
});

test("doctor rejects a mutable TASKMUX_HOME before a collision replacement can trigger probe cleanup", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-private-home-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-private-home-root-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  const foreignReplacement = join(home, "foreign-replacement");
  childProcessCompile(preload);
  chmodSync(home, 0o777);
  writeFileSync(foreignReplacement, "foreign\n");
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const check = doctorChildCheck(home, {
    LD_PRELOAD: preload,
    TASKMUX_TEST_DOCTOR_COLLIDE_MKDIR: "1"
  });

  assert.equal(check.status, "invalid");
  assert.match(check.detail, /owned real directory with exact mode 0700/);
  assert.deepEqual(readdirSync(home), ["foreign-replacement"]);
  assert.equal(statSync(home).mode & 0o7777, 0o777);
});

test("setup creates nested homes despite a restrictive umask and requires explicit repair for existing directories", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "taskmux-setup-private-home-"));
  const home = join(parent, "nested", "taskmux", "home");
  const arbitrary = join(parent, "arbitrary-existing");
  const existing = join(parent, "existing");
  const link = join(parent, "taskmux-home-link");
  const nestedLinkTarget = join(parent, "nested-link-target");
  const nestedLink = join(parent, "nested-link");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const { ensureTaskmuxHome, inspectTaskmuxHome } = await import(pathToFileURL(
    join(root, "dist", "storage", "taskStore.js")
  ).href);

  const originalUmask = process.umask(0o777);
  try {
    ensureTaskmuxHome(home);
  } finally {
    process.umask(originalUmask);
  }
  assert.equal(statSync(join(parent, "nested")).mode & 0o7777, 0o700);
  assert.equal(statSync(join(parent, "nested", "taskmux")).mode & 0o7777, 0o700);
  assert.equal(statSync(home).mode & 0o7777, 0o700);

  mkdirSync(arbitrary);
  chmodSync(arbitrary, 0o755);
  writeFileSync(join(arbitrary, "keep.txt"), "do not touch\n");
  assert.throws(
    () => ensureTaskmuxHome(arbitrary),
    /Refusing to change an existing directory automatically/
  );
  assert.equal(statSync(arbitrary).mode & 0o7777, 0o755);
  assert.equal(readFileSync(join(arbitrary, "keep.txt"), "utf8"), "do not touch\n");

  mkdirSync(existing);
  chmodSync(existing, 0o755);
  writeFileSync(
    join(existing, "schema.json"),
    `${JSON.stringify({ schemaVersion: 1, storageVersion: 4, updatedAt: "2026-07-14T00:00:00.000Z" })}\n`
  );
  writeFileSync(join(existing, "keep.txt"), "do not touch\n");

  const repairInspection = inspectTaskmuxHome(existing);
  assert.equal(repairInspection.status, "repair-required");
  ensureTaskmuxHome(existing, { repairExisting: repairInspection.identity });
  assert.equal(statSync(existing).mode & 0o7777, 0o700);
  assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), "do not touch\n");
  ensureTaskmuxHome(existing);

  symlinkSync(existing, link, "dir");
  assert.throws(
    () => ensureTaskmuxHome(link),
    /symbolic link/
  );
  assert.equal(statSync(existing).mode & 0o7777, 0o700);

  mkdirSync(nestedLinkTarget);
  symlinkSync(nestedLinkTarget, nestedLink, "dir");
  assert.throws(
    () => ensureTaskmuxHome(join(nestedLink, "home")),
    /symbolic link/
  );
  assert.equal(existsSync(join(nestedLinkTarget, "home")), false);
});

test("setup refuses a TASKMUX_HOME replacement after repair confirmation", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "taskmux-setup-repair-swap-"));
  const home = join(parent, "taskmux-home");
  const original = join(parent, "original-home");
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  mkdirSync(home);
  chmodSync(home, 0o755);
  writeFileSync(join(home, "original.txt"), "original\n");

  const { runSetupCommand } = await import(pathToFileURL(
    join(root, "dist", "setup", "setupCommand.js")
  ).href);
  let swapped = false;
  let outputText = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk);
      outputText += text;
      if (!swapped && text.includes("Tighten existing TASKMUX_HOME")) {
        renameSync(home, original);
        mkdirSync(home);
        chmodSync(home, 0o700);
        writeFileSync(join(home, "replacement.txt"), "replacement\n");
        swapped = true;
      }
      callback();
    }
  });
  const input = Readable.from(["yes\n"]);
  Object.defineProperty(input, "isTTY", { value: true });

  await assert.rejects(
    () => runSetupCommand(
      [],
      { TASKMUX_HOME: home },
      { run: () => "tmux 3.4\n" },
      {
        input,
        output,
        forceInteractive: true
      }
    ),
    /TASKMUX_HOME changed after repair confirmation/
  );

  assert.equal(swapped, true);
  assert.match(outputText, /Tighten existing TASKMUX_HOME to mode 0700\? \[y\/N\]: /);
  assert.equal(statSync(original).mode & 0o7777, 0o755);
  assert.equal(statSync(home).mode & 0o7777, 0o700);
  assert.equal(readFileSync(join(original, "original.txt"), "utf8"), "original\n");
  assert.equal(readFileSync(join(home, "replacement.txt"), "utf8"), "replacement\n");
  assert.equal(existsSync(join(original, "schema.json")), false);
  assert.equal(existsSync(join(home, "schema.json")), false);
});

test("default home resolution ignores HOME while an explicit isolated home remains allowed", (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "taskmux-setup-spoofed-home-"));
  const explicitHome = join(fakeHome, "isolated-taskmux-home");
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const childEnv = {
    ...process.env,
    HOME: fakeHome,
    TASKMUX_TEST_EXPLICIT_HOME: explicitHome
  };
  delete childEnv.TASKMUX_HOME;
  const taskStoreModule = new URL("../dist/storage/taskStore.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { ensureTaskmuxHome, resolveTaskmuxHome } from ${JSON.stringify(taskStoreModule)};
        const defaultHome = resolveTaskmuxHome(process.env);
        const explicitHome = resolveTaskmuxHome({
          ...process.env,
          TASKMUX_HOME: process.env.TASKMUX_TEST_EXPLICIT_HOME
        });
        ensureTaskmuxHome(explicitHome);
        process.stdout.write(JSON.stringify({ defaultHome, explicitHome }));
      `
    ],
    { cwd: root, encoding: "utf8", env: childEnv }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    defaultHome: join(realpathSync(userInfo().homedir), ".taskmux"),
    explicitHome: resolve(explicitHome)
  });
  assert.equal(statSync(explicitHome).mode & 0o7777, 0o700);
});

test("setup rejects the trusted account home despite HOME spoofing or lexical aliases", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "taskmux-setup-account-home-spoof-"));
  const accountHome = resolve(userInfo().homedir);
  const before = statSync(accountHome);
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));

  for (const candidate of [accountHome, `${accountHome}/.`]) {
    const result = inspectTaskmuxHomeInChild(candidate, { HOME: fakeHome });
    assert.match(result.error, /must not be the current user's home directory/);
  }

  const after = statSync(accountHome);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
});

test("setup rejects lexical filesystem-root aliases without mutation", async () => {
  const { ensureTaskmuxHome } = await import(pathToFileURL(
    join(root, "dist", "storage", "taskStore.js")
  ).href);
  const before = statSync("/");
  for (const candidate of ["/", "/.", "//", "/tmp/../"]) {
    assert.throws(
      () => ensureTaskmuxHome(candidate),
      /must not be the filesystem root/
    );
  }
  const after = statSync("/");
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
});

test("setup rejects a mounted alias to the exact filesystem-root inode when available", (t) => {
  const rootIdentity = statSync("/");
  const alias = readFileSync("/proc/self/mountinfo", "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeMountInfoPath(line.split(" - ")[0].split(" ")[4] ?? ""))
    .find((candidate) => {
      if (candidate.length === 0 || resolve(candidate) === "/") return false;
      try {
        if (lstatSync(candidate).isSymbolicLink()) return false;
        const identity = statSync(candidate);
        return identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino;
      } catch {
        return false;
      }
    });
  if (alias === undefined) {
    t.skip("no non-symlink mounted alias to the filesystem-root inode is available");
    return;
  }

  const result = inspectTaskmuxHomeInChild(alias);
  assert.match(result.error, /must not be the filesystem root/);
  const after = statSync("/");
  assert.equal(after.dev, rootIdentity.dev);
  assert.equal(after.ino, rootIdentity.ino);
  assert.equal(after.mode, rootIdentity.mode);
});

test("setup refuses root-identity permission repair before mutation", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-root-identity-fixture-"));
  const home = join(fixtureRoot, "root-alias");
  const preload = join(fixtureRoot, "unlink-pause.so");
  mkdirSync(home);
  chmodSync(home, 0o755);
  writeFileSync(join(home, "keep.txt"), "do not touch\n");
  childProcessCompile(preload);
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const taskStoreModule = new URL("../dist/storage/taskStore.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { ensureTaskmuxHome, inspectTaskmuxHome } from ${JSON.stringify(taskStoreModule)};
        try {
          const inspection = inspectTaskmuxHome(process.env.TASKMUX_HOME);
          if (inspection.status !== "repair-required") {
            throw new Error(\`expected repair-required, received \${inspection.status}\`);
          }
          ensureTaskmuxHome(process.env.TASKMUX_HOME, { repairExisting: inspection.identity });
          process.stdout.write(JSON.stringify({ status: "accepted" }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ error: String(error.message) }));
        }
      `
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LD_PRELOAD: preload,
        TASKMUX_HOME: home,
        TASKMUX_TEST_ROOT_IDENTITY_PATH: home
      }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).error, /must not be the filesystem root/);
  assert.equal(statSync(home).mode & 0o7777, 0o755);
  assert.equal(readFileSync(join(home, "keep.txt"), "utf8"), "do not touch\n");
  assert.equal(existsSync(join(home, "schema.json")), false);
});

function decodeMountInfoPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, digits) =>
    String.fromCharCode(Number.parseInt(digits, 8))
  );
}

test("setup rejects an alternate path to the exact trusted account-home inode", (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "taskmux-setup-account-home-alias-"));
  const accountHome = resolve(userInfo().homedir);
  const accountIdentity = statSync(accountHome);
  const alias = [`/data00${accountHome}`].find((candidate) => {
    if (!existsSync(candidate) || resolve(candidate) === accountHome) return false;
    const candidateIdentity = statSync(candidate);
    return candidateIdentity.dev === accountIdentity.dev &&
      candidateIdentity.ino === accountIdentity.ino;
  });
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  if (alias === undefined) {
    t.skip("no alternate lexical path to the account-home inode is available");
    return;
  }

  const result = inspectTaskmuxHomeInChild(alias, { HOME: fakeHome });
  assert.match(result.error, /must not be the current user's home directory/);
  const after = statSync(accountHome);
  assert.equal(after.dev, accountIdentity.dev);
  assert.equal(after.ino, accountIdentity.ino);
  assert.equal(after.mode, accountIdentity.mode);
});

test("runtime storage checks reject unsafe existing homes without mutating them", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-runtime-unsafe-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(
    join(home, "schema.json"),
    `${JSON.stringify({ schemaVersion: 1, storageVersion: 4, updatedAt: "2026-07-14T00:00:00.000Z" })}\n`
  );
  writeFileSync(join(home, "keep.txt"), "unchanged\n");
  chmodSync(home, 0o755);
  const { requireStorageSchema } = await import(pathToFileURL(
    join(root, "dist", "storage", "storageSchema.js")
  ).href);

  assert.throws(
    () => requireStorageSchema(home),
    /owned real directory with exact mode 0700/
  );
  assert.equal(statSync(home).mode & 0o7777, 0o755);
  assert.equal(readFileSync(join(home, "keep.txt"), "utf8"), "unchanged\n");
});

test("setup rejects a foreign-owned TASKMUX_HOME", async (t) => {
  if (process.geteuid?.() !== 0) {
    t.skip("requires a root test process to create a foreign-owned directory");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "taskmux-foreign-owned-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { ensureTaskmuxHome } = await import(pathToFileURL(
    join(root, "dist", "storage", "taskStore.js")
  ).href);

  chownSync(home, 65534, 65534);
  assert.throws(
    () => ensureTaskmuxHome(home),
    /owned real directory with exact mode 0700/
  );
});

test("doctor removes a post-create probe directory and keeps the primary error over cleanup failure", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-failure-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-failure-home-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  for (const failCleanup of [false, true]) {
    const check = JSON.parse(execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", doctorChildScript(home)],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          LD_PRELOAD: preload,
          TASKMUX_TEST_DOCTOR_FAIL_FIRST_FSYNC: "1",
          ...(failCleanup ? { TASKMUX_TEST_DOCTOR_FAIL_PROBE_RMDIR: "1" } : {})
        }
      }
    ));

    assert.equal(check.status, "invalid");
    assert.match(check.detail, /External publication failed at fsync-parent \(published-not-durable\)/);
    if (failCleanup) {
      assert.equal(readdirSync(home).length, 1);
      rmSync(join(home, readdirSync(home)[0]), { recursive: true, force: true });
    } else {
      assert.deepEqual(readdirSync(home), []);
    }
  }
});

test("doctor never removes a conflicting probe-directory candidate", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-collision-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-collision-home-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const check = JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", doctorChildScript(home)],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LD_PRELOAD: preload,
        TASKMUX_TEST_DOCTOR_COLLIDE_MKDIR: "1"
      }
    }
  ));

  assert.equal(check.status, "invalid");
  assert.match(check.detail, /External publication failed at mkdir-target \(conflict\)/);
  const remaining = readdirSync(home);
  assert.equal(remaining.length, 1);
  assert.match(remaining[0], /^\.taskmux-doctor-native-storage-/);
});

test("doctor fsyncs the root descriptor after probe cleanup", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-fsync-"));
  const home = mkdtempSync(join(tmpdir(), "taskmux-doctor-native-storage-fsync-home-"));
  const preload = join(fixtureRoot, "unlink-pause.so");
  childProcessCompile(preload);
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const check = JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", doctorChildScript(home)],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LD_PRELOAD: preload,
        TASKMUX_TEST_DOCTOR_FAIL_ROOT_FSYNC_AFTER_CLEANUP: "1"
      }
    }
  ));

  assert.equal(check.status, "invalid");
  assert.match(check.detail, /\bfsync\b/i);
  assert.deepEqual(readdirSync(home), []);
});

function doctorChildScript(home) {
  return `
    import { getDoctorChecks } from ${JSON.stringify(
      new URL("../dist/doctor/doctor.js", import.meta.url).href
    )};
    process.stdout.write(JSON.stringify(getDoctorChecks(
      { TASKMUX_HOME: ${JSON.stringify(home)} },
      { run: () => "tmux 3.4\\\\n" }
    ).find((check) => check.name === "native storage")));
  `;
}

function doctorChildCheck(home, env) {
  return JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", doctorChildScript(home)],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env }
    }
  ));
}

function doctorChildChecks(home, env) {
  const doctorModule = new URL("../dist/doctor/doctor.js", import.meta.url).href;
  return JSON.parse(execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { getDoctorChecks } from ${JSON.stringify(doctorModule)};
        process.stdout.write(JSON.stringify(getDoctorChecks(
          { TASKMUX_HOME: ${JSON.stringify(home)} },
          { run: () => "tmux 3.4\\n" }
        ).filter((check) => check.name === "taskmux home" || check.name === "native storage")));
      `
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env }
    }
  ));
}

function inspectTaskmuxHomeInChild(home, env = {}) {
  const taskStoreModule = new URL("../dist/storage/taskStore.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { inspectTaskmuxHome } from ${JSON.stringify(taskStoreModule)};
        try {
          const inspection = inspectTaskmuxHome(process.env.TASKMUX_HOME);
          process.stdout.write(JSON.stringify({ status: inspection.status }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ error: String(error.message) }));
        }
      `
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env, TASKMUX_HOME: home }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function sharedBarrierContenderScript(home) {
  return `
    import { closeSync, constants, fstatSync, openSync } from "node:fs";
    import {
      acquireStableAncestorSharedBarrier,
      releaseStableAncestorBarrier
    } from ${JSON.stringify(new URL("../dist/storage/nativeStorageFs.js", import.meta.url).href)};
    const descriptor = openSync(${JSON.stringify(home)},
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor, { bigint: true });
    try {
      const barrier = acquireStableAncestorSharedBarrier(descriptor, {
        dev: identity.dev,
        ino: identity.ino,
        uid: identity.uid,
        mode: identity.mode,
        nlink: identity.nlink,
        birthtimeNs: identity.birthtimeNs
      });
      releaseStableAncestorBarrier(barrier);
      process.stdout.write("acquired");
    } catch (error) {
      process.stdout.write(String(error.code));
    } finally {
      closeSync(descriptor);
    }
  `;
}

function childProcessCompile(output) {
  execFileSync("cc", [
    "-shared",
    "-fPIC",
    "-o",
    output,
    join(root, "test", "fixtures", "unlink-pause.c"),
    "-ldl"
  ]);
}

async function waitForPath(path) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for native doctor probe cleanup: ${path}`);
    }
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
