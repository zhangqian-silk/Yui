import { createHash } from "node:crypto";

import type {
  AgentDriver,
  AgentDriverMappedHook,
  AgentDriverNativeHook
} from "./agentDriver.js";
import {
  createRuntimeObservation,
  type RuntimeObservation,
  type RuntimeObservationFence,
  type RuntimeUsageSnapshot
} from "./runtimeObservation.js";

export type AgentDriverObservationInput = AgentDriverNativeHook & Readonly<{
  driver: AgentDriver;
  receivedAt: string;
  observedAt?: string;
  sequence?: number;
  ordinal?: number;
  fence: RuntimeObservationFence;
}>;

export function mapAgentDriverHook(
  input: AgentDriverObservationInput
): RuntimeObservation {
  requireMatchingDriver(input);
  const mapped = input.driver.runtime.mapHook({
    hookEventName: input.hookEventName,
    payload: input.payload,
    ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId })
  });
  const source = mapped.kind === "turn.accepted"
    ? input.driver.runtime.observer?.source({
        hookEventName: input.hookEventName,
        payload: input.payload,
        ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId })
      }) ?? null
    : null;
  return observation(input, source === null ? mapped : {
    ...mapped,
    payload: Object.freeze({ ...mapped.payload, observerSource: source })
  });
}

export function mapAgentDriverUsage(
  input: AgentDriverObservationInput,
  usage: RuntimeUsageSnapshot
): RuntimeObservation {
  requireMatchingDriver(input);
  return observation(input, {
    kind: "activity.observed",
    payload: Object.freeze({ activity: "model", usage })
  });
}

function observation(
  input: AgentDriverObservationInput,
  mapped: AgentDriverMappedHook
): RuntimeObservation {
  return createRuntimeObservation({
    schemaVersion: 1,
    eventId: hookEventId(input, mapped),
    kind: mapped.kind,
    authority: "provider-structured",
    receivedAt: input.receivedAt,
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    fence: input.fence,
    payload: mapped.payload
  });
}

function requireMatchingDriver(input: AgentDriverObservationInput): void {
  if (input.fence.driverId !== input.driver.id) {
    throw new Error("Agent Driver Hook fence does not match the selected Driver.");
  }
}

function hookEventId(
  input: AgentDriverObservationInput,
  mapped: AgentDriverMappedHook
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    input.driver.id,
    input.hookEventName,
    input.fence,
    mapped.kind,
    mapped.payload
  ])).digest("hex");
  return `runtime-observation-${digest}`;
}
