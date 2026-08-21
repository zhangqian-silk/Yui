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

export type RuntimeAttention = Readonly<{
  runtime:
    | "healthy"
    | "waiting"
    | "unobservable"
    | "quiet"
    | "active-operation-quiet"
    | "stopped"
    | "broken";
  workflow: "progressing" | "not-progressing" | "completed";
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
      return next(current, { session: "started", stateSince: at });
    case "session.ready":
      return next(current, { session: "ready", stateSince: at });
    case "session.ended":
      return next(current, {
        session: "ended",
        turn: terminalTurn(current.turn),
        operations: Object.freeze({}),
        stateSince: at
      });
    case "session.failed":
      return next(current, {
        session: "failed",
        turn: current.turn === "none" ? "failed" : terminalTurn(current.turn, "failed"),
        operations: Object.freeze({}),
        stateSince: at
      });
    case "turn.accepted":
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
        session: "active",
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
        session: "active",
        turn: current.turn === "waiting" ? "accepted" : current.turn,
        waitingReason: undefined,
        waitId: undefined,
        operations: Object.freeze(operations),
        stateSince: at
      }), event.payload.operation!, at);
    }
    case "activity.observed": {
      const usage = event.payload.usage;
      if (usage !== undefined && !usageAdvanced(current.usage, usage)) {
        return next(current, { usage: Object.freeze({ ...usage }) });
      }
      return withActivity(next(current, {
        ...(usage === undefined ? {} : { usage: Object.freeze({ ...usage }) }),
        session: current.turn === "waiting" ? "active" : current.session,
        turn: current.turn === "waiting" ? "accepted" : current.turn,
        waitingReason: undefined,
        waitId: undefined
      }), event.payload.activity!, at);
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

export function runtimeDisplayStatus(current: RuntimeProjection): RuntimeDisplayStatus {
  if (current.session === "failed") return "broken";
  if (current.host === "exited" || current.session === "ended") return "stopped";
  const operation = dominantOperation(current.operations);
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

export function evaluateRuntimeAttention(
  current: RuntimeProjection,
  now: Date,
  policy: Readonly<{ runtimeSilenceMs: number; semanticSilenceMs: number }>
): RuntimeAttention {
  const display = runtimeDisplayStatus(current);
  const runtimeIdleMs = current.lastRuntimeActivityAt === undefined
    ? Number.POSITIVE_INFINITY
    : now.getTime() - Date.parse(current.lastRuntimeActivityAt);
  const semanticIdleMs = now.getTime() - Date.parse(current.workflow.lastSemanticProgressAt);
  const runtime: RuntimeAttention["runtime"] = display === "broken"
    ? "broken"
    : display === "stopped"
      ? "stopped"
      : display === "runtime-unobservable"
        ? "unobservable"
        : display.startsWith("waiting-")
          ? "waiting"
          : runtimeIdleMs <= policy.runtimeSilenceMs
            ? "healthy"
            : Object.keys(current.operations).length > 0
              ? "active-operation-quiet"
              : "quiet";
  return Object.freeze({
    runtime,
    workflow: current.workflow.completed
      ? "completed"
      : semanticIdleMs > policy.semanticSilenceMs
        ? "not-progressing"
        : "progressing"
  });
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
  return Object.freeze(copy);
}

function usageAdvanced(
  previous: RuntimeUsageSnapshot | undefined,
  current: RuntimeUsageSnapshot
): boolean {
  // A first cumulative snapshot may contain history from a resumed native
  // Session. It establishes the generation baseline but cannot prove that
  // tokens were consumed during the current observation window.
  if (previous === undefined) return false;
  return usageTotal(current) > usageTotal(previous);
}

function usageTotal(usage: RuntimeUsageSnapshot): number {
  // cachedInputTokens and reasoningTokens are breakdowns of the normalized
  // input/output totals, not additional usage.
  return usage.inputTokens + usage.outputTokens;
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
