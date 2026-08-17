import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  createSessionOwnerIdentity,
  discoverProviderRootByLaunchEnv,
  isLinuxProcessLive,
  listOwnedProcessTree,
  readLinuxProcessIdentity
} from "../../dist/runtime/sessionOwnerIdentity.js";

const isLinux = process.platform === "linux";

test("createSessionOwnerIdentity validates and freezes an owner record", () => {
  const record = createSessionOwnerIdentity({
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "agent-1",
    adapterId: "codex",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    tmux: {
      serverName: "yui-server",
      socketPath: "/tmp/tmux-1000/yui-server",
      sessionName: "yui-abc-task-1",
      windowName: "leader",
      panePid: 1234
    },
    providerRoot: {
      pid: 1234,
      startIdentity: "1000",
      processGroupId: 1234,
      processSessionId: 1234,
      attribution: "launch-env"
    },
    recordedAt: new Date("2026-08-17T00:00:00.000Z")
  });
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, "yui-session-owner");
  assert.equal(record.providerRoot.pid, 1234);
  assert.throws(() => {
    createSessionOwnerIdentity({
      ...record,
      recordedAt: new Date("2026-08-17T00:00:00.000Z"),
      providerRoot: { ...record.providerRoot, pid: 0 }
    });
  }, /pid is invalid/);
  assert.throws(() => {
    createSessionOwnerIdentity({
      ...record,
      recordedAt: new Date("2026-08-17T00:00:00.000Z"),
      providerRoot: { ...record.providerRoot, startIdentity: "not-a-number" }
    });
  }, /start identity is invalid/);
});

test("createSessionOwnerIdentity rejects a task owner without a task id", () => {
  assert.throws(() => createSessionOwnerIdentity({
    owner: { scope: "task", roleName: "leader" },
    agentId: "agent-1",
    adapterId: "codex",
    launchId: "launch-1",
    tmux: {
      serverName: "yui-server",
      socketPath: "/tmp/tmux-1000/yui-server",
      sessionName: "yui-abc-operator",
      windowName: "leader"
    },
    providerRoot: {
      pid: 1234,
      startIdentity: "1000",
      attribution: "launch-env"
    },
    recordedAt: new Date("2026-08-17T00:00:00.000Z")
  }), /requires a task id/);
});

test("readLinuxProcessIdentity reads the test process itself", { skip: !isLinux }, () => {
  const identity = readLinuxProcessIdentity(process.pid);
  assert.ok(identity);
  assert.equal(identity.pid, process.pid);
  assert.match(identity.startIdentity, /^[0-9]{1,32}$/u);
  assert.ok(identity.processGroupId === undefined || identity.processGroupId > 0);
  assert.ok(identity.rssBytes >= 0);
});

test("isLinuxProcessLive pairs PID with start identity (PID reuse)", { skip: !isLinux }, () => {
  const identity = readLinuxProcessIdentity(process.pid);
  assert.ok(identity);
  assert.equal(isLinuxProcessLive(process.pid, identity.startIdentity), true);
  // A different start identity means the PID was reused: never live.
  assert.equal(isLinuxProcessLive(process.pid, "999999999"), false);
  assert.equal(isLinuxProcessLive(999999, identity.startIdentity), false);
});

test("discoverProviderRootByLaunchEnv finds the exact launch fence", { skip: !isLinux }, async () => {
  const launchId = `test-launch-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 2 ** 30);"
  ], {
    env: { ...process.env, YUI_LAUNCH_ID: launchId },
    stdio: "ignore"
  });
  try {
    await waitForProcess(child.pid);
    const found = discoverProviderRootByLaunchEnv(launchId);
    assert.ok(found);
    assert.equal(found.pid, child.pid);
    assert.match(found.identity.startIdentity, /^[0-9]{1,32}$/u);
    // A forged/unknown launch id must not attribute any process.
    assert.equal(discoverProviderRootByLaunchEnv("definitely-not-a-real-launch"), undefined);
  } finally {
    child.kill("SIGKILL");
  }
});

test("listOwnedProcessTree includes the root and its descendants", { skip: !isLinux }, async () => {
  const child = spawn(process.execPath, [
    "-e",
    `
    const { fork } = require("node:child_process");
    const grandchild = fork("-e", ["setInterval(() => {}, 2 ** 30);"], {
      env: { ...process.env, YUI_LAUNCH_ID: "tree-test" },
      stdio: "ignore"
    });
    setInterval(() => {}, 2 ** 30);
    `
  ], {
    env: { ...process.env, YUI_LAUNCH_ID: "tree-test" },
    stdio: "ignore"
  });
  try {
    await waitForProcess(child.pid);
    // Give the grandchild a moment to spawn.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const identity = readLinuxProcessIdentity(child.pid);
    assert.ok(identity);
    const tree = listOwnedProcessTree(child.pid, identity.processGroupId);
    const pids = tree.map((process) => process.pid);
    assert.ok(pids.includes(child.pid), "root must be in its own tree");
    assert.ok(pids.length >= 2, `tree should include the grandchild; got ${pids.join(",")}`);
  } finally {
    child.kill("SIGKILL");
  }
});

function waitForProcess(pid, timeoutMs = 2_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (readLinuxProcessIdentity(pid) !== undefined) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Process ${pid} did not appear in /proc within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}
