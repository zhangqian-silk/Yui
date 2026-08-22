import { usageError } from "../errors/cliError.js";
import {
  DEFAULT_CONTEXT_HARD_TOKENS,
  DEFAULT_CONTEXT_SOFT_TOKENS,
  DEFAULT_LEADER_NEXT_ACTION_MODE,
  DEFAULT_PROVIDER_RETRY_MODE,
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  DEFAULT_RESOURCES_GC_MODE,
  LEADER_NEXT_ACTION_MODES,
  PROVIDER_RETRY_MODES,
  reconciliationIntervalMilliseconds,
  resolveContextBudget,
  resolveGitBin,
  resolveLeaderNextActionMode,
  resolveProviderRetryAdapters,
  resolveProviderRetryMaxWindowMs,
  resolveProviderRetryMode,
  resolveResourcesGcAutoQuarantine,
  resolveResourcesGcMode,
  resolveTelemetryMode,
  resolveTelemetryRunCap,
  resolveTelemetryTerminalKeep,
  resolveTmuxBin,
  resolveYieldReceiptReplay,
  type ContextBudgetConfig,
  type LeaderNextActionMode,
  type ProviderRetryMode
} from "../config/yuiConfig.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { YuiConfig } from "../storage/taskStore.js";
import {
  DEFAULT_DELTA_RECHECK_MAX_CHANGED_FILES,
  DEFAULT_DELTA_RECHECK_MAX_CHANGED_LINES,
  REVIEW_FINDING_LEDGER_MODES,
  REVIEW_DELTA_RECHECK_MODES,
  REVIEW_TRIGGERS,
  type ReviewDeltaRecheckMode,
  type ReviewFindingLedgerMode,
  type ReviewTrigger
} from "../review/reviewConfig.js";

/**
 * `output` is the rendered text shown to humans. `data` carries the same
 * effective values as structured JSON for `--json` consumers; it is present
 * only for `config show`, since set/clear are single-line confirmations.
 */
export type ConfigCommandResult = Readonly<{
  output: string;
  data?: unknown;
}>;

type ConfigCommandStore = Readonly<{
  transaction<T>(execute: (store: ConfigCommandStore) => T): T;
  getConfig(): YuiConfig;
  saveConfig(config: YuiConfig): void;
  getGlobalRole?(name: string): Readonly<{ name: string }> | null;
}>;

/**
 * One uniform key model for every durable Yui setting. `config show` displays
 * each key's effective value, `config set <key> <value...>` updates one key,
 * and `config clear <key>` resets it to its documented default. Strategy
 * settings such as `review` and `leader-next-action` are keys like any other;
 * they deliberately have no separate command trees. The stored YuiConfig
 * shape is unchanged, so existing Homes keep working without migration.
 */
export const CONFIG_KEYS = [
  "time-zone",
  "reconciliation-interval-seconds",
  "leader-next-action",
  "context-budget",
  "resources-gc-mode",
  "resources-gc-auto-quarantine",
  "provider-retry-mode",
  "provider-retry-adapters",
  "provider-retry-max-window-ms",
  "yield-receipt-replay",
  "tmux-bin",
  "git-bin",
  "telemetry-mode",
  "telemetry-terminal-keep",
  "telemetry-run-cap",
  "review"
] as const;

export type ConfigKey = typeof CONFIG_KEYS[number];

const CONFIG_USAGE = "Config usage: yui config show | yui config set <key> <value...> | yui config clear <key>.";
const CONFIG_SET_USAGE = `Config set usage: yui config set <key> <value...>; keys: ${CONFIG_KEYS.join(", ")}.`;
const CONFIG_CLEAR_USAGE = `Config clear usage: yui config clear <key>; keys: ${CONFIG_KEYS.join(", ")}.`;

const TIME_ZONE_SET_USAGE = "Config set usage: yui config set time-zone <IANA timezone>.";
const RECONCILIATION_SET_USAGE = "Config set usage: yui config set reconciliation-interval-seconds <5-300>.";
const RESOURCES_GC_MODE_SET_USAGE = "Config set usage: yui config set resources-gc-mode <report|quarantine>.";
const RESOURCES_GC_AUTO_QUARANTINE_SET_USAGE = "Config set usage: yui config set resources-gc-auto-quarantine <true|false>.";
const LEADER_NEXT_ACTION_SET_USAGE = `Config set usage: yui config set leader-next-action <${LEADER_NEXT_ACTION_MODES.join("|")}>.`;
const CONTEXT_BUDGET_SET_USAGE = "Config set usage: yui config set context-budget [--soft-tokens <n>] [--hard-tokens <n>].";
const REVIEW_SET_USAGE = "Config set usage: yui config set review --role <global-role> --trigger <always|leader|final> "
  + "[--finding-ledger <shadow|enforce>] [--delta-recheck <enabled|disabled>] "
  + "[--delta-recheck-max-lines <n>] [--delta-recheck-max-files <n>].";

type ConfigKeyHandler = Readonly<{
  key: ConfigKey;
  showLabel: string;
  showValue(config: YuiConfig): string;
  set(args: string[], store: ConfigCommandStore): string;
  clear(store: ConfigCommandStore): string;
}>;

export function runConfigCommand(args: string[], store: ConfigCommandStore): ConfigCommandResult {
  const [command, ...rest] = args;
  if (command === "show") {
    if (rest.length !== 0) throw usageError("Config show usage: yui config show.");
    const config = store.getConfig();
    reconciliationIntervalMilliseconds(config.reconciliationIntervalSeconds);
    return { output: renderConfigShow(config), data: effectiveConfigData(config) };
  }
  if (command === "set") return { output: runConfigSet(rest, store) };
  if (command === "clear") return { output: runConfigClear(rest, store) };
  throw usageError(
    command === undefined ? "Config command is required." : `Unknown command: config ${command}`,
    CONFIG_USAGE
  );
}

/**
 * `config show` is row/column data, so it renders through the shared
 * `renderTable` like every other list command. The column contract follows
 * the shared rules: left-aligned cells, widths fitted between min/max,
 * terminal width from `defaultTableWidth()`, and empty values as empty cells.
 */
function renderConfigShow(config: YuiConfig): string {
  return renderTable(
    "Yui configuration",
    [
      { header: "Setting", minWidth: 20, maxWidth: 32 },
      { header: "Value", minWidth: 10, maxWidth: 60 }
    ],
    CONFIG_KEY_HANDLERS.map((handler) => [handler.showLabel, handler.showValue(config)]),
    defaultTableWidth()
  );
}

/** Effective values under the same field names as the stored YuiConfig. */
function effectiveConfigData(config: YuiConfig): Record<string, unknown> {
  return {
    timeZone: resolveTimeZone(config.timeZone),
    reconciliationIntervalSeconds: config.reconciliationIntervalSeconds
      ?? DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
    leaderNextActionMode: resolveLeaderNextActionMode(config.leaderNextActionMode),
    resourcesGcMode: resolveResourcesGcMode(config.resourcesGcMode),
    resourcesGcAutoQuarantine: resolveResourcesGcAutoQuarantine(config.resourcesGcAutoQuarantine),
    review: config.review === undefined
      ? null
      : {
          roleName: config.review.roleName,
          trigger: config.review.trigger,
          findingLedger: config.review.findingLedger ?? "shadow",
          deltaRecheck: config.review.deltaRecheck ?? "disabled",
          deltaRecheckMaxChangedLines: config.review.deltaRecheckMaxChangedLines
            ?? DEFAULT_DELTA_RECHECK_MAX_CHANGED_LINES,
          deltaRecheckMaxChangedFiles: config.review.deltaRecheckMaxChangedFiles
            ?? DEFAULT_DELTA_RECHECK_MAX_CHANGED_FILES
        }
  };
}

function runConfigSet(args: string[], store: ConfigCommandStore): string {
  const [key, ...values] = args;
  if (key === undefined) throw usageError(CONFIG_SET_USAGE);
  const handler = CONFIG_KEY_HANDLERS.find((entry) => entry.key === key);
  if (handler === undefined) {
    throw usageError(`Unknown config key: ${key}`, CONFIG_SET_USAGE);
  }
  return handler.set(values, store);
}

function runConfigClear(args: string[], store: ConfigCommandStore): string {
  const [key, ...rest] = args;
  if (key === undefined) throw usageError(CONFIG_CLEAR_USAGE);
  if (rest.length !== 0) throw usageError(`Config clear usage: yui config clear ${key}.`);
  const handler = CONFIG_KEY_HANDLERS.find((entry) => entry.key === key);
  if (handler === undefined) {
    throw usageError(`Unknown config key: ${key}`, CONFIG_CLEAR_USAGE);
  }
  return handler.clear(store);
}

function saveConfigKey(
  store: ConfigCommandStore,
  update: (config: YuiConfig) => YuiConfig
): void {
  store.transaction((tx) => {
    tx.saveConfig(update(tx.getConfig()));
  });
}

function validatedConfigValue<T>(validate: () => T, usage: string): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof TypeError) {
      throw usageError(error.message, usage);
    }
    throw error;
  }
}

function parseBudgetToken(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw usageError(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function parseReconciliationIntervalSeconds(value: string): number {
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}

function parseBooleanConfigValue(value: string): boolean | string {
  return value === "true" ? true : value === "false" ? false : value;
}

function parsePositiveIntegerOption(value: string | undefined, usage: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw usageError(usage);
  }
  return Number(value);
}

const CONFIG_KEY_HANDLERS: readonly ConfigKeyHandler[] = [
  {
    key: "time-zone",
    showLabel: "Time zone",
    showValue: (config) => resolveTimeZone(config.timeZone),
    set(args, store) {
      if (args.length !== 1) throw usageError(TIME_ZONE_SET_USAGE);
      const timeZone = validatedConfigValue(() => resolveTimeZone(args[0]), TIME_ZONE_SET_USAGE);
      saveConfigKey(store, (config) => ({ ...config, timeZone }));
      return `Time zone set to ${timeZone}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { timeZone: _removed, ...rest } = config;
        return rest;
      });
      return `Time zone reset to ${resolveTimeZone(undefined)}\n`;
    }
  },
  {
    key: "reconciliation-interval-seconds",
    showLabel: "Reconciliation interval",
    showValue: (config) =>
      `${config.reconciliationIntervalSeconds ?? DEFAULT_RECONCILIATION_INTERVAL_SECONDS} seconds`,
    set(args, store) {
      if (args.length !== 1) throw usageError(RECONCILIATION_SET_USAGE);
      const reconciliationIntervalSeconds = parseReconciliationIntervalSeconds(args[0]);
      validatedConfigValue(
        () => reconciliationIntervalMilliseconds(reconciliationIntervalSeconds),
        RECONCILIATION_SET_USAGE
      );
      saveConfigKey(store, (config) => ({ ...config, reconciliationIntervalSeconds }));
      return `Reconciliation interval set to ${reconciliationIntervalSeconds} seconds\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { reconciliationIntervalSeconds: _removed, ...rest } = config;
        return rest;
      });
      return `Reconciliation interval reset to ${DEFAULT_RECONCILIATION_INTERVAL_SECONDS} seconds\n`;
    }
  },
  {
    key: "leader-next-action",
    showLabel: "Leader next-action mode",
    showValue: (config) => resolveLeaderNextActionMode(config.leaderNextActionMode),
    set(args, store) {
      if (args.length !== 1) throw usageError(LEADER_NEXT_ACTION_SET_USAGE);
      let mode: LeaderNextActionMode;
      try {
        mode = resolveLeaderNextActionMode(args[0]);
      } catch (error) {
        throw usageError(
          error instanceof Error ? error.message : String(error),
          LEADER_NEXT_ACTION_SET_USAGE
        );
      }
      saveConfigKey(store, (config) => ({ ...config, leaderNextActionMode: mode }));
      return `Leader next-action mode set to ${mode}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { leaderNextActionMode: _removed, ...rest } = config;
        return rest;
      });
      return `Leader next-action mode reset to ${DEFAULT_LEADER_NEXT_ACTION_MODE}\n`;
    }
  },
  {
    key: "context-budget",
    showLabel: "Context budget",
    showValue: (config) => {
      const budget = resolveContextBudget(config.contextBudget);
      return `soft ${budget.softTokens} / hard ${budget.hardTokens} tokens`;
    },
    set(args, store) {
      if (args.length !== 2 && args.length !== 4) throw usageError(CONTEXT_BUDGET_SET_USAGE);
      const options = new Map<string, string>();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!["--soft-tokens", "--hard-tokens"].includes(name)
          || value === undefined
          || options.has(name)) {
          throw usageError(CONTEXT_BUDGET_SET_USAGE);
        }
        options.set(name, value);
      }
      const current = resolveContextBudget(store.getConfig().contextBudget);
      const next: ContextBudgetConfig = {
        ...(options.get("--soft-tokens") === undefined
          ? {}
          : { softTokens: parseBudgetToken(options.get("--soft-tokens")!, "--soft-tokens") }),
        ...(options.get("--hard-tokens") === undefined
          ? {}
          : { hardTokens: parseBudgetToken(options.get("--hard-tokens")!, "--hard-tokens") })
      };
      const resolved = resolveContextBudget({ ...current, ...next });
      saveConfigKey(store, (config) => ({ ...config, contextBudget: resolved }));
      return `Context budget set to soft ${resolved.softTokens} / hard ${resolved.hardTokens} tokens\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { contextBudget: _removed, ...rest } = config;
        return rest;
      });
      return `Context budget reset to soft ${DEFAULT_CONTEXT_SOFT_TOKENS} / hard ${DEFAULT_CONTEXT_HARD_TOKENS} tokens\n`;
    }
  },
  {
    key: "resources-gc-mode",
    showLabel: "Resources GC mode",
    showValue: (config) => resolveResourcesGcMode(config.resourcesGcMode),
    set(args, store) {
      if (args.length !== 1) throw usageError(RESOURCES_GC_MODE_SET_USAGE);
      const resourcesGcMode = validatedConfigValue(
        () => resolveResourcesGcMode(args[0]),
        RESOURCES_GC_MODE_SET_USAGE
      );
      saveConfigKey(store, (config) => ({ ...config, resourcesGcMode }));
      return `Resources GC mode set to ${resourcesGcMode}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { resourcesGcMode: _removed, ...rest } = config;
        return rest;
      });
      return `Resources GC mode reset to ${DEFAULT_RESOURCES_GC_MODE}\n`;
    }
  },
  {
    key: "resources-gc-auto-quarantine",
    showLabel: "Resources GC auto-quarantine",
    showValue: (config) =>
      (resolveResourcesGcAutoQuarantine(config.resourcesGcAutoQuarantine) ? "on" : "off"),
    set(args, store) {
      if (args.length !== 1) throw usageError(RESOURCES_GC_AUTO_QUARANTINE_SET_USAGE);
      const resourcesGcAutoQuarantine = validatedConfigValue(
        () => resolveResourcesGcAutoQuarantine(parseBooleanConfigValue(args[0])),
        RESOURCES_GC_AUTO_QUARANTINE_SET_USAGE
      );
      saveConfigKey(store, (config) => ({ ...config, resourcesGcAutoQuarantine }));
      return `Resources GC auto-quarantine set to ${resourcesGcAutoQuarantine ? "on" : "off"}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { resourcesGcAutoQuarantine: _removed, ...rest } = config;
        return rest;
      });
      return "Resources GC auto-quarantine reset to off\n";
    }
  },
  {
    key: "provider-retry-mode",
    showLabel: "Provider retry mode",
    showValue: (config) => resolveProviderRetryMode(config.providerRetryMode),
    set(args, store) {
      if (args.length !== 1) throw usageError(`Config set usage: yui config set provider-retry-mode <${PROVIDER_RETRY_MODES.join("|")}>.`);
      const mode = validatedConfigValue(
        () => resolveProviderRetryMode(args[0]),
        `Config set usage: yui config set provider-retry-mode <${PROVIDER_RETRY_MODES.join("|")}>.`
      );
      saveConfigKey(store, (config) => ({ ...config, providerRetryMode: mode }));
      return `Provider retry mode set to ${mode}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { providerRetryMode: _removed, ...rest } = config;
        return rest;
      });
      return `Provider retry mode reset to ${DEFAULT_PROVIDER_RETRY_MODE}\n`;
    }
  },
  {
    key: "provider-retry-adapters",
    showLabel: "Provider retry adapters",
    showValue: (config) => resolveProviderRetryAdapters(config.providerRetryAdapters).join(", ") || "none",
    set(args, store) {
      if (args.length !== 1) throw usageError("Config set usage: yui config set provider-retry-adapters <all|claude,codex|off>.");
      const raw = args[0].trim().toLowerCase();
      const adapters = raw === "off" || raw === "" || raw === "0"
        ? []
        : validatedConfigValue(
          () => resolveProviderRetryAdapters(raw.split(",")),
          "Config set usage: yui config set provider-retry-adapters <all|claude,codex|off>."
        );
      saveConfigKey(store, (config) => ({ ...config, providerRetryAdapters: adapters }));
      return `Provider retry adapters set to ${adapters.join(", ") || "none"}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { providerRetryAdapters: _removed, ...rest } = config;
        return rest;
      });
      return "Provider retry adapters reset to all supported\n";
    }
  },
  {
    key: "provider-retry-max-window-ms",
    showLabel: "Provider retry max window",
    showValue: (config) => `${resolveProviderRetryMaxWindowMs(config.providerRetryMaxWindowMs)} ms`,
    set(args, store) {
      if (args.length !== 1) throw usageError("Config set usage: yui config set provider-retry-max-window-ms <milliseconds>.");
      const maxWindowMs = validatedConfigValue(
        () => resolveProviderRetryMaxWindowMs(Number(args[0])),
        "Config set usage: yui config set provider-retry-max-window-ms <milliseconds>."
      );
      saveConfigKey(store, (config) => ({ ...config, providerRetryMaxWindowMs: maxWindowMs }));
      return `Provider retry max window set to ${maxWindowMs} ms\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { providerRetryMaxWindowMs: _removed, ...rest } = config;
        return rest;
      });
      return "Provider retry max window reset to default\n";
    }
  },
  {
    key: "yield-receipt-replay",
    showLabel: "Yield receipt replay",
    showValue: (config) => (resolveYieldReceiptReplay(config.yieldReceiptReplay) ? "on" : "off"),
    set(args, store) {
      if (args.length !== 1) throw usageError("Config set usage: yui config set yield-receipt-replay <true|false>.");
      const yieldReceiptReplay = validatedConfigValue(
        () => resolveYieldReceiptReplay(parseBooleanConfigValue(args[0])),
        "Config set usage: yui config set yield-receipt-replay <true|false>."
      );
      saveConfigKey(store, (config) => ({ ...config, yieldReceiptReplay }));
      return `Yield receipt replay set to ${yieldReceiptReplay ? "on" : "off"}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { yieldReceiptReplay: _removed, ...rest } = config;
        return rest;
      });
      return "Yield receipt replay reset to on\n";
    }
  },
  {
    key: "tmux-bin",
    showLabel: "Tmux bin",
    showValue: (config) => resolveTmuxBin(config.tmuxBin),
    set(args, store) {
      if (args.length !== 1) throw usageError("Config set usage: yui config set tmux-bin <path>.");
      const tmuxBin = validatedConfigValue(
        () => resolveTmuxBin(args[0]),
        "Config set usage: yui config set tmux-bin <path>."
      );
      saveConfigKey(store, (config) => ({ ...config, tmuxBin }));
      return `Tmux bin set to ${tmuxBin}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { tmuxBin: _removed, ...rest } = config;
        return rest;
      });
      return "Tmux bin reset to tmux\n";
    }
  },
  {
    key: "git-bin",
    showLabel: "Git bin",
    showValue: (config) => resolveGitBin(config.gitBin),
    set(args, store) {
      if (args.length !== 1) throw usageError("Config set usage: yui config set git-bin <path>.");
      const gitBin = validatedConfigValue(
        () => resolveGitBin(args[0]),
        "Config set usage: yui config set git-bin <path>."
      );
      saveConfigKey(store, (config) => ({ ...config, gitBin }));
      return `Git bin set to ${gitBin}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { gitBin: _removed, ...rest } = config;
        return rest;
      });
      return "Git bin reset to git\n";
    }
  },
  {
    key: "telemetry-mode",
    showLabel: "Telemetry mode",
    showValue: (config) => resolveTelemetryMode(config.telemetryMode),
    set(args, store) {
      if (args.length !== 1) throw usageError("Config set usage: yui config set telemetry-mode <legacy|dual|bounded>.");
      const telemetryMode = validatedConfigValue(
        () => resolveTelemetryMode(args[0]),
        "Config set usage: yui config set telemetry-mode <legacy|dual|bounded>."
      );
      saveConfigKey(store, (config) => ({ ...config, telemetryMode }));
      return `Telemetry mode set to ${telemetryMode}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { telemetryMode: _removed, ...rest } = config;
        return rest;
      });
      return "Telemetry mode reset to legacy\n";
    }
  },
  {
    key: "telemetry-terminal-keep",
    showLabel: "Telemetry terminal keep",
    showValue: (config) => String(resolveTelemetryTerminalKeep(config.telemetryTerminalKeep)),
    set(args, store) {
      if (args.length !== 1) throw usageError("Config set usage: yui config set telemetry-terminal-keep <n>.");
      const telemetryTerminalKeep = validatedConfigValue(
        () => resolveTelemetryTerminalKeep(Number(args[0])),
        "Config set usage: yui config set telemetry-terminal-keep <n>."
      );
      saveConfigKey(store, (config) => ({ ...config, telemetryTerminalKeep }));
      return `Telemetry terminal keep set to ${telemetryTerminalKeep}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { telemetryTerminalKeep: _removed, ...rest } = config;
        return rest;
      });
      return "Telemetry terminal keep reset to default\n";
    }
  },
  {
    key: "telemetry-run-cap",
    showLabel: "Telemetry run cap",
    showValue: (config) => String(resolveTelemetryRunCap(config.telemetryRunCap)),
    set(args, store) {
      if (args.length !== 1) throw usageError("Config set usage: yui config set telemetry-run-cap <n>.");
      const telemetryRunCap = validatedConfigValue(
        () => resolveTelemetryRunCap(Number(args[0])),
        "Config set usage: yui config set telemetry-run-cap <n>."
      );
      saveConfigKey(store, (config) => ({ ...config, telemetryRunCap }));
      return `Telemetry run cap set to ${telemetryRunCap}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { telemetryRunCap: _removed, ...rest } = config;
        return rest;
      });
      return "Telemetry run cap reset to default\n";
    }
  },
  {
    key: "review",

    showLabel: "Review",
    showValue: (config) => (config.review === undefined
      ? "disabled"
      : `${config.review.roleName} (${config.review.trigger}; finding ledger: ${config.review.findingLedger ?? "shadow"}`
        + `${config.review.deltaRecheck === "enabled" ? "; delta recheck: enabled" : ""})`),
    set(args, store) {
      if (args.length < 4 || args.length % 2 !== 0) throw usageError(REVIEW_SET_USAGE);
      const options = new Map<string, string>();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!["--role", "--trigger", "--finding-ledger", "--delta-recheck",
          "--delta-recheck-max-lines", "--delta-recheck-max-files"].includes(name)
          || value === undefined
          || options.has(name)) {
          throw usageError(REVIEW_SET_USAGE);
        }
        options.set(name, value);
      }
      const roleName = options.get("--role")?.trim();
      const rawTrigger = options.get("--trigger")?.trim();
      if (roleName === undefined || roleName.length === 0
        || rawTrigger === undefined
        || !REVIEW_TRIGGERS.includes(rawTrigger as ReviewTrigger)) {
        throw usageError(REVIEW_SET_USAGE);
      }
      if (store.getGlobalRole?.(roleName) === null) {
        throw usageError(`Global Role not found: ${roleName}.`);
      }
      const trigger = rawTrigger as ReviewTrigger;
      const rawLedgerMode = options.get("--finding-ledger")?.trim();
      let findingLedger: ReviewFindingLedgerMode | undefined;
      if (rawLedgerMode !== undefined) {
        if (!REVIEW_FINDING_LEDGER_MODES.includes(rawLedgerMode as ReviewFindingLedgerMode)) {
          throw usageError(REVIEW_SET_USAGE);
        }
        findingLedger = rawLedgerMode as ReviewFindingLedgerMode;
      }
      const rawDeltaRecheck = options.get("--delta-recheck")?.trim();
      let deltaRecheck: ReviewDeltaRecheckMode | undefined;
      if (rawDeltaRecheck !== undefined) {
        if (!REVIEW_DELTA_RECHECK_MODES.includes(rawDeltaRecheck as ReviewDeltaRecheckMode)) {
          throw usageError(REVIEW_SET_USAGE);
        }
        deltaRecheck = rawDeltaRecheck as ReviewDeltaRecheckMode;
      }
      const deltaRecheckMaxChangedLines = parsePositiveIntegerOption(
        options.get("--delta-recheck-max-lines"),
        REVIEW_SET_USAGE
      );
      const deltaRecheckMaxChangedFiles = parsePositiveIntegerOption(
        options.get("--delta-recheck-max-files"),
        REVIEW_SET_USAGE
      );
      saveConfigKey(store, (config) => ({
        ...config,
        review: {
          roleName,
          trigger,
          ...(findingLedger === undefined ? {} : { findingLedger }),
          ...(deltaRecheck === undefined ? {} : { deltaRecheck }),
          ...(deltaRecheckMaxChangedLines === undefined
            ? {}
            : { deltaRecheckMaxChangedLines }),
          ...(deltaRecheckMaxChangedFiles === undefined
            ? {}
            : { deltaRecheckMaxChangedFiles })
        }
      }));
      return `Review set to ${roleName} (${trigger}; finding ledger: ${findingLedger ?? "shadow"}; `
        + `delta recheck: ${deltaRecheck ?? "disabled"})\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { review: _removed, ...rest } = config;
        return rest;
      });
      return "Review disabled\n";
    }
  }
];
