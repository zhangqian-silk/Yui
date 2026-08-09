import { createHash, randomUUID } from "node:crypto";
import {
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import {
  createRuntimeBinding,
  RuntimeLaunchError,
  type RuntimeBinding,
  type RuntimeLaunchPersistence as RuntimeLaunchPersistencePort,
  type RuntimeLaunchPreparationPort,
  type RuntimeLaunchPreparationRequest,
  type SessionHostPort
} from "../runtime/index.js";
import { validateEffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type {
  TaskRuntimeIsolationPort,
  TaskRuntimeIsolationPreparation
} from "../runtime/taskRuntimeIsolation.js";

export type CoordinatedRuntimeLaunchRequest = RuntimeLaunchPreparationRequest;

export type RuntimeLaunchReservationPort = Readonly<{
  reserveRuntimeLaunch(
    input: Readonly<{ owner: RuntimeRoleOwner; launchId: string; runId?: string }>,
    assertCurrent: () => void,
    now?: Date
  ): Readonly<{
    status: "reserved" | "existing";
    launchId: string;
    runId?: string;
  }>;
  confirmRuntimeLaunchReservation(
    input: Readonly<{ owner: RuntimeRoleOwner; launchId: string }>,
    assertCurrent: () => void
  ): void;
  recordReservedRuntimeNativeSession(input: Readonly<{
    owner: RuntimeRoleOwner;
    launchId: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot;
  }>, assertCurrent: () => void, now?: Date): void;
  completeRuntimeLaunchReservation(
    owner: RuntimeRoleOwner,
    launchId: string,
    expectedTerminalRunId?: string
  ): boolean;
  settleStoppedRuntimeLaunch(input: Readonly<{
    owner: RuntimeRoleOwner;
    launchId: string;
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
  runtimeIsolation?: TaskRuntimeIsolationPort;
}>;

export type RuntimeLaunchPersistence = RuntimeLaunchPersistencePort;

class RuntimeBindingContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeBindingContractError";
  }
}

/**
 * One application service owns the reservation -> host -> persistence
 * protocol for both foreground enter and scheduler-driven Role launches.
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
  readonly #runtimeIsolation: TaskRuntimeIsolationPort | undefined;

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
    assertCurrent?: () => void
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
      return await this.#prepareUnlocked(request, persistence, assertCurrent);
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
    assertCurrent?: () => void
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
    const proposedLaunchId = `${generationPrefix}${proposedGenerationId}`;
    let runtimeIsolation = this.#preflightRuntimeIsolation(
      request,
      proposedLaunchId,
      proposedGenerationId,
      false
    );
    let reservation = this.reservations.reserveRuntimeLaunch({
      owner: request.owner,
      launchId: proposedLaunchId,
      ...(request.runId === undefined ? {} : { runId: request.runId })
    }, assertLaunchCurrent, this.#now());
    let reusedConfirmedRunningHost = false;
    let launchPromptAcknowledgementRequired = false;

    if (reservation.status === "existing") {
      if (!reservation.launchId.startsWith(generationPrefix)) {
        this.#requireCleanup(request.owner);
        throw new Error(
          `Runtime launch reservation belongs to stale Role or Agent state: ${
            request.owner.roleName
          }.`
        );
      }
      const sameRunReservation = request.runId !== undefined
        && reservation.runId === request.runId;
      const differentRunReservation = request.runId !== undefined
        && reservation.runId !== undefined
        && reservation.runId !== request.runId;
      const inspection = await this.host.inspectOwner(request.owner);
      if (inspection.state === "unavailable" || inspection.state === "starting") {
        if (sameRunReservation) {
          throw new RuntimeLaunchError(
            true,
            reservation.launchId,
            `Runtime is temporarily ${inspection.state}: ${request.runId}/${reservation.launchId}.`
          );
        }
        throw new Error(
          `Runtime launch reservation cannot yet be verified: ${
            request.owner.roleName
          }.`
        );
      }
      if (inspection.state === "stopped") {
        if (sameRunReservation) {
          throw new RuntimeLaunchError(
            false,
            reservation.launchId,
            `Exact Run launch generation stopped before delivery: ${request.runId}/${reservation.launchId}.`
          );
        }
        if (!this.reservations.completeRuntimeLaunchReservation(
          request.owner,
          reservation.launchId,
          differentRunReservation ? reservation.runId : undefined
        )) {
          throw new Error("Runtime launch reservation changed during recovery.");
        }
        reservation = this.reservations.reserveRuntimeLaunch({
          owner: request.owner,
          launchId: proposedLaunchId,
          ...(request.runId === undefined ? {} : { runId: request.runId })
        }, assertLaunchCurrent, this.#now());
        if (reservation.status !== "reserved") {
          throw new Error("Runtime launch reservation could not be renewed.");
        }
      } else {
        if (differentRunReservation) {
          throw new Error(
            `Runtime launch reservation belongs to another Run whose host is still running: ${
              reservation.runId
            }.`
          );
        }
        reusedConfirmedRunningHost = true;
        launchPromptAcknowledgementRequired = sameRunReservation
          && request.adapterId === "codex";
        runtimeIsolation = this.#preflightRuntimeIsolation(
          request,
          reservation.launchId,
          reservation.launchId.slice(generationPrefix.length),
          true
        );
        assertLaunchCurrent();
      }
    }

    const launchId = reservation.launchId;
    let binding: RuntimeBinding;
    let runtimeIsolationActivated = false;
    try {
      if (!reusedConfirmedRunningHost && runtimeIsolation !== undefined) {
        // Activation is the first runtime-resource side effect and can occur
        // only after the centralized read-only preflight and durable launch
        // reservation have both succeeded.
        runtimeIsolationActivated = true;
        this.#runtimeIsolation!.activate(runtimeIsolation);
      }
      const rawBinding = request.mode === "new"
        ? await this.host.start({
            mode: "new",
            launchId,
            owner: request.owner,
            agentId: request.agentId,
            adapterId: request.adapterId,
            effective: request.effective,
            workspace: request.workspace,
            ...(runtimeIsolation === undefined
              ? {}
              : { runtimeIsolation: runtimeIsolation.descriptor }),
            ...(request.runId === undefined ? {} : { runId: request.runId }),
            ...(request.environment === undefined
              ? {}
              : { environment: request.environment })
          })
        : await this.host.resume({
            mode: "resume",
            launchId,
            owner: request.owner,
            agentId: request.agentId,
            adapterId: request.adapterId,
            effective: request.effective,
            workspace: request.workspace,
            ...(runtimeIsolation === undefined
              ? {}
              : { runtimeIsolation: runtimeIsolation.descriptor }),
            ...(request.runId === undefined ? {} : { runId: request.runId }),
            ...(request.environment === undefined
              ? {}
              : { environment: request.environment }),
            nativeSessionId: requireText(
              request.nativeSessionId,
              "Native session id"
            )
          });
      binding = requireMatchingRuntimeBinding(
        rawBinding,
        request,
        launchId,
        launchPromptAcknowledgementRequired
      );
    } catch (error) {
      if (error instanceof RuntimeBindingContractError) {
        // Never pass an untrusted hostRef to stop(). Reconcile the requested
        // owner through the durable, owner-addressed cleanup lane instead.
        this.#requireCleanup(request.owner);
        throw error;
      }
      await this.#settleFailedStart(
        request,
        launchId,
        reusedConfirmedRunningHost,
        runtimeIsolation,
        runtimeIsolationActivated
      );
      throw error;
    }

    if (reusedConfirmedRunningHost && binding.hostCreated === true) {
      if (request.runId !== undefined && reservation.runId === request.runId) {
        throw new RuntimeLaunchError(
          false,
          launchId,
          `Exact Run launch generation was unexpectedly recreated: ${request.runId}/${launchId}.`
        );
      }
      await this.#compensateStartedHost(
        request.owner,
        binding,
        launchId,
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
      if (persistence === "immediate" && binding.nativeSessionId !== undefined) {
        this.reservations.recordReservedRuntimeNativeSession({
          owner: request.owner,
          launchId,
          agentId: request.agentId,
          adapterId: request.adapterId,
          nativeSessionId: binding.nativeSessionId,
          effective: request.effective
        }, assertLaunchCurrent, this.#now());
      } else {
        // Deferred scheduler persistence records a known native identity while
        // retaining the reservation until exact Run delivery. Fresh Codex has
        // no identity yet and keeps it until its matching generation Hook.
        this.reservations.confirmRuntimeLaunchReservation({
          owner: request.owner,
          launchId
        }, assertLaunchCurrent);
      }
    } catch (error) {
      await this.#compensateStartedHost(
        request.owner,
        binding,
        launchId,
        runtimeIsolation,
        error
      );
    }
    return binding;
  }

  async #settleFailedStart(
    request: CoordinatedRuntimeLaunchRequest,
    launchId: string,
    reusedConfirmedRunningHost: boolean,
    runtimeIsolation: TaskRuntimeIsolationPreparation | undefined,
    runtimeIsolationActivated: boolean
  ): Promise<void> {
    let inspection;
    try {
      inspection = await this.host.inspectOwner(request.owner);
    } catch {
      // A rebind/preflight failure did not create the already-confirmed host.
      // Preserve its generation when the follow-up probe is merely unknown.
      if (!reusedConfirmedRunningHost) this.#requireCleanup(request.owner);
      return;
    }
    if (inspection.state === "stopped") {
      if (runtimeIsolationActivated && runtimeIsolation !== undefined) {
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
      if (!this.#settleConfirmedStopped(request, launchId)) {
        this.#requireCleanup(request.owner);
      }
      return;
    }
    if (reusedConfirmedRunningHost) return;
    this.#requireCleanup(request.owner);
  }

  async #compensateStartedHost(
    owner: RuntimeRoleOwner,
    binding: RuntimeBinding,
    launchId: string,
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
        launchId,
        agentId: binding.agentId,
        adapterId: binding.adapterId,
        ...(binding.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: binding.nativeSessionId })
      }, this.#now())
    ) {
      this.#requireCleanup(owner);
    }
    throw cause;
  }

  #preflightRuntimeIsolation(
    request: CoordinatedRuntimeLaunchRequest,
    launchId: string,
    generationId: string,
    allowExactActive: boolean
  ): TaskRuntimeIsolationPreparation | undefined {
    if (this.#runtimeIsolation === undefined || request.owner.scope !== "task") {
      return undefined;
    }
    return this.#runtimeIsolation.preflight({
      workspace: request.managedWorkspace!,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      launchId,
      generationId: requireText(generationId, "Launch generation id"),
      ...(request.runtimePolicy === undefined ? {} : { policy: request.runtimePolicy }),
      ...(allowExactActive ? { allowExactActive: true } : {})
    });
  }

  #settleConfirmedStopped(
    request: CoordinatedRuntimeLaunchRequest,
    launchId: string
  ): boolean {
    return this.reservations.settleStoppedRuntimeLaunch({
      owner: request.owner,
      launchId,
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

function requireMatchingRuntimeBinding(
  raw: RuntimeBinding,
  request: CoordinatedRuntimeLaunchRequest,
  launchId: string,
  launchPromptAcknowledgementRequired: boolean
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
  const launchCarriedPromptAcknowledgementRequired = request.owner.scope === "task"
    && request.adapterId === "codex"
    && request.runId !== undefined
    // An explicit reused-host result may take the receipt-backed active-push
    // path. A new or ambiguous host may have carried the prompt in argv, but
    // Yui has no provider acknowledgement for that transport.
    && binding.hostCreated !== false;
  if (
    launchPromptAcknowledgementRequired
    || launchCarriedPromptAcknowledgementRequired
  ) {
    throw new RuntimeBindingContractError(
      `Session host cannot acknowledge the exact launch-carried prompt: ${
        request.owner.roleName
      }.`
    );
  }
  if (
    binding.launchId !== launchId
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
