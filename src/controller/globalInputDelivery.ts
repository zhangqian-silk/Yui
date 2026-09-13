import type { TaskStore } from "../storage/taskStore.js";
import { sendAgentHostRunControl, AGENT_HOST_CONTROL_PROTOCOL } from "../runtime/agentHost.js";
import { currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import { hasRuntimeCleanupObligation, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import { markGlobalRoleMessageNotDelivered, type GlobalRoleMessage } from "../message/message.js";
import { providerRetryPending } from "../runtime/providerRetry.js";
import { settleGlobalRetryInput } from "../message/globalProviderRetry.js";

/** Messages are the only queue. Host's atomic begin arbitrates native writers. */
export async function deliverGlobalInputs(
  home: string,
  store: TaskStore,
  ensure: (roleName: string) => Promise<void>,
  onError: (error: unknown) => void
): Promise<void> {
  for (const role of store.listGlobalRoles()) {
    try {
      let pending = store.listGlobalRoleMessages(role.name).filter(message =>
        message.delivery === undefined && message.notDelivered === undefined
        && (message.inputControl?.action === "queue" || message.interruptThen !== undefined));
      if (pending.length === 0 || hasRuntimeCleanupObligation(store.getWorkMailbox(
        runtimeLifecycleTarget({ scope: "global", roleName: role.name })))) continue;
      let sessions = store.getGlobalRoleSessionSet(role.name);
      if (sessions?.providerBinding?.retry !== undefined && !providerRetryPending(sessions.providerBinding)) {
        store.transaction(tx => settleGlobalRetryInput(tx, role.name,
          tx.getGlobalRoleSessionSet(role.name)?.providerBinding, new Date()));
        pending = store.listGlobalRoleMessages(role.name).filter(message =>
          message.delivery === undefined && message.notDelivered === undefined
          && (message.inputControl?.action === "queue" || message.interruptThen !== undefined));
        if (pending.length === 0) continue;
      }
      if (providerRetryPending(sessions?.providerBinding)) continue;
      const current = sessions?.providerBinding?.run;
      const obsolete = pending.filter(message => {
        const claim = message.interruptThen;
        return claim !== undefined && (sessions?.activeAgentId !== claim.targetAgentId
          || sessions.sessions[claim.targetAgentId]?.nativeSessionId !== claim.targetNativeSessionId
          || sessions.providerBinding?.authority.epoch !== claim.targetAuthorityEpoch
          || sessions.providerBinding.authority.holderId !== claim.targetAuthorityHolderId);
      });
      for (const message of obsolete) store.updateGlobalRoleMessage(
        markGlobalRoleMessageNotDelivered(message, "native-session-or-authority-changed", new Date()));
      pending = pending.filter(message => !obsolete.includes(message));
      if (pending.length === 0) continue;
      if (current != null && ["submitting", "accepted", "delivery-unknown"].includes(current.status)) continue;
      const claims = pending.filter(message => message.interruptThen !== undefined);
      let next: GlobalRoleMessage | undefined;
      if (claims.length > 0) {
        next = claims.find(message => {
          const claim = message.interruptThen!;
          const binding = sessions?.providerBinding;
          return current?.attemptId === claim.targetAttemptId
            && ["completed", "failed", "cancelled"].includes(current.status)
            && sessions?.activeAgentId === claim.targetAgentId
            && sessions.sessions[claim.targetAgentId]?.nativeSessionId === claim.targetNativeSessionId
            && binding?.authority.owner === "controller"
            && binding.authority.epoch === claim.targetAuthorityEpoch
            && binding.authority.holderId === claim.targetAuthorityHolderId;
        });
        if (next === undefined) continue;
      } else next = pending[0];
      const attemptId = `global-input:${role.name}/${next.id}`;
      if (current?.attemptId === attemptId) continue;
      if (next.control !== undefined && next.control.outcome !== "rejected") continue;
      const matchesTarget = () => next!.deliveryTarget === undefined
        || sessions?.activeAgentId === next!.deliveryTarget.agentId
          && sessions.sessions[next!.deliveryTarget.agentId]?.nativeSessionId === next!.deliveryTarget.nativeSessionId;
      if (!matchesTarget()) {
        store.updateGlobalRoleMessage(markGlobalRoleMessageNotDelivered(next, "native-session-changed", new Date()));
        continue;
      }
      await ensure(role.name);
      sessions = store.getGlobalRoleSessionSet(role.name);
      const binding = sessions?.providerBinding;
      if (binding == null || binding.authority.owner !== "controller") continue;
      const nativeSessionId = currentProviderConversation(binding).conversationId;
      const persisted = store.listGlobalRoleMessages(role.name).find(message => message.id === next!.id);
      if (persisted === undefined || JSON.stringify(persisted) !== JSON.stringify(next)) continue;
      const claim = next.interruptThen;
      if (!matchesTarget() || claim !== undefined
        && (sessions?.activeAgentId !== claim.targetAgentId
          || nativeSessionId !== claim.targetNativeSessionId
          || binding.authority.epoch !== claim.targetAuthorityEpoch
          || binding.authority.holderId !== claim.targetAuthorityHolderId
          || binding.run?.attemptId !== claim.targetAttemptId
          || !["completed", "failed", "cancelled"].includes(binding.run.status))) {
        store.updateGlobalRoleMessage(markGlobalRoleMessageNotDelivered(next, "native-session-changed", new Date()));
        continue;
      }
      if (next.deliveryTarget === undefined) {
        next = { ...next, deliveryTarget: { agentId: sessions!.activeAgentId, nativeSessionId } };
        store.updateGlobalRoleMessage(next);
      }
      const result = await sendAgentHostRunControl({
        home, scope: "global", roleName: role.name,
        control: {
          protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "submit-turn", nativeSessionId,
          authority: { epoch: binding.authority.epoch, owner: "controller",
            holderId: binding.authority.holderId! },
          run: { attemptId, boundedText: [
            `Yui Global Message: role=${role.name} message=${next.id}.`,
            "Read your Session Context and the referenced Message in full, then act on its durable input."
          ].join("\n") }
        }
      });
      if (result.outcome === "rejected") {
        store.transaction(tx => {
          const latest = tx.listGlobalRoleMessages(role.name).find(message => message.id === next!.id);
          if (latest === undefined || latest.delivery !== undefined || latest.notDelivered !== undefined) return;
          const turn = tx.getGlobalRoleSessionSet(role.name)?.providerBinding?.run;
          if (providerRetryPending(tx.getGlobalRoleSessionSet(role.name)?.providerBinding)) return;
          // A later canonical acceptance wins over transport diagnostics.
          if (turn?.attemptId === attemptId && ["accepted", "completed", "failed", "cancelled"].includes(turn.status)) return;
          const unknown = result.failure?.inputDisposition === "unknown" || result.snapshot.state === "delivery-unknown";
          const updated = { ...latest, control: {
            requestId: latest.inputControl?.requestId ?? latest.interruptThen!.requestId,
            receiptId: attemptId, outcome: unknown ? "delivery-unknown" : "rejected",
            observedAt: new Date().toISOString()
          } } as GlobalRoleMessage;
          tx.updateGlobalRoleMessage(unknown ? updated : markGlobalRoleMessageNotDelivered(updated,
            result.failure?.detail ?? result.snapshot.detail ?? "provider-input-rejected", new Date()));
        });
      }
    } catch (error) { onError(error); }
  }
}
