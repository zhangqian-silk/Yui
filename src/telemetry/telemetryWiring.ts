import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  resolveRunCap,
  resolveTerminalKeep
} from "./telemetryConfig.js";
import { resolveTelemetryEnabled } from "../config/yuiConfig.js";
import type { YuiConfig } from "../storage/taskStore.js";
import { SqliteTelemetryStore } from "./sqliteTelemetryStore.js";
import type { SchedulerTelemetry } from "./telemetryStore.js";
import { COMMITTED_DATABASE_FILENAME } from "../storage/upgrade/sqliteStateMigration.js";

/**
 * Open the telemetry sidecar for a Home, resolved from the durable Yui
 * config (default `legacy`). Returns null in legacy mode so callers keep the
 * exact master behavior and never touch the database.
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
  config: YuiConfig
): SchedulerTelemetry | null {
  if (!resolveTelemetryEnabled(config.telemetryEnabled)) return null;
  const mode = "on" as const;
  const dbPath = join(home, COMMITTED_DATABASE_FILENAME);
  if (!existsSync(dbPath)) {
    throw new Error(
      `telemetryEnabled=true requires SQLite storage, but ${dbPath} does not exist. `
      + "Migrate this Home to the database backend first (yui upgrade)."
    );
  }
  const store = new SqliteTelemetryStore(home, {
    mode,
    terminalKeep: resolveTerminalKeep(config.telemetryTerminalKeep),
    runCap: resolveRunCap(config.telemetryRunCap)
  });
  return { mode, sink: store, reader: store, retention: store };
}
