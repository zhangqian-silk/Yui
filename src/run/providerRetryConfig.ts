import {
  resolveProviderRetryAdapters,
  resolveProviderRetryMaxWindowMs,
  resolveProviderRetryMode,
  resolveYieldReceiptReplay,
  type ProviderRetryMode
} from "../config/yuiConfig.js";
import type { YuiConfig } from "../storage/taskStore.js";

/**
 * Issue 04 feature flags.
 *
 * The retry-in-place path is per-Provider-adapter and defaults to on for every
 * supported adapter. Task-27 proved that a transient stream/INTERNAL_ERROR
 * otherwise terminalizes the original Run and Native Session and forces a
 * full replay under a new Run. The in-place path is bounded by a finite retry
 * budget and by at-most-once delivery checks, so defaulting it on cannot loop
 * forever or double-send a prompt once a durable completion exists. Yield
 * receipt replay is safe by construction (same request → same receipt;
 * different digest → fail closed) and defaults on.
 *
 * All settings live in the durable Yui config (`yui config show/set`), not in
 * environment variables, so a Home's retry policy is visible and auditable.
 */

export type ProviderRetryConfig = Readonly<{
  mode: ProviderRetryMode;
  /** Adapters with in-place retry enabled (shadow or enforce). */
  adapters: readonly string[] | "all-capable";
  /** Idempotent yield receipt replay on resend. */
  yieldReceiptReplay: boolean;
  /** Total retry budget per Run lineage, in milliseconds. */
  maxWindowMs: number;
}>;

/**
 * Resolves the retry flags from the durable Yui config. Homes without the
 * fields get the safe defaults: enforce mode, all supported adapters, receipt
 * replay on, 10-minute budget.
 */
export function providerRetryConfig(config: YuiConfig): ProviderRetryConfig {
  const mode = resolveProviderRetryMode(config.providerRetryMode);
  const adapters = resolveProviderRetryAdapters(config.providerRetryAdapters);
  return {
    mode: adapters.length === 0 ? "off" : mode,
    adapters,
    yieldReceiptReplay: resolveYieldReceiptReplay(config.yieldReceiptReplay),
    maxWindowMs: resolveProviderRetryMaxWindowMs(config.providerRetryMaxWindowMs)
  };
}

/** Whether the adapter has in-place retry enabled in the given mode. */
export function providerRetryEnabledForAdapter(
  config: ProviderRetryConfig,
  adapterId: string,
  mode: Exclude<ProviderRetryMode, "off">
): boolean {
  return config.mode === mode
    && providerRetryAdapterEnabled(config, adapterId);
}

/** Default admission is capability-driven, not a hard-coded Provider list. */
export function providerRetryAdapterEnabled(
  config: ProviderRetryConfig,
  adapterId: string
): boolean {
  return config.adapters === "all-capable" || config.adapters.includes(adapterId);
}
