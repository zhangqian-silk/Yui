import type {
  ReleaseStepEffect,
  ReleaseStepQuery,
  ReleaseWorkflowPorts
} from "./releaseWorkflowPorts.js";
import type { ReleaseStepPlan, ReleaseWorkflowSource } from "./releaseWorkflow.js";

/**
 * Deterministic script for one plan step. `execute` and `query` are queues:
 * the Nth call consumes the Nth entry. A function is re-invoked per call.
 * When the queue is exhausted the next call throws, which fails the test
 * loudly instead of silently inventing outcomes.
 */
export type FakeReleaseStepScript = Readonly<{
  execute?: ReadonlyArray<ReleaseStepEffect | (() => ReleaseStepEffect)>;
  query?: ReadonlyArray<ReleaseStepQuery | (() => ReleaseStepQuery)>;
}>;

export type FakeReleaseStepCalls = Readonly<{
  execute: number;
  query: number;
  /** idempotencyKey of every execute call, in order. */
  keys: readonly string[];
}>;

/** The workflow ports plus the call evidence the at-most-once proofs assert. */
export type FakeReleasePorts = ReleaseWorkflowPorts & Readonly<{
  calls(stepId: string): FakeReleaseStepCalls;
  /** True once the scripted queues are exhausted for every step. */
  exhausted(): boolean;
}>;

type MutableCalls = { execute: number; query: number; keys: string[] };

/**
 * The deterministic double for every external system (GitHub, npm, Home,
 * Controller). No real network, process, or filesystem side effect: the
 * engine's at-most-once and recovery guarantees are proven against this.
 */
export function createFakeReleasePorts(
  scripts: Readonly<Record<string, FakeReleaseStepScript>>
): FakeReleasePorts {
  const counters = new Map<string, MutableCalls>();
  for (const stepId of Object.keys(scripts)) {
    counters.set(stepId, { execute: 0, query: 0, keys: [] });
  }
  const tally = (stepId: string): MutableCalls => {
    let calls = counters.get(stepId);
    if (calls === undefined) {
      calls = { execute: 0, query: 0, keys: [] };
      counters.set(stepId, calls);
    }
    return calls;
  };
  const next = <T>(
    queue: ReadonlyArray<T | (() => T)> | undefined,
    stepId: string,
    kind: "execute" | "query",
    consumed: number
  ): T => {
    if (queue === undefined || consumed >= queue.length) {
      throw new Error(`Fake release ports: no more scripted ${kind} outcomes for step ${stepId}.`);
    }
    const entry = queue[consumed]!;
    return typeof entry === "function" ? (entry as () => T)() : entry;
  };
  return {
    async executeStep(input: Readonly<{
      step: ReleaseStepPlan;
      idempotencyKey: string;
      source: ReleaseWorkflowSource;
      params: Readonly<Record<string, string>>;
    }>): Promise<ReleaseStepEffect> {
      const calls = tally(input.step.id);
      const effect = next(scripts[input.step.id]?.execute, input.step.id, "execute", calls.execute);
      calls.execute += 1;
      calls.keys.push(input.idempotencyKey);
      return effect;
    },
    async queryStepEffect(input: Readonly<{
      step: ReleaseStepPlan;
      externalIdentity: Readonly<{ kind: string; value: string }>;
    }>): Promise<ReleaseStepQuery> {
      const calls = tally(input.step.id);
      const query = next(scripts[input.step.id]?.query, input.step.id, "query", calls.query);
      calls.query += 1;
      return query;
    },
    calls(stepId: string): FakeReleaseStepCalls {
      const calls = tally(stepId);
      return { execute: calls.execute, query: calls.query, keys: Object.freeze([...calls.keys]) };
    },
    exhausted(): boolean {
      for (const [stepId, script] of Object.entries(scripts)) {
        const calls = counters.get(stepId)!;
        if ((script.execute?.length ?? 0) !== calls.execute) return false;
        if ((script.query?.length ?? 0) !== calls.query) return false;
      }
      return true;
    }
  };
}
