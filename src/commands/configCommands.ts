import { usageError } from "../errors/cliError.js";
import {
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  DEFAULT_RESOURCES_GC_MODE,
  reconciliationIntervalMilliseconds
  , resolveResourcesGcAutoQuarantine
  , resolveResourcesGcMode
} from "../config/yuiConfig.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import type { YuiConfig } from "../storage/taskStore.js";
import {
  REVIEW_FINDING_LEDGER_MODES,
  REVIEW_TRIGGERS,
  type ReviewFindingLedgerMode,
  type ReviewTrigger
} from "../review/reviewConfig.js";
import {
  DEFAULT_LEADER_NEXT_ACTION_MODE,
  LEADER_NEXT_ACTION_MODES,
  resolveLeaderNextActionMode,
  type LeaderNextActionMode
} from "../config/yuiConfig.js";

type ConfigCommandStore = Readonly<{
  transaction<T>(execute: (store: ConfigCommandStore) => T): T;
  getConfig(): YuiConfig;
  saveConfig(config: YuiConfig): void;
  getGlobalRole?(name: string): Readonly<{ name: string }> | null;
}>;

const CONFIG_SET_USAGE = "Config set usage: yui config set "
  + "<--time-zone <IANA timezone> | "
  + "--reconciliation-interval-seconds <seconds> | "
  + "--resources-gc-mode <report|quarantine> | "
  + "--resources-gc-auto-quarantine <true|false>>.";

export function runConfigCommand(args: string[], store: ConfigCommandStore): string {
  const [command, ...rest] = args;
  if (command === "review") return runReviewConfigCommand(rest, store);
  if (command === "leader-next-action") return runLeaderNextActionConfigCommand(rest, store);
  if (command === "show") {
    if (rest.length !== 0) throw usageError("Config show usage: yui config show.");
    const config = store.getConfig();
    const reconciliationIntervalSeconds = config.reconciliationIntervalSeconds
      ?? DEFAULT_RECONCILIATION_INTERVAL_SECONDS;
    reconciliationIntervalMilliseconds(reconciliationIntervalSeconds);
    return [
      `Time zone: ${resolveTimeZone(config.timeZone)}`,
      `Reconciliation interval: ${reconciliationIntervalSeconds} seconds`,
      `Leader next-action mode: ${resolveLeaderNextActionMode(config.leaderNextActionMode)}`,
      `Resources GC mode: ${resolveResourcesGcMode(config.resourcesGcMode)}`,
      `Resources GC auto-quarantine: ${resolveResourcesGcAutoQuarantine(config.resourcesGcAutoQuarantine) ? "on" : "off"}`,
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
    if (rest[0] === "--resources-gc-mode") {
      const resourcesGcMode = validatedConfigValue(() => resolveResourcesGcMode(rest[1]));
      store.transaction((tx) => {
        tx.saveConfig({ ...tx.getConfig(), resourcesGcMode });
      });
      return `Resources GC mode set to ${resourcesGcMode}\n`;
    }
    if (rest[0] === "--resources-gc-auto-quarantine") {
      const resourcesGcAutoQuarantine = validatedConfigValue(
        () => resolveResourcesGcAutoQuarantine(rest[1] === "true" ? true : rest[1] === "false" ? false : rest[1])
      );
      store.transaction((tx) => {
        tx.saveConfig({ ...tx.getConfig(), resourcesGcAutoQuarantine });
      });
      return `Resources GC auto-quarantine set to ${resourcesGcAutoQuarantine ? "on" : "off"}\n`;
    }
    throw configSetUsageError();
  }
  throw usageError(command === undefined
    ? "Config command is required."
    : `Unknown command: config ${command}`);
}

function runLeaderNextActionConfigCommand(
  args: string[],
  store: ConfigCommandStore
): string {
  const [command, ...rest] = args;
  if (command === "show") {
    if (rest.length !== 0) {
      throw usageError("Config leader-next-action show usage: yui config leader-next-action show.");
    }
    return `Leader next-action mode: ${resolveLeaderNextActionMode(store.getConfig().leaderNextActionMode)}\n`;
  }
  if (command === "set") {
    const usage = "Config leader-next-action set usage: "
      + `yui config leader-next-action set <${LEADER_NEXT_ACTION_MODES.join("|")}>.`;
    if (rest.length !== 1) throw usageError(usage);
    let mode: LeaderNextActionMode;
    try {
      mode = resolveLeaderNextActionMode(rest[0]);
    } catch (error) {
      throw usageError(
        error instanceof Error ? error.message : String(error),
        usage
      );
    }
    store.transaction((tx) => {
      tx.saveConfig({ ...tx.getConfig(), leaderNextActionMode: mode });
    });
    return `Leader next-action mode set to ${mode}\n`;
  }
  if (command === "clear") {
    if (rest.length !== 0) {
      throw usageError("Config leader-next-action clear usage: yui config leader-next-action clear.");
    }
    store.transaction((tx) => {
      const { leaderNextActionMode: _mode, ...config } = tx.getConfig();
      tx.saveConfig(config);
    });
    return `Leader next-action mode reset to ${DEFAULT_LEADER_NEXT_ACTION_MODE}\n`;
  }
  throw usageError(command === undefined
    ? "Config leader-next-action command is required."
    : `Unknown command: config leader-next-action ${command}`);
}

function runReviewConfigCommand(args: string[], store: ConfigCommandStore): string {
  const [command, ...rest] = args;
  if (command === "show") {
    if (rest.length !== 0) throw usageError("Config review show usage: yui config review show.");
    const review = store.getConfig().review;
    return review === undefined
      ? "Review: disabled\n"
      : `Review: ${review.roleName} (${review.trigger}; finding ledger: ${review.findingLedger ?? "shadow"})\n`;
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
      + "yui config review set --role <global-role> --trigger <always|leader|final> "
      + "[--finding-ledger <shadow|enforce>].";
    if (rest.length !== 4 && rest.length !== 6) throw usageError(usage);
    const options = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const name = rest[index];
      const value = rest[index + 1];
      if (!["--role", "--trigger", "--finding-ledger"].includes(name)
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
    const rawLedgerMode = options.get("--finding-ledger")?.trim();
    let findingLedger: ReviewFindingLedgerMode | undefined;
    if (rawLedgerMode !== undefined) {
      if (!REVIEW_FINDING_LEDGER_MODES.includes(rawLedgerMode as ReviewFindingLedgerMode)) {
        throw usageError(usage);
      }
      findingLedger = rawLedgerMode as ReviewFindingLedgerMode;
    }
    store.transaction((tx) => {
      tx.saveConfig({
        ...tx.getConfig(),
        review: {
          roleName,
          trigger,
          ...(findingLedger === undefined ? {} : { findingLedger })
        }
      });
    });
    return `Review set to ${roleName} (${trigger}; finding ledger: ${findingLedger ?? "shadow"})\n`;
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
