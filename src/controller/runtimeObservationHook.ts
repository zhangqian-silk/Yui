import { callController } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import {
  builtinAgentDriverRegistry
} from "../runtime/builtinAgentDrivers.js";
import {
  AgentDriverRegistry,
  normalizeAgentDriverHookClassification
} from "../runtime/agentDriver.js";
import {
  mapAgentDriverHooks
} from "../runtime/agentDriverObservation.js";
import { runtimeLifecycleSignalKey } from "../runtime/lifecycleReservation.js";
import type { RuntimeObservation } from "../runtime/runtimeObservation.js";
import { formatTurnReceiptId } from "../task/taskRecordReference.js";
import {
  boundedTurnFailureDiagnostic,
  transportAgentResult
} from "../domain/agentResultTransport.js";
import {
  FileRuntimeEventInbox,
  MAX_RUNTIME_EVENT_FILE_BYTES,
  type RuntimeTurnTerminalOutcome
} from "./runtimeEventInbox.js";
import { resolveRuntimeHookTurnFence } from "./runtimeHookTurnFence.js";
import type {
  RuntimeHookTurnFence,
  RuntimeHookTurnFenceOptions
} from "./runtimeHookTurnFence.js";

type ControllerCall = (
  home: string,
  method: string,
  params: JsonValue,
  options?: Readonly<{ timeoutMs?: number }>
) => Promise<JsonValue>;

export type ParsedRuntimeObservationHook = Readonly<{
  home: string;
  taskId: string;
  roleName: string;
  observations: readonly RuntimeObservation[];
}>;

type ResolveTurnFence = (
  environment: NodeJS.ProcessEnv,
  adapterId: string,
  nativeSessionId: string,
  options: RuntimeHookTurnFenceOptions
) => RuntimeHookTurnFence;

export type RuntimeObservationHookDependencies = Readonly<{
  drivers?: AgentDriverRegistry;
  resolveTurnFence?: ResolveTurnFence;
  sequence?: () => number;
}>;

/**
 * Single hidden ingress for every structured CLI Driver Hook. Native event
 * names and payload shapes terminate here; the durable inbox contains only a
 * provider-independent RuntimeObservation with an exact generation/Turn fence.
 */
export async function runRuntimeObservationHookCommand(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  call: ControllerCall = callController,
  now: Date = new Date(),
  dependencies: RuntimeObservationHookDependencies = {}
): Promise<void> {
  if (environment.YUI_SESSION_SCOPE === "global") {
    await runGlobalRuntimeTurnHook(stdinJson, environment, call, now, dependencies);
    return;
  }
  const parsed = parseRuntimeObservationHook(stdinJson, environment, now, dependencies);
  const inbox = new FileRuntimeEventInbox(parsed.home);
  for (const observation of parsed.observations) inbox.enqueueObservation(observation);
  // The immutable inbox write is authoritative. The socket call only reduces
  // observation latency when the Controller is currently available.
  await call(
    parsed.home,
    "scheduler.signal",
    {
      key: runtimeLifecycleSignalKey({
        scope: "task",
        taskId: parsed.taskId,
        roleName: parsed.roleName
      })
    },
    { timeoutMs: 100 }
  ).catch(() => {});
}

async function runGlobalRuntimeTurnHook(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv,
  call: ControllerCall,
  now: Date,
  dependencies: RuntimeObservationHookDependencies
): Promise<void> {
  const payload = parseObject(stdinJson);
  const hookEventName = requireIdentity(payload.hook_event_name, "Agent Driver Hook event name");
  if (hookEventName !== "Stop" && hookEventName !== "StopFailure") return;

  const driverId = requireIdentity(environment.YUI_DRIVER_ID, "Agent Driver id");
  const driver = (dependencies.drivers ?? builtinAgentDriverRegistry()).require(driverId);
  if (driver.adapterId !== "claude" || environment.YUI_ADAPTER_ID !== driver.adapterId) {
    throw new Error("Global runtime Hook requires the Claude adapter.");
  }
  const occurrenceId = `${now.toISOString()}:${(dependencies.sequence ?? monotonicSequence)()}`;
  const nativeHook = Object.freeze({ hookEventName, payload, occurrenceId });
  const nativeSessionId = requireIdentity(
    driver.runtime.nativeSessionId(nativeHook),
    "Agent Driver native Session id"
  );
  if (nativeSessionId !== requireIdentity(
    environment.YUI_NATIVE_SESSION_ID,
    "YUI native session id"
  )) {
    throw new Error("Global runtime Hook native Session does not match its launch envelope.");
  }
  const home = requireIdentity(environment.YUI_HOME, "YUI_HOME");
  const roleName = requireIdentity(environment.YUI_ROLE, "Role name");
  new FileRuntimeEventInbox(home, () => now).enqueueTurnTerminal({
    scope: "global",
    roleName,
    agentId: requireIdentity(environment.YUI_AGENT_ID, "Agent id"),
    adapterId: "claude",
    runtimeGenerationId: requireIdentity(environment.YUI_RUNTIME_GENERATION_ID, "Runtime generation id"),
    nativeSessionId,
    nativeTurnId: optionalIdentity(driver.runtime.nativeTurnId(nativeHook)) ?? occurrenceId,
    ...(environment.YUI_SESSION_TITLE === undefined
      ? {}
      : { title: requireIdentity(environment.YUI_SESSION_TITLE, "Session title") }),
    providerStatus: hookEventName === "Stop" ? "completed" : "failed",
    outcome: globalHookOutcome(payload, hookEventName)
  });
  await call(
    home,
    "scheduler.signal",
    { key: runtimeLifecycleSignalKey({ scope: "global", roleName }) },
    { timeoutMs: 100 }
  ).catch(() => {});
}

function globalHookOutcome(
  payload: Readonly<Record<string, unknown>>,
  hookEventName: "Stop" | "StopFailure"
): RuntimeTurnTerminalOutcome {
  if (hookEventName === "Stop") {
    return transportAgentResult(payload.last_assistant_message);
  }
  const diagnostic = [payload.error, payload.error_details]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return {
    status: "failed",
    failureReason: "runtime-failed",
    diagnostic: boundedTurnFailureDiagnostic(diagnostic)
  };
}

export function parseRuntimeObservationHook(
  stdinJson: string | undefined,
  environment: NodeJS.ProcessEnv,
  now: Date = new Date(),
  dependencies: RuntimeObservationHookDependencies = {}
): ParsedRuntimeObservationHook {
  const payload = parseObject(stdinJson);
  const drivers = dependencies.drivers ?? builtinAgentDriverRegistry();
  const driverId = requireIdentity(environment.YUI_DRIVER_ID, "Agent Driver id");
  const driver = drivers.require(driverId);
  const hookEventName = requireIdentity(payload.hook_event_name, "Agent Driver Hook event name");
  const receivedAt = now.toISOString();
  const sequence = (dependencies.sequence ?? monotonicSequence)();
  const occurrenceId = `${receivedAt}:${sequence}`;
  const nativeHook = Object.freeze({ hookEventName, payload, occurrenceId });
  const nativeSessionId = requireIdentity(
    driver.runtime.nativeSessionId(nativeHook),
    "Agent Driver native Session id"
  );
  const nativeTurnId = optionalIdentity(driver.runtime.nativeTurnId(nativeHook));
  const classification = normalizeAgentDriverHookClassification(
    driver.runtime.classifyHook(nativeHook)
  );
  const fence = (dependencies.resolveTurnFence ?? resolveRuntimeHookTurnFence)(
    environment,
    driver.adapterId,
    nativeSessionId,
    {
      ...(classification.startupSession === undefined
        ? {}
        : { startupSession: classification.startupSession }),
      terminal: classification.terminal,
      ...(classification.continuationId === undefined ? {} : {
        continuationId: classification.continuationId,
        continuationGeneration: classification.continuationGeneration ?? 1
      }),
      ...(nativeTurnId === undefined ? {} : { nativeTurnId })
    }
  );
  if (fence.turnId === undefined) {
    throw new Error("Agent Driver Hook requires a managed Turn.");
  }
  const driverInput = {
    driver,
    hookEventName,
    receivedAt,
    // Hook commands run in separate short-lived processes. CLOCK_MONOTONIC is
    // shared by those processes on the host, so this preserves their order
    // when wall-clock timestamps land in the same millisecond.
    sequence,
    occurrenceId,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      turnId: fence.turnId,
      agentId: fence.agentId,
      driverId,
      runtimeGenerationId: fence.runtimeGenerationId,
      conversationId: fence.nativeSessionId,
      activationId: fence.runtimeGenerationId,
      nativeSessionId: fence.nativeSessionId,
      nativeTurnId: nativeTurnId ?? fence.turnId,
      receiptId: fence.receiptId ?? formatTurnReceiptId(fence.taskId, fence.turnId)
    },
    payload
  } as const;
  const observations = mapAgentDriverHooks({ ...driverInput, ordinal: 0 });
  return {
    home: requireIdentity(environment.YUI_HOME, "YUI_HOME"),
    taskId: fence.taskId,
    roleName: fence.roleName,
    observations: Object.freeze(observations)
  };
}

function monotonicSequence(): number {
  return Number(process.hrtime.bigint() / 1_000n);
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (value === undefined
    || Buffer.byteLength(value, "utf8") > MAX_RUNTIME_EVENT_FILE_BYTES) {
    throw new Error("Agent Driver lifecycle Hook stdin JSON is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Agent Driver lifecycle Hook stdin JSON is invalid.");
  }
}

function optionalIdentity(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireIdentity(value, "Agent Driver native Turn id");
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
