import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import { resolveAgentSessionRoot } from "../dist/executor/executorRegistry.js";
import { isCanonicalNativeSessionRoot } from "../dist/executor/nativeSessionIdentity.js";
import { runGlobalRoleCommand } from "../dist/commands/globalRoleCommands.js";
import {
  mergeImportedRoleSessionSets
} from "../dist/commands/maintenanceCommands.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { createGlobalRole, createRole } from "../dist/role/role.js";
import { isRoleAgentSessionRecord } from "../dist/storage/recordValidation.js";
import { primeResilientTaskStore } from "../dist/storage/resilientTaskStore.js";
import {
  FileTaskStore,
  snapshotNativeSessionIdentityClaims
} from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const now = new Date("2026-07-13T00:00:00.000Z");
const hash = "a".repeat(64);

function fixtureStore() {
  const store = FileTaskStore.createEphemeralWorkspace("taskmux-role-identity-final-");
  return { store, home: store.rootDirectory() };
}

function fixtureHome() {
  return mkdtempSync(join(tmpdir(), "taskmux-role-identity-final-files-"));
}

function binding(agentId) {
  return { agentId, adapterId: "codex", config: { adapterId: "codex" } };
}

function configuredAgent(agentId = "codex") {
  return {
    schemaVersion: 2,
    id: agentId,
    adapterId: "codex",
    command: "codex",
    baseArgs: [],
    environment: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function role(taskId, name, agentIds, activeAgentId = agentIds[0]) {
  return createRole(taskId, name, agentIds.map(binding), activeAgentId, "/repo", now);
}

function sessionInput(agentId, nativeSessionId, sessionRoot, replacementReason) {
  return {
    agentId,
    adapterId: "codex",
    nativeSessionId,
    policy: "fixed",
    status: "ready",
    sessionRoot,
    worktreeRoot: "/repo",
    configFingerprint: {
      overall: hash,
      replayable: hash,
      permission: hash,
      sessionBound: hash
    },
    permissionEnvelope: { adapterId: "codex" },
    ...(replacementReason === undefined ? {} : { replacementReason })
  };
}

function taskSession(taskId, roleName, activeAgentId, input) {
  return recordRoleAgentSession(
    createRoleSessionSet({ scope: "task", taskId, roleName }, activeAgentId, now),
    input,
    now
  );
}

function globalSession(roleName, activeAgentId, input) {
  return recordRoleAgentSession(
    createRoleSessionSet({ scope: "global", roleName }, activeAgentId, now),
    input,
    now
  );
}

function saveTaskRole(store, taskId, roleName, agentIds, activeAgentId = agentIds[0]) {
  store.saveTask(createTask(taskId, taskId, now));
  store.saveRole(taskId, role(taskId, roleName, agentIds, activeAgentId));
}

function corruptDuplicateGlobalSessions(store, home) {
  store.saveGlobalRole(createGlobalRole("leader", [binding("codex")], "codex", "/repo", now));
  store.saveGlobalRole(createGlobalRole("reviewer", [binding("codex")], "codex", "/repo", now));
  const leader = globalSession(
    "leader",
    "codex",
    sessionInput("codex", "leader-native", "/sessions/shared")
  );
  store.saveGlobalRoleSessionSet(leader);
  store.saveGlobalRoleSessionSet(globalSession(
    "reviewer",
    "codex",
    sessionInput("codex", "reviewer-native", "/sessions/reviewer")
  ));
  writeFileSync(
    join(home, "runtime", "role-sessions", "global", "reviewer.json"),
    `${JSON.stringify({ ...leader, owner: { scope: "global", roleName: "reviewer" } })}\n`
  );
  rmSync(join(home, "runtime", "native-session-identities.json"), { force: true });
}

function corruptDuplicateTaskSessions(store, home) {
  saveTaskRole(store, "task-1", "leader", ["codex"]);
  saveTaskRole(store, "task-1", "reviewer", ["codex"]);
  const leader = taskSession(
    "task-1",
    "leader",
    "codex",
    sessionInput("codex", "leader-native", "/sessions/shared")
  );
  store.saveRoleSessionSet(leader);
  store.saveRoleSessionSet(taskSession(
    "task-1",
    "reviewer",
    "codex",
    sessionInput("codex", "reviewer-native", "/sessions/reviewer")
  ));
  writeFileSync(
    join(home, "runtime", "role-sessions", "tasks", "task-1", "reviewer.json"),
    `${JSON.stringify({
      ...leader,
      owner: { scope: "task", taskId: "task-1", roleName: "reviewer" }
    })}\n`
  );
  rmSync(join(home, "runtime", "native-session-identities.json"), { force: true });
}

test("a task Role directory cannot alias a different info.name", () => {
  const { store, home } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    const infoPath = join(home, "tasks", "task-1", "roles", "leader", "info.json");
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    writeFileSync(infoPath, `${JSON.stringify({ ...info, name: "reviewer" })}\n`);

    assert.throws(
      () => store.getRole("task-1", "leader"),
      (error) => error.code === "DATA_ERROR" && /Invalid role info record: leader/.test(error.message)
    );
    assert.equal(store.getRole("task-1", "reviewer"), null);
    assert.throws(
      () => store.listRoles("task-1"),
      (error) => error.code === "DATA_ERROR" && /Invalid role info record: leader/.test(error.message)
    );
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("task and global record reject a same-id root change without explicit replacement", () => {
  const { store, home } = fixtureStore();
  try {
    const rootOne = join(home, "native-one");
    const rootTwo = join(home, "native-two");
    mkdirSync(rootOne);
    mkdirSync(rootTwo);
    store.saveConfiguredAgent(configuredAgent());
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    store.saveGlobalRole(createGlobalRole("operator", [binding("codex")], "codex", "/repo", now));

    runTaskCommand(
      ["session", "record", "task-1", "leader", "--native-id", "task-native"],
      store,
      undefined,
      { environment: { HOME: home, CODEX_HOME: rootOne } }
    );
    assert.throws(
      () => runTaskCommand(
        ["session", "record", "task-1", "leader", "--native-id", "task-native"],
        store,
        undefined,
        { environment: { HOME: home, CODEX_HOME: rootTwo } }
      ),
      /replacement must be explicit/i
    );
    assert.equal(store.getRoleSessionSet("task-1", "leader").sessions.codex.sessionRoot, rootOne);

    runGlobalRoleCommand(
      ["session", "record", "operator", "--native-id", "global-native"],
      store,
      { env: { HOME: home, CODEX_HOME: rootOne } }
    );
    assert.throws(
      () => runGlobalRoleCommand(
        ["session", "record", "operator", "--native-id", "global-native"],
        store,
        { env: { HOME: home, CODEX_HOME: rootTwo } }
      ),
      /replacement must be explicit/i
    );
    assert.equal(store.getGlobalRoleSessionSet("operator").sessions.codex.sessionRoot, rootOne);
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("native session ids reject surrounding ECMAScript whitespace at runtime storage and ledger boundaries", () => {
  const padded = "\uFEFFnative-id\u00A0";
  const base = taskSession(
    "task-1",
    "leader",
    "codex",
    sessionInput("codex", "native-id", "/sessions/root")
  );
  assert.throws(
    () => taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", padded, "/sessions/root")
    ),
    /must not contain surrounding whitespace/i
  );
  const hostileCurrent = structuredClone(base.sessions.codex);
  hostileCurrent.nativeSessionId = padded;
  assert.equal(isRoleAgentSessionRecord(hostileCurrent), false);
  const hostileHistory = structuredClone(base.sessions.codex);
  hostileHistory.previousIdentities = [{
    adapterId: "codex",
    sessionRoot: "/sessions/old",
    nativeSessionId: padded
  }];
  hostileHistory.replacementReason = "replace";
  assert.equal(isRoleAgentSessionRecord(hostileHistory), false);

  const { store, home } = fixtureStore();
  try {
    const ledgerPath = join(home, "runtime", "native-session-identities.json");
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(ledgerPath, `${JSON.stringify({
      schemaVersion: 3,
      identities: {
        [JSON.stringify(["codex", "/sessions/root", padded])]: {
          state: "owned",
          owner: { scope: "global", roleName: "operator", agentId: "codex" }
        }
      }
    })}\n`);
    assert.throws(
      () => store.nativeSessionIdentityClaims(),
      /Invalid native session identity ledger/
    );
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("native identity import snapshots never execute hostile accessors", () => {
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, JSON.stringify(["codex", "/sessions/root", "native-id"]), {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { state: "retired" };
    }
  });

  assert.equal(snapshotNativeSessionIdentityClaims(hostile), null);
  assert.equal(getterCalls, 0);
  assert.equal(snapshotNativeSessionIdentityClaims(new Proxy({}, {})), null);
});

test("durable identity ledger import rejects malformed or conflicting claims without mutation", () => {
  const { store, home } = fixtureStore();
  try {
    const identity = JSON.stringify(["codex", "/sessions/root", "native-id"]);
    const original = {
      [identity]: {
        state: "owned",
        owner: { scope: "global", roleName: "leader", agentId: "codex" }
      }
    };
    store.mergeImportedNativeSessionIdentityClaims(original);
    const ledgerPath = join(home, "runtime", "native-session-identities.json");
    const before = readFileSync(ledgerPath, "utf8");

    for (const imported of [
      { [identity]: { state: "retired" } },
      {
        [identity]: {
          state: "owned",
          owner: { scope: "global", roleName: "reviewer", agentId: "codex" }
        }
      },
      { [JSON.stringify(["codex", "/sessions/root", " native-id"])]: { state: "retired" } },
      { [identity]: { state: "retired", extra: true } }
    ]) {
      assert.throws(
        () => store.mergeImportedNativeSessionIdentityClaims(imported),
        /Invalid imported|conflicts with the target ledger/i
      );
      assert.equal(readFileSync(ledgerPath, "utf8"), before);
    }
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("ledger seeding rejects duplicate live owners before plain save rename remove or delete", async (t) => {
  const cases = [
    {
      name: "plain save",
      arrange: corruptDuplicateGlobalSessions,
      act(store) {
        store.saveGlobalRole(store.getGlobalRole("leader"));
      },
      assertUnchanged(store) {
        assert.notEqual(store.getGlobalRole("leader"), null);
        assert.notEqual(store.getGlobalRole("reviewer"), null);
      }
    },
    {
      name: "rename",
      arrange: corruptDuplicateTaskSessions,
      act(store) {
        store.renameRole("task-1", "leader", { ...store.getRole("task-1", "leader"), name: "renamed" });
      },
      assertUnchanged(store) {
        assert.notEqual(store.getRole("task-1", "leader"), null);
        assert.equal(store.getRole("task-1", "renamed"), null);
      }
    },
    {
      name: "remove",
      arrange: corruptDuplicateGlobalSessions,
      act(store) {
        store.removeGlobalRole("leader");
      },
      assertUnchanged(store) {
        assert.notEqual(store.getGlobalRole("leader"), null);
      }
    },
    {
      name: "delete",
      arrange: corruptDuplicateTaskSessions,
      act(store) {
        store.deleteTask("task-1");
      },
      assertUnchanged(store, home) {
        assert.notEqual(store.getTask("task-1"), null);
        assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), false);
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const { store, home } = fixtureStore();
      try {
        scenario.arrange(store, home);
        assert.throws(
          () => scenario.act(store),
          /native session identity is already owned by another Role Agent/i
        );
        scenario.assertUnchanged(store, home);
        assert.equal(existsSync(join(home, "runtime", "native-session-identities.json")), false);
      } finally {
        store.disposeEphemeralWorkspace();
      }
    });
  }
});

test("ledger seeding reconciles every live current and historical tuple", () => {
  const { store, home } = fixtureStore();
  try {
    store.saveGlobalRole(createGlobalRole("leader", [binding("codex")], "codex", "/repo", now));
    store.saveGlobalRole(createGlobalRole("reviewer", [binding("codex")], "codex", "/repo", now));
    let leader = globalSession(
      "leader",
      "codex",
      sessionInput("codex", "leader-old", "/sessions/leader-old")
    );
    leader = recordRoleAgentSession(
      leader,
      sessionInput("codex", "leader-current", "/sessions/leader-current", "replace"),
      new Date("2026-07-13T00:01:00.000Z")
    );
    store.saveGlobalRoleSessionSet(leader);
    store.saveGlobalRoleSessionSet(globalSession(
      "reviewer",
      "codex",
      sessionInput("codex", "reviewer-current", "/sessions/reviewer")
    ));
    rmSync(join(home, "runtime", "native-session-identities.json"), { force: true });

    store.saveGlobalRole(store.getGlobalRole("leader"));

    const claims = [...store.nativeSessionIdentityClaims().entries()];
    assert.equal(claims.length, 3);
    assert.deepEqual(
      new Set(claims.map(([key]) => JSON.parse(key)[2])),
      new Set(["leader-old", "leader-current", "reviewer-current"])
    );
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("session roots are stored as physical paths and do not follow a later symlink retarget", () => {
  const home = fixtureHome();
  try {
    const targetOne = join(home, "target-one");
    const targetTwo = join(home, "target-two");
    const alias = join(home, "native-alias");
    mkdirSync(targetOne);
    mkdirSync(targetTwo);
    symlinkSync(targetOne, alias, "dir");
    const firstRoot = resolveAgentSessionRoot("codex", { HOME: home, CODEX_HOME: alias });
    assert.equal(firstRoot, targetOne);
    const original = taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", "native-id", firstRoot)
    );

    rmSync(alias);
    symlinkSync(targetTwo, alias, "dir");
    const retargetedRoot = resolveAgentSessionRoot("codex", { HOME: home, CODEX_HOME: alias });
    assert.equal(retargetedRoot, targetTwo);
    assert.equal(original.sessions.codex.sessionRoot, targetOne);
    assert.throws(
      () => recordRoleAgentSession(
        original,
        sessionInput("codex", "native-id", retargetedRoot),
        new Date("2026-07-13T00:01:00.000Z")
      ),
      /replacement reason is required/i
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("broken symlink session roots are rejected instead of becoming identity keys", () => {
  const home = fixtureHome();
  try {
    const brokenAlias = join(home, "broken-native-root");
    symlinkSync(join(home, "missing-native-root"), brokenAlias, "dir");

    assert.equal(isCanonicalNativeSessionRoot(brokenAlias), false);
    assert.throws(
      () => resolveAgentSessionRoot("codex", { HOME: home, CODEX_HOME: brokenAlias }),
      /no such file|Native session root/i
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ledger reconciliation scans live and trash SessionSets even without task metadata", () => {
  const { store, home } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    const sessions = taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", "shared-native", "/sessions/shared")
    );
    store.saveRoleSessionSet(sessions);
    assert.equal(store.deleteTask("task-1"), true);
    rmSync(join(home, "trash", "tasks", "task-1", "task.json"), { force: true });
    rmSync(join(home, "runtime", "native-session-identities.json"), { force: true });

    store.reconcileNativeSessionIdentityLedger();
    const key = JSON.stringify(["codex", "/sessions/shared", "shared-native"]);
    assert.deepEqual(store.nativeSessionIdentityClaims().get(key), {
      state: "owned",
      owner: { scope: "task", taskId: "task-1", roleName: "leader", agentId: "codex" }
    });

    saveTaskRole(store, "task-1", "leader", ["codex"]);
    store.saveRoleSessionSet(sessions);
    rmSync(join(home, "runtime", "native-session-identities.json"), { force: true });
    assert.doesNotThrow(() => store.reconcileNativeSessionIdentityLedger());
    assert.equal(store.nativeSessionIdentityClaims().get(key).state, "owned");
    assert.throws(
      () => store.renameRole(
        "task-1",
        "leader",
        { ...store.getRole("task-1", "leader"), name: "reviewer" }
      ),
      /another trashed Role Agent/i
    );
    assert.notEqual(store.getRole("task-1", "leader"), null);
    assert.equal(store.getRole("task-1", "reviewer"), null);
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("ledger reconciliation rejects conflicting live and trash owners before rebuilding a missing ledger", () => {
  const { store, home } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    store.saveRoleSessionSet(taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", "shared-native", "/sessions/shared")
    ));
    assert.equal(store.deleteTask("task-1"), true);

    saveTaskRole(store, "task-2", "reviewer", ["codex"]);
    const live = taskSession(
      "task-2",
      "reviewer",
      "codex",
      sessionInput("codex", "other-native", "/sessions/other")
    );
    store.saveRoleSessionSet(live);
    live.sessions.codex.nativeSessionId = "shared-native";
    live.sessions.codex.sessionRoot = "/sessions/shared";
    writeFileSync(
      join(home, "runtime", "role-sessions", "tasks", "task-2", "reviewer.json"),
      `${JSON.stringify(live)}\n`
    );
    rmSync(join(home, "runtime", "native-session-identities.json"), { force: true });

    assert.throws(
      () => store.reconcileNativeSessionIdentityLedger(),
      /already owned by another Role Agent/i
    );
    assert.equal(existsSync(join(home, "runtime", "native-session-identities.json")), false);
    assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), true);
    assert.notEqual(store.getTask("task-2"), null);
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("ledger reconciliation rejects retired or other-owner durable claims for physical sessions", async (t) => {
  for (const state of ["retired", "other-owner"]) {
    await t.test(state, () => {
      const { store, home } = fixtureStore();
      try {
        saveTaskRole(store, "task-1", "leader", ["codex"]);
        store.saveRoleSessionSet(taskSession(
          "task-1",
          "leader",
          "codex",
          sessionInput("codex", "native-id", "/sessions/root")
        ));
        const ledgerPath = join(home, "runtime", "native-session-identities.json");
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
        const [identity] = Object.keys(ledger.identities);
        ledger.identities[identity] = state === "retired"
          ? { state: "retired" }
          : {
              state: "owned",
              owner: { scope: "task", taskId: "task-2", roleName: "reviewer", agentId: "codex" }
            };
        writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);

        assert.throws(
          () => store.reconcileNativeSessionIdentityLedger(),
          state === "retired" ? /permanently retired/i : /already owned by another Role Agent/i
        );
        assert.deepEqual(JSON.parse(readFileSync(ledgerPath, "utf8")), ledger);
      } finally {
        store.disposeEphemeralWorkspace();
      }
    });
  }
});

test("import merge preserves monotonic Role Agent lineage for null older extending and divergent snapshots", () => {
  const older = taskSession(
    "task-1",
    "leader",
    "codex",
    sessionInput("codex", "native-1", "/sessions/one")
  );
  const current = recordRoleAgentSession(
    older,
    sessionInput("codex", "native-2", "/sessions/two", "replace one"),
    new Date("2026-07-13T00:01:00.000Z")
  );
  const extending = recordRoleAgentSession(
    current,
    sessionInput("codex", "native-3", "/sessions/three", "replace two"),
    new Date("2026-07-13T00:02:00.000Z")
  );
  const divergent = recordRoleAgentSession(
    older,
    sessionInput("codex", "native-x", "/sessions/x", "diverge"),
    new Date("2026-07-13T00:01:00.000Z")
  );

  assert.deepEqual(mergeImportedRoleSessionSets(current, null), current);
  assert.deepEqual(mergeImportedRoleSessionSets(null, older), older);
  assert.deepEqual(
    mergeImportedRoleSessionSets(current, older).sessions.codex.previousIdentities,
    current.sessions.codex.previousIdentities
  );
  assert.equal(
    mergeImportedRoleSessionSets(older, current).sessions.codex.nativeSessionId,
    "native-2"
  );
  const roundTripped = mergeImportedRoleSessionSets(
    mergeImportedRoleSessionSets(current, older),
    extending
  );
  assert.equal(roundTripped.sessions.codex.nativeSessionId, "native-3");
  assert.equal(roundTripped.sessions.codex.previousIdentities.length, 2);
  assert.throws(
    () => mergeImportedRoleSessionSets(current, divergent),
    /lineage diverges/i
  );

  const { store } = fixtureStore();
  try {
    const role = createGlobalRole("operator", [binding("codex")], "codex", "/repo", now);
    store.saveGlobalRole(role);
    store.saveGlobalRoleSessionSet(older.owner.scope === "task"
      ? { ...older, owner: { scope: "global", roleName: "operator" } }
      : older);
    const imported = { ...extending, owner: { scope: "global", roleName: "operator" } };
    assert.throws(
      () => store.saveGlobalRoleWithSessionSet(role, imported),
      /lineage must be preserved exactly/i
    );
    store.saveGlobalRoleWithSessionSet(role, imported, true);
    assert.equal(store.getGlobalRoleSessionSet("operator").sessions.codex.nativeSessionId, "native-3");
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("startup preflight uses canonical roots and exact Role Agent owner tuples", async (t) => {
  await t.test("symlink aliases are rejected instead of becoming mutable identity keys", () => {
    const { store, home } = fixtureStore();
    try {
      const realRoot = join(home, "native-root");
      const aliasTwo = join(home, "native-alias-two");
      const reviewerRoot = join(home, "reviewer-root");
      mkdirSync(realRoot);
      mkdirSync(reviewerRoot);
      symlinkSync(realRoot, aliasTwo, "dir");
      store.saveGlobalRole(createGlobalRole("leader", [binding("codex")], "codex", "/repo", now));
      store.saveGlobalRole(createGlobalRole("reviewer", [binding("codex")], "codex", "/repo", now));
      store.saveGlobalRoleSessionSet(globalSession(
        "leader",
        "codex",
        sessionInput("codex", "shared-native", realRoot)
      ));
      const reviewer = globalSession(
        "reviewer",
        "codex",
        sessionInput("codex", "reviewer-native", reviewerRoot)
      );
      store.saveGlobalRoleSessionSet(reviewer);
      reviewer.sessions.codex.nativeSessionId = "shared-native";
      reviewer.sessions.codex.sessionRoot = aliasTwo;
      writeFileSync(
        join(home, "runtime", "role-sessions", "global", "reviewer.json"),
        `${JSON.stringify(reviewer)}\n`
      );

      assert.throws(
        () => primeResilientTaskStore(store),
        /Invalid global role session set/i
      );
    } finally {
      store.disposeEphemeralWorkspace();
    }
  });

  await t.test("owner identities cannot collide through delimiter characters", () => {
    const { store, home } = fixtureStore();
    try {
      store.saveGlobalRole(createGlobalRole("a:b", [binding("c")], "c", "/repo", now));
      store.saveGlobalRole(createGlobalRole("a", [binding("b:c")], "b:c", "/repo", now));
      store.saveGlobalRoleSessionSet(globalSession(
        "a:b",
        "c",
        sessionInput("c", "shared-native", "/sessions/shared")
      ));
      const second = globalSession(
        "a",
        "b:c",
        sessionInput("b:c", "other-native", "/sessions/other")
      );
      store.saveGlobalRoleSessionSet(second);
      second.sessions["b:c"].nativeSessionId = "shared-native";
      second.sessions["b:c"].sessionRoot = "/sessions/shared";
      writeFileSync(
        join(home, "runtime", "role-sessions", "global", "a.json"),
        `${JSON.stringify(second)}\n`
      );

      assert.throws(
        () => primeResilientTaskStore(store),
        /native Agent session identity is owned by multiple Role Agents/i
      );
    } finally {
      store.disposeEphemeralWorkspace();
    }
  });
});

test("replacement history preserves the exact old adapter root and native id tuple", () => {
  let sessions = taskSession(
    "task-1",
    "leader",
    "codex",
    sessionInput("codex", "native-old", "/sessions/old")
  );
  sessions = recordRoleAgentSession(
    sessions,
    sessionInput("codex", "native-new", "/sessions/new", "explicit replacement"),
    new Date("2026-07-13T00:01:00.000Z")
  );

  assert.equal("previousSessionIds" in sessions.sessions.codex, false);
  assert.deepEqual(sessions.sessions.codex.previousIdentities, [{
    adapterId: "codex",
    sessionRoot: "/sessions/old",
    nativeSessionId: "native-old"
  }]);
  const crossAdapterHistory = structuredClone(sessions);
  crossAdapterHistory.sessions.codex.previousIdentities[0].adapterId = "claude";
  assert.throws(
    () => recordRoleAgentSession(
      crossAdapterHistory,
      sessionInput("codex", "native-new", "/sessions/new"),
      new Date("2026-07-13T00:02:00.000Z")
    ),
    /history adapter is inconsistent/i
  );

  const { store } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    store.saveRoleSessionSet(sessions);
    saveTaskRole(store, "task-2", "reviewer", ["codex"]);
    assert.throws(
      () => store.saveRoleSessionSet(taskSession(
        "task-2",
        "reviewer",
        "codex",
        sessionInput("codex", "native-old", "/sessions/old")
      )),
      /already owned by another Role Agent/i
    );
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("one Role cannot transfer a native tuple between two Agent bindings", () => {
  const { store } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex-a", "codex-b"], "codex-b");
    const original = taskSession(
      "task-1",
      "leader",
      "codex-b",
      sessionInput("codex-a", "shared-native", "/sessions/shared")
    );
    store.saveRoleSessionSet(original);

    assert.throws(
      () => store.saveRoleSessionSet(taskSession(
        "task-1",
        "leader",
        "codex-b",
        sessionInput("codex-b", "shared-native", "/sessions/shared")
      )),
      /identity lineage cannot be removed/i
    );
    assert.throws(
      () => store.saveRoleSessionSet(recordRoleAgentSession(
        original,
        sessionInput("codex-b", "shared-native", "/sessions/shared"),
        new Date("2026-07-13T00:01:00.000Z")
      )),
      /already owned by another Role Agent/i
    );
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("Role rename transfers current and historical tuples without changing Agent ownership", () => {
  const { store } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    let sessions = taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", "native-old", "/sessions/old")
    );
    sessions = recordRoleAgentSession(
      sessions,
      sessionInput("codex", "native-new", "/sessions/new", "explicit replacement"),
      new Date("2026-07-13T00:01:00.000Z")
    );
    store.saveRoleSessionSet(sessions);
    const current = store.getRole("task-1", "leader");
    store.renameRole("task-1", "leader", { ...current, name: "reviewer" });

    const claims = [...store.nativeSessionIdentityClaims().entries()]
      .filter(([key]) => ["native-old", "native-new"].includes(JSON.parse(key)[2]));
    assert.equal(claims.length, 2);
    for (const [, claim] of claims) {
      assert.deepEqual(claim, {
        state: "owned",
        owner: { scope: "task", taskId: "task-1", roleName: "reviewer", agentId: "codex" }
      });
    }
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("pruning an old trash incarnation does not retire a tuple held by the live recreation", () => {
  const { store } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    const sessions = taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", "reused-native", "/sessions/reused")
    );
    store.saveRoleSessionSet(sessions);
    assert.equal(store.deleteTask("task-1"), true);

    saveTaskRole(store, "task-1", "leader", ["codex"]);
    store.saveRoleSessionSet(sessions);
    assert.equal(store.pruneTrashedTasks(), 1);

    const identity = JSON.stringify(["codex", "/sessions/reused", "reused-native"]);
    assert.deepEqual(store.nativeSessionIdentityClaims().get(identity), {
      state: "owned",
      owner: { scope: "task", taskId: "task-1", roleName: "leader", agentId: "codex" }
    });
    assert.doesNotThrow(() => store.saveRoleSessionSet(store.getRoleSessionSet("task-1", "leader")));
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("restore identity preflight rejects conflicts before moving any task data", () => {
  const { store, home } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    store.saveRoleSessionSet(taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", "trash-native", "/sessions/trash")
    ));
    assert.equal(store.deleteTask("task-1"), true);

    saveTaskRole(store, "task-2", "reviewer", ["codex"]);
    const conflicting = taskSession(
      "task-2",
      "reviewer",
      "codex",
      sessionInput("codex", "live-native", "/sessions/live")
    );
    store.saveRoleSessionSet(conflicting);
    const trashedSessions = {
      ...conflicting,
      owner: { scope: "task", taskId: "task-1", roleName: "leader" }
    };
    writeFileSync(
      join(home, "trash", "tasks", "task-1", "role-sessions", "leader.json"),
      `${JSON.stringify(trashedSessions)}\n`
    );

    assert.throws(() => store.restoreTask("task-1"), /already owned by another Role Agent/i);
    assert.equal(store.getTask("task-1"), null);
    assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), true);
    assert.equal(store.getTask("task-2").id, "task-2");
    assert.equal(store.getRoleSessionSet("task-2", "reviewer").sessions.codex.nativeSessionId, "live-native");
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("storage rejects legacy SessionSet v2 and identity-lineage regression without partial writes", () => {
  const { store, home } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    const original = taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", "native-old", "/sessions/old")
    );
    store.saveRoleSessionSet(original);
    const sessionPath = join(home, "runtime", "role-sessions", "tasks", "task-1", "leader.json");
    const legacy = structuredClone(original);
    legacy.schemaVersion = 2;
    legacy.sessions.codex.schemaVersion = 2;
    legacy.sessions.codex.previousSessionIds = [];
    delete legacy.sessions.codex.previousIdentities;
    writeFileSync(sessionPath, `${JSON.stringify(legacy)}\n`);
    assert.throws(() => store.getRoleSessionSet("task-1", "leader"), /Invalid role session set/);

    writeFileSync(sessionPath, `${JSON.stringify(original)}\n`);
    const regressed = structuredClone(original);
    regressed.sessions.codex.nativeSessionId = "native-new";
    regressed.sessions.codex.sessionRoot = "/sessions/new";
    regressed.sessions.codex.updatedAt = "2026-07-13T00:01:00.000Z";
    regressed.updatedAt = "2026-07-13T00:01:00.000Z";
    assert.throws(
      () => store.saveRoleSessionSet(regressed),
      /identity lineage must be preserved exactly/i
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(store.getRoleSessionSet("task-1", "leader"))),
      JSON.parse(JSON.stringify(original))
    );
    const claims = store.nativeSessionIdentityClaims();
    assert.equal([...claims.keys()].some((key) => JSON.parse(key)[2] === "native-new"), false);
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("prune fails closed on a conflicting ledger owner before deleting trash", () => {
  const { store, home } = fixtureStore();
  try {
    saveTaskRole(store, "task-1", "leader", ["codex"]);
    store.saveRoleSessionSet(taskSession(
      "task-1",
      "leader",
      "codex",
      sessionInput("codex", "trash-native", "/sessions/trash")
    ));
    assert.equal(store.deleteTask("task-1"), true);
    const ledgerPath = join(home, "runtime", "native-session-identities.json");
    const before = JSON.parse(readFileSync(ledgerPath, "utf8"));
    const identity = Object.keys(before.identities).find((key) => JSON.parse(key)[2] === "trash-native");
    before.identities[identity] = {
      state: "owned",
      owner: { scope: "task", taskId: "task-2", roleName: "reviewer", agentId: "codex" }
    };
    writeFileSync(ledgerPath, `${JSON.stringify(before)}\n`);

    assert.throws(() => store.pruneTrashedTasks(), /conflicts with trashed Role Agent ownership/i);
    assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), true);
    assert.deepEqual(JSON.parse(readFileSync(ledgerPath, "utf8")), before);
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("selective trash pruning retires only the selected task session identities", () => {
  const { store, home } = fixtureStore();
  try {
    for (const [taskId, roleName, nativeId] of [
      ["task-1", "leader", "native-one"],
      ["task-2", "reviewer", "native-two"]
    ]) {
      saveTaskRole(store, taskId, roleName, ["codex"]);
      store.saveRoleSessionSet(taskSession(
        taskId,
        roleName,
        "codex",
        sessionInput("codex", nativeId, `/sessions/${nativeId}`)
      ));
      assert.equal(store.deleteTask(taskId), true);
    }

    assert.equal(store.pruneTrashedTasks(["task-1"]), 1);
    assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), false);
    assert.equal(existsSync(join(home, "trash", "tasks", "task-2")), true);
    assert.equal(store.nativeSessionIdentityClaims().get(
      JSON.stringify(["codex", "/sessions/native-one", "native-one"])
    ).state, "retired");
    assert.equal(store.nativeSessionIdentityClaims().get(
      JSON.stringify(["codex", "/sessions/native-two", "native-two"])
    ).state, "owned");
  } finally {
    store.disposeEphemeralWorkspace();
  }
});
