import { randomUUID } from "node:crypto";

import { createRuntimeBinding, type RuntimeBinding } from "./runtimeBinding.js";
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
    mode: "new" | "resume";
    nativeSessionId?: string;
    launchId?: string;
  }>): RuntimePlannedSession;
  planGlobalRole(input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    mode: "new" | "resume";
    nativeSessionId?: string;
    launchId?: string;
  }>): RuntimePlannedSession;
}

/** The lifecycle subset required from TmuxManager. */
export interface RuntimeTmuxHostPort {
  ensureRoleWindow(
    hostId: string,
    role: RuntimeTmuxRole,
    launch?: RuntimeTmuxLaunchPlan
  ): boolean;
  probeRoleStatus(hostId: string, roleName: string): "running" | "exited";
  killRole(hostId: string, roleName: string): void;
}

export type RuntimeTmuxPaneState = Readonly<{
  taskId: string;
  roleName: string;
  target: string;
  dead: boolean;
  pid?: number;
  currentCommand: string;
  content: string;
}>;

export type RuntimeReadinessProbe = (pane: RuntimeTmuxPaneState) => boolean;
export type RuntimeReadinessResolver = (adapterId: string) => RuntimeReadinessProbe;

/** The non-blocking delivery subset required from TmuxManager. */
export interface RuntimeTmuxPromptPort {
  probeRoleStatus(hostId: string, roleName: string): "running" | "exited";
  sendRoleInputOnceIfReady(
    hostId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: RuntimeReadinessProbe
  ): "sent" | "already-sent" | "not-ready";
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
    if (this.tmux.probeRoleStatus(ref.hostId, ref.roleName) === "running") {
      this.tmux.killRole(ref.hostId, ref.roleName);
    }
  }

  async inspect(binding: RuntimeBinding): Promise<SessionInspection> {
    const ref = requireMatchingHostRef(binding);
    try {
      const state = this.tmux.probeRoleStatus(ref.hostId, ref.roleName) === "running"
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

  #launch(request: SessionLaunchRequest): RuntimeBinding {
    // Validate generated identity before starting an external process.
    const bindingId = requireSafeIdentity(this.#createBindingId(), "Runtime binding id");
    const input = {
      roleName: request.owner.roleName,
      agentId: request.agentId,
      adapterId: request.adapterId,
      launchId: request.launchId,
      mode: request.mode,
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
    const hostId = request.owner.scope === "task"
      ? request.owner.taskId
      : this.#globalHostId;

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
    this.tmux.ensureRoleWindow(hostId, planned.role, planned.launch);
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
      ...(nativeSessionId === undefined ? {} : { nativeSessionId })
    });
  }
}

/** Non-blocking active-composer push adapter; it never performs readiness polling. */
export class TmuxPromptPushAdapter implements ActivePromptPushPort {
  constructor(
    private readonly tmux: RuntimeTmuxPromptPort,
    private readonly readiness: RuntimeReadinessResolver
  ) {}

  async tryPush(request: ActivePromptPushRequest): Promise<PromptPushResult> {
    const ref = requireMatchingHostRef(request.binding);
    try {
      if (this.tmux.probeRoleStatus(ref.hostId, ref.roleName) !== "running") {
        return "unavailable";
      }
    } catch {
      return "unavailable";
    }
    const outcome = this.tmux.sendRoleInputOnceIfReady(
      ref.hostId,
      ref.roleName,
      request.envelope.id,
      request.envelope.text,
      this.readiness(request.binding.adapterId)
    );
    return outcome === "not-ready" ? "busy" : "delivered";
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
