import { isAbsolute, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import { validateAgentAdvancedArguments, validateAgentBaseArguments } from "../agent/argumentPolicy.js";
import {
  isObsoleteProbeExecutablePin,
  isProbeExecutablePin,
  type ConfiguredAgent,
  type EnvironmentBinding
} from "../agent/agent.js";
import type {
  GlobalRoleSessionSet,
  PermissionEnvelope,
  RoleAgentSession,
  RoleSessionSet,
  TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { isConfigFingerprint } from "../executor/configFingerprint.js";
import type { GlobalRole, RoleAgentBinding, RoleProfile, TaskRole } from "../role/role.js";
import {
  isCanonicalNativeSessionId,
  isCanonicalNativeSessionRoot
} from "../executor/nativeSessionIdentity.js";
import {
  hasExactOwnKeys,
  lowerUnknownInertData,
  stringifyCanonicalInertData
} from "./inertData.js";
import { isConfiguredSkillId } from "./configuredSkill.js";
import { hasNonWhitespace } from "./stringValidation.js";

const PROFILE_KEYS = ["description", "responsibilities", "constraints", "expectedOutput", "systemPrompt", "skills"] as const;

export function isSafeStorageSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." &&
    value !== "__proto__" && value !== "prototype" && value !== "constructor" &&
    !containsStorageSeparator(value);
}

export function isConfiguredAgentRecord(value: unknown, expectedId?: string): value is ConfiguredAgent {
  return snapshotConfiguredAgentRecord(value, expectedId) !== null;
}

export function snapshotConfiguredAgentRecord(value: unknown, expectedId?: string): ConfiguredAgent | null {
  const snapshot = recordSnapshot(value);
  if (snapshot === null || !hasExactKeys(snapshot,
    ["schemaVersion", "id", "adapterId", "command", "baseArgs", "environment", "createdAt", "updatedAt"],
    ["probePin", "probePinRefreshRequired"])) return null;
  const obsoleteProbePin = snapshot.probePin !== undefined &&
    isObsoleteProbeExecutablePin(snapshot.probePin);
  if (snapshot.schemaVersion !== 2 || !isSafeStorageSegment(snapshot.id) ||
      (expectedId !== undefined && snapshot.id !== expectedId) || !isNonEmptyString(snapshot.adapterId) ||
      !isNonEmptyString(snapshot.command) || !isStringArray(snapshot.baseArgs) ||
      !Array.isArray(snapshot.environment) || !arrayEvery(snapshot.environment, isEnvironmentBinding) ||
      (snapshot.probePin !== undefined && !isProbeExecutablePin(snapshot.probePin) && !obsoleteProbePin) ||
      (snapshot.probePinRefreshRequired !== undefined && snapshot.probePinRefreshRequired !== true) ||
      (snapshot.probePin !== undefined && snapshot.probePinRefreshRequired !== undefined) ||
      !isNonEmptyString(snapshot.createdAt) || !isNonEmptyString(snapshot.updatedAt)) return null;
  try {
    validateAgentBaseArguments(snapshot.adapterId, snapshot.baseArgs);
    if (obsoleteProbePin) {
      delete snapshot.probePin;
      snapshot.probePinRefreshRequired = true;
    }
    return snapshot as unknown as ConfiguredAgent;
  } catch {
    return null;
  }
}

export function isGlobalRoleRecord(value: unknown, expectedName?: string): value is GlobalRole {
  return snapshotGlobalRoleRecord(value, expectedName) !== null;
}

export function snapshotGlobalRoleRecord(value: unknown, expectedName?: string): GlobalRole | null {
  const snapshot = recordSnapshot(value);
  return snapshot !== null && isRoleOwnerRecord(snapshot, expectedName, false)
    ? snapshot as unknown as GlobalRole
    : null;
}

export function isTaskRoleRecord(value: unknown, taskId: string, expectedName?: string): value is TaskRole {
  return snapshotTaskRoleRecord(value, taskId, expectedName) !== null;
}

export function isTaskRoleSnapshot(value: unknown, taskId: string, expectedName?: string): value is TaskRole {
  return isRecord(value) && isRoleOwnerRecord(value, expectedName, true) && value.taskId === taskId &&
    typeof value.status === "string" &&
    isOneOf(value.status, ["idle", "running", "detached", "exited", "failed"]);
}

export function snapshotTaskRoleRecord(value: unknown, taskId: string, expectedName?: string): TaskRole | null {
  const snapshot = recordSnapshot(value);
  return snapshot !== null && isTaskRoleSnapshot(snapshot, taskId, expectedName)
    ? snapshot as unknown as TaskRole
    : null;
}

export function isRoleProfileRecord(value: unknown, expectedName?: string): value is RoleProfile & { schemaVersion: 1; name: string } {
  return snapshotRoleProfileRecord(value, expectedName) !== null;
}

export function snapshotRoleProfileRecord(
  value: unknown,
  expectedName?: string
): (RoleProfile & { schemaVersion: 1; name: string }) | null {
  const snapshot = recordSnapshot(value);
  return snapshot !== null && hasExactKeys(snapshot, ["schemaVersion", "name"], [...PROFILE_KEYS]) &&
    snapshot.schemaVersion === 1 && isSafeStorageSegment(snapshot.name) &&
    (expectedName === undefined || snapshot.name === expectedName) && isRoleProfile(snapshot)
    ? snapshot as unknown as RoleProfile & { schemaVersion: 1; name: string }
    : null;
}

export function isRoleSessionSetRecord(value: unknown): value is RoleSessionSet {
  return snapshotRoleSessionSetRecord(value) !== null;
}

export function snapshotRoleSessionSetRecord(value: unknown): RoleSessionSet | null {
  if (!rawRoleSessionSetFingerprintsAreExact(value)) return null;
  const snapshot = recordSnapshot(value);
  if (snapshot === null || !hasExactKeys(snapshot,
    ["schemaVersion", "owner", "activeAgentId", "sessions", "updatedAt"]) ||
      snapshot.schemaVersion !== 3 || !isRecord(snapshot.owner) || !isSafeStorageSegment(snapshot.activeAgentId) ||
      !isRecord(snapshot.sessions) || !isNonEmptyString(snapshot.updatedAt)) return null;
  const owner = snapshot.owner;
  const validOwner = owner.scope === "global"
    ? hasExactKeys(owner, ["scope", "roleName"]) && isSafeStorageSegment(owner.roleName)
    : owner.scope === "task" && hasExactKeys(owner, ["scope", "taskId", "roleName"]) &&
      isSafeStorageSegment(owner.taskId) && isSafeStorageSegment(owner.roleName);
  return validOwner && recordEntriesEvery(snapshot.sessions, (agentId, session) =>
    isSafeStorageSegment(agentId) && isRoleAgentSessionSnapshotValue(session, agentId))
    ? snapshot as unknown as RoleSessionSet
    : null;
}

export function isGlobalRoleSessionSetRecord(
  value: unknown,
  roleName?: string
): value is GlobalRoleSessionSet {
  return snapshotGlobalRoleSessionSetRecord(value, roleName) !== null;
}

export function snapshotGlobalRoleSessionSetRecord(
  value: unknown,
  roleName?: string
): GlobalRoleSessionSet | null {
  const snapshot = snapshotRoleSessionSetRecord(value);
  return snapshot !== null && snapshot.owner.scope === "global" &&
    (roleName === undefined || snapshot.owner.roleName === roleName)
    ? snapshot as GlobalRoleSessionSet
    : null;
}

export function isTaskRoleSessionSetRecord(
  value: unknown,
  taskId?: string,
  roleName?: string
): value is TaskRoleSessionSet {
  return snapshotTaskRoleSessionSetRecord(value, taskId, roleName) !== null;
}

export function snapshotTaskRoleSessionSetRecord(
  value: unknown,
  taskId?: string,
  roleName?: string
): TaskRoleSessionSet | null {
  const snapshot = snapshotRoleSessionSetRecord(value);
  return snapshot !== null && snapshot.owner.scope === "task" &&
    (taskId === undefined || snapshot.owner.taskId === taskId) &&
    (roleName === undefined || snapshot.owner.roleName === roleName)
    ? snapshot as TaskRoleSessionSet
    : null;
}

export function isRoleAgentSessionRecord(value: unknown, agentId?: string): value is RoleAgentSession {
  return snapshotRoleAgentSessionRecord(value, agentId) !== null;
}

export function isRoleAgentSessionSnapshot(value: unknown, agentId?: string): value is RoleAgentSession {
  return isRoleAgentSessionSnapshotValue(value, agentId);
}

export function snapshotRoleAgentSessionRecord(value: unknown, agentId?: string): RoleAgentSession | null {
  if (!rawRoleAgentSessionFingerprintsAreExact(value)) return null;
  const snapshot = recordSnapshot(value);
  return snapshot !== null && isRoleAgentSessionSnapshotValue(snapshot, agentId)
    ? snapshot as unknown as RoleAgentSession
    : null;
}

function rawRoleSessionSetFingerprintsAreExact(value: unknown): boolean {
  const sessions = ownEnumerableDataProperty(value, "sessions");
  if (sessions === null || !isNonProxyRecord(sessions.value)) return false;
  const keys = Reflect.ownKeys(sessions.value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return false;
    const session = ownEnumerableDataProperty(sessions.value, key);
    if (session === null || !rawRoleAgentSessionFingerprintsAreExact(session.value)) return false;
  }
  return true;
}

function rawRoleAgentSessionFingerprintsAreExact(value: unknown): boolean {
  const created = ownEnumerableDataProperty(value, "createdConfigHash");
  const lastLaunch = ownEnumerableDataProperty(value, "lastLaunchConfigHash");
  return created !== null && lastLaunch !== null &&
    isConfigFingerprint(created.value) && isConfigFingerprint(lastLaunch.value);
}

function ownEnumerableDataProperty(
  value: unknown,
  key: string
): { value: unknown } | null {
  if (!isNonProxyRecord(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true
    ? { value: descriptor.value }
    : null;
}

function isNonProxyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !utilTypes.isProxy(value) && !Array.isArray(value);
}

function isRoleAgentSessionSnapshotValue(value: unknown, agentId?: string): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "agentId", "adapterId", "nativeSessionId", "policy", "status",
    "previousIdentities", "sessionRoot", "createdConfigHash", "lastLaunchConfigHash",
    "permissionEnvelope", "createdAt", "updatedAt"
  ], ["worktreeRoot", "replacementReason"]) || value.schemaVersion !== 3 ||
      !isSafeStorageSegment(value.agentId) || (agentId !== undefined && value.agentId !== agentId) ||
      !isNonEmptyString(value.adapterId) || !isCanonicalNativeSessionId(value.nativeSessionId) ||
      (value.policy !== "fixed" && value.policy !== "leader-controlled") ||
      typeof value.status !== "string" ||
      !isOneOf(value.status, ["reserved", "ready", "running", "stopped", "broken"]) ||
      !isNativeSessionIdentityHistory(value.previousIdentities, value.adapterId, {
        sessionRoot: value.sessionRoot,
        nativeSessionId: value.nativeSessionId
      }) ||
      !isCanonicalNativeSessionRoot(value.sessionRoot) ||
      (value.worktreeRoot !== undefined && !isCanonicalRoot(value.worktreeRoot)) ||
      !isConfigFingerprint(value.createdConfigHash) || !isConfigFingerprint(value.lastLaunchConfigHash) ||
      !isPermissionEnvelope(value.permissionEnvelope, value.adapterId) ||
      (value.replacementReason !== undefined && !isNonEmptyString(value.replacementReason)) ||
      (value.previousIdentities.length > 0 && !isNonEmptyString(value.replacementReason)) ||
      (value.previousIdentities.length === 0 && value.replacementReason !== undefined) ||
      !isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt)) return false;
  return true;
}

function isNativeSessionIdentityHistory(
  value: unknown,
  adapterId: string,
  current: { sessionRoot: unknown; nativeSessionId: string }
): value is Array<{ adapterId: string; sessionRoot: string; nativeSessionId: string }> {
  if (!Array.isArray(value) || !arrayEvery(value, (identity) =>
    isNativeSessionIdentity(identity, adapterId))) return false;
  for (let index = 0; index < value.length; index += 1) {
    const identity = value[index];
    if (identity.sessionRoot === current.sessionRoot &&
        identity.nativeSessionId === current.nativeSessionId) return false;
    for (let candidate = 0; candidate < index; candidate += 1) {
      if (nativeSessionIdentitiesMatch(identity, value[candidate])) return false;
    }
  }
  return true;
}

function isNativeSessionIdentity(value: unknown, adapterId: string): value is {
  adapterId: string;
  sessionRoot: string;
  nativeSessionId: string;
} {
  return isRecord(value) && hasExactKeys(value, ["adapterId", "sessionRoot", "nativeSessionId"]) &&
    value.adapterId === adapterId && isCanonicalNativeSessionRoot(value.sessionRoot) &&
    isCanonicalNativeSessionId(value.nativeSessionId);
}

function nativeSessionIdentitiesMatch(left: {
  adapterId: string;
  sessionRoot: string;
  nativeSessionId: string;
}, right: {
  adapterId: string;
  sessionRoot: string;
  nativeSessionId: string;
}): boolean {
  return left.adapterId === right.adapterId && left.sessionRoot === right.sessionRoot &&
    left.nativeSessionId === right.nativeSessionId;
}

export function roleReferencesAreConsistent(
  role: GlobalRole | TaskRole,
  agents: ReadonlyMap<string, ConfiguredAgent>
): boolean {
  return recordEntriesEvery(role.agentBindings, (agentId, binding) => {
    const agent = agents.get(agentId);
    return agent !== undefined && binding.agentId === agentId &&
      binding.adapterId === agent.adapterId && binding.config.adapterId === agent.adapterId;
  });
}

export function sessionSetMatchesRole(set: RoleSessionSet, role: GlobalRole | TaskRole): boolean {
  if (set.activeAgentId !== role.activeAgentId) return false;
  if (set.owner.roleName !== role.name) return false;
  if (set.owner.scope === "task" && (!("taskId" in role) || set.owner.taskId !== role.taskId)) return false;
  if (set.owner.scope === "global" && "taskId" in role) return false;
  return recordEntriesEvery(set.sessions, (agentId, session) => {
    if (!Object.hasOwn(role.agentBindings, agentId)) return false;
    const binding = role.agentBindings[agentId];
    return binding !== undefined && binding.agentId === session.agentId && binding.adapterId === session.adapterId;
  });
}

function isRoleOwnerRecord(value: unknown, expectedName: string | undefined, task: boolean): boolean {
  const required = task
    ? ["schemaVersion", "taskId", "name", "activeAgentId", "agentBindings", "workspace", "status", "createdAt", "updatedAt"]
    : ["schemaVersion", "name", "activeAgentId", "agentBindings", "workspace", "createdAt", "updatedAt"];
  if (!isRecord(value) || !hasExactKeys(value, required, [...PROFILE_KEYS]) || value.schemaVersion !== 2 ||
      !isSafeStorageSegment(value.name) || (expectedName !== undefined && value.name !== expectedName) ||
      (task && !isSafeStorageSegment(value.taskId)) || !isSafeStorageSegment(value.activeAgentId) ||
      !isRoleAgentBindings(value.agentBindings) || !Object.hasOwn(value.agentBindings, value.activeAgentId) ||
      !isNonEmptyString(value.workspace) || !isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt) ||
      !isRoleProfile(value)) return false;
  return true;
}

function isRoleAgentBindings(value: unknown): value is Record<string, RoleAgentBinding> {
  return isRecord(value) && Object.keys(value).length > 0 && recordEntriesEvery(value, (agentId, binding) =>
    isSafeStorageSegment(agentId) && isRecord(binding) && hasExactKeys(binding, ["agentId", "adapterId", "config"]) &&
    binding.agentId === agentId && isNonEmptyString(binding.adapterId) &&
    isRoleAgentConfig(binding.config, binding.adapterId));
}

function isRoleAgentConfig(value: unknown, adapterId: string): boolean {
  if (!isRecord(value) || value.adapterId !== adapterId) return false;
  if (adapterId === "codex") {
    return hasExactKeys(value, ["adapterId"], [
      "model", "effort", "permission", "search", "profile", "additionalDirectories", "advanced"
    ]) && isOptionalString(value.model) && isOptionalString(value.effort) &&
      (value.permission === undefined || (isRecord(value.permission) &&
        hasExactKeys(value.permission, [], ["sandbox", "approval"]) &&
        (value.permission.sandbox === undefined || (typeof value.permission.sandbox === "string" &&
          isOneOf(value.permission.sandbox, ["read-only", "workspace-write", "danger-full-access"]))) &&
        (value.permission.approval === undefined || (typeof value.permission.approval === "string" &&
          isOneOf(value.permission.approval, ["untrusted", "on-request", "never"]))))) &&
      (value.search === undefined || typeof value.search === "boolean") && isOptionalString(value.profile) &&
      isOptionalAbsolutePathArray(value.additionalDirectories) && isAdvanced(value.advanced, adapterId);
  }
  if (adapterId === "claude") {
    return hasExactKeys(value, ["adapterId"], [
      "model", "effort", "permission", "additionalDirectories", "settingsFile", "settingsSources", "advanced"
    ]) && isOptionalString(value.model) && isOptionalString(value.effort) &&
      (value.permission === undefined || (isRecord(value.permission) &&
        hasExactKeys(value.permission, [], ["mode", "allowedTools", "disallowedTools"]) &&
        isOptionalString(value.permission.mode) && isOptionalSafeToolExpressions(value.permission.allowedTools) &&
        isOptionalSafeToolExpressions(value.permission.disallowedTools))) &&
      isOptionalAbsolutePathArray(value.additionalDirectories) &&
      (value.settingsFile === undefined || isSafeAbsolutePath(value.settingsFile)) &&
      (value.settingsSources === undefined || (isStringArray(value.settingsSources) &&
        arrayEvery(value.settingsSources, isNonEmptyString) &&
        !hasDuplicateStrings(value.settingsSources))) &&
      isAdvanced(value.advanced, adapterId);
  }
  return false;
}

function isAdvanced(value: unknown, adapterId: string): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasExactKeys(value, [], ["rawArgs"]) || !isOptionalStringArray(value.rawArgs)) return false;
  if (value.rawArgs === undefined) return true;
  try {
    validateAgentAdvancedArguments(adapterId, value.rawArgs);
    return true;
  } catch {
    return false;
  }
}

function isPermissionEnvelope(value: unknown, adapterId: string): value is PermissionEnvelope {
  if (!isRecord(value) || value.adapterId !== adapterId) return false;
  if (adapterId === "codex") {
    return hasExactKeys(value, ["adapterId"], ["sandbox", "approval", "additionalDirectoryHashes"]) &&
      isOptionalNonEmptyString(value.sandbox) && isOptionalNonEmptyString(value.approval) &&
      isOptionalSortedUniqueSha256(value.additionalDirectoryHashes);
  }
  if (adapterId === "claude") {
    return hasExactKeys(
      value,
      ["adapterId"],
      ["mode", "allowedToolHashes", "disallowedToolHashes", "additionalDirectoryHashes"]
    ) &&
      isOptionalNonEmptyString(value.mode) && isOptionalSortedUniqueSha256(value.allowedToolHashes) &&
      isOptionalSortedUniqueSha256(value.disallowedToolHashes) &&
      isOptionalSortedUniqueSha256(value.additionalDirectoryHashes);
  }
  return false;
}

function isEnvironmentBinding(value: unknown): value is EnvironmentBinding {
  return isRecord(value) && hasExactKeys(value, ["target", "source", "sourceName", "required"]) &&
    typeof value.target === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.target) &&
    value.source === "process" && typeof value.sourceName === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.sourceName) && typeof value.required === "boolean";
}

function isRoleProfile(value: Record<string, unknown>): boolean {
  return isOptionalString(value.description) && isOptionalStringArray(value.responsibilities) &&
    isOptionalStringArray(value.constraints) && isOptionalString(value.expectedOutput) &&
    isOptionalString(value.systemPrompt) && isOptionalConfiguredSkillIds(value.skills);
}

function isOptionalConfiguredSkillIds(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isConfiguredSkillId) &&
    new Set(value).size === value.length);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return hasExactOwnKeys(value, required, optional);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordSnapshot(value: unknown): Record<string, unknown> | null {
  const snapshot = lowerUnknownInertData(value);
  if (snapshot === null || !isRecord(snapshot.value)) return null;
  const encoded = stringifyCanonicalInertData(snapshot);
  if (encoded === null) return null;
  const materialized = JSON.parse(encoded) as unknown;
  return isRecord(materialized) ? materialized : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && hasNonWhitespace(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && arrayEvery(value, (entry) => typeof entry === "string");
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) && resolve(value) === value &&
    !/[\r\n\0]/.test(value) && !/[{}]/.test(value);
}

function isCanonicalRoot(value: unknown): value is string {
  return typeof value === "string" && hasNonWhitespace(value) && isAbsolute(value) && resolve(value) === value;
}

function isOptionalAbsolutePathArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && arrayEvery(value, isSafeAbsolutePath));
}

function isOptionalSortedUniqueSha256(value: unknown): value is string[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !arrayEvery(
    value,
    (entry) => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry)
  )) {
    return false;
  }
  return arrayEvery(value, (entry, index) => index === 0 || value[index - 1] < entry);
}

function isOptionalSafeToolExpressions(value: unknown): value is string[] | undefined {
  return isOptionalStringArray(value) && arrayEvery(value ?? [], (entry) =>
    !/(?:api[-_]?key|token|secret|password|credential|authorization|Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,})/i.test(entry));
}

function arrayEvery<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean
): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!predicate(values[index], index)) return false;
  }
  return true;
}

function arraySome<T>(values: readonly T[], predicate: (value: T) => boolean): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (predicate(values[index])) return true;
  }
  return false;
}

function arrayContains<T>(values: readonly T[], target: T): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) return true;
  }
  return false;
}

function isOneOf<T>(value: T, choices: readonly T[]): boolean {
  return arrayContains(choices, value);
}

function recordEntriesEvery<T>(
  value: Record<string, T>,
  predicate: (key: string, item: T) => boolean
): boolean {
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!predicate(key, value[key])) return false;
  }
  return true;
}

function hasDuplicateStrings(values: readonly string[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    for (let candidate = 0; candidate < index; candidate += 1) {
      if (values[index] === values[candidate]) return true;
    }
  }
  return false;
}

function containsStorageSeparator(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "/" || character === "\\" || character === "\0") return true;
  }
  return false;
}
import { createHash } from "node:crypto";
