import { createHash, randomUUID } from "node:crypto";
import type { InputRequest } from "../input/inputRequest.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { FileTaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import type { OperatorDelivery } from "./operatorDelivery.js";
import {
  OperatorDeliveryService,
  type OperatorDeliveryActiveTarget
} from "./operatorDeliveryService.js";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const MAX_DELIVERIES_PER_PUMP = 100;

type ActiveOperatorTarget = OperatorDeliveryActiveTarget;

export type OperatorDeliveryPumpOptions = {
  leaseDurationMs?: number;
  maxDeliveries?: number;
  clock?: () => Date;
};

/**
 * Delivers the durable pointer-only outbox to the one live Operator pane.
 *
 * GlobalRoleSessionSet("operator") is the only session authority. The pump
 * snapshots its active tuple before every lease and again immediately before
 * acceptance. The final ACK repeats that tuple check in its authoritative
 * domain transaction, so a replacement cannot race between the check and
 * durable acceptance. A completed acceptance is durable; later Controller
 * restarts see no pending record to send again.
 */
export function pumpOperatorDeliveries(
  rootDir: string,
  tmux: TmuxManager,
  options: OperatorDeliveryPumpOptions = {}
): string[] {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const maxDeliveries = options.maxDeliveries ?? MAX_DELIVERIES_PER_PUMP;
  const clock = options.clock ?? (() => new Date());
  assertPumpOptions(leaseDurationMs, maxDeliveries);

  const service = new OperatorDeliveryService(rootDir);
  const accepted: string[] = [];
  for (let attempt = 0; attempt < maxDeliveries; attempt += 1) {
    const target = readActiveOperatorTarget(rootDir, tmux);
    if (target === null) return accepted;

    const leaseId = `operator-delivery-${randomUUID()}`;
    const ownerId = ownerIdFor(target);
    const delivery = service.leaseNext(
      `operator-delivery-lease-${randomUUID()}`,
      { ownerId, leaseId, durationMs: leaseDurationMs },
      readTrustedTime(clock)
    );
    if (delivery === null) return accepted;

    const lease = {
      deliveryId: delivery.deliveryId,
      ownerId,
      leaseId,
      leaseGeneration: delivery.leaseGeneration
    };
    try {
      const current = readActiveOperatorTarget(rootDir, tmux);
      if (!sameTarget(target, current)) {
        releaseFencedLease(service, lease, clock);
        return accepted;
      }

      const request = loadOpenRequest(rootDir, delivery);
      if (request === null) {
        service.revokeUnacceptedForRequest(
          `operator-delivery-revoke-${randomUUID()}`,
          delivery.taskId,
          delivery.requestId,
          "request-terminal",
          readTrustedTime(clock)
        );
        continue;
      }

      // The target/window recheck can take non-trivial time. Read the trusted
      // clock only after it and refuse to begin a user-visible effect if this
      // owner no longer has an active lease.
      if (!isActiveLease(delivery, readTrustedTime(clock))) {
        return accepted;
      }

      tmux.sendRoleInputOnce(
        "operator",
        SYSTEM_OPERATOR_ROLE,
        receiptIdFor(delivery, target),
        renderOperatorDeliveryInput(delivery, request)
      );

      if (!sameTarget(target, readActiveOperatorTarget(rootDir, tmux))) {
        releaseFencedLease(service, lease, clock);
        return accepted;
      }

      // Never acknowledge or release an effect after its lease expired. A
      // recovered owner will observe the pane receipt and avoid duplicate
      // input while it performs the durable acceptance.
      if (!isActiveLease(delivery, readTrustedTime(clock))) {
        return accepted;
      }

      const acknowledged = service.acknowledgeActiveTargetTransportAcceptance(
        `operator-delivery-accept-${randomUUID()}`,
        { ...lease, expectedActiveTarget: target },
        readTrustedTime(clock)
      );
      if (acknowledged.status !== "accepted") {
        return accepted;
      }
      accepted.push(delivery.deliveryId);
    } catch (error) {
      releaseFencedLease(service, lease, clock);
      throw error;
    }
  }
  throw new Error("Operator delivery pump exceeded its safety limit.");
}

/**
 * This is intentionally an ordinary prompt sent through the live native
 * Operator pane, not a second Inbox or raw stored presentation copy.
 */
export function renderOperatorDeliveryInput(
  delivery: OperatorDelivery,
  request: InputRequest
): string {
  const choices = request.choices.length === 0
    ? "Choices: free-text response."
    : [
        "Choices:",
        ...request.choices.map((choice) =>
          `- ${choice.key}: ${choice.label}${choice.description === undefined ? "" : ` — ${choice.description}`}`
        )
      ].join("\n");
  const recommendation = request.resolutionPolicy.mode === "offline-recommended"
    ? `Offline recommendation: ${request.resolutionPolicy.recommendation.choiceKey} (${request.resolutionPolicy.recommendation.reason})`
    : "This request requires an explicit user response.";

  return [
    `[TaskMux input request delivery ${delivery.deliveryId}]`,
    `Task ${request.taskId}; request ${request.id}.`,
    "A Task Leader is blocked waiting for this user decision:",
    request.question,
    choices,
    recommendation,
    "Treat this as user-facing work. Do not claim that the delivery itself is a user response."
  ].join("\n");
}

function readActiveOperatorTarget(rootDir: string, tmux: TmuxManager): ActiveOperatorTarget | null {
  const store = new FileTaskStore(rootDir);
  const role = store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
  if (role === null) return null;
  const binding = role.agentBindings[role.activeAgentId];
  const sessionSet = store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
  const session = sessionSet?.sessions[role.activeAgentId];
  if (
    binding === undefined ||
    sessionSet === null ||
    sessionSet.activeAgentId !== role.activeAgentId ||
    session === undefined ||
    session.agentId !== role.activeAgentId ||
    session.adapterId !== binding.adapterId ||
    session.status !== "running"
  ) {
    return null;
  }
  try {
    if (tmux.probeRoleStatus("operator", SYSTEM_OPERATOR_ROLE) !== "running") {
      return null;
    }
  } catch {
    return null;
  }
  return {
    agentId: session.agentId,
    adapterId: session.adapterId,
    sessionRoot: session.sessionRoot,
    nativeSessionId: session.nativeSessionId
  };
}

function loadOpenRequest(rootDir: string, delivery: OperatorDelivery): InputRequest | null {
  const store = new FileTaskStore(rootDir);
  const task = store.getTask(delivery.taskId);
  if (task === null || task.archived) return null;
  const request = store.getInputRequest(delivery.taskId, delivery.requestId);
  return request?.status === "open" ? request : null;
}

function ownerIdFor(target: ActiveOperatorTarget): string {
  const identity = JSON.stringify([
    target.agentId,
    target.adapterId,
    target.sessionRoot,
    target.nativeSessionId
  ]);
  return `operator-${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
}

function receiptIdFor(delivery: OperatorDelivery, target: ActiveOperatorTarget): string {
  return createHash("sha256").update(JSON.stringify([
    delivery.deliveryId,
    target.agentId,
    target.adapterId,
    target.sessionRoot,
    target.nativeSessionId
  ])).digest("hex");
}

function sameTarget(
  expected: ActiveOperatorTarget,
  actual: ActiveOperatorTarget | null
): boolean {
  return actual !== null &&
    actual.agentId === expected.agentId &&
    actual.adapterId === expected.adapterId &&
    actual.sessionRoot === expected.sessionRoot &&
    actual.nativeSessionId === expected.nativeSessionId;
}

function releaseFencedLease(
  service: OperatorDeliveryService,
  lease: { deliveryId: string; ownerId: string; leaseId: string; leaseGeneration: number },
  clock: () => Date
): void {
  const now = readTrustedTime(clock);
  try {
    service.releaseLease(
      `operator-delivery-release-${randomUUID()}`,
      lease,
      now
    );
  } catch {
    // A concurrent request terminalization or new pump owner may already have
    // fenced the obsolete lease. The authoritative record decides the outcome.
  }
}

function isActiveLease(delivery: OperatorDelivery, now: Date): boolean {
  return delivery.status === "leased" &&
    Date.parse(delivery.leaseExpiresAt ?? "") > now.getTime();
}

function readTrustedTime(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Operator delivery pump trusted clock returned an invalid time.");
  }
  return new Date(value.getTime());
}

function assertPumpOptions(leaseDurationMs: number, maxDeliveries: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 24 * 60 * 60 * 1_000) {
    throw new Error("Operator delivery pump lease duration is invalid.");
  }
  if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1 || maxDeliveries > 10_000) {
    throw new Error("Operator delivery pump delivery limit is invalid.");
  }
}
