/**
 * The foreground Operator deliberately depends on this narrow authority port
 * instead of a second runtime/session store. Production launch state remains
 * in GlobalRoleSessionSet("operator"); the in-memory implementation below is
 * a test fixture for transport fencing only.
 */
export type OperatorRoleBinding = {
  roleName: "operator";
  generation: string;
  agentId: string;
  adapterId: string;
  workspace: string;
  session: OperatorBoundSession | null;
};

export type OperatorBoundSession = {
  reservationId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  status: "reserved" | "running" | "stopped" | "failed";
  reservedAt: string;
  runningAt?: string;
  terminalAt?: string;
};

export type OperatorSessionReservation = {
  roleName: "operator";
  generation: string;
  reservationId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  reservedAt: string;
};

export interface OperatorRoleBindingAuthority {
  read(): OperatorRoleBinding | null;
  reserve(): OperatorSessionReservation;
  markRunning(reservation: OperatorSessionReservation, now: Date): void;
  markTerminal(
    reservation: OperatorSessionReservation,
    status: "stopped" | "failed",
    now: Date
  ): void;
}

export class OperatorRoleBindingFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorRoleBindingFenceError";
  }
}

type InMemoryAuthorityOptions = {
  nextReservationId?: () => string;
  nextNativeSessionId?: () => string;
  now?: () => Date;
};

type OperatorRoleBindingFixture = Omit<OperatorRoleBinding, "session"> & {
  session?: OperatorBoundSession | null;
};

/**
 * Test-only fixture. It intentionally has no filesystem persistence and must
 * never be substituted for GlobalRoleSessionSet authority.
 */
export class InMemoryOperatorRoleBindingAuthority implements OperatorRoleBindingAuthority {
  private binding: OperatorRoleBinding | null;
  private readonly nextReservationId: () => string;
  private readonly nextNativeSessionId: () => string;
  private readonly now: () => Date;

  constructor(binding: OperatorRoleBindingFixture | null, options: InMemoryAuthorityOptions = {}) {
    this.binding = binding === null
      ? null
      : normalizeBinding({ ...binding, session: binding.session ?? null });
    this.nextReservationId = options.nextReservationId ?? (() => crypto.randomUUID());
    this.nextNativeSessionId = options.nextNativeSessionId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  read(): OperatorRoleBinding | null {
    return this.binding === null ? null : structuredClone(this.binding);
  }

  reserve(): OperatorSessionReservation {
    const binding = this.requireBinding();
    if (binding.session !== null && ["reserved", "running"].includes(binding.session.status)) {
      throw new OperatorRoleBindingFenceError("Operator binding already owns a live native session.");
    }
    const reservationId = requireToken(this.nextReservationId(), "reservation id");
    const nativeSessionId = requireToken(this.nextNativeSessionId(), "native session id");
    const reservedAt = isoTimestamp(this.now());
    const reservation: OperatorSessionReservation = {
      roleName: "operator",
      generation: binding.generation,
      reservationId,
      agentId: binding.agentId,
      adapterId: binding.adapterId,
      nativeSessionId,
      reservedAt
    };
    this.binding = {
      ...binding,
      session: {
        reservationId,
        agentId: binding.agentId,
        adapterId: binding.adapterId,
        nativeSessionId,
        status: "reserved",
        reservedAt
      }
    };
    return structuredClone(reservation);
  }

  markRunning(reservation: OperatorSessionReservation, now: Date): void {
    const current = this.requireExactReservation(reservation, "reserved");
    this.binding = {
      ...current.binding,
      session: {
        ...current.session,
        status: "running",
        runningAt: isoTimestamp(now)
      }
    };
  }

  markTerminal(
    reservation: OperatorSessionReservation,
    status: "stopped" | "failed",
    now: Date
  ): void {
    const current = this.requireExactReservation(reservation, "reserved", "running");
    this.binding = {
      ...current.binding,
      session: {
        ...current.session,
        status,
        terminalAt: isoTimestamp(now)
      }
    };
  }

  /**
   * Fixture control for restart/fence tests. Production changes come from the
   * structured Role authority, not from the foreground supervisor.
   */
  replaceBinding(binding: OperatorRoleBindingFixture | null): void {
    this.binding = binding === null
      ? null
      : normalizeBinding({ ...binding, session: binding.session ?? null });
  }

  private requireBinding(): OperatorRoleBinding {
    if (this.binding === null) {
      throw new OperatorRoleBindingFenceError("Operator role binding is unavailable.");
    }
    return this.binding;
  }

  private requireExactReservation(
    reservation: OperatorSessionReservation,
    ...allowedStatuses: OperatorBoundSession["status"][]
  ): { binding: OperatorRoleBinding; session: OperatorBoundSession } {
    const binding = this.requireBinding();
    const session = binding.session;
    if (
      reservation.roleName !== "operator" ||
      reservation.generation !== binding.generation ||
      reservation.agentId !== binding.agentId ||
      reservation.adapterId !== binding.adapterId ||
      session === null ||
      !allowedStatuses.includes(session.status) ||
      session.reservationId !== reservation.reservationId ||
      session.nativeSessionId !== reservation.nativeSessionId ||
      session.agentId !== reservation.agentId ||
      session.adapterId !== reservation.adapterId
    ) {
      throw new OperatorRoleBindingFenceError(
        "Foreground Operator reservation is fenced by the current role binding."
      );
    }
    return { binding, session };
  }
}

function normalizeBinding(value: OperatorRoleBinding): OperatorRoleBinding {
  if (
    value.roleName !== "operator" ||
    !isToken(value.generation) ||
    !isToken(value.agentId) ||
    !isToken(value.adapterId) ||
    typeof value.workspace !== "string" ||
    value.workspace.trim().length === 0
  ) {
    throw new Error("Invalid Operator role binding fixture.");
  }
  if (value.session !== null) {
    validateSession(value.session, value);
  }
  return structuredClone(value);
}

function validateSession(session: OperatorBoundSession, binding: OperatorRoleBinding): void {
  if (
    !isToken(session.reservationId) ||
    !isToken(session.agentId) ||
    !isToken(session.adapterId) ||
    !isToken(session.nativeSessionId) ||
    session.agentId !== binding.agentId ||
    session.adapterId !== binding.adapterId ||
    !isIsoTimestamp(session.reservedAt) ||
    !["reserved", "running", "stopped", "failed"].includes(session.status) ||
    (session.runningAt !== undefined && !isIsoTimestamp(session.runningAt)) ||
    (session.terminalAt !== undefined && !isIsoTimestamp(session.terminalAt))
  ) {
    throw new Error("Invalid Operator bound session fixture.");
  }
}

function requireToken(value: unknown, label: string): string {
  if (!isToken(value)) {
    throw new Error(`Invalid Operator ${label}.`);
  }
  return value;
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isoTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid Operator lifecycle timestamp.");
  }
  return value.toISOString();
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
