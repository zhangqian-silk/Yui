import type { InputRequest } from "../input/inputRequest.js";
import { readGlobalRoleRuntimeOperationClaim } from "../executor/roleRuntimeOperationClaim.js";
import { applyOfflineRecommendedResolution } from "../input/inputResolutionTransaction.js";
import type { TaskStore } from "../storage/taskStore.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { createOfflineResolutionClock } from "./offlineResolutionClock.js";

export type OperatorPresenceSnapshot = {
  state: "online" | "offline" | "unknown";
};

export type OfflineInputResolutionScan = {
  started: string[];
  resolved: string[];
  cleared: string[];
};

export type ResolutionIdFactory = (request: InputRequest) => string;

export type OperatorPresenceProbe = {
  probeRoleStatus(taskId: string, roleName: string): "running" | "exited";
};

/**
 * Foreground presence has one durable authority: the active Operator binding
 * and session in GlobalRoleSessionSet("operator"). A window without a
 * confirmed binding is never evidence of absence: it is unknown, so the
 * offline clock cannot advance across a launch crash or registration gap.
 */
export function readOperatorPresence(
  store: Pick<TaskStore, "getGlobalRole" | "getGlobalRoleSessionSet" | "getActiveAgentRun"> &
    Partial<Pick<TaskStore, "rootDirectory">>,
  probe?: OperatorPresenceProbe
): OperatorPresenceSnapshot {
  const role = store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
  if (role === null) {
    return { state: "offline" };
  }
  if (probe === undefined) {
    return { state: "unknown" };
  }
  let windowState: "running" | "exited";
  try {
    windowState = probe.probeRoleStatus("operator", SYSTEM_OPERATOR_ROLE);
  } catch {
    return { state: "unknown" };
  }
  if (
    store.rootDirectory !== undefined &&
    readGlobalRoleRuntimeOperationClaim(store.rootDirectory(), SYSTEM_OPERATOR_ROLE)?.kind === "global-role-launch"
  ) {
    return { state: "unknown" };
  }
  const binding = role.agentBindings[role.activeAgentId];
  const sessionSet = store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
  const session = sessionSet?.sessions[role.activeAgentId];
  const confirmedRunning =
    binding !== undefined &&
    sessionSet !== null &&
    sessionSet.activeAgentId === role.activeAgentId &&
    session !== undefined &&
    session.agentId === role.activeAgentId &&
    session.adapterId === binding.adapterId &&
    session.status === "running";
  if (windowState === "running") {
    return confirmedRunning ? { state: "online" } : { state: "unknown" };
  }
  if (session === undefined || sessionSet === null) {
    return { state: "offline" };
  }
  return ["stopped", "broken"].includes(session.status)
    ? { state: "offline" }
    : { state: "unknown" };
}

/**
 * Applies the only timeout policy TaskMux supports. A user-required request
 * never gets a clock; online/unknown actively clear any stale clock so only a
 * continuous confirmed-offline interval may auto-resolve.
 */
export function scanOfflineInputResolutions(
  store: TaskStore,
  presence: OperatorPresenceSnapshot,
  now: Date,
  nextResolutionId: ResolutionIdFactory
): OfflineInputResolutionScan {
  const normalizedPresence = normalizePresence(presence);
  assertNow(now);
  const result: OfflineInputResolutionScan = { started: [], resolved: [], cleared: [] };
  const eligible = new Map<string, InputRequest>();

  for (const task of store.listTasks()) {
    if (task.archived) continue;
    for (const request of store.listInputRequests(task.id)) {
      if (request.status === "open" && request.resolutionPolicy.mode === "offline-recommended") {
        eligible.set(clockKey(request.taskId, request.id), request);
      }
    }
  }

  for (const clock of store.listOfflineResolutionClocks()) {
    const key = clockKey(clock.taskId, clock.requestId);
    if (normalizedPresence.state !== "offline" || !eligible.has(key)) {
      store.clearOfflineResolutionClock(clock.taskId, clock.requestId);
      result.cleared.push(key);
    }
  }

  if (normalizedPresence.state !== "offline") {
    return result;
  }

  for (const [key, request] of eligible) {
    const policy = request.resolutionPolicy;
    if (policy.mode !== "offline-recommended") {
      continue;
    }
    let clock = store.getOfflineResolutionClock(request.taskId, request.id);
    if (clock === null || Date.parse(clock.offlineSince) > now.getTime()) {
      if (clock !== null) {
        store.clearOfflineResolutionClock(request.taskId, request.id);
        result.cleared.push(key);
      }
      store.saveOfflineResolutionClock(createOfflineResolutionClock(request.taskId, request.id, now));
      result.started.push(key);
      continue;
    }
    if (now.getTime() - Date.parse(clock.offlineSince) < policy.offlineTimeoutMs) {
      continue;
    }
    const resolutionId = nextResolutionId(request);
    if (store.getInputResolution(request.taskId, resolutionId) !== null) {
      throw new Error(`Offline input resolution id already exists: ${request.taskId}/${resolutionId}`);
    }
    applyOfflineRecommendedResolution(store, request.taskId, request.id, resolutionId, now);
    result.resolved.push(key);
  }

  return result;
}

function normalizePresence(value: OperatorPresenceSnapshot): OperatorPresenceSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !["online", "offline", "unknown"].includes(value.state)
  ) {
    throw new Error("Invalid Operator presence snapshot.");
  }
  return { state: value.state };
}

function assertNow(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid offline input resolution scan timestamp.");
  }
}

function clockKey(taskId: string, requestId: string): string {
  return `${taskId}/${requestId}`;
}
