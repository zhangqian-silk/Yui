import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Round-9 P1 reproduction: a managed Agent must not be able to mint an
// irreversible grant by clearing its child environment, and must not be able
// to revoke one either. Grant issue/revoke require the authenticated global
// Operator session; the recorded granter/revoker is bound to that session.
//
// All stores are disposable temp directories. No npm, GitHub, Controller, or
// real Home is touched.

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { installOperatorSession } from "../test/helpers/operatorSession.js";

const NOW = new Date("2026-08-15T00:00:00.000Z");
const AUTH_ERROR = /operator|user authorization|managed agent/i;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-task15-round9-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const task = runTaskCommand(["create", "round 9 grant origin"], store, {
    now: () => NOW
  }).data.task;
  const operator = installOperatorSession(store, agent, NOW);
  return { root, store, task, operator };
}

function issueArgs(taskId, extra = []) {
  return [
    "grant", "issue", taskId,
    "--action", "npm-publish",
    "--irreversibility-ceiling", "irreversible",
    ...extra
  ];
}

// The managed Agent's own runtime identity, exactly as the launcher exports it.
const managedEnv = (taskId) => ({
  YUI_SESSION_SCOPE: "task",
  YUI_TASK_ID: taskId,
  YUI_ROLE: "worker",
  YUI_RUN_ID: "agent-run-50",
  YUI_AGENT_ID: "codex",
  YUI_ADAPTER_ID: "codex",
  YUI_LAUNCH_ID: "managed-launch-1",
  YUI_NATIVE_SESSION_ID: "managed-native-1"
});

test("round9 P1: a managed Agent cannot self-issue an irreversible grant by clearing its environment", (t) => {
  const { store, task } = fixture(t);

  // The child scrubs every YUI_* variable before invoking the CLI.
  assert.throws(() => runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: {}
  }), AUTH_ERROR);
  assert.equal(store.listCapabilityGrants(task.id).length, 0,
    "no grant may be persisted from a scrubbed environment");
});

test("round9 P1: a managed Agent cannot self-issue with its own task-scoped identity", (t) => {
  const { store, task } = fixture(t);

  assert.throws(() => runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: managedEnv(task.id)
  }), AUTH_ERROR);
  assert.equal(store.listCapabilityGrants(task.id).length, 0);
});

test("round9 P1: a managed Agent cannot self-revoke a grant with a cleared environment", (t) => {
  const { store, task, operator } = fixture(t);
  const issued = runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: operator.environment
  }).data;

  assert.throws(() => runTaskCommand(
    ["grant", "revoke", task.id, issued.id],
    store,
    { now: () => NOW, environment: {} }
  ), AUTH_ERROR);

  const grant = store.getCapabilityGrant(task.id, issued.id);
  assert.equal(grant.revokedAt, undefined, "the grant must remain active");
  assert.equal(grant.revokedBy, undefined);
});

test("round9 P1: a managed Agent cannot self-revoke with its task-scoped identity", (t) => {
  const { store, task, operator } = fixture(t);
  const issued = runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: operator.environment
  }).data;

  assert.throws(() => runTaskCommand(
    ["grant", "revoke", task.id, issued.id],
    store,
    { now: () => NOW, environment: managedEnv(task.id) }
  ), AUTH_ERROR);

  const grant = store.getCapabilityGrant(task.id, issued.id);
  assert.equal(grant.revokedAt, undefined);
});

test("round9 P1: a partial global identity is not an Operator origin", (t) => {
  const { store, task, operator } = fixture(t);

  // Claims the global operator scope but omits the launch envelope a managed
  // child could not know... and even a full envelope is verified below.
  for (const partial of [
    { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator" },
    { ...operator.environment, YUI_LAUNCH_ID: undefined },
    { ...operator.environment, YUI_AGENT_ID: undefined, YUI_ADAPTER_ID: undefined }
  ]) {
    assert.throws(() => runTaskCommand(issueArgs(task.id), store, {
      now: () => NOW,
      environment: partial
    }), AUTH_ERROR);
  }
  assert.equal(store.listCapabilityGrants(task.id).length, 0);
});

test("round9 P1: a forged or stale global launch binding is refused", (t) => {
  const { store, task, operator } = fixture(t);

  // Same agent/adapter, but a launch generation the durable session does not
  // bind: the env shape of an Operator with a stolen agent id.
  assert.throws(() => runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: { ...operator.environment, YUI_LAUNCH_ID: "forged-launch-9" }
  }), AUTH_ERROR);
  // A native session the live binding never recorded.
  assert.throws(() => runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: { ...operator.environment, YUI_NATIVE_SESSION_ID: "forged-native-9" }
  }), AUTH_ERROR);
  // An unbound agent entirely.
  assert.throws(() => runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: { ...operator.environment, YUI_AGENT_ID: "intruder", YUI_ADAPTER_ID: "intruder" }
  }), AUTH_ERROR);
  assert.equal(store.listCapabilityGrants(task.id).length, 0);
});

test("round9 P1: the authenticated Operator session issues with an origin-bound granter", (t) => {
  const { store, task, operator } = fixture(t);

  const issued = runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: operator.environment
  }).data;

  assert.equal(issued.granter, operator.granter,
    "the recorded granter is bound to the Operator session, not a flag");
  assert.equal(issued.irreversibilityCeiling, "irreversible");
  assert.equal(store.listCapabilityGrants(task.id).length, 1);
});

test("round9 P1: the authenticated Operator session revokes with an origin-bound revoker", (t) => {
  const { store, task, operator } = fixture(t);
  const issued = runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: operator.environment
  }).data;

  const revoked = runTaskCommand(
    ["grant", "revoke", task.id, issued.id],
    store,
    { now: () => NOW, environment: operator.environment }
  ).data;

  assert.equal(revoked.revokedBy, operator.granter);
  assert.notEqual(store.getCapabilityGrant(task.id, issued.id).revokedAt, undefined);
});

test("round9 P1: --granter and --by are no longer accepted identity channels", (t) => {
  const { store, task, operator } = fixture(t);

  assert.throws(() => runTaskCommand(
    issueArgs(task.id, ["--granter", "spoofed-user"]),
    store,
    { now: () => NOW, environment: operator.environment }
  ), /unsupported option/i);

  const issued = runTaskCommand(issueArgs(task.id), store, {
    now: () => NOW,
    environment: operator.environment
  }).data;
  assert.throws(() => runTaskCommand(
    ["grant", "revoke", task.id, issued.id, "--by", "spoofed-user"],
    store,
    { now: () => NOW, environment: operator.environment }
  ), /unsupported option/i);
});
