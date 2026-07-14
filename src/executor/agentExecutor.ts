import { isAbsolute, resolve } from "node:path";
import {
  isCanonicalNativeSessionId,
  isCanonicalNativeSessionRoot
} from "./nativeSessionIdentity.js";
import {
  snapshotConfigFingerprint,
  type ConfigFingerprint
} from "./configFingerprint.js";
import { trimSurroundingWhitespace } from "../storage/stringValidation.js";

export type { ConfigFingerprint } from "./configFingerprint.js";

export type AgentSessionStatus = "reserved" | "ready" | "running" | "stopped" | "broken";

export type CodexPermissionEnvelope = {
  adapterId: "codex";
  sandbox?: string;
  approval?: string;
  additionalDirectoryHashes?: string[];
};

export type ClaudePermissionEnvelope = {
  adapterId: "claude";
  mode?: string;
  allowedToolHashes?: string[];
  disallowedToolHashes?: string[];
  additionalDirectoryHashes?: string[];
};

export type PermissionEnvelope = CodexPermissionEnvelope | ClaudePermissionEnvelope;
export type PermissionChange = "same" | "narrower" | "broader" | "incomparable";
export type ConfigDrift = {
  replayable: boolean;
  permission: PermissionChange;
  sessionBound: boolean;
};
export type ResumeDecision = "resume" | "requires-confirmation" | "requires-replacement";

export type GlobalRoleSessionOwner = { scope: "global"; roleName: string };
export type TaskRoleSessionOwner = { scope: "task"; taskId: string; roleName: string };
export type RoleSessionOwner = GlobalRoleSessionOwner | TaskRoleSessionOwner;

export type NativeSessionIdentity = {
  adapterId: string;
  sessionRoot: string;
  nativeSessionId: string;
};

export type RoleAgentSession = {
  schemaVersion: 3;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  policy: "fixed" | "leader-controlled";
  status: AgentSessionStatus;
  previousIdentities: NativeSessionIdentity[];
  sessionRoot: string;
  worktreeRoot?: string;
  createdConfigHash: ConfigFingerprint;
  lastLaunchConfigHash: ConfigFingerprint;
  permissionEnvelope: PermissionEnvelope;
  replacementReason?: string;
  createdAt: string;
  updatedAt: string;
};

type RoleSessionSetBase<TOwner extends RoleSessionOwner> = {
  schemaVersion: 3;
  owner: TOwner;
  activeAgentId: string;
  sessions: Record<string, RoleAgentSession>;
  updatedAt: string;
};

export type GlobalRoleSessionSet = RoleSessionSetBase<GlobalRoleSessionOwner>;
export type TaskRoleSessionSet = RoleSessionSetBase<TaskRoleSessionOwner>;
export type RoleSessionSet = GlobalRoleSessionSet | TaskRoleSessionSet;

export type ExecutorCapabilities = {
  recover: boolean;
  interrupt: boolean;
  nativeSessionDiscovery: boolean;
};

type RecordRoleAgentSessionInput = {
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  policy: RoleAgentSession["policy"];
  status: AgentSessionStatus;
  sessionRoot: string;
  worktreeRoot?: string;
  configFingerprint: ConfigFingerprint;
  permissionEnvelope: PermissionEnvelope;
  replacementReason?: string;
};

export function createRoleSessionSet(
  owner: GlobalRoleSessionOwner,
  activeAgentId: string,
  now: Date
): GlobalRoleSessionSet;
export function createRoleSessionSet(
  owner: TaskRoleSessionOwner,
  activeAgentId: string,
  now: Date
): TaskRoleSessionSet;
export function createRoleSessionSet(
  owner: RoleSessionOwner,
  activeAgentId: string,
  now: Date
): RoleSessionSet {
  const normalizedOwner = normalizeOwner(owner);
  const set = {
    schemaVersion: 3 as const,
    owner: normalizedOwner,
    activeAgentId: requireSafeIdentity(activeAgentId, "Active Agent id"),
    sessions: {},
    updatedAt: now.toISOString()
  };
  return set as RoleSessionSet;
}

export function activeRoleAgentSession(set: RoleSessionSet | null): RoleAgentSession | null {
  if (set === null) return null;
  validateRoleSessionSet(set);
  return set.sessions[set.activeAgentId] ?? null;
}

export function recordRoleAgentSession<TSet extends RoleSessionSet>(
  set: TSet,
  input: RecordRoleAgentSessionInput,
  now: Date
): TSet {
  validateRoleSessionSet(set);
  const agentId = requireSafeIdentity(input.agentId, "Agent id");
  const adapterId = requireNonEmpty(input.adapterId, "Agent adapter id");
  const nativeSessionId = requireCanonicalNativeSessionId(input.nativeSessionId, "Native session id");
  const sessionRoot = requirePhysicalSessionRoot(input.sessionRoot, "Native session root");
  const worktreeRoot = input.worktreeRoot === undefined
    ? undefined
    : requireCanonicalRoot(input.worktreeRoot, "Role worktree root");
  const fingerprint = cloneAndValidateFingerprint(input.configFingerprint);
  const permissionEnvelope = cloneAndValidatePermissionEnvelope(input.permissionEnvelope, adapterId);
  const existing = set.sessions[agentId];
  const candidateIdentity = { adapterId, sessionRoot, nativeSessionId };
  const replacing = existing !== undefined && !sameNativeSessionIdentity(
    currentNativeSessionIdentity(existing),
    candidateIdentity
  );
  if (existing !== undefined) {
    validateRoleAgentSession(existing, agentId);
    if (existing.adapterId !== adapterId) {
      throw new Error(`Role session adapter cannot change in place: ${agentId}.`);
    }
    if (!replacing && existing.sessionRoot !== sessionRoot) {
      throw new Error(`Role session root cannot change in place: ${agentId}.`);
    }
    if (!replacing && existing.worktreeRoot !== worktreeRoot) {
      throw new Error(`Role worktree root cannot change in place: ${agentId}.`);
    }
    if (replacing && existing.previousIdentities.some((identity) =>
      sameNativeSessionIdentity(identity, candidateIdentity))) {
      throw new Error(`Historical native session identity cannot be reused: ${agentId}.`);
    }
  }

  const timestamp = now.toISOString();
  const replacementReason = normalizeReplacementReason(input.replacementReason, existing, replacing);
  const previousIdentities = replacing
    ? replacedSessionHistory(existing)
    : cloneNativeSessionIdentities(existing?.previousIdentities ?? []);
  const session: RoleAgentSession = {
    schemaVersion: 3,
    agentId,
    adapterId,
    nativeSessionId,
    policy: input.policy,
    status: input.status,
    previousIdentities,
    sessionRoot,
    ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
    createdConfigHash: existing === undefined || replacing
      ? cloneFingerprint(fingerprint)
      : cloneFingerprint(existing.createdConfigHash),
    lastLaunchConfigHash: cloneFingerprint(fingerprint),
    permissionEnvelope,
    ...(replacing
      ? { replacementReason }
      : existing?.replacementReason === undefined
        ? {}
        : { replacementReason: existing.replacementReason }),
    createdAt: existing === undefined || replacing ? timestamp : existing.createdAt,
    updatedAt: timestamp
  };
  validateRoleAgentSession(session, agentId);

  const next = {
    ...set,
    sessions: { ...set.sessions, [agentId]: session },
    updatedAt: timestamp
  } as TSet;
  validateRoleSessionSet(next);
  return next;
}

export function createRoleAgentSession(
  input: RecordRoleAgentSessionInput,
  now: Date,
  existing: RoleAgentSession | null = null
): RoleAgentSession {
  const agentId = requireSafeIdentity(input.agentId, "Agent id");
  const set = createRoleSessionSet({ scope: "global", roleName: "session-factory" }, agentId, now);
  const seeded = existing === null ? set : { ...set, sessions: { [agentId]: existing } };
  return recordRoleAgentSession(seeded, input, now).sessions[agentId];
}

export function classifyRoleAgentSessionResume(
  session: RoleAgentSession,
  candidate: ConfigFingerprint,
  candidatePermission: PermissionEnvelope
): { decision: ResumeDecision; drift: ConfigDrift } {
  validateRoleAgentSession(session, session.agentId);
  const fingerprint = cloneAndValidateFingerprint(candidate);
  assertPermissionEnvelope(candidatePermission, session.adapterId);
  const envelopeChange = comparePermissionEnvelopes(session.permissionEnvelope, candidatePermission);
  const permission = fingerprint.permission === session.lastLaunchConfigHash.permission
    ? (samePermissionEnvelope(session.permissionEnvelope, candidatePermission) ? "same" : "incomparable")
    : (envelopeChange === "same" ? "incomparable" : envelopeChange);
  const drift: ConfigDrift = {
    replayable: fingerprint.replayable !== session.lastLaunchConfigHash.replayable,
    permission,
    sessionBound: fingerprint.sessionBound !== session.createdConfigHash.sessionBound
  };
  return {
    drift,
    decision: drift.sessionBound
      ? "requires-replacement"
      : drift.permission === "broader" || drift.permission === "incomparable"
        ? "requires-confirmation"
        : "resume"
  };
}

export function comparePermissionEnvelopes(
  previous: PermissionEnvelope,
  candidate: PermissionEnvelope
): PermissionChange {
  if (previous.adapterId !== candidate.adapterId) return "incomparable";
  if (previous.adapterId === "codex" && candidate.adapterId === "codex") {
    return combinePermissionChanges([
      compareOrderedValue(previous.sandbox, candidate.sandbox, ["read-only", "workspace-write", "danger-full-access"]),
      compareOrderedValue(previous.approval, candidate.approval, ["untrusted", "on-request", "never"]),
      compareAllowedSets(previous.additionalDirectoryHashes, candidate.additionalDirectoryHashes)
    ]);
  }
  if (previous.adapterId === "claude" && candidate.adapterId === "claude") {
    return combinePermissionChanges([
      previous.mode === candidate.mode ? "same" : "incomparable",
      compareAllowedSets(previous.allowedToolHashes, candidate.allowedToolHashes),
      compareDeniedSets(previous.disallowedToolHashes, candidate.disallowedToolHashes),
      compareAllowedSets(previous.additionalDirectoryHashes, candidate.additionalDirectoryHashes)
    ]);
  }
  return "incomparable";
}

export function updateRoleAgentSessionStatus<TSet extends RoleSessionSet>(
  set: TSet,
  agentId: string,
  status: AgentSessionStatus,
  now: Date
): TSet {
  validateRoleSessionSet(set);
  const normalizedAgentId = requireSafeIdentity(agentId, "Agent id");
  const session = set.sessions[normalizedAgentId];
  if (session === undefined) throw new Error(`No Role session is recorded for Agent: ${normalizedAgentId}.`);
  const timestamp = now.toISOString();
  const next = {
    ...set,
    sessions: {
      ...set.sessions,
      [normalizedAgentId]: { ...session, status, updatedAt: timestamp }
    },
    updatedAt: timestamp
  } as TSet;
  validateRoleSessionSet(next);
  return next;
}

function normalizeOwner(owner: RoleSessionOwner): RoleSessionOwner {
  const roleName = requireSafeIdentity(owner.roleName, "Role name");
  return owner.scope === "global"
    ? { scope: "global", roleName }
    : { scope: "task", taskId: requireSafeIdentity(owner.taskId, "Task id"), roleName };
}

function validateRoleSessionSet(set: RoleSessionSet): void {
  if (set.schemaVersion !== 3) throw new Error("Role session set schema version is invalid.");
  normalizeOwner(set.owner);
  requireSafeIdentity(set.activeAgentId, "Active Agent id");
  const entries = Object.entries(set.sessions);
  for (const [agentId, session] of entries) validateRoleAgentSession(session, agentId);
  requireNonEmpty(set.updatedAt, "Role session set update timestamp");
}

function validateRoleAgentSession(session: RoleAgentSession, key: string): void {
  if (session.schemaVersion !== 3) throw new Error(`Role Agent session schema version is invalid: ${key}.`);
  const agentId = requireSafeIdentity(session.agentId, "Agent id");
  const adapterId = requireNonEmpty(session.adapterId, "Agent adapter id");
  if (key !== agentId) throw new Error(`Role Agent session identity is inconsistent: ${key}.`);
  requireCanonicalNativeSessionId(session.nativeSessionId, "Native session id");
  requirePhysicalSessionRoot(session.sessionRoot, "Native session root");
  if (!["fixed", "leader-controlled"].includes(session.policy)) {
    throw new Error(`Role Agent session policy is invalid: ${agentId}.`);
  }
  if (!["reserved", "ready", "running", "stopped", "broken"].includes(session.status)) {
    throw new Error(`Role Agent session status is invalid: ${agentId}.`);
  }
  if (session.worktreeRoot !== undefined) requireCanonicalRoot(session.worktreeRoot, "Role worktree root");
  cloneAndValidateFingerprint(session.createdConfigHash);
  cloneAndValidateFingerprint(session.lastLaunchConfigHash);
  cloneAndValidatePermissionEnvelope(session.permissionEnvelope, adapterId);
  const currentIdentity = currentNativeSessionIdentity(session);
  const history = session.previousIdentities.map((identity) =>
    cloneAndValidateNativeSessionIdentity(identity));
  if (history.some((identity) => identity.adapterId !== adapterId)) {
    throw new Error(`Role Agent session history adapter is inconsistent: ${agentId}.`);
  }
  const historyKeys = history.map(nativeSessionIdentityKey);
  if (new Set(historyKeys).size !== historyKeys.length) {
    throw new Error(`Role Agent session history contains duplicate identities: ${agentId}.`);
  }
  if (history.some((identity) => sameNativeSessionIdentity(identity, currentIdentity))) {
    throw new Error(`Role Agent session history contains the current identity: ${agentId}.`);
  }
  if (history.length > 0 && session.replacementReason === undefined) {
    throw new Error(`Role Agent session replacement reason is required: ${agentId}.`);
  }
  if (history.length === 0 && session.replacementReason !== undefined) {
    throw new Error(`Role Agent session replacement reason has no history: ${agentId}.`);
  }
  if (session.replacementReason !== undefined) requireNonEmpty(session.replacementReason, "Session replacement reason");
  requireNonEmpty(session.createdAt, "Role Agent session creation timestamp");
  requireNonEmpty(session.updatedAt, "Role Agent session update timestamp");
}

function cloneAndValidateFingerprint(fingerprint: ConfigFingerprint): ConfigFingerprint {
  return cloneFingerprint(fingerprint);
}

function cloneFingerprint(fingerprint: ConfigFingerprint): ConfigFingerprint {
  const snapshot = snapshotConfigFingerprint(fingerprint);
  if (snapshot === null) {
    throw new Error("Config fingerprint must be an inert record containing exact lowercase SHA-256 hex digests.");
  }
  return snapshot;
}

function cloneAndValidatePermissionEnvelope(envelope: PermissionEnvelope, adapterId: string): PermissionEnvelope {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Role session permission envelope is required.");
  }
  if (envelope.adapterId !== adapterId) {
    throw new Error(`Role session permission adapter does not match session adapter: ${adapterId}.`);
  }
  if (envelope.adapterId === "codex") {
    assertExactKeys(
      envelope,
      ["adapterId", "sandbox", "approval", "additionalDirectoryHashes"],
      "Codex permission envelope"
    );
    if (envelope.sandbox !== undefined) requireNonEmpty(envelope.sandbox, "Codex permission sandbox");
    if (envelope.approval !== undefined) requireNonEmpty(envelope.approval, "Codex permission approval");
    return {
      adapterId: "codex",
      ...(envelope.sandbox === undefined ? {} : { sandbox: envelope.sandbox }),
      ...(envelope.approval === undefined ? {} : { approval: envelope.approval }),
      ...(envelope.additionalDirectoryHashes === undefined
        ? {}
        : {
            additionalDirectoryHashes: validateToolHashes(
              envelope.additionalDirectoryHashes,
              "Codex additional directory hash"
            )
          })
    };
  }
  if (envelope.adapterId !== "claude") {
    throw new Error("Role session permission adapter is unsupported.");
  }
  assertExactKeys(
    envelope,
    ["adapterId", "mode", "allowedToolHashes", "disallowedToolHashes", "additionalDirectoryHashes"],
    "Claude permission envelope"
  );
  if (envelope.mode !== undefined) requireNonEmpty(envelope.mode, "Claude permission mode");
  return {
    adapterId: "claude",
    ...(envelope.mode === undefined ? {} : { mode: envelope.mode }),
    ...(envelope.allowedToolHashes === undefined
      ? {}
      : { allowedToolHashes: validateToolHashes(envelope.allowedToolHashes, "Claude allowed tool hash") }),
    ...(envelope.disallowedToolHashes === undefined
      ? {}
      : { disallowedToolHashes: validateToolHashes(envelope.disallowedToolHashes, "Claude disallowed tool hash") }),
    ...(envelope.additionalDirectoryHashes === undefined
      ? {}
      : {
          additionalDirectoryHashes: validateToolHashes(
            envelope.additionalDirectoryHashes,
            "Claude additional directory hash"
          )
        })
  };
}

function assertPermissionEnvelope(envelope: PermissionEnvelope, adapterId: string): void {
  cloneAndValidatePermissionEnvelope(envelope, adapterId);
}

function compareOrderedValue(previous: string | undefined, candidate: string | undefined, order: string[]): PermissionChange {
  if (previous === candidate) return "same";
  if (previous === undefined || candidate === undefined) return "incomparable";
  const previousIndex = order.indexOf(previous);
  const candidateIndex = order.indexOf(candidate);
  if (previousIndex === -1 || candidateIndex === -1) return "incomparable";
  return candidateIndex < previousIndex ? "narrower" : "broader";
}

function compareAllowedSets(previous: string[] | undefined, candidate: string[] | undefined): PermissionChange {
  if (previous === undefined || candidate === undefined) {
    return previous === candidate ? "same" : "incomparable";
  }
  return compareSetDirection(previous, candidate, "narrower", "broader");
}

function compareDeniedSets(previous: string[] | undefined, candidate: string[] | undefined): PermissionChange {
  if (previous === undefined || candidate === undefined) {
    return previous === candidate ? "same" : "incomparable";
  }
  return compareSetDirection(previous, candidate, "broader", "narrower");
}

function compareSetDirection(
  previous: string[],
  candidate: string[],
  removed: PermissionChange,
  added: PermissionChange
): PermissionChange {
  const previousSet = new Set(previous);
  const candidateSet = new Set(candidate);
  const removedAny = [...previousSet].some((value) => !candidateSet.has(value));
  const addedAny = [...candidateSet].some((value) => !previousSet.has(value));
  if (removedAny && addedAny) return "incomparable";
  if (removedAny) return removed;
  if (addedAny) return added;
  return "same";
}

function combinePermissionChanges(changes: PermissionChange[]): PermissionChange {
  if (changes.includes("incomparable")) return "incomparable";
  const narrower = changes.includes("narrower");
  const broader = changes.includes("broader");
  if (narrower && broader) return "incomparable";
  return narrower ? "narrower" : broader ? "broader" : "same";
}

function samePermissionEnvelope(left: PermissionEnvelope, right: PermissionEnvelope): boolean {
  if (left.adapterId !== right.adapterId) return false;
  return left.adapterId === "codex" && right.adapterId === "codex"
    ? left.sandbox === right.sandbox &&
      left.approval === right.approval &&
      sameStringArray(left.additionalDirectoryHashes, right.additionalDirectoryHashes)
    : left.adapterId === "claude" && right.adapterId === "claude" &&
      left.mode === right.mode &&
      sameStringArray(left.allowedToolHashes, right.allowedToolHashes) &&
      sameStringArray(left.disallowedToolHashes, right.disallowedToolHashes) &&
      sameStringArray(left.additionalDirectoryHashes, right.additionalDirectoryHashes);
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertExactKeys(value: object, allowed: string[], label: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains an unsupported field.`);
  }
}

function validateToolHashes(values: string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} list must be an array.`);
  const cloned = values.map((value) => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`${label} must be a SHA-256 hex digest.`);
    }
    return value;
  });
  if (new Set(cloned).size !== cloned.length) throw new Error(`${label} list contains duplicates.`);
  if (cloned.some((value, index) => index > 0 && cloned[index - 1] >= value)) {
    throw new Error(`${label} list must be sorted.`);
  }
  return cloned;
}

function normalizeReplacementReason(
  reason: string | undefined,
  existing: RoleAgentSession | undefined,
  replacing: boolean
): string | undefined {
  if (existing === undefined) {
    if (reason !== undefined) throw new Error("Session replacement requires an existing native session.");
    return undefined;
  }
  if (!replacing) {
    if (reason !== undefined) throw new Error("Session replacement requires a different native session identity.");
    return undefined;
  }
  if (reason === undefined) throw new Error("Session replacement reason is required.");
  return requireNonEmpty(reason, "Session replacement reason");
}

function replacedSessionHistory(existing: RoleAgentSession): NativeSessionIdentity[] {
  return [
    ...cloneNativeSessionIdentities(existing.previousIdentities),
    currentNativeSessionIdentity(existing)
  ];
}

export function roleAgentSessionIdentities(session: RoleAgentSession): NativeSessionIdentity[] {
  validateRoleAgentSession(session, session.agentId);
  return [
    ...cloneNativeSessionIdentities(session.previousIdentities),
    currentNativeSessionIdentity(session)
  ];
}

export function sameNativeSessionIdentity(
  left: NativeSessionIdentity,
  right: NativeSessionIdentity
): boolean {
  return left.adapterId === right.adapterId &&
    left.sessionRoot === right.sessionRoot &&
    left.nativeSessionId === right.nativeSessionId;
}

function currentNativeSessionIdentity(session: RoleAgentSession): NativeSessionIdentity {
  return {
    adapterId: session.adapterId,
    sessionRoot: session.sessionRoot,
    nativeSessionId: session.nativeSessionId
  };
}

function cloneNativeSessionIdentities(identities: NativeSessionIdentity[]): NativeSessionIdentity[] {
  return identities.map((identity) => cloneAndValidateNativeSessionIdentity(identity));
}

function cloneAndValidateNativeSessionIdentity(identity: NativeSessionIdentity): NativeSessionIdentity {
  assertExactKeys(identity, ["adapterId", "sessionRoot", "nativeSessionId"], "Native session identity");
  return {
    adapterId: requireNonEmpty(identity.adapterId, "Native session adapter id"),
    sessionRoot: requirePhysicalSessionRoot(identity.sessionRoot, "Native session root"),
    nativeSessionId: requireCanonicalNativeSessionId(identity.nativeSessionId, "Native session id")
  };
}

function nativeSessionIdentityKey(identity: NativeSessionIdentity): string {
  return JSON.stringify([identity.adapterId, identity.sessionRoot, identity.nativeSessionId]);
}

function requireCanonicalRoot(value: string, label: string): string {
  const root = requireNonEmpty(value, label);
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw new Error(`${label} must be an absolute canonical path.`);
  }
  return root;
}

function requirePhysicalSessionRoot(value: string, label: string): string {
  const root = requireNonEmpty(value, label);
  if (!isCanonicalNativeSessionRoot(root)) throw new Error(`${label} must be a physical canonical path.`);
  return root;
}

function requireCanonicalNativeSessionId(value: string, label: string): string {
  if (!isCanonicalNativeSessionId(value)) throw new Error(`${label} must not contain surrounding whitespace.`);
  return value;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = trimSurroundingWhitespace(value);
  if (trimmed.length === 0) throw new Error(`${label} is required.`);
  return trimmed;
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireNonEmpty(value, label);
  if (["__proto__", "prototype", "constructor"].includes(normalized) || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
