import assert from "node:assert/strict";
import test from "node:test";

import {
  agentComposerReadinessProbe,
  ExecutorRegistry
} from "../../dist/executor/executorRegistry.js";
import { TmuxSessionHost } from "../../dist/runtime/index.js";

test("readiness resolver distinguishes Codex node composer and Claude prompt markers", () => {
  const base = {
    taskId: "task-1",
    roleName: "leader",
    target: "yui:leader",
    dead: false,
    pid: 123
  };
  const codex = agentComposerReadinessProbe("codex");
  const claude = agentComposerReadinessProbe("claude");

  assert.equal(codex({
    ...base,
    currentCommand: "node",
    content: "OpenAI Codex\nmodel: gpt-5 /model to change\n› Find and fix a bug in @filename\n"
  }), true);
  assert.equal(codex({
    ...base,
    currentCommand: "node",
    content: [
      "• Working (1m 10s • esc to interrupt)",
      "",
      "› Summarize recent commits",
      "",
      "gpt-5.6-sol medium · /tmp/workspace"
    ].join("\n")
  }), false);
  assert.equal(codex({
    ...base,
    currentCommand: "node",
    content: [
      "Would you like to run this command?",
      "› 1. Yes, proceed",
      "  2. No",
      "Press enter to confirm or esc to cancel",
      "gpt-5.6-sol medium · /tmp/workspace"
    ].join("\n")
  }), false);
  assert.equal(codex({
    ...base,
    currentCommand: "node",
    content: [
      ...Array.from({ length: 40 }, (_, index) => `completed transcript line ${index}`),
      "",
      "› Summarize recent commits",
      "",
      "gpt-5.6-sol medium · /tmp/workspace"
    ].join("\n")
  }), true);
  assert.equal(codex({ ...base, currentCommand: "node", content: "starting\n" }), false);
  assert.equal(codex({
    ...base,
    currentCommand: "node",
    content: "OpenAI Codex\nUpdate available\nPress enter to continue\n› \n/model to change\n"
  }), false);
  assert.equal(claude({ ...base, currentCommand: "claude", content: "hello\n❯ \n" }), true);
  assert.equal(claude({
    ...base,
    currentCommand: "claude",
    content: "❯ old prompt\nWorking… press ctrl-c to interrupt\n"
  }), false);
  assert.equal(claude({ ...base, currentCommand: "claude", content: "thinking…\n" }), false);
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
    hasDeliveryReceipt() { throw new Error("legacy receipt lookup must not run"); },
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
    workspace: "/tmp/workspace", mode: "new", runId: "run-1"
  });
  const retriedPrepare = await registry.prepareRoleSession({
    taskId: "task-1", roleName: "leader", agentId: "codex", adapterId: "codex",
    workspace: "/tmp/workspace", mode: "new", runId: "run-1"
  });
  assert.equal(retriedPrepare, prepared);
  const ready = await registry.waitUntilReady(prepared);
  assert.equal(await registry.sendOnce({ delivery: ready, receiptId: "agent-run:run-1", text: "lead" }), "busy");
  pushOutcome = "delivered";
  assert.equal(await registry.sendOnce({ delivery: ready, receiptId: "agent-run:run-1", text: "lead" }), "sent");
  assert.deepEqual(calls.map(([kind]) => kind), ["start", "push", "push"]);
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
    hasDeliveryReceipt() { throw new Error("legacy receipt lookup must not run"); },
    stopTask() { return false; }
  };
  const host = new TmuxSessionHost(planner, tmux, { createBindingId: () => "binding-1" });
  const registry = new ExecutorRegistry(planner, tmux, undefined, {
    sessionHost: host,
    promptPush: { async tryPush() { return "delivered"; } }
  });

  const prepared = await registry.prepareRoleSession({
    taskId: "task-1", roleName: "worker", agentId: "claude", adapterId: "claude",
    workspace: "/tmp/workspace", mode: "new"
  });
  const ready = await registry.waitUntilReady(prepared);

  assert.equal(plans, 1);
  assert.equal(ready.session.nativeSessionId, "claude-hosted-1");
});

test("runtime-backed delivery still checks the tmux receipt before treating a send as fresh", async () => {
  let pushes = 0;
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
    waitUntilReady() { throw new Error("legacy readiness must not run"); },
    sendRoleInputOnce() { throw new Error("legacy send must not run"); },
    sendRoleInputOnceIfReady() { throw new Error("unused"); },
    hasDeliveryReceipt() { throw new Error("async receipt path should win"); },
    async hasDeliveryReceiptAsync() { return true; },
    probeRoleStatus() { return "running"; },
    stopTask() { return false; }
  };
  const registry = new ExecutorRegistry(planner, tmux, undefined, {
    sessionHost: {
      async start(request) {
        return {
          id: "binding-receipt",
          launchId: request.launchId,
          owner: request.owner,
          agentId: request.agentId,
          adapterId: request.adapterId,
          hostRef: "opaque",
          hostCreated: false
        };
      },
      async resume() { throw new Error("unused"); },
      async stop() {},
      async inspect() { return { state: "running" }; }
    },
    promptPush: {
      async tryPush() { pushes += 1; return "delivered"; }
    }
  });
  const prepared = await registry.prepareRoleSession({
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    workspace: "/tmp/workspace",
    mode: "new"
  });

  const existing = await registry.findExistingReceipt({
    delivery: prepared,
    receiptId: "agent-run:run-1"
  });

  assert.notEqual(existing, null);
  assert.equal(pushes, 0);
});

test("Operator input notification never launches a pane or waits for a busy composer", async () => {
  const calls = [];
  let state = "exited";
  const registry = new ExecutorRegistry({ plan() { throw new Error("unused"); } }, {
    ensureRoleWindow() { throw new Error("must not launch"); },
    waitUntilReady() { throw new Error("must not wait"); },
    sendRoleInputOnce() { throw new Error("unused"); },
    sendRoleInputOnceIfReady(taskId, roleName, receiptId, text, probe) {
      calls.push([taskId, roleName, receiptId, text, probe]);
      return state === "ready" ? "sent" : "not-ready";
    },
    hasDeliveryReceipt() { return false; },
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
  assert.equal(calls.length, 0);
  state = "busy";
  assert.equal(await registry.notifyOperatorInputOnce(input), "not-ready");
  assert.equal(calls.length, 1);
  state = "ready";
  assert.equal(await registry.notifyOperatorInputOnce(input), "sent");
  assert.equal(calls.length, 2);
});
