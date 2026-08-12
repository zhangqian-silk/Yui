import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  refreshRunningFileTaskControllerConfiguration,
  refreshRunningFileTaskControllerEnvironment
} from "../../dist/controller/clientRuntime.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createRuntimeLifecycleDispatcher } from "../../dist/controller/runtime.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import {
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { taskOwnedWorkspace } from "../helpers/taskWorkspace.js";

const NOW = new Date("2026-07-24T00:00:00.000Z");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-env-refresh-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent(
    "codex-env",
    "codex",
    "codex-test",
    [],
    [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "YUI_OPENAI_KEY",
      required: true
    }, {
      target: "OPTIONAL_AGENT_VALUE",
      source: "process",
      sourceName: "YUI_OPTIONAL_VALUE",
      required: false
    }],
    NOW
  );
  const task = activateTask(createTask("task-1", "Environment refresh", NOW, {
    cwd: home
  }), NOW);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    NOW
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveManagedWorkspace(taskOwnedWorkspace(task, NOW));
    tx.saveRole(task.id, role);
  });
  return { home, store, agent, task, role };
}

test("planner environment refresh is private, authoritative, and used by background launches", (t) => {
  const { home, store, agent, task, role } = fixture(t);
  const source = { CODEX_HOME: "/tmp/codex-old" };
  const planner = new FileRoleLaunchPlanner(home, store, {
    environment: source,
    cliPath: "/dist/cli.js"
  });
  const input = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  };

  assert.throws(() => planner.plan(input), /required agent environment is missing/i);
  planner.refreshAgentEnvironment({
    sources: { YUI_OPENAI_KEY: "secret-one" },
    sourceNames: ["YUI_OPENAI_KEY"],
    nativeSources: { CODEX_HOME: "/tmp/codex-one" },
    nativeNames: ["CODEX_HOME"]
  });
  assert.equal(planner.plan(input).launch.env.OPENAI_API_KEY, "secret-one");
  assert.equal(planner.plan(input).launch.env.CODEX_HOME, "/tmp/codex-one");
  planner.refreshAgentEnvironment({
    sources: { YUI_OPTIONAL_VALUE: "keep-me" },
    sourceNames: ["YUI_OPTIONAL_VALUE"],
    nativeSources: {},
    nativeNames: []
  });
  planner.refreshAgentEnvironment({
    sources: { YUI_OPENAI_KEY: "secret-two" },
    sourceNames: ["YUI_OPENAI_KEY"],
    nativeSources: {},
    nativeNames: []
  });
  assert.equal(planner.plan(input).launch.env.OPTIONAL_AGENT_VALUE, "keep-me");
  planner.refreshAgentEnvironment({
    sources: {},
    sourceNames: ["YUI_OPENAI_KEY"],
    nativeSources: {},
    nativeNames: ["CODEX_HOME"]
  });
  assert.throws(() => planner.plan(input), /required agent environment is missing/i);
  planner.refreshAgentEnvironment({
    sources: { YUI_OPENAI_KEY: "secret-three" },
    sourceNames: ["YUI_OPENAI_KEY"],
    nativeSources: {},
    nativeNames: []
  });
  assert.equal(planner.plan(input).launch.env.CODEX_HOME, undefined);
  assert.deepEqual(source, { CODEX_HOME: "/tmp/codex-old" });
  assert.equal(process.env.YUI_OPENAI_KEY, undefined);
});

test("environment refresh RPC accepts only current source bindings and never persists values", async (t) => {
  const { home, store, agent, task, role } = fixture(t);
  const planner = new FileRoleLaunchPlanner(home, store, {
    environment: {},
    cliPath: "/dist/cli.js"
  });
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const unusedHost = {};
  const dispatch = createRuntimeLifecycleDispatcher(
    store,
    schedulerStore,
    unusedHost,
    undefined,
    undefined,
    undefined,
    planner
  );

  const secret = "refresh-secret-not-on-disk";
  assert.deepEqual(
    await dispatch("runtime.replace-agent-environment", {
      sources: { YUI_OPENAI_KEY: secret },
      sourceNames: ["YUI_OPENAI_KEY"],
      nativeSources: {},
      nativeNames: ["CODEX_HOME"]
    }),
    { replaced: true, count: 1 }
  );
  assert.equal(planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }).launch.env.OPENAI_API_KEY, secret);
  assert.equal(readFileSync(join(home, "state.json"), "utf8").includes(secret), false);

  await assert.rejects(dispatch("runtime.replace-agent-environment", {
    sources: {
      YUI_OPENAI_KEY: "must-not-merge",
      OPENAI_API_KEY: "target-only"
    },
    sourceNames: ["YUI_OPENAI_KEY", "OPENAI_API_KEY"],
    nativeSources: {},
    nativeNames: []
  }), /not declared: OPENAI_API_KEY/i);
  await assert.rejects(dispatch("runtime.replace-agent-environment", {
    sources: { YUI_HOME: "managed" },
    sourceNames: ["YUI_HOME"],
    nativeSources: {},
    nativeNames: []
  }), /source is invalid: YUI_HOME/i);
  assert.equal(planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }).launch.env.OPENAI_API_KEY, secret);
});

test("refresh helper sends present declared sources and never starts an absent Controller", async (t) => {
  const { home, store } = fixture(t);
  const calls = [];
  const refreshed = await refreshRunningFileTaskControllerEnvironment(
    home,
    store,
    {
      YUI_OPENAI_KEY: "present",
      OPENAI_API_KEY: "target-only",
      UNDECLARED_SECRET: "not-forwarded"
    },
    {
      call: async (...input) => {
        calls.push(input);
        return { replaced: true, count: 1 };
      },
      spawnController: () => {
        throw new Error("must not start Controller");
      }
    }
  );
  assert.deepEqual(refreshed, { status: "refreshed" });
  assert.deepEqual(calls[0].slice(1, 3), [
    "runtime.replace-agent-environment",
    {
      sources: { YUI_OPENAI_KEY: "present" },
      sourceNames: ["YUI_OPENAI_KEY", "YUI_OPTIONAL_VALUE"],
      nativeSources: {},
      nativeNames: ["CODEX_HOME"]
    }
  ]);

  let spawnCount = 0;
  const unavailable = await refreshRunningFileTaskControllerEnvironment(
    home,
    store,
    { YUI_OPENAI_KEY: "present" },
    {
      call: async () => {
        throw Object.assign(new Error("offline"), {
          code: "CONTROLLER_NOT_RUNNING"
        });
      },
      spawnController: () => { spawnCount += 1; }
    }
  );
  assert.deepEqual(unavailable, { status: "not-running" });
  assert.equal(spawnCount, 0);
});

test("refresh helpers distinguish a running Controller failure without starting one", async (t) => {
  const { home, store } = fixture(t);
  const errors = [];
  const options = {
    call: async () => {
      throw Object.assign(new Error("timed out"), { code: "CONTROLLER_TIMEOUT" });
    },
    spawnController: () => {
      throw new Error("must not start Controller");
    },
    onError: (error) => errors.push(error)
  };

  assert.deepEqual(
    await refreshRunningFileTaskControllerEnvironment(
      home,
      store,
      { YUI_OPENAI_KEY: "present" },
      options
    ),
    { status: "failed", message: "timed out" }
  );
  assert.deepEqual(
    await refreshRunningFileTaskControllerConfiguration(home, options),
    { status: "failed", message: "timed out" }
  );
  assert.equal(errors.length, 2);
});

test("a malformed reply is reported as refresh failure, not an absent Controller", async (t) => {
  const { home, store } = fixture(t);
  const result = await refreshRunningFileTaskControllerEnvironment(
    home,
    store,
    { YUI_OPENAI_KEY: "present" },
    {
      call: async () => {
        throw Object.assign(new Error("malformed reply"), { code: "INVALID_RESPONSE" });
      }
    }
  );
  assert.deepEqual(result, { status: "failed", message: "malformed reply" });
});

test("socket and discovery failures are not mistaken for an absent Controller", async (t) => {
  const { home, store } = fixture(t);
  for (const [code, message] of [
    ["CONTROLLER_UNAVAILABLE", "socket unavailable"],
    ["CONTROLLER_DISCOVERY_INVALID", "discovery invalid"]
  ]) {
    const result = await refreshRunningFileTaskControllerEnvironment(
      home,
      store,
      { YUI_OPENAI_KEY: "present" },
      {
        call: async () => {
          throw Object.assign(new Error(message), { code });
        }
      }
    );
    assert.deepEqual(result, { status: "failed", message });
  }
});

test("configuration refresh reads durable state in the Controller and never starts it", async () => {
  const calls = [];
  assert.deepEqual(
    await refreshRunningFileTaskControllerConfiguration("/tmp/yui-test-home", {
      call: async (...input) => {
        calls.push(input);
        return { configured: true, reconciliationIntervalMs: 45_000 };
      },
      spawnController: () => {
        throw new Error("must not start Controller");
      }
    }),
    { status: "refreshed" }
  );
  assert.deepEqual(calls[0].slice(1, 3), ["scheduler.configure", {}]);
});

test("Agent launch targets cannot overwrite Yui runtime control variables", () => {
  assert.throws(() => createConfiguredAgent(
    "unsafe",
    "codex",
    "codex",
    [],
    [{
      target: "YUI_CUSTOM",
      source: "process",
      sourceName: "SAFE_SOURCE",
      required: true
    }],
    NOW
  ), /environment binding is invalid/i);
  assert.doesNotThrow(() => createConfiguredAgent(
    "safe",
    "codex",
    "codex",
    [],
    [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "YUI_OPENAI_KEY",
      required: true
    }],
    NOW
  ));
});
