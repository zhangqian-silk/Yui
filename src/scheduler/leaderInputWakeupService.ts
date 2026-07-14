import { randomUUID } from "node:crypto";
import { dataError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import {
  updateRoleAgentSessionStatus,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  resolveAgentExecutor,
  type ExactRoleInputDeliveryOutcome,
  type ExactRoleInputTarget
} from "../executor/executorRegistry.js";
import { updateRoleStatus } from "../role/role.js";
import { resumeBlockedAgentRun } from "../run/agentRun.js";
import {
  abandonInputResolutionWakeup,
  acceptInputResolutionWakeupTransport,
  assertInputResolutionWakeupClaim,
  claimInputResolutionWakeup,
  completeAcceptedInputResolutionWakeup,
  releaseExpiredInputResolutionWakeupClaim,
  releaseInputResolutionWakeupClaim,
  type InputResolutionWakeup,
  type InputResolutionWakeupClaimReference
} from "./inputResolutionWakeup.js";
import { createLeaderRecoveryNotification } from "./operatorNotification.js";
import { executeDomainTransaction } from "../storage/domainTransaction.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";

const DEFAULT_CLAIM_DURATION_MS = 30_000;
const DEFAULT_MAX_WAKEUPS = 100;

export type ClaimLeaderInputWakeup = {
  controllerId: string;
  controllerGeneration: string;
  claimId: string;
  durationMs: number;
};

export type LeaderInputWakeupClaim = InputResolutionWakeupClaimReference & {
  taskId: string;
  roleName: "leader";
  agentId: string;
  requestId: string;
  resolutionId: string;
  agentRunId: string;
  adapterId: string;
  sessionRoot: string;
  nativeSessionId: string;
  deliveryId: string;
};

export type LeaderInputWakeupRuntime = {
  sendExactRoleInputOnce(
    expected: ExactRoleInputTarget,
    deliveryId: string,
    input: string
  ): ExactRoleInputDeliveryOutcome;
  probeRoleStatus(taskId: string, roleName: string): "running" | "exited";
};

/**
 * Fences native input effects for resolved input. It deliberately never finds
 * "the current Leader" as a fallback: an origin/session mismatch terminalizes
 * the wakeup, leaving the replacement Leader untouched.
 *
 * The accepted transport receipt is a durable boundary between the external
 * tmux effect and local resume. Recovery finalizes an accepted receipt without
 * sending another prompt.
 */
export class LeaderInputWakeupService {
  constructor(private readonly rootDir: string) {}

  claimNext(
    transactionId: string,
    claim: ClaimLeaderInputWakeup,
    now: Date,
    excludedWakeups: ReadonlySet<string> = new Set()
  ): LeaderInputWakeupClaim | null {
    assertClaimDuration(claim.durationMs);
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      for (const persisted of store.listInputResolutionWakeups()) {
        if (excludedWakeups.has(wakeupKey(persisted))) {
          continue;
        }
        if (persisted.status === "completed" || persisted.status === "abandoned" || persisted.status === "accepted") {
          continue;
        }
        let wakeup = persisted;
        if (wakeup.status === "claimed") {
          if (Date.parse(wakeup.claim!.expiresAt) > now.getTime()) {
            continue;
          }
          wakeup = releaseExpiredInputResolutionWakeupClaim(wakeup, now);
          store.saveInputResolutionWakeup(wakeup);
        }

        const target = inspectExactBlockedLeader(store, wakeup);
        if (target.kind === "invalid") {
          abandonExactLeaderWakeup(store, wakeup, target.reason, now);
          continue;
        }
        const claimed = claimInputResolutionWakeup(wakeup, {
          controllerId: claim.controllerId,
          controllerGeneration: claim.controllerGeneration,
          claimId: claim.claimId,
          expiresAt: new Date(now.getTime() + claim.durationMs).toISOString()
        }, now);
        store.saveInputResolutionWakeup(claimed);
        return claimReference(claimed);
      }
      return null;
    });
  }

  /**
   * Reads the exact target in a transaction immediately before the external
   * effect. An invalid tuple is terminalized and never falls back to a
   * replacement Leader.
   */
  prepareEffect(
    transactionId: string,
    claim: LeaderInputWakeupClaim,
    now: Date
  ): Extract<ExactBlockedLeader, { kind: "ready" }> | null {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const wakeup = requireWakeup(store, claim);
      assertInputResolutionWakeupClaim(wakeup, claim, now);
      const target = inspectExactBlockedLeader(store, wakeup);
      if (target.kind === "invalid") {
        abandonExactLeaderWakeup(store, wakeup, target.reason, now);
        return null;
      }
      return target;
    });
  }

  /**
   * Re-reads the exact tuple after tmux accepted the message, then writes the
   * durable receipt. A stale lease or changed session cannot acknowledge the
   * old Controller's transport attempt.
   */
  acceptTransport(
    transactionId: string,
    claim: LeaderInputWakeupClaim,
    now: Date
  ): boolean {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const wakeup = requireWakeup(store, claim);
      assertInputResolutionWakeupClaim(wakeup, claim, now);
      const target = inspectExactBlockedLeader(store, wakeup);
      if (target.kind === "invalid") {
        abandonExactLeaderWakeup(store, wakeup, target.reason, now);
        return false;
      }
      store.saveInputResolutionWakeup(acceptInputResolutionWakeupTransport(
        wakeup,
        claim,
        { deliveryId: claim.deliveryId, transport: "tmux" },
        now
      ));
      store.saveEvent(target.task.id, createTaskEvent(
        store.nextEventId(target.task.id),
        "leader.input_resolution_transport_accepted",
        {
          requestId: wakeup.requestId,
          resolutionId: wakeup.resolutionId,
          deliveryId: wakeup.deliveryId
        },
        now
      ));
      return true;
    });
  }

  /**
   * Finalizes one known accepted receipt. No native effect occurs here, so
   * replay after a crash cannot send another Leader input.
   */
  finalizeAccepted(
    transactionId: string,
    taskId: string,
    requestId: string,
    now: Date
  ): LeaderInputWakeupFinalizeResult | null {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const wakeup = store.getInputResolutionWakeup(taskId, requestId);
      if (wakeup === null || wakeup.status !== "accepted") {
        return null;
      }
      return finalizeAcceptedWakeup(store, wakeup, now);
    });
  }

  /**
   * Recovery path for a Controller crash after durable transport acceptance
   * but before the blocked run is marked active.
   */
  finalizeNextAccepted(
    transactionId: string,
    now: Date
  ): LeaderInputWakeupFinalizeResult | null {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const wakeup = store.listInputResolutionWakeups()
        .find((candidate) => candidate.status === "accepted");
      return wakeup === undefined ? null : finalizeAcceptedWakeup(store, wakeup, now);
    });
  }

  release(
    transactionId: string,
    claim: LeaderInputWakeupClaim,
    now: Date
  ): void {
    executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      const wakeup = requireWakeup(store, claim);
      store.saveInputResolutionWakeup(releaseInputResolutionWakeupClaim(wakeup, claim, now));
    });
  }
}

/**
 * The controller's one shared direct/RPC scheduler effect path. It sends a
 * resolution pointer through the exact existing Leader session; it never
 * dispatches or spawns a new Agent.
 */
export function processLeaderInputWakeups(
  rootDir: string,
  runtime: LeaderInputWakeupRuntime,
  now: Date,
  options: {
    controllerId?: string;
    controllerGeneration?: string;
    leaseDurationMs?: number;
    maxWakeups?: number;
    clock?: () => Date;
  } = {}
): string[] {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_CLAIM_DURATION_MS;
  const maxWakeups = options.maxWakeups ?? DEFAULT_MAX_WAKEUPS;
  assertClaimDuration(leaseDurationMs);
  assertMaxWakeups(maxWakeups);

  const service = new LeaderInputWakeupService(rootDir);
  const controllerId = options.controllerId ?? `scheduler-${process.pid}`;
  const controllerGeneration = options.controllerGeneration ?? randomUUID();
  const clock = options.clock ?? (() => now);
  const completed: string[] = [];
  const deferredWakeups = new Set<string>();

  for (let attempt = 0; attempt < maxWakeups; attempt += 1) {
    const finalized = service.finalizeNextAccepted(
      `input-wakeup-recover-finalize-${randomUUID()}`,
      trustedNow(clock)
    );
    if (finalized !== null) {
      if (finalized.status === "completed") completed.push(finalized.requestId);
      continue;
    }

    const token = randomUUID();
    const claim = service.claimNext(
      `input-wakeup-claim-${token}`,
      {
        controllerId,
        controllerGeneration,
        claimId: `input-wakeup-${token}`,
        durationMs: leaseDurationMs
      },
      trustedNow(clock),
      deferredWakeups
    );
    if (claim === null) {
      return completed;
    }

    try {
      const target = service.prepareEffect(
        `input-wakeup-preflight-${randomUUID()}`,
        claim,
        trustedNow(clock)
      );
      if (target === null) continue;
      if (runtime.probeRoleStatus(claim.taskId, claim.roleName) !== "running") {
        releaseBestEffort(service, claim, trustedNow(clock));
        deferredWakeups.add(wakeupKey(claim));
        continue;
      }

      const input = renderLeaderInputResolutionDelivery(claim);
      const delivery = resolveAgentExecutor(claim.adapterId).sendExact({
        runtime,
        target: {
          taskId: claim.taskId,
          roleName: claim.roleName,
          agentId: claim.agentId,
          adapterId: claim.adapterId,
          sessionRoot: claim.sessionRoot,
          nativeSessionId: claim.nativeSessionId,
          agentRunId: claim.agentRunId
        },
        role: target.role,
        deliveryId: claim.deliveryId,
        input
      });
      if (delivery === "fenced") {
        const current = service.prepareEffect(
          `input-wakeup-fenced-recheck-${randomUUID()}`,
          claim,
          trustedNow(clock)
        );
        if (current !== null) {
          releaseBestEffort(service, claim, trustedNow(clock));
          deferredWakeups.add(wakeupKey(claim));
        }
        continue;
      }

      if (!service.acceptTransport(
        `input-wakeup-accept-${randomUUID()}`,
        claim,
        trustedNow(clock)
      )) {
        continue;
      }
      const finalization = service.finalizeAccepted(
        `input-wakeup-finalize-${randomUUID()}`,
        claim.taskId,
        claim.requestId,
        trustedNow(clock)
      );
      if (finalization?.status === "completed") completed.push(finalization.requestId);
    } catch {
      // The lease is the retry boundary. Do not let one unavailable Leader
      // session prevent another task's exact wakeup from progressing.
      releaseBestEffort(service, claim, trustedNow(clock));
      deferredWakeups.add(wakeupKey(claim));
    }
  }
  throw new Error("Input resolution wakeup processing exceeded its safety limit.");
}

export function renderLeaderInputResolutionDelivery(
  claim: Pick<
    LeaderInputWakeupClaim,
    "deliveryId" | "taskId" | "requestId" | "resolutionId" | "agentRunId"
  >
): string {
  return [
    `[TaskMux input resolution delivery ${claim.deliveryId}]`,
    `Task ${claim.taskId}; input request ${claim.requestId}; resolution ${claim.resolutionId}.`,
    `This is for blocked Leader run ${claim.agentRunId}.`,
    `Run taskmux task context ${claim.taskId} --format json, read durable resolution ${claim.resolutionId}, then continue stewardship.`,
    `If delivery ${claim.deliveryId} was already handled, do not apply the resolution twice.`
  ].join("\n");
}

export type LeaderInputWakeupFinalizeResult =
  | {
      status: "completed";
      taskId: string;
      requestId: string;
      resolutionId: string;
      deliveryId: string;
    }
  | {
      status: "abandoned";
      taskId: string;
      requestId: string;
      reason: string;
    };

export type ExactBlockedLeader =
  | {
      kind: "ready";
      task: NonNullable<ReturnType<TaskStore["getTask"]>>;
      role: NonNullable<ReturnType<TaskStore["getRole"]>>;
      run: NonNullable<ReturnType<TaskStore["getAgentRun"]>>;
      sessionSet: TaskRoleSessionSet;
      session: RoleAgentSession;
    }
  | { kind: "invalid"; reason: string };

function finalizeAcceptedWakeup(
  store: TaskStore,
  wakeup: InputResolutionWakeup,
  now: Date
): LeaderInputWakeupFinalizeResult {
  const target = inspectExactBlockedLeader(store, wakeup);
  if (target.kind === "invalid") {
    abandonExactLeaderWakeup(store, wakeup, target.reason, now);
    return {
      status: "abandoned",
      taskId: wakeup.taskId,
      requestId: wakeup.requestId,
      reason: target.reason
    };
  }

  const completed = completeAcceptedInputResolutionWakeup(wakeup, now);
  const resumed = resumeBlockedAgentRun(target.run, wakeup.requestId, now);
  store.saveAgentRun(resumed);
  store.saveActiveAgentRun(resumed);
  store.saveRole(target.task.id, updateRoleStatus(target.role, "running", now));
  store.saveRoleSessionSet(updateRoleAgentSessionStatus(
    target.sessionSet,
    target.session.agentId,
    "running",
    now
  ));
  store.saveInputResolutionWakeup(completed);
  store.saveEvent(target.task.id, createTaskEvent(
    store.nextEventId(target.task.id),
    "leader.input_resolution_resumed",
    {
      requestId: wakeup.requestId,
      resolutionId: wakeup.resolutionId,
      runId: wakeup.agentRunId,
      deliveryId: wakeup.deliveryId
    },
    now
  ));
  return {
    status: "completed",
    taskId: wakeup.taskId,
    requestId: wakeup.requestId,
    resolutionId: wakeup.resolutionId,
    deliveryId: wakeup.deliveryId
  };
}

function abandonExactLeaderWakeup(
  store: TaskStore,
  wakeup: InputResolutionWakeup,
  reason: string,
  now: Date
): void {
  const abandoned = abandonInputResolutionWakeup(wakeup, reason, now);
  store.saveInputResolutionWakeup(abandoned);
  store.saveEvent(wakeup.taskId, createTaskEvent(
    store.nextEventId(wakeup.taskId),
    "leader.input_resolution_wakeup_abandoned",
    {
      requestId: wakeup.requestId,
      resolutionId: wakeup.resolutionId,
      deliveryId: wakeup.deliveryId,
      reason
    },
    now
  ));
  store.saveOperatorNotification(createLeaderRecoveryNotification(
    wakeup.taskId,
    `TaskMux refused to wake Leader ${wakeup.agentId} for resolved input ${wakeup.requestId}: ${reason}.`,
    now,
    store.getOperatorNotification(wakeup.taskId)
  ));
}

function requireWakeup(
  store: TaskStore,
  claim: Pick<LeaderInputWakeupClaim, "taskId" | "requestId">
): InputResolutionWakeup {
  const wakeup = store.getInputResolutionWakeup(claim.taskId, claim.requestId);
  if (wakeup === null) {
    throw dataError(`Input resolution wakeup not found: ${claim.taskId}/${claim.requestId}`);
  }
  return wakeup;
}

function claimReference(wakeup: InputResolutionWakeup): LeaderInputWakeupClaim {
  if (wakeup.status !== "claimed") {
    throw new Error(`Input resolution wakeup is not claimed: ${wakeup.taskId}/${wakeup.requestId}`);
  }
  const persistedClaim = wakeup.claim;
  if (persistedClaim === undefined) {
    throw new Error(`Input resolution wakeup claim is missing: ${wakeup.taskId}/${wakeup.requestId}`);
  }
  return {
    taskId: wakeup.taskId,
    roleName: wakeup.roleName,
    agentId: wakeup.agentId,
    requestId: wakeup.requestId,
    resolutionId: wakeup.resolutionId,
    agentRunId: wakeup.agentRunId,
    adapterId: wakeup.adapterId,
    sessionRoot: wakeup.sessionRoot,
    nativeSessionId: wakeup.nativeSessionId,
    deliveryId: wakeup.deliveryId,
    controllerId: persistedClaim.controllerId,
    controllerGeneration: persistedClaim.controllerGeneration,
    claimId: persistedClaim.claimId
  };
}

function inspectExactBlockedLeader(
  store: TaskStore,
  wakeup: InputResolutionWakeup
): ExactBlockedLeader {
  const task = store.getTask(wakeup.taskId);
  const request = store.getInputRequest(wakeup.taskId, wakeup.requestId);
  const resolution = store.getInputResolution(wakeup.taskId, wakeup.resolutionId);
  const role = store.getRole(wakeup.taskId, wakeup.roleName);
  const run = store.getAgentRun(wakeup.taskId, wakeup.agentRunId);
  const active = store.getActiveAgentRun(wakeup.taskId, wakeup.roleName);
  const sessionSet = store.getRoleSessionSet(wakeup.taskId, wakeup.roleName);
  const session = sessionSet?.sessions[wakeup.agentId];
  const binding = role?.agentBindings[wakeup.agentId];
  if (
    task === null ||
    task.archived ||
    request === null ||
    !["answered", "auto-resolved"].includes(request.status) ||
    request.resolutionId !== wakeup.resolutionId ||
    resolution === null ||
    resolution.requestId !== wakeup.requestId ||
    wakeup.roleName !== "leader" ||
    request.requester.roleName !== wakeup.roleName ||
    request.requester.agentId !== wakeup.agentId ||
    role === null ||
    role.status !== "running" ||
    role.activeAgentId !== wakeup.agentId ||
    run === null ||
    active === null ||
    active.id !== run.id ||
    run.status !== "blocked" ||
    active.status !== "blocked" ||
    run.blockedBy?.type !== "input-request" ||
    run.blockedBy.requestId !== wakeup.requestId ||
    active.blockedBy?.type !== "input-request" ||
    active.blockedBy.requestId !== wakeup.requestId ||
    sessionSet === null ||
    sessionSet.activeAgentId !== wakeup.agentId ||
    binding === undefined ||
    binding.agentId !== wakeup.agentId ||
    binding.adapterId !== wakeup.adapterId ||
    session === undefined ||
    session.agentId !== wakeup.agentId ||
    session.adapterId !== wakeup.adapterId ||
    session.sessionRoot !== wakeup.sessionRoot ||
    session.nativeSessionId !== wakeup.nativeSessionId ||
    !["ready", "running"].includes(session.status) ||
    request.requester.agentRunId !== wakeup.agentRunId ||
    request.requester.adapterId !== wakeup.adapterId ||
    request.requester.sessionRoot !== wakeup.sessionRoot ||
    request.requester.nativeSessionId !== wakeup.nativeSessionId
  ) {
    return { kind: "invalid", reason: "origin-session-or-agent-drift" };
  }
  return { kind: "ready", task, role, run, sessionSet, session };
}

function releaseBestEffort(
  service: LeaderInputWakeupService,
  claim: LeaderInputWakeupClaim,
  now: Date
): void {
  try {
    service.release(`input-wakeup-release-${randomUUID()}`, claim, now);
  } catch {
    // A concurrent Controller may have accepted, finalized, or reclaimed it.
  }
}

function wakeupKey(value: Pick<LeaderInputWakeupClaim, "taskId" | "requestId">): string {
  return `${value.taskId}\u0000${value.requestId}`;
}

function assertClaimDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) {
    throw new Error("Leader input wakeup claim duration must be a positive safe integer up to five minutes.");
  }
}

function assertMaxWakeups(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Leader input wakeup processing limit is invalid.");
  }
}

function trustedNow(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Leader input wakeup clock returned an invalid timestamp.");
  }
  return value;
}
