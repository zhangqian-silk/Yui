import { randomUUID } from "node:crypto";
import type { OperatorDelivery } from "./operatorDelivery.js";
import { OperatorDeliveryService } from "./operatorDeliveryService.js";
import type {
  OperatorRoleBinding,
  OperatorRoleBindingAuthority,
  OperatorSessionReservation
} from "./operatorRoleBindingAuthority.js";
import {
  createStructuredPtyDeliveryRequest,
  isStructuredPtyTransportAccepted,
  type StructuredPtyTransport
} from "./structuredPtyDelivery.js";

export type OperatorDeliveryControllerPort = {
  leaseNext(
    request: { ownerId: string; leaseId: string; durationMs: number },
    now: Date
  ): OperatorDelivery | null;
  acknowledgeTransportAcceptance(
    request: { deliveryId: string; ownerId: string; leaseId: string; leaseGeneration: number },
    now: Date
  ): OperatorDelivery;
  releaseLease(
    request: { deliveryId: string; ownerId: string; leaseId: string; leaseGeneration: number },
    now: Date
  ): OperatorDelivery;
};

export type LocalOperatorDeliveryControllerPortOptions = {
  nextTransactionId?: () => string;
};

/**
 * Local controller-side delivery adapter. A Controller RPC adapter can satisfy
 * the same port without changing supervisor transport semantics.
 */
export class LocalOperatorDeliveryControllerPort implements OperatorDeliveryControllerPort {
  private readonly service: OperatorDeliveryService;
  private readonly nextTransactionId: () => string;

  constructor(rootDir: string, options: LocalOperatorDeliveryControllerPortOptions = {}) {
    this.service = new OperatorDeliveryService(rootDir);
    this.nextTransactionId = options.nextTransactionId ?? randomUUID;
  }

  leaseNext(
    request: { ownerId: string; leaseId: string; durationMs: number },
    now: Date
  ): OperatorDelivery | null {
    return this.service.leaseNext(this.nextTransactionId(), request, now);
  }

  acknowledgeTransportAcceptance(
    request: { deliveryId: string; ownerId: string; leaseId: string; leaseGeneration: number },
    now: Date
  ): OperatorDelivery {
    return this.service.acknowledgeTransportAcceptance(this.nextTransactionId(), request, now);
  }

  releaseLease(
    request: { deliveryId: string; ownerId: string; leaseId: string; leaseGeneration: number },
    now: Date
  ): OperatorDelivery {
    return this.service.releaseLease(this.nextTransactionId(), request, now);
  }
}

export type OperatorSupervisorOptions = {
  supervisorId: string;
  authority: OperatorRoleBindingAuthority;
  controller: OperatorDeliveryControllerPort;
  transport: StructuredPtyTransport;
  nextLeaseId: () => string;
  leaseDurationMs: number;
};

export class OperatorSupervisorFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorSupervisorFenceError";
  }
}

export class OperatorStructuredPtyProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorStructuredPtyProtocolError";
  }
}

/**
 * Foreground Operator lifecycle coordinator. Durable session transitions live
 * exclusively behind OperatorRoleBindingAuthority; production session
 * authority is GlobalRoleSessionSet("operator"), while this coordinator keeps
 * only an in-memory transport fence.
 */
export class OperatorSupervisor {
  private binding: OperatorRoleBinding | null = null;
  private reservation: OperatorSessionReservation | null = null;

  constructor(private readonly options: OperatorSupervisorOptions) {
    assertToken(options.supervisorId, "supervisor id");
    if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs < 1) {
      throw new Error("Operator supervisor lease duration must be a positive safe integer.");
    }
  }

  start(now: Date): void {
    if (this.reservation !== null) {
      throw new OperatorSupervisorFenceError("Foreground Operator supervisor is already started.");
    }
    const before = this.options.authority.read();
    if (before === null) {
      throw new OperatorSupervisorFenceError("Operator role binding is unavailable.");
    }
    const reservation = this.options.authority.reserve();
    const reservedBinding = this.options.authority.read();
    if (
      reservedBinding === null ||
      !sameBinding(before, reservedBinding) ||
      reservedBinding.session?.reservationId !== reservation.reservationId ||
      reservedBinding.session?.status !== "reserved"
    ) {
      throw new OperatorSupervisorFenceError("Operator role binding changed during foreground reservation.");
    }
    try {
      this.options.transport.start({ binding: reservedBinding, reservation });
      this.options.authority.markRunning(reservation, now);
      this.binding = staticBinding(this.options.authority.read(), reservation);
      this.reservation = reservation;
    } catch (error) {
      try {
        this.options.authority.markTerminal(reservation, "failed", now);
      } catch {
        // The original startup error is authoritative; a later adapter retry
        // will observe and repair its fenced reservation.
      }
      throw error;
    }
  }

  deliverNext(now: Date): OperatorDelivery | null {
    const reservation = this.requireBoundReservation();
    const leaseId = this.options.nextLeaseId();
    assertToken(leaseId, "delivery lease id");
    const delivery = this.options.controller.leaseNext({
      ownerId: this.options.supervisorId,
      leaseId,
      durationMs: this.options.leaseDurationMs
    }, now);
    if (delivery === null) {
      return null;
    }

    const lease = {
      deliveryId: delivery.deliveryId,
      ownerId: this.options.supervisorId,
      leaseId,
      leaseGeneration: delivery.leaseGeneration
    };
    let acceptanceAttempted = false;
    try {
      const response = this.options.transport.request(createStructuredPtyDeliveryRequest(delivery));
      if (!isStructuredPtyTransportAccepted(response, delivery.deliveryId)) {
        throw new OperatorStructuredPtyProtocolError(
          `Structured PTY did not accept delivery ${delivery.deliveryId}.`
        );
      }
      acceptanceAttempted = true;
      return this.options.controller.acknowledgeTransportAcceptance(lease, now);
    } catch (error) {
      if (!acceptanceAttempted) {
        try {
          this.options.controller.releaseLease(lease, now);
        } catch {
          // A concurrent Controller recovery may have already fenced the lease.
        }
      }
      throw error;
    } finally {
      // Keep the compiler and future readers honest: delivery itself carries
      // no session authority, only the lease held by the current reservation.
      void reservation;
    }
  }

  stop(status: "stopped" | "failed", now: Date): void {
    const reservation = this.requireBoundReservation();
    let transportError: unknown;
    try {
      this.options.transport.stop?.();
    } catch (error) {
      transportError = error;
    }
    this.options.authority.markTerminal(reservation, status, now);
    this.binding = null;
    this.reservation = null;
    if (transportError !== undefined) {
      throw transportError;
    }
  }

  private requireBoundReservation(): OperatorSessionReservation {
    const reservation = this.reservation;
    const binding = this.binding;
    if (reservation === null || binding === null) {
      throw new OperatorSupervisorFenceError("Foreground Operator supervisor is not started.");
    }
    const current = this.options.authority.read();
    if (
      current === null ||
      !sameBinding(binding, current) ||
      current.session?.reservationId !== reservation.reservationId ||
      current.session.nativeSessionId !== reservation.nativeSessionId ||
      current.session.status !== "running"
    ) {
      throw new OperatorSupervisorFenceError("Foreground Operator supervisor is fenced by the current role binding.");
    }
    return reservation;
  }
}

function staticBinding(
  value: OperatorRoleBinding | null,
  reservation: OperatorSessionReservation
): OperatorRoleBinding {
  if (
    value === null ||
    value.generation !== reservation.generation ||
    value.agentId !== reservation.agentId ||
    value.adapterId !== reservation.adapterId ||
    value.session?.reservationId !== reservation.reservationId ||
    value.session.status !== "running"
  ) {
    throw new OperatorSupervisorFenceError("Operator role binding did not enter the running state.");
  }
  return value;
}

function sameBinding(left: OperatorRoleBinding, right: OperatorRoleBinding): boolean {
  return left.roleName === right.roleName &&
    left.generation === right.generation &&
    left.agentId === right.agentId &&
    left.adapterId === right.adapterId &&
    left.workspace === right.workspace;
}

function assertToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`Invalid Operator ${label}.`);
  }
}
