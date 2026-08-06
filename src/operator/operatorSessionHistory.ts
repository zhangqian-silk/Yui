import {
  normalizeRoleAgentSessionText,
  roleAgentSessionRef,
  validateRoleSessionSet,
  type GlobalRoleSessionSet,
  type RoleAgentSession
} from "../executor/agentExecutor.js";

export type OperatorSessionListItem = Readonly<{
  ref: string;
  agentId: string;
  adapterId: string;
  displayTitle: string;
  title?: string;
  preview?: string;
  state: "running" | "current" | "history";
  createdAt: string;
  updatedAt: string;
}>;

type OperatorSessionIdentity = Readonly<{
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
}>;

export function operatorSessionRef(session: OperatorSessionIdentity): string {
  return roleAgentSessionRef(session);
}

export function listOperatorSessions(
  sessions: GlobalRoleSessionSet | null
): OperatorSessionListItem[] {
  if (sessions === null) return [];
  validateRoleSessionSet(sessions);
  const current = Object.values(sessions.sessions).map((session) => (
    listItem(session, session.status === "stopped" || session.status === "broken"
      ? "current"
      : "running")
  ));
  const history = Object.values(sessions.history ?? {}).map((session) => (
    listItem(session, "history")
  ));
  return [...current, ...history].sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || left.ref.localeCompare(right.ref)
  ));
}

export function prepareOperatorNewSession(
  sessions: GlobalRoleSessionSet,
  targetAgentId: string,
  now: Date
): GlobalRoleSessionSet {
  validateRoleSessionSet(sessions);
  const agentId = requireText(targetAgentId, "Target Agent id");
  const current = sessions.sessions[agentId];
  const nextSessions = { ...sessions.sessions };
  let history = { ...(sessions.history ?? {}) };
  if (current !== undefined) {
    history = archiveCurrent(history, current);
    delete nextSessions[agentId];
  }
  return validateRoleSessionSet({
    ...sessions,
    activeAgentId: agentId,
    sessions: nextSessions,
    history,
    updatedAt: requireDate(now)
  });
}

export function prepareOperatorResumeSession(
  sessions: GlobalRoleSessionSet,
  ref: string,
  now: Date
): GlobalRoleSessionSet {
  validateRoleSessionSet(sessions);
  const normalizedRef = requireText(ref, "Operator session ref");
  const current = Object.values(sessions.sessions).find(
    (candidate) => operatorSessionRef(candidate) === normalizedRef
  );
  if (current !== undefined) {
    return validateRoleSessionSet({
      ...sessions,
      activeAgentId: current.agentId,
      updatedAt: requireDate(now)
    });
  }

  const selected = sessions.history?.[normalizedRef];
  if (selected === undefined) {
    throw new Error(`Operator session not found: ${normalizedRef}.`);
  }
  const nextSessions = { ...sessions.sessions };
  const history = { ...(sessions.history ?? {}) };
  const replaced = nextSessions[selected.agentId];
  if (replaced !== undefined) {
    Object.assign(history, archiveCurrent(history, replaced));
  }
  delete history[normalizedRef];
  nextSessions[selected.agentId] = {
    ...selected,
    status: "stopped",
    updatedAt: requireDate(now)
  };
  return validateRoleSessionSet({
    ...sessions,
    activeAgentId: selected.agentId,
    sessions: nextSessions,
    history,
    updatedAt: requireDate(now)
  });
}

function archiveCurrent(
  history: Record<string, RoleAgentSession>,
  session: RoleAgentSession
): Record<string, RoleAgentSession> {
  if (session.status !== "stopped" && session.status !== "broken") {
    throw new Error(
      `Cannot replace Operator session while its native process is ${session.status}.`
    );
  }
  const archived = {
    ...session,
    status: "stopped" as const
  };
  return {
    ...history,
    [operatorSessionRef(archived)]: archived
  };
}

function listItem(
  session: RoleAgentSession,
  state: OperatorSessionListItem["state"]
): OperatorSessionListItem {
  const ref = operatorSessionRef(session);
  const title = optionalDisplayText(session.title);
  const preview = optionalDisplayText(session.preview);
  const fallback = `${adapterLabel(session.adapterId)} session · ${ref.slice(-8)}`;
  return {
    ref,
    agentId: session.agentId,
    adapterId: session.adapterId,
    displayTitle: title ?? preview ?? fallback,
    ...(title === undefined ? {} : { title }),
    ...(preview === undefined ? {} : { preview }),
    state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function optionalDisplayText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeRoleAgentSessionText(value);
  return normalized.length === 0 ? undefined : normalized;
}

function adapterLabel(adapterId: string): string {
  return adapterId === "codex"
    ? "Codex"
    : adapterId === "claude"
      ? "Claude"
      : adapterId;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requireDate(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Operator session timestamp is invalid.");
  }
  return value.toISOString();
}
