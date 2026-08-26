import { createHash } from "node:crypto";

import type { TaskEvent } from "../event/taskEvent.js";
import {
  latestRunDurableProgressAt,
  type RoleRunProviderAcceptance
} from "../scheduler/roleRunStall.js";
import type { Task } from "../task/task.js";
import type {
  RoleAgentSession,
  TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import type { AgentRun } from "./agentRun.js";
import {
  actionableExecutionLaneRecoveries,
  type ExecutionGroupHealthSummary
} from "../execution/executionHealth.js";

/**
 * Issue 08: read-only projection of the exact recovery position for one Run.
 *
 * The recovery CAS fence is the Yui-durable semantic progress timestamp
 * (`run.delivered` or a later durable progress point). Provider observation
 * timestamps (for example `turn.accepted`) are evidence only: they are
 * displayed side by side with clear labels but can never be used as the
 * fence. This module is deliberately pure — it never mutates state and never
 * picks an action or a provider acceptance for the Leader.
 */

export type RunRecoveryAction =
  | "diagnose"
  | "retry"
  | "replace-session"
  | "terminate";

export const RUN_RECOVERY_ACTIONS: readonly RunRecoveryAction[] = [
  "diagnose",
  "retry",
  "replace-session",
  "terminate"
];

/** One executable recovery option the Leader may copy verbatim. */
export type RunRecoveryActionPlan = Readonly<{
  action: RunRecoveryAction;
  /** When this action is the right one. */
  reason: string;
  /** The canonical fence this plan was built from. */
  expectedProgressAt: string;
  /** Exact identity fences the recovery CAS validates. */
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
  /** Copy-pasteable command; the fence is the Yui-durable canonical value. */
  command: string;
  /** Structured argv for machines; no free-text or table parsing required. */
  argv: readonly string[];
  /**
   * Stable hash of the action, the canonical fence, and the exact identity
   * fences. It changes exactly when the recovery position changes, so a
   * server can resolve it back to the canonical fence without the caller
   * copying timestamps.
   */
  fingerprint: string;
}>;

export type RunRecoveryProjection = Readonly<{
  taskId: string;
  runId: string;
  roleName: string;
  runStatus: string;
  /** Whether `task run recover` can currently be applied to this Run. */
  recoverable: boolean;
  /**
   * The authoritative CAS fence, computed only from Yui durable records.
   * Null when no durable progress timestamp exists for the Run.
   */
  canonicalProgressAt: string | null;
  /** What the canonical fence was derived from, when known. */
  canonicalProgressEvidence?: string;
  /**
   * Provider-side evidence, clearly separated from the durable fence.
   * `acceptedAt` is the durable acceptance boundary (run.deliveredAt);
   * `observedAt` is the latest Provider observation timestamp (for example
   * turn.accepted) and is evidence only — never a CAS fence.
   */
  provider: Readonly<{
    acceptedAt: string | null;
    observedAt: string | null;
    observationKind: string | null;
  }>;
  /**
   * Durable constraint on the acceptance decision. The Leader still passes
   * `--provider-acceptance` explicitly; the projection never guesses it.
   */
  providerAcceptance: Readonly<{
    /** Durably recorded acceptance boundary. */
    accepted: boolean;
    /** Values that would not be rejected by the durable acceptance check. */
    options: readonly RoleRunProviderAcceptance[];
  }>;
  session: Readonly<{
    status: RoleAgentSession["status"];
    nativeSessionId?: string;
    launchId?: string;
  }> | null;
  /** The exact actions the Leader may take; the projection never picks one. */
  actions: readonly RunRecoveryActionPlan[];
  /** Present when the semantic decision cannot be derived from records alone. */
  judgmentRequired?: string;
  /** Why the Run is not recoverable, when it is not. */
  reason?: string;
}>;

export type RunRecoveryFacts = Readonly<{
  run: AgentRun;
  task: Pick<Task, "id" | "status"> | null;
  sessionSet: TaskRoleSessionSet | null;
  progress: Readonly<{ progressAt: string; evidence?: string }> | null;
  latestProviderObservation: Readonly<{ kind: string; receivedAt: string }> | null;
}>;

/** Narrow store port both CLI and Web projections read through. */
export type RunRecoveryStore = Readonly<{
  getAgentRun(taskId: string, runId: string): AgentRun | null;
  getTask(taskId: string): Task | null;
  getTaskRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null;
  listEvents(taskId: string): readonly TaskEvent[];
  getWorkItem?: (taskId: string, workItemId: string) => Readonly<{
    updatedAt: string;
    candidates?: readonly Readonly<{ createdAt: string }>[];
  }> | null;
  listReviewRounds?: (taskId: string) => readonly Readonly<{
    workItemId?: string;
    createdAt: string;
    endedAt?: string;
  }>[];
  listChangeSets?: (taskId: string) => readonly Readonly<{
    workItemId: string;
    createdAt: string;
    id: string;
  }>[];
  listIntegrationAttempts?: (taskId: string) => readonly Readonly<{
    updatedAt: string;
    changeSetIds: readonly string[];
  }>[];
  listInputRequests?: (taskId: string) => readonly Readonly<{
    updatedAt: string;
    requester: Readonly<{ runId?: string }>;
    blockedRefs: readonly Readonly<{ type: string; id: string }>[];
  }>[];
}>;

/**
 * Reads every durable record the recovery projection needs. Returns null
 * only when the Run itself is absent.
 */
export function readRunRecoveryFacts(
  store: RunRecoveryStore,
  taskId: string,
  runId: string
): RunRecoveryFacts | null {
  const run = store.getAgentRun(taskId, runId);
  if (run === null || run.taskId !== taskId) return null;
  const task = store.getTask(taskId);
  const sessionSet = store.getTaskRoleSessionSet(taskId, run.roleName);
  const progress = latestRunDurableProgressAt(
    store,
    taskId,
    run.roleName,
    runId
  );
  return {
    run,
    task: task === null ? null : { id: task.id, status: task.status },
    sessionSet,
    progress,
    latestProviderObservation: latestRunProviderObservation(
      store.listEvents(taskId),
      runId
    )
  };
}

/**
 * Resolve the exact live-Run recovery plans referenced by Lane health. Failed
 * terminal Lanes use `task run retry` directly and therefore need no live-Run
 * recovery projection here.
 */
export function projectExecutionLaneRunRecoveries(
  store: RunRecoveryStore,
  taskId: string,
  groups: readonly ExecutionGroupHealthSummary[]
): RunRecoveryProjection[] {
  const runIds = new Set(actionableExecutionLaneRecoveries(groups).flatMap((lane) => (
    lane.runId === undefined || lane.recovery === "retry-new-agent-run"
      ? []
      : [lane.runId]
  )));
  return [...runIds].flatMap((runId) => {
    const facts = readRunRecoveryFacts(store, taskId, runId);
    return facts === null ? [] : [projectRunRecovery(facts)];
  });
}

/**
 * Latest Provider observation for a Run. Provider timestamps are evidence:
 * they explain why a stale fence was supplied but never authorize recovery.
 */
function latestRunProviderObservation(
  events: readonly TaskEvent[],
  runId: string
): { kind: string; receivedAt: string } | null {
  let latest: { kind: string; receivedAt: string; at: number } | null = null;
  for (const event of events) {
    if (event.type !== "runtime.observation") continue;
    if (event.payload.runId !== runId) continue;
    const kind = typeof event.payload.kind === "string" ? event.payload.kind : "unknown";
    const receivedAt = typeof event.payload.receivedAt === "string"
      && Number.isFinite(Date.parse(event.payload.receivedAt))
      ? event.payload.receivedAt
      : event.createdAt;
    const at = Date.parse(receivedAt);
    if (latest === null || at > latest.at) {
      latest = { kind, receivedAt, at };
    }
  }
  return latest === null ? null : { kind: latest.kind, receivedAt: latest.receivedAt };
}

export function projectRunRecovery(facts: RunRecoveryFacts): RunRecoveryProjection {
  const { run, task, sessionSet, progress } = facts;
  const session = activeSession(facts);
  const canonicalProgressAt = progress?.progressAt ?? null;
  const accepted = run.deliveredAt !== undefined;
  const acceptanceOptions = accepted
    ? ["accepted", "ambiguous"] as const
    : ["rejected", "ambiguous"] as const;

  const blocked = recoveryBlocker(facts, session, canonicalProgressAt);
  const supportedActions = session?.status === "stopped" || session?.status === "broken"
    ? RUN_RECOVERY_ACTIONS.filter((action) => action !== "retry")
    : RUN_RECOVERY_ACTIONS;
  const actions = blocked === null
    ? supportedActions.map((action) => buildActionPlan(facts, action, session!, canonicalProgressAt!))
    : [];

  const judgmentRequired = blocked === null && actions.some((plan) =>
    plan.argv.includes(PROVIDER_ACCEPTANCE_PLACEHOLDER)
  )
    ? "Provider acceptance is not durably determined for every action; pass --provider-acceptance explicitly."
    : undefined;

  return {
    taskId: run.taskId,
    runId: run.id,
    roleName: run.roleName,
    runStatus: run.status,
    recoverable: blocked === null,
    canonicalProgressAt,
    ...(progress?.evidence === undefined ? {} : { canonicalProgressEvidence: progress.evidence }),
    provider: {
      acceptedAt: run.deliveredAt ?? null,
      observedAt: facts.latestProviderObservation?.receivedAt ?? null,
      observationKind: facts.latestProviderObservation?.kind ?? null
    },
    providerAcceptance: {
      accepted,
      options: acceptanceOptions
    },
    session: session === null ? null : {
      status: session.status,
      ...(session.nativeSessionId === undefined ? {} : { nativeSessionId: session.nativeSessionId }),
      ...(session.launchId === undefined ? {} : { launchId: session.launchId })
    },
    actions,
    ...(judgmentRequired === undefined ? {} : { judgmentRequired }),
    ...(blocked === null ? {} : { reason: blocked })
  };
}

const PROVIDER_ACCEPTANCE_PLACEHOLDER = "<accepted|rejected|ambiguous>";

function activeSession(
  facts: RunRecoveryFacts
): RoleAgentSession | null {
  const sessions = facts.sessionSet;
  if (sessions === null) return null;
  const session = sessions.sessions[sessions.activeAgentId];
  if (session === undefined) return null;
  if (session.agentId !== facts.run.effective.agentId) return null;
  if (session.adapterId !== facts.run.effective.adapterId) return null;
  return session;
}

/**
 * Mirrors the fail-closed checks of `recoverExactAgentRun` that are visible
 * from durable records. A non-null result means recovery cannot currently be
 * applied; the canonical fence is still projected for diagnosis.
 */
function recoveryBlocker(
  facts: RunRecoveryFacts,
  session: RoleAgentSession | null,
  canonicalProgressAt: string | null
): string | null {
  const { run, task } = facts;
  if (task === null) return "task-missing";
  if (task.status !== "active") return "task-terminal";
  if (run.status !== "active") return "run-terminal";
  if (canonicalProgressAt === null) return "progress-unavailable";
  if (session === null) return "session-missing";
  return null;
}

function buildActionPlan(
  facts: RunRecoveryFacts,
  action: RunRecoveryAction,
  session: RoleAgentSession,
  canonicalProgressAt: string
): RunRecoveryActionPlan {
  const { run } = facts;
  const acceptance = actionAcceptance(facts, action);
  const argv = [
    "task",
    "run",
    "recover",
    `${run.taskId}/${run.id}`,
    "--action",
    action,
    "--expected-progress-at",
    canonicalProgressAt,
    "--provider-acceptance",
    acceptance,
    "--reason",
    "<text>",
    "--agent-id",
    run.effective.agentId,
    "--adapter-id",
    run.effective.adapterId,
    ...(session.nativeSessionId === undefined
      ? []
      : ["--native-session-id", session.nativeSessionId]),
    ...(session.launchId === undefined
      ? []
      : ["--launch-id", session.launchId])
  ];
  const command = `yui ${argv
    .map((part) => (part === "<text>" ? '"<text>"' : part))
    .join(" ")}`;
  const fingerprintSource = [
    run.id,
    action,
    canonicalProgressAt,
    run.effective.agentId,
    run.effective.adapterId,
    session.nativeSessionId ?? "",
    session.launchId ?? ""
  ].join("|");
  return {
    action,
    reason: ACTION_REASONS[action],
    expectedProgressAt: canonicalProgressAt,
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    ...(session.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: session.nativeSessionId }),
    ...(session.launchId === undefined ? {} : { launchId: session.launchId }),
    command,
    argv,
    fingerprint: createHash("sha256").update(fingerprintSource).digest("hex")
  };
}

/**
 * The acceptance value for the copy-paste command. When exactly one value is
 * durably valid it is filled in (the durable record, not a guess); otherwise
 * the Leader must choose and the command carries an explicit placeholder.
 */
function actionAcceptance(
  facts: RunRecoveryFacts,
  action: RunRecoveryAction
): RoleRunProviderAcceptance | typeof PROVIDER_ACCEPTANCE_PLACEHOLDER {
  if (action === "diagnose") return PROVIDER_ACCEPTANCE_PLACEHOLDER;
  return facts.run.deliveredAt === undefined ? "rejected" : "accepted";
}

const ACTION_REASONS: Readonly<Record<RunRecoveryAction, string>> = {
  diagnose: "Collect bounded diagnostics before any state-changing recovery.",
  retry: "Request another provider turn on the same native Session when the failure is transient.",
  "replace-session": "Request a fresh native Session when the current one is unusable.",
  terminate: "Fail the Run explicitly when recovery is not viable."
};
