import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveTelemetryEnabled } from "../config/yuiConfig.js";
import { CURRENT_DATABASE_FILENAME as COMMITTED_DATABASE_FILENAME } from "../storage/currentTaskStore.js";
import type { AsyncTaskStoreClient } from "../storage/storeRpc.js";
import type { YuiConfig } from "../storage/taskStore.js";
import { SqliteTelemetryStore } from "./sqliteTelemetryStore.js";
import {
  resolveRunCap,
  resolveTerminalKeep
} from "./telemetryConfig.js";
import type { SchedulerTelemetry } from "./telemetryStore.js";

/**
 * Open optional telemetry from the current Home's authoritative `yui.db`.
 * Disabled telemetry performs no database work. Once opened, telemetry fails
 * isolated: a broken sink increments its dropped counter without blocking the
 * semantic lane.
 */
export function openSchedulerTelemetry(
  home: string,
  config: YuiConfig,
  writer?: Pick<AsyncTaskStoreClient, "flushTelemetry">
): SchedulerTelemetry | null {
  if (!resolveTelemetryEnabled(config.telemetryEnabled)) return null;
  const mode = "on" as const;
  const dbPath = join(home, COMMITTED_DATABASE_FILENAME);
  if (!existsSync(dbPath)) {
    throw new Error(
      `telemetryEnabled=true requires SQLite storage, but ${dbPath} does not exist. `
      + "The current Home is incomplete; preserve it for diagnosis and initialize a new Home."
    );
  }
  const store = new SqliteTelemetryStore(home, {
    mode,
    writer,
    terminalKeep: resolveTerminalKeep(config.telemetryTerminalKeep),
    runCap: resolveRunCap(config.telemetryRunCap)
  });
  return { mode, sink: store, reader: store, retention: store };
}
