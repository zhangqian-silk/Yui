import { executeDomainTransaction } from "../storage/domainTransaction.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import {
  OperatorDeliveryLeaseError,
  acknowledgeOperatorTransportAcceptance,
  leaseOperatorDelivery,
  operatorDeliveryKey,
  requeueExpiredOperatorDelivery,
  releaseOperatorDelivery,
  revokeOperatorDelivery,
  type OperatorDelivery,
  type OperatorDeliveryRevocation
} from "./operatorDelivery.js";

export type LeaseNextOperatorDelivery = {
  ownerId: string;
  leaseId: string;
  durationMs: number;
};

export type OperatorDeliveryAcceptance = {
  deliveryId: string;
  ownerId: string;
  leaseId: string;
  leaseGeneration: number;
};

export type OperatorDeliveryActiveTarget = {
  agentId: string;
  adapterId: string;
  sessionRoot: string;
  nativeSessionId: string;
};

export type ActiveTargetOperatorDeliveryAcceptance = OperatorDeliveryAcceptance & {
  expectedActiveTarget: OperatorDeliveryActiveTarget;
};

/**
 * The only durable data this service mutates is the pointer-only delivery
 * outbox. Every mutation uses the same #34 domain transaction as task input
 * records; it never creates an Operator session or presentation authority.
 */
export class OperatorDeliveryService {
  constructor(private readonly rootDir: string) {}

  leaseNext(
    transactionId: string,
    lease: LeaseNextOperatorDelivery,
    now: Date
  ): OperatorDelivery | null {
    assertLeaseDuration(lease.durationMs);
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const candidate = store.listOperatorDeliveries()
        .find((delivery) => isLeaseCandidate(delivery, now));
      if (candidate === undefined) {
        return null;
      }
      const pending = candidate.status === "leased"
        ? requeueExpiredOperatorDelivery(candidate, now)
        : candidate;
      const leased = leaseOperatorDelivery(pending, {
        ownerId: lease.ownerId,
        leaseId: lease.leaseId,
        expiresAt: new Date(now.getTime() + lease.durationMs).toISOString()
      }, now);
      store.saveOperatorDelivery(leased);
      return leased;
    });
  }

  acknowledgeTransportAcceptance(
    transactionId: string,
    acceptance: OperatorDeliveryAcceptance,
    now: Date
  ): OperatorDelivery {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const delivery = store.getOperatorDelivery(acceptance.deliveryId);
      if (delivery === null) {
        throw new OperatorDeliveryLeaseError(
          `Operator delivery not found: ${acceptance.deliveryId}.`
        );
      }
      const accepted = acknowledgeOperatorTransportAcceptance(delivery, acceptance, now);
      store.saveOperatorDelivery(accepted);
      return accepted;
    });
  }

  /**
   * Atomically accepts a tmux delivery only if the durable active Operator
   * tuple still identifies the pane that received its receipt. A mismatch
   * releases the same fenced lease for the replacement Operator instead of
   * recording an acceptance for the old target.
   */
  acknowledgeActiveTargetTransportAcceptance(
    transactionId: string,
    acceptance: ActiveTargetOperatorDeliveryAcceptance,
    now: Date
  ): OperatorDelivery {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const delivery = store.getOperatorDelivery(acceptance.deliveryId);
      if (delivery === null) {
        throw new OperatorDeliveryLeaseError(
          `Operator delivery not found: ${acceptance.deliveryId}.`
        );
      }
      if (!matchesActiveOperatorTarget(store, acceptance.expectedActiveTarget)) {
        const released = releaseOperatorDelivery(delivery, acceptance, now);
        store.saveOperatorDelivery(released);
        return released;
      }
      const accepted = acknowledgeOperatorTransportAcceptance(delivery, acceptance, now);
      store.saveOperatorDelivery(accepted);
      return accepted;
    });
  }

  releaseLease(
    transactionId: string,
    acceptance: OperatorDeliveryAcceptance,
    now: Date
  ): OperatorDelivery {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const delivery = store.getOperatorDelivery(acceptance.deliveryId);
      if (
        delivery === null ||
        delivery.status !== "leased" ||
        delivery.leaseOwnerId !== acceptance.ownerId ||
        delivery.leaseId !== acceptance.leaseId ||
        delivery.leaseGeneration !== acceptance.leaseGeneration
      ) {
        throw new OperatorDeliveryLeaseError(
          `Operator delivery ${acceptance.deliveryId} lease is fenced.`
        );
      }
      const released = releaseOperatorDelivery(delivery, acceptance, now);
      store.saveOperatorDelivery(released);
      return released;
    });
  }

  revokeUnacceptedForRequest(
    transactionId: string,
    taskId: string,
    requestId: string,
    reason: OperatorDeliveryRevocation,
    now: Date
  ): OperatorDelivery[] {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const key = operatorDeliveryKey({ taskId, requestId });
      const revoked: OperatorDelivery[] = [];
      for (const delivery of store.listOperatorDeliveries()) {
        if (
          operatorDeliveryKey(delivery) === key &&
          (delivery.status === "pending" || delivery.status === "leased")
        ) {
          const result = revokeOperatorDelivery(delivery, reason, now);
          store.saveOperatorDelivery(result);
          revoked.push(result);
        }
      }
      return revoked;
    });
  }
}

function isLeaseCandidate(delivery: OperatorDelivery, now: Date): boolean {
  return delivery.status === "pending" ||
    (
      delivery.status === "leased" &&
      Date.parse(delivery.leaseExpiresAt ?? "") <= now.getTime()
    );
}

function assertLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("Operator delivery lease duration must be a positive safe integer up to one day.");
  }
}

function matchesActiveOperatorTarget(
  store: Pick<TaskStore, "getGlobalRole" | "getGlobalRoleSessionSet">,
  expected: OperatorDeliveryActiveTarget
): boolean {
  const role = store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
  if (role === null || role.activeAgentId !== expected.agentId) {
    return false;
  }
  const binding = role.agentBindings[role.activeAgentId];
  const sessionSet = store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
  const session = sessionSet?.sessions[role.activeAgentId];
  return binding !== undefined &&
    binding.agentId === expected.agentId &&
    binding.adapterId === expected.adapterId &&
    sessionSet !== null &&
    sessionSet.activeAgentId === expected.agentId &&
    session !== undefined &&
    session.agentId === expected.agentId &&
    session.adapterId === expected.adapterId &&
    session.sessionRoot === expected.sessionRoot &&
    session.nativeSessionId === expected.nativeSessionId &&
    session.status === "running";
}
