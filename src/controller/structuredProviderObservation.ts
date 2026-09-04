import { randomUUID } from "node:crypto";

import { callController } from "../core/controllerClient.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import { standardAgentError } from "../runtime/agentError.js";
import {
  createRuntimeObservation,
  runtimeObservationSemanticKey,
  type RuntimeObservation,
  type RuntimeObservationKind,
  type RuntimeObservationPayload
} from "../runtime/runtimeObservation.js";
import type {
  StructuredProviderTurnReceipt,
  StructuredProviderTurnStarted,
  StructuredProviderTurnTerminal,
  StructuredProviderGoal
} from "../runtime/structuredProviderHost.js";
import { runtimeLifecycleSignalKey } from "../runtime/lifecycleReservation.js";
import { isForeignHandoverLockHeld } from "../release/runtimeRelease.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import { resolveRuntimeHookTurnFence } from "./runtimeHookTurnFence.js";

let structuredSequence = 0;

export async function publishStructuredProviderStarted(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  activationId: string;
  started: StructuredProviderTurnStarted;
}>): Promise<void> {
  if (input.started.clientOwned) return;
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = resolveRuntimeHookTurnFence(
    input.environment,
    adapterId,
    input.started.nativeSessionId,
    {
      nativeTurnId: input.started.nativeTurnId,
      sessionOnly: true
    }
  );
  const receiptId = `direct:${input.started.nativeTurnId}`;
  const startedObservation = observation({
    kind: "turn.accepted",
    observedAt: input.started.observedAt,
    sequence: nextStructuredSequence(),
    ordinal: 0,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: fence.agentId,
      driverId: driver.id,
      runtimeGenerationId: fence.runtimeGenerationId,
      conversationId: input.started.conversationId,
      activationId: requireIdentity(input.activationId, "Provider Activation id"),
      nativeSessionId: input.started.nativeSessionId,
      nativeTurnId: input.started.nativeTurnId,
      receiptId
    },
    payload: input.started.input === undefined ? {} : { input: input.started.input }
  });
  await persistAndApply(
    input.home,
    [startedObservation],
    fence.taskId,
    fence.roleName
  );
}

export async function publishStructuredProviderAccepted(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  activationId: string;
  receipt: StructuredProviderTurnReceipt;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const startupSession = driver.capabilities.observation.sessionBootstrap;
  const fence = resolveRuntimeHookTurnFence(
    input.environment,
    adapterId,
    input.receipt.nativeSessionId,
    {
      startupSession,
      nativeTurnId: input.receipt.nativeTurnId,
      attemptId: input.receipt.attemptId
    }
  );
  const observedAt = input.receipt.acceptedAt;
  const commonFence = {
    taskId: fence.taskId,
    roleName: fence.roleName,
    ...(fence.turnId === undefined ? {} : { turnId: fence.turnId }),
    agentId: fence.agentId,
    driverId: driver.id,
    runtimeGenerationId: fence.runtimeGenerationId,
    conversationId: input.receipt.conversationId,
    activationId: requireIdentity(input.activationId, "Provider Activation id"),
    nativeSessionId: input.receipt.nativeSessionId,
    nativeTurnId: input.receipt.nativeTurnId,
    // The structured Host owns the exact input attempt identity. Runtime
    // descriptor receipts name the Turn bootstrap and must not overwrite a
    // continuation or human-takeover Turn.
    receiptId: input.receipt.attemptId
  };
  const baseSequence = nextStructuredSequence();
  const observations = [observation({
    kind: startupSession === "preallocated" ? "session.ready" : "session.started",
    observedAt,
    sequence: baseSequence,
    ordinal: 0,
    fence: commonFence
  }), observation({
    kind: "conversation.observed",
    observedAt,
    sequence: baseSequence,
    ordinal: 1,
    fence: commonFence,
    payload: { recoverability: "recoverable" }
  }), observation({
    kind: "activation.started",
    observedAt,
    sequence: baseSequence,
    ordinal: 2,
    fence: commonFence
  }), observation({
    kind: "turn.accepted",
    observedAt,
    sequence: baseSequence,
    ordinal: 3,
    fence: commonFence
  })];
  await persistAndApply(input.home, observations, fence.taskId, fence.roleName);
}

export async function publishStructuredProviderOpened(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  conversationId: string;
  nativeSessionId: string;
  activationId: string;
  recoverability: "unknown" | "recoverable";
  observedAt: string;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const startupSession = driver.capabilities.observation.sessionBootstrap;
  const fence = resolveRuntimeHookTurnFence(
    input.environment,
    adapterId,
    input.nativeSessionId,
    { startupSession }
  );
  const commonFence = {
    taskId: fence.taskId,
    roleName: fence.roleName,
    ...(fence.turnId === undefined ? {} : { turnId: fence.turnId }),
    agentId: fence.agentId,
    driverId: driver.id,
    runtimeGenerationId: fence.runtimeGenerationId,
    conversationId: input.conversationId,
    activationId: requireIdentity(input.activationId, "Provider Activation id"),
    nativeSessionId: input.nativeSessionId,
    ...(fence.receiptId === undefined ? {} : { receiptId: fence.receiptId })
  };
  const sequence = nextStructuredSequence();
  const observations = [observation({
    kind: startupSession === "preallocated" ? "session.ready" : "session.started",
    observedAt: input.observedAt,
    sequence,
    ordinal: 0,
    fence: commonFence
  }), observation({
    kind: "conversation.observed",
    observedAt: input.observedAt,
    sequence,
    ordinal: 1,
    fence: commonFence,
    payload: { recoverability: input.recoverability }
  }), observation({
    kind: "activation.started",
    observedAt: input.observedAt,
    sequence,
    ordinal: 2,
    fence: commonFence
  })];
  await persistAndApply(input.home, observations, fence.taskId, fence.roleName);
}

export async function publishStructuredProviderGoal(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  activationId: string;
  conversationId: string;
  goal: StructuredProviderGoal | null;
  observedAt?: string;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = resolveRuntimeHookTurnFence(
    input.environment,
    adapterId,
    input.conversationId,
    { sessionOnly: true }
  );
  const goal = input.goal;
  const observedAt = input.observedAt ?? goal?.updatedAt ?? new Date().toISOString();
  const goalObservation = observation({
    kind: goal === null ? "goal.cleared" : "goal.updated",
    observedAt,
    sequence: nextStructuredSequence(),
    ordinal: 0,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      agentId: fence.agentId,
      driverId: driver.id,
      runtimeGenerationId: fence.runtimeGenerationId,
      conversationId: input.conversationId,
      activationId: requireIdentity(input.activationId, "Provider Activation id"),
      nativeSessionId: input.conversationId
    },
    payload: goal === null ? {} : {
      goalStatus: goal.status,
      goalObjective: goal.objective,
      goalUpdatedAt: goal.updatedAt,
      ...(goal.nativeTurnId === undefined ? {} : { goalNativeTurnId: goal.nativeTurnId }),
      ...(goal.tokenBudget === undefined ? {} : { goalTokenBudget: goal.tokenBudget })
    }
  });
  await persistAndApply(input.home, [goalObservation], fence.taskId, fence.roleName);
}

export async function publishStructuredConversationRecoverability(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  conversationId: string;
  activationId: string;
  recoverability: "recoverable" | "unrecoverable";
  observedAt: string;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = resolveRuntimeHookTurnFence(
    input.environment,
    adapterId,
    input.conversationId
  );
  const sequence = nextStructuredSequence();
  const observationFence = {
    taskId: fence.taskId,
    roleName: fence.roleName,
    ...(fence.turnId === undefined ? {} : { turnId: fence.turnId }),
    agentId: fence.agentId,
    driverId: driver.id,
    runtimeGenerationId: fence.runtimeGenerationId,
    conversationId: input.conversationId,
    activationId: requireIdentity(input.activationId, "Provider Activation id"),
    nativeSessionId: input.conversationId,
    ...(fence.receiptId === undefined ? {} : { receiptId: fence.receiptId })
  };
  const observations: RuntimeObservation[] = [observation({
    kind: "activation.started",
    observedAt: input.observedAt,
    sequence,
    ordinal: 0,
    fence: observationFence
  }), observation({
    kind: "conversation.observed",
    observedAt: input.observedAt,
    sequence,
    ordinal: 1,
    fence: observationFence,
    payload: { recoverability: input.recoverability }
  })];
  if (input.recoverability === "unrecoverable") {
    observations.push(observation({
      kind: "activation.failed",
      observedAt: input.observedAt,
      sequence,
      ordinal: 2,
      fence: observationFence,
      payload: {}
    }));
  }
  await persistAndApply(input.home, observations, fence.taskId, fence.roleName);
}

export async function publishStructuredProviderTerminal(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  activationId: string;
  terminal: StructuredProviderTurnTerminal;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = resolveRuntimeHookTurnFence(
    input.environment,
    adapterId,
    input.terminal.nativeSessionId,
    {
      terminal: true,
      nativeTurnId: input.terminal.nativeTurnId,
      ...(input.terminal.clientOwned ? {} : { sessionOnly: true })
    }
  );
  const kind: RuntimeObservationKind = input.terminal.status === "completed"
    ? "turn.completed"
    : input.terminal.status === "cancelled" ? "turn.cancelled" : "turn.failed";
  const payload: RuntimeObservationPayload = kind === "turn.completed"
    ? {
        ...(input.terminal.input === undefined ? {} : { input: input.terminal.input }),
        ...(input.terminal.summary === undefined ? {} : { summary: input.terminal.summary })
      }
    : kind === "turn.failed"
      ? {
          failure: {
            error: standardAgentError({
              source: "provider",
              phase: "turn-execute",
              classification: driver.runtime.mapError({
                message: input.terminal.error ?? "Provider Turn failed.",
                raw: input.terminal.rawError
                  ?? input.terminal.error
                  ?? "Provider Turn failed without an error payload."
              }),
              message: input.terminal.error ?? "Provider Turn failed.",
              raw: input.terminal.rawError
                ?? input.terminal.error
                ?? "Provider Turn failed without an error payload.",
              inputDisposition: "accepted"
            })
          },
          summary: input.terminal.error ?? "Provider Turn failed.",
          ...(input.terminal.input === undefined ? {} : { input: input.terminal.input })
        }
      : {};
  const terminalObservation = observation({
    kind,
    observedAt: input.terminal.observedAt,
    sequence: nextStructuredSequence(),
    ordinal: 0,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      ...(fence.turnId === undefined ? {} : { turnId: fence.turnId }),
      agentId: fence.agentId,
      driverId: driver.id,
      runtimeGenerationId: fence.runtimeGenerationId,
      conversationId: input.terminal.conversationId,
      activationId: requireIdentity(input.activationId, "Provider Activation id"),
      nativeSessionId: input.terminal.nativeSessionId,
      nativeTurnId: input.terminal.nativeTurnId,
      ...(fence.receiptId === undefined ? {} : { receiptId: fence.receiptId })
    },
    payload
  });
  await persistAndApply(
    input.home,
    [terminalObservation],
    fence.taskId,
    fence.roleName
  );
}

export async function publishStructuredProviderActivationTerminal(input: Readonly<{
  home: string;
  environment: NodeJS.ProcessEnv;
  conversationId: string;
  nativeSessionId: string;
  activationId: string;
  status: "ended" | "failed";
  observedAt: string;
}>): Promise<void> {
  const adapterId = requireIdentity(input.environment.YUI_ADAPTER_ID, "Agent adapter id");
  const driver = builtinAgentDriverRegistry().requireByAdapterId(adapterId);
  const fence = resolveRuntimeHookTurnFence(
    input.environment,
    adapterId,
    input.nativeSessionId,
    { sessionOnly: true }
  );
  const terminal = observation({
    kind: input.status === "failed" ? "activation.failed" : "activation.ended",
    observedAt: input.observedAt,
    sequence: nextStructuredSequence(),
    ordinal: 0,
    fence: {
      taskId: fence.taskId,
      roleName: fence.roleName,
      ...(fence.turnId === undefined ? {} : { turnId: fence.turnId }),
      agentId: fence.agentId,
      driverId: driver.id,
      runtimeGenerationId: fence.runtimeGenerationId,
      conversationId: requireIdentity(input.conversationId, "Provider Conversation id"),
      activationId: requireIdentity(input.activationId, "Provider Activation id"),
      nativeSessionId: requireIdentity(input.nativeSessionId, "native Session id"),
      ...(fence.receiptId === undefined ? {} : { receiptId: fence.receiptId })
    },
    payload: {}
  });
  await persistAndApply(input.home, [terminal], fence.taskId, fence.roleName);
}

function observation(input: Readonly<{
  kind: RuntimeObservationKind;
  observedAt: string;
  sequence: number;
  ordinal: number;
  fence: RuntimeObservation["fence"];
  payload?: RuntimeObservationPayload;
}>): RuntimeObservation {
  const eventId = `agent-host-${randomUUID()}`;
  const partial = {
    eventId,
    kind: input.kind,
    fence: input.fence,
    sequence: input.sequence,
    payload: input.payload ?? {}
  };
  return createRuntimeObservation({
    schemaVersion: 3,
    eventId,
    semanticKey: runtimeObservationSemanticKey(partial),
    kind: input.kind,
    authority: "provider-structured",
    receivedAt: new Date().toISOString(),
    observedAt: input.observedAt,
    sequence: input.sequence,
    ordinal: input.ordinal,
    fence: input.fence,
    payload: input.payload ?? {}
  });
}

async function signalController(home: string, taskId: string, roleName: string): Promise<void> {
  await callController(home, "scheduler.signal", {
    key: runtimeLifecycleSignalKey({ scope: "task", taskId, roleName })
  }, { timeoutMs: 100 }).catch(() => {});
}

function nextStructuredSequence(): number {
  structuredSequence = (structuredSequence + 1) % Number.MAX_SAFE_INTEGER;
  return structuredSequence;
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

async function persistAndApply(
  home: string,
  observations: readonly RuntimeObservation[],
  taskId: string,
  roleName: string
): Promise<void> {
  const inbox = new FileRuntimeEventInbox(home);
  for (const entry of observations) inbox.enqueueObservation(entry);
  // The immutable inbox is authoritative. During a release/update handover the
  // old Controller is draining and the replacement is not ready yet; leave the
  // entries for normal inbox replay instead of turning a healthy Provider Turn
  // into a transport failure.
  if (isForeignHandoverLockHeld(home)) return;
  for (const entry of observations) {
    let result: Readonly<{ outcome?: string }>;
    try {
      result = await callController(home, "runtime.observation-apply", entry, {
        timeoutMs: 10_000
      }) as Readonly<{ outcome?: string }>;
    } catch (error) {
      // Close the race where the handover begins after the first check but
      // before this socket call. The durable entry remains pending for replay.
      if (isForeignHandoverLockHeld(home)) return;
      throw error;
    }
    // A fast Provider can accept the initial Turn before the scheduler call
    // that launched this Host has returned and committed `turn.pushed`. The
    // immutable inbox entry already makes that exact fenced fact durable;
    // `deferred` therefore means "retained for replay", not delivery failure.
    // The signal below schedules the replay after the transport transaction.
    if (result.outcome !== "applied" && result.outcome !== "deferred") {
      throw new Error(`Structured Provider observation was not applied: ${result.outcome ?? "unknown"}.`);
    }
  }
  await signalController(home, taskId, roleName);
}
