import {
  existsSync,
  readdirSync,
  readFileSync
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { dataError } from "../errors/cliError.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import type { GlobalRole, RoleProfile, TaskRole } from "../role/role.js";
import {
  isSafeStorageSegment,
  snapshotConfiguredAgentRecord,
  snapshotGlobalRoleRecord,
  snapshotGlobalRoleSessionSetRecord,
  snapshotRoleProfileRecord,
  snapshotTaskRoleRecord,
  snapshotTaskRoleSessionSetRecord
} from "./recordValidation.js";
import { executeDomainTransaction } from "./domainTransaction.js";
import { writeTextFileAtomically } from "./durableFile.js";
import { FileTaskStore } from "./taskStore.js";

const LEGACY_STORAGE_VERSION = 3;
const CURRENT_STORAGE_VERSION = 4;
const PROFILE_KEYS = [
  "description",
  "responsibilities",
  "constraints",
  "expectedOutput",
  "systemPrompt",
  "skills"
] as const;

type LegacyAgent = {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type LegacyRoleRuntime = {
  agent: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  workspace: string;
  status: TaskRole["status"];
  createdAt: string;
  updatedAt: string;
};

type LegacyGlobalRole = LegacyRoleRuntime & {
  name: string;
  profile: RoleProfile;
};

type DirectoryEntry = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

/**
 * Upgrades the only version of TaskMux storage which predates the Role Agent
 * records. The domain transaction makes the manifest version bump the commit
 * point: a restart replays the exact staged filesystem changes before trying
 * the migration again.
 */
export function migrateStorageSchemaV3ToV4(rootDir: string): void {
  executeDomainTransaction(rootDir, "storage-schema-v3-to-v4", (workingRoot) => {
    const manifest = readJsonRecord(join(workingRoot, "schema.json"), "storage schema manifest");
    const storageVersion = manifest.storageVersion;

    if (storageVersion === CURRENT_STORAGE_VERSION) {
      return;
    }
    if (storageVersion !== LEGACY_STORAGE_VERSION) {
      throw migrationError(
        `schema.json declares storage version ${String(storageVersion)} instead of ${LEGACY_STORAGE_VERSION}`
      );
    }

    const agents = migrateConfiguredAgents(workingRoot);
    migrateGlobalRoles(workingRoot, agents);
    migrateTaskRoleTrees(workingRoot, ["tasks"], agents);
    migrateTaskRoleTrees(workingRoot, ["trash", "tasks"], agents);
    rejectLegacyRoleSessions(workingRoot);

    writeJson(join(workingRoot, "schema.json"), {
      schemaVersion: 1,
      storageVersion: CURRENT_STORAGE_VERSION,
      updatedAt: new Date().toISOString()
    });
  });
}

function migrateConfiguredAgents(rootDir: string): Map<string, ConfiguredAgent> {
  const agents = new Map<string, ConfiguredAgent>();
  const agentsDir = join(rootDir, "agents");

  for (const id of directoryNames(agentsDir)) {
    const location = `agents/${id}/agent.json`;
    const agentPath = join(agentsDir, id, "agent.json");
    if (!existsSync(agentPath)) continue;
    const raw = readJsonRecord(agentPath, location);
    const current = snapshotConfiguredAgentRecord(raw, id);

    if (current !== null) {
      agents.set(id, current);
      continue;
    }

    const legacy = parseLegacyAgent(raw, id, location);
    if (Object.keys(legacy.env).length > 0) {
      throw migrationError(
        `${location} stores literal environment values. Recreate that Agent with process environment bindings before upgrading`
      );
    }

    const adapterId = inferLegacyAdapter(legacy);
    if (adapterId === null) {
      throw migrationError(
        `${location} cannot prove whether legacy Agent "${legacy.id}" is a Codex or Claude adapter. ` +
        "Use a TaskMux v3 binary to recreate it with a canonical codex or claude identity, then retry"
      );
    }

    const migrated = snapshotConfiguredAgentRecord({
      schemaVersion: 2,
      id: legacy.id,
      adapterId,
      command: legacy.command,
      baseArgs: legacy.args,
      environment: [],
      probePinRefreshRequired: true,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt
    }, id);
    if (migrated === null) {
      throw migrationError(
        `${location} has arguments or timestamps that cannot be represented by the v4 Agent contract`
      );
    }

    writeJson(agentPath, migrated);
    agents.set(id, migrated);
  }

  return agents;
}

function migrateGlobalRoles(rootDir: string, agents: ReadonlyMap<string, ConfiguredAgent>): void {
  const rolesDir = join(rootDir, "roles");

  for (const name of directoryNames(rolesDir)) {
    const location = `roles/${name}/role.json`;
    const rolePath = join(rolesDir, name, "role.json");
    if (!existsSync(rolePath)) continue;
    const raw = readJsonRecord(rolePath, location);
    if (snapshotGlobalRoleRecord(raw, name) !== null) continue;

    const legacy = parseLegacyGlobalRole(raw, name, location);
    const binding = bindingForLegacyRole(legacy, agents, location);
    const migrated = snapshotGlobalRoleRecord({
      schemaVersion: 2,
      name: legacy.name,
      activeAgentId: legacy.agent,
      agentBindings: { [legacy.agent]: binding },
      workspace: legacy.workspace,
      ...legacy.profile,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt
    }, name);
    if (migrated === null) {
      throw migrationError(`${location} cannot be represented by the v4 global Role contract`);
    }

    writeJson(rolePath, migrated);
  }
}

function migrateTaskRoleTrees(
  rootDir: string,
  relativeParent: readonly string[],
  agents: ReadonlyMap<string, ConfiguredAgent>
): void {
  const tasksDir = join(rootDir, ...relativeParent);

  for (const taskId of directoryNames(tasksDir)) {
    const taskRoot = join(tasksDir, taskId);
    const rolesDir = join(taskRoot, "roles");

    for (const name of directoryNames(rolesDir)) {
      const roleRoot = join(rolesDir, name);
      rejectLegacyWorktree(join(relativeParent.join("/"), taskId, "roles", name, "worktree.json"), roleRoot);

      const rolePath = join(roleRoot, "role.json");
      if (!existsSync(rolePath)) continue;
      const infoPath = join(roleRoot, "info.json");
      const location = join(relativeParent.join("/"), taskId, "roles", name, "role.json");
      const infoLocation = join(relativeParent.join("/"), taskId, "roles", name, "info.json");
      const runtime = readJsonRecord(rolePath, location);
      const profile = readRoleProfile(infoPath, name, infoLocation);
      const profileFields = withoutSchemaVersion(profile);
      const { name: profileName, ...profileData } = profileFields;
      const current = snapshotTaskRoleRecord({ ...runtime, ...profileFields }, taskId, name);

      if (current !== null) continue;

      const legacy = parseLegacyTaskRoleRuntime(runtime, location);
      const binding = bindingForLegacyRole(legacy, agents, location);
      const migrated = snapshotTaskRoleRecord({
        schemaVersion: 2,
        taskId,
        activeAgentId: legacy.agent,
        agentBindings: { [legacy.agent]: binding },
        workspace: legacy.workspace,
        status: legacy.status,
        ...profileData,
        name: profileName,
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt
      }, taskId, name);
      if (migrated === null) {
        throw migrationError(`${location} cannot be represented by the v4 task Role contract`);
      }

      writeJson(rolePath, {
        schemaVersion: migrated.schemaVersion,
        taskId: migrated.taskId,
        activeAgentId: migrated.activeAgentId,
        agentBindings: migrated.agentBindings,
        workspace: migrated.workspace,
        status: migrated.status,
        createdAt: migrated.createdAt,
        updatedAt: migrated.updatedAt
      });
    }
  }
}

function rejectLegacyRoleSessions(rootDir: string): void {
  const sessionsDir = join(rootDir, "runtime", "role-sessions");

  for (const entry of directoryEntries(sessionsDir)) {
    if (entry.name === "tasks") {
      validateCurrentTaskRoleSessions(join(sessionsDir, entry.name));
      continue;
    }
    if (entry.name === "global") {
      validateCurrentGlobalRoleSessions(join(sessionsDir, entry.name));
      continue;
    }
    const location = `runtime/role-sessions/${entry.name}`;
    throw migrationError(
      `${location} is a legacy Role session location. v3 sessions do not persist the physical session root, ` +
      "configuration fingerprint, or permission envelope required to resume safely. " +
      "Use a TaskMux v3 binary to stop or replace the session, then retry"
    );
  }

  try {
    new FileTaskStore(rootDir).listAllRoleSessionSets();
  } catch {
    throw migrationError(
      "current Role session storage does not match its persisted Role bindings. Repair or replace that session before upgrading"
    );
  }
}

function validateCurrentTaskRoleSessions(sessionsDir: string): void {
  for (const taskId of directoryNames(sessionsDir)) {
    for (const roleName of jsonRecordNames(join(sessionsDir, taskId))) {
      const location = `runtime/role-sessions/tasks/${taskId}/${roleName}.json`;
      const session = snapshotTaskRoleSessionSetRecord(
        readJsonRecord(join(sessionsDir, taskId, `${roleName}.json`), location),
        taskId,
        roleName
      );
      if (session === null) {
        throw migrationError(
          `${location} is not a valid current Role session set. Repair or replace that session before upgrading`
        );
      }
    }
  }
}

function validateCurrentGlobalRoleSessions(sessionsDir: string): void {
  for (const roleName of jsonRecordNames(sessionsDir)) {
    const location = `runtime/role-sessions/global/${roleName}.json`;
    const session = snapshotGlobalRoleSessionSetRecord(
      readJsonRecord(join(sessionsDir, `${roleName}.json`), location),
      roleName
    );
    if (session === null) {
      throw migrationError(
        `${location} is not a valid current Role session set. Repair or replace that session before upgrading`
      );
    }
  }
}

function rejectLegacyWorktree(location: string, roleRoot: string): void {
  const worktreePath = join(roleRoot, "worktree.json");
  if (!existsSync(worktreePath)) return;

  const value = readJsonRecord(worktreePath, location);
  if (value.schemaVersion === 1) {
    throw migrationError(
      `${location} is a legacy worktree record without the v4 ownership marker. ` +
      "TaskMux will not claim or delete an external Git worktree without proven ownership. " +
      "Use a TaskMux v3 binary to remove or recreate that worktree, then retry"
    );
  }
  if (!isCurrentWorktreeRecord(value)) {
    throw migrationError(`${location} is not a valid v4 worktree ownership record`);
  }
}

function bindingForLegacyRole(
  role: Pick<LegacyRoleRuntime, "agent" | "command" | "args" | "env">,
  agents: ReadonlyMap<string, ConfiguredAgent>,
  location: string
): { agentId: string; adapterId: "codex" | "claude"; config: { adapterId: "codex" | "claude" } } {
  const agent = agents.get(role.agent);
  if (agent === undefined) {
    throw migrationError(`${location} references legacy Agent "${role.agent}" that is not configured`);
  }
  if (
    agent.command !== role.command ||
    !sameStringArray(agent.baseArgs, role.args) ||
    agent.environment.length !== 0 ||
    Object.keys(role.env).length !== 0
  ) {
    throw migrationError(
      `${location} does not exactly match configured Agent "${role.agent}". ` +
      "TaskMux will not merge two different launch configurations"
    );
  }
  if (agent.adapterId !== "codex" && agent.adapterId !== "claude") {
    throw migrationError(`${location} references unsupported Role Agent adapter "${agent.adapterId}"`);
  }
  return {
    agentId: agent.id,
    adapterId: agent.adapterId,
    config: { adapterId: agent.adapterId }
  };
}

function parseLegacyAgent(value: Record<string, unknown>, expectedId: string, location: string): LegacyAgent {
  if (
    !hasExactKeys(value, ["schemaVersion", "id", "command", "args", "env", "createdAt", "updatedAt"]) ||
    value.schemaVersion !== 1 ||
    value.id !== expectedId ||
    typeof value.id !== "string" ||
    typeof value.command !== "string" ||
    !isStringArray(value.args) ||
    !isStringRecord(value.env) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw migrationError(`${location} is not an exact v3 Agent record`);
  }
  return {
    id: value.id,
    command: value.command,
    args: value.args,
    env: value.env,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function parseLegacyGlobalRole(
  value: Record<string, unknown>,
  expectedName: string,
  location: string
): LegacyGlobalRole {
  const required = [
    "schemaVersion",
    "name",
    "agent",
    "command",
    "args",
    "env",
    "workspace",
    "createdAt",
    "updatedAt"
  ];
  if (
    !hasExactKeys(value, required, PROFILE_KEYS) ||
    value.schemaVersion !== 1 ||
    value.name !== expectedName ||
    typeof value.name !== "string"
  ) {
    throw migrationError(`${location} is not an exact v3 global Role record`);
  }
  const runtime = parseLegacyRoleRuntime(value, location, false);
  const profile = profileFromLegacyRole(value, expectedName, location);
  return { ...runtime, name: expectedName, profile };
}

function parseLegacyTaskRoleRuntime(value: Record<string, unknown>, location: string): LegacyRoleRuntime {
  return parseLegacyRoleRuntime(value, location, true);
}

function parseLegacyRoleRuntime(
  value: Record<string, unknown>,
  location: string,
  includeStatus: boolean
): LegacyRoleRuntime {
  const required = includeStatus
    ? ["schemaVersion", "agent", "command", "args", "env", "workspace", "status", "createdAt", "updatedAt"]
    : ["schemaVersion", "name", "agent", "command", "args", "env", "workspace", "createdAt", "updatedAt"];
  if (
    !hasExactKeys(value, required, includeStatus ? [] : PROFILE_KEYS) ||
    value.schemaVersion !== 1 ||
    typeof value.agent !== "string" ||
    typeof value.command !== "string" ||
    !isStringArray(value.args) ||
    !isStringRecord(value.env) ||
    typeof value.workspace !== "string" ||
    (includeStatus && !isRoleStatus(value.status)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw migrationError(`${location} is not an exact v3 task Role runtime record`);
  }
  return {
    agent: value.agent,
    command: value.command,
    args: value.args,
    env: value.env,
    workspace: value.workspace,
    status: includeStatus ? value.status as TaskRole["status"] : "idle",
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function readRoleProfile(path: string, expectedName: string, location: string): RoleProfile & { schemaVersion: 1; name: string } {
  const value = readJsonRecord(path, location);
  const profile = snapshotRoleProfileRecord(value, expectedName);
  if (profile === null) throw migrationError(`${location} is not an exact v3 Role profile record`);
  return profile;
}

function profileFromLegacyRole(
  value: Record<string, unknown>,
  name: string,
  location: string
): RoleProfile {
  const profile = snapshotRoleProfileRecord({
    schemaVersion: 1,
    name,
    ...Object.fromEntries(PROFILE_KEYS
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]))
  }, name);
  if (profile === null) throw migrationError(`${location} has an invalid Role profile`);
  return withoutSchemaVersion(profile);
}

function inferLegacyAdapter(agent: LegacyAgent): "codex" | "claude" | null {
  const commandName = agent.command.includes("/") ? agent.command.slice(agent.command.lastIndexOf("/") + 1) : agent.command;
  return agent.id === "codex" && commandName === "codex"
    ? "codex"
    : agent.id === "claude" && commandName === "claude"
      ? "claude"
      : null;
}

function isCurrentWorktreeRecord(value: Record<string, unknown>): boolean {
  const keys = [
    "schemaVersion",
    "taskId",
    "roleName",
    "repositoryRoot",
    "commonDir",
    "repositoryFingerprint",
    "path",
    "worktreeGitDir",
    "branchRef",
    "headOid",
    "ownerToken",
    "createdAt"
  ];
  return hasExactKeys(value, keys) &&
    value.schemaVersion === 2 &&
    isSafeStorageSegment(value.taskId) &&
    isSafeStorageSegment(value.roleName) &&
    ["repositoryRoot", "commonDir", "path", "worktreeGitDir"].every((key) => isCanonicalAbsolutePath(value[key])) &&
    typeof value.repositoryFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.repositoryFingerprint) &&
    typeof value.branchRef === "string" && isSafeGitBranchName(value.branchRef) &&
    typeof value.headOid === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.headOid) &&
    typeof value.ownerToken === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.ownerToken) &&
    isCanonicalTimestamp(value.createdAt);
}

function isCanonicalAbsolutePath(value: unknown): boolean {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function isSafeGitBranchName(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") &&
    !value.endsWith(".") && !value.includes("..") && !value.includes("//") && !value.includes("@{") &&
    !value.endsWith(".lock") && !/[\u0000-\u0020\u007f~^:?*\[\]\\]/.test(value);
}

function isCanonicalTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function writeJson(path: string, value: unknown): void {
  writeTextFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonRecord(path: string, location: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw migrationError(`${location} is not valid JSON`);
  }
  if (!isRecord(value)) throw migrationError(`${location} must be a JSON object`);
  return value;
}

function directoryNames(path: string): string[] {
  return directoryEntries(path)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function jsonRecordNames(path: string): string[] {
  return directoryEntries(path)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort((left, right) => left.localeCompare(right));
}

function directoryEntries(path: string): DirectoryEntry[] {
  try {
    return readdirSync(path, { withFileTypes: true, encoding: "utf8" }) as DirectoryEntry[];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function withoutSchemaVersion(
  value: RoleProfile & { schemaVersion: 1; name: string }
): RoleProfile & { name: string } {
  const { schemaVersion: _schemaVersion, ...profile } = value;
  return profile;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRoleStatus(value: unknown): value is TaskRole["status"] {
  return value === "idle" || value === "running" || value === "detached" ||
    value === "exited" || value === "failed";
}

function migrationError(detail: string): ReturnType<typeof dataError> {
  return dataError(
    `TaskMux storage schema v3-to-v4 migration cannot continue: ${detail}. ` +
    "No TaskMux storage changes were committed."
  );
}
