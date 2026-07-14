import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRoleSessionSet, recordRoleAgentSession } from "../dist/executor/agentExecutor.js";
import { createOperatorDelivery } from "../dist/operator/operatorDelivery.js";
import { OperatorDeliveryService } from "../dist/operator/operatorDeliveryService.js";
import { createGlobalRole } from "../dist/role/role.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-operator-delivery-service-"));
  ensureStorageSchema(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function seed(home) {
  executeDomainTransaction(home, "seed-deliveries", (workingRoot) => {
    const store = new FileTaskStore(workingRoot);
    store.saveOperatorDelivery(createOperatorDelivery(
      "delivery-2", 2, "task-2", "input-2", new Date("2026-07-14T07:30:00.000Z")
    ));
    store.saveOperatorDelivery(createOperatorDelivery(
      "delivery-1", 1, "task-1", "input-1", new Date("2026-07-14T07:30:00.000Z")
    ));
  });
}

function seedActiveOperatorTarget(home) {
  const now = new Date("2026-07-14T07:30:00.000Z");
  const sessionRoot = join(home, "operator-native-1");
  mkdirSync(sessionRoot);
  const role = createGlobalRole("operator", [{
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  }], "codex", home, now);
  let sessions = createRoleSessionSet({ scope: "global", roleName: "operator" }, "codex", now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "operator-native-1",
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
  }, now);
  executeDomainTransaction(home, "seed-active-operator-target", (workingRoot) => {
    new FileTaskStore(workingRoot).saveGlobalRoleWithSessionSet(role, sessions);
  });
  return {
    agentId: "codex",
    adapterId: "codex",
    sessionRoot,
    nativeSessionId: "operator-native-1"
  };
}

function digest(value = "operator-delivery-service") {
  return createHash("sha256").update(value).digest("hex");
}

test("leases FIFO pointer deliveries and acknowledges native transport acceptance only", (t) => {
  const home = createHome(t);
  seed(home);
  const service = new OperatorDeliveryService(home);
  const now = new Date("2026-07-14T07:30:10.000Z");

  const lease = service.leaseNext(
    "operator-lease-1",
    { ownerId: "operator-a", leaseId: "lease-a", durationMs: 30_000 },
    now
  );
  assert.equal(lease.deliveryId, "delivery-1");
  assert.equal(lease.status, "leased");
  assert.equal(lease.leaseGeneration, 1);

  const accepted = service.acknowledgeTransportAcceptance(
    "operator-ack-1",
    { deliveryId: "delivery-1", ownerId: "operator-a", leaseId: "lease-a", leaseGeneration: 1 },
    new Date("2026-07-14T07:30:11.000Z")
  );
  assert.equal(accepted.status, "accepted");
  assert.equal("displayedAt" in accepted, false);

  const next = service.leaseNext(
    "operator-lease-2",
    { ownerId: "operator-a", leaseId: "lease-b", durationMs: 30_000 },
    new Date("2026-07-14T07:30:12.000Z")
  );
  assert.equal(next.deliveryId, "delivery-2");
});

test("fences stale acknowledgements and recovers an expired lease through a new transaction", (t) => {
  const home = createHome(t);
  seed(home);
  const service = new OperatorDeliveryService(home);

  service.leaseNext(
    "operator-lease-1",
    { ownerId: "operator-a", leaseId: "lease-a", durationMs: 10 },
    new Date("2026-07-14T07:30:10.000Z")
  );
  assert.throws(
    () => service.acknowledgeTransportAcceptance(
      "operator-stale-ack",
      { deliveryId: "delivery-1", ownerId: "operator-a", leaseId: "lease-a", leaseGeneration: 1 },
      new Date("2026-07-14T07:30:10.011Z")
    ),
    /lease/i
  );

  const recovered = service.leaseNext(
    "operator-lease-2",
    { ownerId: "operator-b", leaseId: "lease-b", durationMs: 30_000 },
    new Date("2026-07-14T07:30:10.011Z")
  );
  assert.equal(recovered.deliveryId, "delivery-1");
  assert.equal(recovered.leaseOwnerId, "operator-b");
  assert.equal(recovered.leaseGeneration, 2);
  assert.throws(
    () => service.acknowledgeTransportAcceptance(
      "operator-old-owner-ack",
      { deliveryId: "delivery-1", ownerId: "operator-a", leaseId: "lease-a", leaseGeneration: 1 },
      new Date("2026-07-14T07:30:10.012Z")
    ),
    /lease/i
  );
});

test("active-target ACK accepts only the matching durable tuple and preserves generation fencing", (t) => {
  const home = createHome(t);
  seed(home);
  const target = seedActiveOperatorTarget(home);
  const service = new OperatorDeliveryService(home);

  const first = service.leaseNext(
    "operator-active-target-lease-1",
    { ownerId: "operator-a", leaseId: "lease-a", durationMs: 30_000 },
    new Date("2026-07-14T07:30:10.000Z")
  );
  assert.equal(first.deliveryId, "delivery-1");
  const accepted = service.acknowledgeActiveTargetTransportAcceptance(
    "operator-active-target-ack-1",
    {
      deliveryId: "delivery-1",
      ownerId: "operator-a",
      leaseId: "lease-a",
      leaseGeneration: 1,
      expectedActiveTarget: target
    },
    new Date("2026-07-14T07:30:11.000Z")
  );
  assert.equal(accepted.status, "accepted");

  const expired = service.leaseNext(
    "operator-active-target-lease-2",
    { ownerId: "operator-a", leaseId: "lease-b", durationMs: 10 },
    new Date("2026-07-14T07:30:12.000Z")
  );
  assert.equal(expired.deliveryId, "delivery-2");
  const recovered = service.leaseNext(
    "operator-active-target-lease-3",
    { ownerId: "operator-b", leaseId: "lease-c", durationMs: 30_000 },
    new Date("2026-07-14T07:30:12.011Z")
  );
  assert.equal(recovered.leaseGeneration, 2);
  assert.throws(
    () => service.acknowledgeActiveTargetTransportAcceptance(
      "operator-active-target-stale-ack",
      {
        deliveryId: "delivery-2",
        ownerId: "operator-a",
        leaseId: "lease-b",
        leaseGeneration: 1,
        expectedActiveTarget: target
      },
      new Date("2026-07-14T07:30:12.012Z")
    ),
    /lease/i
  );
  const current = new FileTaskStore(home).getOperatorDelivery("delivery-2");
  assert.equal(current.status, "leased");
  assert.equal(current.leaseOwnerId, "operator-b");
  assert.equal(current.leaseGeneration, 2);
});

test("does not let an expired owner release a delivery with a stale lease timestamp", (t) => {
  const home = createHome(t);
  seed(home);
  const service = new OperatorDeliveryService(home);

  service.leaseNext(
    "operator-lease-1",
    { ownerId: "operator-a", leaseId: "lease-a", durationMs: 10 },
    new Date("2026-07-14T07:30:10.000Z")
  );

  assert.throws(
    () => service.releaseLease(
      "operator-stale-release",
      { deliveryId: "delivery-1", ownerId: "operator-a", leaseId: "lease-a", leaseGeneration: 1 },
      new Date("2026-07-14T07:30:10.011Z")
    ),
    /lease/i
  );
});
