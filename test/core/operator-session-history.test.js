import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  listOperatorSessions,
  operatorSessionRef,
  prepareOperatorNewSession,
  prepareOperatorResumeSession
} from "../../dist/operator/operatorSessionHistory.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  applyOperatorSessionControl,
  runOperatorCommand
} from "../../dist/commands/operatorCommands.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const FIRST = new Date("2026-07-28T01:00:00.000Z");
const SECOND = new Date("2026-07-28T02:00:00.000Z");
const THIRD = new Date("2026-07-28T03:00:00.000Z");

function record(set, input, now) {
  return recordRoleAgentSession(set, {
    policy: "fixed",
    status: "stopped",
    ...input
  }, now);
}

test("Operator new archives the target Agent current session without disturbing other Agents", () => {
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    "codex",
    FIRST
  );
  sessions = record(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-1",
    preview: "Design Operator history"
  }, FIRST);
  sessions = record(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-native-1",
    title: "Review archive workflow"
  }, SECOND);

  const updated = prepareOperatorNewSession(sessions, "codex", THIRD);
  const archivedRef = operatorSessionRef({
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-1"
  });

  assert.equal(updated.activeAgentId, "codex");
  assert.equal(updated.sessions.codex, undefined);
  assert.equal(updated.sessions.claude.nativeSessionId, "claude-native-1");
  assert.equal(updated.history[archivedRef].preview, "Design Operator history");
  assert.equal(updated.history[archivedRef].status, "stopped");
});

test("Operator resume swaps one historical session into the Agent current pointer", () => {
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    "codex",
    FIRST
  );
  sessions = record(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-1",
    preview: "First conversation"
  }, FIRST);
  sessions = prepareOperatorNewSession(sessions, "codex", SECOND);
  sessions = record(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-2",
    preview: "Second conversation"
  }, SECOND);

  const firstRef = operatorSessionRef({
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-1"
  });
  const secondRef = operatorSessionRef({
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-2"
  });
  const updated = prepareOperatorResumeSession(sessions, firstRef, THIRD);

  assert.equal(updated.activeAgentId, "codex");
  assert.equal(updated.sessions.codex.nativeSessionId, "codex-native-1");
  assert.equal(updated.sessions.codex.preview, "First conversation");
  assert.equal(updated.history[firstRef], undefined);
  assert.equal(updated.history[secondRef].preview, "Second conversation");
  assert.equal(updated.history[secondRef].status, "stopped");
});

test("Operator sessions are listed by update time with readable identity and opaque refs", () => {
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    "codex",
    FIRST
  );
  sessions = record(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-1",
    preview: "Design Operator history"
  }, FIRST);
  sessions = record(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-native-1",
    title: "Review archive workflow"
  }, SECOND);

  const listed = listOperatorSessions(sessions);

  assert.deepEqual(listed.map(({ agentId, adapterId, displayTitle, state }) => ({
    agentId,
    adapterId,
    displayTitle,
    state
  })), [
    {
      agentId: "claude",
      adapterId: "claude",
      displayTitle: "Review archive workflow",
      state: "current"
    },
    {
      agentId: "codex",
      adapterId: "codex",
      displayTitle: "Design Operator history",
      state: "current"
    }
  ]);
  assert.match(listed[0].ref, /^op-/);
  assert.equal(JSON.stringify(listed).includes("claude-native-1"), false);
});

test("untitled Claude histories receive distinct stable display identities", () => {
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    "claude",
    FIRST
  );
  sessions = record(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-native-1"
  }, FIRST);
  sessions = prepareOperatorNewSession(sessions, "claude", SECOND);
  sessions = record(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-native-2"
  }, SECOND);
  sessions = prepareOperatorNewSession(sessions, "claude", THIRD);

  const titles = listOperatorSessions(sessions).map(({ displayTitle }) => displayTitle);

  assert.equal(titles.length, 2);
  assert.equal(new Set(titles).size, 2);
  assert.ok(titles.every((title) => /^Claude session · [a-f0-9]{8}$/u.test(title)));
});

test("Operator session metadata cannot inject terminal control sequences", () => {
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    "codex",
    FIRST
  );
  sessions = record(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-safe",
    title: "Plan\u001b]52;c;clipboard-payload\u0007 safely",
    preview: "\u001b[31mReview changes\u001b[0m"
  }, FIRST);

  const result = runOperatorCommand(["list"], {
    getGlobalRoleSessionSet: () => sessions
  }, {
    now: () => SECOND,
    width: 100
  });

  assert.equal(result.kind, "output");
  assert.match(result.output, /Plan safely/u);
  assert.doesNotMatch(result.output, /clipboard-payload|\u001b|\u0007/u);
  assert.deepEqual(result.data.sessions.map(({ title, preview }) => ({
    title,
    preview
  })), [{
    title: "Plan safely",
    preview: "Review changes"
  }]);
});

test("Operator list presents readable history while JSON data keeps native IDs private", () => {
  const { store } = operatorStore();
  const result = runOperatorCommand(["list"], store, {
    now: () => new Date("2026-07-28T02:05:00.000Z"),
    width: 100
  });

  assert.equal(result.kind, "output");
  assert.match(result.output, /^Operator sessions/m);
  assert.match(result.output, /5m ago\s+Claude\s+Review archive workflow/);
  assert.match(result.output, /Codex\s+Design Operator history/);
  assert.doesNotMatch(result.output, /native-[12]/);
  assert.equal(JSON.stringify(result.data).includes("native-"), false);
  assert.match(result.data.sessions[0].ref, /^op-/);
});

test("Operator resume --last resolves an opaque control and applies Agent switching atomically", () => {
  const { store } = operatorStore();
  const control = runOperatorCommand(["resume", "--last"], store, {
    now: () => THIRD
  });

  assert.equal(control.kind, "session");
  assert.equal(control.action, "resume");
  assert.equal(control.targetAgentId, "claude");
  assert.match(control.ref, /^op-/);

  applyOperatorSessionControl(control, store, THIRD);
  assert.equal(store.role.activeAgentId, "claude");
  assert.equal(store.sessions.activeAgentId, "claude");
  assert.equal(store.sessions.sessions.claude.nativeSessionId, "claude-native-2");
});

test("Operator new rotates only the selected bound Agent session", () => {
  const { store } = operatorStore();
  const control = runOperatorCommand(["new", "--agent", "codex"], store);

  assert.deepEqual(control, {
    kind: "session",
    action: "new",
    targetAgentId: "codex"
  });
  applyOperatorSessionControl(control, store, THIRD);
  assert.equal(store.sessions.sessions.codex, undefined);
  assert.equal(store.sessions.sessions.claude.nativeSessionId, "claude-native-2");
  assert.equal(listOperatorSessions(store.sessions).length, 2);
});

test("Operator binds multiple adapters but rejects a second Agent for one adapter", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-operator-bindings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, FIRST);
  const store = new FileTaskStore(home);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], FIRST);
  const codexWork = createConfiguredAgent(
    "codex-work", "codex", "codex", [], [], FIRST
  );
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], FIRST);
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding(codex)],
    "codex",
    home,
    FIRST
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(codex);
    tx.saveConfiguredAgent(codexWork);
    tx.saveConfiguredAgent(claude);
    tx.saveGlobalRole(role);
  });

  assert.throws(
    () => runGlobalRoleCommand(["bind", "operator", "codex-work"], store),
    (error) => error?.code === "USAGE_ERROR"
      && /already has a codex Agent.*codex/u.test(error.message)
      && /Update that Agent|activate another adapter/iu.test(error.message)
  );
  assert.match(
    runGlobalRoleCommand(["bind", "operator", "claude"], store),
    /Bound role operator to claude/u
  );
});

test("Operator rejects duplicate adapter bindings at the domain boundary", () => {
  assert.throws(
    () => createGlobalRole(
      "operator",
      [
        createRoleAgentBinding({ id: "codex-personal", adapterId: "codex" }),
        createRoleAgentBinding({ id: "codex-work", adapterId: "codex" })
      ],
      "codex-personal",
      "/workspace",
      FIRST
    ),
    /Operator supports one Agent per adapter.*codex/iu
  );
});

test("FileTaskStore round-trips Operator history with its Agent ownership", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-operator-history-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, FIRST);
  const store = new FileTaskStore(home);
  const codex = createConfiguredAgent(
    "codex",
    "codex",
    "codex",
    [],
    [],
    FIRST
  );
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding(codex)],
    codex.id,
    "/workspace",
    FIRST
  );
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    codex.id,
    FIRST
  );
  sessions = record(sessions, {
    agentId: codex.id,
    adapterId: codex.adapterId,
    nativeSessionId: "codex-native-persisted",
    preview: "Persist Operator history"
  }, FIRST);
  sessions = prepareOperatorNewSession(sessions, codex.id, SECOND);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(codex);
    tx.saveGlobalRoleWithSessionSet(role, sessions);
  });

  const restored = new FileTaskStore(home).getGlobalRoleSessionSet("operator");
  assert.deepEqual(listOperatorSessions(restored).map(({ agentId, displayTitle, state }) => ({
    agentId,
    displayTitle,
    state
  })), [{
    agentId: "codex",
    displayTitle: "Persist Operator history",
    state: "history"
  }]);
});

test("the first completed Operator turn supplies a readable session preview", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-operator-preview-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, FIRST);
  const store = new FileTaskStore(home);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], FIRST);
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding(codex)],
    codex.id,
    "/workspace",
    FIRST
  );
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    codex.id,
    FIRST
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: codex.id,
    adapterId: codex.adapterId,
    nativeSessionId: "codex-native-preview",
    policy: "fixed",
    status: "ready"
  }, FIRST);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(codex);
    tx.saveGlobalRoleWithSessionSet(role, sessions);
  });

  new FileSchedulerStoreAdapter(store).observeGlobalRuntimeTurnCompleted({
    roleName: "operator",
    agentId: codex.id,
    adapterId: codex.adapterId,
    nativeSessionId: "codex-native-preview",
    turnId: "turn-preview",
    title: "How should Operator history work?",
    summary: "Designed lean Operator session history."
  }, SECOND);

  assert.equal(
    store.getGlobalRoleSessionSet("operator").sessions.codex.title,
    "How should Operator history work?"
  );
  assert.equal(
    store.getGlobalRoleSessionSet("operator").sessions.codex.preview,
    "Designed lean Operator session history."
  );
});

function operatorStore() {
  const codex = { id: "codex", adapterId: "codex" };
  const claude = { id: "claude", adapterId: "claude" };
  let role = createGlobalRole(
    "operator",
    [createRoleAgentBinding(codex), createRoleAgentBinding(claude)],
    "codex",
    "/workspace",
    FIRST
  );
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    "codex",
    FIRST
  );
  sessions = record(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-native-1",
    preview: "Design Operator history"
  }, FIRST);
  sessions = record(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-native-2",
    title: "Review archive workflow"
  }, SECOND);

  const store = {
    get role() { return structuredClone(role); },
    get sessions() { return structuredClone(sessions); },
    transaction(execute) { return execute(this); },
    getGlobalRole(name) {
      return name === "operator" ? structuredClone(role) : null;
    },
    getGlobalRoleSessionSet(name) {
      return name === "operator" ? structuredClone(sessions) : null;
    },
    saveGlobalRoleWithSessionSet(nextRole, nextSessions) {
      role = structuredClone(nextRole);
      sessions = structuredClone(nextSessions);
    }
  };
  return { store };
}
