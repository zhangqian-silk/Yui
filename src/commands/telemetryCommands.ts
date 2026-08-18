import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { usageError } from "../errors/cliError.js";
import { STORAGE_SCHEMA_FILE } from "../storage/storageSchema.js";
import type { TaskStore } from "../storage/taskStore.js";
import { openTaskStore, SqliteTaskStore } from "../storage/sqliteStore.js";
import { COMMITTED_DATABASE_FILENAME } from "../storage/upgrade/sqliteStateMigration.js";
import {
  DEFAULT_RUN_CAP,
  DEFAULT_TERMINAL_KEEP,
  resolveRunCap,
  resolveTelemetryMode,
  resolveTerminalKeep
} from "../telemetry/telemetryConfig.js";
import {
  applyTelemetryCompaction,
  planTelemetryCompaction,
  type CompactionReceipt
} from "../telemetry/telemetryCompaction.js";
import { SqliteTelemetryStore } from "../telemetry/sqliteTelemetryStore.js";

/**
 * `yui telemetry status|prune|compact|read` — operational surface for the
 * Issue 09 telemetry sidecar. Telemetry lives in the Home's authoritative
 * `yui.db`; these commands never touch the authoritative semantic records
 * except `compact`, which removes only `runtime.provider-turn-progress`
 * events from a staged copy.
 */

export type TelemetryCommandOptions = Readonly<{
  home: string;
  json?: boolean;
  environment?: NodeJS.ProcessEnv;
  store?: TaskStore;
}>;

export async function runTelemetryCommand(
  args: string[],
  options: TelemetryCommandOptions
): Promise<string> {
  const [command, ...rest] = args;
  if (command === "status") return telemetryStatus(rest, options);
  if (command === "prune") return telemetryPrune(rest, options);
  if (command === "compact") return telemetryCompact(rest, options);
  if (command === "read") return telemetryRead(rest, options);
  throw usageError(
    command === undefined
      ? "Telemetry command is required: status, prune, compact, or read."
      : `Unknown command: telemetry ${command}`,
    "yui telemetry status [--json]\n"
      + "yui telemetry prune [--task <id>] [--keep <n>] [--dry-run] [--json]\n"
      + "yui telemetry compact --from <home> --staged <dir> [--keep <n>] [--dry-run] [--json]\n"
      + "yui telemetry read --task <id> [--run <id>] [--aggregate] [--limit <n>] [--offset <n>]"
  );
}

// -- status ---------------------------------------------------------------------

function telemetryStatus(args: string[], options: TelemetryCommandOptions): string {
  const flags = parseFlags(args, new Set([]));
  const env = options.environment ?? process.env;
  const mode = resolveTelemetryMode(env);
  const telemetry = new SqliteTelemetryStore(options.home, {
    mode,
    terminalKeep: resolveTerminalKeep(env),
    runCap: resolveRunCap(env)
  });
  try {
    const health = telemetry.health();
    const store = options.store;
    const perTask = store === undefined
      ? []
      : store.listTasks().map((task) => ({
          taskId: task.id,
          rows: telemetry.count(task.id),
          runs: telemetry.listRunAggregates(task.id).length
        }));
    const report = {
      mode,
      database: join(options.home, COMMITTED_DATABASE_FILENAME),
      available: health.available,
      dropped: health.dropped,
      coalesced: health.coalesced,
      lastError: health.lastError,
      totalRows: health.rows,
      terminalKeep: resolveTerminalKeep(env),
      runCap: resolveRunCap(env),
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
      `Run cap:         ${report.runCap}`
    ];
    for (const task of perTask) {
      lines.push(`  ${task.taskId}: ${task.rows} rows across ${task.runs} run generation(s)`);
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
  const env = options.environment ?? process.env;
  const cap = resolveRunCap(env);
  const store = requireStore(options);
  const telemetry = new SqliteTelemetryStore(options.home, {
    mode: resolveTelemetryMode(env),
    terminalKeep: keep,
    runCap: cap
  });
  try {
    const tasks = taskId === undefined
      ? store.listTasks().map((task) => task.id)
      : [taskId];
    const report: {
      taskId: string;
      terminalPruned: number;
      activeCapped: number;
      generations: { runId: string; generation: string; kept: number; deleted: number }[];
    }[] = [];
    for (const id of tasks) {
      const terminalRuns = new Set(
        store.listAgentRuns(id)
          .filter((run) => run.status !== "active")
          .map((run) => run.id)
      );
      const entry: {
        taskId: string;
        terminalPruned: number;
        activeCapped: number;
        generations: { runId: string; generation: string; kept: number; deleted: number }[];
      } = { taskId: id, terminalPruned: 0, activeCapped: 0, generations: [] };
      for (const aggregate of telemetry.listRunAggregates(id)) {
        if (terminalRuns.has(aggregate.runId)) {
          const before = telemetry.count(id, aggregate.runId);
          const deleted = dryRun
            ? Math.max(0, before - keep)
            : telemetry.pruneGeneration(
                aggregate.taskId,
                aggregate.roleName,
                aggregate.runId,
                aggregate.generation,
                keep
              );
          entry.terminalPruned += deleted;
          entry.generations.push({
            runId: aggregate.runId,
            generation: aggregate.generation,
            kept: Math.min(before, keep),
            deleted
          });
        }
      }
      for (const run of store.listAgentRuns(id)) {
        if (run.status !== "active") continue;
        const before = telemetry.count(id, run.id);
        if (before <= cap) continue;
        const deleted = dryRun ? before - cap : telemetry.capRun(id, run.id, cap);
        entry.activeCapped += deleted;
        entry.generations.push({
          runId: run.id,
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
      `  active runs capped:          ${totals.activeCapped} row(s) (cap ${cap})`
    ];
    for (const entry of report) {
      if (entry.generations.length === 0) continue;
      lines.push(`  ${entry.taskId}:`);
      for (const generation of entry.generations) {
        lines.push(
          `    ${generation.runId}/${generation.generation}: kept ${generation.kept}, deleted ${generation.deleted}`
        );
      }
    }
    return lines.join("\n");
  } finally {
    void telemetry.close();
  }
}

// -- compact --------------------------------------------------------------------

function telemetryCompact(args: string[], options: TelemetryCommandOptions): string {
  const flags = parseFlags(args, new Set(["dry-run", "json"]));
  const from = stringOption(args, "--from");
  const staged = stringOption(args, "--staged");
  const keep = integerOption(args, "--keep", DEFAULT_TERMINAL_KEEP);
  const dryRun = flags.has("dry-run");
  if (from === undefined || staged === undefined) {
    throw usageError(
      "telemetry compact requires --from <home> and --staged <dir>.",
      "yui telemetry compact --from <home> --staged <dir> [--keep <n>] [--dry-run]"
    );
  }
  const resolvedFrom = resolvePath(from);
  const resolvedStaged = resolvePath(staged);
  if (resolvedFrom === resolvedStaged) {
    throw usageError("--from and --staged must be different directories.");
  }
  if (!existsSync(join(resolvedFrom, STORAGE_SCHEMA_FILE))) {
    throw usageError(`--from is not a Yui Home (missing ${STORAGE_SCHEMA_FILE}): ${resolvedFrom}`);
  }
  if (existsSync(resolvedStaged) && dryRun === false) {
    throw usageError(`--staged already exists; refuse to overwrite: ${resolvedStaged}`);
  }
  // Database-only direction: compaction folds semantic progress into the
  // telemetry tables inside `yui.db`. A Home without a database has not
  // reached SQLite storage yet; migrate it first (yui upgrade) instead
  // of silently compacting a file-only copy that telemetry cannot join.
  if (!existsSync(join(resolvedFrom, COMMITTED_DATABASE_FILENAME))) {
    throw usageError(
      `--from is not a SQLite Home (missing ${COMMITTED_DATABASE_FILENAME}): ${resolvedFrom}. `
      + "Migrate it to the database backend before compaction."
    );
  }
  const backend = "sqlite" as const;
  mkdirSync(resolvedStaged, { recursive: true });
  copyStoreFiles(resolvedFrom, resolvedStaged);
  const store = openTaskStore(resolvedStaged, backend);
  const telemetry = new SqliteTelemetryStore(resolvedStaged, {
    mode: "bounded",
    terminalKeep: keep,
    runCap: DEFAULT_RUN_CAP
  });
  try {
    const plan = planTelemetryCompaction(store, { terminalKeep: keep });
    const receipt = applyTelemetryCompaction(store, telemetry, plan, {
      dryRun,
      source: resolvedFrom,
      terminalKeep: keep
    });
    writeFileSync(
      join(resolvedStaged, "telemetry-compaction.json"),
      JSON.stringify(receipt, null, 2) + "\n"
    );
    if (options.json || flags.has("json")) return JSON.stringify({ staged: resolvedStaged, receipt }, null, 2);
    return [
      `Telemetry compaction (${dryRun ? "dry-run" : "applied"}) on staged copy:`,
      `  staged:       ${resolvedStaged}`,
      `  backend:      ${backend}`,
      `  tasks:        ${receipt.totals.tasks}`,
      `  progress:     ${receipt.totals.progressEvents} event(s) across ${receipt.totals.generations} generation(s)`,
      `  sidecar rows: ${receipt.totals.telemetryRows} (window ${keep}/generation)`,
      `  receipt:      ${join(resolvedStaged, "telemetry-compaction.json")}`,
      dryRun
        ? "Dry-run made no changes. Re-run without --dry-run, then promote the staged Home after verifying the receipt."
        : "Applied. Promote the staged Home only after verifying the receipt; the original Home is unchanged."
    ].join("\n");
  } finally {
    void telemetry.close();
    if (store instanceof SqliteTaskStore) store.close();
  }
}

// -- read -----------------------------------------------------------------------

function telemetryRead(args: string[], options: TelemetryCommandOptions): string {
  const flags = parseFlags(args, new Set(["aggregate", "json"]));
  const taskId = stringOption(args, "--task");
  if (taskId === undefined) {
    throw usageError("telemetry read requires --task <id>.", "yui telemetry read --task <id> [--run <id>] [--aggregate]");
  }
  const runId = stringOption(args, "--run");
  const limit = integerOption(args, "--limit", 100);
  const offset = integerOption(args, "--offset", 0);
  const env = options.environment ?? process.env;
  const telemetry = new SqliteTelemetryStore(options.home, {
    mode: resolveTelemetryMode(env),
    terminalKeep: resolveTerminalKeep(env),
    runCap: resolveRunCap(env)
  });
  try {
    if (flags.has("aggregate")) {
      if (runId === undefined) {
        const aggregates = telemetry.listRunAggregates(taskId);
        if (options.json || flags.has("json")) return JSON.stringify(aggregates, null, 2);
        return aggregates.map((aggregate) => formatAggregate(aggregate)).join("\n") || "(no telemetry)";
      }
      const aggregate = telemetry.aggregate(taskId, runId);
      if (options.json || flags.has("json")) return JSON.stringify(aggregate, null, 2);
      return aggregate === null ? "(no telemetry for this Run)" : formatAggregate(aggregate);
    }
    const page = telemetry.list(taskId, runId, { limit, offset });
    if (options.json || flags.has("json")) return JSON.stringify(page, null, 2);
    const lines = page.items.map((entry) =>
      `${entry.receivedAt} ${entry.runId}/${entry.generation}/${entry.progressId}`
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

function resolvePath(value: string): string {
  return value.startsWith("/") ? value : join(process.cwd(), value);
}

function copyStoreFiles(from: string, staged: string): void {
  for (const filename of [
    COMMITTED_DATABASE_FILENAME,
    `${COMMITTED_DATABASE_FILENAME}-wal`,
    `${COMMITTED_DATABASE_FILENAME}-shm`
  ]) {
    const source = join(from, filename);
    if (existsSync(source)) copyFile(source, join(staged, filename));
  }
  copyFile(join(from, STORAGE_SCHEMA_FILE), join(staged, STORAGE_SCHEMA_FILE));
}

function copyFile(source: string, destination: string): void {
  writeFileSync(destination, readFileSync(source));
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
  runId: string;
  generation: string;
  firstAt: string;
  lastAt: string;
  count: number;
  maxSequence: number | null;
  errorCount: number;
}): string {
  return `${aggregate.runId}/${aggregate.generation}: count=${aggregate.count} first=${aggregate.firstAt} last=${aggregate.lastAt} maxSequence=${aggregate.maxSequence === null ? "-" : aggregate.maxSequence} errors=${aggregate.errorCount}`;
}
