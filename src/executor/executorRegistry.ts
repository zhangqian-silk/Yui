import { createHash } from "node:crypto";
import type {
  PreparedRoleDelivery,
  ReadyRoleDelivery,
  RoleSessionLaunchMode,
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
  type RuntimeLaunchPreparationPort,
  type SessionHostPort
} from "../runtime/index.js";
import type { EffectiveLaunchSnapshot } from "./effectiveLaunch.js";

export type PlannedRoleSession = Readonly<{
  role: TmuxRole;
  launch: TmuxLaunchPlan;
  session: SchedulerRoleSession | null;
  /** Exact Run whose first prompt is carried by the provider launch argv. */
  initialPromptRunId?: string;
}>;

export interface RoleLaunchPlanner {
  plan(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    effective?: EffectiveLaunchSnapshot;
    mode: RoleSessionLaunchMode;
    runId?: string;
    nativeSessionId?: string;
  }>): PlannedRoleSession;
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
}>;

type PreparedRuntime = Readonly<{
  delivery: PreparedRoleDelivery;
  session: SchedulerRoleSession | null;
  planned?: PlannedRoleSession;
  binding?: RuntimeBinding;
}>;

/**
 * Scheduler-to-tmux adapter. It retains only in-process prepared launch data;
 * durable session identity remains owned by FileTaskStore.
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
    mode: RoleSessionLaunchMode;
    runId?: string;
    nativeSessionId?: string;
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
      ...(input.runId === undefined ? {} : { runId: input.runId })
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
      session = planned.session;
    } else {
      const common = {
        owner: { scope: "task", taskId: input.taskId, roleName: input.roleName },
        agentId: input.agentId,
        adapterId: input.adapterId,
        effective: input.effective,
        workspace: input.workspace,
        ...(input.runId === undefined ? {} : { runId: input.runId })
      } as const;
      if (this.runtimePorts.launchCoordinator !== undefined) {
        binding = await this.runtimePorts.launchCoordinator.prepare(
          input.mode === "new"
            ? { ...common, mode: "new" }
            : {
                ...common,
                mode: "resume",
                nativeSessionId: input.nativeSessionId!
              },
          "deferred"
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
          ? await this.runtimePorts.sessionHost.start(request)
          : await this.runtimePorts.sessionHost.resume(request);
      }
      sessionStarted = binding.hostCreated === true;
      session = binding.nativeSessionId === undefined
        ? null
        : {
            agentId: binding.agentId,
            adapterId: binding.adapterId,
            nativeSessionId: binding.nativeSessionId,
            status: "ready",
            effective: input.effective
          };
    }
    const delivery: PreparedRoleDelivery = {
      ...deliveryBase,
      ...(binding === undefined ? {} : { launchId: binding.launchId }),
      sessionStarted,
      ...(
        sessionStarted
        && input.runId !== undefined
        && (planned?.initialPromptRunId ?? binding?.initialPromptRunId) === input.runId
          ? { inputSubmittedAtLaunch: true }
          : {}
      )
    };
    this.#prepared.set(delivery.deliveryId, {
      delivery,
      session,
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
  }>): Promise<"sent" | "already-sent" | "busy" | "unavailable"> {
    const prepared = this.requirePrepared(input.delivery.prepared);
    if (input.delivery.prepared.inputSubmittedAtLaunch === true) {
      this.#prepared.delete(input.delivery.prepared.deliveryId);
      return "sent";
    }
    if (prepared.binding !== undefined && this.runtimePorts !== undefined) {
      const runId = input.delivery.prepared.runId;
      if (runId === undefined) {
        throw new Error("Runtime prompt delivery requires a Task-local Run id.");
      }
      const outcome = await this.runtimePorts.promptPush.tryPush({
        binding: prepared.binding,
        envelope: createPromptEnvelope({
          id: input.receiptId,
          source: {
            kind: "agent-run",
            taskId: input.delivery.prepared.taskId,
            localId: runId
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
    runId?: string;
    launchId?: string;
  }>): void {
    for (const [deliveryId, prepared] of this.#prepared) {
      const delivery = prepared.delivery;
      if (
        delivery.taskId !== input.taskId
        || delivery.roleName !== input.roleName
        || (
          input.runId !== undefined
          && delivery.runId !== input.runId
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
  }>[]): Promise<readonly Readonly<{
    taskId: string;
    roleName: string;
    status: "present" | "absent";
  }>[]> {
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
    const present = new Set(
      inventory
        .filter((pane) => !pane.dead)
        .map((pane) => `${pane.taskId}\0${pane.roleName}`)
    );
    return inputs.map((input) => ({
      taskId: input.taskId,
      roleName: input.roleName,
      status: present.has(`${input.taskId}\0${input.roleName}`)
        ? "present"
        : "absent"
    }));
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

export function agentProcessReadinessProbe(
  adapterId: string,
  _surface: "role" | "operator" = "role"
): TmuxReadinessProbe {
  if (adapterId !== "codex" && adapterId !== "claude") {
    throw new Error(`No tmux readiness probe is registered for Agent adapter: ${adapterId}.`);
  }
  // Run state and receipt fences decide whether delivery is allowed. Provider
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
  runId?: string;
  nativeSessionId?: string;
}>): string {
  return createHash("sha256").update(JSON.stringify([
    input.taskId,
    input.roleName,
    input.agentId,
    input.adapterId,
    input.effective,
    input.mode,
    input.runId ?? null,
    input.nativeSessionId ?? null
  ])).digest("hex");
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
