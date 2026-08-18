import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  resolveRunCap,
  resolveTelemetryMode,
  resolveTerminalKeep
} from "./telemetryConfig.js";
import { SqliteTelemetryStore } from "./sqliteTelemetryStore.js";
import type { SchedulerTelemetry } from "./telemetryStore.js";
import { COMMITTED_DATABASE_FILENAME } from "../storage/upgrade/sqliteStateMigration.js";

/**
 * Open the telemetry sidecar for a Home, resolved from the environment
 * (`YUI_TELEMETRY_MODE`, default `legacy`). Returns null in legacy mode so
 * callers keep the exact master behavior and never touch the database.
 *
 * Telemetry lives in the Home's authoritative `yui.db`. A Home without a
 * database has not reached SQLite storage yet, so dual/bounded mode fails
 * closed at startup with a bounded diagnosis instead of silently creating an
 * empty database (which would corrupt Home classification). Once opened, the
 * store fails isolated: a broken sidecar only increments its dropped counter
 * and never blocks the semantic lane.
 */
export function openSchedulerTelemetry(
  home: string,
  env: NodeJS.ProcessEnv = process.env
): SchedulerTelemetry | null {
  const mode = resolveTelemetryMode(env);
  if (mode === "legacy") return null;
  const dbPath = join(home, COMMITTED_DATABASE_FILENAME);
  if (!existsSync(dbPath)) {
    throw new Error(
      `YUI_TELEMETRY_MODE=${mode} requires SQLite storage, but ${dbPath} does not exist. `
      + "Migrate this Home to the database backend first (yui upgrade)."
    );
  }
  const store = new SqliteTelemetryStore(home, {
    mode,
    terminalKeep: resolveTerminalKeep(env),
    runCap: resolveRunCap(env)
  });
  return { mode, sink: store, reader: store };
}
