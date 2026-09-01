import { createHash } from "node:crypto";
import type {
  PreparedRoleDelivery,
  ReadyRoleDelivery,
  RoleSessionLaunchMode,
  SchedulerRoleResourceInput,
  SchedulerRoleResourceEntry,
  SchedulerRoleSession,
  TmuxDeliveryPort
} from "../scheduler/ports.js";
import type {
  TmuxDeliveryOutcome,
  TmuxLaunchPlan,
  TmuxPaneState,
  TmuxReadinessProbe,
  TmuxRole,
  TmuxRolePaneState
} from "../tmux/tmuxManager.js";
import {
  createPromptEnvelope,
  createSessionLaunchRequest,
  type ActivePromptPushPort,
  type RuntimeBinding,
  type RuntimeLaunchPreStart,
  type RuntimeLaunchPreparationPort,
  type SessionHostPort
} from "../runtime/index.js";
import type { EffectiveLaunchSnapshot } from "./effectiveLaunch.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import type {
  TaskRuntimeIsolationDescriptor,
  TaskRuntimeLaunchPolicy
} from "../runtime/taskRuntimeIsolation.js";
import { formatTurnReceiptId } from "../task/taskRecordReference.js";

export type PlannedRoleSession = Readonly<{
  role: TmuxRole;
  launch: TmuxLaunchPlan;
  session: SchedulerRoleSession | null;
  sessionTitle?: string;
}>;

export interface RoleLaunchPlanner {
  plan(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    effective?: EffectiveLaunchSnapshot;
    mode: RoleSessionLaunchMode;
    turnId?: string;
    nativeSessionId?: string;
    runtimeIsolation?: TaskRuntimeIsolationDescriptor;
  }>): PlannedRoleSession;
  /** Atomically advances every stable exact-runtime source for a reused Task Session. */
  refreshTaskRuntimeDescriptor?(input: Readonly<{
    taskId: string;
    roleName: string;
    turnId?: string;
    launchId: string;
    nativeSessionId: string;
    agentId: string;
    adapterId: string;
    workspace: string;
  }>): void;
  /** Persist a task caller key only after its Provider process was created. */
  commitTaskCallerKey?(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    callerKey: string;
  }>): void;
}

export type ExecutorTmuxPort = Readonly<{
  ensureRoleWindow(taskId: string, role: TmuxRole, launch?: TmuxLaunchPlan): boolean;
  waitUntilReady(
    taskId: string,
    roleName: string,
    readinessProbe: TmuxReadinessProbe
  ): TmuxPaneState;
  sendRoleInputOnce(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: TmuxReadinessProbe
  ): TmuxDeliveryOutcome;
  sendRoleInputOnceIfReady(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: TmuxReadinessProbe
  ): TmuxDeliveryOutcome | "not-ready" | "unavailable";
  sendRoleInputOnceIfReadyAsync?(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: TmuxReadinessProbe
  ): Promise<TmuxDeliveryOutcome | "not-ready" | "unavailable">;
  probeRoleStatus(taskId: string, roleName: string): "running" | "exited";
  probeRoleStatusAsync?(
    taskId: string,
    roleName: string
  ): Promise<"running" | "exited">;
  killRole(taskId: string, roleName: string): void;
  killRoleAsync?(taskId: string, roleName: string): Promise<void>;
  inspectRolePaneInventory?(): TmuxRolePaneState[];
  inspectRolePaneInventoryAsync?(): Promise<TmuxRolePaneState[]>;
  inspectPane?(taskId: string, roleName: string): TmuxPaneState;
  inspectPaneAsync?(taskId: string, roleName: string): Promise<TmuxPaneState>;
}>;

export type AgentReadinessResolver = (
  adapterId: string,
  surface?: "role" | "operator"
) => TmuxReadinessProbe;

export type ExecutorRuntimePorts = Readonly<{
  sessionHost: SessionHostPort;
  promptPush: ActivePromptPushPort;
  launchCoordinator?: RuntimeLaunchPreparationPort;
  /** One advisory resource sample produced alongside the full Role inventory. */
  roleResourceInventory?: (
    panes: readonly TmuxRolePaneState[],
    inputs: readonly SchedulerRoleResourceInput[]
  ) => Promise<readonly SchedulerRoleResourceEntry[]>;
}>;

type PreparedRuntime = Readonly<{
  delivery: PreparedRoleDelivery;
  session: SchedulerRoleSession | null;
  workspace: string;
  planned?: PlannedRoleSession;
  binding?: RuntimeBinding;
}>;

/**
 * rr13/test: Test-only liveness seam. Integration tests that spawn a real
 * Controller subprocess cannot inject a fake TmuxDeliveryPort, and a saved
 * active Leader Turn would be reaped by the startup liveness pass without a
 * real tmux role. When this env var is "1", every role reads "present"
 * without probing tmux. The Controller subprocess inherits it from the
 * test's CLI env. Never set in production.
 */
const TEST_ROLE_LIVENESS_PRESENT = process.env.YUI_TEST_ROLE_LIVENESS_PRESENT === "1";

/**
 * Scheduler-to-tmux adapter. It retains only in-process prepared launch data;
 * durable session identity remains owned by TaskStore.
 */
export class ExecutorRegistry implements TmuxDeliveryPort {
  readonly #prepared = new Map<string, PreparedRuntime>();

  constructor(
    private readonly planner: RoleLaunchPlanner,
    private readonly tmux: ExecutorTmuxPort,
    private readonly readiness: AgentReadinessResolver = agentProcessReadinessProbe,
    private readonly runtimePorts?: ExecutorRuntimePorts
  ) {}

  async prepareRoleSession(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    effective: EffectiveLaunchSnapshot;
    workspace: string;
    managedWorkspace?: ManagedWorkspace;
    runtimePolicy?: TaskRuntimeLaunchPolicy;
    mode: RoleSessionLaunchMode;
    turnId?: string;
    nativeSessionId?: string;
    hostActivationId?: string;
    beforeHostStart?: RuntimeLaunchPreStart;
  }>): Promise<PreparedRoleDelivery> {
    if (input.mode === "resume" && !hasText(input.nativeSessionId)) {
      throw new Error("Role session resume requires a native session id.");
    }
    let sessionStarted = false;
    const deliveryBase = {
      deliveryId: preparedDeliveryId(input),
      taskId: input.taskId,
      roleName: input.roleName,
      agentId: input.agentId,
      adapterId: input.adapterId,
      mode: input.mode,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId })
    };
    const cached = this.#prepared.get(deliveryBase.deliveryId);
    if (cached !== undefined) return cached.delivery;
    let binding: RuntimeBinding | undefined;
    let planned: PlannedRoleSession | undefined;
    let session: SchedulerRoleSession | null;
    if (this.runtimePorts === undefined) {
      planned = this.planner.plan(input);
      sessionStarted = this.tmux.ensureRoleWindow(
        input.taskId,
        planned.role,
        planned.launch
      );
      if (
        sessionStarted
        && planned.launch.env.YUI_JOB_CALLER_KEY !== undefined
        && this.planner.commitTaskCallerKey !== undefined
      ) {
        this.planner.commitTaskCallerKey({
          taskId: input.taskId,
          roleName: input.roleName,
          agentId: input.agentId,
          callerKey: planned.launch.env.YUI_JOB_CALLER_KEY
        });
      }
      session = planned.session;
    } else {
      const common = {
        owner: { scope: "task", taskId: input.taskId, roleName: input.roleName },
        agentId: input.agentId,
        adapterId: input.adapterId,
        effective: input.effective,
        workspace: input.workspace,
        ...(input.managedWorkspace === undefined
          ? {}
          : { managedWorkspace: input.managedWorkspace }),
        ...(input.runtimePolicy === undefined
          ? {}
          : { runtimePolicy: input.runtimePolicy }),
        ...(input.turnId === undefined ? {} : { turnId: input.turnId })
      } as const;
      if (this.runtimePorts.launchCoordinator !== undefined) {
        binding = await this.runtimePorts.launchCoordinator.prepare(
          input.mode === "new"
            ? { ...common, mode: "new" }
            : {
                ...common,
                mode: "resume",
                nativeSessionId: input.nativeSessionId!,
                ...(input.hostActivationId === undefined
                  ? {}
                  : { hostActivationId: input.hostActivationId })
              },
          "deferred",
          undefined,
          input.beforeHostStart
        );
      } else {
        const request = input.mode === "new"
          ? createSessionLaunchRequest({
              ...common,
              launchId: deliveryBase.deliveryId,
              mode: "new"
            })
          : createSessionLaunchRequest({
              ...common,
              launchId: deliveryBase.deliveryId,
              mode: "resume",
              nativeSessionId: input.nativeSessionId!
            });
        binding = request.mode === "new"
          ? await this.runtimePorts.sessionHost.start(request, input.beforeHostStart)
          : await this.runtimePorts.sessionHost.restore(request, input.beforeHostStart);
      }
      sessionStarted = binding.hostCreated === true;
      session = binding.nativeSessionId === undefined
        ? null
        : {
            agentId: binding.agentId,
            adapterId: binding.adapterId,
            nativeSessionId: binding.nativeSessionId,
            status: "active",
            effective: input.effective
          };
    }
    const delivery: PreparedRoleDelivery = {
      ...deliveryBase,
      ...(binding === undefined ? {} : { launchId: binding.launchId }),
      sessionStarted,
      session,
    };
    this.#prepared.set(delivery.deliveryId, {
      delivery,
      session,
      workspace: input.workspace,
      ...(planned === undefined ? {} : { planned }),
      ...(binding === undefined ? {} : { binding })
    });
    return delivery;
  }

  async waitUntilReady(delivery: PreparedRoleDelivery): Promise<ReadyRoleDelivery> {
    const prepared = this.requirePrepared(delivery);
    if (prepared.binding === undefined) {
      this.tmux.waitUntilReady(
        delivery.taskId,
        delivery.roleName,
        this.readiness(delivery.adapterId)
      );
    }
    return { prepared: delivery, session: prepared.session };
  }

  async sendOnce(input: Readonly<{
    delivery: ReadyRoleDelivery;
    receiptId: string;
    text: string;
  }>): Promise<
    "sent" | "already-sent" | "busy" | "rejected" | "delivery-unknown" | "unavailable"
  > {
    const prepared = this.requirePrepared(input.delivery.prepared);
    if (prepared.binding !== undefined && this.runtimePorts !== undefined) {
      const turnId = input.delivery.prepared.turnId;
      if (turnId === undefined) {
        throw new Error("Runtime prompt delivery requires a Task-local Turn id.");
      }
      // A reused native process retains the stable descriptor path from its
      // original control plane. Publish only the current-control source after
      // the Turn/Session fence is durable and immediately before Provider input;
      // the reused Hook self-refreshes its own source before the volatile
      // fence instead of the Controller scanning history to keep it fresh.
      if (
        prepared.binding.hostCreated === false
        && this.planner.refreshTaskRuntimeDescriptor !== undefined
      ) {
        if (!hasText(prepared.binding.nativeSessionId)) {
          throw new Error("Runtime prompt delivery requires a native Session id.");
        }
        this.planner.refreshTaskRuntimeDescriptor({
          taskId: input.delivery.prepared.taskId,
          roleName: input.delivery.prepared.roleName,
          turnId,
          launchId: prepared.binding.launchId,
          nativeSessionId: prepared.binding.nativeSessionId,
          agentId: prepared.binding.agentId,
          adapterId: prepared.binding.adapterId,
          workspace: prepared.workspace
        });
      }
      const outcome = await this.runtimePorts.promptPush.tryPush({
        binding: prepared.binding,
        envelope: createPromptEnvelope({
          id: input.receiptId,
          source: {
            kind: input.receiptId === formatTurnReceiptId(
              input.delivery.prepared.taskId,
              turnId
            ) ? "turn" : "turn-input",
            taskId: input.delivery.prepared.taskId,
            localId: turnId
          },
          text: input.text,
          createdAt: new Date()
        })
      });
      if (outcome === "delivered") {
        this.#prepared.delete(input.delivery.prepared.deliveryId);
      }
      return outcome === "delivered" ? "sent" : outcome;
    }
    const outcome = this.tmux.sendRoleInputOnce(
      input.delivery.prepared.taskId,
      input.delivery.prepared.roleName,
      input.receiptId,
      input.text,
      this.readiness(input.delivery.prepared.adapterId)
    );
    if (outcome === "sent" || outcome === "already-sent") {
      this.#prepared.delete(input.delivery.prepared.deliveryId);
    }
    return outcome;
  }

  async steerOnce(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId: string;
    nativeSessionId: string;
    nativeTurnId: string;
    authority: import("../runtime/providerAuthorityFence.js").ProviderAuthorityFence;
    receiptId: string;
    text: string;
  }>): Promise<
    "sent" | "already-sent" | "busy" | "rejected" | "delivery-unknown" | "unavailable"
  > {
    if (this.runtimePorts === undefined) return "unavailable";
    const outcome = await this.runtimePorts.promptPush.trySteer({
      owner: { scope: "task", taskId: input.taskId, roleName: input.roleName },
      launchId: input.launchId,
      agentId: input.agentId,
      adapterId: input.adapterId,
      nativeSessionId: input.nativeSessionId,
      nativeTurnId: input.nativeTurnId,
      providerAuthority: input.authority,
      envelope: createPromptEnvelope({
        id: input.receiptId,
        source: { kind: "turn-input", taskId: input.taskId, localId: activeTurnId(input.receiptId) },
        text: input.text,
        createdAt: new Date()
      })
    });
    return outcome === "delivered" ? "sent" : outcome;
  }

  async notifyOperatorInputOnce(input: Readonly<{
    roleName: "operator";
    adapterId: string;
    receiptId: string;
    text: string;
  }>): Promise<"sent" | "already-sent" | "unavailable" | "not-ready"> {
    const probe = this.readiness(input.adapterId, "operator");
    return this.tmux.sendRoleInputOnceIfReadyAsync === undefined
      ? this.tmux.sendRoleInputOnceIfReady(
          "operator", input.roleName, input.receiptId, input.text, probe
        )
      : this.tmux.sendRoleInputOnceIfReadyAsync(
          "operator", input.roleName, input.receiptId, input.text, probe
        );
  }

  forgetPrepared(input: Readonly<{
    taskId: string;
    roleName: string;
    turnId?: string;
    launchId?: string;
  }>): void {
    for (const [deliveryId, prepared] of this.#prepared) {
      const delivery = prepared.delivery;
      if (
        delivery.taskId !== input.taskId
        || delivery.roleName !== input.roleName
        || (
          input.turnId !== undefined
          && delivery.turnId !== input.turnId
        )
        || (
          input.launchId !== undefined
          && delivery.launchId !== input.launchId
        )
      ) {
        continue;
      }
      this.#prepared.delete(deliveryId);
    }
  }

  async inspectRole(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"present" | "absent"> {
    if (TEST_ROLE_LIVENESS_PRESENT) return "present";
    const status = this.tmux.probeRoleStatusAsync === undefined
      ? this.tmux.probeRoleStatus(input.taskId, input.roleName)
      : await this.tmux.probeRoleStatusAsync(input.taskId, input.roleName);
    return status === "running"
      ? "present"
      : "absent";
  }

  async inspectRoleReadiness(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"ready" | "busy" | "absent"> {
    const status = await this.inspectRole(input);
    if (status === "absent") return "absent";
    try {
      const pane = this.tmux.inspectPaneAsync === undefined
        ? this.tmux.inspectPane?.(input.taskId, input.roleName)
        : await this.tmux.inspectPaneAsync(input.taskId, input.roleName);
      if (pane === undefined) return "busy";
      return this.readiness(input.adapterId)(pane) ? "ready" : "busy";
    } catch {
      // A pane can disappear between inventory and the targeted process snapshot; the
      // ordinary liveness pass will classify it on the next reconciliation.
      return "busy";
    }
  }

  async inspectRoles(inputs: readonly Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    turnId?: string;
    launchId?: string;
    progressAt?: string;
  }>[], resourceInputs?: readonly SchedulerRoleResourceInput[]): Promise<readonly Readonly<{
    taskId: string;
    roleName: string;
    status: "present" | "absent";
    resource?: SchedulerRoleResourceEntry["resource"];
    hostExit?: Readonly<{ deadStatus?: number }>;
  }>[]> {
    if (TEST_ROLE_LIVENESS_PRESENT) {
      return inputs.map((input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: "present" as const
      }));
    }
    if (
      this.tmux.inspectRolePaneInventory === undefined
      && this.tmux.inspectRolePaneInventoryAsync === undefined
    ) {
      return Promise.all(inputs.map(async (input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: await this.inspectRole(input)
      })));
    }
    const inventory = this.tmux.inspectRolePaneInventoryAsync === undefined
      ? this.tmux.inspectRolePaneInventory!()
      : await this.tmux.inspectRolePaneInventoryAsync();
    let resources = new Map<string, SchedulerRoleResourceEntry["resource"]>();
    const requested = resourceInputs ?? inputs.map((input) => ({
      taskId: input.taskId,
      roleName: input.roleName,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      agentId: input.agentId,
      adapterId: input.adapterId,
      ...(input.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: input.nativeSessionId }),
      ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
      ...(input.progressAt === undefined ? {} : { progressAt: input.progressAt })
    }));
    if (
      this.runtimePorts?.roleResourceInventory !== undefined
      && requested.length > 0
    ) {
      try {
        for (const entry of await this.runtimePorts.roleResourceInventory(inventory, requested)) {
          const key = `${entry.taskId}\0${entry.roleName}`;
          if (!resources.has(key)) resources.set(key, entry.resource);
        }
      } catch {
        // Resource evidence is advisory. A failed process snapshot must not
        // turn the authoritative pane inventory into an absent observation.
      }
    }
    const present = new Set(
      inventory
        .filter((pane) => !pane.dead)
        .map((pane) => `${pane.taskId}\0${pane.roleName}`)
    );
    return inputs.map((input) => {
      const key = `${input.taskId}\0${input.roleName}`;
      const resource = resources.get(key);
      const deadPane = inventory.find((pane) => (
        pane.taskId === input.taskId && pane.roleName === input.roleName && pane.dead
      ));
      return {
        taskId: input.taskId,
        roleName: input.roleName,
        status: present.has(key) ? "present" : "absent",
        ...(resource === undefined ? {} : { resource }),
        ...(deadPane === undefined
          ? {}
          : { hostExit: {
              ...(deadPane.deadStatus === undefined ? {} : { deadStatus: deadPane.deadStatus })
            } })
      };
    });
  }

  async stopRole(taskId: string, roleName: string): Promise<boolean> {
    const status = this.tmux.probeRoleStatusAsync === undefined
      ? this.tmux.probeRoleStatus(taskId, roleName)
      : await this.tmux.probeRoleStatusAsync(taskId, roleName);
    if (status !== "running") {
      this.forgetPrepared({ taskId, roleName });
      return false;
    }
    if (this.tmux.killRoleAsync === undefined) {
      this.tmux.killRole(taskId, roleName);
    } else {
      await this.tmux.killRoleAsync(taskId, roleName);
    }
    this.forgetPrepared({ taskId, roleName });
    return true;
  }

  private requirePrepared(delivery: PreparedRoleDelivery): PreparedRuntime {
    const planned = this.#prepared.get(delivery.deliveryId);
    if (planned === undefined) {
      throw new Error(`Role delivery is not prepared: ${delivery.deliveryId}.`);
    }
    return planned;
  }
}

function activeTurnId(receiptId: string): string {
  const match = /^turn-input:[^/]+\/([^/]+)\/[1-9]\d*$/u.exec(receiptId);
  if (match === null) throw new Error("Turn steer receipt is invalid.");
  return decodeURIComponent(match[1]!);
}

export function agentProcessReadinessProbe(
  adapterId: string,
  _surface: "role" | "operator" = "role"
): TmuxReadinessProbe {
  if (adapterId !== "codex" && adapterId !== "claude") {
    throw new Error(`No tmux readiness probe is registered for Agent adapter: ${adapterId}.`);
  }
  // Turn state and receipt fences decide whether delivery is allowed. Provider
  // terminal contents are display-only evidence and never lifecycle input.
  return livePane;
}

function livePane(pane: TmuxPaneState): boolean {
  return !pane.dead && pane.pid !== undefined && pane.currentCommand.trim().length > 0;
}

function preparedDeliveryId(input: Readonly<{
  taskId: string;
  roleName: string;
    agentId: string;
    adapterId: string;
    effective: EffectiveLaunchSnapshot;
    mode: RoleSessionLaunchMode;
  turnId?: string;
  nativeSessionId?: string;
  hostActivationId?: string;
}>): string {
  return createHash("sha256").update(JSON.stringify([
    input.taskId,
    input.roleName,
    input.agentId,
    input.adapterId,
    input.effective,
    input.mode,
    input.turnId ?? null,
    input.nativeSessionId ?? null,
    input.hostActivationId ?? null
  ])).digest("hex");
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
