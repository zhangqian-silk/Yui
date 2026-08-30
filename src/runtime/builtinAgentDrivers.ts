import {
  AgentDriverRegistry,
  type AgentDriverCapabilities,
  type AgentDriver,
  type AgentDriverMappedHook,
  type AgentDriverNativeHook
} from "./agentDriver.js";
import type {
  RuntimeObservationKind,
  RuntimeObservationPayload
} from "./runtimeObservation.js";
import {
  claudeTranscriptObserver,
  codexTranscriptObserver,
  transcriptObserverSource
} from "./builtinTranscriptObserver.js";
import { parseClaudeError } from "./providerErrorCodes.js";

export const CODEX_DRIVER_ID = "openai/codex";
export const CLAUDE_CODE_DRIVER_ID = "anthropic/claude-code";

export function builtinDriverIdForAdapter(adapterId: string): string {
  return builtinAgentDriverRegistry().requireByAdapterId(adapterId).id;
}

const STRUCTURED_CLI_CAPABILITIES: AgentDriverCapabilities = Object.freeze({
  surfaces: Object.freeze(["interactive-cli", "managed-protocol"] as const),
  lifecycle: Object.freeze({
    host: "persistent" as const,
    providerProcess: "persistent" as const,
    nativeConversationResume: "exact" as const,
    // Yui deliberately does not guess provider compaction behavior from token
    // counters. A future Driver may upgrade these only with exact native facts.
    compaction: "unknown" as const,
    compactionEvents: "unavailable" as const,
    contextUsage: "cumulative-only" as const,
    inSessionContinuation: true,
    deliveryDeduplication: "unsupported" as const
  }),
  control: Object.freeze({
    start: true,
    resume: true,
    sendTurn: true,
    interrupt: true,
    stop: true
  }),
  conversation: Object.freeze({
    persistentIdentity: "exact" as const,
    crossProcessResume: true,
    readback: "partial" as const
  }),
  input: Object.freeze({
    startTurn: true,
    steer: "unavailable" as const,
    inject: "unavailable" as const,
    acceptance: "exact" as const,
    idempotency: "unavailable" as const
  }),
  descendants: Object.freeze({
    lineage: "partial" as const,
    detachedQuery: "partial" as const,
    resultRouting: "partial" as const
  }),
  bounded: Object.freeze({ structuredTerminal: true }),
  observation: Object.freeze({
    sessionIdentity: "exact",
    sessionBootstrap: "discovered",
    preInputReadiness: "unavailable",
    promptAcceptance: "exact",
    turnLifecycle: "exact",
    // Transcript sources may emit an explicit activity identity separately
    // from usage snapshots. Numeric token values never decide runtime health.
    operations: Object.freeze(["tool", "subagent"] as const),
    waiting: Object.freeze(["permission"] as const),
    usage: "streaming-cumulative",
    delivery: "ordered-best-effort"
  })
});

export const BUILTIN_AGENT_DRIVERS: readonly AgentDriver[] = Object.freeze([
  Object.freeze({
    id: CLAUDE_CODE_DRIVER_ID,
    label: "Claude Code",
    protocolVersion: 1,
    adapterId: "claude",
    capabilities: Object.freeze({
      ...STRUCTURED_CLI_CAPABILITIES,
      observation: Object.freeze({
        ...STRUCTURED_CLI_CAPABILITIES.observation,
        sessionBootstrap: "preallocated" as const,
        preInputReadiness: "exact" as const,
        usage: "event-snapshot" as const
      })
    }),
    runtime: Object.freeze({
      nativeSessionId: ({ payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, ["session_id"])
      ),
      nativeTurnId: ({ payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, ["prompt_id", "turn_id"])
      ),
      mapHook: ({ hookEventName, payload, occurrenceId }: AgentDriverNativeHook) => (
        mapClaudeHook(hookEventName, payload, occurrenceId)
      ),
      classifyHook: ({ hookEventName, payload }: AgentDriverNativeHook) => Object.freeze({
        ...(hookEventName === "SessionStart" && payload.source === "startup"
          ? { startupSession: "preallocated" as const }
          : {}),
        terminal: isTerminalHook(hookEventName),
        ...(hookEventName !== "SubagentStop" ? {} : {
          continuationId: subagentId(payload),
          continuationGeneration: continuationGeneration(payload)
        })
      }),
      observer: Object.freeze({
        source: (input: AgentDriverNativeHook) => transcriptObserverSource(
          CLAUDE_CODE_DRIVER_ID,
          input
        ),
        sample: claudeTranscriptObserver
      })
    })
  }),
  Object.freeze({
    id: CODEX_DRIVER_ID,
    label: "Codex",
    protocolVersion: 1,
    adapterId: "codex",
    capabilities: Object.freeze({
      ...STRUCTURED_CLI_CAPABILITIES,
      surfaces: Object.freeze(["interactive-cli", "managed-protocol"] as const),
      conversation: Object.freeze({
        persistentIdentity: "exact" as const,
        crossProcessResume: true,
        readback: "exact" as const
      }),
      input: Object.freeze({
        startTurn: true,
        steer: "fenced" as const,
        inject: "fenced" as const,
        acceptance: "exact" as const,
        idempotency: "unavailable" as const
      }),
      descendants: Object.freeze({
        lineage: "partial" as const,
        detachedQuery: "partial" as const,
        resultRouting: "partial" as const
      }),
      observation: Object.freeze({
        ...STRUCTURED_CLI_CAPABILITIES.observation,
        // Managed Codex uses its Yui-owned proxy subscription to the shared
        // App Server event stream.
        // Turn lifecycle is exact; Yui does not install per-thread Hooks merely
        // to manufacture tool/wait/usage observations.
        operations: Object.freeze([] as const),
        waiting: Object.freeze([] as const),
        usage: "unavailable" as const
      })
    }),
    runtime: Object.freeze({
      nativeSessionId: ({ payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, ["session_id"])
      ),
      nativeTurnId: ({ payload }: AgentDriverNativeHook) => (
        optionalIdentityFrom(payload, ["turn_id", "prompt_id"])
      ),
      mapHook: ({ hookEventName, payload, occurrenceId }: AgentDriverNativeHook) => (
        mapCodexHook(hookEventName, payload, occurrenceId)
      ),
      classifyHook: ({ hookEventName, payload }: AgentDriverNativeHook) => Object.freeze({
        ...(hookEventName === "SessionStart"
          ? { startupSession: "discovered" as const }
          : {}),
        terminal: isTerminalHook(hookEventName),
        ...(hookEventName !== "SubagentStop" ? {} : {
          continuationId: subagentId(payload),
          continuationGeneration: continuationGeneration(payload)
        })
      }),
      observer: Object.freeze({
        source: (input: AgentDriverNativeHook) => transcriptObserverSource(
          CODEX_DRIVER_ID,
          input
        ),
        sample: codexTranscriptObserver
      })
    })
  })
]);

export function builtinAgentDriverRegistry(): AgentDriverRegistry {
  const registry = new AgentDriverRegistry();
  for (const descriptor of BUILTIN_AGENT_DRIVERS) registry.register(descriptor);
  return registry;
}

type MappedHook = AgentDriverMappedHook;

function mapClaudeHook(
  name: string,
  payload: Readonly<Record<string, unknown>>,
  occurrenceId?: string
): MappedHook | readonly MappedHook[] {
  switch (name) {
    case "SessionStart":
      return [
        payload.source === "startup"
          ? mapped("session.ready")
          : mapped("session.started"),
        mapped("conversation.observed", { recoverability: "recoverable" }),
        mapped("activation.started")
      ];
    case "UserPromptSubmit":
      return mapped("turn.accepted");
    case "PreToolUse":
      return operation("operation.started", "tool", toolId(payload));
    case "PostToolUse":
      return operation("operation.completed", "tool", toolId(payload));
    case "PostToolUseFailure":
      return operation("operation.failed", "tool", toolId(payload));
    case "PermissionRequest":
      return mapped("turn.waiting", {
        reason: "permission",
        waitId: optionalIdentityFrom(payload, ["tool_use_id", "call_id"]) ?? requireOccurrence(occurrenceId)
      });
    case "MessageDisplay": {
      const messageId = optionalIdentityFrom(payload, ["message_id"]);
      const index = typeof payload.index === "number" && Number.isSafeInteger(payload.index)
        ? String(payload.index)
        : undefined;
      return mapped("activity.observed", {
        activity: "model",
        activityId: messageId === undefined
          ? requireOccurrence(occurrenceId)
          : `${messageId}:${index ?? "message"}`
      });
    }
    case "SubagentStart":
      return [
        operation("operation.started", "subagent", subagentId(payload)),
        continuationObservation("continuation.started", payload, {
          execution: "active",
          outcome: "pending",
          attachment: "attached",
          observationQuality: "exact",
          mayWriteWorkspace: true
        })
      ];
    case "SubagentStop":
      return [
        operation("operation.completed", "subagent", subagentId(payload)),
        ...(optionalSummary(payload).summary === undefined ? [] : [
          continuationObservation("continuation.reported", payload, {
            execution: "quiescent",
            outcome: "succeeded",
            attachment: "attached",
            observationQuality: "exact",
            mayWriteWorkspace: false,
            reportId: reportId(payload),
            ...optionalSummary(payload)
          })
        ]),
        continuationObservation("continuation.settled", payload, {
          execution: "quiescent",
          outcome: continuationOutcome(payload),
          attachment: "attached",
          observationQuality: "exact",
          mayWriteWorkspace: false,
          ...optionalSummary(payload)
        })
      ];
    case "Stop":
      return [
        mapped("turn.completed", optionalSummary(payload)),
        mapped("native-work.snapshot", {
          snapshotComplete: payload.background_tasks_complete === true,
          observationQuality: payload.background_tasks_complete === true ? "exact" : "partial"
        })
      ];
    case "StopFailure":
      return mapped("turn.failed", claudeFailure(payload));
    case "SessionEnd":
      return [mapped("session.ended"), mapped("activation.ended")];
    default:
      throw new Error(`Claude Code Driver does not support Hook event: ${name}.`);
  }
}

function mapCodexHook(
  name: string,
  payload: Readonly<Record<string, unknown>>,
  occurrenceId?: string
): MappedHook | readonly MappedHook[] {
  switch (name) {
    case "SessionStart":
      return [
        mapped("session.started"),
        mapped("conversation.observed", { recoverability: "recoverable" }),
        mapped("activation.started")
      ];
    case "UserPromptSubmit":
      return mapped("turn.accepted");
    case "PreToolUse":
      return operation("operation.started", "tool", toolId(payload));
    case "PostToolUse":
      return operation("operation.completed", "tool", toolId(payload));
    case "PostToolUseFailure":
      return operation("operation.failed", "tool", toolId(payload));
    case "PermissionRequest":
      return mapped("turn.waiting", {
        reason: "permission",
        waitId: optionalIdentityFrom(payload, ["tool_use_id", "call_id", "tool_call_id"])
          ?? requireOccurrence(occurrenceId)
      });
    case "SubagentStart":
      return [
        operation("operation.started", "subagent", subagentId(payload)),
        continuationObservation("continuation.started", payload, {
          execution: "active",
          outcome: "pending",
          attachment: "attached",
          observationQuality: "partial",
          mayWriteWorkspace: true
        })
      ];
    case "SubagentStop":
      return [
        operation("operation.completed", "subagent", subagentId(payload)),
        continuationObservation("continuation.reported", payload, {
          execution: "unknown",
          outcome: "unknown",
          attachment: "attached",
          observationQuality: "partial",
          mayWriteWorkspace: true,
          reportId: reportId(payload),
          ...optionalSummary(payload)
        })
      ];
    case "Stop":
      return mapped("turn.completed", optionalSummary(payload));
    case "SessionEnd":
      return [mapped("session.ended"), mapped("activation.ended")];
    default:
      throw new Error(`Codex Driver does not support Hook event: ${name}.`);
  }
}

function mapped(
  kind: RuntimeObservationKind,
  payload: RuntimeObservationPayload = {},
  fence?: AgentDriverMappedHook["fence"]
): MappedHook {
  return Object.freeze({
    kind,
    payload: Object.freeze({ ...payload }),
    ...(fence === undefined ? {} : { fence: Object.freeze({ ...fence }) })
  });
}

function continuationObservation(
  kind: "continuation.started" | "continuation.reported" | "continuation.settled",
  native: Readonly<Record<string, unknown>>,
  payload: RuntimeObservationPayload
): MappedHook {
  const continuationId = subagentId(native);
  const generation = continuationGeneration(native);
  return mapped(kind, payload, {
    continuationId,
    continuationGeneration: generation,
    ...(optionalIdentityFrom(native, ["parent_agent_id", "parent_subagent_id"]) === undefined
      ? {}
      : {
          parentContinuationId: optionalIdentityFrom(
            native,
            ["parent_agent_id", "parent_subagent_id"]
          )
        })
  });
}

function continuationGeneration(native: Readonly<Record<string, unknown>>): number {
  return typeof native.generation === "number"
    && Number.isSafeInteger(native.generation) && native.generation >= 1
    ? native.generation
    : 1;
}

function reportId(payload: Readonly<Record<string, unknown>>): string {
  return optionalIdentityFrom(payload, ["report_id", "message_id", "agent_id", "subagent_id"])
    ?? subagentId(payload);
}

function continuationOutcome(
  payload: Readonly<Record<string, unknown>>
): "succeeded" | "failed" | "cancelled" | "unknown" {
  if (payload.cancelled === true || payload.status === "cancelled") return "cancelled";
  if (payload.error !== undefined || payload.status === "failed") return "failed";
  if (payload.status === undefined || payload.status === "completed" || payload.status === "succeeded") {
    return "succeeded";
  }
  return "unknown";
}

function operation(
  kind: "operation.started" | "operation.completed" | "operation.failed",
  operationKind: "tool" | "subagent",
  operationId: string
): MappedHook {
  return mapped(kind, { operationId, operation: operationKind });
}

function toolId(payload: Readonly<Record<string, unknown>>): string {
  return firstIdentity(payload, ["tool_use_id", "call_id", "tool_call_id"], "Tool operation id");
}

function subagentId(payload: Readonly<Record<string, unknown>>): string {
  return firstIdentity(payload, ["agent_id", "subagent_id"], "Subagent operation id");
}

function firstIdentity(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string
): string {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0 && !value.includes("\0")) {
      return value.trim();
    }
  }
  throw new Error(`${label} is required.`);
}

function optionalIdentityFrom(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[]
): string | undefined {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0 && !value.includes("\0")) {
      return value.trim();
    }
  }
  return undefined;
}

function optionalSummary(
  payload: Readonly<Record<string, unknown>>,
  preferred = "last_assistant_message"
): RuntimeObservationPayload {
  for (const field of [preferred, "summary", "message"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return { summary: value.trim() };
    }
  }
  return {};
}

function claudeFailure(
  payload: Readonly<Record<string, unknown>>
): RuntimeObservationPayload {
  const code = firstIdentity(payload, ["error"], "Claude StopFailure error");
  const details = optionalText(payload.error_details);
  const lastOutput = optionalText(payload.last_assistant_message);
  const parsed = parseClaudeError(code, details);
  const retryAfterMs = typeof payload.retry_after_ms === "number"
    && Number.isSafeInteger(payload.retry_after_ms)
    && payload.retry_after_ms > 0
    ? payload.retry_after_ms
    : undefined;
  return {
    failure: {
      ...(parsed.code !== "unknown" ? { errorCode: parsed.code } : {}),
      code,
      ...(details === undefined ? {} : { details }),
      ...(lastOutput === undefined ? {} : { lastOutput }),
      ...(payload.run_terminal === true || payload.unrecoverable === true
        ? { runTerminal: true }
        : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    },
    summary: [
      "Agent turn failed.",
      `error: ${code}`,
      ...(details === undefined ? [] : [`details: ${details}`]),
      ...(lastOutput === undefined ? [] : [`last_output: ${lastOutput}`])
    ].join("\n")
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isTerminalHook(name: string): boolean {
  return name === "Stop" || name === "StopFailure" || name === "SessionEnd";
}

function requireOccurrence(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Agent Driver Hook occurrence id is required.");
  }
  return value;
}
