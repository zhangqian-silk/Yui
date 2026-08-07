import assert from "node:assert/strict";
import test from "node:test";

import {
  agentProcessReadinessProbe,
  ExecutorRegistry
} from "../../dist/executor/executorRegistry.js";
import { TmuxSessionHost } from "../../dist/runtime/index.js";
import { testEffectiveLaunch } from "../helpers/effectiveLaunch.js";

function effective(agentId, adapterId, workspace = "/tmp/workspace") {
  return testEffectiveLaunch({ agentId, adapterId, workspaceRoot: workspace });
}

test("readiness uses tmux process state and never parses Agent output", () => {
  const base = {
    taskId: "task-1",
    roleName: "leader",
    target: "yui:leader",
    dead: false,
    pid: 123
  };
  const codex = agentProcessReadinessProbe("codex");
  const claude = agentProcessReadinessProbe("claude");

  assert.equal(codex({ ...base, currentCommand: "node" }), true);
  assert.equal(codex({
    ...base,
    currentCommand: "node",
    content: "Unknown future trust or permission prompt"
  }), true);
  assert.equal(claude({ ...base, currentCommand: "claude" }), true);
  assert.equal(claude({
    ...base,
    currentCommand: "claude",
    content: "❯ Working… press ctrl-c to interrupt"
  }), true);
  assert.equal(codex({ ...base, dead: true, currentCommand: "node" }), false);
  assert.equal(claude({ ...base, pid: undefined, currentCommand: "claude" }), false);
  assert.equal(codex({ ...base, currentCommand: "" }), false);
});

test("ExecutorRegistry prepares new/resume sessions and always carries the adapter probe into sendOnce", async () => {
  const calls = [];
  const planner = {
    plan(input) {
      calls.push(["plan", input]);
      return {
        role: { name: input.roleName, workspace: "/tmp/workspace" },
        launch: {
          command: input.adapterId,
          args: input.mode === "resume" ? ["resume", input.nativeSessionId] : [],
          env: {}
        },
        session: input.adapterId === "codex" && input.mode === "new"
          ? null
          : {
              agentId: input.agentId,
              adapterId: input.adapterId,
              nativeSessionId: input.nativeSessionId ?? "claude-preallocated",
              status: "ready"
            }
      };
    }
  };
  const tmux = {
    ensureRoleWindow(taskId, role, launch) {
      calls.push(["ensure", taskId, role.name, launch.args]);
      return true;
    },
    waitUntilReady(taskId, roleName, probe) {
      const content = roleName === "leader"
        ? "OpenAI Codex\n/model to change\n› Find and fix a bug in @filename\n"
        : "❯ \n";
      const pane = {
        taskId, roleName, target: `${taskId}:${roleName}`, dead: false, pid: 123,
        currentCommand: roleName === "leader" ? "node" : "claude", content
      };
      assert.equal(probe(pane), true);
      calls.push(["ready", roleName]);
      return pane;
    },
    sendRoleInputOnce(taskId, roleName, receiptId, text, probe) {
      const content = roleName === "leader"
        ? "OpenAI Codex\n/model to change\n› Find and fix a bug in @filename\n"
        : "❯ \n";
      assert.equal(probe({
        taskId, roleName, target: `${taskId}:${roleName}`, dead: false, pid: 123,
        currentCommand: roleName === "leader" ? "node" : "claude", content
      }), true);
      calls.push(["send", roleName, receiptId, text]);
      return "sent";
    },
    probeRoleStatus() { return "running"; }
  };
  const registry = new ExecutorRegistry(planner, tmux);

  const fresh = await registry.prepareRoleSession({
    taskId: "task-1", roleName: "leader", agentId: "codex", adapterId: "codex", mode: "new"
  });
  const freshReady = await registry.waitUntilReady(fresh);
  assert.equal(freshReady.session, null);
  assert.equal(await registry.sendOnce({
    delivery: freshReady, receiptId: "wake-1", text: "lead"
  }), "sent");

  const resumed = await registry.prepareRoleSession({
    taskId: "task-1", roleName: "worker", agentId: "claude", adapterId: "claude",
    mode: "resume", nativeSessionId: "claude-1"
  });
  const resumedReady = await registry.waitUntilReady(resumed);
  assert.equal(resumedReady.session.nativeSessionId, "claude-1");
  assert.equal(await registry.sendOnce({
    delivery: resumedReady, receiptId: "work-1", text: "work"
  }), "sent");

  assert.deepEqual(calls.filter(([kind]) => kind === "send").map((call) => call[1]), [
    "leader", "worker"
  ]);
});

test("production runtime ports launch and attempt delivery without the legacy readiness loop", async () => {
  const calls = [];
  const planner = {
    plan(input) {
      return {
        role: { name: input.roleName, workspace: "/tmp/workspace" },
        launch: { command: "codex", args: [], env: {} },
        session: null
      };
    }
  };
  const tmux = {
    ensureRoleWindow() { throw new Error("legacy launch must not run"); },
    waitUntilReady() { throw new Error("legacy readiness loop must not run"); },
    sendRoleInputOnce() { throw new Error("legacy delivery must not run"); },
    sendRoleInputOnceIfReady() { throw new Error("unused"); },
    probeRoleStatus() { return "running"; },
    stopTask() { return false; }
  };
  const binding = {
    id: "binding-1", launchId: "launch-placeholder",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex", adapterId: "codex", hostRef: "opaque"
  };
  let pushOutcome = "busy";
  const registry = new ExecutorRegistry(planner, tmux, undefined, {
    sessionHost: {
      async start(request) { calls.push(["start", request]); return { ...binding, launchId: request.launchId }; },
      async resume() { throw new Error("unused"); },
      async stop() {},
      async inspect() { return { state: "running" }; }
    },
    promptPush: {
      async tryPush(request) { calls.push(["push", request]); return pushOutcome; }
    }
  });

  const prepared = await registry.prepareRoleSession({
    taskId: "task-1", roleName: "leader", agentId: "codex", adapterId: "codex",
    effective: effective("codex", "codex"),
    workspace: "/tmp/workspace", mode: "new", runId: "agent-run-1"
  });
  const retriedPrepare = await registry.prepareRoleSession({
    taskId: "task-1", roleName: "leader", agentId: "codex", adapterId: "codex",
    effective: effective("codex", "codex"),
    workspace: "/tmp/workspace", mode: "new", runId: "agent-run-1"
  });
  assert.equal(retriedPrepare, prepared);
  const ready = await registry.waitUntilReady(prepared);
  assert.equal(await registry.sendOnce({
    delivery: ready,
    receiptId: "agent-run:task-1/agent-run-1",
    text: "lead"
  }), "busy");
  pushOutcome = "delivered";
  assert.equal(await registry.sendOnce({
    delivery: ready,
    receiptId: "agent-run:task-1/agent-run-1",
    text: "lead"
  }), "sent");
  assert.deepEqual(calls.map(([kind]) => kind), ["start", "push", "push"]);
});

test("a newly launched Codex process carries the exact first Run prompt and skips tmux delivery", async () => {
  let pushes = 0;
  const registry = new ExecutorRegistry(
    { plan() { throw new Error("runtime host owns planning"); } },
    {
      ensureRoleWindow() { throw new Error("legacy launch must not run"); },
      waitUntilReady() { throw new Error("legacy readiness must not run"); },
      sendRoleInputOnce() { throw new Error("first prompt must not use tmux"); },
      sendRoleInputOnceIfReady() { throw new Error("unused"); },
      probeRoleStatus() { return "running"; }
    },
    undefined,
    {
      sessionHost: {
        async start(request) {
          return {
            id: "binding-1",
            launchId: request.launchId,
            owner: request.owner,
            agentId: request.agentId,
            adapterId: request.adapterId,
            hostRef: "opaque",
            hostCreated: true,
            initialPromptRunId: request.runId
          };
        },
        async resume() { throw new Error("unused"); },
        async stop() {},
        async inspect() { return { state: "running" }; }
      },
      promptPush: {
        async tryPush() { pushes += 1; return "delivered"; }
      }
    }
  );
  const prepared = await registry.prepareRoleSession({
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    effective: effective("codex", "codex"),
    workspace: "/tmp/workspace",
    mode: "new",
    runId: "agent-run-1"
  });
  assert.equal(prepared.inputSubmittedAtLaunch, true);
  assert.equal(await registry.sendOnce({
    delivery: await registry.waitUntilReady(prepared),
    receiptId: "agent-run:task-1/agent-run-1",
    text: "first prompt"
  }), "sent");
  assert.equal(pushes, 0);
});

test("prepared runtime bindings survive transient unavailability but explicit terminal cleanup starts a new generation", async () => {
  let generations = 0;
  const launchCoordinator = {
    async prepare(request) {
      generations += 1;
      return {
        id: `binding-${generations}`,
        launchId: `launch-${generations}`,
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        hostRef: `host-${generations}`
      };
    }
  };
  const registry = new ExecutorRegistry(
    { plan() { throw new Error("legacy planner must not run"); } },
    {
      ensureRoleWindow() { throw new Error("legacy launch must not run"); },
      waitUntilReady() { throw new Error("legacy readiness must not run"); },
      sendRoleInputOnce() { throw new Error("legacy delivery must not run"); },
      sendRoleInputOnceIfReady() { throw new Error("unused"); },
      probeRoleStatus() { return "running"; },
      stopTask() { return false; }
    },
    undefined,
    {
      launchCoordinator,
      sessionHost: {
        async start() { throw new Error("coordinator must own launch"); },
        async resume() { throw new Error("coordinator must own launch"); },
        async stop() {},
        async inspect() { return { state: "running" }; },
        async inspectOwner() { return { state: "running" }; },
        async stopOwner() { return true; }
      },
      promptPush: {
        async tryPush() { return "unavailable"; }
      }
    }
  );
  const input = {
    taskId: "task-1",
    roleName: "worker",
    agentId: "codex",
    adapterId: "codex",
    effective: effective("codex", "codex"),
    workspace: "/tmp/workspace",
    mode: "new",
    runId: "agent-run-1"
  };

  const first = await registry.prepareRoleSession(input);
  const ready = await registry.waitUntilReady(first);
  assert.equal(await registry.sendOnce({
    delivery: ready,
    receiptId: "agent-run:task-1/agent-run-1",
    text: "work"
  }), "unavailable");
  assert.equal(await registry.prepareRoleSession(input), first);
  assert.equal(generations, 1);

  registry.forgetPrepared({
    taskId: input.taskId,
    roleName: input.roleName,
    runId: input.runId,
    launchId: first.launchId
  });
  const replacement = await registry.prepareRoleSession(input);

  assert.equal(replacement.deliveryId, first.deliveryId);
  assert.equal(replacement.launchId, "launch-2");
  assert.equal(generations, 2);
});

test("runtime launch plans Claude once and reports the native session actually hosted", async () => {
  let plans = 0;
  const planner = {
    plan(input) {
      plans += 1;
      return {
        role: { name: input.roleName, workspace: "/tmp/workspace" },
        launch: { command: "claude", args: [], env: {} },
        session: {
          agentId: input.agentId,
          adapterId: input.adapterId,
          nativeSessionId: "claude-hosted-1",
          status: "ready"
        }
      };
    }
  };
  const tmux = {
    ensureRoleWindow() { return true; },
    probeRoleStatus() { return "running"; },
    killRole() {},
    sendRoleInputOnceIfReady() { return "sent"; },
    waitUntilReady() { throw new Error("legacy readiness loop must not run"); },
    sendRoleInputOnce() { throw new Error("legacy send must not run"); },
    stopTask() { return false; }
  };
  const host = new TmuxSessionHost(planner, tmux, { createBindingId: () => "binding-1" });
  const registry = new ExecutorRegistry(planner, tmux, undefined, {
    sessionHost: host,
    promptPush: { async tryPush() { return "delivered"; } }
  });

  const prepared = await registry.prepareRoleSession({
    taskId: "task-1", roleName: "worker", agentId: "claude", adapterId: "claude",
    effective: effective("claude", "claude"),
    workspace: "/tmp/workspace", mode: "new"
  });
  const ready = await registry.waitUntilReady(prepared);

  assert.equal(plans, 1);
  assert.equal(ready.session.nativeSessionId, "claude-hosted-1");
});

test("Operator input notification never launches a pane or waits for a busy process", async () => {
  const calls = [];
  let state = "exited";
  const registry = new ExecutorRegistry({ plan() { throw new Error("unused"); } }, {
    ensureRoleWindow() { throw new Error("must not launch"); },
    waitUntilReady() { throw new Error("must not wait"); },
    sendRoleInputOnce() { throw new Error("unused"); },
    sendRoleInputOnceIfReady(taskId, roleName, receiptId, text, probe) {
      calls.push([taskId, roleName, receiptId, text, probe]);
      return state === "exited"
        ? "unavailable"
        : state === "ready" ? "sent" : "not-ready";
    },
    probeRoleStatus() { return state === "exited" ? "exited" : "running"; },
    stopTask() { return false; }
  });
  const input = {
    roleName: "operator",
    adapterId: "codex",
    receiptId: "input-request:input-1",
    text: "Question"
  };

  assert.equal(await registry.notifyOperatorInputOnce(input), "unavailable");
  assert.equal(calls.length, 1);
  state = "busy";
  assert.equal(await registry.notifyOperatorInputOnce(input), "not-ready");
  assert.equal(calls.length, 2);
  state = "ready";
  assert.equal(await registry.notifyOperatorInputOnce(input), "sent");
  assert.equal(calls.length, 3);
});

test("Role inventory carries one advisory CPU/RSS sample into the scheduler batch", async () => {
  let resourceCalls = 0;
  const registry = new ExecutorRegistry(
    { plan() { throw new Error("unused"); } },
    {
      inspectRolePaneInventory() {
        return [{
          taskId: "task-1",
          roleName: "worker",
          target: "task-1:worker",
          dead: false,
          pid: 123,
          currentCommand: "codex"
        }];
      }
    },
    undefined,
    {
      sessionHost: {},
      promptPush: {},
      async roleResourceInventory(panes) {
        resourceCalls += 1;
        assert.equal(panes.length, 1);
        assert.equal(panes[0].pid, 123);
        return [{
          taskId: "task-1",
          roleName: "worker",
          resource: {
            observedAt: "2026-08-05T01:00:00.000Z",
            active: true,
            cpuTimeMs: 7,
            rssBytes: 4096
          }
        }];
      }
    }
  );
  const result = await registry.inspectRoles([{
    taskId: "task-1",
    roleName: "worker",
    agentId: "codex",
    adapterId: "codex"
  }]);
  assert.equal(resourceCalls, 1);
  assert.deepEqual(result, [{
    taskId: "task-1",
    roleName: "worker",
    status: "present",
    resource: {
      observedAt: "2026-08-05T01:00:00.000Z",
      active: true,
      cpuTimeMs: 7,
      rssBytes: 4096
    }
  }]);
});
