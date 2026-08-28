import { createHash } from "node:crypto";

import type {
  AgentDriver,
  AgentDriverMappedHook,
  AgentDriverNativeHook
} from "./agentDriver.js";
import {
  createRuntimeObservation,
  runtimeObservationSemanticKey,
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
  return mapAgentDriverHooks(input)[0]!;
}

export function mapAgentDriverHooks(
  input: AgentDriverObservationInput
): readonly RuntimeObservation[] {
  requireMatchingDriver(input);
  const raw = input.driver.runtime.mapHook({
    hookEventName: input.hookEventName,
    payload: input.payload,
    ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId })
  });
  const mapped = Array.isArray(raw) ? raw : [raw];
  if (mapped.length === 0) throw new Error("Agent Driver Hook must map at least one observation.");
  const source = mapped.some((entry) => entry.kind === "turn.accepted")
    ? input.driver.runtime.observer?.source({
        hookEventName: input.hookEventName,
        payload: input.payload,
        ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId })
      }) ?? null
    : null;
  return Object.freeze(mapped.map((entry, index) => observation(
    { ...input, ordinal: (input.ordinal ?? 0) + index },
    source === null || entry.kind !== "turn.accepted" ? entry : {
      ...entry,
      payload: Object.freeze({ ...entry.payload, observerSource: source })
    }
  )));
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
  const requestOccurrenceId = mapped.kind === "activity.observed"
    && mapped.payload.usage?.semantics === "request-context"
    ? requireRequestOccurrenceId(mapped.payload.activityId)
    : undefined;
  const eventId = hookEventId(input, mapped, requestOccurrenceId);
  const fence = { ...input.fence, ...mapped.fence };
  return createRuntimeObservation({
    schemaVersion: 2,
    eventId,
    semanticKey: requestOccurrenceId === undefined
      ? runtimeObservationSemanticKey({
          eventId,
          kind: mapped.kind,
          fence,
          ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
          payload: mapped.payload
        })
      : `provider-request:${eventId}`,
    kind: mapped.kind,
    authority: "provider-structured",
    receivedAt: input.receivedAt,
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    fence,
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
  mapped: AgentDriverMappedHook,
  requestOccurrenceId?: string
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    input.driver.id,
    input.hookEventName,
    input.fence,
    mapped.kind,
    ...(requestOccurrenceId === undefined
      ? [mapped.payload]
      : [{ requestOccurrenceId }])
  ])).digest("hex");
  return `runtime-observation-${digest}`;
}

function requireRequestOccurrenceId(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0 || value.includes("\0")) {
    throw new Error("Request-context usage requires a stable activity id.");
  }
  return value.trim();
}
