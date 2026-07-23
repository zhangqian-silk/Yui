import { usageError } from "../errors/cliError.js";
import {
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  reconciliationIntervalMilliseconds
} from "../config/yuiConfig.js";
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
    const config = store.getConfig();
    const reconciliationIntervalSeconds = config.reconciliationIntervalSeconds
      ?? DEFAULT_RECONCILIATION_INTERVAL_SECONDS;
    reconciliationIntervalMilliseconds(reconciliationIntervalSeconds);
    return [
      `Time zone: ${resolveTimeZone(config.timeZone)}`,
      `Reconciliation interval: ${reconciliationIntervalSeconds} seconds`,
      ""
    ].join("\n");
  }
  if (command === "set") {
    if (rest.length !== 2) {
      throw configSetUsageError();
    }
    if (rest[0] === "--time-zone") {
      const timeZone = resolveTimeZone(rest[1]);
      store.saveConfig({ ...store.getConfig(), timeZone });
      return `Time zone set to ${timeZone}\n`;
    }
    if (rest[0] === "--reconciliation-interval-seconds") {
      const reconciliationIntervalSeconds = parseReconciliationIntervalSeconds(rest[1]);
      reconciliationIntervalMilliseconds(reconciliationIntervalSeconds);
      store.saveConfig({ ...store.getConfig(), reconciliationIntervalSeconds });
      return `Reconciliation interval set to ${reconciliationIntervalSeconds} seconds\n`;
    }
    throw configSetUsageError();
  }
  throw usageError(command === undefined
    ? "Config command is required."
    : `Unknown command: config ${command}`);
}

function parseReconciliationIntervalSeconds(value: string): number {
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}

function configSetUsageError(): Error {
  return usageError(
    "Config set usage: yui config set "
    + "<--time-zone <IANA timezone> | "
    + "--reconciliation-interval-seconds <seconds>>."
  );
}
