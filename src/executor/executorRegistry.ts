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
  type SessionHostPort
} from "../runtime/index.js";

export type PlannedRoleSession = Readonly<{
  role: TmuxRole;
  launch: TmuxLaunchPlan;
  session: SchedulerRoleSession | null;
}>;

export interface RoleLaunchPlanner {
  plan(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    mode: RoleSessionLaunchMode;
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
  ): TmuxDeliveryOutcome | "not-ready";
  hasDeliveryReceipt(taskId: string, roleName: string, receiptId: string): boolean;
  probeRoleStatus(taskId: string, roleName: string): "running" | "exited";
  inspectRolePaneInventory?(): TmuxRolePaneState[];
  stopTask(taskId: string): boolean;
}>;

export type AgentReadinessResolver = (adapterId: string) => TmuxReadinessProbe;

export type ExecutorRuntimePorts = Readonly<{
  sessionHost: SessionHostPort;
  promptPush: ActivePromptPushPort;
}>;

type PreparedRuntime = Readonly<{
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
    private readonly readiness: AgentReadinessResolver = agentComposerReadinessProbe,
    private readonly runtimePorts?: ExecutorRuntimePorts
  ) {}

  async prepareRoleSession(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    workspace: string;
    mode: RoleSessionLaunchMode;
    nativeSessionId?: string;
  }>): Promise<PreparedRoleDelivery> {
    if (input.mode === "resume" && !hasText(input.nativeSessionId)) {
      throw new Error("Role session resume requires a native session id.");
    }
    const delivery: PreparedRoleDelivery = {
      deliveryId: preparedDeliveryId(input),
      taskId: input.taskId,
      roleName: input.roleName,
      agentId: input.agentId,
      adapterId: input.adapterId,
      mode: input.mode
    };
    let binding: RuntimeBinding | undefined;
    let planned: PlannedRoleSession | undefined;
    let session: SchedulerRoleSession | null;
    if (this.runtimePorts === undefined) {
      planned = this.planner.plan(input);
      this.tmux.ensureRoleWindow(input.taskId, planned.role, planned.launch);
      session = planned.session;
    } else {
      const common = {
        launchId: delivery.deliveryId,
        owner: { scope: "task", taskId: input.taskId, roleName: input.roleName },
        agentId: input.agentId,
        adapterId: input.adapterId,
        workspace: input.workspace
      } as const;
      const request = input.mode === "new"
        ? createSessionLaunchRequest({ ...common, mode: "new" })
        : createSessionLaunchRequest({
            ...common,
            mode: "resume",
            nativeSessionId: input.nativeSessionId!
          });
      binding = request.mode === "new"
        ? await this.runtimePorts.sessionHost.start(request)
        : await this.runtimePorts.sessionHost.resume(request);
      session = binding.nativeSessionId === undefined
        ? null
        : {
            agentId: binding.agentId,
            adapterId: binding.adapterId,
            nativeSessionId: binding.nativeSessionId,
            status: "ready"
          };
    }
    this.#prepared.set(delivery.deliveryId, {
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
    if (prepared.binding !== undefined && this.runtimePorts !== undefined) {
      const outcome = await this.runtimePorts.promptPush.tryPush({
        binding: prepared.binding,
        envelope: createPromptEnvelope({
          id: input.receiptId,
          source: { kind: "agent-run", id: input.receiptId },
          text: input.text,
          createdAt: new Date()
        })
      });
      return outcome === "delivered" ? "sent" : outcome;
    }
    return this.tmux.sendRoleInputOnce(
      input.delivery.prepared.taskId,
      input.delivery.prepared.roleName,
      input.receiptId,
      input.text,
      this.readiness(input.delivery.prepared.adapterId)
    );
  }

  async notifyOperatorInputOnce(input: Readonly<{
    roleName: "operator";
    adapterId: string;
    receiptId: string;
    text: string;
  }>): Promise<"sent" | "already-sent" | "unavailable" | "not-ready"> {
    if (this.tmux.probeRoleStatus("operator", input.roleName) !== "running") {
      return "unavailable";
    }
    return this.tmux.sendRoleInputOnceIfReady(
      "operator",
      input.roleName,
      input.receiptId,
      input.text,
      this.readiness(input.adapterId)
    );
  }

  async inspectRole(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"present" | "absent"> {
    return this.tmux.probeRoleStatus(input.taskId, input.roleName) === "running"
      ? "present"
      : "absent";
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
    if (this.tmux.inspectRolePaneInventory === undefined) {
      return Promise.all(inputs.map(async (input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: await this.inspectRole(input)
      })));
    }
    const present = new Set(
      this.tmux.inspectRolePaneInventory()
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

  async findExistingReceipt(input: Readonly<{
    delivery: PreparedRoleDelivery;
    receiptId: string;
  }>): Promise<ReadyRoleDelivery | null> {
    const prepared = this.requirePrepared(input.delivery);
    if (prepared.binding !== undefined) return null;
    return this.tmux.hasDeliveryReceipt(
      input.delivery.taskId,
      input.delivery.roleName,
      input.receiptId
    ) ? { prepared: input.delivery, session: prepared.session } : null;
  }

  async stopTask(taskId: string): Promise<boolean> {
    return this.tmux.stopTask(taskId);
  }

  private requirePrepared(delivery: PreparedRoleDelivery): PreparedRuntime {
    const planned = this.#prepared.get(delivery.deliveryId);
    if (planned === undefined) {
      throw new Error(`Role delivery is not prepared: ${delivery.deliveryId}.`);
    }
    return planned;
  }
}

export function agentComposerReadinessProbe(adapterId: string): TmuxReadinessProbe {
  switch (adapterId) {
    case "codex":
      return (pane) => {
        const content = pane.content.replace(/\r/g, "");
        const nonEmptyLines = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const reverseComposerIndex = [...nonEmptyLines]
          .reverse()
          .findIndex((line) => line.startsWith("›"));
        const composerIndex = reverseComposerIndex < 0
          ? -1
          : nonEmptyLines.length - reverseComposerIndex - 1;
        const legacyComposer = content.includes("OpenAI Codex")
          && content.includes("/model to change")
          && composerIndex === nonEmptyLines.length - 1;
        const currentComposer = nonEmptyLines[nonEmptyLines.length - 1]?.includes(" · ") === true
          && composerIndex >= Math.max(0, nonEmptyLines.length - 12)
          && composerIndex < nonEmptyLines.length - 1;
        return livePane(pane)
          && !/Press enter to continue|select.*update|update selector/i.test(content)
          && (legacyComposer || currentComposer);
      };
    case "claude":
      return (pane) => livePane(pane)
        && /(?:^|\n)\s*❯\s*(?:$|\S)/u.test(pane.content.replace(/\r/g, ""));
    default:
      throw new Error(`No tmux readiness probe is registered for Agent adapter: ${adapterId}.`);
  }
}

function livePane(pane: TmuxPaneState): boolean {
  return !pane.dead && pane.pid !== undefined && pane.currentCommand.trim().length > 0;
}

function preparedDeliveryId(input: Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  mode: RoleSessionLaunchMode;
  nativeSessionId?: string;
}>): string {
  return createHash("sha256").update(JSON.stringify([
    input.taskId,
    input.roleName,
    input.agentId,
    input.adapterId,
    input.mode,
    input.nativeSessionId ?? null
  ])).digest("hex");
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
