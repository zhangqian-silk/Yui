import type { ConfiguredAgent, AgentDefinition } from "./agent.js";
import { configuredAgentToDefinition } from "./agent.js";

export function resolveAgent(id: string, agents: ConfiguredAgent[] = []): AgentDefinition | null {
  return listAgentDefinitions(agents).find((agent) => agent.id === id) ?? null;
}

export function listAgentDefinitions(agents: ConfiguredAgent[] = []): AgentDefinition[] {
  return agents.map((agent) => configuredAgentToDefinition(agent));
}

export function supportedAgentIds(agents: ConfiguredAgent[] = []): string[] {
  return listAgentDefinitions(agents).map((agent) => agent.id);
}
