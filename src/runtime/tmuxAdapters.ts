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
import type {
  ActivePromptPushPort,
  ActivePromptPushRequest,
  PromptPushResult,
  SessionHostPort,
  SessionInspection
} from "./ports.js";
import { requireSafeIdentity } from "./validation.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";

export type RuntimeTmuxRole = Readonly<{
  name: string;
  workspace: string;
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
}

/** The lifecycle subset required from TmuxManager. */
export interface RuntimeTmuxHostPort {
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
}>;

/**
 * Runtime lifecycle adapter for the current tmux host. The returned hostRef is
 * opaque to the domain and self-contained for a later inspect/stop operation.
 */
export class TmuxSessionHost implements SessionHostPort {
  readonly #globalHostId: string;
  readonly #createBindingId: () => string;
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
  }

  async start(request: NewSessionLaunchRequest): Promise<RuntimeBinding> {
    return this.#launch(request);
  }

  async resume(request: ResumeSessionLaunchRequest): Promise<RuntimeBinding> {
    return this.#launch(request);
  }

  async stop(binding: RuntimeBinding): Promise<void> {
    const ref = requireMatchingHostRef(binding);
    if (await probeRoleStatus(this.tmux, ref.hostId, ref.roleName) === "running") {
      await killRole(this.tmux, ref.hostId, ref.roleName);
    }
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
      if (
        await probeRoleStatus(this.tmux, hostId, normalized.roleName)
        === "running"
      ) {
        await killRole(this.tmux, hostId, normalized.roleName);
      }
      return await probeRoleStatus(this.tmux, hostId, normalized.roleName)
        === "exited";
    } catch {
      return false;
    }
  }

  async #launch(request: SessionLaunchRequest): Promise<RuntimeBinding> {
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
      return await this.#launchUnlocked(request, hostId);
    } finally {
      release();
      if (this.#launchTails.get(key) === tail) this.#launchTails.delete(key);
    }
  }

  async #launchUnlocked(
    request: SessionLaunchRequest,
    hostId: string
  ): Promise<RuntimeBinding> {
    // Validate generated identity before starting an external process.
    const bindingId = requireSafeIdentity(this.#createBindingId(), "Runtime binding id");
    const input = {
      roleName: request.owner.roleName,
      agentId: request.agentId,
      adapterId: request.adapterId,
      effective: request.effective,
      launchId: request.launchId,
      mode: request.mode,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment }),
      ...(request.mode === "resume" ? { nativeSessionId: request.nativeSessionId } : {})
    };
    const planned = request.owner.scope === "task"
      ? this.planner.plan({ taskId: request.owner.taskId, ...input })
      : this.planner.planGlobalRole(input);
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
    // Process creation is last: every local invariant has already passed.
    const hostCreated = await ensureRoleWindow(
      this.tmux,
      hostId,
      planned.role,
      planned.launch
    );
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
      hostCreated,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId })
    });
  }
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
