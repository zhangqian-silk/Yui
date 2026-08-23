import { inspectCompletionStates, renderCompletionStateTable } from "../completion/completionState.js";
import type { CliIdentity } from "../cli/completion.js";
import { usageError } from "../errors/cliError.js";
import { SYSTEM_ROLE_NAMES } from "../role/systemRoles.js";
import type { TaskStore } from "../storage/taskStore.js";
import { runAgentCommand, type AgentCommandStore } from "./agentCommands.js";
import { runConfigCommand } from "./configCommands.js";
import { runGlobalRoleCommand, type GlobalRoleCommandOptions } from "./globalRoleCommands.js";
import { runProfileCommand } from "./profileCommands.js";
import { CONFIG_DOMAINS, type ConfigDomain } from "../config/configCatalog.js";

export type ConfigOverviewResult = Readonly<{
  output: string;
  data: Readonly<Record<ConfigDomain, unknown> & {
    agents: unknown;
    roles: Readonly<{
      system: Readonly<Record<string, unknown>>;
      custom: readonly unknown[];
    }>;
    profiles: unknown;
    completion: unknown;
  }>;
}>;

/**
 * One complete projection of every persistent configuration domain. Human and
 * JSON callers intentionally consume the same store projection; the Operator can
 * therefore explain what the user sees without reconstructing configuration
 * from help text or implementation defaults.
 */
export function runConfigOverview(
  args: readonly string[],
  store: TaskStore,
  environment: NodeJS.ProcessEnv,
  identity: CliIdentity,
  roleOptions: GlobalRoleCommandOptions
): ConfigOverviewResult {
  if (args.length !== 0) throw usageError("Config show usage: yui config show.");

  const domains = Object.fromEntries(CONFIG_DOMAINS.map((domain) => [
    domain,
    runConfigCommand(domain, ["show"], store)
  ])) as Record<ConfigDomain, ReturnType<typeof runConfigCommand>>;
  const agents = store.listConfiguredAgents();
  const roles = store.listGlobalRoles();
  const systemRoles = Object.fromEntries(SYSTEM_ROLE_NAMES.map((name) => [
    name,
    store.getGlobalRole(name)
  ]));
  const profiles = store.listAgentProfiles();
  const completion = inspectCompletionStates(store.getConfig(), environment, identity);
  const roleOutput = runGlobalRoleCommand(
    ["list"],
    store as unknown as Parameters<typeof runGlobalRoleCommand>[1],
    roleOptions
  );
  if (typeof roleOutput !== "string") {
    throw new Error("Config overview received an invalid Role control result.");
  }

  const profileOutput = runProfileCommand(["list"], store).output;
  const agentOutput = runAgentCommand(
    ["list"],
    store as unknown as AgentCommandStore
  );
  const domainData = Object.fromEntries(CONFIG_DOMAINS.map((domain) => [
    domain,
    domains[domain].data
  ])) as Record<ConfigDomain, unknown>;
  return {
    output: `${[
      "Yui configuration",
      ...CONFIG_DOMAINS.map((domain) => domains[domain].output.trimEnd()),
      agentOutput.trimEnd(),
      roleOutput.trimEnd(),
      profileOutput.trimEnd(),
      renderCompletionStateTable(completion).trimEnd()
    ].join("\n\n")}\n`,
    data: {
      ...domainData,
      agents,
      roles: {
        system: systemRoles,
        custom: roles.filter(({ name }) => !(SYSTEM_ROLE_NAMES as readonly string[]).includes(name))
      },
      profiles,
      completion
    }
  };
}
