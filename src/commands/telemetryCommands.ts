import { join } from "node:path";

import { usageError } from "../errors/cliError.js";
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  type TaskStore,
  type YuiConfig
} from "../storage/taskStore.js";
import { CURRENT_DATABASE_FILENAME as COMMITTED_DATABASE_FILENAME } from "../storage/currentTaskStore.js";
import {
  DEFAULT_TURN_CAP,
  DEFAULT_TERMINAL_KEEP,
  resolveTurnCap,
  resolveTerminalKeep
} from "../telemetry/telemetryConfig.js";
import { resolveTelemetryEnabled } from "../config/yuiConfig.js";
import { SqliteTelemetryStore } from "../telemetry/sqliteTelemetryStore.js";

/**
 * `yui telemetry status|prune|read` — operational surface for telemetry in the
 * current Home's authoritative `yui.db`.
 */

export type TelemetryCommandOptions = Readonly<{
  home: string;
  json?: boolean;
  environment?: NodeJS.ProcessEnv;
  store?: TaskStore;
}>;

/** Read the durable config, falling back to defaults when no store is available. */
function storeConfig(options: TelemetryCommandOptions): YuiConfig {
  return options.store?.getConfig() ?? { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION };
}

function telemetryMode(config: YuiConfig): "off" | "on" {
  return resolveTelemetryEnabled(config.telemetryEnabled) ? "on" : "off";
}

export async function runTelemetryCommand(
  args: string[],
  options: TelemetryCommandOptions
): Promise<string> {
  const [command, ...rest] = args;
  if (command === "status") return telemetryStatus(rest, options);
  if (command === "prune") return telemetryPrune(rest, options);
  if (command === "read") return telemetryRead(rest, options);
  throw usageError(
    command === undefined
      ? "Telemetry command is required: status, prune, or read."
      : `Unknown command: telemetry ${command}`,
    "yui telemetry status [--json]\n"
      + "yui telemetry prune [--task <id>] [--keep <n>] [--dry-run] [--json]\n"
      + "yui telemetry read --task <id> [--turn <id>] [--aggregate] [--limit <n>] [--offset <n>]"
  );
}

// -- status ---------------------------------------------------------------------

function telemetryStatus(args: string[], options: TelemetryCommandOptions): string {
  const flags = parseFlags(args, new Set([]));

  const mode = telemetryMode(storeConfig(options));
  const telemetry = new SqliteTelemetryStore(options.home, {
    mode,
    terminalKeep: resolveTerminalKeep(storeConfig(options).telemetryTerminalKeep),
    turnCap: resolveTurnCap(storeConfig(options).telemetryTurnCap)
  });
  try {
    const health = telemetry.health();
    const store = options.store;
    const perTask = store === undefined
      ? []
      : store.listTasks().map((task) => ({
          taskId: task.id,
          rows: telemetry.count(task.id),
          turns: telemetry.listTurnAggregates(task.id).length
        }));
    const report = {
      mode,
      database: join(options.home, COMMITTED_DATABASE_FILENAME),
      available: health.available,
      dropped: health.dropped,
      coalesced: health.coalesced,
      lastError: health.lastError,
      totalRows: health.rows,
      terminalKeep: resolveTerminalKeep(storeConfig(options).telemetryTerminalKeep),
      turnCap: resolveTurnCap(storeConfig(options).telemetryTurnCap),
      tasks: perTask
    };
    if (options.json || flags.has("json")) return JSON.stringify(report, null, 2);
    const lines = [
      `Mode:            ${mode}`,
      `Database:        ${report.database}`,
      `Available:       ${health.available ? "yes" : "no"}`,
      `Rows:            ${health.rows}`,
      `Dropped:         ${health.dropped}`,
      `Coalesced:       ${health.coalesced}`,
      ...(health.lastError === null ? [] : [`Last error:      ${health.lastError}`]),
      `Terminal keep:   ${report.terminalKeep}`,
      `Turn cap:        ${report.turnCap}`
    ];
    for (const task of perTask) {
      lines.push(`  ${task.taskId}: ${task.rows} rows across ${task.turns} Turn generation(s)`);
    }
    return lines.join("\n");
  } finally {
    void telemetry.close();
  }
}

// -- prune ----------------------------------------------------------------------

function telemetryPrune(args: string[], options: TelemetryCommandOptions): string {
  const flags = parseFlags(args, new Set(["dry-run", "json"]));
  const taskId = stringOption(args, "--task");
  const keep = integerOption(args, "--keep", DEFAULT_TERMINAL_KEEP);
  const dryRun = flags.has("dry-run");

  const cap = resolveTurnCap(storeConfig(options).telemetryTurnCap);
  const store = requireStore(options);
  const telemetry = new SqliteTelemetryStore(options.home, {
    mode: telemetryMode(storeConfig(options)),
    terminalKeep: keep,
    turnCap: cap
  });
  try {
    const tasks = taskId === undefined
      ? store.listTasks().map((task) => task.id)
      : [taskId];
    const report: {
      taskId: string;
      terminalPruned: number;
      activeCapped: number;
      generations: { turnId: string; generation: string; kept: number; deleted: number }[];
    }[] = [];
    for (const id of tasks) {
      const terminalTurns = new Set(
        store.listTurns(id)
          .filter((run) => run.status !== "active")
          .map((run) => run.id)
      );
      const entry: {
        taskId: string;
        terminalPruned: number;
        activeCapped: number;
        generations: { turnId: string; generation: string; kept: number; deleted: number }[];
      } = { taskId: id, terminalPruned: 0, activeCapped: 0, generations: [] };
      for (const aggregate of telemetry.listTurnAggregates(id)) {
        if (terminalTurns.has(aggregate.turnId)) {
          const before = telemetry.count(id, aggregate.turnId);
          const deleted = dryRun
            ? Math.max(0, before - keep)
            : telemetry.pruneGeneration(
                aggregate.taskId,
                aggregate.roleName,
                aggregate.turnId,
                aggregate.generation,
                keep
              );
          entry.terminalPruned += deleted;
          entry.generations.push({
            turnId: aggregate.turnId,
            generation: aggregate.generation,
            kept: Math.min(before, keep),
            deleted
          });
        }
      }
      for (const run of store.listTurns(id)) {
        if (run.status !== "active") continue;
        const before = telemetry.count(id, run.id);
        if (before <= cap) continue;
        const deleted = dryRun ? before - cap : telemetry.capTurn(id, run.id, cap);
        entry.activeCapped += deleted;
        entry.generations.push({
          turnId: run.id,
          generation: "*",
          kept: Math.min(before, cap),
          deleted
        });
      }
      report.push(entry);
    }
    const totals = report.reduce(
      (acc, entry) => ({
        terminalPruned: acc.terminalPruned + entry.terminalPruned,
        activeCapped: acc.activeCapped + entry.activeCapped
      }),
      { terminalPruned: 0, activeCapped: 0 }
    );
    const result = { dryRun, keep, cap, totals, tasks: report };
    if (options.json || flags.has("json")) return JSON.stringify(result, null, 2);
    const lines = [
      `Telemetry prune (${dryRun ? "dry-run" : "applied"}):`,
      `  terminal generations pruned: ${totals.terminalPruned} row(s) (keep ${keep})`,
      `  active Turns capped:         ${totals.activeCapped} row(s) (cap ${cap})`
    ];
    for (const entry of report) {
      if (entry.generations.length === 0) continue;
      lines.push(`  ${entry.taskId}:`);
      for (const generation of entry.generations) {
        lines.push(
          `    ${generation.turnId}/${generation.generation}: kept ${generation.kept}, deleted ${generation.deleted}`
        );
      }
    }
    return lines.join("\n");
  } finally {
    void telemetry.close();
  }
}

// -- read -----------------------------------------------------------------------

function telemetryRead(args: string[], options: TelemetryCommandOptions): string {
  const flags = parseFlags(args, new Set(["aggregate", "json"]));
  const taskId = stringOption(args, "--task");
  if (taskId === undefined) {
    throw usageError("telemetry read requires --task <id>.", "yui telemetry read --task <id> [--turn <id>] [--aggregate]");
  }
  const turnId = stringOption(args, "--turn");
  const limit = integerOption(args, "--limit", 100);
  const offset = integerOption(args, "--offset", 0);

  const telemetry = new SqliteTelemetryStore(options.home, {
    mode: telemetryMode(storeConfig(options)),
    terminalKeep: resolveTerminalKeep(storeConfig(options).telemetryTerminalKeep),
    turnCap: resolveTurnCap(storeConfig(options).telemetryTurnCap)
  });
  try {
    if (flags.has("aggregate")) {
      if (turnId === undefined) {
        const aggregates = telemetry.listTurnAggregates(taskId);
        if (options.json || flags.has("json")) return JSON.stringify(aggregates, null, 2);
        return aggregates.map((aggregate) => formatAggregate(aggregate)).join("\n") || "(no telemetry)";
      }
      const aggregate = telemetry.aggregate(taskId, turnId);
      if (options.json || flags.has("json")) return JSON.stringify(aggregate, null, 2);
      return aggregate === null ? "(no telemetry for this Turn)" : formatAggregate(aggregate);
    }
    const page = telemetry.list(taskId, turnId, { limit, offset });
    if (options.json || flags.has("json")) return JSON.stringify(page, null, 2);
    const lines = page.items.map((entry) =>
      `${entry.receivedAt} ${entry.turnId}/${entry.generation}/${entry.progressId}`
      + `${entry.sequence === undefined ? "" : ` seq=${entry.sequence}`}`
    );
    if (page.nextOffset !== null) lines.push(`(next offset: ${page.nextOffset})`);
    return lines.join("\n") || "(no telemetry rows)";
  } finally {
    void telemetry.close();
  }
}

// -- helpers --------------------------------------------------------------------

function requireStore(options: TelemetryCommandOptions): TaskStore {
  if (options.store === undefined) {
    throw usageError("This telemetry command requires the Home store.");
  }
  return options.store;
}

function parseFlags(args: string[], known: ReadonlySet<string>): Set<string> {
  const flags = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.split("=", 1)[0].replace(/^--/, "");
    if (known.has(name)) flags.add(name);
  }
  return flags;
}

function stringOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw usageError(`${name} requires a value.`);
  }
  return value;
}

function integerOption(args: string[], name: string, fallback: number): number {
  const raw = stringOption(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw usageError(`${name} must be a positive integer; got ${JSON.stringify(raw)}.`);
  }
  return value;
}

function formatAggregate(aggregate: {
  turnId: string;
  generation: string;
  firstAt: string;
  lastAt: string;
  count: number;
  maxSequence: number | null;
  errorCount: number;
}): string {
  return `${aggregate.turnId}/${aggregate.generation}: count=${aggregate.count} first=${aggregate.firstAt} last=${aggregate.lastAt} maxSequence=${aggregate.maxSequence === null ? "-" : aggregate.maxSequence} errors=${aggregate.errorCount}`;
}
