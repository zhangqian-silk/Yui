import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInputRequest } from "../dist/input/inputRequest.js";
import { createOperatorDelivery } from "../dist/operator/operatorDelivery.js";
import { pumpOperatorDeliveries } from "../dist/operator/operatorDeliveryPump.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../dist/executor/agentExecutor.js";
import { createGlobalRole, updateGlobalRole } from "../dist/role/role.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const startedAt = new Date("2026-07-15T00:00:00.000Z");

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-operator-delivery-pump-"));
  ensureStorageSchema(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function digest(value = "operator-pump-test") {
  return createHash("sha256").update(value).digest("hex");
}

function seed(home, nativeSessionId = "operator-native-1") {
  const sessionRoot = join(home, `operator-${nativeSessionId}`);
  mkdirSync(sessionRoot);
  const role = createGlobalRole("operator", [{
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  }], "codex", home, startedAt);
  let sessions = createRoleSessionSet({ scope: "global", roleName: "operator" }, "codex", startedAt);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId,
    policy: "fixed",
    status: "running",
    sessionRoot,
    worktreeRoot: home,
    configFingerprint: {
      overall: digest(),
      replayable: digest(),
      permission: digest(),
      sessionBound: digest()
    },
    permissionEnvelope: {
      adapterId: "codex",
      sandbox: "workspace-write",
      approval: "on-request",
      additionalDirectoryHashes: []
    }
  }, startedAt);

  executeDomainTransaction(home, "seed-operator-delivery-pump", (workingRoot) => {
    const store = new FileTaskStore(workingRoot);
    store.saveGlobalRoleWithSessionSet(role, sessions);
    store.saveTask(createTask("task-1", "Await decision", startedAt));
    store.saveInputRequest(createInputRequest("input-1", "task-1", {
      roleName: "leader",
      agentId: "codex",
      adapterId: "codex",
      sessionRoot,
      nativeSessionId: "leader-native-1",
      agentRunId: "leader-run-1"
    }, {
      question: "Proceed?",
      choices: [],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    }, startedAt));
    store.saveOperatorDelivery(createOperatorDelivery(
      "delivery-1",
      1,
      "task-1",
      "input-1",
      startedAt
    ));
  });
}

function replaceActiveOperatorSession(home, nativeSessionId) {
  const sessionRoot = join(home, `operator-${nativeSessionId}`);
  mkdirSync(sessionRoot);
  executeDomainTransaction(home, `replace-operator-${nativeSessionId}`, (workingRoot) => {
    const store = new FileTaskStore(workingRoot);
    const role = store.getGlobalRole("operator");
    const current = store.getGlobalRoleSessionSet("operator");
    assert.ok(role);
    assert.ok(current);
    const previous = current.sessions.codex;
    const sessions = recordRoleAgentSession(current, {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId,
      policy: previous.policy,
      status: "running",
      sessionRoot,
      worktreeRoot: previous.worktreeRoot,
      configFingerprint: previous.lastLaunchConfigHash,
      permissionEnvelope: previous.permissionEnvelope,
      replacementReason: "test session drift"
    }, new Date("2026-07-15T00:00:00.001Z"));
    store.saveGlobalRoleWithSessionSet(role, sessions, true);
  });
}

function switchActiveOperator(home, nativeSessionId) {
  const sessionRoot = join(home, `operator-${nativeSessionId}`);
  mkdirSync(sessionRoot);
  executeDomainTransaction(home, `switch-operator-${nativeSessionId}`, (workingRoot) => {
    const store = new FileTaskStore(workingRoot);
    const role = store.getGlobalRole("operator");
    const current = store.getGlobalRoleSessionSet("operator");
    assert.ok(role);
    assert.ok(current);
    const previous = current.sessions.codex;
    let sessions = recordRoleAgentSession(current, {
      agentId: "claude",
      adapterId: "claude",
      nativeSessionId,
      policy: "fixed",
      status: "running",
      sessionRoot,
      worktreeRoot: previous.worktreeRoot,
      configFingerprint: previous.lastLaunchConfigHash,
      permissionEnvelope: {
        adapterId: "claude",
        mode: "default",
        allowedToolHashes: [],
        disallowedToolHashes: [],
        additionalDirectoryHashes: []
      }
    }, new Date("2026-07-15T00:00:00.001Z"));
    sessions = {
      ...sessions,
      activeAgentId: "claude",
      updatedAt: new Date("2026-07-15T00:00:00.001Z").toISOString()
    };
    const switchedRole = updateGlobalRole(role, {
      activeAgentId: "claude",
      agentBindings: {
        ...role.agentBindings,
        claude: {
          agentId: "claude",
          adapterId: "claude",
          config: { adapterId: "claude" }
        }
      }
    }, new Date("2026-07-15T00:00:00.001Z"));
    store.saveGlobalRoleWithSessionSet(switchedRole, sessions, true);
  });
}

function sequenceClock(values) {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    assert.ok(value instanceof Date, "trusted clock was read more often than expected");
    return value;
  };
}

class ReceiptTmux {
  receipts = new Set();
  inputs = [];
  afterEffect = null;

  probeRoleStatus() {
    return "running";
  }

  sendRoleInput() {
    throw new Error("pump must use the idempotent delivery transport");
  }

  sendRoleInputOnce(_taskId, _roleName, receiptId, input) {
    if (!this.receipts.has(receiptId)) {
      this.receipts.add(receiptId);
      this.inputs.push(input);
    }
    this.afterEffect?.();
  }
}

test("a send that crosses expiry is not ACKed, and a resumed owner uses the pane receipt without duplicate input", (t) => {
  const home = createHome(t);
  seed(home);
  const tmux = new ReceiptTmux();
  const clock = sequenceClock([
    new Date("2026-07-15T00:00:00.000Z"),
    new Date("2026-07-15T00:00:00.001Z"),
    new Date("2026-07-15T00:00:00.011Z"),
    new Date("2026-07-15T00:00:00.012Z"),
    new Date("2026-07-15T00:00:00.013Z"),
    new Date("2026-07-15T00:00:00.014Z"),
    new Date("2026-07-15T00:00:00.015Z"),
    new Date("2026-07-15T00:00:00.016Z")
  ]);

  assert.deepEqual(pumpOperatorDeliveries(home, tmux, {
    leaseDurationMs: 10,
    clock
  }), []);
  assert.equal(tmux.inputs.length, 1);
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "leased");

  assert.deepEqual(pumpOperatorDeliveries(home, tmux, {
    leaseDurationMs: 10,
    clock
  }), ["delivery-1"]);
  assert.equal(tmux.inputs.length, 1);
  assert.equal(tmux.receipts.size, 1);
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "accepted");

  assert.deepEqual(pumpOperatorDeliveries(home, tmux, {
    leaseDurationMs: 10,
    clock: () => new Date("2026-07-15T00:00:00.020Z")
  }), []);
  assert.equal(tmux.inputs.length, 1);
});

test("an O1 to O2 switch after final target check releases the O1 lease instead of ACKing it", (t) => {
  const home = createHome(t);
  seed(home);
  const tmux = new ReceiptTmux();
  let clockReads = 0;
  const clock = () => {
    clockReads += 1;
    if (clockReads === 3) {
      switchActiveOperator(home, "operator-native-2");
    }
    return new Date("2026-07-15T00:00:00.100Z");
  };

  assert.deepEqual(pumpOperatorDeliveries(home, tmux, { leaseDurationMs: 30_000, clock }), []);
  const released = new FileTaskStore(home).getOperatorDelivery("delivery-1");
  assert.equal(released.status, "pending");
  assert.equal(released.leaseGeneration, 1);
  assert.equal(tmux.inputs.length, 1);

  assert.deepEqual(pumpOperatorDeliveries(home, tmux, { leaseDurationMs: 30_000, clock }), ["delivery-1"]);
  assert.equal(tmux.inputs.length, 2);
  assert.equal(tmux.receipts.size, 2);
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "accepted");
});

test("an effect crash releases only the active generation and a new owner resumes through the receipt", (t) => {
  const home = createHome(t);
  seed(home);
  const tmux = new ReceiptTmux();
  let crash = true;
  tmux.afterEffect = () => {
    if (crash) {
      crash = false;
      throw new Error("simulated crash after tmux effect");
    }
  };

  assert.throws(
    () => pumpOperatorDeliveries(home, tmux, {
      leaseDurationMs: 30_000,
      clock: sequenceClock([
        new Date("2026-07-15T00:00:00.000Z"),
        new Date("2026-07-15T00:00:00.001Z"),
        new Date("2026-07-15T00:00:00.002Z")
      ])
    }),
    /simulated crash/
  );
  assert.equal(tmux.inputs.length, 1);
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "pending");

  assert.deepEqual(pumpOperatorDeliveries(home, tmux, {
    leaseDurationMs: 30_000,
    clock: sequenceClock([
      new Date("2026-07-15T00:00:00.003Z"),
      new Date("2026-07-15T00:00:00.004Z"),
      new Date("2026-07-15T00:00:00.005Z"),
      new Date("2026-07-15T00:00:00.006Z"),
      new Date("2026-07-15T00:00:00.007Z")
    ])
  }), ["delivery-1"]);
  assert.equal(tmux.inputs.length, 1);
  assert.equal(tmux.receipts.size, 1);
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "accepted");
});

test("session tuple drift releases the old generation and delivers once to the replacement pane", (t) => {
  const home = createHome(t);
  seed(home);
  const tmux = new ReceiptTmux();
  let drift = true;
  tmux.afterEffect = () => {
    if (drift) {
      drift = false;
      replaceActiveOperatorSession(home, "operator-native-2");
    }
  };

  const clock = sequenceClock([
    new Date("2026-07-15T00:00:00.000Z"),
    new Date("2026-07-15T00:00:00.001Z"),
    new Date("2026-07-15T00:00:00.002Z"),
    new Date("2026-07-15T00:00:00.003Z"),
    new Date("2026-07-15T00:00:00.004Z"),
    new Date("2026-07-15T00:00:00.005Z"),
    new Date("2026-07-15T00:00:00.006Z"),
    new Date("2026-07-15T00:00:00.007Z")
  ]);

  assert.deepEqual(pumpOperatorDeliveries(home, tmux, { leaseDurationMs: 30_000, clock }), []);
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "pending");
  assert.deepEqual(pumpOperatorDeliveries(home, tmux, { leaseDurationMs: 30_000, clock }), ["delivery-1"]);
  assert.equal(tmux.inputs.length, 2);
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "accepted");
});
