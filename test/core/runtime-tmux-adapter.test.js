import assert from "node:assert/strict";
import test from "node:test";

import {
  TmuxPromptPushAdapter,
  TmuxSessionHost,
  createPromptEnvelope,
  createRuntimeBinding,
  createSessionLaunchRequest
} from "../../dist/runtime/index.js";
import { testEffectiveLaunch } from "../helpers/effectiveLaunch.js";

function effective(workspace = "/repo") {
  return testEffectiveLaunch({
    agentId: "codex-personal",
    adapterId: "codex",
    workspaceRoot: workspace
  });
}

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
      return { ...fakePlan(), initialPromptRunId: input.runId };
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
    effective: effective(),
    workspace: "/repo",
    runId: "agent-run-1"
  });

  const binding = await host.start(request, (preflight) => {
    calls.push(["preflight", preflight]);
  });

  assert.deepEqual(calls.slice(0, 3), [
    ["plan", {
      taskId: "task-1",
      roleName: "leader",
      agentId: "codex-personal",
      adapterId: "codex",
      effective: effective(),
      launchId: "launch-1",
      mode: "new",
      runId: "agent-run-1"
    }],
    ["preflight", {
      owner: { scope: "task", taskId: "task-1", roleName: "leader" },
      launchId: "launch-1",
      runId: "agent-run-1",
      agentId: "codex-personal",
      adapterId: "codex",
      effective: effective(),
      initialPromptRunId: "agent-run-1"
    }],
    ["ensure-async", "task-1", fakePlan().role, fakePlan().launch]
  ]);
  assert.equal(binding.id, "binding-1");
  assert.equal(binding.launchId, "launch-1");
  assert.equal(binding.hostRef.startsWith("yui-tmux:v1:"), true);
  assert.equal("initialPromptReceipt" in binding, false);
  assert.equal(binding.initialPromptRunId, "agent-run-1");
  assert.equal("nativeSessionId" in binding, false);
  assert.deepEqual(await host.inspect(binding), { state: "running" });
  assert.deepEqual(calls.at(-1), ["probe-async", "task-1", "leader"]);
});

test("planner metadata cannot inject a launch prompt acknowledgement into a runtime binding", async () => {
  let queried = false;
  const host = new TmuxSessionHost({
    plan() {
      return {
        ...fakePlan(),
        initialPromptReceipt: { receiptId: "not-a-supported-seam" }
      };
    },
    planGlobalRole() { throw new Error("unexpected global plan"); }
  }, {
    async ensureRoleWindowAsync() { return true; },
    async hasDeliveryReceiptAsync() {
      queried = true;
      throw new Error("launch must not query a delivery receipt");
    },
    probeRoleStatus() { return "running"; },
    killRole() {}
  });
  const request = createSessionLaunchRequest({
    mode: "new",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex-personal",
    adapterId: "codex",
    effective: effective(),
    workspace: "/repo",
    runId: "agent-run-1"
  });

  const binding = await host.start(request);
  assert.equal(queried, false);
  assert.equal(binding.hostCreated, true);
  assert.equal("initialPromptReceipt" in binding, false);
});

test("an existing tmux host cannot claim that a newly planned prompt was carried at launch", async () => {
  const host = new TmuxSessionHost({
    plan(input) {
      return { ...fakePlan(), initialPromptRunId: input.runId };
    },
    planGlobalRole() { throw new Error("unexpected global plan"); }
  }, {
    async ensureRoleWindowAsync() { return false; },
    probeRoleStatus() { return "running"; },
    killRole() {}
  });
  const binding = await host.start(createSessionLaunchRequest({
    mode: "new",
    launchId: "launch-existing",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex-personal",
    adapterId: "codex",
    effective: effective(),
    workspace: "/repo",
    runId: "agent-run-existing"
  }));

  assert.equal(binding.hostCreated, false);
  assert.equal("initialPromptRunId" in binding, false);
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
    effective: effective(),
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
    effective: effective(),
    workspace: "/repo",
    nativeSessionId: "native-1"
  }));

  assert.deepEqual(calls.slice(0, 2), [
    ["plan-global", {
      roleName: "operator",
      agentId: "codex-personal",
      adapterId: "codex",
      effective: effective(),
      launchId: "launch-2",
      mode: "resume",
      nativeSessionId: "native-1"
    }],
    ["ensure", "global-runtime", { name: "operator", workspace: "/repo" }, fakePlan().launch]
  ]);
  assert.equal(binding.nativeSessionId, "native-1");

  assert.deepEqual(
    await host.inspectOwner({ scope: "global", roleName: "operator" }),
    { state: "running" }
  );
  assert.equal(
    await host.stopOwner({ scope: "global", roleName: "operator" }),
    true
  );
  assert.equal(
    calls.some((call) => (
      call[0] === "kill"
      && call[1] === "global-runtime"
      && call[2] === "operator"
    )),
    true
  );
  assert.deepEqual(await host.inspect(binding), {
    state: "stopped",
    nativeSessionId: "native-1"
  });
  await host.stop(binding);
  assert.equal(calls.filter(([kind]) => kind === "kill").length, 1);
});

test("TmuxSessionHost accepts a kill error only when the exact role is proven stopped", async () => {
  const planner = { plan: () => fakePlan(), planGlobalRole: () => fakePlan() };
  let status = "running";
  const tmux = {
    ensureRoleWindow: () => true,
    probeRoleStatus: () => status,
    killRole() {
      status = "exited";
      throw new Error("server exited unexpectedly");
    }
  };
  const host = new TmuxSessionHost(planner, tmux);
  const binding = createRuntimeBinding({
    id: "binding-1",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "worker" },
    agentId: "codex",
    adapterId: "codex",
    hostRef: "yui-tmux:v1:eyJzY29wZSI6InRhc2siLCJob3N0SWQiOiJ0YXNrLTEiLCJyb2xlTmFtZSI6IndvcmtlciJ9"
  });

  await host.stop(binding);
});

test("TmuxSessionHost preserves a kill error while the exact role remains live", async () => {
  const planner = { plan: () => fakePlan(), planGlobalRole: () => fakePlan() };
  const failure = new Error("kill failed");
  const tmux = {
    ensureRoleWindow: () => true,
    probeRoleStatus: () => "running",
    killRole() { throw failure; }
  };
  const host = new TmuxSessionHost(planner, tmux);
  const binding = createRuntimeBinding({
    id: "binding-1",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "worker" },
    agentId: "codex",
    adapterId: "codex",
    hostRef: "yui-tmux:v1:eyJzY29wZSI6InRhc2siLCJob3N0SWQiOiJ0YXNrLTEiLCJyb2xlTmFtZSI6IndvcmtlciJ9"
  });

  await assert.rejects(host.stop(binding), (error) => error === failure);
});

test("TmuxSessionHost preserves a kill error when the stop postcondition is unavailable", async () => {
  const planner = { plan: () => fakePlan(), planGlobalRole: () => fakePlan() };
  const failure = new Error("kill failed");
  let probes = 0;
  const tmux = {
    ensureRoleWindow: () => true,
    probeRoleStatus() {
      probes += 1;
      if (probes === 1) return "running";
      throw new Error("tmux unavailable");
    },
    killRole() { throw failure; }
  };
  const host = new TmuxSessionHost(planner, tmux);
  const binding = createRuntimeBinding({
    id: "binding-1",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "worker" },
    agentId: "codex",
    adapterId: "codex",
    hostRef: "yui-tmux:v1:eyJzY29wZSI6InRhc2siLCJob3N0SWQiOiJ0YXNrLTEiLCJyb2xlTmFtZSI6IndvcmtlciJ9"
  });

  await assert.rejects(host.stop(binding), (error) => error === failure);
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
      effective: effective("/expected"),
      workspace: "/expected"
    })),
    /workspace does not match the runtime request/u
  );
  assert.equal(ensured, false);
});

test("TmuxSessionHost inventories Task and global owners from one tmux snapshot", async () => {
  let inventoryCalls = 0;
  const host = new TmuxSessionHost(
    { plan: () => fakePlan(), planGlobalRole: () => fakePlan() },
    {
      ensureRoleWindow: () => true,
      probeRoleStatus() {
        throw new Error("per-owner probes must not be used");
      },
      killRole() {},
      inspectRolePaneInventory() {
        throw new Error("async inventory must be preferred");
      },
      async inspectRolePaneInventoryAsync() {
        inventoryCalls += 1;
        return [
          { taskId: "task-1", roleName: "leader", dead: false },
          { taskId: "operator", roleName: "operator", dead: true }
        ];
      }
    },
    { createBindingId: () => "binding-inventory" }
  );
  const owners = [
    { scope: "task", taskId: "task-1", roleName: "leader" },
    { scope: "global", roleName: "operator" },
    { scope: "task", taskId: "task-missing", roleName: "worker" }
  ];

  assert.deepEqual(await host.inspectOwners(owners), [
    { owner: owners[0], inspection: { state: "running" } },
    { owner: owners[1], inspection: { state: "stopped" } },
    { owner: owners[2], inspection: { state: "stopped" } }
  ]);
  assert.equal(inventoryCalls, 1);
});

test("TmuxPromptPushAdapter maps tmux presence and process readiness to portable outcomes", async () => {
  const pushes = [];
  let status = "running";
  let outcome = "sent";
  const tmux = {
    probeRoleStatus: () => status,
    sendRoleInputOnceIfReady(taskId, roleName, receiptId, text, readinessProbe) {
      pushes.push({ taskId, roleName, receiptId, text, readinessProbe });
      return status === "exited" ? "unavailable" : outcome;
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
    effective: effective(),
    workspace: "/repo"
  }));
  const envelope = createPromptEnvelope({
    id: "agent-run:task-1/agent-run-1",
    source: { kind: "agent-run", taskId: "task-1", localId: "agent-run-1" },
    text: "Continue the task",
    createdAt: new Date("2026-07-22T08:00:00.000Z")
  });

  assert.equal(await adapter.tryPush({ binding, envelope }), "delivered");
  assert.deepEqual(pushes[0], {
    taskId: "task-1",
    roleName: "leader",
    receiptId: "agent-run:task-1/agent-run-1",
    text: "Continue the task",
    readinessProbe: pushes[0].readinessProbe
  });

  outcome = "already-sent";
  assert.equal(await adapter.tryPush({ binding, envelope }), "delivered");
  outcome = "not-ready";
  assert.equal(await adapter.tryPush({ binding, envelope }), "busy");
  status = "exited";
  assert.equal(await adapter.tryPush({ binding, envelope }), "unavailable");
  assert.equal(pushes.length, 4);
});

test("TmuxPromptPushAdapter prefers the async tmux path", async () => {
  const calls = [];
  let outcome = "sent";
  const tmux = {
    probeRoleStatus() {
      throw new Error("sync probe must not be used");
    },
    async probeRoleStatusAsync() {
      throw new Error("preflight status probe must not be used");
    },
    sendRoleInputOnceIfReady() {
      throw new Error("sync delivery must not be used");
    },
    async sendRoleInputOnceIfReadyAsync(hostId, roleName, receiptId, text) {
      calls.push(["send-async", hostId, roleName, receiptId, text]);
      return outcome;
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
    effective: effective(),
    workspace: "/repo"
  }));
  const envelope = createPromptEnvelope({
    id: "agent-run:task-1/agent-run-2",
    source: { kind: "agent-run", taskId: "task-1", localId: "agent-run-2" },
    text: String.raw`literal ; $HOME "quotes"`,
    createdAt: new Date("2026-07-22T08:00:00.000Z")
  });

  const adapter = new TmuxPromptPushAdapter(tmux, () => () => true);
  assert.equal(await adapter.tryPush({ binding, envelope }), "delivered");
  assert.deepEqual(calls, [
    ["send-async", "task-1", "leader", "agent-run:task-1/agent-run-2", envelope.text]
  ]);
  outcome = "unavailable";
  assert.equal(await adapter.tryPush({ binding, envelope }), "unavailable");
});
