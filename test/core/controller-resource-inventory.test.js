import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildControllerResourceInventory,
  createRuntimeResourceActivityTracker
} from "../../dist/controller/resourceInventory.js";
import {
  classifyRuntimeProcess,
  forEachInEventLoopBatches,
  INVENTORY_EVENT_LOOP_TURN_BUDGET_MS,
  linuxProcessEntryPid,
  parseLinuxProcessStat,
  scanControllerResourceInventory
} from "../../dist/controller/resourceInventoryLinux.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { openCompatibleFileTaskStore } from "../../dist/storage/compatibleTaskStore.js";
import { MigrationRegistry } from "../../dist/storage/migration/index.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
import { NodeCommandExecutor } from "../../dist/tmux/commandExecutor.js";
import {
  TmuxManager,
  yuiTmuxServerName
} from "../../dist/tmux/tmuxManager.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createAgentRun,
  recordRoleAgentSession
} from "../helpers/effectiveLaunch.js";

const HOME = "/tmp/yui-inventory-home";
const NOW = "2026-07-28T00:00:00.000Z";

test("Linux process inventory accepts only numeric /proc entry names", () => {
  assert.equal(linuxProcessEntryPid("self"), undefined);
  assert.equal(linuxProcessEntryPid("4916 (deleted)"), undefined);
  assert.equal(linuxProcessEntryPid("0"), undefined);
  assert.equal(linuxProcessEntryPid("42"), 42);
});

test("Linux process inventory yields between bounded entry batches", async () => {
  let socketCallbackRan = false;
  let callbackObservedBySecondBatch = false;
  const visited = [];
  setImmediate(() => { socketCallbackRan = true; });

  await forEachInEventLoopBatches(
    Array.from({ length: 65 }, (_, index) => index),
    64,
    (_entry, index) => {
      visited.push(index);
      if (index === 64) callbackObservedBySecondBatch = socketCallbackRan;
    }
  );

  assert.equal(callbackObservedBySecondBatch, true);
  assert.deepEqual(visited, Array.from({ length: 65 }, (_, index) => index));
});

test("Linux process inventory also yields at its wall-clock turn budget", async () => {
  let now = 0;
  let socketCallbackRan = false;
  let callbackObservedAfterBudget = false;
  const visited = [];
  setImmediate(() => { socketCallbackRan = true; });

  await forEachInEventLoopBatches(
    [0, 1, 2],
    64,
    (entry) => {
      visited.push(entry);
      if (entry === 2) callbackObservedAfterBudget = socketCallbackRan;
      now += INVENTORY_EVENT_LOOP_TURN_BUDGET_MS;
    },
    { now: () => now }
  );

  assert.equal(callbackObservedAfterBudget, true);
  assert.deepEqual(visited, [0, 1, 2]);
});

test("Linux process inventory propagates visitor failures without revisiting entries", async () => {
  const visited = [];
  await assert.rejects(
    forEachInEventLoopBatches([0, 1, 2], 64, (entry) => {
      visited.push(entry);
      if (entry === 1) throw new Error("inventory visit failed");
    }),
    /inventory visit failed/
  );
  assert.deepEqual(visited, [0, 1]);
});

test("Linux inventory finds the default tmux root under a deep TMPDIR", async (t) => {
  const fixtureRoot = mkdtempSync(join("/tmp", "yui-inventory-deep-tmp-"));
  const deepTmp = join(
    fixtureRoot,
    "explicitly-long-temporary-root",
    "nested-runtime-boundary",
    "nested-runtime-boundary",
    "nested-runtime-boundary"
  );
  mkdirSync(deepTmp, { recursive: true });
  const home = join(deepTmp, "yui-home");
  const tmuxServer = yuiTmuxServerName(home);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const defaultTmuxSocket = join("/tmp", `tmux-${uid}`, tmuxServer);
  const previousTmpdir = process.env.TMPDIR;
  const previousTmuxTmpdir = process.env.TMUX_TMPDIR;
  process.env.TMPDIR = deepTmp;
  delete process.env.TMUX_TMPDIR;
  t.after(() => {
    spawnSync(
      process.env.YUI_TMUX_BIN ?? "tmux",
      ["-L", tmuxServer, "kill-server"],
      { env: { ...process.env, TMPDIR: deepTmp } }
    );
    rmSync(defaultTmuxSocket, { force: true });
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = previousTmuxTmpdir;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  ensureStorageSchema(home, new Date("2026-08-14T00:00:00.000Z"));
  const tmux = new TmuxManager(
    process.env.YUI_TMUX_BIN ?? "tmux",
    new NodeCommandExecutor(),
    { yuiHome: home }
  );
  tmux.ensureRoleWindow(
    "task-deep-tmp",
    { name: "worker", workspace: home },
    {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      env: { YUI_HOME: home }
    }
  );
  const [expectedPane] = tmux.inspectRolePaneInventory();
  assert.notEqual(expectedPane, undefined);
  assert.equal(existsSync(defaultTmuxSocket), true);
  assert.equal(existsSync(join(deepTmp, `tmux-${uid}`, tmuxServer)), false);

  const snapshot = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current",
    environment: { ...process.env, TMPDIR: deepTmp }
  });
  const pane = snapshot.resources.find((resource) => (
    resource.kind === "agent-session"
    && resource.target === expectedPane.target
  ));

  assert.notEqual(pane, undefined, JSON.stringify(snapshot.resources, null, 2));
  assert.equal(pane.processes.some(({ pid }) => pid === expectedPane.pid), true);
  assert.equal(snapshot.resources.some((resource) => (
    resource.reasonCode === "unattributed-other"
    && resource.processes.some(({ pid }) => pid === expectedPane.pid)
  )), false);
});

function roleResource(overrides = {}) {
  return {
    id: "agent-session:/tmp/yui:yui-task-1:worker",
    fingerprint: "agent-session:123:1000:yui-task-1:worker",
    kind: "agent-session",
    state: "running",
    disposition: "protected",
    reasonCode: "owned-role-pane",
    yuiHome: HOME,
    owner: {
      kind: "task-role",
      taskId: "task-1",
      roleName: "worker",
      runId: "run-1",
      agentId: "agent-1",
      adapterId: "codex",
      nativeSessionId: "native-1",
      launchId: "launch-1"
    },
    processes: [{
      pid: 123,
      ppid: 1,
      uid: 1000,
      startIdentity: "1000",
      command: "codex",
      rssBytes: 1024,
      cpuTimeMs: 10,
      ageMs: 60_000
    }],
    rssBytes: 1024,
    cpuTimeMs: 10,
    ageMs: 60_000,
    ...overrides
  };
}

function resourceIdentity(overrides = {}) {
  return {
    taskId: "task-1",
    roleName: "worker",
    runId: "run-1",
    agentId: "agent-1",
    adapterId: "codex",
    nativeSessionId: "native-1",
    launchId: "launch-1",
    ...overrides
  };
}

test("adjacent resource activity requires exact identity and increasing CPU/IO counters", () => {
  const tracker = createRuntimeResourceActivityTracker();
  assert.equal(tracker(resourceIdentity(), roleResource()), false, "first sample is a baseline");
  assert.equal(tracker(resourceIdentity(), roleResource()), false, "cumulative CPU is not a delta");
  assert.equal(
    tracker(resourceIdentity(), roleResource({ cpuTimeMs: 11 })),
    true,
    "CPU increment is activity"
  );
  assert.equal(
    tracker(resourceIdentity(), roleResource({ cpuTimeMs: 11, rssBytes: 2048 })),
    false,
    "RSS-only residency is not activity"
  );
  assert.equal(
    tracker(resourceIdentity(), roleResource({ cpuTimeMs: 11, ioReadBytes: 3 })),
    false,
    "first IO sample is a baseline"
  );
  assert.equal(
    tracker(resourceIdentity(), roleResource({ cpuTimeMs: 11, ioReadBytes: 4 })),
    true,
    "IO increment is activity"
  );
  assert.equal(
    tracker(resourceIdentity(), roleResource({ cpuTimeMs: 3, ioReadBytes: 1 })),
    false,
    "counter reset establishes a new baseline"
  );
  assert.equal(
    tracker(resourceIdentity(), roleResource({ cpuTimeMs: 4, ioReadBytes: 1 })),
    false,
    "the first valid sample after a reset is not adjacent"
  );
  assert.equal(
    tracker(resourceIdentity(), roleResource({ cpuTimeMs: 5, ioReadBytes: 1 })),
    true,
    "activity resumes only after a post-reset baseline"
  );
  assert.equal(
    tracker(resourceIdentity({ nativeSessionId: "other-native" }), roleResource()),
    false,
    "identity mismatch is fail-closed"
  );
  assert.equal(
    createRuntimeResourceActivityTracker()(resourceIdentity(), roleResource({ cpuTimeMs: 99 })),
    false,
    "Controller restart starts a fresh baseline"
  );
});

test("rejected identity, inventory, counter, and process gaps clear the adjacent baseline", () => {
  const identity = resourceIdentity();
  const tracker = createRuntimeResourceActivityTracker();
  assert.equal(tracker(identity, roleResource({ cpuTimeMs: 10 })), false);
  assert.equal(
    tracker({ ...identity, nativeSessionId: "old-native" }, roleResource({ cpuTimeMs: 11 })),
    false,
    "identity mismatch is a gap"
  );
  assert.equal(
    tracker(identity, roleResource({ cpuTimeMs: 20 })),
    false,
    "the first sample after identity returns is a baseline"
  );
  assert.equal(
    tracker(identity, roleResource({ cpuTimeMs: 21 })),
    true,
    "only the next adjacent sample is activity"
  );
  assert.equal(
    tracker(identity, roleResource({ processes: [], cpuTimeMs: 22 })),
    false,
    "an empty process inventory clears the baseline"
  );
  assert.equal(
    tracker(identity, roleResource({ cpuTimeMs: 30 })),
    false,
    "a sample after an empty inventory is a baseline"
  );
  assert.equal(
    tracker(identity, roleResource({ cpuTimeMs: Number.NaN })),
    false,
    "an invalid counter clears the baseline"
  );
  assert.equal(
    tracker(identity, roleResource({ cpuTimeMs: 40 })),
    false,
    "a sample after an invalid counter is a baseline"
  );
  assert.equal(
    tracker(identity, roleResource({ cpuTimeMs: 41 })),
    true,
    "valid adjacent samples resume only after the gap"
  );
  assert.equal(
    tracker(identity, roleResource({ fingerprint: "agent-session:new-process", cpuTimeMs: 42 })),
    false,
    "a process identity change is a generation gap"
  );
  assert.equal(
    tracker(identity, roleResource({ fingerprint: "agent-session:new-process", cpuTimeMs: 43 })),
    false,
    "the first sample after process replacement is a baseline"
  );
  assert.equal(
    tracker(identity, roleResource({ fingerprint: "agent-session:new-process", cpuTimeMs: 44 })),
    true,
    "replacement process activity needs an adjacent sample"
  );
});

function processFact(overrides) {
  return {
    pid: 100,
    ppid: 1,
    uid: 1000,
    startIdentity: "1000",
    yuiHome: HOME,
    kind: "controller",
    command: "node",
    args: ["node", "/app/controller/controllerMain.js"],
    rssBytes: 64 * 1024 * 1024,
    cpuTimeMs: 250,
    ageMs: 60_000,
    ...overrides
  };
}

test("inventory attributes live Controller and Role resources", () => {
  const current = processFact({ pid: 101, startIdentity: "1001" });
  const superseded = processFact({ pid: 102, startIdentity: "1002" });
  const paneRoot = processFact({
    pid: 201,
    ppid: 150,
    startIdentity: "2001",
    kind: "agent",
    command: "codex",
    args: ["codex"],
    rssBytes: 512 * 1024 * 1024
  });
  const snapshot = buildControllerResourceInventory({
    schemaVersion: 1,
    observedAt: NOW,
    currentHome: HOME,
    scope: "all",
    processes: [
      current,
      superseded,
      paneRoot
    ],
    homes: [{
      yuiHome: HOME,
      exists: true,
      storageStatus: "current",
      discovery: {
        status: "valid",
        pid: current.pid,
        processStartIdentity: current.startIdentity,
        socketPath: `${HOME}/runtime/controller.sock`,
        socketActive: true,
        fingerprint: "discovery-current"
      },
      panes: [{
        taskId: "task-1",
        roleName: "worker",
        target: "yui-task-1:worker",
        dead: false,
        pid: paneRoot.pid,
        currentCommand: "codex"
      }],
      roles: [{
        ownerKind: "task-role",
        taskId: "task-1",
        taskTitle: "Inventory",
        taskStatus: "active",
        roleName: "worker",
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "thread-role"
      }],
      artifacts: []
    }],
    globalArtifacts: []
  });

  const controllerResources = snapshot.resources.filter(({ kind }) => kind === "controller");
  assert.deepEqual(
    controllerResources.map(({ state, disposition }) => ({ state, disposition })),
    [
      { state: "current", disposition: "protected" },
      { state: "superseded", disposition: "safe" }
    ]
  );

  const role = snapshot.resources.find(({ kind }) => kind === "agent-session");
  assert.equal(role.state, "running");
  assert.equal(role.disposition, "protected");
  assert.deepEqual(role.owner, {
    kind: "task-role",
    taskId: "task-1",
    taskTitle: "Inventory",
    taskStatus: "active",
    roleName: "worker",
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-role"
  });

});

test("Linux inventory loads exact Role ownership from record-only older storage", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-compatible-inventory-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-11T00:00:00.000Z");
  ensureStorageSchema(home, now);
  const agent = createConfiguredAgent("agent-1", "codex", "codex", [], [], now);
  const task = activateTask(createTask("task-1", "Compatible inventory", now), now);
  const role = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    now
  );
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const run = createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "compatible inventory",
    now,
    { effective }
  );
  let sessions = createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: role.name },
    agent.id,
    now
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: "codex",
    nativeSessionId: "native-1",
    launchId: "launch-1",
    policy: "fixed",
    status: "running",
    effective
  }, now);
  sessions = bindTaskRoleRun(sessions, {
    agentId: agent.id,
    runId: run.id,
    receiptId: `agent-run:${task.id}/${run.id}`
  }, now);
  const store = new FileTaskStore(home);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, role);
    tx.saveActiveAgentRun(run);
    tx.saveTaskRoleSessionSet(sessions);
  });

  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.configuredAgents[agent.id].schemaVersion = 1;
  delete state.configuredAgents[agent.id].environment;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.recordVersions.configuredAgent = 1;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const registry = new MigrationRegistry();
  registry.registerCompatible({
    axis: "record",
    recordKind: "configuredAgent",
    fromVersion: 1,
    toVersion: 2,
    defaults: ["environment=[]"],
    validateSource: (snapshot) => {
      assert.equal(snapshot.state.configuredAgents[agent.id].schemaVersion, 1);
      assert.equal(snapshot.state.configuredAgents[agent.id].environment, undefined);
    },
    normalize: (snapshot) => ({
      ...snapshot,
      schemaManifest: {
        ...snapshot.schemaManifest,
        recordVersions: {
          ...snapshot.schemaManifest.recordVersions,
          configuredAgent: 2
        }
      },
      state: {
        ...snapshot.state,
        configuredAgents: Object.fromEntries(
          Object.entries(snapshot.state.configuredAgents).map(([id, configured]) => [
            id,
            { ...configured, schemaVersion: 2, environment: [] }
          ])
        )
      }
    })
  });

  const snapshot = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current",
    panes: [{
      taskId: task.id,
      roleName: role.name,
      target: "yui-task-1:worker",
      dead: false,
      currentCommand: "codex"
    }],
    openCompatibleStore: (candidateHome) => {
      assert.equal(candidateHome, home);
      return openCompatibleFileTaskStore(candidateHome, {
        registry,
        latest: latestStorageVersionState()
      });
    }
  });
  const resource = snapshot.resources.find(({ kind }) => kind === "agent-session");
  assert.deepEqual(resource.owner, {
    kind: "task-role",
    taskId: task.id,
    taskTitle: task.title,
    taskStatus: task.status,
    roleName: role.name,
    runId: "agent-run-1",
    agentId: agent.id,
    adapterId: "codex",
    nativeSessionId: "native-1",
    launchId: "launch-1"
  });
});

test("Linux inventory keeps non-compatible and corrupted storage ownership closed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-closed-inventory-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const panes = [{
    taskId: "task-1",
    roleName: "worker",
    target: "yui-task-1:worker",
    dead: false,
    currentCommand: "codex"
  }];
  const blocked = [
    { status: "uninitialized" },
    { status: "invalid" },
    {
      status: "unsupported",
      incompatibleComponent: "layout",
      direction: "older",
      currentLayoutVersion: 5,
      latestLayoutVersion: 6,
      currentAggregateSchemaVersion: 17,
      latestAggregateSchemaVersion: 17
    },
    {
      status: "unsupported",
      incompatibleComponent: "aggregate",
      direction: "older",
      currentLayoutVersion: 6,
      latestLayoutVersion: 6,
      currentAggregateSchemaVersion: 16,
      latestAggregateSchemaVersion: 17
    },
    {
      status: "unsupported",
      incompatibleComponent: "record",
      direction: "newer",
      currentLayoutVersion: 6,
      latestLayoutVersion: 6,
      currentAggregateSchemaVersion: 17,
      latestAggregateSchemaVersion: 17
    },
    {
      status: "unsupported",
      incompatibleComponent: "record",
      direction: "older",
      currentLayoutVersion: 5,
      latestLayoutVersion: 6,
      currentAggregateSchemaVersion: 17,
      latestAggregateSchemaVersion: 17
    }
  ];
  let openCount = 0;
  for (const storage of blocked) {
    const snapshot = await scanControllerResourceInventory({
      currentHome: home,
      scope: "current",
      panes,
      inspectStorage: () => storage,
      openCompatibleStore: () => {
        openCount += 1;
        throw new Error("unexpected compatible open");
      }
    });
    const resource = snapshot.resources.find(({ kind }) => kind === "agent-session");
    assert.deepEqual(resource.owner, { kind: "none" });
  }
  assert.equal(openCount, 0);

  const corrupted = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current",
    panes,
    inspectStorage: () => ({
      status: "unsupported",
      incompatibleComponent: "record",
      direction: "older",
      currentLayoutVersion: 6,
      latestLayoutVersion: 6,
      currentAggregateSchemaVersion: 17,
      latestAggregateSchemaVersion: 17
    }),
    openCompatibleStore: () => {
      openCount += 1;
      throw new Error("compatible source is corrupted");
    }
  });
  const resource = corrupted.resources.find(({ kind }) => kind === "agent-session");
  assert.deepEqual(resource.owner, { kind: "none" });
  assert.equal(openCount, 1);
  assert.match(corrupted.warnings.join("\n"), /compatible source is corrupted/i);
  assert.equal(corrupted.domains[0].storageStatus, "invalid");
});

test("inventory separates orphaned, unattributed, and stale resources by cleanup safety", () => {
  const orphanController = processFact({
    pid: 111,
    startIdentity: "1111",
    yuiHome: "/tmp/deleted-yui-home"
  });
  const orphanPane = processFact({
    pid: 211,
    startIdentity: "2111",
    kind: "agent",
    command: "claude",
    args: ["claude"]
  });

  const snapshot = buildControllerResourceInventory({
    schemaVersion: 1,
    observedAt: NOW,
    currentHome: HOME,
    scope: "all",
    processes: [orphanController, orphanPane],
    homes: [
      {
        yuiHome: "/tmp/deleted-yui-home",
        exists: false,
        storageStatus: "uninitialized",
        discovery: { status: "absent" },
        panes: [],
        roles: [],
        artifacts: []
      },
      {
        yuiHome: HOME,
        exists: true,
        storageStatus: "current",
        discovery: { status: "absent" },
        panes: [{
          taskId: "task-missing",
          roleName: "worker",
          target: "missing:worker",
          dead: false,
          pid: orphanPane.pid,
          currentCommand: "claude"
        }],
        roles: [],
        artifacts: []
      }
    ],
    globalArtifacts: [{
      artifactKind: "tmux-socket",
      path: "/tmp/tmux-1000/yui-stale",
      active: false,
      fingerprint: "socket-stale"
    }, {
      artifactKind: "tmux-socket",
      path: "/tmp/tmux-1000/yui-live-unmapped",
      active: true,
      fingerprint: "socket-live"
    }]
  });

  const orphan = snapshot.resources.find(
    ({ kind, processes }) => kind === "controller" && processes.some(({ pid }) => pid === 111)
  );
  assert.equal(orphan.state, "orphaned");
  assert.equal(orphan.disposition, "safe");

  const pane = snapshot.resources.find(({ kind }) => kind === "agent-session");
  assert.equal(pane.state, "orphaned");
  assert.equal(pane.disposition, "review");

  const stale = snapshot.resources.find(
    ({ artifact }) => artifact?.path.endsWith("yui-stale")
  );
  assert.equal(stale.state, "stale");
  assert.equal(stale.disposition, "safe");

  const unattributed = snapshot.resources.find(
    ({ artifact }) => artifact?.path.endsWith("yui-live-unmapped")
  );
  assert.equal(unattributed.state, "unattributed");
  assert.equal(unattributed.disposition, "report-only");
});

test("a tmux server hosting known Role panes remains protected", () => {
  const tmuxServer = processFact({
    pid: 601,
    startIdentity: "6001",
    kind: "tmux-server",
    command: "tmux: server",
    args: ["tmux", "-L", "yui-test"]
  });
  const paneRoot = processFact({
    pid: 602,
    ppid: tmuxServer.pid,
    startIdentity: "6002",
    kind: "agent",
    command: "codex",
    args: ["codex"]
  });
  const snapshot = buildControllerResourceInventory({
    schemaVersion: 1,
    observedAt: NOW,
    currentHome: HOME,
    scope: "current",
    processes: [tmuxServer, paneRoot],
    homes: [{
      yuiHome: HOME,
      exists: true,
      storageStatus: "current",
      discovery: { status: "absent" },
      panes: [{
        taskId: "task-1",
        roleName: "leader",
        target: "yui-task-1:leader",
        dead: false,
        pid: paneRoot.pid,
        currentCommand: "codex"
      }],
      roles: [{
        ownerKind: "task-role",
        taskId: "task-1",
        taskTitle: "Active task",
        taskStatus: "active",
        roleName: "leader",
        agentId: "codex",
        adapterId: "codex"
      }],
      artifacts: []
    }],
    globalArtifacts: []
  });

  const server = snapshot.resources.find(({ kind }) => kind === "tmux-server");
  assert.equal(server.state, "running");
  assert.equal(server.disposition, "protected");
  assert.equal(server.reasonCode, "owned-tmux-server");
  assert.deepEqual(server.owner, { kind: "controller-domain", yuiHome: HOME });
});

test("an exact Controller discovery identity remains protected while its socket is unavailable", () => {
  const controller = processFact({ pid: 401, startIdentity: "4001" });
  const snapshot = buildControllerResourceInventory({
    schemaVersion: 1,
    observedAt: NOW,
    currentHome: HOME,
    scope: "current",
    processes: [controller],
    homes: [{
      yuiHome: HOME,
      exists: true,
      storageStatus: "current",
      discovery: {
        status: "valid",
        pid: controller.pid,
        processStartIdentity: controller.startIdentity,
        socketPath: `${HOME}/runtime/controller.sock`,
        socketActive: false,
        fingerprint: "discovery-starting"
      },
      panes: [],
      roles: [],
      artifacts: []
    }],
    globalArtifacts: []
  });

  const resource = snapshot.resources.find(({ kind }) => kind === "controller");
  assert.equal(resource.state, "current");
  assert.equal(resource.disposition, "protected");
});

test("a deleted-home Controller with an untagged child still requires review", () => {
  const home = "/tmp/deleted-yui-home-with-child";
  const controller = processFact({
    pid: 501,
    startIdentity: "5001",
    yuiHome: home
  });
  const child = processFact({
    pid: 502,
    ppid: controller.pid,
    startIdentity: "5002",
    yuiHome: undefined,
    kind: "other",
    command: "node",
    args: ["node", "child.js"]
  });
  const snapshot = buildControllerResourceInventory({
    schemaVersion: 1,
    observedAt: NOW,
    currentHome: HOME,
    scope: "all",
    processes: [controller, child],
    homes: [{
      yuiHome: home,
      exists: false,
      storageStatus: "uninitialized",
      discovery: { status: "absent" },
      panes: [],
      roles: [],
      artifacts: []
    }],
    globalArtifacts: []
  });

  const resource = snapshot.resources.find(({ kind }) => kind === "controller");
  assert.equal(resource.reasonCode, "orphan-controller");
  assert.equal(resource.disposition, "review");
});

test("Linux process facts use start identity for cleanup fencing and classify only known hosts", () => {
  const fields = [
    "S", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "20", "5",
    "13", "14", "15", "16", "17", "18", "2000", "21", "22"
  ];
  const parsed = parseLinuxProcessStat(`123 (node worker) ${fields.join(" ")}`, 100, 60_000);
  assert.deepEqual(parsed, {
    ppid: 1,
    startIdentity: "2000",
    cpuTimeMs: 250,
    ageMs: 40_000
  });

  assert.equal(
    classifyRuntimeProcess(
      ["node", "/opt/yui/dist/controller/controllerMain.js"],
      "node"
    ),
    "controller"
  );
  assert.equal(
    classifyRuntimeProcess(
      ["codex", "app-server", "--listen", "unix:///tmp/attempt.sock"],
      "codex"
    ),
    "app-server"
  );
  assert.equal(
    classifyRuntimeProcess(["tmux", "-L", "yui-abcd", "start-server"], "tmux: server"),
    "tmux-server"
  );
  assert.equal(classifyRuntimeProcess(["node", "unrelated.js"], "node"), "other");
});
