import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureStorageSchema,
  requireStorageSchema
} from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

const FIRST = "2026-07-14T00:00:00.000Z";
const SECOND = "2026-07-14T00:00:01.000Z";
const OWNER_TOKEN = "00000000-0000-4000-8000-000000000001";

test("new TaskMux homes initialize the v4 storage manifest privately", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-schema-v4-new-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  ensureStorageSchema(home);

  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.storageVersion, 4);
  assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
});

test("a complete v3 Role home upgrades agents and roles without losing their ownership", (t) => {
  const home = createCompleteV3RoleHome(t);

  requireStorageSchema(home);

  const manifestPath = join(home, "schema.json");
  const manifest = readJson(manifestPath);
  const store = new FileTaskStore(home);
  const agent = store.getConfiguredAgent("codex");
  const globalRole = store.getGlobalRole("operator");
  const taskRole = store.getRole("task-1", "leader");

  assert.equal(manifest.storageVersion, 4);
  assert.deepEqual(agent, {
    schemaVersion: 2,
    id: "codex",
    adapterId: "codex",
    command: "/usr/local/bin/codex",
    baseArgs: ["--verbose"],
    environment: [],
    probePinRefreshRequired: true,
    createdAt: FIRST,
    updatedAt: SECOND
  });
  assert.equal(globalRole?.schemaVersion, 2);
  assert.equal(globalRole?.activeAgentId, "codex");
  assert.deepEqual(globalRole?.agentBindings.codex, {
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  });
  assert.equal(taskRole?.schemaVersion, 2);
  assert.equal(taskRole?.taskId, "task-1");
  assert.equal(taskRole?.name, "leader");
  assert.equal(taskRole?.description, "Coordinate the implementation");
  assert.deepEqual(taskRole?.agentBindings, globalRole?.agentBindings);
  assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
  assert.equal(
    statSync(join(home, "agents", "codex", "agent.json")).mode & 0o777,
    0o600
  );

  const firstManifest = readFileSync(manifestPath, "utf8");
  requireStorageSchema(home);
  assert.equal(readFileSync(manifestPath, "utf8"), firstManifest);
});

test("a v3 manifest upgrades the already-current Role Agent layout without rewriting it", (t) => {
  const home = createCurrentRoleLayoutV3Home(t);
  const agentPath = join(home, "agents", "codex", "agent.json");
  const globalRolePath = join(home, "roles", "operator", "role.json");
  const taskRolePath = join(home, "tasks", "task-1", "roles", "leader", "role.json");
  const sessionPath = join(home, "runtime", "role-sessions", "tasks", "task-1", "leader.json");
  const worktreePath = join(home, "tasks", "task-1", "roles", "leader", "worktree.json");
  const before = new Map([
    [agentPath, readFileSync(agentPath, "utf8")],
    [globalRolePath, readFileSync(globalRolePath, "utf8")],
    [taskRolePath, readFileSync(taskRolePath, "utf8")],
    [sessionPath, readFileSync(sessionPath, "utf8")],
    [worktreePath, readFileSync(worktreePath, "utf8")]
  ]);

  requireStorageSchema(home);

  const store = new FileTaskStore(home);
  assert.equal(readJson(join(home, "schema.json")).storageVersion, 4);
  assert.equal(store.getConfiguredAgent("codex")?.schemaVersion, 2);
  assert.equal(store.getGlobalRole("operator")?.schemaVersion, 2);
  assert.equal(store.getRole("task-1", "leader")?.schemaVersion, 2);
  assert.equal(store.getRoleSessionSet("task-1", "leader")?.sessions.codex.nativeSessionId, "thread-1");
  assert.equal(
    store.getRoleWorktree("task-1", "leader")?.ownerToken,
    OWNER_TOKEN
  );
  for (const [path, content] of before) {
    assert.equal(readFileSync(path, "utf8"), content, path);
  }
});

test("an invalid current Role session in a v3 manifest fails closed before the manifest upgrade", (t) => {
  const home = createCurrentRoleLayoutV3Home(t);
  const sessionPath = join(home, "runtime", "role-sessions", "tasks", "task-1", "leader.json");
  const invalidSession = readJson(sessionPath);
  delete invalidSession.sessions.codex.sessionRoot;
  writeJson(sessionPath, invalidSession);
  const beforeSession = readFileSync(sessionPath, "utf8");
  const beforeRole = readFileSync(join(home, "tasks", "task-1", "roles", "leader", "role.json"), "utf8");

  assert.throws(
    () => requireStorageSchema(home),
    /not a valid current Role session set.*No TaskMux storage changes were committed/i
  );

  assert.equal(readJson(join(home, "schema.json")).storageVersion, 3);
  assert.equal(readFileSync(sessionPath, "utf8"), beforeSession);
  assert.equal(
    readFileSync(join(home, "tasks", "task-1", "roles", "leader", "role.json"), "utf8"),
    beforeRole
  );
});

test("a v3 Role session without new provenance fails closed before any migration commit", (t) => {
  const home = createCompleteV3RoleHome(t);
  const sessionPath = join(home, "runtime", "role-sessions", "task-1", "leader.json");
  writeJson(sessionPath, {
    schemaVersion: 1,
    taskId: "task-1",
    roleName: "leader",
    agent: "codex",
    nativeSessionId: "legacy-native-session",
    policy: "fixed",
    status: "ready",
    previousSessionIds: [],
    createdAt: FIRST,
    updatedAt: SECOND
  });
  const beforeAgent = readFileSync(join(home, "agents", "codex", "agent.json"), "utf8");
  const beforeSession = readFileSync(sessionPath, "utf8");

  assert.throws(
    () => requireStorageSchema(home),
    /legacy Role session location.*physical session root.*No TaskMux storage changes were committed/i
  );

  assert.equal(readJson(join(home, "schema.json")).storageVersion, 3);
  assert.equal(readFileSync(join(home, "agents", "codex", "agent.json"), "utf8"), beforeAgent);
  assert.equal(readFileSync(sessionPath, "utf8"), beforeSession);
});

test("a v3 worktree without an ownership marker fails closed before any migration commit", (t) => {
  const home = createCompleteV3RoleHome(t);
  const worktreePath = join(home, "tasks", "task-1", "roles", "leader", "worktree.json");
  writeJson(worktreePath, {
    schemaVersion: 1,
    taskId: "task-1",
    roleName: "leader",
    repository: "/repo",
    path: "/repo/taskmux-leader",
    branch: "taskmux/leader",
    base: "main",
    createdAt: FIRST
  });
  const beforeRole = readFileSync(join(home, "tasks", "task-1", "roles", "leader", "role.json"), "utf8");
  const beforeWorktree = readFileSync(worktreePath, "utf8");

  assert.throws(
    () => requireStorageSchema(home),
    /legacy worktree record without the v4 ownership marker.*will not claim or delete.*No TaskMux storage changes were committed/i
  );

  assert.equal(readJson(join(home, "schema.json")).storageVersion, 3);
  assert.equal(readFileSync(join(home, "tasks", "task-1", "roles", "leader", "role.json"), "utf8"), beforeRole);
  assert.equal(readFileSync(worktreePath, "utf8"), beforeWorktree);
});

test("a staged v3-to-v4 migration recovers on the next schema gate", (t) => {
  const home = createCompleteV3RoleHome(t);
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFailpoint = process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT;

  try {
    process.env.NODE_ENV = "test";
    process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT = "after-stage";
    assert.throws(() => requireStorageSchema(home), /storage-schema-v3-to-v4|stopped after staging/i);

    delete process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT;
    requireStorageSchema(home);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFailpoint === undefined) delete process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT;
    else process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT = previousFailpoint;
  }

  assert.equal(readJson(join(home, "schema.json")).storageVersion, 4);
  assert.equal(new FileTaskStore(home).getRole("task-1", "leader")?.activeAgentId, "codex");
});

function createCompleteV3RoleHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-schema-v3-role-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  writeJson(join(home, "schema.json"), {
    schemaVersion: 1,
    storageVersion: 3,
    updatedAt: FIRST
  });
  writeJson(join(home, "config.json"), {
    schemaVersion: 1,
    defaultAgent: "codex",
    defaultWorkspace: "/repo"
  });
  writeJson(join(home, "agents", "codex", "agent.json"), {
    schemaVersion: 1,
    id: "codex",
    command: "/usr/local/bin/codex",
    args: ["--verbose"],
    env: {},
    createdAt: FIRST,
    updatedAt: SECOND
  });
  writeJson(join(home, "roles", "operator", "role.json"), {
    schemaVersion: 1,
    name: "operator",
    agent: "codex",
    command: "/usr/local/bin/codex",
    args: ["--verbose"],
    env: {},
    workspace: "/repo",
    description: "Coordinate the implementation",
    responsibilities: ["Coordinate"],
    constraints: ["Preserve data"],
    expectedOutput: "A complete result",
    systemPrompt: "Be precise.",
    skills: ["storage"],
    createdAt: FIRST,
    updatedAt: SECOND
  });
  writeJson(join(home, "tasks", "task-1", "task.json"), {
    schemaVersion: 1,
    id: "task-1",
    archived: false,
    createdAt: FIRST,
    updatedAt: SECOND
  });
  writeJson(join(home, "tasks", "task-1", "info.json"), {
    schemaVersion: 1,
    title: "Migrate Role storage"
  });
  writeJson(join(home, "tasks", "task-1", "roles", "leader", "role.json"), {
    schemaVersion: 1,
    agent: "codex",
    command: "/usr/local/bin/codex",
    args: ["--verbose"],
    env: {},
    workspace: "/repo",
    status: "idle",
    createdAt: FIRST,
    updatedAt: SECOND
  });
  writeJson(join(home, "tasks", "task-1", "roles", "leader", "info.json"), {
    schemaVersion: 1,
    name: "leader",
    description: "Coordinate the implementation",
    responsibilities: ["Coordinate"],
    constraints: ["Preserve data"],
    expectedOutput: "A complete result",
    systemPrompt: "Be precise.",
    skills: ["storage"]
  });

  return home;
}

function createCurrentRoleLayoutV3Home(t) {
  const home = createCompleteV3RoleHome(t);
  const binding = {
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  };
  const fingerprint = "a".repeat(64);

  writeJson(join(home, "agents", "codex", "agent.json"), {
    schemaVersion: 2,
    id: "codex",
    adapterId: "codex",
    command: "/usr/local/bin/codex",
    baseArgs: ["--verbose"],
    environment: [],
    probePinRefreshRequired: true,
    createdAt: FIRST,
    updatedAt: SECOND
  });
  writeJson(join(home, "roles", "operator", "role.json"), {
    schemaVersion: 2,
    name: "operator",
    activeAgentId: "codex",
    agentBindings: { codex: binding },
    workspace: "/repo",
    description: "Coordinate the implementation",
    responsibilities: ["Coordinate"],
    constraints: ["Preserve data"],
    expectedOutput: "A complete result",
    systemPrompt: "Be precise.",
    skills: ["storage"],
    createdAt: FIRST,
    updatedAt: SECOND
  });
  writeJson(join(home, "tasks", "task-1", "roles", "leader", "role.json"), {
    schemaVersion: 2,
    taskId: "task-1",
    activeAgentId: "codex",
    agentBindings: { codex: binding },
    workspace: "/repo",
    status: "idle",
    createdAt: FIRST,
    updatedAt: SECOND
  });
  writeJson(join(home, "runtime", "role-sessions", "tasks", "task-1", "leader.json"), {
    schemaVersion: 3,
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    activeAgentId: "codex",
    sessions: {
      codex: {
        schemaVersion: 3,
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "thread-1",
        policy: "fixed",
        status: "ready",
        previousIdentities: [],
        sessionRoot: "/tmp",
        worktreeRoot: "/repo",
        createdConfigHash: {
          overall: fingerprint,
          replayable: fingerprint,
          permission: fingerprint,
          sessionBound: fingerprint
        },
        lastLaunchConfigHash: {
          overall: fingerprint,
          replayable: fingerprint,
          permission: fingerprint,
          sessionBound: fingerprint
        },
        permissionEnvelope: { adapterId: "codex" },
        createdAt: FIRST,
        updatedAt: SECOND
      }
    },
    updatedAt: SECOND
  });
  writeJson(join(home, "tasks", "task-1", "roles", "leader", "worktree.json"), {
    schemaVersion: 2,
    taskId: "task-1",
    roleName: "leader",
    repositoryRoot: "/repo",
    commonDir: "/repo/.git",
    repositoryFingerprint: fingerprint,
    path: "/repo/.taskmux/worktrees/task-1/leader",
    worktreeGitDir: "/repo/.git/worktrees/leader",
    branchRef: "taskmux/task-1/leader",
    headOid: "b".repeat(40),
    ownerToken: OWNER_TOKEN,
    createdAt: FIRST
  });

  return home;
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
