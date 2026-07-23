import { usageError } from "../errors/cliError.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import type { YuiConfig } from "../storage/taskStore.js";

type ConfigCommandStore = Readonly<{
  getConfig(): YuiConfig;
  saveConfig(config: YuiConfig): void;
}>;

export function runConfigCommand(args: string[], store: ConfigCommandStore): string {
  const [command, ...rest] = args;
  if (command === "show") {
    if (rest.length !== 0) throw usageError("Config show usage: yui config show.");
    return `Time zone: ${resolveTimeZone(store.getConfig().timeZone)}\n`;
  }
  if (command === "set") {
    if (rest.length !== 2 || rest[0] !== "--time-zone") {
      throw usageError("Config set usage: yui config set --time-zone <IANA timezone>.");
    }
    const timeZone = resolveTimeZone(rest[1]);
    store.saveConfig({ ...store.getConfig(), timeZone });
    return `Time zone set to ${timeZone}\n`;
  }
  throw usageError(command === undefined
    ? "Config command is required."
    : `Unknown command: config ${command}`);
}
