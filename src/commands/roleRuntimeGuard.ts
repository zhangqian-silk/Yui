import type { WorkMailbox } from "../coordination/workMailbox.js";
import { usageError } from "../errors/cliError.js";
import {
  hasRuntimeLifecycleWork,
  runtimeLifecycleTarget,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";

export type RoleRuntimeGuardStore = Readonly<{
  getWorkMailbox(target: RuntimeLifecycleTarget): WorkMailbox | null;
}>;

/**
 * Runtime launch reservation and cleanup are ownership obligations for a Role
 * identity. Mutating or recreating that identity while either obligation is
 * queued can make the controller act on a different launch configuration.
 */
export function assertRoleRuntimeMutationAllowed(
  store: RoleRuntimeGuardStore,
  owner: RuntimeRoleOwner,
  action: string
): void {
  if (!hasRuntimeLifecycleWork(store.getWorkMailbox(runtimeLifecycleTarget(owner)))) return;
  throw usageError(
    `Role ${action} is blocked while a runtime lifecycle transition is pending or processing.`
  );
}
