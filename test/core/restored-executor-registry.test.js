import assert from "node:assert/strict";
import test from "node:test";

import {
  agentComposerReadinessProbe,
  ExecutorRegistry
} from "../../dist/executor/executorRegistry.js";

test("readiness resolver distinguishes Codex node composer and Claude prompt markers", () => {
  const base = {
    taskId: "task-1",
    roleName: "leader",
    target: "taskmux:leader",
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
  assert.equal(codex({ ...base, currentCommand: "node", content: "starting\n" }), false);
  assert.equal(codex({
    ...base,
    currentCommand: "node",
    content: "OpenAI Codex\nUpdate available\nPress enter to continue\n› \n/model to change\n"
  }), false);
  assert.equal(claude({ ...base, currentCommand: "claude", content: "hello\n❯ \n" }), true);
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
