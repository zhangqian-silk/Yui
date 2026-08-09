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
    const proposedLaunchId = `${generationPrefix}${requireText(
      this.#createGenerationId(),
      "Launch generation id"
    )}`;
    let reservation = this.reservations.reserveRuntimeLaunch({
      owner: request.owner,
      launchId: proposedLaunchId,
      ...(request.runId === undefined ? {} : { runId: request.runId })
    }, assertLaunchCurrent, this.#now());
    let reusedConfirmedRunningHost = false;
    let requireInitialPromptReceipt = false;

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
        requireInitialPromptReceipt = sameRunReservation
          && request.adapterId === "codex";
        assertLaunchCurrent();
      }
    }

    const launchId = reservation.launchId;
    let binding: RuntimeBinding;
    try {
      const rawBinding = request.mode === "new"
        ? await this.host.start({
            mode: "new",
            launchId,
            owner: request.owner,
            agentId: request.agentId,
            adapterId: request.adapterId,
            effective: request.effective,
            workspace: request.workspace,
            ...(request.runId === undefined ? {} : { runId: request.runId }),
            ...(requireInitialPromptReceipt
              ? { initialPromptReceiptRequired: true }
              : {}),
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
            ...(request.runId === undefined ? {} : { runId: request.runId }),
            ...(requireInitialPromptReceipt
              ? { initialPromptReceiptRequired: true }
              : {}),
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
        requireInitialPromptReceipt
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
        reusedConfirmedRunningHost
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
      await this.#compensateStartedHost(request.owner, binding, launchId, error);
    }
    return binding;
  }

  async #settleFailedStart(
    request: CoordinatedRuntimeLaunchRequest,
    launchId: string,
    reusedConfirmedRunningHost: boolean
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
  initialPromptReceiptRequired: boolean
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
  const launchCarriedPromptReceiptRequired = request.owner.scope === "task"
    && request.adapterId === "codex"
    && request.runId !== undefined
    // A portable host must explicitly report reuse before the Coordinator may
    // take the active-push path. A new or ambiguous host cannot turn a missing
    // argv receipt into a resend.
    && binding.hostCreated !== false;
  if (
    (initialPromptReceiptRequired || launchCarriedPromptReceiptRequired)
    && binding.initialPromptReceipt === undefined
  ) {
    throw new RuntimeBindingContractError(
      `Session host did not acknowledge the exact initial prompt receipt: ${
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
      binding.initialPromptRunId !== undefined
      && binding.initialPromptRunId !== request.runId
    )
    || (
      binding.initialPromptReceipt !== undefined
      && (
        binding.initialPromptReceipt.runId !== request.runId
        || binding.initialPromptReceipt.launchId !== launchId
        || binding.initialPromptReceipt.workspace !== request.workspace
      )
    )
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
    request.workspace
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
