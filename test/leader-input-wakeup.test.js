import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent, configuredAgentToDefinition } from "../dist/agent/agent.js";
import { ControllerInputService } from "../dist/input/controllerInputService.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import {
  LeaderInputWakeupService,
  processLeaderInputWakeups
} from "../dist/scheduler/leaderInputWakeupService.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../dist/role/role.js";
import { createAgentRun } from "../dist/run/agentRun.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const seedNow = new Date("2026-07-14T08:40:00.000Z");

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-leader-input-wakeup-"));
  ensureStorageSchema(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function requester(options = {}) {
  return {
    roleName: "leader",
    agentId: options.agentId ?? "codex",
    adapterId: "codex",
    sessionRoot: "/tmp",
    nativeSessionId: options.nativeSessionId ?? "leader-native-1",
    agentRunId: options.agentRunId ?? "leader-run-1"
  };
}

function seedResolvedInput(home, options = {}) {
  const taskId = options.taskId ?? "task-1";
  const requestId = options.requestId ?? "input-1";
  const resolutionId = options.resolutionId ?? "resolution-1";
  const agentRunId = options.agentRunId ?? "leader-run-1";
  const nativeSessionId = options.nativeSessionId ?? "leader-native-1";
  const agentId = options.agentId ?? "codex";
  const origin = requester({ agentId, nativeSessionId, agentRunId });
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], seedNow);
  const binding = createRoleAgentBinding(configuredAgentToDefinition(agent));
  store.saveTask(createTask(taskId, "Task one", seedNow));
  store.saveRole(taskId, updateRoleStatus(createRole(
    taskId, "leader", [binding], agentId, `/workspace/${taskId}`, seedNow
  ), "running", seedNow));
  store.saveRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet(
      { scope: "task", taskId, roleName: "leader" },
      agentId,
      seedNow
    ),
    {
      agentId,
      adapterId: "codex",
      nativeSessionId,
      policy: "fixed",
      status: "running",
      sessionRoot: origin.sessionRoot,
      configFingerprint: {
        overall: "a".repeat(64),
        replayable: "a".repeat(64),
        permission: "a".repeat(64),
        sessionBound: "a".repeat(64)
      },
      permissionEnvelope: { adapterId: "codex" }
    },
    seedNow
  ));
  const run = createAgentRun(
    agentRunId, taskId, "leader", "resume", "Continue leadership", seedNow
  );
  store.saveAgentRun(run);
  store.saveActiveAgentRun(run);

  const ids = {
    nextRequestId: () => requestId,
    nextResolutionId: () => resolutionId,
    nextDeliveryId: () => options.deliveryId ?? "delivery-1"
  };
  const input = new ControllerInputService(home, ids);
  input.create("create-input", {
    taskId,
    requester: origin,
    input: {
      question: "Use safe path?",
      choices: [{ key: "safe", label: "Safe path" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    }
  }, new Date("2026-07-14T08:40:01.000Z"));
  input.resolve("resolve-input", {
    requestId,
    answer: { choiceKey: "safe", text: "ignored" },
    operatorPresence: "online"
  }, new Date("2026-07-14T08:40:02.000Z"));
}

function claimInput(controllerId, generation, claimId) {
  return { controllerId, controllerGeneration: generation, claimId, durationMs: 1_000 };
}

function leaderTarget(options = {}) {
  return {
    taskId: options.taskId ?? "task-1",
    roleName: "leader",
    agentId: options.agentId ?? "codex",
    adapterId: "codex",
    sessionRoot: "/tmp",
    nativeSessionId: options.nativeSessionId ?? "leader-native-1",
    agentRunId: options.agentRunId ?? "leader-run-1"
  };
}

function targetKey(target) {
  return `${target.taskId}\u0000${target.roleName}`;
}

function sameTarget(left, right) {
  return right !== undefined &&
    left.taskId === right.taskId &&
    left.roleName === right.roleName &&
    left.agentId === right.agentId &&
    left.adapterId === right.adapterId &&
    left.sessionRoot === right.sessionRoot &&
    left.nativeSessionId === right.nativeSessionId &&
    left.agentRunId === right.agentRunId;
}

class ExactReceiptTmux {
  panes = new Map();
  receipts = new Set();
  inputs = [];
  beforeSend = null;
  afterEffect = null;
  unavailableTasks = new Set();

  setPane(target) {
    this.panes.set(targetKey(target), { ...target });
  }

  probeRoleStatus(taskId, roleName) {
    return this.panes.has(`${taskId}\u0000${roleName}`) ? "running" : "exited";
  }

  sendRoleInput() {
    throw new Error("Leader wakeups must not use raw role-name input delivery");
  }

  sendExactRoleInputOnce(expected, deliveryId, input) {
    this.beforeSend?.(expected);
    if (this.unavailableTasks.has(expected.taskId)) {
      throw new Error(`Leader pane is unavailable: ${expected.taskId}`);
    }
    const actual = this.panes.get(targetKey(expected));
    if (!sameTarget(expected, actual)) {
      return "fenced";
    }
    const receipt = `${targetKey(actual)}\u0000${deliveryId}`;
    if (!this.receipts.has(receipt)) {
      this.receipts.add(receipt);
      this.inputs.push({ expected: { ...expected }, deliveryId, input });
      this.afterEffect?.();
      return "applied";
    }
    return "receipt-present";
  }
}

function replaceLeaderSession(home, nativeSessionId) {
  executeDomainTransaction(home, `replace-leader-session-${nativeSessionId}`, (workingRoot) => {
    const store = new FileTaskStore(workingRoot);
    const sessionSet = store.getRoleSessionSet("task-1", "leader");
    const session = sessionSet.sessions.codex;
    store.saveRoleSessionSet(recordRoleAgentSession(sessionSet, {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId,
      policy: session.policy,
      status: session.status,
      sessionRoot: session.sessionRoot,
      configFingerprint: session.lastLaunchConfigHash,
      permissionEnvelope: session.permissionEnvelope,
      replacementReason: "Restarted after transport failure."
    }, new Date("2026-07-14T08:40:03.000Z")));
  });
}

test("an exact Leader tuple uses one receipt-bound transport delivery before resuming its blocked run", (t) => {
  const home = createHome(t);
  seedResolvedInput(home);
  const tmux = new ExactReceiptTmux();
  tmux.setPane(leaderTarget());

  const processed = processLeaderInputWakeups(
    home,
    tmux,
    new Date("2026-07-14T08:40:03.000Z")
  );

  assert.deepEqual(processed, ["input-1"]);
  assert.equal(tmux.inputs.length, 1);
  assert.deepEqual(
    tmux.inputs[0].expected,
    leaderTarget()
  );
  assert.match(tmux.inputs[0].deliveryId, /^input-resolution-[a-f0-9]{64}$/);
  assert.match(tmux.inputs[0].input, /TaskMux input resolution delivery/);
  assert.match(tmux.inputs[0].input, /resolution-1/);
  assert.match(tmux.inputs[0].input, /taskmux task context task-1 --format json/);

  const store = new FileTaskStore(home);
  const wakeup = store.getInputResolutionWakeup("task-1", "input-1");
  assert.deepEqual(
    {
      taskId: wakeup.taskId,
      roleName: wakeup.roleName,
      agentId: wakeup.agentId,
      adapterId: wakeup.adapterId,
      sessionRoot: wakeup.sessionRoot,
      nativeSessionId: wakeup.nativeSessionId,
      runId: wakeup.agentRunId
    },
    {
      taskId: "task-1",
      roleName: "leader",
      agentId: "codex",
      adapterId: "codex",
      sessionRoot: "/tmp",
      nativeSessionId: "leader-native-1",
      runId: "leader-run-1"
    }
  );
  assert.equal(wakeup.status, "completed");
  assert.equal(wakeup.receipt.deliveryId, wakeup.deliveryId);
  assert.equal(store.getActiveAgentRun("task-1", "leader").status, "active");
});

test("a preflight-to-send Leader pane replacement fails closed without ACKing or typing into the replacement pane", (t) => {
  const home = createHome(t);
  seedResolvedInput(home);
  const tmux = new ExactReceiptTmux();
  tmux.setPane(leaderTarget());
  let replaced = false;
  tmux.beforeSend = () => {
    if (replaced) return;
    replaced = true;
    tmux.setPane(leaderTarget({ nativeSessionId: "leader-native-replacement" }));
  };

  assert.deepEqual(
    processLeaderInputWakeups(
      home,
      tmux,
      new Date("2026-07-14T08:40:03.000Z")
    ),
    []
  );
  assert.equal(tmux.inputs.length, 0, "replacement pane must not receive the old tuple");

  const store = new FileTaskStore(home);
  assert.equal(store.getInputResolutionWakeup("task-1", "input-1").status, "pending");
  assert.equal(store.getActiveAgentRun("task-1", "leader").status, "blocked");
});

test("a controller restart fences stale exact-Leader wakeup claims and only the current claim can resume", (t) => {
  const home = createHome(t);
  seedResolvedInput(home);
  const service = new LeaderInputWakeupService(home);

  const first = service.claimNext(
    "leader-claim-a",
    claimInput("controller-a", "generation-a", "claim-a"),
    new Date("2026-07-14T08:40:03.000Z")
  );
  assert.equal(first.agentRunId, "leader-run-1");
  assert.equal(first.adapterId, "codex");
  assert.equal(first.sessionRoot, "/tmp");
  assert.equal(first.nativeSessionId, "leader-native-1");
  assert.equal(
    service.claimNext(
      "leader-claim-b-too-early",
      claimInput("controller-b", "generation-b", "claim-b"),
      new Date("2026-07-14T08:40:03.500Z")
    ),
    null
  );

  const reclaimed = service.claimNext(
    "leader-claim-b",
    claimInput("controller-b", "generation-b", "claim-b"),
    new Date("2026-07-14T08:40:04.001Z")
  );
  assert.equal(reclaimed.claimId, "claim-b");

  assert.throws(
    () => service.acceptTransport(
      "leader-accept-stale",
      first,
      new Date("2026-07-14T08:40:04.002Z")
    ),
    /fenced/i
  );
  assert.equal(service.acceptTransport(
    "leader-accept-current",
    reclaimed,
    new Date("2026-07-14T08:40:04.003Z")
  ), true);
  assert.equal(
    service.finalizeAccepted(
      "leader-finalize-current",
      reclaimed.taskId,
      reclaimed.requestId,
      new Date("2026-07-14T08:40:04.004Z")
    ).status,
    "completed"
  );

  const store = new FileTaskStore(home);
  assert.equal(store.getActiveAgentRun("task-1", "leader").status, "active");
  assert.equal(store.getInputResolutionWakeup("task-1", "input-1").status, "completed");
});

test("a changed Leader native session terminalizes the wakeup instead of restoring a replacement Leader", (t) => {
  const home = createHome(t);
  seedResolvedInput(home);
  replaceLeaderSession(home, "leader-native-replacement");

  const service = new LeaderInputWakeupService(home);
  assert.equal(
    service.claimNext(
      "leader-claim-drift",
      claimInput("controller-a", "generation-a", "claim-a"),
      new Date("2026-07-14T08:40:04.000Z")
    ),
    null
  );

  const store = new FileTaskStore(home);
  assert.equal(store.getInputResolutionWakeup("task-1", "input-1").status, "abandoned");
  assert.equal(store.getActiveAgentRun("task-1", "leader").status, "blocked");
  assert.equal(store.getOperatorNotification("task-1").type, "leader-recovery-failed");
  assert.match(store.getOperatorNotification("task-1").message, /origin-session-or-agent-drift/);
});

test("a send-to-durable-ACK crash replays through the pane receipt without duplicate Leader input", (t) => {
  const home = createHome(t);
  seedResolvedInput(home);
  const tmux = new ExactReceiptTmux();
  tmux.setPane(leaderTarget());
  let crash = true;
  tmux.afterEffect = () => {
    if (crash) {
      crash = false;
      throw new Error("simulated Controller crash after tmux pane receipt");
    }
  };

  assert.deepEqual(
    processLeaderInputWakeups(
      home,
      tmux,
      new Date("2026-07-14T08:40:03.000Z")
    ),
    []
  );
  assert.equal(tmux.inputs.length, 1);
  assert.equal(new FileTaskStore(home).getInputResolutionWakeup("task-1", "input-1").status, "pending");

  assert.deepEqual(
    processLeaderInputWakeups(
      home,
      tmux,
      new Date("2026-07-14T08:40:04.000Z")
    ),
    ["input-1"]
  );
  assert.equal(tmux.inputs.length, 1, "pane receipt must suppress replayed native input");
  assert.equal(new FileTaskStore(home).getInputResolutionWakeup("task-1", "input-1").status, "completed");
});

test("one task's unavailable exact pane does not prevent a second task's exact wakeup", (t) => {
  const home = createHome(t);
  seedResolvedInput(home);
  seedResolvedInput(home, {
    taskId: "task-2",
    requestId: "input-2",
    resolutionId: "resolution-2",
    agentRunId: "leader-run-2",
    nativeSessionId: "leader-native-2",
    deliveryId: "delivery-2"
  });
  const tmux = new ExactReceiptTmux();
  tmux.setPane(leaderTarget());
  tmux.setPane(leaderTarget({
    taskId: "task-2",
    agentRunId: "leader-run-2",
    nativeSessionId: "leader-native-2"
  }));
  tmux.unavailableTasks.add("task-1");

  assert.deepEqual(
    processLeaderInputWakeups(
      home,
      tmux,
      new Date("2026-07-14T08:40:03.000Z")
    ),
    ["input-2"]
  );
  assert.deepEqual(tmux.inputs.map((message) => message.expected.taskId), ["task-2"]);

  const store = new FileTaskStore(home);
  assert.equal(store.getInputResolutionWakeup("task-1", "input-1").status, "pending");
  assert.equal(store.getActiveAgentRun("task-1", "leader").status, "blocked");
  assert.equal(store.getInputResolutionWakeup("task-2", "input-2").status, "completed");
  assert.equal(store.getActiveAgentRun("task-2", "leader").status, "active");
});
