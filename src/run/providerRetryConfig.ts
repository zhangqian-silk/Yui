import { supportedAgentAdapterIds } from "../agent/adapterCatalog.js";
import { PROVIDER_RETRY_MAX_WINDOW_MS } from "./providerRetry.js";

/**
 * Issue 04 feature flags.
 *
 * The retry-in-place path is per-Provider-adapter and defaults to on for every
 * supported adapter. Task-27 proved that a transient stream/INTERNAL_ERROR
 * otherwise terminalizes the original Run and Native Session and forces a
 * full replay under a new Run. The in-place path is bounded by a finite retry
 * budget (see {@link PROVIDER_RETRY_MAX_WINDOW_MS}) and by at-most-once
 * delivery checks, so defaulting it on cannot loop forever or double-send a
 * prompt once a durable completion exists. Yield receipt replay is safe by
 * construction (same request → same receipt; different digest → fail closed)
 * and defaults on.
 */

export type ProviderRetryMode = "off" | "shadow" | "enforce";

export type ProviderRetryConfig = Readonly<{
  mode: ProviderRetryMode;
  /** Adapters with in-place retry enabled (shadow or enforce). */
  adapters: readonly string[];
  /** Idempotent yield receipt replay on resend. */
  yieldReceiptReplay: boolean;
  /** Total retry budget per Run lineage, in milliseconds. */
  maxWindowMs: number;
}>;

function parseAdapters(value: string | undefined): string[] {
  if (value === undefined) {
    // Default: every supported adapter retries in place.
    return [...supportedAgentAdapterIds()];
  }
  const token = value.trim().toLowerCase();
  if (token === "" || token === "0" || token === "off" || token === "none") {
    return [];
  }
  const supported = supportedAgentAdapterIds();
  const supportedSet = new Set<string>(supported);
  const adapters: string[] = [];
  for (const raw of value.split(",")) {
    const token = raw.trim().toLowerCase();
    if (token === "") continue;
    if (token === "0" || token === "off" || token === "none") continue;
    if (token === "all") {
      for (const adapter of supported) {
        if (!adapters.includes(adapter)) adapters.push(adapter);
      }
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(token)) {
      throw new Error(`Invalid Provider retry adapter: ${token}.`);
    }
    if (!supportedSet.has(token)) {
      throw new Error(`Unknown Provider retry adapter: ${token}.`);
    }
    if (!adapters.includes(token)) {
      adapters.push(token);
    }
  }
  return adapters;
}

/**
 * Resolves the Issue 04 flags from the process environment.
 *
 * - `YUI_PROVIDER_RETRY_IN_PLACE` — comma-separated adapter ids (`claude`,
 *   `codex`, `all`). Unset defaults to `all`; set to `0`/`off`/empty disables
 *   the feature entirely.
 * - `YUI_PROVIDER_RETRY_MODE` — `enforce` (default) keeps the Run active and
 *   retries in place; `shadow` records classification and "would retry" facts
 *   without changing behavior; `off` disables the feature.
 * - `YUI_YIELD_RECEIPT_REPLAY` — `0` disables receipt replay; default `1`.
 * - `YUI_PROVIDER_RETRY_MAX_WINDOW_MS` — total retry budget per Run lineage.
 *   Default {@link PROVIDER_RETRY_MAX_WINDOW_MS}; once the window elapses the
 *   Run terminalizes with one structured failure instead of looping.
 */
export function providerRetryConfig(
  environment: NodeJS.ProcessEnv = process.env
): ProviderRetryConfig {
  const adapters = parseAdapters(environment.YUI_PROVIDER_RETRY_IN_PLACE);
  const modeValue = environment.YUI_PROVIDER_RETRY_MODE?.trim().toLowerCase();
  let mode: ProviderRetryMode;
  if (modeValue === "off" || adapters.length === 0) {
    mode = "off";
  } else if (modeValue === undefined || modeValue === "" || modeValue === "enforce") {
    mode = "enforce";
  } else if (modeValue === "shadow") {
    mode = "shadow";
  } else {
    throw new Error(`Unknown Provider retry mode: ${modeValue}.`);
  }
  const replayValue = environment.YUI_YIELD_RECEIPT_REPLAY?.trim();
  const yieldReceiptReplay = replayValue === undefined || replayValue === "" || replayValue === "1";
  if (!["0", "1"].includes(replayValue ?? "1")) {
    throw new Error(`YUI_YIELD_RECEIPT_REPLAY must be 0 or 1: ${replayValue}.`);
  }
  const maxWindowValue = environment.YUI_PROVIDER_RETRY_MAX_WINDOW_MS?.trim();
  const maxWindowMs = maxWindowValue === undefined || maxWindowValue === ""
    ? PROVIDER_RETRY_MAX_WINDOW_MS
    : parsePositiveInteger(maxWindowValue, "YUI_PROVIDER_RETRY_MAX_WINDOW_MS");
  return { mode, adapters, yieldReceiptReplay, maxWindowMs };
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a positive integer: ${value}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer: ${value}.`);
  }
  return parsed;
}

/** Whether the adapter has in-place retry enabled in the given mode. */
export function providerRetryEnabledForAdapter(
  config: ProviderRetryConfig,
  adapterId: string,
  mode: Exclude<ProviderRetryMode, "off">
): boolean {
  return config.mode === mode
    && config.adapters.includes(adapterId);
}
