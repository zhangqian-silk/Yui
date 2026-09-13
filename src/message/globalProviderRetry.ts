import { markGlobalRoleMessageNotDelivered, type GlobalRoleMessage } from "./message.js";
import type { ProviderRuntimeBinding } from "../runtime/providerRuntimeIdentity.js";

/** Settle the original queue entry when recovery ends with exact nondelivery.
 * Cancellation of a submitted/unknown request is not negative Provider proof. */
export function settleGlobalRetryInput(
  store: Readonly<{
    listGlobalRoleMessages(roleName: string): GlobalRoleMessage[];
    updateGlobalRoleMessage(message: GlobalRoleMessage): void;
  }>,
  roleName: string,
  binding: ProviderRuntimeBinding | null | undefined,
  now: Date
): void {
  const retry = binding?.retry;
  if (retry === undefined || retry.input.kind !== "message" || retry.input.roleName !== roleName
    || !["cancelled", "exhausted", "needs-attention"].includes(retry.status)
    || binding?.run == null || ["submitting", "accepted", "delivery-unknown"].includes(binding.run.status)) return;
  const messageId = retry.input.messageId;
  const message = store.listGlobalRoleMessages(roleName).find(m => m.id === messageId);
  if (message === undefined || message.delivery !== undefined || message.notDelivered !== undefined) return;
  store.updateGlobalRoleMessage(markGlobalRoleMessageNotDelivered(message,
    `provider-retry-${retry.status}: ${retry.reason ?? retry.failureRef}`, now));
}
