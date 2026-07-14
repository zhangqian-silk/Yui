import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(readme.includes("O_TMPFILE"), true);
    assert.equal(readme.includes("/proc/self/fd"), true);
    assert.equal(readme.includes("linkat"), true);
    assert.equal(readme.includes("AT_EMPTY_PATH"), false);
    assert.equal(readme.includes("ENOTSUP") && readme.includes("EOPNOTSUPP"), true);
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
  assert.equal(english.includes("Linux kernel 5.6 or newer"), true);
  assert.equal(
    chinese.includes("Node.js 20.17+（20.x）、22.9+（22.x）或 24.x"),
    true
  );
  assert.equal(chinese.includes("Linux 内核 5.6 或更高版本"), true);
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
      detail: `openat2 + O_TMPFILE + /proc/self/fd linkat verified for ${home}`
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

  for (const phase of ["file", "directory"]) {
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
