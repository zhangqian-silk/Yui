import type { ConfiguredAgent } from "../agent/agent.js";
import {
  createRoleAgentBinding,
  type GlobalRole,
  type RoleAgentBinding,
  type RoleAgentConfig
} from "../role/role.js";
import type { AgentProfile } from "./agentProfile.js";

export type AgentProfileRuntimeStore = Readonly<{
  getConfiguredAgent(id: string): ConfiguredAgent | null;
  getGlobalRole(name: string): GlobalRole | null;
}>;

export type ResolvedAgentProfileRuntime =
  | Readonly<{
      status: "resolved";
      source: "global-worker";
      workerRevision: number;
      binding: RoleAgentBinding;
    }>
  | Readonly<{
      status: "resolved";
      source: "explicit";
      binding: RoleAgentBinding;
    }>
  | Readonly<{
      status: "unavailable";
      source: "global-worker" | "explicit";
      workerRevision?: number;
      reason: string;
    }>;

export type AgentProfileView = Readonly<{
  profile: AgentProfile;
  runtime: ResolvedAgentProfileRuntime;
}>;

/** The single read model for persisted Profile intent and current runtime. */
export function resolveAgentProfileView(
  profile: AgentProfile,
  store: AgentProfileRuntimeStore
): AgentProfileView {
  return {
    profile,
    runtime: resolveAgentProfileRuntime(profile, store)
  };
}

/**
 * Resolve one Profile into a complete Role binding. Inherited Profiles copy
 * the current Global Worker active binding verbatim; explicit Profiles use the
 * selected Agent's provider defaults plus their own model/effort.
 */
export function resolveAgentProfileRuntime(
  profile: AgentProfile,
  store: AgentProfileRuntimeStore
): ResolvedAgentProfileRuntime {
  if (profile.runtime.source === "global-worker") {
    const worker = store.getGlobalRole("worker");
    if (worker === null) {
      return {
        status: "unavailable",
        source: "global-worker",
        reason: "Global Role worker is not configured."
      };
    }
    const binding = worker.agentBindings[worker.activeAgentId];
    if (binding === undefined) {
      return {
        status: "unavailable",
        source: "global-worker",
        workerRevision: worker.launchRevision,
        reason: `Global Role worker active Agent is not bound: ${worker.activeAgentId}.`
      };
    }
    const agent = store.getConfiguredAgent(binding.agentId);
    if (agent === null) {
      return {
        status: "unavailable",
        source: "global-worker",
        workerRevision: worker.launchRevision,
        reason: `Global Role worker Agent is not configured: ${binding.agentId}.`
      };
    }
    if (agent.adapterId !== binding.adapterId) {
      return {
        status: "unavailable",
        source: "global-worker",
        workerRevision: worker.launchRevision,
        reason: `Global Role worker Agent adapter does not match its binding: ${binding.agentId}.`
      };
    }
    return {
      status: "resolved",
      source: "global-worker",
      workerRevision: worker.launchRevision,
      binding: createRoleAgentBinding(agent, binding.config)
    };
  }

  const agent = store.getConfiguredAgent(profile.runtime.agentId);
  if (agent === null) {
    return {
      status: "unavailable",
      source: "explicit",
      reason: `Configured Agent not found: ${profile.runtime.agentId}.`
    };
  }
  const defaults = createRoleAgentBinding(agent);
  const config = structuredClone(defaults.config) as unknown as Record<string, unknown>;
  if (profile.runtime.model !== undefined) config.model = profile.runtime.model;
  if (profile.runtime.effort !== undefined) config.effort = profile.runtime.effort;
  return {
    status: "resolved",
    source: "explicit",
    binding: createRoleAgentBinding(agent, config as unknown as RoleAgentConfig)
  };
}

export function requireResolvedAgentProfileRuntime(
  profile: AgentProfile,
  store: AgentProfileRuntimeStore
): Extract<ResolvedAgentProfileRuntime, { status: "resolved" }> {
  const runtime = resolveAgentProfileRuntime(profile, store);
  if (runtime.status === "unavailable") {
    throw new Error(`Agent Profile ${profile.id} runtime is unavailable: ${runtime.reason}`);
  }
  return runtime;
}
