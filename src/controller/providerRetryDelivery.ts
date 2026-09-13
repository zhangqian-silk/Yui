import { performance } from "node:perf_hooks";
import type { TaskStore } from "../storage/taskStore.js";
import type { RoleSessionSet } from "../executor/agentExecutor.js";
import type { AgentRun } from "../agentRun/agentRun.js";
import type { TaskReviewCandidate } from "../review/reviewRound.js";
import type { MailboxKey } from "./controller.js";
import { runTaskCommand } from "../commands/taskCommands.js";
import { retryIntentBlocker } from "./providerRetryAdmission.js";
import {
  cancelProviderRetry, providerRetryAttemptId, providerRetryPending, providerRetryProjection,
  type ProviderRetry
} from "../runtime/providerRetry.js";
import { currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import { runtimeLifecycleTarget, hasRuntimeCleanupObligation } from "../runtime/lifecycleReservation.js";
import {
  sendAgentHostRunControl, inspectAgentHostSocket, agentHostControlSocketPath, AGENT_HOST_CONTROL_PROTOCOL
} from "../runtime/agentHost.js";
import type { inspectAgentHost } from "../runtime/agentHost.js";
import { redactAgentErrorText } from "../runtime/agentError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { settleGlobalRetryInput } from "../message/globalProviderRetry.js";

type RetryDeliveryPorts = Readonly<{
  now?: () => Date;
  monotonicNow?: () => number;
  submit?: typeof sendAgentHostRunControl;
  inspect?: typeof inspectAgentHost;
  snapshotTaskCandidate?: (run: AgentRun) => Promise<TaskReviewCandidate | undefined>;
  onError?: (error: unknown) => void;
}>;

/** Hooks in the existing Controller pass and nearest-deadline timer. SQLite's
 * current Provider input is the only pending intent; nothing is queued here. */
export function createProviderRetryHooks(home: string, store: TaskStore, ports: RetryDeliveryPorts = {}) {
  const anchors = new Map<string, { wall: number; monotonic: number }>();
  const inspectedUnknown = new Set<string>();
  const inspect = ports.inspect ?? ((target: Parameters<typeof inspectAgentHost>[0]) =>
    inspectAgentHostSocket(agentHostControlSocketPath(target), 250));
  const now = (retry: ProviderRetry) => {
    const wall = (ports.now ?? (() => new Date()))().getTime();
    const monotonic = (ports.monotonicNow ?? (() => performance.now()))();
    let anchor = anchors.get(retry.chainId);
    if (anchor === undefined) {
      anchor = { wall: Math.max(wall, Date.parse(retry.updatedAt)), monotonic };
      anchors.set(retry.chainId, anchor);
    }
    return Math.max(wall, anchor.wall + Math.max(0, monotonic - anchor.monotonic));
  };
  const load = (owner: RoleSessionSet["owner"]) => owner.scope === "task"
    ? store.getTaskRoleSessionSet(owner.taskId, owner.roleName) : store.getGlobalRoleSessionSet(owner.roleName);
  const save = (set: RoleSessionSet) => {
    if (set.owner.scope === "task") store.saveTaskRoleSessionSet(set as Parameters<TaskStore["saveTaskRoleSessionSet"]>[0]);
    else store.saveGlobalRoleSessionSet(set as Parameters<TaskStore["saveGlobalRoleSessionSet"]>[0]);
  };
  const stop = (set: RoleSessionSet, reason: string, at: number, exhausted = false) => {
    store.transaction(() => {
      const current = load(set.owner);
      if (current === null || current.providerBinding?.retry?.chainId !== set.providerBinding?.retry?.chainId) return;
      const binding = current.providerBinding!;
      if (!providerRetryPending(binding)) return;
      const cancelled = cancelProviderRetry(binding, reason, at);
      save({ ...current, providerBinding: exhausted
        ? { ...cancelled, retry: { ...cancelled.retry!, status: "exhausted" } } : cancelled });
      const owner = set.owner;
      if (owner.scope === "global") settleGlobalRetryInput(store, owner.roleName, load(owner)?.providerBinding, new Date(at));
      if (owner.scope === "task") {
        const event = createTaskEvent(store.nextEventId(owner.taskId), owner.taskId, "provider.retry-stopped", {
          roleName: owner.roleName, chainId: binding.retry!.chainId, reason
        }, new Date(at));
        store.saveEvent(owner.taskId, event);
        enqueueWork(store, owner.roleName === "leader" ? { kind: "operator" }
          : { kind: "role", taskId: owner.taskId, roleName: "leader" },
        "provider-retry-needs-attention", new Date(at), [{ type: "event", taskId: owner.taskId, id: event.id }]);
      }
    });
  };
  const key = (set: RoleSessionSet): MailboxKey => set.owner.scope === "task"
    ? `role:${encodeURIComponent(set.owner.taskId)}/${encodeURIComponent(set.owner.roleName)}`
    : `global-role:${encodeURIComponent(set.owner.roleName)}`;

  return {
    deadlines(): readonly { key: MailboxKey; at: number }[] {
      return store.listProviderRetrySessions().flatMap(set => {
        const retry = set.providerBinding!.retry!;
        if (retry.status !== "waiting") return [];
        // Busy or already-queued work awaits the next ordinary pass without a
        // zero-delay timer loop. Waiting never consumes an execution attempt.
        const wall = (ports.now ?? (() => new Date()))().getTime();
        const effective = now(retry);
        return [{ key: key(set), at: wall + Math.max(250,
          (retry.successorAutomatic === false ? Date.parse(retry.nextEligibleAt)
            : Math.min(Date.parse(retry.nextEligibleAt), Date.parse(retry.deadline))) - effective) }];
      });
    },
    async reconcile(): Promise<void> {
      const current = store.listProviderRetrySessions();
      const activeChains = new Set(current.map(set => set.providerBinding!.retry!.chainId));
      for (const id of anchors.keys()) if (!activeChains.has(id)) anchors.delete(id);
      const pendingAttempts = new Set(current.map(set => set.providerBinding!.retry!.currentAttemptId));
      for (const id of inspectedUnknown) if (!pendingAttempts.has(id)) inspectedUnknown.delete(id);
      for (const set of current) {
        const owner = set.owner;
        const binding = set.providerBinding!;
        const retry = binding.retry!;
        const at = now(retry);
        const scoped = { ...(owner.scope === "task" ? { taskId: owner.taskId } : {}), roleName: owner.roleName };
        const session = set.sessions[set.activeAgentId];
        const blocker = retryIntentBlocker(store, scoped, retry);
        if (blocker !== undefined && blocker !== "background-work-unsettled") {
          stop(set, blocker, at); continue;
        }
        if (binding.retryDisabled && retry.successorAutomatic !== false || binding.authority.owner !== "controller"
          || binding.authority.epoch !== retry.authorityEpoch
          || currentProviderConversation(binding).conversationId !== retry.nativeSessionId
          || session?.status !== "active" || session.nativeSessionId !== retry.nativeSessionId
          || hasRuntimeCleanupObligation(store.getWorkMailbox(runtimeLifecycleTarget(owner)))) {
          stop(set, "session-or-authority-changed", at); continue;
        }
        // Never replay an admitted attempt. Existing exact runtime queries and
        // terminal ingress resolve it, even across Controller restart.
        if (retry.status === "in-flight") {
          if (binding.run?.status === "delivery-unknown" && retry.currentAttemptId !== undefined
            && !inspectedUnknown.has(retry.currentAttemptId)) {
            inspectedUnknown.add(retry.currentAttemptId);
            let detail: string;
            try {
              const host = await inspect({ home, ...scoped, scope: owner.scope });
              detail = host.nativeSessionId === retry.nativeSessionId && host.attemptId === retry.currentAttemptId
                ? `Exact Host query: ${host.state}; awaiting original canonical Provider evidence.`
                : "Host query did not prove the original Session/input identity; no replay.";
            } catch (error) {
              detail = `Original Host query unavailable; no replay: ${redactAgentErrorText(error instanceof Error ? error.message : String(error))}`;
            }
            store.transaction(() => {
              const latest = load(owner);
              if (latest === null || latest.providerBinding == null || latest.providerBinding.run === null
                || latest.providerBinding.run.attemptId !== retry.currentAttemptId
                || latest.providerBinding.run.status !== "delivery-unknown") return;
              save({ ...latest, providerBinding: { ...latest.providerBinding,
                retry: { ...latest.providerBinding.retry!, reason: detail } } });
              if (owner.scope === "task") {
                const event = createTaskEvent(store.nextEventId(owner.taskId), owner.taskId, "provider.retry-unconfirmed", {
                  roleName: owner.roleName, attemptId: retry.currentAttemptId!, nativeSessionId: retry.nativeSessionId, detail
                }, new Date(at));
                store.saveEvent(owner.taskId, event);
                enqueueWork(store, owner.roleName === "leader" ? { kind: "operator" }
                  : { kind: "role", taskId: owner.taskId, roleName: "leader" },
                "provider-retry-needs-attention", new Date(at), [{ type: "event", taskId: owner.taskId, id: event.id }]);
              }
            });
          }
          continue;
        }
        if (retry.successorAutomatic !== false && at >= Date.parse(retry.deadline)) { stop(set, "deadline-exhausted", at, true); continue; }
        if (at < Date.parse(retry.nextEligibleAt) || blocker !== undefined || binding.goal?.status === "active") continue;
        if (binding.run?.attemptId !== retry.failedAttemptId) { stop(set, "superseded-input", at); continue; }
        try {
          if (owner.scope === "task" && retry.previousRunId !== undefined) {
            if (retry.successorRunId !== undefined || retry.successorReviewRoundId !== undefined) continue;
            const previous = store.getRun(owner.taskId, retry.previousRunId);
            if (previous?.status === "active") continue; // ordinary rejected-delivery terminal fold
            if (previous?.status !== "failed") { stop(set, "run-no-longer-failed", at); continue; }
            const actualTaskReviewCandidate = await ports.snapshotTaskCandidate?.(previous);
            store.transaction(() => {
              const latest = load(owner)?.providerBinding?.retry;
              if (latest?.chainId !== retry.chainId || latest.failedAttemptId !== retry.failedAttemptId
                || latest.status !== "waiting") return;
              const reason = retryIntentBlocker(store, scoped, latest);
              if (reason !== undefined) throw new Error(reason);
              runTaskCommand(["run", "retry", `${owner.taskId}/${previous.id}`], store, {
                now: () => new Date(at), environment: {}, providerRetryChainId: retry.chainId,
                ...(actualTaskReviewCandidate === undefined ? {} : { actualTaskReviewCandidate })
              });
            });
          } else {
            const original = retry.input.kind === "text" ? retry.input.text
              : retry.input.kind === "wake"
                ? `Yui Task notification: task=${retry.input.taskId} wake=${retry.input.wakeId}.\nRead current Task context and that fixed wake window, including original Messages in full. This is not an execution assignment.`
                : retry.input.kind === "message"
                  ? `Yui Global Message: role=${retry.input.roleName} message=${retry.input.messageId}.\nRead your Session Context and referenced original Message in full.`
                  : undefined;
            if (original === undefined) { stop(set, "original-input-unavailable", at); continue; }
            const result = await (ports.submit ?? sendAgentHostRunControl)({
              home, ...scoped, scope: owner.scope,
              control: {
                protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "submit-turn", nativeSessionId: retry.nativeSessionId,
                authority: { epoch: binding.authority.epoch, owner: "controller", holderId: binding.authority.holderId! },
                run: { attemptId: providerRetryAttemptId(retry), boundedText: original }
              }
            });
            // Durable settlement belongs to Host/Controller ingress. In
            // particular a lost response is never a reason to replay.
            if (result.outcome === "rejected" && result.failure?.registrationDisposition === "not-committed"
              && result.failure.errorName !== "ProviderTurnBusyError") {
              stop(set, result.failure.detail, at);
            }
          }
        } catch (error) {
          // A send failure may have applied. A durable submitting/unknown
          // identity fences it; do not manufacture a successor to uncertainty.
          const latest = load(owner);
          if (latest?.providerBinding?.run?.attemptId === retry.failedAttemptId) {
            stop(set, error instanceof Error ? error.message : String(error), at);
          }
          ports.onError?.(error);
        }
      }
    }
  };
}
