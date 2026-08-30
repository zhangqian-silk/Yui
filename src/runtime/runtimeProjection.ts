import type { AgentRuntimeOperation, AgentRuntimeWaitReason } from "./agentDriver.js";
import {
  createRuntimeObservation,
  runtimeObservationFromTaskEvent,
  runtimeObservationRunFenceMatches,
  type RuntimeObservation,
  type RuntimeObservationFence,
  type RuntimeUsageSnapshot
} from "./runtimeObservation.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { WorkMailbox } from "../coordination/workMailbox.js";
import {
  DEFAULT_RUNTIME_HEALTH_POLICY,
  type RuntimeHealthPolicy
} from "./runtimeHealthPolicy.js";

export type RuntimeDisplayStatus =
  | "starting"
  | "awaiting-provider-acceptance"
  | "model-active"
  | "tool-active"
  | "subagent-active"
  | "waiting-user"
  | "waiting-permission"
  | "waiting-external"
  | "active-quiet"
  | "ready"
  | "runtime-unobservable"
  | "stopped"
  | "broken";

export type RuntimeProjection = Readonly<{
  fence: RuntimeObservationFence;
  host: "unknown" | "alive" | "exited";
  session: "unknown" | "started" | "ready" | "active" | "waiting" | "ended" | "failed";
  turn: "none" | "accepted" | "waiting" | "completed" | "failed" | "cancelled";
  conversation: "unknown" | "recoverable" | "unrecoverable";
  activation: "none" | "active" | "ended" | "failed";
  continuations: Readonly<Record<string, Readonly<{
    execution: "active" | "quiescent" | "unknown";
    outcome: "pending" | "succeeded" | "failed" | "cancelled" | "unknown";
    attachment: "attached" | "detached";
    observation: "exact" | "partial" | "unavailable";
    mayWriteWorkspace: boolean;
    identityConflict: boolean;
    resultRef?: string;
  }>>>;
  inputDelivery: "none" | "dispatching" | "delivery-unknown";
  runActivity: "starting" | "running" | "waiting" | "parked";
  health: "healthy" | "reconciling" | "unobservable";
  waitingOn: readonly string[];
  attention: readonly string[];
  waitingReason?: AgentRuntimeWaitReason;
  waitId?: string;
  operations: Readonly<Record<string, Readonly<{
    kind: AgentRuntimeOperation;
    startedAt: string;
  }>>>;
  activity: Readonly<{
    kind: "none" | "model" | "tool" | "subagent" | "provider" | "resource";
    observedAt?: string;
  }>;
  usage?: RuntimeUsageSnapshot;
  observer: Readonly<{
    status: "unknown" | "healthy" | "degraded" | "unavailable";
    sourceId?: string;
    detail?: string;
  }>;
  lastRuntimeActivityAt?: string;
  stateSince: string;
  workflow: Readonly<{
    lastSemanticProgressAt: string;
    completed: boolean;
    blocked: boolean;
  }>;
}>;

/**
 * Layered runtime health state shared by the CLI status projection, the Web
 * snapshot, and the scheduler. Short silence is a hint, not a failure. The
 * durable semantic window schedules read-only diagnosis; it does not itself
 * authorize an execution mutation.
 */
export type RuntimeHealthLayer =
  | "model-active"
  | "tool-active"
  | "subagent-active"
  | "active-quiet"
  | "quiet"
  | "diagnostic-needed"
  | "waiting-user"
  | "waiting-permission"
  | "waiting-external"
  | "stopped"
  | "broken"
  | "ready"
  | "starting"
  | "awaiting-provider-acceptance"
  | "runtime-unobservable";

export type RuntimeHealthClassification = Readonly<{
  layer: RuntimeHealthLayer;
  reason: string;
  lastRuntimeActivityAt?: string;
  lastSemanticProgressAt: string;
  activeOperations: readonly string[];
  host: "unknown" | "alive" | "exited";
  observerStatus: "unknown" | "healthy" | "degraded" | "unavailable";
  runtimeIdleMs: number;
  semanticIdleMs: number;
}>;

export function createRuntimeProjection(
  fence: RuntimeObservationFence,
  createdAt: string
): RuntimeProjection {
  const timestamp = requireTimestamp(createdAt);
  return Object.freeze({
    fence: Object.freeze({ ...fence }),
    host: "unknown",
    session: "unknown",
    turn: "none",
    conversation: "unknown",
    activation: "none",
    continuations: Object.freeze({}),
    inputDelivery: "none",
    runActivity: "starting",
    health: "reconciling",
    waitingOn: Object.freeze([]),
    attention: Object.freeze([]),
    operations: Object.freeze({}),
    activity: Object.freeze({ kind: "none" }),
    observer: Object.freeze({ status: "unknown" }),
    stateSince: timestamp,
    workflow: Object.freeze({
      lastSemanticProgressAt: timestamp,
      completed: false,
      blocked: false
    })
  });
}

export function projectRuntimeTaskEvents(
  fence: RuntimeObservationFence,
  createdAt: string,
  events: readonly TaskEvent[]
): RuntimeProjection {
  const observations = events
    .map(runtimeObservationFromTaskEvent)
    .filter((event): event is RuntimeObservation => (
      event !== null && runtimeObservationRunFenceMatches(fence, event.fence)
    ))
    .sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? -1) - (right.sequence ?? -1)
      || (left.ordinal ?? -1) - (right.ordinal ?? -1)
      || left.eventId.localeCompare(right.eventId)
    ));
  return observations.reduce(projectRuntimeObservation, createRuntimeProjection(fence, createdAt));
}

export function projectRuntimeObservation(
  current: RuntimeProjection,
  raw: RuntimeObservation
): RuntimeProjection {
  const event = createRuntimeObservation(raw);
  if (!runtimeObservationRunFenceMatches(current.fence, event.fence)) {
    throw new Error("Runtime observation fence does not match the projection.");
  }
  const at = event.receivedAt;
  switch (event.kind) {
    case "host.observed":
      return next(current, {
        host: event.payload.alive ? "alive" : "exited",
        stateSince: at
      });
    case "session.started":
      return next(current, {
        session: "started",
        conversation: "recoverable",
        activation: "active",
        stateSince: at
      });
    case "session.ready":
      return next(current, { session: "ready", stateSince: at });
    case "session.ended":
      return next(current, {
        session: "ended",
        activation: "ended",
        turn: terminalTurn(current.turn),
        // A parent provider Session ending is independent from native child
        // operations already observed under the Run. Keep those children
        // visible until their own terminal facts arrive; host/session loss is
        // health evidence, not proof that child work or the Yui Run ended.
        operations: activeSubagentOperations(current.operations),
        stateSince: at
      });
    case "session.failed":
      return next(current, {
        session: "failed",
        activation: "failed",
        turn: current.turn === "none" ? "failed" : terminalTurn(current.turn, "failed"),
        operations: activeSubagentOperations(current.operations),
        stateSince: at
      });
    case "turn.accepted":
    case "input.accepted":
      return withActivity(next(current, {
        session: "active",
        turn: "accepted",
        waitingReason: undefined,
        waitId: undefined,
        stateSince: at
      }), "provider", at);
    case "turn.waiting":
      return next(current, {
        session: "waiting",
        turn: "waiting",
        waitingReason: event.payload.reason,
        waitId: event.payload.waitId,
        stateSince: at
      });
    case "turn.completed":
      return withActivity(next(current, {
        session: "ready",
        turn: "completed",
        waitingReason: undefined,
        waitId: undefined,
        // Tool operations belong to the completed native Turn. Provider-owned
        // background subagents may legitimately outlive it and wake later
        // native Turns inside the same durable Yui Run.
        operations: activeSubagentOperations(current.operations),
        stateSince: at
      }), "provider", at);
    case "turn.failed":
      return withActivity(next(current, {
        session: "ready",
        turn: "failed",
        waitingReason: undefined,
        waitId: undefined,
        operations: Object.freeze({}),
        stateSince: at
      }), "provider", at);
    case "turn.cancelled":
      return withActivity(next(current, {
        session: "ready",
        turn: "cancelled",
        waitingReason: undefined,
        waitId: undefined,
        operations: Object.freeze({}),
        stateSince: at
      }), "provider", at);
    case "operation.started": {
      const operationId = event.payload.operationId!;
      const operation = event.payload.operation!;
      return withActivity(next(current, {
        session: current.session === "ended" || current.session === "failed"
          ? current.session
          : "active",
        turn: current.turn === "waiting" ? "accepted" : current.turn,
        waitingReason: undefined,
        waitId: undefined,
        operations: Object.freeze({
          ...current.operations,
          [operationId]: Object.freeze({ kind: operation, startedAt: at })
        }),
        stateSince: at
      }), operation, at);
    }
    case "operation.completed":
    case "operation.failed": {
      const operations = { ...current.operations };
      delete operations[event.payload.operationId!];
      return withActivity(next(current, {
        session: current.session === "ended" || current.session === "failed"
          ? current.session
          : "active",
        turn: current.turn === "waiting" ? "accepted" : current.turn,
        waitingReason: undefined,
        waitId: undefined,
        operations: Object.freeze(operations),
        stateSince: at
      }), event.payload.operation!, at);
    }
    case "activity.observed": {
      const usage = event.payload.usage;
      const lifecycleActivity = event.payload.activityId !== undefined
        && usage === undefined;
      const projected = next(current, {
        ...(usage === undefined ? {} : { usage: Object.freeze({ ...usage }) }),
        ...(lifecycleActivity ? {
          session: current.turn === "waiting" ? "active" : current.session,
          turn: current.turn === "waiting" ? "accepted" : current.turn,
          waitingReason: undefined,
          waitId: undefined
        } : {})
      });
      // Token counters are read-only measurements. Only a separate explicit
      // activity observation may advance runtime health or waiting state;
      // usage activityId values identify requests only for token projection.
      if (!lifecycleActivity) return projected;
      return withActivity(projected, event.payload.activity!, at);
    }
    case "observer.health":
      return next(current, {
        observer: Object.freeze({
          status: event.payload.observerStatus!,
          sourceId: event.payload.sourceId,
          ...(event.payload.observerDetail === undefined
            ? {}
            : { detail: event.payload.observerDetail })
        })
      });
    case "conversation.observed":
      return next(current, {
        conversation: event.payload.recoverability === "unrecoverable"
          ? "unrecoverable"
          : event.payload.recoverability === "recoverable" ? "recoverable" : "unknown"
      });
    case "activation.started":
      return next(current, { activation: "active", stateSince: at });
    case "activation.ended":
      return next(current, { activation: "ended", stateSince: at });
    case "activation.failed":
      return next(current, { activation: "failed", stateSince: at });
    case "continuation.started":
    case "continuation.reported":
    case "continuation.settled": {
      const id = [
        event.fence.activationId,
        event.fence.continuationId,
        event.fence.continuationGeneration
      ].join("/");
      const existing = current.continuations[id];
      if (event.kind === "continuation.reported") {
        // A report is an attachment, not lifecycle evidence. When it races
        // ahead of continuation.started, retain a conservative writer-owned
        // stub until structured start/settlement metadata arrives.
        const reported = existing ?? Object.freeze({
          execution: "unknown" as const,
          outcome: "pending" as const,
          attachment: event.payload.attachment ?? "detached",
          observation: "unavailable" as const,
          mayWriteWorkspace: true,
          identityConflict: false
        });
        return next(current, {
          continuations: Object.freeze({
            ...current.continuations,
            [id]: Object.freeze({
              ...reported,
              ...(event.payload.resultRef === undefined
                ? {}
                : { resultRef: event.payload.resultRef })
            })
          }),
          stateSince: at
        });
      }
      const settled = existing?.execution === "quiescent" && existing.observation === "exact";
      const conflicts = settled && (
        event.payload.execution !== "quiescent"
        || event.payload.outcome !== existing.outcome
      );
      return next(current, {
        continuations: Object.freeze({
          ...current.continuations,
          [id]: Object.freeze(conflicts
            ? { ...existing, identityConflict: true }
            : {
                execution: event.payload.execution!,
                outcome: event.payload.outcome!,
                attachment: event.payload.attachment!,
                observation: event.payload.observationQuality!,
                mayWriteWorkspace: event.payload.observationQuality === "exact"
                  ? event.payload.mayWriteWorkspace!
                  : (existing?.mayWriteWorkspace ?? false)
                    || event.payload.mayWriteWorkspace!,
                identityConflict: existing?.identityConflict ?? false,
                ...(event.payload.resultRef === undefined
                  ? existing?.resultRef === undefined ? {} : { resultRef: existing.resultRef }
                  : { resultRef: event.payload.resultRef })
              })
        }),
        stateSince: at
      });
    }
    case "input.delivery-unknown":
      return next(current, { inputDelivery: "delivery-unknown", stateSince: at });
    case "native-work.snapshot":
      return next(current, {});
    default:
      return current;
  }
}

export function recordRuntimeSemanticProgress(
  current: RuntimeProjection,
  progressAt: string
): RuntimeProjection {
  const at = requireTimestamp(progressAt);
  if (Date.parse(at) <= Date.parse(current.workflow.lastSemanticProgressAt)) return current;
  return next(current, {
    workflow: Object.freeze({ ...current.workflow, lastSemanticProgressAt: at })
  });
}

export function completeRuntimeWorkflow(
  current: RuntimeProjection,
  completedAt: string
): RuntimeProjection {
  const at = requireTimestamp(completedAt);
  return next(current, {
    workflow: Object.freeze({
      lastSemanticProgressAt: maxTimestamp(current.workflow.lastSemanticProgressAt, at),
      completed: true,
      blocked: false
    })
  });
}

export function projectRuntimeMailbox(
  current: RuntimeProjection,
  mailbox: WorkMailbox | null
): RuntimeProjection {
  if (mailbox?.inputDelivery === undefined || mailbox.inputDelivery === null) {
    return next(current, { inputDelivery: "none" });
  }
  return next(current, {
    inputDelivery: mailbox.inputDelivery.status === "delivery-unknown"
      ? "delivery-unknown"
      : "dispatching"
  });
}

export function runtimeDisplayStatus(current: RuntimeProjection): RuntimeDisplayStatus {
  if (current.session === "failed") return "broken";
  const operation = dominantOperation(current.operations);
  // Provider-owned child work can outlive the parent Session. Surface the
  // child as active while retaining host/session health orthogonally in the
  // projection instead of collapsing both facts into "stopped".
  if (operation === "subagent") return "subagent-active";
  if (current.host === "exited" || current.session === "ended") return "stopped";
  if (operation !== null) return `${operation}-active`;
  if (current.turn === "waiting") return `waiting-${current.waitingReason ?? "external"}`;
  if (current.session === "ready" || current.turn === "completed"
    || current.turn === "failed" || current.turn === "cancelled") return "ready";
  if (current.turn === "accepted" || current.session === "active") {
    return current.activity.kind === "model" ? "model-active" : "active-quiet";
  }
  if (current.session === "started") return "awaiting-provider-acceptance";
  if (current.host === "alive") return "runtime-unobservable";
  return "starting";
}

/**
 * Classify one RuntimeProjection into the layered health state shared by CLI,
 * Web, and scheduler. The semantic progress timestamp is the same durable
 * fence the scheduler stall pass consumes (deliveredAt plus Work/Review/
 * Integration checkpoints), so token/tool/CPU activity can never masquerade
 * as business progress.
 *
 * Time-derived layers are advisory: `quiet` and `diagnostic-needed` never
 * authorize a reset or Session switch. The scheduler owns the separate,
 * coalesced 30-minute read-only diagnostic window.
 */
export function classifyRuntimeHealth(input: Readonly<{
  projection: RuntimeProjection;
  semanticProgressAt: string;
  now: Date;
  policy?: RuntimeHealthPolicy;
}>): RuntimeHealthClassification {
  const policy = input.policy ?? DEFAULT_RUNTIME_HEALTH_POLICY;
  const current = input.projection;
  const semanticMs = Date.parse(input.semanticProgressAt);
  if (!Number.isFinite(semanticMs)) {
    throw new Error("Runtime health semantic progress timestamp is invalid.");
  }
  const runtimeIdleMs = current.lastRuntimeActivityAt === undefined
    ? Number.POSITIVE_INFINITY
    : input.now.getTime() - Date.parse(current.lastRuntimeActivityAt);
  const semanticIdleMs = input.now.getTime() - semanticMs;
  const activeOperations = Object.entries(current.operations)
    .map(([id, operation]) => `${operation.kind}:${id}`);
  const base = {
    lastSemanticProgressAt: input.semanticProgressAt,
    activeOperations,
    host: current.host,
    observerStatus: current.observer.status,
    runtimeIdleMs,
    semanticIdleMs,
    ...(current.lastRuntimeActivityAt === undefined
      ? {}
      : { lastRuntimeActivityAt: current.lastRuntimeActivityAt })
  };
  const operation = dominantOperation(current.operations);
  const layer = classifyLayer(current, operation, runtimeIdleMs, semanticIdleMs, policy);
  return Object.freeze({
    layer,
    reason: runtimeHealthReason(layer, current),
    ...base
  });
}

function classifyLayer(
  current: RuntimeProjection,
  operation: AgentRuntimeOperation | null,
  runtimeIdleMs: number,
  semanticIdleMs: number,
  policy: RuntimeHealthPolicy
): RuntimeHealthLayer {
  // Deterministic terminal evidence is immediate: no waiting for any window.
  if (current.session === "failed") return "broken";
  if (current.host === "exited" || current.session === "ended") return "stopped";
  // Recent structured runtime activity is the strongest liveness signal.
  if (operation === "subagent") return "subagent-active";
  if (operation === "tool") return "tool-active";
  if (operation === "model") return "model-active";
  // An incomplete observer signal warrants a read-only diagnostic, but a
  // dominant operation above is still trusted as the most recent fact.
  if (current.observer.status === "degraded" || current.observer.status === "unavailable") {
    return "diagnostic-needed";
  }
  if (current.turn === "waiting") {
    return `waiting-${current.waitingReason ?? "external"}` as RuntimeHealthLayer;
  }
  // No durable semantic progress past fifteen minutes: display only. The
  // scheduler's coalesced read-only diagnostic remains a separate 30m clock.
  if (semanticIdleMs >= policy.diagnosticAfterMs) return "diagnostic-needed";
  // A live turn with no recent structured activity is quiet, not dead.
  if (runtimeIdleMs >= policy.quietAfterMs) return "quiet";
  if (current.turn === "accepted" || current.session === "active") return "active-quiet";
  if (current.session === "ready"
    || current.turn === "completed"
    || current.turn === "failed"
    || current.turn === "cancelled") return "ready";
  if (current.session === "started") return "awaiting-provider-acceptance";
  if (current.host === "alive") return "runtime-unobservable";
  return "starting";
}

function runtimeHealthReason(
  layer: RuntimeHealthLayer,
  current: RuntimeProjection
): string {
  switch (layer) {
    case "broken":
      return "the Agent Driver runtime is broken";
    case "stopped":
      return "the Provider Activation ended while the Yui Run remains active";
    case "subagent-active":
    case "tool-active":
    case "model-active":
      return `the Agent Driver reports ${layer.replaceAll("-", " ")}`;
    case "diagnostic-needed":
      if (current.observer.status === "degraded" || current.observer.status === "unavailable") {
        return `the runtime observer is ${current.observer.status}; read-only diagnostic recommended`;
      }
      return "no durable semantic checkpoint in the overdue window; the runtime remains undisturbed";
    case "quiet":
      return "the Agent turn is active but has reported no structured runtime activity recently";
    case "active-quiet":
      return "the Agent Driver reports active quiet";
    case "waiting-user":
    case "waiting-permission":
    case "waiting-external":
      return `the Agent Driver is ${layer.replaceAll("-", " ")}`;
    case "ready":
      return "the Agent turn ended while the workflow Run is still active";
    case "awaiting-provider-acceptance":
      return "the pushed active Run is awaiting provider acceptance";
    case "runtime-unobservable":
      return "the host is present but the Agent Driver exposes no current runtime state";
    case "starting":
    default:
      return "the Agent Driver runtime is starting";
  }
}

function withActivity(
  current: RuntimeProjection,
  kind: "model" | "tool" | "subagent" | "provider" | "resource",
  at: string
): RuntimeProjection {
  return next(current, {
    activity: Object.freeze({ kind, observedAt: at }),
    lastRuntimeActivityAt: maxTimestamp(current.lastRuntimeActivityAt, at)
  });
}

function next(
  current: RuntimeProjection,
  patch: Partial<RuntimeProjection>
): RuntimeProjection {
  const copy = { ...current, ...patch } as RuntimeProjection & {
    waitingReason?: AgentRuntimeWaitReason;
    waitId?: string;
  };
  if (patch.waitingReason === undefined && Object.hasOwn(patch, "waitingReason")) {
    delete copy.waitingReason;
  }
  if (patch.waitId === undefined && Object.hasOwn(patch, "waitId")) delete copy.waitId;
  const continuations = Object.entries(copy.continuations);
  const waitingNative = continuations.filter(([, continuation]) => (
    continuation.execution === "active" || continuation.execution === "unknown"
  ));
  const activeNativeOperations = Object.entries(copy.operations).filter(([, operation]) => (
    operation.kind === "subagent"
  ));
  const waitingOn = [
    ...waitingNative.map(([id]) => `native:${id}`),
    ...activeNativeOperations.map(([id]) => `native-operation:${id}`)
  ];
  const attention = [
    ...(copy.inputDelivery === "delivery-unknown" ? ["delivery-unknown"] : []),
    ...continuations.flatMap(([id, continuation]) => (
      continuation.identityConflict ? [`identity-conflict:${id}`]
        : continuation.observation === "unavailable" ? [`continuation-unresolved:${id}`]
        : []
    )),
    ...(copy.conversation === "unrecoverable" ? ["leader-decision-needed"] : []),
    ...(copy.host === "exited" || copy.session === "ended" || copy.session === "failed"
      ? ["runtime-unobservable"]
      : [])
  ];
  const health: RuntimeProjection["health"] = copy.observer.status === "unavailable"
      || waitingNative.some(([, continuation]) => continuation.observation === "unavailable")
      || copy.host === "exited"
      || copy.session === "ended"
      || copy.session === "failed"
    ? "unobservable"
    : copy.inputDelivery === "dispatching"
      || (copy.activation !== "active" && waitingNative.length > 0)
      ? "reconciling"
      : "healthy";
  const runActivity: RuntimeProjection["runActivity"] = copy.inputDelivery === "dispatching"
      || copy.turn === "accepted"
      || copy.session === "active"
    ? "running"
    : waitingNative.length > 0 || activeNativeOperations.length > 0 ? "waiting"
    : copy.session === "unknown" || copy.session === "started" ? "starting"
    : "parked";
  return Object.freeze({
    ...copy,
    waitingOn: Object.freeze(waitingOn),
    attention: Object.freeze([...new Set(attention)]),
    health,
    runActivity
  });
}

function dominantOperation(
  operations: RuntimeProjection["operations"]
): AgentRuntimeOperation | null {
  const kinds = Object.values(operations).map(({ kind }) => kind);
  if (kinds.includes("subagent")) return "subagent";
  if (kinds.includes("tool")) return "tool";
  if (kinds.includes("model")) return "model";
  return null;
}

function activeSubagentOperations(
  operations: RuntimeProjection["operations"]
): RuntimeProjection["operations"] {
  return Object.freeze(Object.fromEntries(
    Object.entries(operations).filter(([, operation]) => operation.kind === "subagent")
  ));
}

function terminalTurn(
  current: RuntimeProjection["turn"],
  fallback: "failed" | "cancelled" = "cancelled"
): RuntimeProjection["turn"] {
  return current === "completed" || current === "failed" || current === "cancelled"
    ? current
    : fallback;
}

function maxTimestamp(left: string | undefined, right: string): string {
  return left === undefined || Date.parse(right) > Date.parse(left) ? right : left;
}

function requireTimestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Runtime projection timestamp is invalid.");
  }
  return value;
}
