import { createHash, randomUUID } from "node:crypto";
import {
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import {
  createRuntimeBinding,
  RuntimeGenerationMismatchError,
  RuntimeHostContentionError,
  RuntimeLaunchError,
  type RuntimeBinding,
  type RuntimeLaunchPersistence as RuntimeLaunchPersistencePort,
  type RuntimeLaunchPreflight,
  type RuntimeLaunchPreStart,
  type RuntimeLaunchPreparationPort,
  type RuntimeLaunchPreparationRequest,
  type SessionHostPort
} from "../runtime/index.js";
import {
  effectiveLaunchSnapshotsCompatible,
  validateEffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import type {
  TaskRuntimeIsolationPort,
  TaskRuntimeIsolationPreparation,
  TaskRuntimeLifecycleCleanupPort
} from "../runtime/taskRuntimeIsolation.js";

export type CoordinatedRuntimeLaunchRequest = RuntimeLaunchPreparationRequest;

export type RuntimeLaunchReservationPort = Readonly<{
  reserveRuntimeLaunch(
    input: Readonly<{ owner: RuntimeRoleOwner; runtimeGenerationId: string }>,
    assertCurrent: () => void,
    now?: Date
  ): Readonly<{
    status: "reserved" | "existing";
    runtimeGenerationId: string;
  }>;
  confirmRuntimeLaunchReservation(
    input: Readonly<{ owner: RuntimeRoleOwner; runtimeGenerationId: string }>,
    assertCurrent: () => void
  ): "reserved" | "provider-bound";
  recordReservedRuntimeNativeSession(input: Readonly<{
    owner: RuntimeRoleOwner;
    runtimeGenerationId: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot;
  }>, assertCurrent: () => void, now?: Date): void;
  completeRuntimeLaunchReservation(
    owner: RuntimeRoleOwner,
    runtimeGenerationId: string,
    /** Runs after the exact reservation/terminal fence passes, before it clears. */
    beforeComplete?: () => void
  ): boolean;
  settleStoppedRuntimeLaunch(input: Readonly<{
    owner: RuntimeRoleOwner;
    runtimeGenerationId: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>, now?: Date): boolean;
  enqueueRuntimeCleanup(
    owner: RuntimeRoleOwner,
    now?: Date
  ): RuntimeLifecycleTarget | null;
}>;

export type RuntimeLaunchCoordinatorOptions = Readonly<{
  createGenerationId?: () => string;
  now?: () => Date;
  assertCurrent?: (request: CoordinatedRuntimeLaunchRequest) => void;
  launchFingerprint?: (request: CoordinatedRuntimeLaunchRequest) => string;
  onCleanupRequired?: (target: RuntimeLifecycleTarget) => void;
  runtimeIsolation?: TaskRuntimeIsolationPort & Partial<TaskRuntimeLifecycleCleanupPort>;
}>;

export type RuntimeLaunchPersistence = RuntimeLaunchPersistencePort;

class RuntimeBindingContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeBindingContractError";
  }
}

class RuntimeLaunchStateChangedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeLaunchStateChangedError";
  }
}

/**
 * One application service owns the reservation -> host -> persistence
 * protocol for Controller/scheduler-driven Role launches. Foreground Task
 * attach is deliberately outside this lifecycle boundary.
 */
export class RuntimeLaunchCoordinator implements RuntimeLaunchPreparationPort {
  readonly #createGenerationId: () => string;
  readonly #now: () => Date;
  readonly #assertCurrent:
    | ((request: CoordinatedRuntimeLaunchRequest) => void)
    | undefined;
  readonly #launchFingerprint:
    (request: CoordinatedRuntimeLaunchRequest) => string;
  readonly #onCleanupRequired:
    | ((target: RuntimeLifecycleTarget) => void)
    | undefined;
  readonly #runtimeIsolation:
    | (TaskRuntimeIsolationPort & Partial<TaskRuntimeLifecycleCleanupPort>)
    | undefined;

  constructor(
    private readonly reservations: RuntimeLaunchReservationPort,
    private readonly host: SessionHostPort,
    options: RuntimeLaunchCoordinatorOptions = {}
  ) {
    this.#createGenerationId = options.createGenerationId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#assertCurrent = options.assertCurrent;
    this.#launchFingerprint = options.launchFingerprint
      ?? defaultLaunchFingerprint;
    this.#onCleanupRequired = options.onCleanupRequired;
    this.#runtimeIsolation = options.runtimeIsolation;
  }

  async prepare(
    request: CoordinatedRuntimeLaunchRequest,
    persistence: RuntimeLaunchPersistence,
    assertCurrent?: () => void,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    const ownerKey = request.owner.scope === "task"
      ? `task\0${request.owner.taskId}\0${request.owner.roleName}`
      : `global\0${request.owner.roleName}`;
    const previous = this.#launchTails.get(ownerKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.#launchTails.set(ownerKey, tail);
    await previous;
    try {
      return await this.#prepareUnlocked(
        request,
        persistence,
        assertCurrent,
        beforeHostStart
      );
    } finally {
      release();
      if (this.#launchTails.get(ownerKey) === tail) {
        this.#launchTails.delete(ownerKey);
      }
    }
  }

  readonly #launchTails = new Map<string, Promise<void>>();

  async #prepareUnlocked(
    request: CoordinatedRuntimeLaunchRequest,
    persistence: RuntimeLaunchPersistence,
    assertCurrent?: () => void,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    const effective = validateEffectiveLaunchSnapshot(request.effective);
    if (
      effective.agentId !== request.agentId
      || effective.adapterId !== request.adapterId
      || effective.workspace.root !== request.workspace
    ) {
      throw new TypeError(
        "Runtime launch request does not match its effective snapshot."
      );
    }
    if (this.#runtimeIsolation !== undefined && request.owner.scope === "task") {
      if (request.managedWorkspace === undefined) {
        throw new Error(
          "An authoritative ManagedWorkspace owner is required for a Task runtime launch."
        );
      }
      if (
        request.managedWorkspace.owner.taskId !== request.owner.taskId
        || request.managedWorkspace.root !== request.workspace
      ) {
        throw new Error(
          "Task runtime launch does not match its authoritative ManagedWorkspace."
        );
      }
    }
    if (request.owner.scope === "global" && request.managedWorkspace !== undefined) {
      throw new Error("A global runtime cannot use a Task ManagedWorkspace.");
    }
    const expectedFingerprint = requireText(
      this.#launchFingerprint(request),
      "Launch fingerprint"
    );
    const assertLaunchCurrent = () => {
      this.#assertCurrent?.(request);
      assertCurrent?.();
      if (this.#launchFingerprint(request) !== expectedFingerprint) {
        throw new Error(
          `Role or Agent launch state changed: ${request.owner.roleName}.`
        );
      }
    };
    const generationPrefix = `runtime-${expectedFingerprint}:generation:`;
    const proposedGenerationId = requireText(
      this.#createGenerationId(),
      "Launch generation id"
    );
    let proposedRuntimeGenerationId = `${generationPrefix}${proposedGenerationId}`;
    let reusedConfirmedRunningHost = false;
    if (request.mode === "resume" && request.hostActivationId !== undefined) {
      if (!request.hostActivationId.startsWith(generationPrefix)) {
        throw new Error("Session restore targets an incompatible Host activation.");
      }
      const inspection = await this.host.inspectOwner(request.owner);
      if (inspection.state === "unavailable" || inspection.state === "starting") {
        throw new RuntimeLaunchError(
          true,
          request.hostActivationId,
          `Host activation is temporarily ${inspection.state}: ${request.owner.roleName}.`
        );
      }
      if (inspection.state === "running") {
        proposedRuntimeGenerationId = request.hostActivationId;
        reusedConfirmedRunningHost = true;
      }
    }
    let runtimeIsolation = reusedConfirmedRunningHost
      ? undefined
      : this.#preflightRuntimeIsolation(
          request,
          proposedRuntimeGenerationId,
          proposedGenerationId,
          false
        );
    let reservation = this.reservations.reserveRuntimeLaunch({
      owner: request.owner,
      runtimeGenerationId: proposedRuntimeGenerationId
    }, assertLaunchCurrent, this.#now());
    if (reservation.status === "existing") {
      if (!reservation.runtimeGenerationId.startsWith(generationPrefix)) {
        this.#requireCleanup(request.owner);
        throw new Error(
          `Runtime launch reservation belongs to stale Role or Agent state: ${
            request.owner.roleName
          }.`
        );
      }
      const inspection = await this.host.inspectOwner(request.owner);
      if (inspection.state === "unavailable" || inspection.state === "starting") {
        throw new RuntimeLaunchError(
          true,
          reservation.runtimeGenerationId,
          `Runtime is temporarily ${inspection.state}: ${request.owner.roleName}/${reservation.runtimeGenerationId}.`
        );
      }
      if (inspection.state === "stopped") {
        const taskOwner = request.owner.scope === "task"
          ? request.owner
          : undefined;
        let exactCleanupAttempted = false;
        let completed = false;
        try {
          completed = this.reservations.completeRuntimeLaunchReservation(
            request.owner,
            reservation.runtimeGenerationId,
            taskOwner !== undefined && this.#runtimeIsolation !== undefined
              ? () => {
                  exactCleanupAttempted = true;
                  this.#cleanupTaskLaunch(taskOwner, reservation.runtimeGenerationId);
                }
              : undefined
          );
        } catch (error) {
          if (exactCleanupAttempted) this.#requireCleanup(request.owner);
          throw error;
        }
        if (!completed) {
          if (exactCleanupAttempted) this.#requireCleanup(request.owner);
          throw new Error("Runtime launch reservation changed during recovery.");
        }
        reservation = this.reservations.reserveRuntimeLaunch({
          owner: request.owner,
          runtimeGenerationId: proposedRuntimeGenerationId
        }, assertLaunchCurrent, this.#now());
        if (reservation.status !== "reserved") {
          throw new Error("Runtime launch reservation could not be renewed.");
        }
      } else {
        reusedConfirmedRunningHost = true;
        runtimeIsolation = undefined;
        assertLaunchCurrent();
      }
    }

    const runtimeGenerationId = reservation.runtimeGenerationId;
    let preflightObserved = beforeHostStart === undefined;
    const observePreflight = (preflight: RuntimeLaunchPreflight): void => {
      if (preflightObserved) {
        throw new Error("Runtime host reported its pre-start launch fence more than once.");
      }
      validateRuntimeLaunchPreflight(preflight, request, runtimeGenerationId);
      preflightObserved = true;
      beforeHostStart?.(preflight);
    };
    let binding: RuntimeBinding;
    try {
      if (!reusedConfirmedRunningHost && runtimeIsolation !== undefined) {
        // Activation is the first runtime-resource side effect and can occur
        // only after the centralized read-only preflight and durable launch
        // reservation have both succeeded.
        this.#runtimeIsolation!.activate(runtimeIsolation);
      }
      const rawBinding = request.mode === "new"
        ? await this.host.start({
            mode: "new",
            runtimeGenerationId,
            owner: request.owner,
            agentId: request.agentId,
            adapterId: request.adapterId,
            effective: request.effective,
            workspace: request.workspace,
            ...(runtimeIsolation === undefined
              ? {}
              : { runtimeIsolation: runtimeIsolation.descriptor }),
            ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
            ...(request.environment === undefined
              ? {}
              : { environment: request.environment })
          }, beforeHostStart === undefined ? undefined : observePreflight)
        : await this.host.restore({
            mode: "resume",
            runtimeGenerationId,
            owner: request.owner,
            agentId: request.agentId,
            adapterId: request.adapterId,
            effective: request.effective,
            workspace: request.workspace,
            ...(runtimeIsolation === undefined
              ? {}
              : { runtimeIsolation: runtimeIsolation.descriptor }),
            ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
            ...(request.environment === undefined
              ? {}
              : { environment: request.environment }),
            nativeSessionId: requireText(
              request.nativeSessionId,
              "Native session id"
            )
          }, beforeHostStart === undefined ? undefined : observePreflight);
      binding = requireMatchingRuntimeBinding(
        rawBinding,
        request,
        runtimeGenerationId
      );
      if (!preflightObserved) {
        throw new Error("Runtime session host did not expose a pre-host-start launch fence.");
      }
    } catch (error) {
      if (error instanceof RuntimeGenerationMismatchError) {
        await this.#settleFailedStart(
          request,
          runtimeGenerationId,
          reusedConfirmedRunningHost,
          runtimeIsolation,
          true
        );
        throw new RuntimeLaunchError(
          false,
          runtimeGenerationId,
          error.message,
          "generation-mismatch"
        );
      }
      if (error instanceof RuntimeHostContentionError && reusedConfirmedRunningHost) {
        // The exact recovered generation remains authoritative. A late human
        // writer is transient backpressure and must not settle, clean, or
        // terminalize that reservation.
        throw new RuntimeLaunchError(
          true,
          runtimeGenerationId,
          error.message,
          error.reason
        );
      }
      if (
        error instanceof RuntimeHostContentionError
        && !reusedConfirmedRunningHost
      ) {
        let exactCleanupAttempted = false;
        let completed = false;
        try {
          completed = this.reservations.completeRuntimeLaunchReservation(
            request.owner,
            runtimeGenerationId,
            runtimeIsolation === undefined
              ? undefined
              : () => {
                  exactCleanupAttempted = true;
                  this.#runtimeIsolation!.cleanup(runtimeIsolation, "failure");
                }
          );
        } catch (cleanupError) {
          if (exactCleanupAttempted) this.#requireCleanup(request.owner);
          throw cleanupError;
        }
        if (!completed) {
          this.#requireCleanup(request.owner);
          throw new Error("Busy managed runtime launch reservation changed during retry release.");
        }
        throw new RuntimeLaunchError(
          true,
          runtimeGenerationId,
          error.message,
          error instanceof RuntimeHostContentionError
            ? error.reason
            : "previous-process"
        );
      }
      if (error instanceof RuntimeBindingContractError) {
        // Never pass an untrusted hostRef to stop(). Reconcile the requested
        // owner through the durable, owner-addressed cleanup lane instead.
        this.#requireCleanup(request.owner);
        throw error;
      }
      await this.#settleFailedStart(
        request,
        runtimeGenerationId,
        reusedConfirmedRunningHost,
        runtimeIsolation
      );
      throw error;
    }

    if (reusedConfirmedRunningHost && binding.hostCreated === true) {
      await this.#compensateStartedHost(
        request.owner,
        binding,
        runtimeGenerationId,
        runtimeIsolation,
        new Error(
          `Runtime host was recreated while recovering an existing generation: ${
            request.owner.roleName
          }.`
        )
      );
    }

    try {
      assertLaunchCurrent();
      const reservationState = this.reservations.confirmRuntimeLaunchReservation({
        owner: request.owner,
        runtimeGenerationId
      }, assertLaunchCurrent);
      if (reservationState === "reserved") {
        if (binding.nativeSessionId !== undefined) {
          this.reservations.recordReservedRuntimeNativeSession({
            owner: request.owner,
            runtimeGenerationId,
            agentId: request.agentId,
            adapterId: request.adapterId,
            nativeSessionId: binding.nativeSessionId,
            effective: request.effective
          }, assertLaunchCurrent, this.#now());
        } else if (!this.reservations.completeRuntimeLaunchReservation(
          request.owner,
          runtimeGenerationId
        )) {
          throw new Error("Runtime Host-start reservation changed before completion.");
        }
      }
    } catch (error) {
      await this.#compensateStartedHost(
        request.owner,
        binding,
        runtimeGenerationId,
        runtimeIsolation,
        error
      );
    }
    return binding;
  }

  async #settleFailedStart(
    request: CoordinatedRuntimeLaunchRequest,
    runtimeGenerationId: string,
    reusedConfirmedRunningHost: boolean,
    runtimeIsolation: TaskRuntimeIsolationPreparation | undefined,
    forceCleanup = false
  ): Promise<void> {
    let inspection;
    try {
      inspection = await this.host.inspectOwner(request.owner);
    } catch {
      // A rebind/preflight failure did not create the already-confirmed host.
      // Preserve its generation when the follow-up probe is merely unknown.
      if (!reusedConfirmedRunningHost || forceCleanup) this.#requireCleanup(request.owner);
      return;
    }
    if (inspection.state === "stopped") {
      if (runtimeIsolation !== undefined) {
        try {
          this.#runtimeIsolation!.cleanup(runtimeIsolation, "failure");
        } catch (cleanupError) {
          this.#requireCleanup(request.owner);
          throw new Error(
            `Task runtime launch failed and exact resource cleanup also failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
            { cause: cleanupError }
          );
        }
      }
      if (!this.#settleConfirmedStopped(request, runtimeGenerationId)) {
        this.#requireCleanup(request.owner);
      }
      return;
    }
    if (reusedConfirmedRunningHost && !forceCleanup) return;
    this.#requireCleanup(request.owner);
  }

  async #compensateStartedHost(
    owner: RuntimeRoleOwner,
    binding: RuntimeBinding,
    runtimeGenerationId: string,
    runtimeIsolation: TaskRuntimeIsolationPreparation | undefined,
    cause: unknown
  ): Promise<never> {
    try {
      await this.host.stop(binding);
    } catch (stopError) {
      this.#requireCleanup(owner);
      throw new Error(
        `Runtime launch state changed. Runtime cleanup also failed: ${
          stopError instanceof Error ? stopError.message : String(stopError)
        }`,
        { cause: stopError }
      );
    }
    let stopped = false;
    try {
      stopped = (await this.host.inspectOwner(owner)).state === "stopped";
    } catch {
      // Durable owner cleanup below is the only safe fallback.
    }
    if (stopped && runtimeIsolation !== undefined) {
      try {
        this.#runtimeIsolation!.cleanup(runtimeIsolation, "failure");
      } catch (cleanupError) {
        this.#requireCleanup(owner);
        throw new Error(
          `Runtime host stopped but exact Task resource cleanup failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
          { cause: cleanupError }
        );
      }
    }
    if (
      !stopped
      || !this.reservations.settleStoppedRuntimeLaunch({
        owner,
        runtimeGenerationId,
        agentId: binding.agentId,
        adapterId: binding.adapterId,
        ...(binding.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: binding.nativeSessionId })
      }, this.#now())
    ) {
      this.#requireCleanup(owner);
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RuntimeLaunchStateChangedError(
      `Runtime launch was compensated after state changed: ${detail}`,
      { cause }
    );
  }

  #preflightRuntimeIsolation(
    request: CoordinatedRuntimeLaunchRequest,
    runtimeGenerationId: string,
    generationId: string,
    allowExactActive: boolean
  ): TaskRuntimeIsolationPreparation | undefined {
    if (this.#runtimeIsolation === undefined || request.owner.scope !== "task") {
      return undefined;
    }
    return this.#runtimeIsolation.preflight({
      workspace: request.managedWorkspace!,
      runtimeGenerationId,
      generationId: requireText(generationId, "Launch generation id"),
      ...(request.runtimePolicy === undefined ? {} : { policy: request.runtimePolicy }),
      ...(allowExactActive ? { allowExactActive: true } : {})
    });
  }

  #cleanupTaskLaunch(
    owner: Extract<RuntimeRoleOwner, { scope: "task" }>,
    runtimeGenerationId: string
  ): void {
    const cleanupTaskLaunch = this.#runtimeIsolation?.cleanupTaskLaunch;
    if (cleanupTaskLaunch === undefined) {
      throw new Error("Exact Task runtime launch cleanup is unavailable.");
    }
    cleanupTaskLaunch.call(this.#runtimeIsolation, {
      taskId: owner.taskId,
      runtimeGenerationId,
      reason: "interruption"
    });
  }

  #settleConfirmedStopped(
    request: CoordinatedRuntimeLaunchRequest,
    runtimeGenerationId: string
  ): boolean {
    return this.reservations.settleStoppedRuntimeLaunch({
      owner: request.owner,
      runtimeGenerationId,
      agentId: request.agentId,
      adapterId: request.adapterId,
      ...(request.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: request.nativeSessionId })
    }, this.#now());
  }

  #requireCleanup(owner: RuntimeRoleOwner): void {
    const target = this.reservations.enqueueRuntimeCleanup(owner, this.#now())
      ?? runtimeLifecycleTarget(owner);
    try {
      this.#onCleanupRequired?.(target);
    } catch {
      // The durable cleanup lane is authoritative.
    }
  }
}

function validateRuntimeLaunchPreflight(
  preflight: RuntimeLaunchPreflight,
  request: CoordinatedRuntimeLaunchRequest,
  runtimeGenerationId: string
): void {
  const ownerMatches = preflight.owner.scope === request.owner.scope
    && preflight.owner.roleName === request.owner.roleName
    && (
      preflight.owner.scope === "global"
      || (
        request.owner.scope === "task"
        && preflight.owner.taskId === request.owner.taskId
      )
    );
  if (
    preflight.runtimeGenerationId !== runtimeGenerationId
    || !ownerMatches
    || preflight.turnId !== request.turnId
    || preflight.agentId !== request.agentId
    || preflight.adapterId !== request.adapterId
    || !effectiveLaunchSnapshotsCompatible(preflight.effective, request.effective)
    || (
      request.mode === "resume"
      && preflight.nativeSessionId !== request.nativeSessionId
    )
  ) {
    throw new Error(
      `Session host pre-start launch fence does not match the requested runtime: ${
        request.owner.roleName
      }.`
    );
  }
}

function requireMatchingRuntimeBinding(
  raw: RuntimeBinding,
  request: CoordinatedRuntimeLaunchRequest,
  runtimeGenerationId: string
): RuntimeBinding {
  let binding: RuntimeBinding;
  try {
    binding = createRuntimeBinding(raw);
  } catch (error) {
    throw new RuntimeBindingContractError(
      "Session host returned an invalid runtime binding.",
      { cause: error }
    );
  }
  const ownerMatches = binding.owner.scope === request.owner.scope
    && binding.owner.roleName === request.owner.roleName
    && (
      binding.owner.scope === "global"
      || (
        request.owner.scope === "task"
        && binding.owner.taskId === request.owner.taskId
      )
    );
  if (
    binding.runtimeGenerationId !== runtimeGenerationId
    || !ownerMatches
    || binding.agentId !== request.agentId
    || binding.adapterId !== request.adapterId
    || (
      request.mode === "resume"
      && binding.nativeSessionId !== request.nativeSessionId
    )
  ) {
    throw new RuntimeBindingContractError(
      `Session host returned a binding that does not match the requested runtime: ${
        request.owner.roleName
      }.`
    );
  }
  return binding;
}

function defaultLaunchFingerprint(
  request: CoordinatedRuntimeLaunchRequest
): string {
  return createHash("sha256").update(JSON.stringify([
    request.owner,
    request.agentId,
    request.adapterId,
    request.effective,
    request.workspace,
    request.managedWorkspace,
    request.runtimePolicy
  ])).digest("hex");
}

function requireText(value: string | undefined, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
