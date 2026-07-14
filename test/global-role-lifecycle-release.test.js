import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as globalRoleCommands from "../dist/commands/globalRoleCommands.js";
import {
  clearRuntimeOperationClaim,
  readGlobalRoleRuntimeOperationClaim,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim
} from "../dist/executor/roleRuntimeOperationClaim.js";
import { createGlobalRole } from "../dist/role/role.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

const require = createRequire(import.meta.url);
const authoritativeTransactionTest = canUseAuthoritativeTransactionLock() ? test : test.skip;
const now = new Date("2026-07-13T00:00:00.000Z");
const later = new Date("2026-07-13T00:01:00.000Z");

function canUseAuthoritativeTransactionLock() {
  try {
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    database.exec("BEGIN IMMEDIATE; ROLLBACK;");
    database.close();
    return true;
  } catch {
    return false;
  }
}

function binding() {
  return { agentId: "codex", adapterId: "codex", config: { adapterId: "codex" } };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "taskmux-global-role-operation-"));
  const seed = FileTaskStore.forDomainTransactionWorkspace(home);
  const role = createGlobalRole("reviewer", [binding()], "codex", "/repo", now);
  seed.saveGlobalRole(role);
  return { home, role, store: new FileTaskStore(home) };
}

function preparedClaim(role, overrides = {}) {
  const preparedState = { role, sessionSet: null, activeRun: null };
  return {
    schemaVersion: 1,
    scope: "global-role",
    kind: "global-role-mutation",
    token: randomUUID(),
    taskId: null,
    roleName: role.name,
    operation: "update",
    ownerPid: process.pid,
    preparedSession: null,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(preparedState),
    recoveryToken: null,
    createdAt: now.toISOString(),
    leaseExpiresAt: later.toISOString(),
    phase: "prepared",
    preparedState,
    ...overrides
  };
}

test("GlobalRole prepared release requires the exact token and unclaimed recovery ownership", () => {
  const role = createGlobalRole("reviewer", [binding()], "codex", "/repo", now);
  const expected = preparedClaim(role);
  assert.equal(globalRoleCommands.isExactPreparedGlobalRoleMutationClaim(expected, expected), true);
  assert.equal(globalRoleCommands.isExactPreparedGlobalRoleMutationClaim(
    expected,
    { ...expected, token: randomUUID() }
  ), false);
  assert.equal(globalRoleCommands.isExactPreparedGlobalRoleMutationClaim(
    expected,
    { ...expected, recoveryToken: randomUUID() }
  ), false);
  assert.equal(globalRoleCommands.isExactPreparedGlobalRoleMutationClaim(expected, null), false);
});

test("GlobalRole claim codec rejects phase drift instead of treating it as releasable", () => {
  const { home, role } = fixture();
  try {
    const claim = preparedClaim(role);
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    const claimFile = join(home, "runtime", "role-runtime-operations", "global-roles", "reviewer.json");
    const persisted = JSON.parse(readFileSync(claimFile, "utf8"));
    writeFileSync(claimFile, `${JSON.stringify({ ...persisted, phase: "effect-started" }, null, 2)}\n`);

    assert.throws(
      () => readGlobalRoleRuntimeOperationClaim(home, "reviewer"),
      /Invalid GlobalRole runtime operation claim/i
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const operation of ["update", "remove"]) {
  authoritativeTransactionTest(`${operation} releases its exact prepared GlobalRole claim when finalize throws`, () => {
    const { home, store } = fixture();
    try {
      store.runDomainTransaction = () => {
        throw new Error("finalize transaction failed");
      };
      const command = operation === "update"
        ? ["update", "reviewer", "--workspace", "/updated"]
        : ["remove", "reviewer"];
      const options = operation === "remove"
        ? { tmux: { probeRoleStatus() { return "exited"; } } }
        : {};

      assert.throws(
        () => globalRoleCommands.runGlobalRoleCommand(command, store, options),
        /finalize transaction failed/i
      );
      assert.equal(readGlobalRoleRuntimeOperationClaim(home, "reviewer"), null);
      assert.equal(store.getGlobalRole("reviewer").workspace, "/repo");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

authoritativeTransactionTest("failed GlobalRole finalize never clears a foreign replacement token", () => {
  const { home, store } = fixture();
  let foreignToken;
  try {
    store.runDomainTransaction = () => {
      const owned = readGlobalRoleRuntimeOperationClaim(home, "reviewer");
      clearRuntimeOperationClaim(home, { scope: "global-role", roleName: "reviewer" }, owned.token);
      const foreign = { ...owned, token: randomUUID() };
      foreignToken = foreign.token;
      writeRoleRuntimeOperationClaim(home, foreign, foreign.expectedStateDigest);
      throw new Error("finalize ownership changed");
    };

    assert.throws(
      () => globalRoleCommands.runGlobalRoleCommand(["update", "reviewer", "--workspace", "/updated"], store),
      /ownership changed|does not own|token/i
    );
    assert.equal(readGlobalRoleRuntimeOperationClaim(home, "reviewer").token, foreignToken);
    assert.equal(store.getGlobalRole("reviewer").workspace, "/repo");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

authoritativeTransactionTest("failed GlobalRole finalize preserves invalid phase drift for strict recovery", () => {
  const { home, store } = fixture();
  const claimFile = join(home, "runtime", "role-runtime-operations", "global-roles", "reviewer.json");
  try {
    store.runDomainTransaction = () => {
      const persisted = JSON.parse(readFileSync(claimFile, "utf8"));
      writeFileSync(claimFile, `${JSON.stringify({ ...persisted, phase: "effect-started" }, null, 2)}\n`);
      throw new Error("finalize phase changed");
    };

    assert.throws(
      () => globalRoleCommands.runGlobalRoleCommand(["update", "reviewer", "--workspace", "/updated"], store),
      /Invalid GlobalRole runtime operation claim/i
    );
    assert.equal(JSON.parse(readFileSync(claimFile, "utf8")).phase, "effect-started");
    assert.equal(store.getGlobalRole("reviewer").workspace, "/repo");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
