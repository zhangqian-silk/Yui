import type { AgentAdapterId } from "../agent/adapterCatalog.js";

/**
 * Issue 04 feature flags.
 *
 * The retry-in-place path is per-Provider-adapter and defaults to off so a
 * deployment keeps the existing terminalize-immediately behavior until it
 * explicitly opts in. Yield receipt replay is safe by construction (same
 * request → same receipt; different digest → fail closed) and defaults on,
 * matching the Issue 04 rollout order: shadow classification, receipt replay,
 * then per-adapter in-place retry.
 */

export type ProviderRetryMode = "off" | "shadow" | "enforce";

export type ProviderRetryConfig = Readonly<{
  mode: ProviderRetryMode;
  /** Adapters with in-place retry enabled (shadow or enforce). */
  adapters: readonly AgentAdapterId[];
  /** Idempotent yield receipt replay on resend. */
  yieldReceiptReplay: boolean;
}>;

const KNOWN_ADAPTERS: readonly AgentAdapterId[] = ["claude", "codex"];

function parseAdapters(value: string | undefined): AgentAdapterId[] {
  if (value === undefined) return [];
  const adapters: AgentAdapterId[] = [];
  for (const raw of value.split(",")) {
    const token = raw.trim().toLowerCase();
    if (token === "") continue;
    if (token === "all") {
      for (const adapter of KNOWN_ADAPTERS) {
        if (!adapters.includes(adapter)) adapters.push(adapter);
      }
      continue;
    }
    if (!KNOWN_ADAPTERS.includes(token as AgentAdapterId)) {
      throw new Error(`Unknown Provider retry adapter: ${token}.`);
    }
    if (!adapters.includes(token as AgentAdapterId)) {
      adapters.push(token as AgentAdapterId);
    }
  }
  return adapters;
}

/**
 * Resolves the Issue 04 flags from the process environment.
 *
 * - `YUI_PROVIDER_RETRY_IN_PLACE` — comma-separated adapter ids (`claude`,
 *   `codex`, `all`). Unset/empty disables the feature entirely.
 * - `YUI_PROVIDER_RETRY_MODE` — `shadow` (default when adapters are listed)
 *   records classification and "would retry" facts without changing behavior;
 *   `enforce` keeps the Run active and retries in place.
 * - `YUI_YIELD_RECEIPT_REPLAY` — `0` disables receipt replay; default `1`.
 */
export function providerRetryConfig(
  environment: NodeJS.ProcessEnv = process.env
): ProviderRetryConfig {
  const adapters = parseAdapters(environment.YUI_PROVIDER_RETRY_IN_PLACE);
  const modeValue = environment.YUI_PROVIDER_RETRY_MODE?.trim().toLowerCase();
  let mode: ProviderRetryMode;
  if (adapters.length === 0) {
    mode = "off";
  } else if (modeValue === "enforce") {
    mode = "enforce";
  } else if (modeValue === undefined || modeValue === "" || modeValue === "shadow") {
    mode = "shadow";
  } else {
    throw new Error(`Unknown Provider retry mode: ${modeValue}.`);
  }
  const replayValue = environment.YUI_YIELD_RECEIPT_REPLAY?.trim();
  const yieldReceiptReplay = replayValue === undefined || replayValue === "" || replayValue === "1";
  if (!["0", "1"].includes(replayValue ?? "1")) {
    throw new Error(`YUI_YIELD_RECEIPT_REPLAY must be 0 or 1: ${replayValue}.`);
  }
  return { mode, adapters, yieldReceiptReplay };
}

/** Whether the adapter has in-place retry enabled in the given mode. */
export function providerRetryEnabledForAdapter(
  config: ProviderRetryConfig,
  adapterId: string,
  mode: Exclude<ProviderRetryMode, "off">
): boolean {
  return config.mode === mode
    && config.adapters.includes(adapterId as AgentAdapterId);
}
