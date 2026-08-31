import type { PromptEnvelope } from "./promptEnvelope.js";
import type { RuntimeBinding } from "./runtimeBinding.js";
import type { RuntimeOwner } from "./runtimeOwner.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import type { TaskRuntimeLaunchPolicy } from "./taskRuntimeIsolation.js";
import type {
  NewSessionLaunchRequest,
  ResumeSessionLaunchRequest
} from "./sessionLaunchRequest.js";

export type SessionRuntimeState = "starting" | "running" | "stopped" | "unavailable";

export type RuntimeLaunchRetryReason =
  | "previous-process"
  | "writable-client"
  | "provider-child-active";

/** A persisted launch is either temporarily unavailable or permanently lost. */
export class RuntimeLaunchError extends Error {
  readonly name = "RuntimeLaunchError";

  constructor(
    readonly retryable: boolean,
    readonly launchId: string,
    message: string,
    readonly reason?: RuntimeLaunchRetryReason
  ) {
    super(message);
  }
}

/** A host-side contention check that occurs before planning or process start. */
export class RuntimeHostContentionError extends Error {
  readonly name = "RuntimeHostContentionError";

  constructor(
    readonly reason: Extract<
      RuntimeLaunchRetryReason,
      "writable-client" | "provider-child-active"
    >,
    message: string
  ) {
    super(message);
  }
}

export type SessionInspection = Readonly<{
  state: SessionRuntimeState;
  nativeSessionId?: string;
}>;

export type RuntimeLaunchPreparationRequest = Readonly<{
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  effective: EffectiveLaunchSnapshot;
  workspace: string;
  /** Authoritative runtime owner; a Role is only transport/session addressing. */
  managedWorkspace?: ManagedWorkspace;
  runtimePolicy?: TaskRuntimeLaunchPolicy;
  environment?: Readonly<Record<string, string>>;
  mode: "new" | "resume";
  nativeSessionId?: string;
  /** Current Host activation for exact same-Session restore, when known. */
  hostActivationId?: string;
  runId?: string;
}>;

export type RuntimeLaunchPersistence = "deferred" | "immediate";

/**
 * Exact launch facts available after reservation/planning but before the
 * session host is allowed to create the external Provider process.
 */
export type RuntimeLaunchPreflight = Readonly<{
  owner: RuntimeOwner;
  launchId: string;
  runId?: string;
  agentId: string;
  adapterId: string;
  effective: EffectiveLaunchSnapshot;
  sessionTitle?: string;
  nativeSessionId?: string;
}>;

export type RuntimeLaunchPreStart = (preflight: RuntimeLaunchPreflight) => void;

/** Runtime-side seam implemented by reservation, Hook, or hybrid launch policy. */
export interface RuntimeLaunchPreparationPort {
  /**
   * When supplied, the host must invoke `beforeHostStart` before creating any
   * external Provider process; callers use it to persist the exact Run fence.
   */
  prepare(
    request: RuntimeLaunchPreparationRequest,
    persistence: RuntimeLaunchPersistence,
    assertCurrent?: () => void,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding>;
}

export type AgentEnvironmentRefresh = Readonly<{
  sources: Readonly<Record<string, string>>;
  sourceNames: readonly string[];
  nativeSources: Readonly<Record<string, string>>;
  nativeNames: readonly string[];
}>;

/** Volatile, non-persisted source values used to resolve configured Agent bindings. */
export interface AgentEnvironmentRefreshPort {
  refreshAgentEnvironment(refresh: AgentEnvironmentRefresh): void;
}

export interface SessionHostPort {
  /** The callback must run after planning but before any Provider process starts. */
  start(
    request: NewSessionLaunchRequest,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding>;
  /** Reattach exactly the requested native Session; never creates a replacement Session. */
  restore(
    request: ResumeSessionLaunchRequest,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding>;
  stop(binding: RuntimeBinding): Promise<void>;
  inspect(binding: RuntimeBinding): Promise<SessionInspection>;
  /** Owner-level probe used to resolve an interrupted pre-binding launch. */
  inspectOwner(owner: RuntimeOwner): Promise<SessionInspection>;
  /** Optional one-snapshot owner inventory for low-frequency reconciliation. */
  inspectOwners?(
    owners: readonly RuntimeOwner[]
  ): Promise<readonly Readonly<{
    owner: RuntimeOwner;
    inspection: SessionInspection;
  }>[]>;
  /**
   * Stop the current host process selected by its domain owner.
   *
   * Returns true only when the owner is confirmed absent after the operation;
   * false means the host could not be inspected or stopped and the durable
   * cleanup obligation must remain queued.
   */
  stopOwner(owner: RuntimeOwner): Promise<boolean>;
}

export type PromptPushResult =
  | "delivered"
  | "busy"
  | "rejected"
  | "delivery-unknown"
  | "unavailable";

export type ActivePromptPushRequest = Readonly<{
  binding: RuntimeBinding;
  envelope: PromptEnvelope;
}>;

export interface ActivePromptPushPort {
  tryPush(request: ActivePromptPushRequest): Promise<PromptPushResult>;
}
