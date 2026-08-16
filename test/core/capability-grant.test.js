import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  checkGrant,
  createCapabilityGrant,
  recordGrantUse,
  revokeGrant
} from "../../dist/grant/capabilityGrant.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { installOperatorSession } from "../helpers/operatorSession.js";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-capability-grant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  // Grant issue/revoke require the authenticated Operator origin.
  const operator = installOperatorSession(store, agent, NOW);
  return { root, store, operator };
}

function createTask(store) {
  const result = runTaskCommand(["create", "Capability grant test"], store, { now: () => NOW });
  return result.data.task;
}

// ---------------------------------------------------------------------------
// Domain unit tests
// ---------------------------------------------------------------------------

test("checkGrant allows a matching request", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "reversible"
  }, NOW);
  const decision = checkGrant(grant, { action: "npm-publish" }, NOW);
  assert.equal(decision.allowed, true);
});

test("checkGrant denies a revoked grant", () => {
  const grant = revokeGrant(
    createCapabilityGrant("capability-grant-1", "task-1", {
      granter: "alice",
      actions: ["npm-publish"]
    }, NOW),
    "bob",
    NOW
  );
  const decision = checkGrant(grant, { action: "npm-publish" }, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "grant-revoked");
});

test("checkGrant denies an expired grant", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    expiresAt: new Date(NOW.getTime() - 1000).toISOString()
  }, NOW);
  const decision = checkGrant(grant, { action: "npm-publish" }, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "grant-expired");
});

test("checkGrant denies an exhausted grant", () => {
  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    maxUses: 1
  }, NOW);
  grant = recordGrantUse(grant, NOW);
  const decision = checkGrant(grant, { action: "npm-publish" }, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "grant-uses-exhausted");
});

test("checkGrant denies an action not in the grant", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"]
  }, NOW);
  const decision = checkGrant(grant, { action: "git-tag" }, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "grant-action-not-allowed");
});

test("checkGrant denies when a bounded parameter is missing", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    parameterBounds: { channel: ["stable", "beta"] }
  }, NOW);
  const decision = checkGrant(grant, { action: "npm-publish" }, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "grant-parameter-missing");
});

test("checkGrant denies when a parameter value is not allowed", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    parameterBounds: { channel: ["stable", "beta"] }
  }, NOW);
  const decision = checkGrant(grant, {
    action: "npm-publish",
    params: { channel: "edge" }
  }, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "grant-parameter-value-not-allowed");
});

test("checkGrant denies when irreversibility exceeds the ceiling", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "reversible"
  }, NOW);
  const decision = checkGrant(grant, {
    action: "npm-publish",
    irreversibility: "irreversible"
  }, NOW);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "grant-irreversibility-exceeds-ceiling");
});

test("checkGrant allows irreversibility at the ceiling", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "reversible"
  }, NOW);
  const decision = checkGrant(grant, {
    action: "npm-publish",
    irreversibility: "reversible"
  }, NOW);
  assert.equal(decision.allowed, true);
});

test("recordGrantUse increments and throws past maxUses", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    maxUses: 1
  }, NOW);
  const used = recordGrantUse(grant, NOW);
  assert.equal(used.usesUsed, 1);
  assert.throws(() => recordGrantUse(used, NOW), /exhausted/);
});

test("revokeGrant is idempotent", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"]
  }, NOW);
  const revoked = revokeGrant(grant, "bob", NOW);
  assert.equal(revoked.revokedBy, "bob");
  assert.ok(revoked.revokedAt);
  const again = revokeGrant(revoked, "carol", NOW);
  assert.equal(again, revoked);
  assert.equal(again.revokedBy, "bob");
});

test("createCapabilityGrant rejects empty actions", () => {
  assert.throws(() => createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: []
  }, NOW), /non-empty/);
});

test("createCapabilityGrant rejects a bad irreversibility ceiling", () => {
  assert.throws(() => createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "invalid"
  }, NOW), /invalid/);
});

test("createCapabilityGrant rejects maxUses of zero", () => {
  assert.throws(() => createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    maxUses: 0
  }, NOW), /positive/);
});

test("createCapabilityGrant rejects a non-timestamp expiresAt", () => {
  assert.throws(() => createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    expiresAt: "not-a-timestamp"
  }, NOW), /timestamp/);
});

test("createCapabilityGrant defaults scope to the owning Task", () => {
  const grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"]
  }, NOW);
  assert.deepEqual(grant.scope, { taskId: "task-1" });
});

// ---------------------------------------------------------------------------
// Storage round-trip tests
// ---------------------------------------------------------------------------

test("capability grant storage round-trip survives reopen", (t) => {
  const { root, store, operator } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW, environment: operator.environment };

  const first = runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--max-uses", "3"
  ], store, options);
  assert.equal(first.data.id, "capability-grant-1");

  const second = runTaskCommand([
    "grant", "issue", task.id,
    "--action", "git-tag"
  ], store, options);
  assert.equal(second.data.id, "capability-grant-2");

  // Record a use on the first grant and revoke the second.
  const used = recordGrantUse(first.data, NOW);
  store.saveCapabilityGrant(task.id, used);
  const revoked = revokeGrant(second.data, operator.granter, NOW);
  store.saveCapabilityGrant(task.id, revoked);

  // Re-open a second FileTaskStore on the same root.
  const reopened = new FileTaskStore(root);
  const grants = reopened.listCapabilityGrants(task.id);
  assert.equal(grants.length, 2);

  const grant1 = reopened.getCapabilityGrant(task.id, "capability-grant-1");
  assert.ok(grant1);
  assert.equal(grant1.usesUsed, 1);
  assert.equal(grant1.maxUses, 3);
  assert.equal(grant1.granter, operator.granter);
  assert.deepEqual(grant1.actions, ["npm-publish"]);

  const grant2 = reopened.getCapabilityGrant(task.id, "capability-grant-2");
  assert.ok(grant2);
  assert.ok(grant2.revokedAt);
  assert.equal(grant2.revokedBy, operator.granter);
  assert.equal(grant2.granter, operator.granter);
  assert.deepEqual(grant2.actions, ["git-tag"]);
});

// ---------------------------------------------------------------------------
// CLI envelope tests
// ---------------------------------------------------------------------------

test("capability grant CLI issue show list revoke", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW, environment: operator.environment };

  // Issue with multiple actions and max-uses.
  const issued = runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--action", "git-tag",
    "--max-uses", "3"
  ], store, options);
  assert.equal(issued.kind, "output");
  assert.equal(issued.data.id, "capability-grant-1");
  assert.equal(issued.data.granter, operator.granter);
  assert.equal(issued.data.usesUsed, 0);
  assert.equal(issued.data.maxUses, 3);
  assert.deepEqual(issued.data.actions, ["npm-publish", "git-tag"]);
  assert.ok(issued.output.includes("Granted capability-grant-1"));

  // Show.
  const shown = runTaskCommand(
    ["grant", "show", task.id, "capability-grant-1"],
    store,
    options
  );
  assert.equal(shown.kind, "output");
  assert.equal(shown.data.id, "capability-grant-1");
  assert.ok(shown.output.includes(`Granter: ${operator.granter}`));

  // Issue a second grant.
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "deploy"
  ], store, options);

  // List returns an array of 2.
  const listed = runTaskCommand(["grant", "list", task.id], store, options);
  assert.equal(listed.kind, "output");
  assert.ok(Array.isArray(listed.data));
  assert.equal(listed.data.length, 2);

  // Revoke.
  const revoked = runTaskCommand(
    ["grant", "revoke", task.id, "capability-grant-1"],
    store,
    options
  );
  assert.equal(revoked.kind, "output");
  assert.equal(revoked.data.revokedBy, operator.granter);
  assert.ok(revoked.data.revokedAt);
  assert.ok(revoked.output.includes("Revoked capability-grant-1"));

  // Second revoke stays idempotent.
  const again = runTaskCommand(
    ["grant", "revoke", task.id, "capability-grant-1"],
    store,
    options
  );
  assert.equal(again.kind, "output");
  assert.equal(again.data.revokedBy, operator.granter);

  // Missing grant on show throws.
  assert.throws(
    () => runTaskCommand(
      ["grant", "show", task.id, "capability-grant-999"],
      store,
      options
    ),
    /not found/
  );
});

test("capability grant issue with full scope and parameters", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW, environment: operator.environment };

  const result = runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--scope-project", "proj-1",
    "--scope-project", "proj-2",
    "--scope-repo", "owner/repo",
    "--scope-package", "pkg-1",
    "--scope-home", "/home/user",
    "--param", "channel=stable,beta",
    "--param", "env=prod",
    "--expires-at", "2026-12-31T23:59:59.000Z",
    "--max-uses", "5",
    "--irreversibility-ceiling", "irreversible"
  ], store, options);

  assert.equal(result.kind, "output");
  assert.equal(result.data.id, "capability-grant-1");
  assert.equal(result.data.granter, operator.granter);
  assert.deepEqual(result.data.scope.projectIds, ["proj-1", "proj-2"]);
  assert.deepEqual(result.data.scope.repositories, [{ owner: "owner", name: "repo" }]);
  assert.deepEqual(result.data.scope.packages, ["pkg-1"]);
  assert.equal(result.data.scope.homePath, "/home/user");
  assert.deepEqual(result.data.parameterBounds, {
    channel: ["stable", "beta"],
    env: ["prod"]
  });
  assert.equal(result.data.expiresAt, "2026-12-31T23:59:59.000Z");
  assert.equal(result.data.maxUses, 5);
  assert.equal(result.data.irreversibilityCeiling, "irreversible");
});

test("capability grant list empty state", (t) => {
  const { store } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW };

  const result = runTaskCommand(["grant", "list", task.id], store, options);
  assert.equal(result.kind, "output");
  assert.ok(result.output.includes("No capability grants found."));
  assert.ok(Array.isArray(result.data));
  assert.equal(result.data.length, 0);
});

test("capability grant issue rejects a caller without the operator session", (t) => {
  const { store } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW };

  // A clean environment is not user authority: the caller must present the
  // authenticated global Operator session.
  assert.throws(
    () => runTaskCommand([
      "grant", "issue", task.id,
      "--action", "npm-publish"
    ], store, options),
    /operator session|managed Agent|user authority/i
  );
  assert.equal(store.listCapabilityGrants(task.id).length, 0);

  // A Task-scoped managed Agent is refused too.
  assert.throws(
    () => runTaskCommand([
      "grant", "issue", task.id,
      "--action", "npm-publish"
    ], store, {
      ...options,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "reviewer",
        YUI_RUN_ID: "agent-run-review"
      }
    }),
    /operator session|managed Agent|user authority/i
  );
  assert.equal(store.listCapabilityGrants(task.id).length, 0);
});

test("capability grant issue rejects missing action", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW, environment: operator.environment };

  assert.throws(
    () => runTaskCommand([
      "grant", "issue", task.id
    ], store, options),
    /action is required/i
  );
});

test("capability grant revoke rejects a caller without the operator session", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW, environment: operator.environment };

  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish"
  ], store, options);

  // A clean environment cannot revoke a grant either.
  assert.throws(
    () => runTaskCommand(
      ["grant", "revoke", task.id, "capability-grant-1"],
      store,
      { now: () => NOW }
    ),
    /operator session|managed Agent|user authority/i
  );
  assert.equal(
    store.getCapabilityGrant(task.id, "capability-grant-1").revokedAt,
    undefined
  );
});

// ---------------------------------------------------------------------------
// Audit event tests
// ---------------------------------------------------------------------------

test("capability grant issue and revoke emit audit events", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW, environment: operator.environment };

  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish"
  ], store, options);

  runTaskCommand([
    "grant", "revoke", task.id, "capability-grant-1"
  ], store, options);

  const events = store.listEvents(task.id);
  const issued = events.find((e) => e.type === "capability-grant.issued");
  assert.ok(issued, "capability-grant.issued event should exist");
  assert.equal(issued.payload.grantId, "capability-grant-1");
  assert.equal(issued.payload.granter, operator.granter);
  assert.ok(issued.payload.actions.includes("npm-publish"));
  assert.ok(issued.payload.scope);

  const revoked = events.find((e) => e.type === "capability-grant.revoked");
  assert.ok(revoked, "capability-grant.revoked event should exist");
  assert.equal(revoked.payload.grantId, "capability-grant-1");
  assert.equal(revoked.payload.revokedBy, operator.granter);
});

test("capability grant idempotent re-revoke does not duplicate audit event", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  const options = { now: () => NOW, environment: operator.environment };

  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish"
  ], store, options);

  runTaskCommand([
    "grant", "revoke", task.id, "capability-grant-1"
  ], store, options);

  // Idempotent re-revoke.
  runTaskCommand([
    "grant", "revoke", task.id, "capability-grant-1"
  ], store, options);

  const events = store.listEvents(task.id);
  const revokedEvents = events.filter((e) => e.type === "capability-grant.revoked");
  assert.equal(revokedEvents.length, 1);
});
