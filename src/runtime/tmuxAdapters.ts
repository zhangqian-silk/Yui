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
  RuntimeHostUnavailableError,
  promptPushOutcome,
  type ActivePromptPushPort,
  type ActivePromptPushRequest,
  type ActivePromptSteerRequest,
  type PromptPushOutcome,
  type RuntimeLaunchPreStart,
  type SessionHostPort,
  type SessionInspection
} from "./ports.js";
import {
  providerDeliveryFailureFrom,
  type AgentErrorPhase,
  type ProviderDeliveryFailure
} from "./agentError.js";
import {
  toRuntimeLaunchFailure,
  type RuntimeLaunchDiagnosticContext
} from "./launchDiagnostics.js";
import { requireSafeIdentity } from "./validation.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { TaskRuntimeIsolationDescriptor } from "./taskRuntimeIsolation.js";
import { launchBrokerForHome, type AgentHostLaunchPayload } from "./launchBroker.js";
import {
  AGENT_HOST_CONTROL_PROTOCOL,
  sendAgentHostLaunchControl,
  sendAgentHostRunControl,
  sendAgentHostSteerControl,
  waitForAgentHostLaunchAck,
  type AgentHostControlResult,
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
  interactiveCodexThread?: AgentHostLaunchPayload["interactiveCodexThread"];
  childLifecycle?: AgentHostLaunchPayload["childLifecycle"];
  executionEnvironment?: AgentHostLaunchPayload["executionEnvironment"];
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
    runId?: string;
    nativeSessionId?: string;
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
    environment?: Readonly<Record<string, string>>;
  }>): RuntimePlannedSession;
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
    const run = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => run);
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
    const input = {
      roleName: request.owner.roleName,
      agentId: request.agentId,
      adapterId: request.adapterId,
      effective: request.effective,
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
    const interactiveCodex = request.owner.scope === "global" && request.adapterId === "codex"
      && planned.launch.providerControl === undefined;
    let reuseInteractivePane = false;
    if (interactiveCodex) {
      let status: "running" | "exited";
      try {
        status = await probeRoleStatus(this.tmux, hostId, request.owner.roleName);
      } catch (error) {
        throw new RuntimeHostContentionError(
          "previous-process",
          `Global Role pane state is unknown; preserving it: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (status === "running") {
        if (request.mode === "new") {
          throw new RuntimeHostContentionError(
            "previous-process",
            "Global Role already has a live pane; stop or record its exact Session first."
          );
        }
        reuseInteractivePane = true;
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
      ...(request.runId === undefined ? {} : { runId: request.runId }),
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
    // Global Codex retains the native TUI inside a thin Host that acknowledges
    // its own App Server startup response. Existing live TUIs (including
    // 0.15.0 Sessions) remain directly attachable without replacing them.
    if (
      reuseInteractivePane
      || (!interactiveCodex && (
        yuiHome === undefined
        || childLifecycle === undefined
        || planned.launch.providerControl === undefined
      ))
    ) {
      if (request.owner.scope === "task" && request.runId !== undefined) {
        throw new Error("Managed Task AgentRun is missing its structured Agent Host contract.");
      }
      let hostCreated: boolean;
      try {
        hostCreated = await ensureRoleWindow(
          this.tmux, hostId, planned.role, reuseInteractivePane ? undefined : planned.launch
        );
      } catch (error) {
        throw toRuntimeLaunchFailure(error, "host-start", launchContext);
      }
      if (reuseInteractivePane && hostCreated) {
        throw new Error("Global Role pane changed during attachment.");
      }
      let binding = createRuntimeBinding({
        id: bindingId,
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
          && request.runId !== undefined
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
    if (yuiHome === undefined || childLifecycle === undefined) {
      throw new Error("Agent Host launch is missing its Home or child lifecycle.");
    }
    const broker = launchBrokerForHome(yuiHome);
    const sessionManifest = planned.launch.env.YUI_SESSION_MANIFEST;
    if (request.owner.scope === "task" && request.runId !== undefined
      && sessionManifest === undefined) {
      throw new Error(
        "Managed Task Agent Host launch is missing its Session Manifest."
      );
    }
    const reservation = broker.reserve(Object.freeze({
      schemaVersion: 2,
      ...(request.runId === undefined ? {} : { startupRunId: request.runId }),
      command: planned.launch.command,
      args: [...planned.launch.args],
      environment: { ...planned.launch.env },
      cwd: planned.role.cwd ?? planned.role.workspace,
      ...(planned.launch.executionEnvironment === undefined ? {} : {
        executionEnvironment: structuredClone(planned.launch.executionEnvironment)
      }),
      childLifecycle,
      startMode: planned.launch.deferProviderStart === true ? "idle" : "provider",
      ...(planned.launch.providerControl === undefined
        ? {}
        : { providerControl: planned.launch.providerControl }),
      ...(planned.launch.interactiveCodexThread === undefined
        ? {}
        : { interactiveCodexThread: planned.launch.interactiveCodexThread })
    }));
    const hostLaunch = {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../cli.js", import.meta.url)),
        "internal",
        "agent-host",
        reservation.ticket
      ],
      env: {
        YUI_HOME: resolve(yuiHome),
        YUI_SESSION_SCOPE: request.owner.scope,
        ...(request.owner.scope === "task" ? { YUI_TASK_ID: request.owner.taskId } : {}),
        YUI_ROLE: request.owner.roleName,
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
          : { YUI_SESSION_MANIFEST: sessionManifest })
      }
    };
    let hostCreated = false;
    let providerSnapshot: AgentHostSnapshot | undefined;
    try {
      hostCreated = await ensureRoleWindow(this.tmux, hostId, planned.role, hostLaunch);
      if (hostCreated && planned.launch.deferProviderStart !== true) {
        const assertInteractivePane = async (): Promise<void> => {
          const pane = await inspectRolePane(this.tmux, hostId, request.owner.roleName);
          if (pane === undefined) throw new Error("Global Codex startup has no observable pane state.");
          if (pane.dead) {
            await deadHostLaunchFailure(this.tmux, hostId, request.owner.roleName, pane, launchContext);
          }
        };
        providerSnapshot = await waitForAgentHostLaunchAck({
          home: yuiHome,
          scope: request.owner.scope,
          ...(request.owner.scope === "task" ? { taskId: request.owner.taskId } : {}),
          roleName: request.owner.roleName,
          requireRunAck: false,
          ...(interactiveCodex ? { assertHostRunning: assertInteractivePane } : {})
        });
        if (interactiveCodex) {
          if (providerSnapshot.nativeSessionId === undefined) {
            throw new Error("Global Codex startup acknowledgement has no Thread identity.");
          }
          requireSafeIdentity(providerSnapshot.nativeSessionId, "Codex Thread identity");
          await assertInteractivePane();
        }
      }
      if (!hostCreated) {
        if (interactiveCodex) {
          throw new RuntimeHostContentionError(
            "previous-process",
            "Global Role pane appeared during launch; preserving its existing Session."
          );
        }
        const controlResult = await sendAgentHostLaunchControl({
          home: yuiHome,
          scope: request.owner.scope,
          ...(request.owner.scope === "task" ? { taskId: request.owner.taskId } : {}),
          roleName: request.owner.roleName,
          control: {
            protocol: AGENT_HOST_CONTROL_PROTOCOL,
            type: "launch",
            ticket: reservation.ticket
          }
        });
        if (controlResult.outcome === "busy") {
          broker.revoke(reservation.ticket);
          throw new RuntimeHostContentionError(
            "provider-child-active",
            `The persistent Agent Host for ${request.owner.roleName} still owns another Provider Turn.`
          );
        }
        if (!["idle", "ready", "busy"].includes(controlResult.snapshot.state)) {
          broker.revoke(reservation.ticket);
          if (["starting", "settling", "delivery-unknown"].includes(
            controlResult.snapshot.state
          )) {
            // A temporarily unavailable Session preserves the pending input.
            throw new RuntimeHostContentionError(
              "provider-child-active",
              `The Agent Host for ${request.owner.roleName} is still ${
                controlResult.snapshot.state
              }${describeHostFailure(controlResult)}.`
            );
          }
          // This launch is unusable. It did not create this Host, so failure
          // is not authority to clean its resources or unknown execution.
          throw new RuntimeHostUnavailableError(
            controlResult.snapshot.state,
            `Agent Host reached ${controlResult.snapshot.state}${describeHostFailure(controlResult)}.`,
            { cause: controlResult.failure ?? controlResult.snapshot }
          );
        }
        providerSnapshot = controlResult.snapshot;
      }
    } catch (error) {
      broker.revoke(reservation.ticket);
      throw error;
    }
    const binding = createRuntimeBinding({
      id: bindingId,
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
      // Missing discovery is not evidence that the running process is unwanted.
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

/**
 * Appends the Host's own cause to a launch diagnostic. Without this the
 * caller only learns the state name and the real reason stays trapped in the
 * Host process.
 */
function describeHostFailure(result: AgentHostControlResult): string {
  const detail = result.failure?.detail ?? result.snapshot.detail;
  return detail === undefined ? "" : `; detail=${detail}`;
}

/** Structured managed-AgentRun input; tmux remains presentation/liveness only. */
export class AgentHostPromptPushAdapter implements ActivePromptPushPort {
  constructor(private readonly home: string) {}

  async tryPush(request: ActivePromptPushRequest): Promise<PromptPushOutcome> {
    const ref = requireMatchingHostRef(request.binding);
    if (ref.scope !== "task" || request.binding.nativeSessionId === undefined
      || request.binding.providerAuthority === undefined
      || request.binding.providerAuthority.owner !== "controller") {
      return promptPushOutcome("unavailable");
    }
    try {
      const result = await sendAgentHostRunControl({
        home: this.home,
        scope: "task",
        taskId: ref.hostId,
        roleName: ref.roleName,
        control: {
          protocol: AGENT_HOST_CONTROL_PROTOCOL,
          type: "submit-turn",
          nativeSessionId: request.binding.nativeSessionId,
          ...(request.envelope.source.kind === "notification"
            ? {} : { runId: request.envelope.source.localId }),
          authority: request.binding.providerAuthority,
          run: {
            attemptId: request.envelope.id,
            boundedText: request.envelope.text
          }
        }
      });
      // The Host attaches its own structured cause to every non-delivery.
      const failure = result.failure;
      if (result.outcome === "pending") return promptPushOutcome("pending");
      if (result.snapshot.state === "delivery-unknown") {
        return promptPushOutcome("delivery-unknown", failure);
      }
      if (result.snapshot.state === "busy") return promptPushOutcome("busy", failure);
      if (result.outcome === "rejected") return promptPushOutcome("rejected", failure);
      if (result.snapshot.attemptId !== request.envelope.id) {
        return result.snapshot.state === "starting" || result.snapshot.state === "settling"
          ? promptPushOutcome("busy", failure)
          : promptPushOutcome("unavailable", failure);
      }
      if (result.snapshot.state === "ready") return promptPushOutcome(
        result.snapshot.inputAcceptance === "provider" ? "delivered" : "pending");
      return result.snapshot.state === "starting" || result.snapshot.state === "settling"
        ? promptPushOutcome("busy", failure)
        : promptPushOutcome("unavailable", failure);
    } catch (error) {
      return transportFailureOutcome(error, "turn-submit", request.envelope.id);
    }
  }

  async trySteer(request: ActivePromptSteerRequest): Promise<PromptPushOutcome> {
    try {
      const result = await sendAgentHostSteerControl({
        home: this.home,
        scope: request.owner.scope,
        ...(request.owner.scope === "task" ? { taskId: request.owner.taskId } : {}),
        roleName: request.owner.roleName,
        control: {
          protocol: AGENT_HOST_CONTROL_PROTOCOL,
          type: "steer-turn",
          nativeSessionId: request.nativeSessionId,
          nativeTurnId: request.nativeTurnId,
          authority: request.providerAuthority,
          run: {
            attemptId: request.envelope.id,
            boundedText: request.envelope.text
          }
        }
      });
      if (result.outcome === "pending") return promptPushOutcome("pending");
      if (result.outcome === "accepted") return promptPushOutcome("delivered");
      const failure = result.failure;
      if (failure?.inputDisposition === "unknown" || result.snapshot.state === "delivery-unknown") {
        return promptPushOutcome("delivery-unknown", failure);
      }
      if (result.snapshot.state === "busy") return promptPushOutcome("busy", failure);
      return result.outcome === "rejected"
        ? promptPushOutcome("rejected", failure)
        : promptPushOutcome("unavailable", failure);
    } catch (error) {
      return transportFailureOutcome(error, "turn-submit", request.envelope.id);
    }
  }
}

/**
 * A transport failure decides the input disposition. A refused or absent
 * socket proves the Host never received the request; anything else leaves
 * delivery genuinely ambiguous and must not be replayed automatically.
 */
function transportFailureOutcome(
  error: unknown,
  phase: AgentErrorPhase,
  attemptId: string
): PromptPushOutcome {
  const code = (error as NodeJS.ErrnoException).code;
  const unreachable = code === "ENOENT" || code === "ECONNREFUSED";
  return promptPushOutcome(
    unreachable ? "unavailable" : "delivery-unknown",
    providerDeliveryFailureFrom(error, {
      phase,
      attemptId,
      inputDisposition: unreachable ? "not-accepted" : "unknown"
    })
  );
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
