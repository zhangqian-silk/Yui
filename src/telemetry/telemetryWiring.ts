import {
  resolveRunCap,
  resolveTelemetryMode,
  resolveTerminalKeep
} from "./telemetryConfig.js";
import { SqliteTelemetryStore } from "./sqliteTelemetryStore.js";
import type { SchedulerTelemetry } from "./telemetryStore.js";

/**
 * Open the telemetry sidecar for a Home, resolved from the environment
 * (`YUI_TELEMETRY_MODE`, default `legacy`). Returns null in legacy mode so
 * callers keep the exact master behavior and never open `telemetry.db`.
 *
 * The store opens lazily on first write/read and fails isolated: a broken
 * sidecar only increments its dropped counter and never blocks the semantic
 * lane.
 */
export function openSchedulerTelemetry(
  home: string,
  env: NodeJS.ProcessEnv = process.env
): SchedulerTelemetry | null {
  const mode = resolveTelemetryMode(env);
  if (mode === "legacy") return null;
  const store = new SqliteTelemetryStore(home, {
    mode,
    terminalKeep: resolveTerminalKeep(env),
    runCap: resolveRunCap(env)
  });
  return { mode, sink: store, reader: store };
}
