export type AgentEnvironment = Record<string, string>;

export type ConfiguredAgent = {
  schemaVersion: 1;
  id: string;
  command: string;
  args: string[];
  env: AgentEnvironment;
  createdAt: string;
  updatedAt: string;
};

export type AgentDefinition = {
  id: string;
  command: string;
  args: string[];
  env: AgentEnvironment;
  source: "custom";
};

export function createConfiguredAgent(
  id: string,
  command: string,
  args: string[],
  env: AgentEnvironment,
  now: Date
): ConfiguredAgent {
  const trimmedId = id.trim();
  const trimmedCommand = command.trim();
  const timestamp = now.toISOString();

  if (trimmedId.length === 0) {
    throw new Error("Agent id is required.");
  }

  if (trimmedCommand.length === 0) {
    throw new Error("Agent command is required.");
  }

  return {
    schemaVersion: 1,
    id: trimmedId,
    command: trimmedCommand,
    args,
    env,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function configuredAgentToDefinition(agent: ConfiguredAgent): AgentDefinition {
  return {
    id: agent.id,
    command: agent.command,
    args: agent.args,
    env: agent.env,
    source: "custom"
  };
}
