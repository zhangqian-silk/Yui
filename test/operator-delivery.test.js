import assert from "node:assert/strict";
import test from "node:test";

import {
  OperatorDeliveryLeaseError,
  acknowledgeOperatorTransportAcceptance,
  createOperatorDelivery,
  leaseOperatorDelivery,
  operatorDeliveryPayload,
  revokeOperatorDelivery
} from "../dist/operator/operatorDelivery.js";

const createdAt = new Date("2026-07-14T07:00:00.000Z");

test("keeps the durable delivery outbox pointer-only and treats ack as transport acceptance", () => {
  const pending = createOperatorDelivery(
    "delivery-1",
    1,
    "task-1",
    "input-1",
    createdAt
  );

  assert.deepEqual(pending, {
    schemaVersion: 1,
    deliveryId: "delivery-1",
    sequence: 1,
    type: "input-request",
    taskId: "task-1",
    requestId: "input-1",
    status: "pending",
    attemptCount: 0,
    leaseGeneration: 0,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString()
  });
  assert.deepEqual(operatorDeliveryPayload(pending), {
    type: "input-request",
    deliveryId: "delivery-1",
    taskId: "task-1",
    requestId: "input-1"
  });

  const leased = leaseOperatorDelivery(
    pending,
    { ownerId: "operator-a", leaseId: "lease-a", expiresAt: "2026-07-14T07:00:30.000Z" },
    new Date("2026-07-14T07:00:01.000Z")
  );
  const accepted = acknowledgeOperatorTransportAcceptance(
    leased,
    { ownerId: "operator-a", leaseId: "lease-a", leaseGeneration: 1 },
    new Date("2026-07-14T07:00:02.000Z")
  );

  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.transportAcceptedAt, "2026-07-14T07:00:02.000Z");
  assert.equal("displayedAt" in accepted, false);
  assert.equal("question" in accepted, false);
  assert.equal("answer" in accepted, false);
  assert.equal("leaseOwnerId" in accepted, false);
});

test("fences leases and only revokes unresolved transport work", () => {
  const pending = createOperatorDelivery(
    "delivery-1",
    1,
    "task-1",
    "input-1",
    createdAt
  );
  const leased = leaseOperatorDelivery(
    pending,
    { ownerId: "operator-a", leaseId: "lease-a", expiresAt: "2026-07-14T07:00:30.000Z" },
    new Date("2026-07-14T07:00:01.000Z")
  );

  assert.throws(
    () => acknowledgeOperatorTransportAcceptance(
      leased,
      { ownerId: "operator-b", leaseId: "lease-a", leaseGeneration: 1 },
      new Date("2026-07-14T07:00:02.000Z")
    ),
    OperatorDeliveryLeaseError
  );

  const revoked = revokeOperatorDelivery(
    leased,
    "request-terminal",
    new Date("2026-07-14T07:00:03.000Z")
  );
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedReason, "request-terminal");
  assert.throws(
    () => acknowledgeOperatorTransportAcceptance(
      revoked,
      { ownerId: "operator-a", leaseId: "lease-a", leaseGeneration: 1 },
      new Date("2026-07-14T07:00:04.000Z")
    ),
    OperatorDeliveryLeaseError
  );
});
