import {
  mailboxHasWork,
  type MailboxTarget,
  type ProcessingBatch,
  type WorkMailbox
} from "../coordination/workMailbox.js";

export const RUNTIME_LIFECYCLE_OWNER = "runtime-lifecycle";
export const RUNTIME_LAUNCH_RESERVED_REASON = "runtime-launch-reserved";
export const RUNTIME_CLEANUP_REQUIRED_REASON = "runtime-cleanup-required";

export type RuntimeRoleOwner =
  | Readonly<{
      scope: "task";
      taskId: string;
      roleName: string;
    }>
  | Readonly<{
      scope: "global";
      roleName: string;
    }>;

export type RuntimeLifecycleTarget = Extract<
  MailboxTarget,
  { kind: "role-runtime" | "global-role-runtime" }
>;

export function runtimeLifecycleTarget(
  owner: RuntimeRoleOwner
): RuntimeLifecycleTarget {
  return owner.scope === "task"
    ? {
        kind: "role-runtime",
        taskId: owner.taskId,
        roleName: owner.roleName
      }
    : {
        kind: "global-role-runtime",
        roleName: owner.roleName
      };
}

export function runtimeLifecycleSignalKey(owner: RuntimeRoleOwner): string {
  return owner.scope === "task"
    ? `role:${encodeURIComponent(owner.taskId)}/${encodeURIComponent(owner.roleName)}`
    : `global-role:${encodeURIComponent(owner.roleName)}`;
}

export function isRuntimeLaunchReservation(
  processing: ProcessingBatch | null | undefined,
  launchId?: string
): boolean {
  return processing?.owner === RUNTIME_LIFECYCLE_OWNER
    && processing.batch.reasons.length === 1
    && processing.batch.reasons[0] === RUNTIME_LAUNCH_RESERVED_REASON
    && (launchId === undefined || processing.batchId === launchId);
}

export function hasRuntimeLaunchReservation(
  mailbox: WorkMailbox | null
): boolean {
  return isRuntimeLaunchReservation(mailbox?.processing);
}

export function hasRuntimeCleanupObligation(
  mailbox: WorkMailbox | null
): boolean {
  const pending = mailbox?.pending.normal;
  return pending?.reasons.includes(RUNTIME_CLEANUP_REQUIRED_REASON) === true
    || (
      !isRuntimeLaunchReservation(mailbox?.processing)
      && mailbox?.processing?.batch.reasons.includes(RUNTIME_CLEANUP_REQUIRED_REASON) === true
    );
}

export function hasRuntimeLifecycleWork(
  mailbox: WorkMailbox | null
): boolean {
  return mailbox !== null && mailboxHasWork(mailbox);
}
