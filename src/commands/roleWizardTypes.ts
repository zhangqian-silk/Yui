import type { AgentDefinition } from "../agent/agent.js";
import type { CapabilitySnapshot } from "../executor/agentAdapter.js";
import type { RoleAgentConfig } from "../role/role.js";

export type RoleWizardMode = "add" | "update";

export type RoleConfigWizardInput = {
  mode: RoleWizardMode;
  roleName: string;
  agents: AgentDefinition[];
  defaultAgentId?: string;
  currentAgentId?: string;
  currentConfigs?: Record<string, RoleAgentConfig>;
};

export type RoleConfigWizardDependencies = {
  question: (prompt: string) => Promise<string>;
  inspectCapabilities: (agent: AgentDefinition) => CapabilitySnapshot | Promise<CapabilitySnapshot>;
  validateAgentSelection?: (input: {
    agent: AgentDefinition;
    snapshot: CapabilitySnapshot;
  }) => void | Promise<void>;
  canKeepUnavailableValue?: (input: {
    agent: AgentDefinition;
    snapshot: CapabilitySnapshot;
    fieldKey: string;
    value: unknown;
    currentConfig: RoleAgentConfig;
    draftConfig: RoleAgentConfig;
  }) => boolean | Promise<boolean>;
  validateSelection?: (input: {
    agent: AgentDefinition;
    snapshot: CapabilitySnapshot;
    selection: RoleConfigWizardSelection;
  }) => void | Promise<void>;
};

export type RoleConfigWizardSelection = {
  agentId: string;
  adapterId: string;
  config: RoleAgentConfig;
};

export type RoleConfigWizardResult =
  | {
    status: "selected";
    selection: RoleConfigWizardSelection;
    summary: string;
  }
  | {
    status: "cancelled";
    message: string;
  };
