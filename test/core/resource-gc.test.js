import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createResourceRecord,
  isReleasable,
  isReleaseNamespacePath,
  isTerminalTaskStatus,
  resourceId
} from "../../dist/resources/resourceTypes.js";
import {
  emptyResourceRegistry,
  loadResourceRegistry,
  removeResourceRecord,
  resourceRegistryPath,
  saveResourceRegistry,
  upsertResourceRecord
} from "../../dist/resources/resourceRegistry.js";
import {
  createResourceRegistryStore,
  FileResourceRegistryStore
} from "../../dist/resources/resourceRegistryStore.js";
import { SqliteResourceRegistry } from "../../dist/resources/sqliteResourceRegistry.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import Database from "better-sqlite3";
import {
  parseGitWorktreePorcelain,
  extractTaskIdFromPath,
  discoverResources
} from "../../dist/resources/resourceDiscovery.js";
import {
  readControllerDiscovery,
  scanLiveReferences,
  scanProcessPathRefs
} from "../../dist/resources/liveReferences.js";
import { readLinuxProcessStartIdentity } from "../../dist/controller/domainIdentity.js";
import { createProject } from "../../dist/repository/project.js";
import { writeRuntimeIdentity } from "../../dist/release/runtimeRelease.js";
import {
  createExactTaskRuntimeDescriptor,
  exactTaskRuntimeDescriptorPath,
  serializeExactDescriptor
} from "../../dist/runtime/exactControlPlane.js";

const now = new Date("2026-08-17T00:00:00.000Z");

test("resourceId is stable for the same kind+path", () => {
  const a = resourceId("worktree", "/tmp/foo");
  const b = resourceId("worktree", "/tmp/foo");
  const c = resourceId("deployment", "/tmp/foo");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("isTerminalTaskStatus recognizes terminal states", () => {
  assert.equal(isTerminalTaskStatus("completed"), true);
  assert.equal(isTerminalTaskStatus("retired"), true);
  assert.equal(isTerminalTaskStatus("archived"), true);
  assert.equal(isTerminalTaskStatus("active"), false);
  assert.equal(isTerminalTaskStatus("draft"), false);
  assert.equal(isTerminalTaskStatus(undefined), false);
});

test("isReleaseNamespacePath excludes runtime/releases", () => {
  const home = "/tmp/yui-home";
  assert.equal(isReleaseNamespacePath(home, join(home, "runtime/releases/foo")), true);
  assert.equal(isReleaseNamespacePath(home, join(home, "runtime/releases")), true);
  assert.equal(isReleaseNamespacePath(home, join(home, "runtime/deployments/foo")), false);
  assert.equal(isReleaseNamespacePath(home, join(home, "runtime/exact-task-runtime/x.json")), false);
});

test("isReleasable requires no refs and clean state", () => {
  const base = {
    kind: "worktree",
    path: "/tmp/wt",
    owner: { home: "/tmp/yui-home", taskId: "task-1", basis: "durable-record" },
    cleanliness: "clean",
    activeRefs: [],
    disposition: "releasable",
    updatedAt: now.toISOString()
  };
  assert.equal(isReleasable(createResourceRecord(base, now)), true);
  assert.equal(isReleasable(createResourceRecord({
    ...base,
    activeRefs: ["proc:cwd:123"]
  }, now)), false);
  assert.equal(isReleasable(createResourceRecord({
    ...base,
    cleanliness: "dirty"
  }, now)), false);
  assert.equal(isReleasable(createResourceRecord({
    ...base,
    disposition: "active"
  }, now)), false);
});

test("registry save/load round-trips records", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-resource-registry-"));
  try {
    const record = createResourceRecord({
      kind: "worktree",
      path: "/tmp/wt",
      owner: { home, taskId: "task-1", basis: "durable-record" },
      cleanliness: "clean",
      activeRefs: [],
      disposition: "releasable"
    }, now);
    let state = emptyResourceRegistry();
    state = upsertResourceRecord(state, record);
    saveResourceRegistry(home, state);
    assert.ok(existsSync(resourceRegistryPath(home)));
    const loaded = loadResourceRegistry(home);
    assert.equal(loaded.records[record.id]?.path, "/tmp/wt");
    assert.equal(loaded.records[record.id]?.disposition, "releasable");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("registry upsert and remove", () => {
  const record = createResourceRecord({
    kind: "deployment",
    path: "/tmp/dep",
    owner: { home: "/tmp/yui-home", basis: "unattributed" },
    cleanliness: "n/a",
    activeRefs: [],
    disposition: "retained-unowned"
  }, now);
  let state = upsertResourceRecord(emptyResourceRegistry(), record);
  assert.ok(state.records[record.id] !== undefined);
  state = removeResourceRecord(state, record.id);
  assert.ok(state.records[record.id] === undefined);
  // Removing a missing record is a no-op.
  assert.equal(removeResourceRecord(state, record.id), state);
});

test("registry load fails closed on corrupt file", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-resource-registry-corrupt-"));
  try {
    mkdirSync(join(home, "runtime", "resource-registry"), { recursive: true });
    writeFileSync(resourceRegistryPath(home), "not json", "utf8");
    assert.throws(() => loadResourceRegistry(home), /corrupt or unreadable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("parseGitWorktreePorcelain parses worktree list output", () => {
  const output = [
    "worktree /repo/main",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/wt-task-1",
    "HEAD def456",
    "branch refs/heads/yui/task-1-abcdef12/main",
    "",
    "worktree /repo/detached",
    "HEAD 789",
    "detached",
    "",
    "worktree /repo/prunable",
    "HEAD 000",
    "prunable gitdir file points to non-existent location"
  ].join("\n");
  const entries = parseGitWorktreePorcelain(output);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].path, "/repo/main");
  assert.equal(entries[0].branch, "refs/heads/main");
  assert.equal(entries[1].path, "/repo/wt-task-1");
  assert.equal(entries[1].branch, "refs/heads/yui/task-1-abcdef12/main");
  assert.equal(entries[2].detached, true);
  assert.equal(entries[3].prunable, true);
});

test("extractTaskIdFromPath finds task-N segments", () => {
  assert.equal(extractTaskIdFromPath("/workspace/yui/task-1/main"), "task-1");
  assert.equal(extractTaskIdFromPath("/workspace/yui/task-1-abcdef12/main"), "task-1");
  assert.equal(extractTaskIdFromPath("combined-task18-4ceb44a-20260814T1415"), "task-18");
  assert.equal(extractTaskIdFromPath("/tmp/random-worktree"), undefined);
});

test("scanProcessPathRefs finds cwd references", () => {
  // Create a directory and spawn a child process with cwd inside it.
  const root = mkdtempSync(join(tmpdir(), "yui-proc-ref-"));
  const child = join(root, "child");
  mkdirSync(child, { recursive: true });
  try {
    // Use a short-lived sleep with cwd in the target directory.
    const proc = spawnSync("sleep", ["0.1"], { cwd: child, timeout: 5_000 });
    assert.equal(proc.status, 0);
    // The process exited; no refs should remain.
    const { refs } = scanProcessPathRefs([child]);
    assert.equal(refs.get(child)?.length ?? 0, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanProcessPathRefs detects live cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-proc-live-"));
  const child = join(root, "live-cwd");
  mkdirSync(child, { recursive: true });
  try {
    const proc = spawn("sleep", ["30"], { cwd: child, detached: true });
    // Give the process a moment to start.
    const deadline = Date.now() + 2_000;
    let found = false;
    while (Date.now() < deadline) {
      const { refs } = scanProcessPathRefs([child]);
      if ((refs.get(child)?.length ?? 0) > 0) {
        found = true;
        break;
      }
      // Busy-wait a tiny bit.
      const end = Date.now() + 50;
      while (Date.now() < end) {}
    }
    proc.kill("SIGKILL");
    assert.ok(found, "expected a live cwd reference from the spawned process");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Controller discovery fails closed when PID identity cannot be proven", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-identity-"));
  try {
    const controllerPath = join(home, "runtime", "controller.json");
    mkdirSync(dirname(controllerPath), { recursive: true, mode: 0o700 });
    writeFileSync(controllerPath, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
    let discovery = readControllerDiscovery(home);
    assert.equal(discovery.protects, false);
    assert.equal(discovery.diagnostic?.severity, "error");
    assert.match(discovery.diagnostic?.message ?? "", /processStartIdentity/);

    writeFileSync(controllerPath, `${JSON.stringify({
      pid: process.pid,
      processStartIdentity: "definitely-not-current"
    })}\n`, "utf8");
    discovery = readControllerDiscovery(home);
    assert.equal(discovery.protects, false);
    assert.equal(discovery.diagnostic?.severity, "error");
    assert.match(discovery.diagnostic?.message ?? "", /identity mismatch/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("live scan protects runtime identity resolved paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-runtime-identity-refs-"));
  try {
    const home = join(root, "home");
    const deployment = join(root, "deployment");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(deployment, { recursive: true });
    writeRuntimeIdentity(home, {
      schemaVersion: 1,
      version: "0.0.0",
      executablePath: process.execPath,
      args: [process.execPath, "controller"],
      buildId: "dev",
      packageDigest: null,
      sourceCommit: null,
      cliRealpath: deployment,
      controllerRealpath: deployment,
      controllerProtocolVersion: 1,
      storageLayoutVersion: 7,
      aggregateSchemaVersion: 18,
      storageBackend: "file",
      workerEnabled: false,
      pid: process.pid,
      processStartIdentity: readLinuxProcessStartIdentity(process.pid) ?? "missing",
      mode: "primary",
      dualOwner: false,
      activeRelease: null,
      writtenAt: now.toISOString()
    });
    const scan = await scanLiveReferences({
      home,
      paths: [deployment],
      ports: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    assert.ok((scan.refsByPath.get(deployment)?.length ?? 0) > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live scan protects exact Task descriptor workspaces and fails on malformed descriptors", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-exact-descriptor-refs-"));
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true });
    const descriptor = createExactTaskRuntimeDescriptor({
      controlPlaneDigest: "a".repeat(64),
      taskId: "task-1",
      roleName: "worker",
      agentId: "agent-1",
      adapterId: "codex",
      workspace
    });
    const descriptorPath = exactTaskRuntimeDescriptorPath(home, descriptor);
    mkdirSync(dirname(descriptorPath), { recursive: true, mode: 0o700 });
    writeFileSync(descriptorPath, `${serializeExactDescriptor(descriptor)}\n`, "utf8");
    const scan = await scanLiveReferences({
      home,
      paths: [workspace, descriptorPath],
      ports: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    assert.ok((scan.refsByPath.get(workspace)?.length ?? 0) > 0);
    assert.ok((scan.refsByPath.get(descriptorPath)?.length ?? 0) > 0);

    writeFileSync(join(dirname(descriptorPath), "malformed.json"), "{not-json", "utf8");
    const malformed = await scanLiveReferences({
      home,
      paths: [workspace],
      ports: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live scan fails closed on an unreadable active release pointer", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-active-release-corrupt-"));
  try {
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "runtime", "active-release.json"), "{not-json", "utf8");
    const scan = await scanLiveReferences({
      home,
      paths: [join(home, "runtime", "deployments", "legacy")],
      ports: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    assert.ok(
      scan.diagnostics.some((diagnostic) =>
        diagnostic.severity === "error"
          && diagnostic.message.includes("active release is unreadable")),
      "an unreadable active release pointer must fail closed with an error diagnostic"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("live scan protects a live Session owner runtime root", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-session-owner-live-"));
  try {
    const runtimeRoot = join(home, "runtime", "task-runtimes", "task-1", "owner", "launch");
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const ownerDirectory = join(home, "runtime", "session-owners");
    mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(ownerDirectory, "launch-1.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "yui-session-owner",
      owner: { scope: "task", taskId: "task-1", roleName: "worker" },
      agentId: "agent-1",
      adapterId: "codex",
      launchId: "launch-1",
      tmux: {
        serverName: "yui-test",
        socketPath: "/tmp/yui-test.sock",
        sessionName: "task-1",
        windowName: "task-1"
      },
      providerRoot: {
        pid: process.pid,
        startIdentity: readLinuxProcessStartIdentity(process.pid) ?? "missing",
        attribution: "launch-env"
      },
      runtimeRoot,
      recordedAt: now.toISOString()
    })}\n`, "utf8");
    const scan = await scanLiveReferences({
      home,
      paths: [runtimeRoot],
      ports: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    assert.ok((scan.refsByPath.get(runtimeRoot)?.length ?? 0) > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("live scan ignores a dead Session owner but fails closed on identity conflict", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-session-owner-dead-"));
  try {
    const runtimeRoot = join(home, "runtime", "task-runtimes", "task-1", "owner", "launch");
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const ownerDirectory = join(home, "runtime", "session-owners");
    mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
    // A dead PID: no protection, no diagnostic.
    writeFileSync(join(ownerDirectory, "dead.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "yui-session-owner",
      owner: { scope: "task", taskId: "task-1", roleName: "worker" },
      agentId: "agent-1",
      adapterId: "codex",
      launchId: "dead",
      tmux: {
        serverName: "yui-test",
        socketPath: "/tmp/yui-test.sock",
        sessionName: "task-1",
        windowName: "task-1"
      },
      providerRoot: { pid: 999999, startIdentity: "1", attribution: "launch-env" },
      runtimeRoot,
      recordedAt: now.toISOString()
    })}\n`, "utf8");
    // An alive PID with a mismatched start identity: error diagnostic.
    writeFileSync(join(ownerDirectory, "conflict.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "yui-session-owner",
      owner: { scope: "task", taskId: "task-2", roleName: "worker" },
      agentId: "agent-2",
      adapterId: "codex",
      launchId: "conflict",
      tmux: {
        serverName: "yui-test",
        socketPath: "/tmp/yui-test.sock",
        sessionName: "task-2",
        windowName: "task-2"
      },
      providerRoot: {
        pid: process.pid,
        startIdentity: "definitely-not-current",
        attribution: "launch-env"
      },
      runtimeRoot,
      recordedAt: now.toISOString()
    })}\n`, "utf8");
    const scan = await scanLiveReferences({
      home,
      paths: [runtimeRoot],
      ports: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    assert.deepEqual(scan.refsByPath.get(runtimeRoot) ?? [], []);
    assert.ok(scan.diagnostics.some((diagnostic) =>
      diagnostic.severity === "error"
        && diagnostic.message.includes("start identity mismatch")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("live scan fails closed on an unreadable Session owner record", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-session-owner-corrupt-"));
  try {
    const ownerDirectory = join(home, "runtime", "session-owners");
    mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(ownerDirectory, "malformed.json"), "{not-json", "utf8");
    const scan = await scanLiveReferences({
      home,
      paths: [join(home, "runtime", "deployments", "legacy")],
      ports: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    assert.ok(scan.diagnostics.some((diagnostic) =>
      diagnostic.severity === "error"
        && diagnostic.message.includes("session owner record is unreadable")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resource discovery fails closed when Git worktree enumeration fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-discovery-git-fail-"));
  try {
    const home = join(root, "home");
    const repository = join(root, "not-a-repository");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(repository, { recursive: true });
    const project = createProject("project-1", "Test", repository, {
      stable: "main",
      development: "main"
    }, now, { ownership: "external" });
    await assert.rejects(
      discoverResources({
        home,
        projects: [project],
        managedWorkspaces: [],
        taskStatusById: new Map(),
        now
      }),
      /Failed to list Git worktrees/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite resource registry round-trips records", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-gc-sqlite-"));
  try {
    // Create and migrate a yui.db so the resource_registry table exists.
    const db = new Database(join(home, "yui.db"));
    migrateSqliteSchema(db);
    db.close();

    const store = new SqliteResourceRegistry(home);
    const record = createResourceRecord({
      kind: "deployment",
      path: join(home, "runtime", "deployments", "combined-test"),
      owner: { home, taskId: "task-1", basis: "naming-convention" },
      sizeBytes: 1024,
      cleanliness: "n/a",
      activeRefs: [],
      disposition: "quarantined"
    }, now);

    const state = upsertResourceRecord(emptyResourceRegistry(), record);
    store.save(state);

    const loaded = store.load();
    assert.equal(loaded.schemaVersion, 1);
    assert.ok(loaded.records[record.id], "expected the record to be loaded");
    assert.equal(loaded.records[record.id].disposition, "quarantined");
    store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("SQLite resource registry removes records that disappeared from state", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-gc-sqlite-rm-"));
  try {
    const db = new Database(join(home, "yui.db"));
    migrateSqliteSchema(db);
    db.close();

    const store = new SqliteResourceRegistry(home);
    const record = createResourceRecord({
      kind: "runtime-artifact",
      path: join(home, "runtime", "exact-task-runtime", "abc.json"),
      owner: { home, taskId: "task-2", basis: "descriptor" },
      sizeBytes: 512,
      cleanliness: "n/a",
      activeRefs: [],
      disposition: "releasable"
    }, now);

    // Save with the record.
    store.save(upsertResourceRecord(emptyResourceRegistry(), record));
    assert.ok(store.load().records[record.id]);

    // Save without the record — the row should be deleted.
    store.save(emptyResourceRegistry());
    assert.equal(Object.keys(store.load().records).length, 0);
    store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("createResourceRegistryStore selects SQLite when yui.db exists", () => {
  const sqliteHome = mkdtempSync(join(tmpdir(), "yui-gc-factory-sqlite-"));
  const fileHome = mkdtempSync(join(tmpdir(), "yui-gc-factory-file-"));
  try {
    const db = new Database(join(sqliteHome, "yui.db"));
    migrateSqliteSchema(db);
    db.close();

    const sqliteStore = createResourceRegistryStore(sqliteHome);
    assert.ok(sqliteStore instanceof SqliteResourceRegistry);
    sqliteStore.close();

    const fileStore = createResourceRegistryStore(fileHome);
    assert.ok(fileStore instanceof FileResourceRegistryStore);
    fileStore.close();
  } finally {
    rmSync(sqliteHome, { recursive: true, force: true });
    rmSync(fileHome, { recursive: true, force: true });
  }
});
