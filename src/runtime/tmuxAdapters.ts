import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

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
  type ActivePromptSteerRequest,
  type PromptPushResult,
  type RuntimeLaunchPreStart,
  type SessionHostPort,
  type SessionInspection
} from "./ports.js";
import {
  toRuntimeLaunchFailure,
  hasFatalLaunchOutput,
  type RuntimeLaunchDiagnosticContext
} from "./launchDiagnostics.js";
import { builtinAgentDriverRegistry } from "./builtinAgentDrivers.js";
import { requireSafeIdentity } from "./validation.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { TaskRuntimeIsolationDescriptor } from "./taskRuntimeIsolation.js";
import {
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR
} from "./exactControlPlane.js";
import { launchBrokerForHome, type AgentHostLaunchPayload } from "./launchBroker.js";
import {
  AGENT_HOST_CONTROL_PROTOCOL,
  sendAgentHostLaunchControl,
  sendAgentHostTurnControl,
  sendAgentHostSteerControl,
  waitForAgentHostLaunchAck,
  type AgentHostSnapshot
} from "./agentHost.js";

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
  providerControl?: AgentHostLaunchPayload["providerControl"];
  childLifecycle?: AgentHostLaunchPayload["childLifecycle"];
  deferProviderStart?: boolean;
}>;

export type RuntimePlannedSession = Readonly<{
  role: RuntimeTmuxRole;
  launch: RuntimeTmuxLaunchPlan;
  session: Readonly<{ nativeSessionId?: string }> | null;
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
    turnId?: string;
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
   * Persist a caller key only after the host adapter has confirmed that its
   * Provider process exists. A live Conversation resume retains its inherited
   * key; a Conversation replacement inside a reused Host owns a fresh one.
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
    deadStatus?: number;
  }>[];
  inspectRolePaneInventoryAsync?(): Promise<readonly Readonly<{
    taskId: string;
    roleName: string;
    dead: boolean;
    deadStatus?: number;
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
   * launch. The host monitors agent-emitted signals (pane death, fatal output,
   * inactivity) and stops the fresh Provider when a negative signal arrives.
   */
  waitForNativeSession?: (
    request: SessionLaunchRequest,
    signal: AbortSignal
  ) => Promise<string>;
  /**
   * Backstop for a completely unresponsive agent: if the agent produces no
   * signal (no hook, no pane output change, no exit) for this long, the launch
   * fails. A slow-but-active agent never triggers this. Defaults to 5 minutes.
   */
  inactivityTimeoutMs?: number;
}>;

const DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000;

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
  readonly #inactivityTimeoutMs: number;
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
    this.#inactivityTimeoutMs = positiveInteger(
      options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
      "Launch inactivity timeout"
    );
  }

  async start(
    request: NewSessionLaunchRequest,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    return this.#launch(request, beforeHostStart);
  }

  async restore(
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
      && request.turnId !== undefined
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
    const input = {
      roleName: request.owner.roleName,
      agentId: request.agentId,
      adapterId: request.adapterId,
      effective: request.effective,
      launchId: request.launchId,
      mode: request.mode,
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      ...(request.runtimeIsolation === undefined
        ? {}
        : { runtimeIsolation: request.runtimeIsolation }),
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment }),
      ...(request.mode === "resume" ? { nativeSessionId: request.nativeSessionId } : {})
    };
    let planned: RuntimePlannedSession;
    try {
      planned = request.owner.scope === "task"
        ? this.planner.plan({ taskId: request.owner.taskId, ...input })
        : this.planner.planGlobalRole(input);
    } catch (error) {
      throw toRuntimeLaunchFailure(error, "validation", {
        cwd: request.workspace,
        agentId: request.agentId
      });
    }
    if (planned.role.name !== request.owner.roleName) {
      throw new Error("Planned Role does not match the runtime owner.");
    }
    if (planned.role.workspace !== request.workspace) {
      throw new Error("Planned Role workspace does not match the runtime request.");
    }
    const launchContext = diagnosticContext(request, planned);
    if (this.#validateLaunch !== undefined) {
      try {
        await this.#validateLaunch(request);
      } catch (error) {
        throw toRuntimeLaunchFailure(error, "validation", launchContext);
      }
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
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      agentId: request.agentId,
      adapterId: request.adapterId,
      effective: request.effective,
      ...(planned.launch.env.YUI_SESSION_TITLE === undefined
        ? {}
        : { sessionTitle: planned.launch.env.YUI_SESSION_TITLE }),
      ...(nativeSessionId === undefined ? {} : { nativeSessionId })
    });
    const yuiHome = planned.launch.env.YUI_HOME;
    const childLifecycle = planned.launch.childLifecycle;
    // Interactive/global Roles remain native TUIs even when their Driver
    // advertises a persistent child lifecycle. Provider control metadata is
    // the discriminator for the structured Agent Host path. A managed Task
    // Turn has no terminal-write fallback and must expose that contract.
    if (
      yuiHome === undefined
      || childLifecycle === undefined
      || planned.launch.providerControl === undefined
    ) {
      if (request.owner.scope === "task" && request.turnId !== undefined) {
        throw new Error("Managed Task Turn is missing its structured Agent Host contract.");
      }
      let hostCreated: boolean;
      try {
        hostCreated = await ensureRoleWindow(this.tmux, hostId, planned.role, planned.launch);
      } catch (error) {
        throw toRuntimeLaunchFailure(error, "host-start", launchContext);
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
        ...(nativeSessionId === undefined ? {} : { nativeSessionId })
      });
      if (hostCreated) {
        const pane = await inspectRolePane(this.tmux, hostId, request.owner.roleName);
        if (pane?.dead === true) {
          await deadHostLaunchFailure(
            this.tmux,
            hostId,
            request.owner.roleName,
            pane,
            launchContext
          );
        }
        if (request.mode === "new"
          && request.owner.scope === "task"
          && request.turnId !== undefined
          && this.#waitForNativeSession !== undefined) {
          binding = createRuntimeBinding({
            ...binding,
            nativeSessionId: await this.waitForNativeSessionDiscovery(
              request,
              hostId,
              launchContext
            )
          });
        }
        if (pane !== undefined) this.#onHostCreated?.({ binding, pane });
      }
      return binding;
    }
    const broker = launchBrokerForHome(yuiHome);
    const sessionManifest = planned.launch.env.YUI_SESSION_MANIFEST;
    const frozenControlPlane = planned.launch.env[YUI_CONTROL_PLANE_DESCRIPTOR];
    const frozenTaskRuntime = planned.launch.env[YUI_TASK_RUNTIME_DESCRIPTOR];
    if (request.owner.scope === "task" && request.turnId !== undefined
      && (sessionManifest === undefined
        || frozenControlPlane === undefined
        || frozenTaskRuntime === undefined)) {
      throw new Error(
        "Managed Task Agent Host launch is missing its Session Manifest or frozen control descriptors."
      );
    }
    const reservation = broker.reserve(Object.freeze({
      schemaVersion: 1,
      launchId: request.launchId,
      command: planned.launch.command,
      args: [...planned.launch.args],
      environment: { ...planned.launch.env },
      cwd: planned.role.cwd ?? planned.role.workspace,
      childLifecycle,
      startMode: planned.launch.deferProviderStart === true ? "idle" : "provider",
      ...(planned.launch.providerControl === undefined
        ? {}
        : { providerControl: planned.launch.providerControl })
    }));
    const hostLaunch = {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../cli.js", import.meta.url)),
        "internal",
        "agent-host",
        reservation.launchId,
        reservation.ticket
      ],
      env: {
        YUI_HOME: resolve(yuiHome),
        YUI_SESSION_SCOPE: request.owner.scope,
        ...(request.owner.scope === "task" ? { YUI_TASK_ID: request.owner.taskId } : {}),
        YUI_ROLE: request.owner.roleName,
        YUI_LAUNCH_ID: request.launchId,
        ...(planned.launch.env.YUI_AGENT_ID === undefined
          ? {}
          : { YUI_AGENT_ID: planned.launch.env.YUI_AGENT_ID }),
        ...(planned.launch.env.YUI_ADAPTER_ID === undefined
          ? {}
          : { YUI_ADAPTER_ID: planned.launch.env.YUI_ADAPTER_ID }),
        ...(planned.launch.env.YUI_WORKSPACE === undefined
          ? {}
          : { YUI_WORKSPACE: planned.launch.env.YUI_WORKSPACE }),
        ...(sessionManifest === undefined
          ? {}
          : { YUI_SESSION_MANIFEST: sessionManifest }),
        ...(frozenControlPlane === undefined
          ? {}
          : { [YUI_CONTROL_PLANE_DESCRIPTOR]: frozenControlPlane }),
        ...(frozenTaskRuntime === undefined
          ? {}
          : { [YUI_TASK_RUNTIME_DESCRIPTOR]: frozenTaskRuntime })
      }
    };
    let hostCreated = false;
    let providerDispatchObserved = false;
    let providerSnapshot: AgentHostSnapshot | undefined;
    try {
      hostCreated = await ensureRoleWindow(this.tmux, hostId, planned.role, hostLaunch);
      if (hostCreated && planned.launch.deferProviderStart !== true) {
        providerSnapshot = await waitForAgentHostLaunchAck({
          home: yuiHome,
          scope: request.owner.scope,
          ...(request.owner.scope === "task" ? { taskId: request.owner.taskId } : {}),
          roleName: request.owner.roleName,
          launchId: reservation.launchId,
          requireTurnAck: false
        });
        providerDispatchObserved = true;
      }
      if (!hostCreated) {
        const controlResult = await sendAgentHostLaunchControl({
          home: yuiHome,
          scope: request.owner.scope,
          ...(request.owner.scope === "task" ? { taskId: request.owner.taskId } : {}),
          roleName: request.owner.roleName,
          control: {
            protocol: AGENT_HOST_CONTROL_PROTOCOL,
            type: "launch",
            launchId: reservation.launchId,
            ticket: reservation.ticket
          }
        });
        if (controlResult.outcome === "active-other-launch") {
          broker.revoke(request.launchId);
          throw new RuntimeHostContentionError(
            "provider-child-active",
            `The persistent Agent Host for ${request.owner.roleName} still owns another Provider Turn.`
          );
        }
        if (controlResult.outcome === "active-same-launch") {
          broker.revoke(request.launchId);
        }
        const acceptableState = ["idle", "ready", "busy"].includes(
          controlResult.snapshot.state
        );
        if (!acceptableState
          || controlResult.snapshot.launchId !== reservation.launchId) {
          broker.revoke(request.launchId);
          throw new Error(
            `Agent Host did not return an exact Provider acknowledgement for ${reservation.launchId}.`
          );
        }
        providerSnapshot = controlResult.snapshot;
        providerDispatchObserved = true;
      }
    } catch (error) {
      broker.revoke(request.launchId);
      if (hostCreated && !providerDispatchObserved) {
        try {
          await stopExactRole(this.tmux, hostId, request.owner.roleName);
        } catch (stopError) {
          throw new Error(
            `Managed Provider launch failed and its disposable Agent Host could not be stopped: ${
              stopError instanceof Error ? stopError.message : String(stopError)
            }`,
            { cause: stopError }
          );
        }
      }
      throw error;
    }
    if (
      providerDispatchObserved
      // A fresh Host always starts a Provider process. mode=new also starts
      // one inside a reused Host by replacing (or creating) the native
      // Conversation. Same-Conversation resume must retain its inherited key.
      && (hostCreated || request.mode === "new")
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
    const binding = createRuntimeBinding({
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
      ...((providerSnapshot?.nativeSessionId ?? nativeSessionId) === undefined
        ? {}
        : { nativeSessionId: providerSnapshot?.nativeSessionId ?? nativeSessionId }),
      ...(planned.launch.providerControl === undefined
        ? {}
        : { providerAuthority: planned.launch.providerControl.authority })
    });
    if (hostCreated && this.#onHostCreated !== undefined) {
      const pane = await inspectRolePane(this.tmux, hostId, request.owner.roleName);
      if (pane !== undefined) this.#onHostCreated({ binding, pane });
    }
    return binding;
  }

  private async waitForNativeSessionDiscovery(
    request: SessionLaunchRequest,
    hostId: string,
    context: RuntimeLaunchDiagnosticContext
  ): Promise<string> {
    const controller = new AbortController();
    const discovery = this.#waitForNativeSession!(request, controller.signal);
    discovery.catch(() => undefined);
    let stopped = false;
    let lastContent = "";
    let lastActivityAt = Date.now();
    const monitor = (async (): Promise<never> => {
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, this.#inactivityTimeoutMs)));
        const pane = await inspectRolePane(this.tmux, hostId, request.owner.roleName);
        if (pane?.dead === true) {
          await deadHostLaunchFailure(this.tmux, hostId, request.owner.roleName, pane, context);
        }
        const content = this.tmux.captureRolePane?.(hostId, request.owner.roleName, 80) ?? "";
        if (content !== lastContent) {
          lastContent = content;
          lastActivityAt = Date.now();
        }
        if (Date.now() - lastActivityAt >= this.#inactivityTimeoutMs) {
          throw new Error(
            `Agent produced no signal for ${this.#inactivityTimeoutMs}ms. `
            + "The process is alive but emitted no lifecycle hook, output, or exit."
          );
        }
      }
      throw new Error("Native session discovery monitor stopped.");
    })();
    monitor.catch(() => undefined);
    try {
      return await Promise.race([discovery, monitor]);
    } catch (error) {
      try {
        await stopExactRole(this.tmux, hostId, request.owner.roleName);
      } catch {
        // Preserve the discovery failure; durable cleanup owns later retries.
      }
      throw toRuntimeLaunchFailure(error, "native-session-discovery", context);
    } finally {
      stopped = true;
      controller.abort();
    }
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

/** Structured managed-Turn input; tmux remains presentation/liveness only. */
export class AgentHostPromptPushAdapter implements ActivePromptPushPort {
  constructor(private readonly home: string) {}

  async tryPush(request: ActivePromptPushRequest): Promise<PromptPushResult> {
    const ref = requireMatchingHostRef(request.binding);
    if (ref.scope !== "task" || request.binding.nativeSessionId === undefined
      || request.binding.providerAuthority === undefined
      || request.binding.providerAuthority.owner !== "controller") {
      return "unavailable";
    }
    try {
      const result = await sendAgentHostTurnControl({
        home: this.home,
        scope: "task",
        taskId: ref.hostId,
        roleName: ref.roleName,
        control: {
          protocol: AGENT_HOST_CONTROL_PROTOCOL,
          type: "submit-turn",
          launchId: request.binding.launchId,
          nativeSessionId: request.binding.nativeSessionId,
          turnId: request.envelope.source.localId,
          authority: request.binding.providerAuthority,
          turn: {
            attemptId: request.envelope.id,
            boundedText: request.envelope.text
          }
        }
      });
      if (result.snapshot.state === "delivery-unknown") return "delivery-unknown";
      if (result.snapshot.state === "busy") return "busy";
      if (result.outcome === "rejected") return "rejected";
      if (result.snapshot.attemptId !== request.envelope.id) {
        return result.snapshot.state === "starting" || result.snapshot.state === "settling"
          ? "busy"
          : "unavailable";
      }
      if (result.snapshot.state === "ready") return "delivered";
      return result.snapshot.state === "starting" || result.snapshot.state === "settling"
        ? "busy"
        : "unavailable";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ECONNREFUSED"
        ? "unavailable"
        : "delivery-unknown";
    }
  }

  async trySteer(request: ActivePromptSteerRequest): Promise<PromptPushResult> {
    try {
      const result = await sendAgentHostSteerControl({
        home: this.home,
        scope: "task",
        taskId: request.owner.taskId,
        roleName: request.owner.roleName,
        control: {
          protocol: AGENT_HOST_CONTROL_PROTOCOL,
          type: "steer-turn",
          launchId: request.launchId,
          nativeSessionId: request.nativeSessionId,
          nativeTurnId: request.nativeTurnId,
          authority: request.providerAuthority,
          turn: {
            attemptId: request.envelope.id,
            boundedText: request.envelope.text
          }
        }
      });
      if (result.outcome === "accepted") return "delivered";
      if (result.snapshot.state === "delivery-unknown") return "delivery-unknown";
      if (result.snapshot.state === "busy") return "busy";
      return result.outcome === "rejected" ? "rejected" : "unavailable";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ECONNREFUSED"
        ? "unavailable"
        : "delivery-unknown";
    }
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

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
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
