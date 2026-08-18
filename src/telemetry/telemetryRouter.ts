import type { TelemetryMode } from "./telemetryConfig.js";
import type { TelemetryProgressEntry, TelemetrySink } from "./telemetryStore.js";

/**
 * Result of routing one provider progress observation. The runtime event
 * processor treats both semantic and telemetry writes as "applied": progress
 * is advisory and never advances Run delivery/acceptance.
 */
export type ProgressRouteResult = "applied";

export type ProgressRouteInput = Readonly<{
  mode: TelemetryMode;
  entry: TelemetryProgressEntry;
  /**
   * Whether the semantic event history already contains this exact
   * observation (idempotent replay). Only consulted in legacy/dual mode.
   */
  semanticExists: boolean;
  /** Append the semantic progress event. Called at most once. */
  writeSemantic: () => void;
  sink: TelemetrySink;
}>;

/**
 * Route one provider progress observation according to `telemetry.mode`:
 *
 * - `legacy`  — semantic event only (master behavior).
 * - `dual`    — semantic event plus best-effort sidecar upsert.
 * - `bounded` — sidecar upsert only; semantic events stop carrying progress.
 *
 * The sidecar write is best-effort and isolated: a sink failure must never
 * block or roll back the semantic lane.
 */
export function routeProviderProgress(input: ProgressRouteInput): ProgressRouteResult {
  const { mode, entry, semanticExists, writeSemantic, sink } = input;
  if (mode === "bounded") {
    safeObserve(sink, entry);
    return "applied";
  }
  if (semanticExists) return "applied";
  writeSemantic();
  if (mode === "dual") safeObserve(sink, entry);
  return "applied";
}

function safeObserve(sink: TelemetrySink, entry: TelemetryProgressEntry): void {
  try {
    sink.observe(entry);
  } catch {
    // Telemetry is best-effort by contract; sinks must not throw, but a
    // broken sink must never take down the semantic lane.
  }
}
