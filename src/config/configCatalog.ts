import { supportedAgentAdapterIds } from "../agent/adapterCatalog.js";
import type { YuiConfig } from "../storage/taskStore.js";
import { MAX_RUN_CAP } from "../telemetry/telemetryConfig.js";
import {
  MAX_CONTEXT_BUDGET_TOKENS,
  MAX_PROVIDER_RETRY_ATTEMPTS,
  MIN_CONTEXT_BUDGET_TOKENS
} from "./yuiConfig.js";

export const CONFIG_DOMAINS = ["system", "runtime", "workflow", "resources", "tools"] as const;
export type ConfigDomain = typeof CONFIG_DOMAINS[number];

export type ConfigDefinition = Readonly<{
  key: string;
  domain: ConfigDomain;
  property: keyof YuiConfig;
  label: string;
  summary: string;
  takesEffect: string;
}>;

/**
 * Public durable configuration contract. CLI help, completion, config show,
 * config describe, and Operator guidance all project from this one catalog.
 * Runtime-only implementation constants deliberately do not appear here.
 */
export const CONFIG_DEFINITIONS = Object.freeze([
  { key: "default-agent", domain: "system", property: "defaultAgent", label: "Default Agent", summary: "Configured Agent used when a Task or Role does not select one explicitly.", takesEffect: "Future Role and Task defaults; existing bindings are unchanged." },
  { key: "default-workspace", domain: "system", property: "defaultWorkspace", label: "Default workspace", summary: "Absolute workspace root outside YUI_HOME used when no workspace is selected.", takesEffect: "Future workspace selection; existing Roles and worktrees are unchanged." },
  { key: "time-zone", domain: "system", property: "timeZone", label: "Time zone", summary: "IANA timezone for human-facing timestamps (default: Asia/Shanghai).", takesEffect: "The next human-readable timestamp rendering; durable JSON remains UTC." },

  { key: "reconciliation-interval-seconds", domain: "runtime", property: "reconciliationIntervalSeconds", label: "Reconciliation interval", summary: "Recovery reconciliation interval, 5-300 seconds (default: 120).", takesEffect: "The running Controller is refreshed after the value is saved." },
  { key: "controller-task-concurrency", domain: "runtime", property: "controllerTaskConcurrency", label: "Controller Task concurrency", summary: "Maximum Tasks reconciled concurrently, 1-32 (default: 4).", takesEffect: "After the Controller restarts." },
  { key: "runtime-health", domain: "runtime", property: "runtimeHealth", label: "Runtime health thresholds", summary: "Quiet, diagnostic, and semantic-stall thresholds in seconds; values must be strictly increasing (defaults: 300/600/1800).", takesEffect: "CLI and Web projections immediately; scheduler stall handling after the Controller restarts." },
  { key: "agent-launch-inactivity-timeout-seconds", domain: "runtime", property: "agentLaunchInactivityTimeoutSeconds", label: "Agent launch inactivity timeout", summary: "Maximum launch silence before startup fails, 15-3600 seconds (default: 300).", takesEffect: "After the Controller restarts." },
  { key: "delivery-timeout-seconds", domain: "runtime", property: "deliveryTimeoutSeconds", label: "Delivery timeout", summary: "Total control-plane delivery retry budget, 5-600 seconds (default: 120).", takesEffect: "After the Controller restarts; internal retry cadence remains automatic." },
  { key: "provider-retry-mode", domain: "runtime", property: "providerRetryMode", label: "Provider retry mode", summary: "Provider retry mode: off, shadow, or enforce (default: enforce).", takesEffect: "The next eligible provider-failure decision." },
  { key: "provider-retry-adapters", domain: "runtime", property: "providerRetryAdapters", label: "Provider retry adapters", summary: `Adapters with in-place retry: all, off, or a comma-separated subset of ${supportedAgentAdapterIds().join(", ")} (default: all).`, takesEffect: "The next eligible provider-failure decision." },
  { key: "provider-retry-delays-seconds", domain: "runtime", property: "providerRetryDelaysSeconds", label: "Provider retry delays", summary: `Ordered comma-separated retry delays of 1-600 seconds, with 1-${MAX_PROVIDER_RETRY_ATTEMPTS} attempts (default: 2,5,15).`, takesEffect: "The next eligible provider-failure decision; attempt count is the list length." },
  { key: "provider-retry-max-window-seconds", domain: "runtime", property: "providerRetryMaxWindowSeconds", label: "Provider retry max window", summary: "Positive-integer total retry budget per Run lineage in seconds (default: 600).", takesEffect: "The next retry episode; an active episode keeps its existing deadline." },

  { key: "leader-next-action", domain: "workflow", property: "leaderNextActionMode", label: "Leader next-action mode", summary: "Leader next-action mode: display, warn, or enforce (default: display).", takesEffect: "The next Leader next-action projection or gate." },
  { key: "leader-semantic-budget-turns", domain: "workflow", property: "leaderSemanticBudgetTurns", label: "Leader semantic budget", summary: "Consecutive yielded Leader turns without durable delivery progress before warning, 1-20 (default: 3).", takesEffect: "The next Leader delivery guard evaluation." },
  { key: "context-budget", domain: "workflow", property: "contextBudget", label: "Legacy context budget (inactive)", summary: `Compatibility-only soft and hard values in ${MIN_CONTEXT_BUDGET_TOKENS}-${MAX_CONTEXT_BUDGET_TOKENS}; they are parsed but never control Session or workflow behavior.`, takesEffect: "No runtime effect; Session Token metrics are read-only observations." },
  { key: "review", domain: "workflow", property: "review", label: "Review", summary: "Optional global WorkItem review rule: a configured Role plus always, leader, or final trigger; optional finding-ledger and delta-recheck controls. Setup leaves it disabled so the Leader may review directly or delegate selectively.", takesEffect: "The next Candidate snapshot; in-flight Candidates and ReviewRounds keep their policy." },

  { key: "resources-gc-mode", domain: "resources", property: "resourcesGcMode", label: "Resources GC mode", summary: "Resource GC mode: report or quarantine (default: report).", takesEffect: "The next resource GC operation." },
  { key: "resources-gc-auto-quarantine", domain: "resources", property: "resourcesGcAutoQuarantine", label: "Resources GC auto-quarantine", summary: "Automatically quarantine eligible terminal Task resources (default: false).", takesEffect: "The next eligible automatic resource GC operation." },
  { key: "resources-quarantine-ttl-hours", domain: "resources", property: "resourcesQuarantineTtlHours", label: "Resource quarantine TTL", summary: "Default observation window before purge, 1-720 hours (default: 24).", takesEffect: "The next resource GC command without an explicit TTL override." },

  { key: "tmux-bin", domain: "tools", property: "tmuxBin", label: "Tmux bin", summary: "Command or path to the tmux binary (default: tmux).", takesEffect: "The next CLI-owned tmux invocation; restart the Controller for Controller-owned launches." },
  { key: "tmux-history-limit", domain: "tools", property: "tmuxHistoryLimit", label: "Tmux history limit", summary: "History lines retained for newly created tmux sessions, 1000-1000000 (default: 100000).", takesEffect: "New tmux sessions; existing sessions report drift until recreated." },
  { key: "telemetry-enabled", domain: "tools", property: "telemetryEnabled", label: "Diagnostic telemetry", summary: "Enable the optional SQLite diagnostic telemetry projection (default: false); requires a SQLite Home.", takesEffect: "Standalone telemetry commands immediately; scheduler writes after Controller restart." },
  { key: "telemetry-terminal-keep", domain: "tools", property: "telemetryTerminalKeep", label: "Telemetry terminal keep", summary: "Positive-integer rows retained per terminal Run generation (default: 200).", takesEffect: "Explicit retention immediately; automatic retention after the Controller restarts." },
  { key: "telemetry-run-cap", domain: "tools", property: "telemetryRunCap", label: "Telemetry Run cap", summary: `Positive-integer maximum rows retained per Run, at most ${MAX_RUN_CAP} (default: 50000).`, takesEffect: "Explicit retention immediately; automatic write-time capping after the Controller restarts." }
] as const satisfies readonly ConfigDefinition[]);

export type ConfigKey = typeof CONFIG_DEFINITIONS[number]["key"];
export const CONFIG_KEYS = Object.freeze(CONFIG_DEFINITIONS.map(({ key }) => key)) as readonly ConfigKey[];

export function configDefinitionsForDomain(domain: ConfigDomain): readonly ConfigDefinition[] {
  return CONFIG_DEFINITIONS.filter((definition) => definition.domain === domain);
}

export function configDefinition(key: string): ConfigDefinition | undefined {
  return CONFIG_DEFINITIONS.find((definition) => definition.key === key);
}
