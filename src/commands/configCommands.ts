import { usageError } from "../errors/cliError.js";
import type { TaskStore, TaskmuxConfig } from "../storage/taskStore.js";

type ConfigKey = "default-agent" | "default-workspace";

export function runConfigCommand(args: string[], store: TaskStore): string {
  const [command, ...rest] = args;

  switch (command) {
    case "show":
      return showConfigCommand(store);
    case "set":
      return setConfigCommand(rest, store);
    case "unset":
      return unsetConfigCommand(rest, store);
    default:
      return configUsage();
  }
}

function showConfigCommand(store: TaskStore): string {
  const config = store.getConfig();

  return [
    "TaskMux config",
    `Default agent: ${config.defaultAgent ?? "(none)"}`,
    `Default workspace: ${config.defaultWorkspace ?? "(none)"}`,
    `Current task: ${config.currentTaskId ?? "(none)"}`,
    `Last task: ${config.lastTaskId ?? "(none)"}`
  ].join("\n").concat("\n");
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
