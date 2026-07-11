import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { SYSTEM_LEADER_ROLE, SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { resolveRunner } from "../runner/runnerRegistry.js";
import type { TaskStore, TaskmuxConfig } from "../storage/taskStore.js";

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
      return configUsage();
  }
}

function showConfigCommand(store: TaskStore, env: NodeJS.ProcessEnv): string {
  const config = store.getConfig();

  return [
    "TaskMux config",
    `Default agent: ${config.defaultAgent ?? "(none)"}`,
    `Default workspace: ${config.defaultWorkspace ?? "(none)"}`,
    `Current task: ${config.currentTaskId ?? "(none)"}`,
    `Last task: ${config.lastTaskId ?? "(none)"}`,
    "",
    renderConfigStatus(store, config, env)
  ].join("\n").concat("\n");
}

function renderConfigStatus(store: TaskStore, config: TaskmuxConfig, env: NodeJS.ProcessEnv): string {
  return renderTable(
    "Status",
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
    const agent = resolveRunner(defaultAgent, store.listCustomRunners());

    if (agent === null) {
      rows.push(["default-agent", "invalid", `${defaultAgent} is not configured`]);
    } else {
      rows.push([
        "default-agent",
        "configured",
        `command=${agent.command}${commandUnavailableDetail(agent.command, env)}`
      ]);
    }
  }

  const workspace = config.defaultWorkspace?.trim() ?? "";

  if (workspace.length === 0) {
    rows.push(["workspace", "missing", "taskmux config set default-workspace <path>"]);
  } else {
    rows.push(["workspace", "configured", workspace]);
  }

  for (const roleName of [SYSTEM_OPERATOR_ROLE, SYSTEM_LEADER_ROLE]) {
    const role = store.getGlobalRole(roleName);

    if (role === null) {
      rows.push([`role:${roleName}`, "missing", "Run taskmux setup in an interactive terminal."]);
    } else {
      rows.push([`role:${roleName}`, "configured", `agent=${role.agent} workspace=${role.workspace}`]);
    }
  }

  return rows;
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
  const configKey = parseConfigKey(key);
  const config = patchConfig(store.getConfig(), configKey, undefined);

  store.saveConfig(config);

  return `Unset ${configKey}\n`;
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

function configUsage(): string {
  return `Config commands:
  taskmux config show
  taskmux config set default-agent <agent-id>
  taskmux config set default-workspace <path>
  taskmux config unset default-agent
  taskmux config unset default-workspace
`;
}
