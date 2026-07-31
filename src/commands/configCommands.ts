import { usageError } from "../errors/cliError.js";
import {
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  reconciliationIntervalMilliseconds
} from "../config/yuiConfig.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import type { YuiConfig } from "../storage/taskStore.js";
import {
  REVIEW_TRIGGERS,
  type ReviewTrigger
} from "../review/reviewConfig.js";

type ConfigCommandStore = Readonly<{
  transaction<T>(execute: (store: ConfigCommandStore) => T): T;
  getConfig(): YuiConfig;
  saveConfig(config: YuiConfig): void;
  getGlobalRole?(name: string): Readonly<{ name: string }> | null;
}>;

const CONFIG_SET_USAGE = "Config set usage: yui config set "
  + "<--time-zone <IANA timezone> | "
  + "--reconciliation-interval-seconds <seconds>>.";

export function runConfigCommand(args: string[], store: ConfigCommandStore): string {
  const [command, ...rest] = args;
  if (command === "review") return runReviewConfigCommand(rest, store);
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
      const timeZone = validatedConfigValue(() => resolveTimeZone(rest[1]));
      store.transaction((tx) => {
        tx.saveConfig({ ...tx.getConfig(), timeZone });
      });
      return `Time zone set to ${timeZone}\n`;
    }
    if (rest[0] === "--reconciliation-interval-seconds") {
      const reconciliationIntervalSeconds = parseReconciliationIntervalSeconds(rest[1]);
      validatedConfigValue(() => reconciliationIntervalMilliseconds(reconciliationIntervalSeconds));
      store.transaction((tx) => {
        tx.saveConfig({ ...tx.getConfig(), reconciliationIntervalSeconds });
      });
      return `Reconciliation interval set to ${reconciliationIntervalSeconds} seconds\n`;
    }
    throw configSetUsageError();
  }
  throw usageError(command === undefined
    ? "Config command is required."
    : `Unknown command: config ${command}`);
}

function runReviewConfigCommand(args: string[], store: ConfigCommandStore): string {
  const [command, ...rest] = args;
  if (command === "show") {
    if (rest.length !== 0) throw usageError("Config review show usage: yui config review show.");
    const review = store.getConfig().review;
    return review === undefined
      ? "Review: disabled\n"
      : `Review: ${review.roleName} (${review.trigger})\n`;
  }
  if (command === "clear") {
    if (rest.length !== 0) throw usageError("Config review clear usage: yui config review clear.");
    store.transaction((tx) => {
      const { review: _review, ...config } = tx.getConfig();
      tx.saveConfig(config);
    });
    return "Review disabled\n";
  }
  if (command === "set") {
    const usage = "Config review set usage: "
      + "yui config review set --role <global-role> --trigger <always|leader>.";
    if (rest.length !== 4) throw usageError(usage);
    const options = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const name = rest[index];
      const value = rest[index + 1];
      if (!["--role", "--trigger"].includes(name)
        || value === undefined
        || options.has(name)) {
        throw usageError(usage);
      }
      options.set(name, value);
    }
    const roleName = options.get("--role")?.trim();
    const rawTrigger = options.get("--trigger")?.trim();
    if (roleName === undefined || roleName.length === 0
      || rawTrigger === undefined
      || !REVIEW_TRIGGERS.includes(rawTrigger as ReviewTrigger)) {
      throw usageError(usage);
    }
    if (store.getGlobalRole?.(roleName) === null) {
      throw usageError(`Global Role not found: ${roleName}.`);
    }
    const trigger = rawTrigger as ReviewTrigger;
    store.transaction((tx) => {
      tx.saveConfig({
        ...tx.getConfig(),
        review: { roleName, trigger }
      });
    });
    return `Review set to ${roleName} (${trigger})\n`;
  }
  throw usageError(command === undefined
    ? "Config review command is required."
    : `Unknown command: config review ${command}`);
}

function parseReconciliationIntervalSeconds(value: string): number {
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}

function validatedConfigValue<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof TypeError) {
      throw usageError(error.message, CONFIG_SET_USAGE);
    }
    throw error;
  }
}

function configSetUsageError(): Error {
  return usageError(CONFIG_SET_USAGE);
}
