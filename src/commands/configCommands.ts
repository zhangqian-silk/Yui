import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { SYSTEM_LEADER_ROLE, SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { resolveAgent } from "../agent/agentRegistry.js";
import { inspectCompletionStates } from "../completion/completionState.js";
import type { CliIdentity } from "../cli/completion.js";
import { COMPLETION_SHELLS, type CompletionShell, type TaskStore, type TaskmuxConfig } from "../storage/taskStore.js";

type ConfigKey = "default-agent" | "default-workspace";

export function runConfigCommand(args: string[], store: TaskStore, env: NodeJS.ProcessEnv = process.env): string {
  const [command, ...rest] = args;

  switch (command) {
    case "show":
      return showConfigCommand(store, env);
    case "set":
      return setConfigCommand(rest, store);
    case "unset":
      return unsetConfigCommand(rest, store);
    default:
      throw usageError(command === undefined ? "Config command is required." : `Unknown command: config ${command}`);
  }
}

function showConfigCommand(store: TaskStore, env: NodeJS.ProcessEnv): string {
  const config = store.getConfig();

  return `${renderConfigStatus(store, config, env)}\n`;
}

function renderConfigStatus(store: TaskStore, config: TaskmuxConfig, env: NodeJS.ProcessEnv): string {
  return renderTable(
    "TaskMux config",
    [
      { header: "Item", minWidth: 8, maxWidth: 22 },
      { header: "Status", minWidth: 7, maxWidth: 16 },
      { header: "Detail", minWidth: 12, maxWidth: 88 }
    ],
    configStatusRows(store, config, env),
    defaultTableWidth()
  );
}

function configStatusRows(store: TaskStore, config: TaskmuxConfig, env: NodeJS.ProcessEnv): string[][] {
  const rows: string[][] = [];
  const defaultAgent = config.defaultAgent?.trim() ?? "";

  if (defaultAgent.length === 0) {
    rows.push(["default-agent", "missing", "taskmux config set default-agent <agent-id>"]);
  } else {
    const agent = resolveAgent(defaultAgent, store.listConfiguredAgents());

    if (agent === null) {
      rows.push(["default-agent", "invalid", `${defaultAgent} is not configured`]);
    } else {
      rows.push([
        "default-agent",
        "configured",
        `agent=${defaultAgent}; command=${agent.command}${commandUnavailableDetail(agent.command, env)}`
      ]);
    }
  }

  const workspace = config.defaultWorkspace?.trim() ?? "";

  if (workspace.length === 0) {
    rows.push(["default-workspace", "missing", "taskmux config set default-workspace <path>"]);
  } else {
    rows.push(["default-workspace", "configured", workspace]);
  }

  rows.push(configPointerRow("current-task", config.currentTaskId));
  rows.push(configPointerRow("last-task", config.lastTaskId));

  for (const state of inspectCompletionStates(config, env, configCliIdentity(env))) {
    if (state.installation === undefined) continue;
    rows.push([
      `completion:${state.shell}`,
      "configured",
      `script=${state.installation.scriptPath}; activation=${state.installation.activationPath}; state=${state.status}`
    ]);
  }

  for (const roleName of [SYSTEM_OPERATOR_ROLE, SYSTEM_LEADER_ROLE]) {
    const role = store.getGlobalRole(roleName);

    if (role === null) {
      rows.push([`role:${roleName}`, "missing", "Run taskmux setup in an interactive terminal."]);
    } else {
      rows.push([
        `role:${roleName}`,
        "configured",
        roleConfigDetail(role.agent, role.workspace, workspace)
      ]);
    }
  }

  return rows;
}

function configCliIdentity(env: NodeJS.ProcessEnv): CliIdentity {
  return env.TASKMUX_CLI_NAME === "taskmux-dev" ? "taskmux-dev" : "taskmux";
}

function configPointerRow(item: "current-task" | "last-task", taskId: string | undefined): string[] {
  return [item, taskId === undefined ? "unset" : "set", taskId ?? ""];
}

function roleConfigDetail(agent: string, workspace: string, defaultWorkspace: string): string {
  const workspaceDetail = defaultWorkspace.length === 0 || workspace !== defaultWorkspace
    ? `; workspace=${workspace}`
    : "";

  return `agent=${agent}${workspaceDetail}`;
}

function commandUnavailableDetail(command: string, env: NodeJS.ProcessEnv): string {
  if (commandOnPath(command, env)) {
    return "";
  }

  if (command.includes("/") || command.includes("\\")) {
    return "; missing";
  }

  return "; not found in PATH";
}

function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command);
  }

  const pathEntries = (env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((entry) => entry.length > 0)
      : [""];

  return pathEntries.some((entry) =>
    extensions.some((extension) => existsSync(join(entry, `${command}${extension}`)))
  );
}

function setConfigCommand(args: string[], store: TaskStore): string {
  const [key, ...valueParts] = args;
  if (key === "completion") {
    const [shellValue, scriptPath, activationPath, ...extra] = valueParts;
    const shell = parseCompletionShell(shellValue);
    if (scriptPath === undefined || activationPath === undefined || extra.length > 0) {
      throw usageError("Config completion usage: taskmux config set completion <bash|zsh|fish> <script-path> <activation-path>");
    }
    const config = store.getConfig();
    store.saveConfig({
      ...config,
      completionInstallations: {
        ...config.completionInstallations,
        [shell]: { scriptPath: resolveConfigPath(scriptPath), activationPath: resolveConfigPath(activationPath) }
      }
    });
    return `Set completion ${shell}: ${resolveConfigPath(scriptPath)}\n`;
  }
  const configKey = parseConfigKey(key);
  const value = valueParts.join(" ").trim();

  if (value.length === 0) {
    throw usageError("Config value is required.");
  }

  const config = patchConfig(store.getConfig(), configKey, value);
  store.saveConfig(config);

  return `Set ${configKey}: ${value}\n`;
}

function unsetConfigCommand(args: string[], store: TaskStore): string {
  const [key] = args;
  if (key === "completion") {
    const shell = parseCompletionShell(args[1]);
    if (args.length !== 2) {
      throw usageError("Config completion usage: taskmux config unset completion <bash|zsh|fish>");
    }
    const config = store.getConfig();
    const installations = { ...config.completionInstallations };
    delete installations[shell];
    store.saveConfig({
      ...config,
      completionInstallations: Object.keys(installations).length === 0 ? undefined : installations
    });
    return `Unset completion ${shell}\n`;
  }
  const configKey = parseConfigKey(key);
  const config = patchConfig(store.getConfig(), configKey, undefined);

  store.saveConfig(config);

  return `Unset ${configKey}\n`;
}

function parseCompletionShell(value: string | undefined): CompletionShell {
  if (COMPLETION_SHELLS.includes(value as CompletionShell)) {
    return value as CompletionShell;
  }
  throw usageError("Completion shell must be one of bash, zsh, fish.");
}

function resolveConfigPath(value: string): string {
  return resolve(value);
}

function patchConfig(config: TaskmuxConfig, key: ConfigKey, value: string | undefined): TaskmuxConfig {
  if (key === "default-agent") {
    return { ...config, defaultAgent: value };
  }

  return { ...config, defaultWorkspace: value };
}

function parseConfigKey(value: string | undefined): ConfigKey {
  if (value === "default-agent" || value === "default-workspace") {
    return value;
  }

  throw usageError("Config key must be one of default-agent, default-workspace.");
}
