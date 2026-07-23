import assert from "node:assert/strict";
import test from "node:test";

import {
  TmuxPromptPushAdapter,
  TmuxSessionHost,
  createPromptEnvelope,
  createRuntimeBinding,
  createSessionLaunchRequest
} from "../../dist/runtime/index.js";

function fakePlan(nativeSessionId = undefined) {
  return {
    role: { name: "leader", workspace: "/repo" },
    launch: { command: "codex", args: [], env: {} },
    session: nativeSessionId === undefined
      ? null
      : { agentId: "codex-personal", adapterId: "codex", nativeSessionId, status: "ready" }
  };
}

test("TmuxSessionHost starts task owners through the task planner and returns an opaque binding", async () => {
  const calls = [];
  const planner = {
    plan(input) {
      calls.push(["plan", input]);
      return fakePlan();
    },
    planGlobalRole() {
      throw new Error("unexpected global plan");
    }
  };
  const tmux = {
    ensureRoleWindow() {
      throw new Error("sync ensure must not be used");
    },
    async ensureRoleWindowAsync(taskId, role, launch) {
      calls.push(["ensure-async", taskId, role, launch]);
      return true;
    },
    probeRoleStatus() {
      throw new Error("sync probe must not be used");
    },
    async probeRoleStatusAsync(taskId, roleName) {
      calls.push(["probe-async", taskId, roleName]);
      return "running";
    },
    killRole() {
      throw new Error("unexpected kill");
    }
  };
  const host = new TmuxSessionHost(planner, tmux, {
    createBindingId: () => "binding-1"
  });
  const request = createSessionLaunchRequest({
    mode: "new",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex-personal",
    adapterId: "codex",
    workspace: "/repo"
  });

  const binding = await host.start(request);

  assert.deepEqual(calls.slice(0, 2), [
    ["plan", {
      taskId: "task-1",
      roleName: "leader",
      agentId: "codex-personal",
      adapterId: "codex",
      launchId: "launch-1",
      mode: "new"
    }],
    ["ensure-async", "task-1", fakePlan().role, fakePlan().launch]
  ]);
  assert.equal(binding.id, "binding-1");
  assert.equal(binding.launchId, "launch-1");
  assert.equal(binding.hostRef.startsWith("yui-tmux:v1:"), true);
  assert.equal("nativeSessionId" in binding, false);
  assert.deepEqual(await host.inspect(binding), { state: "running" });
  assert.deepEqual(calls.at(-1), ["probe-async", "task-1", "leader"]);
});

test("TmuxSessionHost serializes first Role windows that share one Task host", async () => {
  let releaseFirst;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const ensured = [];
  const planner = {
    plan(input) {
      return {
        ...fakePlan(),
        role: { name: input.roleName, workspace: "/repo" }
      };
    },
    planGlobalRole() { throw new Error("unused"); }
  };
  const tmux = {
    ensureRoleWindow() { throw new Error("sync ensure must not be used"); },
    async ensureRoleWindowAsync(taskId, role) {
      ensured.push([taskId, role.name]);
      if (ensured.length === 1) await blocked;
      return true;
    },
    probeRoleStatus() { return "running"; },
    killRole() {}
  };
  let binding = 0;
  const host = new TmuxSessionHost(planner, tmux, {
    createBindingId: () => `binding-${++binding}`
  });
  const request = (roleName) => createSessionLaunchRequest({
    mode: "new",
    launchId: `launch-${roleName}`,
    owner: { scope: "task", taskId: "task-1", roleName },
    agentId: "codex-personal",
    adapterId: "codex",
    workspace: "/repo"
  });

  const leader = host.start(request("leader"));
  const worker = host.start(request("worker"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(ensured, [["task-1", "leader"]]);
  releaseFirst();
  await Promise.all([leader, worker]);
  assert.deepEqual(ensured, [
    ["task-1", "leader"],
    ["task-1", "worker"]
  ]);
});

test("TmuxSessionHost resumes global owners and stops only the referenced role", async () => {
  const calls = [];
  const planner = {
    plan() {
      throw new Error("unexpected task plan");
    },
    planGlobalRole(input) {
      calls.push(["plan-global", input]);
      return { ...fakePlan("native-1"), role: { name: "operator", workspace: "/repo" } };
    }
  };
  let status = "running";
  const tmux = {
    ensureRoleWindow(taskId, role, launch) {
      calls.push(["ensure", taskId, role, launch]);
      return true;
    },
    probeRoleStatus(taskId, roleName) {
      calls.push(["probe", taskId, roleName]);
      return status;
    },
    killRole(taskId, roleName) {
      calls.push(["kill", taskId, roleName]);
      status = "exited";
    }
  };
  const host = new TmuxSessionHost(planner, tmux, {
    globalHostId: "global-runtime",
    createBindingId: () => "binding-2"
  });
  const binding = await host.resume(createSessionLaunchRequest({
    mode: "resume",
    launchId: "launch-2",
    owner: { scope: "global", roleName: "operator" },
    agentId: "codex-personal",
    adapterId: "codex",
    workspace: "/repo",
    nativeSessionId: "native-1"
  }));

  assert.deepEqual(calls.slice(0, 2), [
    ["plan-global", {
      roleName: "operator",
      agentId: "codex-personal",
      adapterId: "codex",
      launchId: "launch-2",
      mode: "resume",
      nativeSessionId: "native-1"
    }],
    ["ensure", "global-runtime", { name: "operator", workspace: "/repo" }, fakePlan().launch]
  ]);
  assert.equal(binding.nativeSessionId, "native-1");

  await host.stop(binding);
  assert.deepEqual(calls.at(-1), ["kill", "global-runtime", "operator"]);
  assert.deepEqual(await host.inspect(binding), {
    state: "stopped",
    nativeSessionId: "native-1"
  });
  await host.stop(binding);
  assert.equal(calls.filter(([kind]) => kind === "kill").length, 1);
});

test("TmuxSessionHost rejects a host reference copied to a different owner", async () => {
  const planner = { plan: () => fakePlan(), planGlobalRole: () => fakePlan() };
  const tmux = {
    ensureRoleWindow: () => true,
    probeRoleStatus: () => "running",
    killRole: () => {}
  };
  const host = new TmuxSessionHost(planner, tmux);
  const binding = createRuntimeBinding({
    id: "binding-1",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex",
    adapterId: "codex",
    hostRef: "yui-tmux:v1:eyJzY29wZSI6Imdsb2JhbCIsImhvc3RJZCI6Im9wZXJhdG9yIiwicm9sZU5hbWUiOiJvcGVyYXRvciJ9"
  });

  await assert.rejects(() => host.inspect(binding), /does not match runtime owner/u);
});

test("TmuxSessionHost rejects a planned workspace mismatch before creating a process", async () => {
  let ensured = false;
  const host = new TmuxSessionHost(
    { plan: () => fakePlan(), planGlobalRole: () => fakePlan() },
    {
      ensureRoleWindow: () => {
        ensured = true;
        return true;
      },
      probeRoleStatus: () => "running",
      killRole: () => {}
    },
    { createBindingId: () => "binding-1" }
  );

  await assert.rejects(
    () => host.start(createSessionLaunchRequest({
      mode: "new",
      launchId: "launch-1",
      owner: { scope: "task", taskId: "task-1", roleName: "leader" },
      agentId: "codex-personal",
      adapterId: "codex",
      workspace: "/expected"
    })),
    /workspace does not match the runtime request/u
  );
  assert.equal(ensured, false);
});

test("TmuxPromptPushAdapter maps tmux presence and composer readiness to portable outcomes", async () => {
  const pushes = [];
  let status = "running";
  let outcome = "sent";
  const tmux = {
    probeRoleStatus: () => status,
    sendRoleInputOnceIfReady(taskId, roleName, receiptId, text, readinessProbe) {
      pushes.push({ taskId, roleName, receiptId, text, readinessProbe });
      return outcome;
    }
  };
  const readiness = () => () => true;
  const adapter = new TmuxPromptPushAdapter(tmux, readiness);
  const host = new TmuxSessionHost(
    { plan: () => fakePlan(), planGlobalRole: () => fakePlan() },
    { ensureRoleWindow: () => true, probeRoleStatus: () => "running", killRole: () => {} },
    { createBindingId: () => "binding-1" }
  );
  const binding = await host.start(createSessionLaunchRequest({
    mode: "new",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex-personal",
    adapterId: "codex",
    workspace: "/repo"
  }));
  const envelope = createPromptEnvelope({
    id: "prompt-1",
    source: { kind: "agent-run", id: "run-1" },
    text: "Continue the task",
    createdAt: new Date("2026-07-22T08:00:00.000Z")
  });

  assert.equal(await adapter.tryPush({ binding, envelope }), "delivered");
  assert.deepEqual(pushes[0], {
    taskId: "task-1",
    roleName: "leader",
    receiptId: "prompt-1",
    text: "Continue the task",
    readinessProbe: pushes[0].readinessProbe
  });

  outcome = "already-sent";
  assert.equal(await adapter.tryPush({ binding, envelope }), "delivered");
  outcome = "not-ready";
  assert.equal(await adapter.tryPush({ binding, envelope }), "busy");
  status = "exited";
  assert.equal(await adapter.tryPush({ binding, envelope }), "unavailable");
  assert.equal(pushes.length, 3);
});

test("TmuxPromptPushAdapter prefers the async tmux path", async () => {
  const calls = [];
  const tmux = {
    probeRoleStatus() {
      throw new Error("sync probe must not be used");
    },
    async probeRoleStatusAsync(hostId, roleName) {
      calls.push(["probe-async", hostId, roleName]);
      return "running";
    },
    sendRoleInputOnceIfReady() {
      throw new Error("sync delivery must not be used");
    },
    async sendRoleInputOnceIfReadyAsync(hostId, roleName, receiptId, text) {
      calls.push(["send-async", hostId, roleName, receiptId, text]);
      return "sent";
    }
  };
  const host = new TmuxSessionHost(
    { plan: () => fakePlan(), planGlobalRole: () => fakePlan() },
    { ensureRoleWindow: () => true, probeRoleStatus: () => "running", killRole: () => {} },
    { createBindingId: () => "binding-async" }
  );
  const binding = await host.start(createSessionLaunchRequest({
    mode: "new",
    launchId: "launch-async",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex-personal",
    adapterId: "codex",
    workspace: "/repo"
  }));
  const envelope = createPromptEnvelope({
    id: "prompt-async",
    source: { kind: "agent-run", id: "run-async" },
    text: String.raw`literal ; $HOME "quotes"`,
    createdAt: new Date("2026-07-22T08:00:00.000Z")
  });

  const adapter = new TmuxPromptPushAdapter(tmux, () => () => true);
  assert.equal(await adapter.tryPush({ binding, envelope }), "delivered");
  assert.deepEqual(calls, [
    ["probe-async", "task-1", "leader"],
    ["send-async", "task-1", "leader", "prompt-async", envelope.text]
  ]);
});
