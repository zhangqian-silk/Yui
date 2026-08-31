import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { usageError } from "../errors/cliError.js";
import {
  DEFAULT_AGENT_LAUNCH_INACTIVITY_TIMEOUT_SECONDS,
  DEFAULT_CONTROLLER_TASK_CONCURRENCY,
  DEFAULT_DELIVERY_TIMEOUT_SECONDS,
  DEFAULT_LEADER_NEXT_ACTION_MODE,
  DEFAULT_LEADER_SEMANTIC_BUDGET_TURNS,
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  DEFAULT_RESOURCES_GC_MODE,
  DEFAULT_RESOURCES_QUARANTINE_TTL_HOURS,
  DEFAULT_TMUX_HISTORY_LIMIT,
  LEADER_NEXT_ACTION_MODES,
  reconciliationIntervalMilliseconds,
  resolveAgentLaunchInactivityTimeoutSeconds,
  resolveControllerTaskConcurrency,
  resolveContextBudget,
  resolveDeliveryTimeoutSeconds,
  resolveLeaderNextActionMode,
  resolveLeaderSemanticBudgetTurns,
  resolveResourcesGcAutoQuarantine,
  resolveResourcesGcMode,
  resolveResourcesQuarantineTtlHours,
  resolveRuntimeHealth,
  resolveTelemetryEnabled,
  resolveTelemetryRunCap,
  resolveTelemetryTerminalKeep,
  resolveTmuxBin,
  resolveTmuxHistoryLimit,
  type ContextBudgetConfig,
  type LeaderNextActionMode
} from "../config/yuiConfig.js";
import {
  CONFIG_DEFINITIONS,
  CONFIG_KEYS,
  configDefinition,
  configDefinitionsForDomain,
  type ConfigDomain,
  type ConfigKey
} from "../config/configCatalog.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { YuiConfig } from "../storage/taskStore.js";
import {
  REVIEW_FINDING_LEDGER_MODES,
  REVIEW_TRIGGERS,
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
  getConfiguredAgent?(id: string): Readonly<{ id: string }> | null;
  rootDirectory?(): string;
}>;

/**
 * One uniform key model for every durable setting. Each catalog domain uses
 * the same show/set/clear contract; strategy settings such as `review` and
 * `leader-next-action` are keys like any other.
 */
export { CONFIG_KEYS } from "../config/configCatalog.js";
export type { ConfigKey } from "../config/configCatalog.js";

const CONFIG_PROPERTIES = Object.fromEntries(CONFIG_DEFINITIONS.map(({ key, property }) => [
  key,
  property
])) as Readonly<Record<ConfigKey, keyof YuiConfig>>;

const TIME_ZONE_SET_USAGE = "System config set usage: yui config system set time-zone <IANA timezone>.";
const RECONCILIATION_SET_USAGE = "Runtime config set usage: yui config runtime set reconciliation-interval-seconds <5-300>.";
const RESOURCES_GC_MODE_SET_USAGE = "Resources config set usage: yui config resources set resources-gc-mode <report|quarantine>.";
const RESOURCES_GC_AUTO_QUARANTINE_SET_USAGE = "Resources config set usage: yui config resources set resources-gc-auto-quarantine <true|false>.";
const LEADER_NEXT_ACTION_SET_USAGE = `Workflow config set usage: yui config workflow set leader-next-action <${LEADER_NEXT_ACTION_MODES.join("|")}>.`;
const CONTEXT_BUDGET_SET_USAGE = "Workflow config set usage: yui config workflow set context-budget [--soft-tokens <n>] [--hard-tokens <n>].";
const REVIEW_SET_USAGE = "Workflow config set usage: yui config workflow set review --role <global-role> --trigger <always|leader|final> "
  + "[--finding-ledger <shadow|enforce>].";

type ConfigKeyHandler = Readonly<{
  key: ConfigKey;
  showLabel: string;
  showValue(config: YuiConfig): string;
  set(args: string[], store: ConfigCommandStore): string;
  clear(store: ConfigCommandStore): string;
}>;

export function runConfigCommand(
  domain: ConfigDomain,
  args: string[],
  store: ConfigCommandStore
): ConfigCommandResult {
  const keys = configDefinitionsForDomain(domain).map(({ key }) => key);
  const usage = `${capitalize(domain)} config usage: yui config ${domain} show | yui config ${domain} set <key> <value...> | yui config ${domain} clear <key>.`;
  const [command, ...rest] = args;
  if (command === "show") {
    if (rest.length !== 0) throw usageError(`${capitalize(domain)} config show usage: yui config ${domain} show.`);
    const config = store.getConfig();
    reconciliationIntervalMilliseconds(config.reconciliationIntervalSeconds);
    return { output: renderConfigShow(domain, config), data: effectiveConfigData(config, domain) };
  }
  if (command === "set") return { output: runConfigSet(domain, keys, rest, store) };
  if (command === "clear") return { output: runConfigClear(domain, keys, rest, store) };
  throw usageError(
    command === undefined ? `${capitalize(domain)} config command is required.` : `Unknown command: config ${domain} ${command}`,
    usage
  );
}

/**
 * A domain `show` is row/column data, so it renders through the shared
 * `renderTable` like every other list command. The column contract follows
 * the shared rules: left-aligned cells, widths fitted between min/max,
 * terminal width from `defaultTableWidth()`, and empty values as empty cells.
 */
function renderConfigShow(domain: ConfigDomain, config: YuiConfig): string {
  return renderTable(
    `Yui ${domain} configuration`,
    [
      { header: "Setting", minWidth: 20, maxWidth: 32 },
      { header: "Value", minWidth: 10, maxWidth: 60 }
    ],
    CONFIG_KEY_HANDLERS
      .filter(({ key }) => configDefinition(key)?.domain === domain)
      .map((handler) => [handler.showLabel, handler.showValue(config)]),
    defaultTableWidth()
  );
}

/** Effective values for every user-configurable system field. */
export function effectiveConfigData(
  config: YuiConfig,
  domain: ConfigDomain
): Record<string, unknown> {
  const budget = resolveContextBudget(config.contextBudget);
  const health = resolveRuntimeHealth(config.runtimeHealth);
  const all: Record<keyof YuiConfig, unknown> = {
    schemaVersion: config.schemaVersion,
    defaultAgent: config.defaultAgent ?? null,
    defaultWorkspace: config.defaultWorkspace ?? null,
    timeZone: resolveTimeZone(config.timeZone),
    currentTaskId: config.currentTaskId ?? null,
    lastTaskId: config.lastTaskId ?? null,
    reconciliationIntervalSeconds: config.reconciliationIntervalSeconds
      ?? DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
    leaderNextActionMode: resolveLeaderNextActionMode(config.leaderNextActionMode),
    contextBudget: { softTokens: budget.softTokens, hardTokens: budget.hardTokens },
    resourcesGcMode: resolveResourcesGcMode(config.resourcesGcMode),
    resourcesGcAutoQuarantine: resolveResourcesGcAutoQuarantine(config.resourcesGcAutoQuarantine),
    resourcesQuarantineTtlHours: resolveResourcesQuarantineTtlHours(config.resourcesQuarantineTtlHours),
    runtimeHealth: {
      quietAfterSeconds: health.quietAfterMs / 1_000,
      diagnosticAfterSeconds: health.diagnosticAfterMs / 1_000,
      stallAfterSeconds: health.stallWindowMs / 1_000
    },
    controllerTaskConcurrency: resolveControllerTaskConcurrency(config.controllerTaskConcurrency),
    agentLaunchInactivityTimeoutSeconds: resolveAgentLaunchInactivityTimeoutSeconds(
      config.agentLaunchInactivityTimeoutSeconds
    ),
    deliveryTimeoutSeconds: resolveDeliveryTimeoutSeconds(config.deliveryTimeoutSeconds),
    leaderSemanticBudgetTurns: resolveLeaderSemanticBudgetTurns(config.leaderSemanticBudgetTurns),
    tmuxBin: resolveTmuxBin(config.tmuxBin),
    tmuxHistoryLimit: resolveTmuxHistoryLimit(config.tmuxHistoryLimit),
    telemetryEnabled: resolveTelemetryEnabled(config.telemetryEnabled),
    telemetryTerminalKeep: resolveTelemetryTerminalKeep(config.telemetryTerminalKeep),
    telemetryRunCap: resolveTelemetryRunCap(config.telemetryRunCap),
    review: config.review === undefined
      ? null
      : {
          roleName: config.review.roleName,
          trigger: config.review.trigger,
          findingLedger: config.review.findingLedger ?? "shadow"
        },
    completionInstallations: config.completionInstallations ?? {}
  };
  const definitions = configDefinitionsForDomain(domain);
  return {
    ...Object.fromEntries(definitions.map(({ property }) => [property, all[property]])),
    valueSources: Object.fromEntries(definitions.map(({ key }) => {
      const typedKey = key as ConfigKey;
      return [
        key,
        config[CONFIG_PROPERTIES[typedKey]] === undefined ? "default" : "stored"
      ];
    }))
  };
}

function runConfigSet(
  domain: ConfigDomain,
  keys: readonly string[],
  args: string[],
  store: ConfigCommandStore
): string {
  const [key, ...values] = args;
  const usage = `${capitalize(domain)} config set usage: yui config ${domain} set <key> <value...>; keys: ${keys.join(", ")}.`;
  if (key === undefined) throw usageError(usage);
  const handler = CONFIG_KEY_HANDLERS.find((entry) => entry.key === key);
  if (handler === undefined || !keys.includes(key)) {
    throw usageError(`Unknown ${domain} config key: ${key}`, usage);
  }
  return handler.set(values, store);
}

function runConfigClear(
  domain: ConfigDomain,
  keys: readonly string[],
  args: string[],
  store: ConfigCommandStore
): string {
  const [key, ...rest] = args;
  const usage = `${capitalize(domain)} config clear usage: yui config ${domain} clear <key>; keys: ${keys.join(", ")}.`;
  if (key === undefined) throw usageError(usage);
  if (rest.length !== 0) throw usageError(`${capitalize(domain)} config clear usage: yui config ${domain} clear ${key}.`);
  const handler = CONFIG_KEY_HANDLERS.find((entry) => entry.key === key);
  if (handler === undefined || !keys.includes(key)) {
    throw usageError(`Unknown ${domain} config key: ${key}`, usage);
  }
  return handler.clear(store);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
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

const CONFIG_KEY_HANDLERS: readonly ConfigKeyHandler[] = [
  {
    key: "default-agent",
    showLabel: "Default Agent",
    showValue: (config) => config.defaultAgent ?? "not configured",
    set(args, store) {
      if (args.length !== 1 || args[0].trim().length === 0) {
        throw usageError("System config set usage: yui config system set default-agent <agent-id>.");
      }
      const defaultAgent = args[0].trim();
      if (store.getConfiguredAgent?.(defaultAgent) === null) {
        throw usageError(`Configured Agent not found: ${defaultAgent}.`);
      }
      saveConfigKey(store, (config) => ({ ...config, defaultAgent }));
      return `Default Agent set to ${defaultAgent}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { defaultAgent: _removed, ...rest } = config;
        return rest;
      });
      return "Default Agent cleared\n";
    }
  },
  {
    key: "default-workspace",
    showLabel: "Default workspace",
    showValue: (config) => config.defaultWorkspace ?? "not configured",
    set(args, store) {
      if (args.length !== 1 || !isAbsolute(args[0])) {
        throw usageError(
          "System config set usage: yui config system set default-workspace <absolute-path>."
        );
      }
      const defaultWorkspace = resolveDefaultWorkspace(args[0], store);
      saveConfigKey(store, (config) => ({ ...config, defaultWorkspace }));
      return `Default workspace set to ${defaultWorkspace}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { defaultWorkspace: _removed, ...rest } = config;
        return rest;
      });
      return "Default workspace cleared\n";
    }
  },
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
    key: "leader-semantic-budget-turns",
    showLabel: "Leader semantic budget",
    showValue: (config) => `${resolveLeaderSemanticBudgetTurns(config.leaderSemanticBudgetTurns)} turns`,
    set(args, store) {
      const usage = "Workflow config set usage: yui config workflow set leader-semantic-budget-turns <1-20>.";
      if (args.length !== 1) throw usageError(usage);
      const leaderSemanticBudgetTurns = validatedConfigValue(
        () => resolveLeaderSemanticBudgetTurns(Number(args[0])),
        usage
      );
      saveConfigKey(store, (config) => ({ ...config, leaderSemanticBudgetTurns }));
      return `Leader semantic budget set to ${leaderSemanticBudgetTurns} turns\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { leaderSemanticBudgetTurns: _removed, ...rest } = config;
        return rest;
      });
      return `Leader semantic budget reset to ${DEFAULT_LEADER_SEMANTIC_BUDGET_TURNS} turns\n`;
    }
  },
  {
    key: "context-budget",
    showLabel: "Legacy context budget (inactive)",
    showValue: (config) => {
      const budget = resolveContextBudget(config.contextBudget);
      return `inactive; legacy soft ${budget.softTokens} / hard ${budget.hardTokens} tokens`;
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
      return `Legacy context budget stored as soft ${resolved.softTokens} / hard ${resolved.hardTokens} tokens (inactive)\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { contextBudget: _removed, ...rest } = config;
        return rest;
      });
      return "Legacy context budget cleared; Session Token metrics remain read-only\n";
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
    key: "resources-quarantine-ttl-hours",
    showLabel: "Resource quarantine TTL",
    showValue: (config) => `${resolveResourcesQuarantineTtlHours(config.resourcesQuarantineTtlHours)} hours`,
    set(args, store) {
      const usage = "Resources config set usage: yui config resources set resources-quarantine-ttl-hours <1-720>.";
      if (args.length !== 1) throw usageError(usage);
      const resourcesQuarantineTtlHours = validatedConfigValue(
        () => resolveResourcesQuarantineTtlHours(Number(args[0])),
        usage
      );
      saveConfigKey(store, (config) => ({ ...config, resourcesQuarantineTtlHours }));
      return `Resource quarantine TTL set to ${resourcesQuarantineTtlHours} hours\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { resourcesQuarantineTtlHours: _removed, ...rest } = config;
        return rest;
      });
      return `Resource quarantine TTL reset to ${DEFAULT_RESOURCES_QUARANTINE_TTL_HOURS} hours\n`;
    }
  },
  {
    key: "controller-task-concurrency",
    showLabel: "Controller Task concurrency",
    showValue: (config) => String(resolveControllerTaskConcurrency(config.controllerTaskConcurrency)),
    set(args, store) {
      const usage = "Runtime config set usage: yui config runtime set controller-task-concurrency <1-32>.";
      if (args.length !== 1) throw usageError(usage);
      const controllerTaskConcurrency = validatedConfigValue(
        () => resolveControllerTaskConcurrency(Number(args[0])),
        usage
      );
      saveConfigKey(store, (config) => ({ ...config, controllerTaskConcurrency }));
      return `Controller Task concurrency set to ${controllerTaskConcurrency}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { controllerTaskConcurrency: _removed, ...rest } = config;
        return rest;
      });
      return `Controller Task concurrency reset to ${DEFAULT_CONTROLLER_TASK_CONCURRENCY}\n`;
    }
  },
  {
    key: "runtime-health",
    showLabel: "Runtime health thresholds",
    showValue: (config) => {
      const health = resolveRuntimeHealth(config.runtimeHealth);
      return `quiet ${health.quietAfterMs / 1_000}s / diagnostic ${health.diagnosticAfterMs / 1_000}s / stall ${health.stallWindowMs / 1_000}s`;
    },
    set(args, store) {
      const usage = "Runtime config set usage: yui config runtime set runtime-health --quiet-after-seconds <n> --diagnostic-after-seconds <n> --stall-after-seconds <n>.";
      if (args.length !== 6) throw usageError(usage);
      const options = new Map<string, number>();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index]!;
        const value = Number(args[index + 1]);
        if (!["--quiet-after-seconds", "--diagnostic-after-seconds", "--stall-after-seconds"].includes(name)
          || options.has(name)) throw usageError(usage);
        options.set(name, value);
      }
      const resolved = validatedConfigValue(() => resolveRuntimeHealth({
        quietAfterSeconds: options.get("--quiet-after-seconds"),
        diagnosticAfterSeconds: options.get("--diagnostic-after-seconds"),
        stallAfterSeconds: options.get("--stall-after-seconds")
      }), usage);
      const runtimeHealth = {
        quietAfterSeconds: resolved.quietAfterMs / 1_000,
        diagnosticAfterSeconds: resolved.diagnosticAfterMs / 1_000,
        stallAfterSeconds: resolved.stallWindowMs / 1_000
      };
      saveConfigKey(store, (config) => ({ ...config, runtimeHealth }));
      return `Runtime health thresholds set to quiet ${runtimeHealth.quietAfterSeconds}s / diagnostic ${runtimeHealth.diagnosticAfterSeconds}s / stall ${runtimeHealth.stallAfterSeconds}s\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { runtimeHealth: _removed, ...rest } = config;
        return rest;
      });
      return "Runtime health thresholds reset to quiet 300s / diagnostic 900s / stall 1800s\n";
    }
  },
  {
    key: "agent-launch-inactivity-timeout-seconds",
    showLabel: "Agent launch inactivity timeout",
    showValue: (config) => `${resolveAgentLaunchInactivityTimeoutSeconds(config.agentLaunchInactivityTimeoutSeconds)} seconds`,
    set(args, store) {
      const usage = "Runtime config set usage: yui config runtime set agent-launch-inactivity-timeout-seconds <15-3600>.";
      if (args.length !== 1) throw usageError(usage);
      const agentLaunchInactivityTimeoutSeconds = validatedConfigValue(
        () => resolveAgentLaunchInactivityTimeoutSeconds(Number(args[0])),
        usage
      );
      saveConfigKey(store, (config) => ({ ...config, agentLaunchInactivityTimeoutSeconds }));
      return `Agent launch inactivity timeout set to ${agentLaunchInactivityTimeoutSeconds} seconds\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { agentLaunchInactivityTimeoutSeconds: _removed, ...rest } = config;
        return rest;
      });
      return `Agent launch inactivity timeout reset to ${DEFAULT_AGENT_LAUNCH_INACTIVITY_TIMEOUT_SECONDS} seconds\n`;
    }
  },
  {
    key: "delivery-timeout-seconds",
    showLabel: "Delivery timeout",
    showValue: (config) => `${resolveDeliveryTimeoutSeconds(config.deliveryTimeoutSeconds)} seconds`,
    set(args, store) {
      const usage = "Runtime config set usage: yui config runtime set delivery-timeout-seconds <5-600>.";
      if (args.length !== 1) throw usageError(usage);
      const deliveryTimeoutSeconds = validatedConfigValue(
        () => resolveDeliveryTimeoutSeconds(Number(args[0])),
        usage
      );
      saveConfigKey(store, (config) => ({ ...config, deliveryTimeoutSeconds }));
      return `Delivery timeout set to ${deliveryTimeoutSeconds} seconds\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { deliveryTimeoutSeconds: _removed, ...rest } = config;
        return rest;
      });
      return `Delivery timeout reset to ${DEFAULT_DELIVERY_TIMEOUT_SECONDS} seconds\n`;
    }
  },
  {
    key: "tmux-bin",
    showLabel: "Tmux bin",
    showValue: (config) => resolveTmuxBin(config.tmuxBin),
    set(args, store) {
      if (args.length !== 1) throw usageError("Tools config set usage: yui config tools set tmux-bin <path>.");
      const tmuxBin = validatedConfigValue(
        () => resolveTmuxBin(args[0]),
        "Tools config set usage: yui config tools set tmux-bin <path>."
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
    key: "tmux-history-limit",
    showLabel: "Tmux history limit",
    showValue: (config) => String(resolveTmuxHistoryLimit(config.tmuxHistoryLimit)),
    set(args, store) {
      const usage = "Tools config set usage: yui config tools set tmux-history-limit <1000-1000000>.";
      if (args.length !== 1) throw usageError(usage);
      const tmuxHistoryLimit = validatedConfigValue(
        () => resolveTmuxHistoryLimit(Number(args[0])),
        usage
      );
      saveConfigKey(store, (config) => ({ ...config, tmuxHistoryLimit }));
      return `Tmux history limit set to ${tmuxHistoryLimit}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { tmuxHistoryLimit: _removed, ...rest } = config;
        return rest;
      });
      return `Tmux history limit reset to ${DEFAULT_TMUX_HISTORY_LIMIT}\n`;
    }
  },
  {
    key: "telemetry-enabled",
    showLabel: "Diagnostic telemetry",
    showValue: (config) => (resolveTelemetryEnabled(config.telemetryEnabled) ? "on" : "off"),
    set(args, store) {
      const usage = "Tools config set usage: yui config tools set telemetry-enabled <true|false>.";
      if (args.length !== 1) throw usageError(usage);
      const telemetryEnabled = validatedConfigValue(
        () => resolveTelemetryEnabled(parseBooleanConfigValue(args[0])),
        usage
      );
      saveConfigKey(store, (config) => ({ ...config, telemetryEnabled }));
      return `Diagnostic telemetry set to ${telemetryEnabled ? "on" : "off"}\n`;
    },
    clear(store) {
      saveConfigKey(store, (config) => {
        const { telemetryEnabled: _removed, ...rest } = config;
        return rest;
      });
      return "Diagnostic telemetry reset to off\n";
    }
  },
  {
    key: "telemetry-terminal-keep",
    showLabel: "Telemetry terminal keep",
    showValue: (config) => String(resolveTelemetryTerminalKeep(config.telemetryTerminalKeep)),
    set(args, store) {
      if (args.length !== 1) throw usageError("Tools config set usage: yui config tools set telemetry-terminal-keep <n>.");
      const telemetryTerminalKeep = validatedConfigValue(
        () => resolveTelemetryTerminalKeep(Number(args[0])),
        "Tools config set usage: yui config tools set telemetry-terminal-keep <n>."
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
      if (args.length !== 1) throw usageError("Tools config set usage: yui config tools set telemetry-run-cap <n>.");
      const telemetryRunCap = validatedConfigValue(
        () => resolveTelemetryRunCap(Number(args[0])),
        "Tools config set usage: yui config tools set telemetry-run-cap <n>."
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
        + ")"),
    set(args, store) {
      if (args.length < 4 || args.length % 2 !== 0) throw usageError(REVIEW_SET_USAGE);
      const options = new Map<string, string>();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!["--role", "--trigger", "--finding-ledger"].includes(name)
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
      saveConfigKey(store, (config) => ({
        ...config,
        review: {
          roleName,
          trigger,
          ...(findingLedger === undefined ? {} : { findingLedger })
        }
      }));
      return `Review set to ${roleName} (${trigger}; finding ledger: ${findingLedger ?? "shadow"})\n`;
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

const configuredHandlerKeys = new Set(CONFIG_KEY_HANDLERS.map(({ key }) => key));
const missingConfigHandlers = CONFIG_KEYS.filter((key) => !configuredHandlerKeys.has(key));
const duplicateConfigHandlers = CONFIG_KEY_HANDLERS
  .map(({ key }) => key)
  .filter((key, index, keys) => keys.indexOf(key) !== index);
if (missingConfigHandlers.length > 0 || duplicateConfigHandlers.length > 0) {
  throw new Error(
    `Config handler/catalog drift: missing=${missingConfigHandlers.join(",") || "none"}; `
    + `duplicate=${duplicateConfigHandlers.join(",") || "none"}.`
  );
}

function resolveDefaultWorkspace(value: string, store: ConfigCommandStore): string {
  const requested = resolve(value);
  if (store.rootDirectory === undefined) return requested;
  const requestedHome = resolve(store.rootDirectory());
  assertWorkspaceOutsideHome(requested, requestedHome);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const workspace = realpathSync(requested);
  const home = realpathSync(requestedHome);
  assertWorkspaceOutsideHome(workspace, home);
  return workspace;
}

function assertWorkspaceOutsideHome(workspace: string, home: string): void {
  const fromHome = relative(home, workspace);
  if (fromHome === "" || (!fromHome.startsWith("..") && !isAbsolute(fromHome))) {
    throw usageError("Default workspace must be outside YUI_HOME.");
  }
}
