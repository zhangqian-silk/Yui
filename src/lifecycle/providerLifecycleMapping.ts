import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import {
  createCanonicalLifecycleEvent,
  CanonicalLifecycleError,
  type CanonicalIdentityFence,
  type CanonicalLifecycleEvent,
  type PreInputReadinessCapability
} from "./canonicalLifecycleEvent.js";

/**
 * A provider-neutral description of one native provider signal, already parsed
 * out of a provider-specific hook payload. The `kind` names the raw native
 * event class; the *meaning* (which canonical phase, and whether it proves
 * pre-input readiness) is decided independently by each adapter mapping below.
 * The same neutral kind can therefore map to different canonical phases per
 * provider — which is exactly why pre-input readiness is an adapter capability
 * and not a provider-wide assumption.
 */
export type NativeLifecycleSignal =
  /**
   * The provider reported that its own session/thread now exists. `sessionSource`
   * carries the exact provider-native discriminator (e.g. Claude's SessionStart
   * `source`: startup/resume/clear/compact) so the adapter can decide whether it
   * proves pre-input readiness. Omission is allowed only for providers whose
   * session-start carries no such discriminator.
   */
  | Readonly<{ kind: "native-session-start"; sessionSource?: string; fence: CanonicalIdentityFence }>
  /** The provider reported it accepted a submitted prompt. */
  | Readonly<{ kind: "native-prompt-submit"; fence: CanonicalIdentityFence }>
  /** The provider reported forward progress inside an accepted turn. */
  | Readonly<{ kind: "native-turn-progress"; sequence?: number; fence: CanonicalIdentityFence }>
  /** The provider reported the current turn completed. */
  | Readonly<{ kind: "native-turn-complete"; summary: string; fence: CanonicalIdentityFence }>
  /** The provider reported the current turn failed. */
  | Readonly<{ kind: "native-stop-failure"; summary: string; fence: CanonicalIdentityFence }>;

export type NativeLifecycleSignalKind = NativeLifecycleSignal["kind"];

/**
 * One provider's independently-authored translation from its observed native
 * behavior to the canonical vocabulary, plus its pre-input readiness capability.
 * Consumers select a mapping from the registry by adapterId; they never branch
 * on the provider name themselves.
 */
export type ProviderLifecycleMapping = Readonly<{
  adapterId: AgentAdapterId;
  preInputReadiness: PreInputReadinessCapability;
  /** The native signal kinds this provider actually emits. */
  supportedSignals: readonly NativeLifecycleSignalKind[];
  /** Maps one native signal to a canonical event, or fails closed. */
  map(signal: NativeLifecycleSignal): CanonicalLifecycleEvent;
}>;

/**
 * Claude, mapped from its observed SessionStart / UserPromptSubmit / StopFailure
 * contract (claude 2.1.x). SessionStart with source=startup fires at process
 * startup, *before* the first prompt, so only that exact variant proves pre-input
 * readiness. A resume/clear/compact SessionStart occurs within an existing
 * session and is downgraded to provider-session-started (never pre-input-ready).
 * A single prompt push precedes the only acceptance fence, an identity-matched
 * UserPromptSubmit.
 */
const CLAUDE_PRE_INPUT_SESSION_SOURCE = "startup";

const CLAUDE_LIFECYCLE_MAPPING: ProviderLifecycleMapping = {
  adapterId: "claude",
  preInputReadiness: {
    status: "supported",
    nativeEvent: "SessionStart(source=startup)",
    note:
      "Claude fires SessionStart at process startup before the first prompt, so "
      + "readiness is proven pre-input by a native durable event. Only the "
      + "startup variant qualifies; resume/clear/compact are session-started only."
  },
  supportedSignals: [
    "native-session-start",
    "native-prompt-submit",
    "native-turn-progress",
    "native-turn-complete",
    "native-stop-failure"
  ],
  map(signal: NativeLifecycleSignal): CanonicalLifecycleEvent {
    switch (signal.kind) {
      case "native-session-start": {
        // The SessionStart source discriminator is required for Claude: readiness
        // safety depends on distinguishing startup from later in-session variants.
        if (signal.sessionSource === undefined) {
          throw new CanonicalLifecycleError(
            "Claude native-session-start requires the SessionStart source variant."
          );
        }
        if (signal.sessionSource !== CLAUDE_PRE_INPUT_SESSION_SOURCE) {
          // A non-startup SessionStart (resume/clear/compact) fires inside an
          // existing session and cannot prove pre-input readiness; downgrade it.
          return createCanonicalLifecycleEvent({
            phase: "provider-session-started",
            source: "provider-native",
            evidence: "provider-native-durable",
            fence: signal.fence
          });
        }
        // SessionStart(startup) proves readiness before any input for Claude.
        return createCanonicalLifecycleEvent({
          phase: "provider-ready",
          source: "provider-native",
          evidence: "provider-native-durable",
          preInputReady: true,
          readinessVariant: `SessionStart(source=${signal.sessionSource})`,
          fence: signal.fence
        });
      }
      case "native-prompt-submit":
        return createCanonicalLifecycleEvent({
          phase: "provider-accepted",
          source: "provider-native",
          evidence: "provider-native-durable",
          fence: signal.fence
        });
      case "native-turn-progress":
        return createCanonicalLifecycleEvent({
          phase: "turn-progress",
          source: "provider-native",
          evidence: "provider-native-durable",
          ...(signal.sequence === undefined ? {} : { sequence: signal.sequence }),
          fence: signal.fence
        });
      case "native-turn-complete":
        return createCanonicalLifecycleEvent({
          phase: "turn-terminal",
          source: "provider-native",
          evidence: "provider-native-durable",
          summary: signal.summary,
          fence: signal.fence
        });
      case "native-stop-failure":
        return createCanonicalLifecycleEvent({
          phase: "turn-terminal",
          source: "provider-native",
          evidence: "provider-native-durable",
          summary: signal.summary,
          fence: signal.fence
        });
      default:
        throw unsupportedSignal("claude", signal);
    }
  }
};

/**
 * Codex 0.145, mapped from its observed run_turn(input) -> SessionStart ->
 * UserPromptSubmit ordering. SessionStart fires *inside* run_turn — after the
 * first input — so it can only prove that the session/thread now exists, never
 * pre-input readiness. UserPromptSubmit is the acceptance fence; the notify
 * agent-turn-complete is the terminal fact. Codex emits no StopFailure hook.
 */
const CODEX_LIFECYCLE_MAPPING: ProviderLifecycleMapping = {
  adapterId: "codex",
  preInputReadiness: {
    status: "unsupported",
    reason: "not-available",
    note:
      "Codex 0.145 SessionStart fires within run_turn(input), i.e. after the "
      + "first input; no native event precedes the first prompt, so pre-input "
      + "readiness is not available and fails closed."
  },
  supportedSignals: [
    "native-session-start",
    "native-prompt-submit",
    "native-turn-progress",
    "native-turn-complete"
  ],
  map(signal: NativeLifecycleSignal): CanonicalLifecycleEvent {
    switch (signal.kind) {
      case "native-session-start":
        // SessionStart proves the thread exists but arrives after the first
        // input, so it maps to session-started only — never ready, never pre-input.
        return createCanonicalLifecycleEvent({
          phase: "provider-session-started",
          source: "provider-native",
          evidence: "provider-native-durable",
          fence: signal.fence
        });
      case "native-prompt-submit":
        return createCanonicalLifecycleEvent({
          phase: "provider-accepted",
          source: "provider-native",
          evidence: "provider-native-durable",
          fence: signal.fence
        });
      case "native-turn-progress":
        return createCanonicalLifecycleEvent({
          phase: "turn-progress",
          source: "provider-native",
          evidence: "provider-native-durable",
          ...(signal.sequence === undefined ? {} : { sequence: signal.sequence }),
          fence: signal.fence
        });
      case "native-turn-complete":
        return createCanonicalLifecycleEvent({
          phase: "turn-terminal",
          source: "provider-native",
          evidence: "provider-native-durable",
          summary: signal.summary,
          fence: signal.fence
        });
      case "native-stop-failure":
        // Codex 0.145 has no StopFailure hook; refuse rather than invent one.
        throw unsupportedSignal("codex", signal);
      default:
        throw unsupportedSignal("codex", signal);
    }
  }
};

const PROVIDER_LIFECYCLE_MAPPINGS: Readonly<Record<AgentAdapterId, ProviderLifecycleMapping>> =
  Object.freeze({
    claude: CLAUDE_LIFECYCLE_MAPPING,
    codex: CODEX_LIFECYCLE_MAPPING
  });

/**
 * Registry lookup: returns the mapping for an adapter without the caller
 * branching on the provider name. Unknown adapters fail closed.
 */
export function providerLifecycleMapping(adapterId: string): ProviderLifecycleMapping {
  const mapping = findProviderLifecycleMapping(adapterId);
  if (mapping === null) {
    throw new CanonicalLifecycleError(`No lifecycle mapping for adapter: ${adapterId}.`);
  }
  return mapping;
}

export function findProviderLifecycleMapping(adapterId: string): ProviderLifecycleMapping | null {
  return adapterId === "codex" || adapterId === "claude"
    ? PROVIDER_LIFECYCLE_MAPPINGS[adapterId]
    : null;
}

/** Neutral capability lookup for consumers that need only the readiness fact. */
export function preInputReadinessCapability(adapterId: string): PreInputReadinessCapability {
  return providerLifecycleMapping(adapterId).preInputReadiness;
}

/**
 * Maps a native signal through the adapter selected by its fence. The fence's
 * adapterId chooses the mapping, so a Codex signal can never be mapped by
 * Claude's rules or vice versa.
 */
export function mapNativeLifecycleSignal(
  signal: NativeLifecycleSignal
): CanonicalLifecycleEvent {
  return providerLifecycleMapping(signal.fence.adapterId).map(signal);
}

function unsupportedSignal(
  adapterId: AgentAdapterId,
  signal: NativeLifecycleSignal
): CanonicalLifecycleError {
  return new CanonicalLifecycleError(
    `Adapter ${adapterId} does not emit native signal: ${signal.kind}.`
  );
}
