import { createHash } from "node:crypto";

export type LeaderRecoveryFailedNotification = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  type: "leader-recovery-failed";
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type RoleExpiryNotification = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  type: "role-expiry-stop-failed" | "role-expiry-identity-drift";
  roleName: string;
  agentId: string;
  runId: string;
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type OperatorNotification = LeaderRecoveryFailedNotification | RoleExpiryNotification;

export function createLeaderRecoveryNotification(
  taskId: string,
  message: string,
  now: Date,
  existing: OperatorNotification | null
): OperatorNotification {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    id: leaderRecoveryNotificationId(),
    taskId,
    type: "leader-recovery-failed",
    message,
    createdAt: existing?.type === "leader-recovery-failed" ? existing.createdAt : timestamp,
    updatedAt: timestamp
  };
}

export function createRoleExpiryNotification(
  taskId: string,
  roleName: string,
  agentId: string,
  runId: string,
  type: RoleExpiryNotification["type"],
  now: Date,
  existing: OperatorNotification | null
): RoleExpiryNotification {
  const timestamp = now.toISOString();
  const matchesExisting = existing?.type === type &&
    existing.roleName === roleName &&
    existing.agentId === agentId &&
    existing.runId === runId;
  return {
    schemaVersion: 1,
    id: roleExpiryNotificationId(type, roleName, agentId, runId),
    taskId,
    type,
    roleName,
    agentId,
    runId,
    message: type === "role-expiry-stop-failed"
      ? `TaskMux could not confirm that the Role process stopped after its ownership deadline for ${taskId}/${roleName}; ownership remains held.`
      : `TaskMux refused to stop ${taskId}/${roleName} because its active Agent or native session identity changed; ownership remains held.`,
    createdAt: matchesExisting ? existing.createdAt : timestamp,
    updatedAt: timestamp
  };
}

export function leaderRecoveryNotificationId(): string {
  return "leader-recovery-failed";
}

export function roleExpiryNotificationId(
  type: RoleExpiryNotification["type"],
  roleName: string,
  agentId: string,
  runId: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([type, roleName, agentId, runId]))
    .digest("hex");
  return `role-expiry-${digest}`;
}
