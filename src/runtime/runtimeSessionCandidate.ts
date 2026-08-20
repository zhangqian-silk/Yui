import {
  activeRoleAgentSession,
  type AgentSessionStatus,
  type RoleSessionSet
} from "../executor/agentExecutor.js";
import type { RuntimeOwner } from "./runtimeOwner.js";

/**
 * Bounded projection of a RoleSessionSet's current non-stopped Session.
 *
 * Historical Session rows never enter this shape. SQLite persists the shape in
 * a dedicated hot table in the same transaction as the authoritative
 * RoleSessionSet; the file rollback backend derives it from its aggregate.
 */
export type RuntimeSessionCandidate = Readonly<{
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  launchId?: string;
  status: Exclude<AgentSessionStatus, "stopped">;
  sessionUpdatedAt: string;
  cleanupRequired: boolean;
}>;

export type RuntimeSessionCandidateQuery = Readonly<{
  /** Uses SQLite's cleanup-required partial index when true. */
  cleanupRequiredOnly?: boolean;
  /** Restricts the projection to one runtime owner scope. */
  scope?: RuntimeOwner["scope"];
  /**
   * Restricts task-scoped candidates to these Task ids. Supplying this field
   * excludes global candidates; an empty list selects no candidates.
   */
  taskIds?: readonly string[];
}>;

/** Exact completed-Task cleanup contract shared by projection writers/readers. */
export function runtimeSessionRequiresCleanup(input: Readonly<{
  status: AgentSessionStatus;
  launchId?: string;
}>): boolean {
  if (input.status === "stopped" || input.status === "broken") return false;
  return input.status === "running" || input.launchId !== undefined;
}

/** Projects only the current active Agent Session; stopped history disappears. */
export function projectRuntimeSessionCandidate(
  sessions: RoleSessionSet
): RuntimeSessionCandidate | null {
  const active = activeRoleAgentSession(sessions);
  if (active === null || active.status === "stopped") return null;
  return {
    owner: sessions.owner.scope === "task"
      ? {
          scope: "task",
          taskId: sessions.owner.taskId,
          roleName: sessions.owner.roleName
        }
      : { scope: "global", roleName: sessions.owner.roleName },
    agentId: active.agentId,
    adapterId: active.adapterId,
    nativeSessionId: active.nativeSessionId,
    ...(active.launchId === undefined ? {} : { launchId: active.launchId }),
    status: active.status,
    sessionUpdatedAt: active.updatedAt,
    cleanupRequired: runtimeSessionRequiresCleanup(active)
  };
}

/** Deterministic owner order shared by all storage backends. */
export function compareRuntimeSessionCandidates(
  left: RuntimeSessionCandidate,
  right: RuntimeSessionCandidate
): number {
  if (left.owner.scope !== right.owner.scope) {
    // Preserve the historical adapter contract: Task owners precede the
    // bounded global Role set.
    return left.owner.scope === "task" ? -1 : 1;
  }
  if (left.owner.scope === "task" && right.owner.scope === "task") {
    const task = left.owner.taskId.localeCompare(
      right.owner.taskId,
      undefined,
      { numeric: true }
    );
    if (task !== 0) return task;
  }
  return left.owner.roleName.localeCompare(
    right.owner.roleName,
    undefined,
    { numeric: true }
  );
}
