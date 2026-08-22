import type { TaskEvent } from "../event/taskEvent.js";
import {
  resolveContextBudget,
  type ResolvedContextBudget
} from "../config/yuiConfig.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";

/**
 * Issue 04 (context token budget): evaluates one native Session generation's
 * observed context pressure from durable `runtime.observation` events. The
 * metric is the largest single observed per-request input peak (the delta
 * between consecutive cumulative usage snapshots), not the cumulative
 * processed volume: cache-read accumulation must not be mistaken for unique
 * context size, and auto-compaction is never inferred from token counts.
 */

export type SessionContextBudgetState = "within" | "soft" | "hard";

export type SessionContextBudgetEvidence = Readonly<{
  state: SessionContextBudgetState;
  /** Largest observed per-request input peak in tokens; 0 when unobserved. */
  peakTokens: number;
  budget: ResolvedContextBudget;
}>;

export type SessionContextBudgetKey = Readonly<{
  taskId: string;
  roleName: string;
  nativeSessionId?: string;
  launchId?: string;
}>;

export function evaluateSessionContextBudget(
  events: readonly TaskEvent[],
  session: SessionContextBudgetKey,
  configured?: unknown
): SessionContextBudgetEvidence {
  const budget = resolveContextBudget(configured);
  const peak = observedPeakInputTokens(events, session);
  const state: SessionContextBudgetState = peak >= budget.hardTokens
    ? "hard"
    : peak >= budget.softTokens
      ? "soft"
      : "within";
  return Object.freeze({ state, peakTokens: peak, budget });
}

/**
 * Largest per-request input peak observed for one Session generation. Usage
 * observations carry cumulative session totals; consecutive deltas bound the
 * per-request input of the window between them. The first observation for a
 * generation is treated as one full request so a long-lived resumed Session
 * that was only sampled late still counts its inherited context.
 */
export function observedPeakInputTokens(
  events: readonly TaskEvent[],
  session: SessionContextBudgetKey
): number {
  let previous = 0;
  let peak = 0;
  for (const event of events) {
    const observation = runtimeObservationFromTaskEvent(event);
    if (observation === null) continue;
    if (!matchesSession(observation.fence, session)) continue;
    const usage = usageTotal(observation.payload.usage);
    if (usage === null) continue;
    const delta = Math.max(0, usage - previous);
    if (delta > peak) peak = delta;
    previous = usage;
  }
  return peak;
}

function matchesSession(
  fence: Readonly<{
    taskId?: string;
    roleName: string;
    nativeSessionId?: string;
    launchId?: string;
  }>,
  session: SessionContextBudgetKey
): boolean {
  if (fence.taskId !== undefined && fence.taskId !== session.taskId) return false;
  if (fence.roleName !== session.roleName) return false;
  if (session.nativeSessionId !== undefined
    && fence.nativeSessionId !== undefined
    && fence.nativeSessionId !== session.nativeSessionId) {
    return false;
  }
  if (session.launchId !== undefined
    && fence.launchId !== undefined
    && fence.launchId !== session.launchId) {
    return false;
  }
  return true;
}

function usageTotal(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const inputTokens = integer(record.inputTokens);
  if (inputTokens === null) return null;
  // RuntimeUsageSnapshot.inputTokens is the normalized processed input total.
  // cachedInputTokens is an informational breakdown of that total, matching
  // runtimeProjection and the Driver documentation; adding it again would
  // fabricate context pressure and trigger premature Session rollover.
  return inputTokens;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
