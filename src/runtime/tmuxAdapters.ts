import { randomUUID } from "node:crypto";

import {
  createRuntimeBinding,
  type RuntimeBinding
} from "./runtimeBinding.js";
import {
  normalizeRuntimeOwner,
  type RuntimeOwner
} from "./runtimeOwner.js";
import type {
  NewSessionLaunchRequest,
  ResumeSessionLaunchRequest,
  SessionLaunchRequest
} from "./sessionLaunchRequest.js";
import {
  RuntimeHostContentionError,
  RuntimeLaunchError,
  type ActivePromptPushPort,
  type ActivePromptPushRequest,
  type PromptPushResult,
  type RuntimeLaunchPreStart,
  type SessionHostPort,
  type SessionInspection
} from "./ports.js";
import {
  toRuntimeLaunchFailure,
  type RuntimeLaunchDiagnosticContext
} from "./launchDiagnostics.js";
import { builtinAgentDriverRegistry } from "./builtinAgentDrivers.js";
import { requireSafeIdentity } from "./validation.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { TaskRuntimeIsolationDescriptor } from "./taskRuntimeIsolation.js";

export type RuntimeTmuxRole = Readonly<{
  name: string;
  workspace: string;
  cwd?: string;
  status?: string;
}>;

export type RuntimeTmuxLaunchPlan = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

export type RuntimePlannedSession = Readonly<{
  role: RuntimeTmuxRole;
  launch: RuntimeTmuxLaunchPlan;
  session: Readonly<{ nativeSessionId?: string }> | null;
  /** Exact Run whose first prompt is submitted by the fresh host process. */
  initialPromptRunId?: string;
}>;

/** Narrow structural boundary implemented by FileRoleLaunchPlanner. */
export interface RuntimeRoleLaunchPlannerPort {
  plan(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    effective: EffectiveLaunchSnapshot;
    mode: "new" | "resume";
    runId?: string;
    nativeSessionId?: string;
    launchId?: string;
    runtimeIsolation?: TaskRuntimeIsolationDescriptor;
    environment?: Readonly<Record<string, string>>;
  }>): RuntimePlannedSession;
  planGlobalRole(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    effective: EffectiveLaunchSnapshot;
    mode: "new" | "resume";
    nativeSessionId?: string;
    launchId?: string;
    environment?: Readonly<Record<string, string>>;
  }>): RuntimePlannedSession;
  /**
   * Persist a caller key only after the host adapter has confirmed that a
   * native process was actually created. Resume/ensure calls may reuse a live
   * host, in which case rotating the durable hash would invalidate the live
   * process's key.
   */
  commitTaskCallerKey?(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    callerKey: string;
  }>): void;
}

/** The lifecycle subset required from TmuxManager. */
export interface RuntimeTmuxHostPort {
  /** Human writer lease; managed Task launches must not share its pane. */
  hasWritableClient?(hostId: string, roleName?: string): boolean;
  hasWritableClientAsync?(hostId: string, roleName?: string): Promise<boolean>;
  ensureRoleWindow(
    hostId: string,
    role: RuntimeTmuxRole,
    launch?: RuntimeTmuxLaunchPlan
  ): boolean;
  ensureRoleWindowAsync?(
    hostId: string,
    role: RuntimeTmuxRole,
    launch?: RuntimeTmuxLaunchPlan
  ): Promise<boolean>;
  probeRoleStatus(hostId: string, roleName: string): "running" | "exited";
  probeRoleStatusAsync?(
    hostId: string,
    roleName: string
  ): Promise<"running" | "exited">;
  killRole(hostId: string, roleName: string): void;
  killRoleAsync?(hostId: string, roleName: string): Promise<void>;
  inspectRolePaneInventory?(): readonly Readonly<{
    taskId: string;
    roleName: string;
    dead: boolean;
  }>[];
  inspectRolePaneInventoryAsync?(): Promise<readonly Readonly<{
    taskId: string;
    roleName: string;
    dead: boolean;
  }>[]>;
  /** Reads one Role pane's exact process state after host creation. */
  inspectRolePane?(
    hostId: string,
    roleName: string
  ): Readonly<{
    pid?: number;
    target: string;
    dead: boolean;
    currentCommand: string;
    exitStatus?: number;
  }>;
  inspectRolePaneAsync?(
    hostId: string,
    roleName: string
  ): Promise<Readonly<{
    pid?: number;
    target: string;
    dead: boolean;
    currentCommand: string;
    exitStatus?: number;
  }>>;
  /** Captures a fresh dead Provider pane for launch diagnostics. */
  captureRolePane?(hostId: string, roleName: string, lines?: number): string;
}

export type RuntimeTmuxPaneState = Readonly<{
  taskId: string;
  roleName: string;
  target: string;
  dead: boolean;
  pid?: number;
  currentCommand: string;
  cursorX?: number;
  cursorY?: number;
  historySize?: number;
}>;

export type RuntimeReadinessProbe = (pane: RuntimeTmuxPaneState) => boolean;
export type RuntimeReadinessResolver = (adapterId: string) => RuntimeReadinessProbe;

/** The non-blocking delivery subset required from TmuxManager. */
export interface RuntimeTmuxPromptPort {
  probeRoleStatus(hostId: string, roleName: string): "running" | "exited";
  probeRoleStatusAsync?(
    hostId: string,
    roleName: string
  ): Promise<"running" | "exited">;
  sendRoleInputOnceIfReady(
    hostId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: RuntimeReadinessProbe
  ): "sent" | "already-sent" | "not-ready" | "unavailable";
  sendRoleInputOnceIfReadyAsync?(
    hostId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: RuntimeReadinessProbe
  ): Promise<"sent" | "already-sent" | "not-ready" | "unavailable">;
}

export type TmuxSessionHostOptions = Readonly<{
  /** Current global Operator topology uses one synthetic tmux Task session. */
  globalHostId?: string;
  createBindingId?: () => string;
  /**
   * Invoked after this host created a new external Role process, with the
   * binding and the fresh pane state. Issue 03 uses it to persist the exact
   * physical owner identity (Provider root PID + start identity) so a later
   * reconciliation can prove exit even after the durable Session map is
   * cleared. Never invoked for a reused live host.
   */
  onHostCreated?: (input: Readonly<{
    binding: RuntimeBinding;
    pane: Readonly<{
      pid?: number;
      target: string;
      dead: boolean;
      currentCommand: string;
      exitStatus?: number;
    }>;
  }>) => void;
  /** Validates resolved launch configuration after planning, before process start. */
  validateLaunch?: (request: SessionLaunchRequest) => Promise<void>;
  /**
   * Awaits the durable native-session fact for a runtime-discovered Provider
   * launch. The host bounds the wait and stops the fresh Provider on timeout.
   */
  waitForNativeSession?: (
    request: SessionLaunchRequest,
    signal: AbortSignal
  ) => Promise<string>;
  nativeSessionDiscoveryTimeoutMs?: number;
}>;

const DEFAULT_NATIVE_SESSION_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Runtime lifecycle adapter for the current tmux host. The returned hostRef is
 * opaque to the domain and self-contained for a later inspect/stop operation.
 */
export class TmuxSessionHost implements SessionHostPort {
  readonly #globalHostId: string;
  readonly #createBindingId: () => string;
  readonly #onHostCreated: TmuxSessionHostOptions["onHostCreated"];
  readonly #validateLaunch: TmuxSessionHostOptions["validateLaunch"];
  readonly #waitForNativeSession: TmuxSessionHostOptions["waitForNativeSession"];
  readonly #nativeSessionDiscoveryTimeoutMs: number;
  readonly #launchTails = new Map<string, Promise<void>>();

  constructor(
    private readonly planner: RuntimeRoleLaunchPlannerPort,
    private readonly tmux: RuntimeTmuxHostPort,
    options: TmuxSessionHostOptions = {}
  ) {
    this.#globalHostId = requireSafeIdentity(
      options.globalHostId ?? "operator",
      "Global tmux host id"
    );
    this.#createBindingId = options.createBindingId ?? randomUUID;
    this.#onHostCreated = options.onHostCreated;
    this.#validateLaunch = options.validateLaunch;
    this.#waitForNativeSession = options.waitForNativeSession;
    this.#nativeSessionDiscoveryTimeoutMs = positiveInteger(
      options.nativeSessionDiscoveryTimeoutMs
        ?? DEFAULT_NATIVE_SESSION_DISCOVERY_TIMEOUT_MS,
      "Native session discovery timeout"
    );
  }

  async start(
    request: NewSessionLaunchRequest,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    return this.#launch(request, beforeHostStart);
  }

  async resume(
    request: ResumeSessionLaunchRequest,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    return this.#launch(request, beforeHostStart);
  }

  async stop(binding: RuntimeBinding): Promise<void> {
    const ref = requireMatchingHostRef(binding);
    await stopExactRole(this.tmux, ref.hostId, ref.roleName);
  }

  async inspect(binding: RuntimeBinding): Promise<SessionInspection> {
    const ref = requireMatchingHostRef(binding);
    try {
      const state = await probeRoleStatus(this.tmux, ref.hostId, ref.roleName) === "running"
        ? "running"
        : "stopped";
      return {
        state,
        ...(binding.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: binding.nativeSessionId })
      };
    } catch {
      return {
        state: "unavailable",
        ...(binding.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: binding.nativeSessionId })
      };
    }
  }

  async inspectOwner(owner: RuntimeOwner): Promise<SessionInspection> {
    const normalized = normalizeRuntimeOwner(owner);
    const hostId = normalized.scope === "task"
      ? normalized.taskId
      : this.#globalHostId;
    try {
      return {
        state: await probeRoleStatus(
          this.tmux,
          hostId,
          normalized.roleName
        ) === "running"
          ? "running"
          : "stopped"
      };
    } catch {
      return { state: "unavailable" };
    }
  }

  async inspectOwners(
    owners: readonly RuntimeOwner[]
  ): Promise<readonly Readonly<{
    owner: RuntimeOwner;
    inspection: SessionInspection;
  }>[]> {
    const normalized = owners.map(normalizeRuntimeOwner);
    if (
      this.tmux.inspectRolePaneInventory === undefined
      && this.tmux.inspectRolePaneInventoryAsync === undefined
    ) {
      return Promise.all(normalized.map(async (owner) => ({
        owner,
        inspection: await this.inspectOwner(owner)
      })));
    }
    try {
      const inventory = this.tmux.inspectRolePaneInventoryAsync === undefined
        ? this.tmux.inspectRolePaneInventory!()
        : await this.tmux.inspectRolePaneInventoryAsync();
      const running = new Set(
        inventory
          .filter((pane) => !pane.dead)
          .map((pane) => `${pane.taskId}\0${pane.roleName}`)
      );
      return normalized.map((owner) => {
        const hostId = owner.scope === "task"
          ? owner.taskId
          : this.#globalHostId;
        return {
          owner,
          inspection: {
            state: running.has(`${hostId}\0${owner.roleName}`)
              ? "running" as const
              : "stopped" as const
          }
        };
      });
    } catch {
      return normalized.map((owner) => ({
        owner,
        inspection: { state: "unavailable" as const }
      }));
    }
  }

  async stopOwner(owner: RuntimeOwner): Promise<boolean> {
    const normalized = normalizeRuntimeOwner(owner);
    const hostId = normalized.scope === "task"
      ? normalized.taskId
      : this.#globalHostId;
    try {
      await stopExactRole(this.tmux, hostId, normalized.roleName);
      return await probeRoleStatus(this.tmux, hostId, normalized.roleName)
        === "exited";
    } catch {
      return false;
    }
  }

  async #launch(
    request: SessionLaunchRequest,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    const hostId = request.owner.scope === "task"
      ? request.owner.taskId
      : this.#globalHostId;
    // All Role windows for one Task share the same tmux session. Serialize the
    // short create/ensure boundary per host so two first Roles cannot race
    // `new-session`; different Tasks and the global Operator remain parallel.
    const key = hostId;
    const previous = this.#launchTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this.#launchTails.set(key, tail);
    await previous;
    try {
      return await this.#launchUnlocked(request, hostId, beforeHostStart);
    } finally {
      release();
      if (this.#launchTails.get(key) === tail) this.#launchTails.delete(key);
    }
  }

  async #launchUnlocked(
    request: SessionLaunchRequest,
    hostId: string,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    // Validate generated identity before starting an external process.
    const bindingId = requireSafeIdentity(this.#createBindingId(), "Runtime binding id");
    const writableHumanAttached = request.owner.scope === "task"
      && request.runId !== undefined
      && (this.tmux.hasWritableClientAsync !== undefined
        ? await this.tmux.hasWritableClientAsync(hostId, request.owner.roleName)
        : this.tmux.hasWritableClient?.(hostId, request.owner.roleName) === true);
    if (
      writableHumanAttached
    ) {
      throw new RuntimeHostContentionError(
        "writable-client",
        `A writable human is attached to ${request.owner.taskId}/${request.owner.roleName}.`
      );
    }
    if (
      request.owner.scope === "task"
      && request.adapterId === "claude"
      && request.runId !== undefined
      && await probeRoleStatus(this.tmux, hostId, request.owner.roleName) === "running"
    ) {
      // Managed Claude is process-per-Run. A live Role window here belongs to
      // an earlier process (or to recovery of the exact reserved Run); never
      // plan, persist pre-start state, or inject input into it. The coordinator
      // decides between same-generation recovery and a retry after natural
      // exit from the durable reservation identity.
      return createRuntimeBinding({
        id: bindingId,
        launchId: request.launchId,
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        hostRef: encodeHostRef({
          scope: request.owner.scope,
          hostId,
          roleName: request.owner.roleName
        }),
        hostCreated: false,
        ...(request.mode === "resume"
          ? { nativeSessionId: request.nativeSessionId }
          : {})
      });
    }
    const { planned, nativeSessionId } = planManagedLaunch(
      this.planner,
      request,
      beforeHostStart
    );
    const launchContext = diagnosticContext(request, planned);
    if (this.#validateLaunch !== undefined) {
      try {
        await this.#validateLaunch(request);
      } catch (error) {
        throw toRuntimeLaunchFailure(error, "validation", launchContext);
      }
    }
    // Process creation is last: every local invariant has already passed.
    let hostCreated: boolean;
    try {
      hostCreated = await ensureRoleWindow(
        this.tmux,
        hostId,
        planned.role,
        planned.launch
      );
    } catch (error) {
      throw toRuntimeLaunchFailure(error, "host-start", launchContext);
    }
    if (
      hostCreated
      && request.owner.scope === "task"
      && planned.launch.env.YUI_JOB_CALLER_KEY !== undefined
      && this.planner.commitTaskCallerKey !== undefined
    ) {
      this.planner.commitTaskCallerKey({
        taskId: request.owner.taskId,
        roleName: request.owner.roleName,
        agentId: request.agentId,
        callerKey: planned.launch.env.YUI_JOB_CALLER_KEY
      });
    }
    let binding = createRuntimeBinding({
      id: bindingId,
      launchId: request.launchId,
      owner: request.owner,
      agentId: request.agentId,
      adapterId: request.adapterId,
      hostRef: encodeHostRef({
        scope: request.owner.scope,
        hostId,
        roleName: request.owner.roleName
      }),
      hostCreated,
      ...(hostCreated && planned.initialPromptRunId !== undefined
        ? { initialPromptRunId: planned.initialPromptRunId }
        : {}),
      ...(nativeSessionId === undefined ? {} : { nativeSessionId })
    });
    if (hostCreated) {
      let pane;
      try {
        pane = await inspectRolePane(this.tmux, hostId, request.owner.roleName);
      } catch (error) {
        throw toRuntimeLaunchFailure(error, "host-started", launchContext);
      }
      if (pane === undefined) {
        throw toRuntimeLaunchFailure(
          new Error("Managed host pane could not be inspected after creation."),
          "host-started",
          launchContext
        );
      }
      this.#onHostCreated?.({ binding, pane });
      if (pane.dead) {
        await deadHostLaunchFailure(
          this.tmux,
          hostId,
          request.owner.roleName,
          pane,
          launchContext
        );
      }
      if (requiresNativeSessionDiscovery(request, planned, this.#waitForNativeSession)) {
        const discoveredNativeSessionId = await this.waitForNativeSessionDiscovery(
          request,
          hostId,
          launchContext,
          pane
        );
        binding = createRuntimeBinding({
          ...binding,
          nativeSessionId: discoveredNativeSessionId
        });
      }
      this.#onHostCreated?.({ binding, pane });
    }
    return binding;
  }

  async waitForNativeSessionDiscovery(
    request: SessionLaunchRequest,
    hostId: string,
    context: RuntimeLaunchDiagnosticContext,
    pane: Readonly<{
      pid?: number;
      target: string;
      dead: boolean;
      currentCommand: string;
      exitStatus?: number;
    }>
  ): Promise<string> {
    if (this.#waitForNativeSession === undefined) {
      throw new Error("Native session discovery is not configured.");
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const discovery = this.#waitForNativeSession(request, controller.signal);
    // The losing branch of the race rejects when the controller aborts; keep
    // that rejection handled so a settled launch does not surface it later.
    discovery.catch(() => undefined);
    try {
      return await Promise.race([
        discovery,
        this.waitForPaneDeath(request, hostId, context, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(
              `Native session discovery timed out after ${
                this.#nativeSessionDiscoveryTimeoutMs
              }ms.`
            ));
          }, this.#nativeSessionDiscoveryTimeoutMs);
        })
      ]);
    } catch (error) {
      try {
        await stopExactRole(this.tmux, hostId, request.owner.roleName);
      } catch {
        // The launch failure below is authoritative; durable owner cleanup
        // remains responsible for a Provider that rejected immediate stop.
      }
      throw toRuntimeLaunchFailure(error, "native-session-discovery", {
        ...context,
        pane
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * Polls the managed pane while native session discovery is pending. A
   * Provider that exits during the wait (bad configuration, auth failure,
   * immediate crash) must surface its own exit evidence instead of being
   * misreported as a discovery timeout.
   */
  private async waitForPaneDeath(
    request: SessionLaunchRequest,
    hostId: string,
    context: RuntimeLaunchDiagnosticContext,
    signal: AbortSignal
  ): Promise<never> {
    while (!signal.aborted) {
      await abortableDelay(PANE_LIVENESS_POLL_MS, signal);
      let pane;
      try {
        pane = await inspectRolePane(this.tmux, hostId, request.owner.roleName);
      } catch {
        // A tmux inspection hiccup must not fabricate a Provider death; the
        // bounded discovery timeout remains the backstop.
        continue;
      }
      if (pane !== undefined && pane.dead) {
        await deadHostLaunchFailure(
          this.tmux,
          hostId,
          request.owner.roleName,
          pane,
          context
        );
      }
    }
    throw new Error("Native session discovery was aborted.");
  }
}

function requiresNativeSessionDiscovery(
  request: SessionLaunchRequest,
  planned: RuntimePlannedSession,
  wait: TmuxSessionHostOptions["waitForNativeSession"]
): boolean {
  return request.mode === "new"
    && request.owner.scope === "task"
    && request.runId !== undefined
    && planned.initialPromptRunId === request.runId
    && wait !== undefined
    && builtinAgentDriverRegistry()
      .requireByAdapterId(request.adapterId)
      .capabilities.observation.sessionBootstrap === "discovered";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

const PANE_LIVENESS_POLL_MS = 100;

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Native session discovery was aborted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Native session discovery was aborted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function planManagedLaunch(
  planner: RuntimeRoleLaunchPlannerPort,
  request: SessionLaunchRequest,
  beforeHostStart: RuntimeLaunchPreStart | undefined
): Readonly<{
  planned: RuntimePlannedSession;
  nativeSessionId: string | undefined;
}> {
  try {
    const input = {
      roleName: request.owner.roleName,
      agentId: request.agentId,
      adapterId: request.adapterId,
      effective: request.effective,
      launchId: request.launchId,
      mode: request.mode,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      ...(request.runtimeIsolation === undefined
        ? {}
        : { runtimeIsolation: request.runtimeIsolation }),
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment }),
      ...(request.mode === "resume" ? { nativeSessionId: request.nativeSessionId } : {})
    };
    const planned = request.owner.scope === "task"
      ? planner.plan({ taskId: request.owner.taskId, ...input })
      : planner.planGlobalRole(input);
    if (planned.role.name !== request.owner.roleName) {
      throw new Error("Planned Role does not match the runtime owner.");
    }
    if (planned.role.workspace !== request.workspace) {
      throw new Error("Planned Role workspace does not match the runtime request.");
    }
    const plannedNativeSessionId = planned.session?.nativeSessionId;
    if (
      request.mode === "resume"
      && plannedNativeSessionId !== undefined
      && plannedNativeSessionId !== request.nativeSessionId
    ) {
      throw new Error("Planned native session does not match the resume request.");
    }
    const nativeSessionId = plannedNativeSessionId
      ?? (request.mode === "resume" ? request.nativeSessionId : undefined);
    beforeHostStart?.({
      owner: request.owner,
      launchId: request.launchId,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      agentId: request.agentId,
      adapterId: request.adapterId,
      effective: request.effective,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      ...(planned.initialPromptRunId === undefined
        ? {}
        : { initialPromptRunId: planned.initialPromptRunId })
    });
    return { planned, nativeSessionId };
  } catch (error) {
    if (
      error instanceof RuntimeLaunchError
      || error instanceof RuntimeHostContentionError
    ) {
      throw error;
    }
    throw toRuntimeLaunchFailure(error, "validation", {
      agentId: request.agentId,
      cwd: request.workspace
    });
  }
}

function diagnosticContext(
  request: SessionLaunchRequest,
  planned: RuntimePlannedSession
): RuntimeLaunchDiagnosticContext {
  return {
    command: planned.launch.command,
    argv: [planned.launch.command, ...planned.launch.args],
    cwd: planned.role.cwd ?? planned.role.workspace,
    agentId: request.agentId
  };
}

async function deadHostLaunchFailure(
  tmux: RuntimeTmuxHostPort,
  hostId: string,
  roleName: string,
  pane: Readonly<{
    pid?: number;
    target: string;
    dead: boolean;
    currentCommand: string;
    exitStatus?: number;
  }>,
  context: RuntimeLaunchDiagnosticContext
): Promise<never> {
  let stderrTail: string | undefined;
  try {
    stderrTail = tmux.captureRolePane?.(hostId, roleName, 80);
  } catch {
    // The pane state is the required evidence; capture is best-effort.
  }
  throw toRuntimeLaunchFailure(
    new Error("Provider exited immediately after managed host start."),
    "host-started",
    {
      ...context,
      pane,
      ...(pane.exitStatus === undefined ? {} : { exitStatus: pane.exitStatus }),
      ...(stderrTail === undefined || stderrTail.length === 0 ? {} : { stderrTail })
    }
  );
}

/** Non-blocking receipt-backed tmux push; it never interprets provider output. */
export class TmuxPromptPushAdapter implements ActivePromptPushPort {
  constructor(
    private readonly tmux: RuntimeTmuxPromptPort,
    private readonly readiness: RuntimeReadinessResolver
  ) {}

  async tryPush(request: ActivePromptPushRequest): Promise<PromptPushResult> {
    const ref = requireMatchingHostRef(request.binding);
    const readinessProbe = this.readiness(request.binding.adapterId);
    const outcome = this.tmux.sendRoleInputOnceIfReadyAsync === undefined
      ? this.tmux.sendRoleInputOnceIfReady(
          ref.hostId,
          ref.roleName,
          request.envelope.id,
          request.envelope.text,
          readinessProbe
        )
      : await this.tmux.sendRoleInputOnceIfReadyAsync(
          ref.hostId,
          ref.roleName,
          request.envelope.id,
          request.envelope.text,
          readinessProbe
        );
    if (outcome === "unavailable") return "unavailable";
    return outcome === "not-ready" ? "busy" : "delivered";
  }
}

async function ensureRoleWindow(
  tmux: RuntimeTmuxHostPort,
  hostId: string,
  role: RuntimeTmuxRole,
  launch?: RuntimeTmuxLaunchPlan
): Promise<boolean> {
  return tmux.ensureRoleWindowAsync === undefined
    ? tmux.ensureRoleWindow(hostId, role, launch)
    : tmux.ensureRoleWindowAsync(hostId, role, launch);
}

async function probeRoleStatus(
  tmux: Pick<
    RuntimeTmuxHostPort,
    "probeRoleStatus" | "probeRoleStatusAsync"
  >,
  hostId: string,
  roleName: string
): Promise<"running" | "exited"> {
  return tmux.probeRoleStatusAsync === undefined
    ? tmux.probeRoleStatus(hostId, roleName)
    : tmux.probeRoleStatusAsync(hostId, roleName);
}

async function inspectRolePane(
  tmux: RuntimeTmuxHostPort,
  hostId: string,
  roleName: string
): Promise<Readonly<{
  pid?: number;
  target: string;
  dead: boolean;
  currentCommand: string;
  exitStatus?: number;
 }> | undefined> {
  return tmux.inspectRolePaneAsync === undefined
    ? tmux.inspectRolePane?.(hostId, roleName)
    : await tmux.inspectRolePaneAsync(hostId, roleName);
}

async function killRole(
  tmux: RuntimeTmuxHostPort,
  hostId: string,
  roleName: string
): Promise<void> {
  if (tmux.killRoleAsync === undefined) {
    tmux.killRole(hostId, roleName);
    return;
  }
  await tmux.killRoleAsync(hostId, roleName);
}

async function stopExactRole(
  tmux: RuntimeTmuxHostPort,
  hostId: string,
  roleName: string
): Promise<void> {
  if (await probeRoleStatus(tmux, hostId, roleName) !== "running") return;
  try {
    await killRole(tmux, hostId, roleName);
  } catch (error) {
    // Killing the final window may make the tmux server exit before the
    // client observes a clean command status. The authoritative outcome is
    // the exact Role's postcondition. Preserve the original error unless the
    // Role is positively proven stopped.
    try {
      if (await probeRoleStatus(tmux, hostId, roleName) === "exited") return;
    } catch {
      // Fall through to the original kill error; an unavailable postcondition
      // is not evidence that cleanup succeeded.
    }
    throw error;
  }
}

type TmuxHostRef = Readonly<{
  scope: "global" | "task";
  hostId: string;
  roleName: string;
}>;

const HOST_REF_PREFIX = "yui-tmux:v1:";

function encodeHostRef(ref: TmuxHostRef): string {
  return `${HOST_REF_PREFIX}${Buffer.from(JSON.stringify(ref), "utf8").toString("base64url")}`;
}

function requireMatchingHostRef(binding: RuntimeBinding): TmuxHostRef {
  const ref = decodeHostRef(binding.hostRef);
  const matches = binding.owner.scope === ref.scope
    && binding.owner.roleName === ref.roleName
    && (binding.owner.scope === "global" || binding.owner.taskId === ref.hostId);
  if (!matches) throw new Error("Tmux host reference does not match runtime owner.");
  return ref;
}

function decodeHostRef(value: string): TmuxHostRef {
  if (!value.startsWith(HOST_REF_PREFIX)) {
    throw new Error("Tmux host reference is invalid.");
  }
  let input: unknown;
  try {
    const encoded = value.slice(HOST_REF_PREFIX.length);
    input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Tmux host reference is invalid.");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Tmux host reference is invalid.");
  }
  const record = input as Record<string, unknown>;
  const expectedKeys = ["hostId", "roleName", "scope"];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.sort().join("\0")) {
    throw new Error("Tmux host reference is invalid.");
  }
  if (record.scope !== "global" && record.scope !== "task") {
    throw new Error("Tmux host reference is invalid.");
  }
  const hostId = requireSafeIdentity(record.hostId as string, "Tmux host id");
  const roleName = requireSafeIdentity(record.roleName as string, "Tmux Role name");
  if (record.scope === "global") return { scope: "global", hostId, roleName };
  return {
    scope: "task",
    hostId,
    roleName
  };
}
