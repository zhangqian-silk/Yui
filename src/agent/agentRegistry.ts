import type { AgentDefinition, ConfiguredAgent } from "./agent.js";
import { configuredAgentToDefinition } from "./agent.js";

export function resolveAgent(id: string, agents: readonly ConfiguredAgent[] = []): AgentDefinition | null {
  return listAgentDefinitions(agents).find((agent) => agent.id === id) ?? null;
}

export function listAgentDefinitions(agents: readonly ConfiguredAgent[] = []): AgentDefinition[] {
  return agents.map(configuredAgentToDefinition);
}

export function supportedAgentIds(agents: readonly ConfiguredAgent[] = []): string[] {
  return listAgentDefinitions(agents).map((agent) => agent.id);
}
