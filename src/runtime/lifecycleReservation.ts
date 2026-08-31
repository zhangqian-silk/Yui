import {
  mailboxHasWork,
  type MailboxTarget,
  type ProcessingBatch,
  type WorkMailbox
} from "../coordination/workMailbox.js";

export const RUNTIME_LIFECYCLE_OWNER = "runtime-lifecycle";
export const RUNTIME_LAUNCH_RESERVED_REASON = "runtime-launch-reserved";
export const RUNTIME_CLEANUP_REQUIRED_REASON = "runtime-cleanup-required";
export const RUNTIME_HOST_DETACH_REQUIRED_REASON = "runtime-host-detach-required";

/**
 * A Role runtime lifecycle lane already holds an in-flight operation (a
 * launch reservation or a cleanup obligation). This is scheduler
 * backpressure: the equivalent wake/Run must be retried after the lane
 * settles. It is never grounds to terminalize a Run, because the contention
 * happens before (or outside) any semantic Run launch.
 */
export class RuntimeLifecycleBusyError extends Error {
  readonly name = "RuntimeLifecycleBusyError";

  constructor(message: string) {
    super(message);
  }
}

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
  return runtimeCleanupDisposition(mailbox) !== null;
}

/** Explicit Session end dominates a coalesced physical Host detach request. */
export function runtimeCleanupDisposition(
  mailbox: WorkMailbox | null
): "end-session" | "detach-host" | null {
  const reasons = [
    ...(mailbox?.pending.normal?.reasons ?? []),
    ...(!isRuntimeLaunchReservation(mailbox?.processing)
      ? mailbox?.processing?.batch.reasons ?? []
      : [])
  ];
  if (reasons.includes(RUNTIME_CLEANUP_REQUIRED_REASON)) return "end-session";
  if (reasons.includes(RUNTIME_HOST_DETACH_REQUIRED_REASON)) return "detach-host";
  return null;
}

export function isRuntimeCleanupReason(reason: string): boolean {
  return reason === RUNTIME_CLEANUP_REQUIRED_REASON
    || reason === RUNTIME_HOST_DETACH_REQUIRED_REASON;
}

export function hasRuntimeLifecycleWork(
  mailbox: WorkMailbox | null
): boolean {
  return mailbox !== null && mailboxHasWork(mailbox);
}
