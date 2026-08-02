import type { PromptEnvelope } from "./promptEnvelope.js";
import type { RuntimeBinding } from "./runtimeBinding.js";
import type { RuntimeOwner } from "./runtimeOwner.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type {
  NewSessionLaunchRequest,
  ResumeSessionLaunchRequest
} from "./sessionLaunchRequest.js";

export type SessionRuntimeState = "starting" | "running" | "stopped" | "unavailable";

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
  environment?: Readonly<Record<string, string>>;
  mode: "new" | "resume";
  nativeSessionId?: string;
  runId?: string;
}>;

export type RuntimeLaunchPersistence = "deferred" | "immediate";

/** Runtime-side seam implemented by reservation, Hook, or hybrid launch policy. */
export interface RuntimeLaunchPreparationPort {
  prepare(
    request: RuntimeLaunchPreparationRequest,
    persistence: RuntimeLaunchPersistence,
    assertCurrent?: () => void
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
  start(request: NewSessionLaunchRequest): Promise<RuntimeBinding>;
  resume(request: ResumeSessionLaunchRequest): Promise<RuntimeBinding>;
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

export type PromptPushResult = "delivered" | "busy" | "unavailable";

export type ActivePromptPushRequest = Readonly<{
  binding: RuntimeBinding;
  envelope: PromptEnvelope;
}>;

export interface ActivePromptPushPort {
  tryPush(request: ActivePromptPushRequest): Promise<PromptPushResult>;
}
