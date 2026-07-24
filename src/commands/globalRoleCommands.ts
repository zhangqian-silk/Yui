import { roleNotFound, usageError } from "../errors/cliError.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession,
  type GlobalRoleSessionSet
} from "../executor/agentExecutor.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { activeRoleSummary, renderRoleDetails } from "../output/rolePresentation.js";
import {
  activeRoleAgentBinding,
  createGlobalRole,
  createRoleAgentBinding,
  switchActiveRoleAgent,
  unbindRoleAgent,
  updateGlobalRole,
  type GlobalRole
} from "../role/role.js";
import {
  isSystemRoleName,
  SYSTEM_ROLE_NAMES,
  systemRoleDescription
} from "../role/systemRoles.js";
import type {
  AgentCommandTransactionStore,
  ConfiguredAgentRecord
} from "./agentCommands.js";
import {
  hasAgentConfigOptions,
  parseRoleOptions,
  patchRoleAgentBinding,
  roleOptionSpecs,
  roleProfileFrom,
  roleProfilePatch
} from "./roleConfiguration.js";
import {
  hasRoleLaunchContextOptions,
  validateConfiguredRoleSkills
} from "./roleSkillValidation.js";
import {
  assertRoleRuntimeMutationAllowed,
  type RoleRuntimeGuardStore
} from "./roleRuntimeGuard.js";

type GlobalRoleTransactionStore = AgentCommandTransactionStore & RoleRuntimeGuardStore & Readonly<{
  getConfig(): Readonly<{ defaultWorkspace?: string }>;
  createGlobalRoleIfAbsent(role: GlobalRole): GlobalRole | null;
  listGlobalRoles(): GlobalRole[];
  getGlobalRole(name: string): GlobalRole | null;
  saveGlobalRole(role: GlobalRole): void;
  saveGlobalRoleWithSessionSet(role: GlobalRole, sessionSet: GlobalRoleSessionSet | null): void;
  removeGlobalRole(name: string): boolean;
  getGlobalRoleSessionSet(name: string): GlobalRoleSessionSet | null;
  saveGlobalRoleSessionSet(sessionSet: GlobalRoleSessionSet): void;
}>;

type GlobalRoleStore = GlobalRoleTransactionStore & Readonly<{
  transaction<T>(execute: (store: GlobalRoleTransactionStore) => T): T;
}>;

export type GlobalRoleCommandOptions = Readonly<{
  yuiHome?: string;
  env?: NodeJS.ProcessEnv;
}>;

export type GlobalRoleEnterControl = Readonly<{
  kind: "enter";
  role: GlobalRole;
}>;

export type GlobalRoleCommandResult = string | GlobalRoleEnterControl;

export function runGlobalRoleCommand(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions = {}
): GlobalRoleCommandResult {
  const [command, ...rest] = args;
  switch (command) {
    case "add": return addRole(rest, store, options);
    case "list": return listRoles(rest, store);
    case "show": return showRole(rest, store);
    case "update": return updateRole(rest, store, options);
    case "remove": return removeRole(rest, store);
    case "bind": return bindRole(rest, store);
    case "unbind": return unbindRole(rest, store);
    case "enter": return enterRole(rest, store);
    case "session": return roleSession(rest, store, options);
    default:
      throw usageError(command === undefined
        ? "Role command is required."
        : `Unknown command: role ${command}`);
  }
}

function addRole(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions
): string {
  const [rawName, ...tail] = args;
  const name = roleName(rawName);
  const parsed = parseRoleOptions(tail, roleOptionSpecs({
    update: false, includeAgent: true, includeWorkspace: true
  }));
  const agentId = required(parsed.one("--agent"), "--agent");
  if (parsed.has("--workspace") && trimmed(parsed.one("--workspace")) === undefined) {
    throw usageError("--workspace is required.");
  }
  const now = new Date();
  const created = store.transaction((tx) => {
    assertRoleRuntimeMutationAllowed(tx, { scope: "global", roleName: name }, "creation");
    const agent = requireAgent(agentId, tx);
    const workspace = trimmed(parsed.one("--workspace"))
      ?? tx.getConfig().defaultWorkspace
      ?? process.cwd();
    const binding = patchRoleAgentBinding(createRoleAgentBinding(definition(agent)), parsed);
    const profile = roleProfileFrom(parsed);
    validateConfiguredRoleSkills(options.yuiHome, profile.skills ?? []);
    const role = createGlobalRole(
      name, [binding], agent.id, workspace, now, profile
    );
    const result = tx.createGlobalRoleIfAbsent(role);
    if (result === null) throw usageError(`Role already exists: ${name}.`);
    return result;
  });
  return presentRole(`Added role ${name}`, created, store);
}

function listRoles(args: string[], store: GlobalRoleStore): string {
  assertNoArguments(args, "Role list usage: yui role list");
  const rows = new Map<string, [string, string, string, string, string, string]>();
  for (const name of SYSTEM_ROLE_NAMES) {
    const role = store.getGlobalRole(name);
    rows.set(name, role === null
      ? [name, "system", "?", "?", "?", "?"]
      : roleListRow(role, "system"));
  }
  for (const role of store.listGlobalRoles()) {
    if (!rows.has(role.name)) {
      rows.set(role.name, roleListRow(role, "global"));
    }
  }
  if (rows.size === 0) return "No roles configured.\n";
  return `${renderTable(
    "Roles",
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Kind", minWidth: 6, maxWidth: 8 },
      { header: "Active Agent", minWidth: 8, maxWidth: 20 },
      { header: "Model", minWidth: 8, maxWidth: 22 },
      { header: "Effort", minWidth: 8, maxWidth: 14 },
      { header: "Workspace", minWidth: 9, maxWidth: 54 }
    ],
    [...rows.values()].sort((left, right) => left[0].localeCompare(right[0])),
    defaultTableWidth()
  )}\n`;
}

function showRole(args: string[], store: GlobalRoleStore): string {
  const [rawName, ...rest] = args;
  const name = roleName(rawName);
  assertNoArguments(rest, "Role show usage: yui role show <role>");
  const role = store.getGlobalRole(name);
  if (role === null) {
    if (isSystemRoleName(name)) return renderMissingSystemRole(name);
    throw roleNotFound(name);
  }
  return renderRoleDetails(`Role: ${name}`, role, {
    kind: isSystemRoleName(name) ? "system" : "global",
    sessions: store.getGlobalRoleSessionSet(name)
  });
}

function updateRole(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions
): string {
  const [rawName, ...tail] = args;
  const name = roleName(rawName);
  const parsed = parseRoleOptions(tail, roleOptionSpecs({
    update: true, includeAgent: true, includeWorkspace: true
  }));
  if (parsed.has("--agent") && trimmed(parsed.one("--agent")) === undefined) {
    throw usageError("--agent is required.");
  }
  if (parsed.has("--workspace") && trimmed(parsed.one("--workspace")) === undefined) {
    throw usageError("--workspace is required.");
  }
  if ([...parsed.seen].every((option) => option === "--agent")) {
    throw usageError("At least one role update option is required.");
  }
  const workspace = trimmed(parsed.one("--workspace"));
  const next = store.transaction((tx) => {
    const role = requireRole(name, tx);
    const sessions = tx.getGlobalRoleSessionSet(name);
    const changesLaunchContext = hasRoleLaunchContextOptions(parsed);
    const changesAgentConfig = hasAgentConfigOptions(parsed);
    if (changesLaunchContext || changesAgentConfig) {
      assertRoleRuntimeMutationAllowed(tx, {
        scope: "global",
        roleName: role.name
      }, "launch configuration update");
    }
    if (
      changesLaunchContext
      && Object.values(sessions?.sessions ?? {}).some(({ status }) => status !== "stopped")
    ) {
      throw usageError("Role launch context cannot be changed while its native process is running.");
    }
    let bindings = role.agentBindings;
    if (changesAgentConfig) {
      const agentId = parsed.one("--agent")?.trim() || role.activeAgentId;
      const agent = requireAgent(agentId, tx);
      const binding = role.agentBindings[agentId] ?? createRoleAgentBinding(definition(agent));
      const targetSession = sessions?.sessions[agentId];
      if (
        targetSession !== undefined
        && targetSession.status !== "stopped"
      ) {
        throw usageError("Agent settings cannot be changed while its native process is running.");
      }
      bindings = { ...role.agentBindings, [agentId]: patchRoleAgentBinding(binding, parsed) };
    }
    const updated = updateGlobalRole(role, {
      ...(workspace === undefined ? {} : { workspace }),
      ...(bindings === role.agentBindings ? {} : { agentBindings: bindings }),
      ...roleProfilePatch(parsed)
    }, new Date());
    if (changesLaunchContext) {
      validateConfiguredRoleSkills(options.yuiHome, updated.skills ?? []);
    }
    tx.saveGlobalRole(updated);
    return updated;
  });
  return renderRoleDetails(`Updated role ${name}`, next, {
    kind: isSystemRoleName(name) ? "system" : "global",
    sessions: store.getGlobalRoleSessionSet(name)
  });
}

function bindRole(args: string[], store: GlobalRoleStore): string {
  const [rawName, rawAgentId, ...rest] = args;
  const name = roleName(rawName);
  const agentId = required(rawAgentId, "Agent id");
  assertNoArguments(rest, "Role bind usage: yui role bind <role> <agent-id>");
  const now = new Date();
  const result = store.transaction((tx) => {
    const role = requireRole(name, tx);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "global",
      roleName: role.name
    }, "Agent binding");
    const agent = requireAgent(agentId, tx);
    const binding = role.agentBindings[agentId] ?? createRoleAgentBinding(definition(agent));
    const withBinding = updateGlobalRole(role, {
      agentBindings: { ...role.agentBindings, [agentId]: binding }
    }, now);
    if (agentId === role.activeAgentId) {
      tx.saveGlobalRole(withBinding);
      return {
        message: `Role ${name} already bound to ${agentId}`,
        role: withBinding
      };
    }
    const existingSet = tx.getGlobalRoleSessionSet(name);
    const activeSession = existingSet?.sessions[role.activeAgentId];
    try {
      const switched = switchActiveRoleAgent(
        withBinding,
        existingSet ?? createRoleSessionSet(
          { scope: "global", roleName: name },
          role.activeAgentId,
          now
        ),
        agentId,
        {
          activeRun: false,
          nativeProcessRunning: activeSession !== undefined
            && activeSession.status !== "stopped"
        },
        now
      );
      tx.saveGlobalRoleWithSessionSet(switched.role, switched.sessions);
      return { message: `Bound role ${name} to ${agentId}`, role: switched.role };
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
  });
  return presentRole(result.message, result.role, store);
}

function removeRole(args: string[], store: GlobalRoleStore): string {
  const [rawName, ...rest] = args;
  const name = roleName(rawName);
  assertNoArguments(rest, "Role remove usage: yui role remove <role>");
  if (isSystemRoleName(name)) throw usageError(`System role cannot be removed: ${name}`);
  store.transaction((tx) => {
    const role = requireRole(name, tx);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "global",
      roleName: role.name
    }, "removal");
    const sessions = tx.getGlobalRoleSessionSet(name);
    if (Object.values(sessions?.sessions ?? {}).some(({ status }) => status !== "stopped")) {
      throw usageError(`GlobalRole is active and cannot be removed: ${name}.`);
    }
    if (!tx.removeGlobalRole(name)) throw roleNotFound(name);
  });
  return `Removed role ${name}\n`;
}

function unbindRole(args: string[], store: GlobalRoleStore): string {
  const [rawName, rawAgentId, ...rest] = args;
  const name = roleName(rawName);
  const agentId = required(rawAgentId, "Agent id");
  assertNoArguments(rest, "Role unbind usage: yui role unbind <role> <agent-id>");
  store.transaction((tx) => {
    const role = requireRole(name, tx);
    try {
      const result = unbindRoleAgent(
        role,
        tx.getGlobalRoleSessionSet(name),
        agentId,
        new Date()
      );
      tx.saveGlobalRoleWithSessionSet(result.role, result.sessions);
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
  });
  return `Unbound Agent ${agentId} from role ${name}\n`;
}

function enterRole(
  args: string[],
  store: GlobalRoleStore
): GlobalRoleEnterControl {
  const [rawName, ...rest] = args;
  const name = roleName(rawName);
  assertNoArguments(rest, "Role enter usage: yui role enter <role>");
  const role = requireRole(name, store);
  return { kind: "enter", role };
}

function roleSession(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions
): string {
  const [command, rawName, ...tail] = args;
  if (command !== "record" && command !== "replace") {
    throw usageError("Role session usage: yui role session record|replace <role> --native-id <id> [--reason <reason>].");
  }
  const name = roleName(rawName);
  const parsed = parseOptions(tail, new Map<string, OptionKind>([
    ["--native-id", false],
    ...(command === "replace" ? [["--reason", false] as const] : [])
  ]));
  const nativeSessionId = required(parsed.one("--native-id"), "--native-id");
  if (nativeSessionId.trim() !== nativeSessionId || nativeSessionId.length === 0) {
    throw usageError("Native session id must not contain surrounding whitespace.");
  }
  const environment = options.env ?? process.env;
  return store.transaction((tx) => {
    const role = requireRole(name, tx);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "global",
      roleName: role.name
    }, "manual native session update");
    const binding = activeRoleAgentBinding(role);
    requireAgent(binding.agentId, tx);
    assertSessionProvenance(command, role, nativeSessionId, environment);
    const now = new Date();
    const set = tx.getGlobalRoleSessionSet(name)
      ?? createRoleSessionSet({ scope: "global", roleName: name }, role.activeAgentId, now);
    const existing = set.sessions[role.activeAgentId] ?? null;
    const input = {
      agentId: binding.agentId,
      adapterId: binding.adapterId,
      nativeSessionId,
      policy: "fixed" as const,
      status: environment.YUI_ROLE === name ? "running" as const : "ready" as const
    };
    if (command === "record") {
      if (existing !== null && existing.nativeSessionId !== nativeSessionId) {
        throw usageError("GlobalRole session replacement must be explicit.");
      }
      tx.saveGlobalRoleSessionSet(recordRoleAgentSession(set, input, now));
      return `Recorded native session for role ${name}\n`;
    }
    if (existing === null) {
      throw usageError("Native session replacement requires an existing native session.");
    }
    if (existing.status !== "stopped") {
      throw usageError("Native session replacement is blocked while the native Agent process is running.");
    }
    if (existing.nativeSessionId === nativeSessionId) {
      throw usageError("Native session replacement requires a different native session identity.");
    }
    required(parsed.one("--reason"), "--reason");
    tx.saveGlobalRoleSessionSet(recordRoleAgentSession(set, input, now));
    return `Replaced native session for role ${name}\n`;
  });
}

function assertSessionProvenance(
  command: "record" | "replace",
  role: GlobalRole,
  nativeSessionId: string,
  environment: NodeJS.ProcessEnv
): void {
  const values = [
    environment.YUI_ROLE,
    environment.YUI_AGENT_ID,
    environment.YUI_ADAPTER_ID
  ];
  if (values.every((value) => value === undefined)) return;
  if (values.some((value) => value === undefined || value.trim().length === 0)) {
    throw usageError("Native session registration provenance is incomplete.");
  }
  if (command !== "record") {
    throw usageError("A running Agent may record only its current native session.");
  }
  const binding = activeRoleAgentBinding(role);
  if (
    environment.YUI_ROLE !== role.name
    || environment.YUI_AGENT_ID !== binding.agentId
    || environment.YUI_ADAPTER_ID !== binding.adapterId
  ) {
    throw usageError("Native session registration does not match the active GlobalRole binding.");
  }
  if (binding.adapterId === "codex" && environment.CODEX_THREAD_ID?.trim() !== nativeSessionId) {
    throw usageError("Native session id does not match CODEX_THREAD_ID.");
  }
}

type OptionKind = boolean | "flag";
type Parsed = Readonly<{
  seen: ReadonlySet<string>;
  has(option: string): boolean;
  one(option: string): string | undefined;
  many(option: string): string[];
}>;

function parseOptions(args: string[], specs: ReadonlyMap<string, OptionKind>): Parsed {
  const values = new Map<string, string[]>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const kind = specs.get(option);
    if (kind === undefined) {
      throw usageError(option.startsWith("--")
        ? `Unsupported option: ${option}`
        : `Unexpected argument: ${option}`);
    }
    const repeatable = kind === true;
    if (!repeatable && seen.has(option)) {
      throw usageError(`Option may only be specified once: ${option}`);
    }
    seen.add(option);
    if (kind === "flag") continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw usageError(`${option} is required.`);
    values.set(option, [...(values.get(option) ?? []), value]);
    index += 1;
  }
  return {
    seen,
    has: (option) => seen.has(option),
    one: (option) => values.get(option)?.[0],
    many: (option) => [...(values.get(option) ?? [])]
  };
}

function definition(agent: ConfiguredAgentRecord) {
  return { ...agent, baseArgs: [...agent.baseArgs], environment: [...agent.environment], source: "custom" as const };
}

function requireAgent(id: string, store: GlobalRoleTransactionStore): ConfiguredAgentRecord {
  const agent = store.getConfiguredAgent(id);
  if (agent === null) throw usageError(`Unsupported agent: ${id}`);
  return agent;
}

function requireRole(name: string, store: GlobalRoleTransactionStore): GlobalRole {
  const role = store.getGlobalRole(name);
  if (role === null) throw roleNotFound(name);
  return role;
}

function roleName(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) throw usageError("Role name is required.");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw usageError("Role name may only contain letters, numbers, hyphens, and underscores.");
  }
  return value.trim();
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) throw usageError(`${label} is required.`);
  return value.trim();
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result === undefined || result.length === 0 ? undefined : result;
}

function assertNoArguments(args: string[], message: string): void {
  if (args.length > 0) throw usageError(`${message}. Unexpected argument: ${args[0]}`);
}

function presentRole(title: string, role: GlobalRole, store: GlobalRoleStore): string {
  return renderRoleDetails(title, role, {
    kind: isSystemRoleName(role.name) ? "system" : "global",
    sessions: store.getGlobalRoleSessionSet(role.name)
  });
}

function roleListRow(
  role: GlobalRole,
  kind: "system" | "global"
): [string, string, string, string, string, string] {
  const summary = activeRoleSummary(role);
  return [role.name, kind, summary.agent, summary.model, summary.effort, role.workspace];
}

function renderMissingSystemRole(name: string): string {
  return [
    `Role: ${name}`,
    `System: ${systemRoleDescription(name)}`,
    "Active agent: ?",
    "Workspace: ?"
  ].join("\n").concat("\n");
}
