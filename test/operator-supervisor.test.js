import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOperatorDelivery } from "../dist/operator/operatorDelivery.js";
import {
  LocalOperatorDeliveryControllerPort,
  OperatorStructuredPtyProtocolError,
  OperatorSupervisor,
  OperatorSupervisorFenceError
} from "../dist/operator/operatorSupervisor.js";
import { InMemoryOperatorRoleBindingAuthority } from "../dist/operator/operatorRoleBindingAuthority.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-operator-supervisor-"));
  ensureStorageSchema(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function seedDelivery(home) {
  executeDomainTransaction(home, "seed-delivery", (workingRoot) => {
    new FileTaskStore(workingRoot).saveOperatorDelivery(createOperatorDelivery(
      "delivery-1",
      1,
      "task-1",
      "input-1",
      new Date("2026-07-14T09:00:00.000Z")
    ));
  });
}

function authority() {
  return new InMemoryOperatorRoleBindingAuthority({
    roleName: "operator",
    generation: "role-generation-1",
    agentId: "codex",
    adapterId: "codex",
    workspace: "/workspace/operator"
  }, {
    nextReservationId: () => "reservation-1",
    nextNativeSessionId: () => "native-1",
    now: () => new Date("2026-07-14T09:00:00.000Z")
  });
}

test("foreground supervisor accepts structured PTY delivery before transport ACK, without claiming display", (t) => {
  const home = createHome(t);
  seedDelivery(home);
  const roleAuthority = authority();
  const seen = [];
  const transport = {
    start: (context) => seen.push({ type: "start", context }),
    request: (message) => {
      seen.push({ type: "request", message });
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { accepted: true }
      };
    },
    stop: () => seen.push({ type: "stop" })
  };
  const supervisor = new OperatorSupervisor({
    supervisorId: "supervisor-a",
    authority: roleAuthority,
    controller: new LocalOperatorDeliveryControllerPort(home, {
      nextTransactionId: (() => {
        let count = 0;
        return () => `operator-supervisor-${++count}`;
      })()
    }),
    transport,
    nextLeaseId: () => "lease-1",
    leaseDurationMs: 30_000
  });

  supervisor.start(new Date("2026-07-14T09:00:01.000Z"));
  const delivered = supervisor.deliverNext(new Date("2026-07-14T09:00:02.000Z"));

  assert.equal(delivered.status, "accepted");
  assert.deepEqual(seen[1].message, {
    jsonrpc: "2.0",
    id: "delivery-1",
    method: "taskmux.operator.input_request",
    params: {
      type: "input-request",
      deliveryId: "delivery-1",
      taskId: "task-1",
      requestId: "input-1"
    }
  });
  assert.equal("displayedAt" in delivered, false);
  supervisor.stop("stopped", new Date("2026-07-14T09:00:03.000Z"));
  assert.equal(roleAuthority.read().session.status, "stopped");
});

test("fenced binding changes prevent stale foreground supervision before it can lease new work", (t) => {
  const home = createHome(t);
  seedDelivery(home);
  const roleAuthority = authority();
  const supervisor = new OperatorSupervisor({
    supervisorId: "supervisor-a",
    authority: roleAuthority,
    controller: new LocalOperatorDeliveryControllerPort(home),
    transport: {
      start: () => {},
      request: () => ({ jsonrpc: "2.0", id: "delivery-1", result: { accepted: true } })
    },
    nextLeaseId: () => "lease-1",
    leaseDurationMs: 30_000
  });
  supervisor.start(new Date("2026-07-14T09:00:01.000Z"));
  roleAuthority.replaceBinding({
    roleName: "operator",
    generation: "role-generation-2",
    agentId: "codex",
    adapterId: "codex",
    workspace: "/workspace/operator"
  });

  assert.throws(
    () => supervisor.deliverNext(new Date("2026-07-14T09:00:02.000Z")),
    OperatorSupervisorFenceError
  );
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "pending");
});

test("a malformed structured PTY response releases the transport lease without inventing delivery success", (t) => {
  const home = createHome(t);
  seedDelivery(home);
  const supervisor = new OperatorSupervisor({
    supervisorId: "supervisor-a",
    authority: authority(),
    controller: new LocalOperatorDeliveryControllerPort(home),
    transport: {
      start: () => {},
      request: () => ({ jsonrpc: "2.0", id: "wrong-id", result: { accepted: true } })
    },
    nextLeaseId: () => "lease-1",
    leaseDurationMs: 30_000
  });
  supervisor.start(new Date("2026-07-14T09:00:01.000Z"));

  assert.throws(
    () => supervisor.deliverNext(new Date("2026-07-14T09:00:02.000Z")),
    OperatorStructuredPtyProtocolError
  );
  assert.equal(new FileTaskStore(home).getOperatorDelivery("delivery-1").status, "pending");
});
