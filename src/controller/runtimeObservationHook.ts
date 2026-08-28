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
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import {
  FileRuntimeEventInbox,
  MAX_RUNTIME_EVENT_FILE_BYTES
} from "./runtimeEventInbox.js";
import { resolveRuntimeHookRunFence } from "./runtimeHookRunFence.js";
import type {
  RuntimeHookRunFence,
  RuntimeHookRunFenceOptions
} from "./runtimeHookRunFence.js";

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

type ResolveRunFence = (
  environment: NodeJS.ProcessEnv,
  adapterId: string,
  nativeSessionId: string,
  options: RuntimeHookRunFenceOptions
) => RuntimeHookRunFence;

export type RuntimeObservationHookDependencies = Readonly<{
  drivers?: AgentDriverRegistry;
  resolveRunFence?: ResolveRunFence;
  sequence?: () => number;
}>;

/**
 * Single hidden ingress for every structured CLI Driver Hook. Native event
 * names and payload shapes terminate here; the durable inbox contains only a
 * provider-independent RuntimeObservation with an exact generation/Run fence.
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
  new FileRuntimeEventInbox(home, () => now).enqueueTurnCompleted({
    scope: "global",
    roleName,
    agentId: requireIdentity(environment.YUI_AGENT_ID, "Agent id"),
    adapterId: "claude",
    launchId: requireIdentity(environment.YUI_LAUNCH_ID, "Launch id"),
    nativeSessionId,
    turnId: optionalIdentity(driver.runtime.nativeTurnId(nativeHook)) ?? occurrenceId,
    ...(environment.YUI_SESSION_TITLE === undefined
      ? {}
      : { title: requireIdentity(environment.YUI_SESSION_TITLE, "Session title") }),
    summary: globalHookSummary(payload, hookEventName)
  });
  await call(
    home,
    "scheduler.signal",
    { key: runtimeLifecycleSignalKey({ scope: "global", roleName }) },
    { timeoutMs: 100 }
  ).catch(() => {});
}

function globalHookSummary(
  payload: Readonly<Record<string, unknown>>,
  hookEventName: "Stop" | "StopFailure"
): string {
  for (const field of ["last_assistant_message", "summary", "message", "error"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return hookEventName === "Stop" ? "Native Turn completed." : "Native Turn failed.";
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
  const fence = (dependencies.resolveRunFence ?? resolveRuntimeHookRunFence)(
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
      runId: fence.runId,
      agentId: fence.agentId,
      driverId,
      launchId: fence.launchId,
      sessionGenerationId: fence.launchId,
      conversationId: fence.nativeSessionId,
      activationId: fence.launchId,
      nativeSessionId: fence.nativeSessionId,
      nativeTurnId: nativeTurnId ?? fence.runId,
      receiptId: fence.receiptId ?? formatAgentRunReceiptId(fence.taskId, fence.runId)
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
