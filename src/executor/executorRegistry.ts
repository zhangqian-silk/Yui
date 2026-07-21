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
  TmuxRole
} from "../tmux/tmuxManager.js";

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
  stopTask(taskId: string): boolean;
}>;

export type AgentReadinessResolver = (adapterId: string) => TmuxReadinessProbe;

/**
 * Scheduler-to-tmux adapter. It retains only in-process prepared launch data;
 * durable session identity remains owned by FileTaskStore.
 */
export class ExecutorRegistry implements TmuxDeliveryPort {
  readonly #prepared = new Map<string, PlannedRoleSession>();

  constructor(
    private readonly planner: RoleLaunchPlanner,
    private readonly tmux: ExecutorTmuxPort,
    private readonly readiness: AgentReadinessResolver = agentComposerReadinessProbe
  ) {}

  async prepareRoleSession(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    mode: RoleSessionLaunchMode;
    nativeSessionId?: string;
  }>): Promise<PreparedRoleDelivery> {
    if (input.mode === "resume" && !hasText(input.nativeSessionId)) {
      throw new Error("Role session resume requires a native session id.");
    }
    const planned = this.planner.plan(input);
    this.tmux.ensureRoleWindow(input.taskId, planned.role, planned.launch);
    const delivery: PreparedRoleDelivery = {
      deliveryId: preparedDeliveryId(input),
      taskId: input.taskId,
      roleName: input.roleName,
      agentId: input.agentId,
      adapterId: input.adapterId,
      mode: input.mode
    };
    this.#prepared.set(delivery.deliveryId, planned);
    return delivery;
  }

  async waitUntilReady(delivery: PreparedRoleDelivery): Promise<ReadyRoleDelivery> {
    const planned = this.requirePrepared(delivery);
    this.tmux.waitUntilReady(
      delivery.taskId,
      delivery.roleName,
      this.readiness(delivery.adapterId)
    );
    return { prepared: delivery, session: planned.session };
  }

  async sendOnce(input: Readonly<{
    delivery: ReadyRoleDelivery;
    receiptId: string;
    text: string;
  }>): Promise<"sent" | "already-sent"> {
    this.requirePrepared(input.delivery.prepared);
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

  async findExistingReceipt(input: Readonly<{
    delivery: PreparedRoleDelivery;
    receiptId: string;
  }>): Promise<ReadyRoleDelivery | null> {
    const planned = this.requirePrepared(input.delivery);
    return this.tmux.hasDeliveryReceipt(
      input.delivery.taskId,
      input.delivery.roleName,
      input.receiptId
    ) ? { prepared: input.delivery, session: planned.session } : null;
  }

  async stopTask(taskId: string): Promise<boolean> {
    return this.tmux.stopTask(taskId);
  }

  private requirePrepared(delivery: PreparedRoleDelivery): PlannedRoleSession {
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
        return livePane(pane)
          && !/Press enter to continue|select.*update|update selector/i.test(content)
          && content.includes("OpenAI Codex")
          && content.includes("/model to change")
          && /(?:^|\n)\s*›\s*(?:$|\S)/u.test(content);
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
