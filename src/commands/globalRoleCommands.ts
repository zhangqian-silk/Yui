import { roleNotFound, usageError } from "../errors/cliError.js";
import { controlProviderRetry, providerRetryProjection, renderProviderRetry } from "../runtime/providerRetry.js";
import { settleGlobalRetryInput } from "../message/globalProviderRetry.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession,
  type GlobalRoleSessionSet
} from "../executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../executor/effectiveLaunch.js";
import { managedGlobalRoleWorkspace } from "../storage/homeLayout.js";
import {
  createGlobalRoleMessage,
  claimGlobalRoleMessageInterruptThen,
  type GlobalRoleMessage,
  type GlobalRoleMessageKind,
  type GlobalRoleMessageAuthor,
  type TaskMessageInputAction
} from "../message/message.js";
import {
  resolveGlobalInputControl,
  type InputControlResolution,
  type ResolvedInputTarget
} from "../message/inputControlResolution.js";
import { readCommandText } from "./textInput.js";
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
  hasNoRoleMutation,
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
  assertLiveRoleSessionAcknowledged,
  assertRoleRuntimeMutationAllowed,
  LIVE_SESSION_ACKNOWLEDGEMENT_OPTION,
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
  nextGlobalRoleMessageId(): string;
  saveGlobalRoleMessage(message: GlobalRoleMessage): void;
  updateGlobalRoleMessage(message: GlobalRoleMessage): void;
  listGlobalRoleMessages(roleName: string): GlobalRoleMessage[];
}>;

type GlobalRoleStore = GlobalRoleTransactionStore & Readonly<{
  transaction<T>(execute: (store: GlobalRoleTransactionStore) => T): T;
}>;

export type GlobalInputFailure = Readonly<{ code: string; detail: string; data: unknown }>;

export type GlobalRoleCommandOptions = Readonly<{
  yuiHome?: string;
  env?: NodeJS.ProcessEnv;
  jsonOutput?: boolean;
  onInputFailure?: (failure: GlobalInputFailure) => void;
}>;

export type GlobalRoleEnterControl = Readonly<{
  kind: "enter";
  role: GlobalRole;
}>;

/**
 * A resolved live steer against a Global Role's exact current native Turn. The
 * durable Global Message is already persisted and the target, capability, and
 * writer fence proven from durable state (decision-3 §9); the CLI performs the
 * one Agent Host steer call with scope "global" and never re-decides target or
 * fallback. The controlled Host supplies the exact native binding.
 */
export type GlobalRoleInputSteer = Readonly<{
  kind: "input-steer";
  roleName: string;
  messageId: string;
  target: ResolvedInputTarget;
  receiptId: string;
  text: string;
  output: string;
}>;

/**
 * A resolved live interrupt of a Global Role's exact current native Turn,
 * delivered only through the Provider's native cancel (never kill/restart/
 * detach). A bare interrupt persists no Message; an explicit `--then-message`
 * names an already-persisted durable Global Message to deliver once after a
 * proven terminal (decision-3 §4), the ordered composition, not a fourth action.
 */
export type GlobalRoleInputInterrupt = Readonly<{
  kind: "input-interrupt";
  roleName: string;
  target: ResolvedInputTarget;
  receiptId: string;
  thenMessageId?: string;
  output: string;
}>;

export type GlobalRoleCommandResult =
  | string
  | GlobalRoleEnterControl
  | GlobalRoleInputSteer
  | GlobalRoleInputInterrupt;

export function runGlobalRoleCommand(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions = {}
): GlobalRoleCommandResult {
  const [command, ...rest] = args;
  if (command === "message" || command === "interrupt" || command === "session" && rest[0] === "retry") {
    const env = options.env ?? process.env;
    const target = command === "message" || command === "session" ? rest[1] : rest[0];
    if (env.YUI_SESSION_SCOPE !== undefined && env.YUI_SESSION_SCOPE !== "global"
      || env.YUI_SESSION_SCOPE === "global" && env.YUI_ROLE !== "operator"
        && env.YUI_ROLE !== target) {
      throw usageError("Global input mutation is outside the exact Session authority.");
    }
    if (env.YUI_SESSION_SCOPE === "global") {
      const caller = store.getGlobalRoleSessionSet(env.YUI_ROLE ?? "");
      const session = caller?.sessions[caller.activeAgentId];
      if (session === undefined || session.status !== "active" || env.YUI_AGENT_ID !== session.agentId
        || env.YUI_ADAPTER_ID !== session.adapterId
        || (env.CODEX_THREAD_ID ?? env.YUI_NATIVE_SESSION_ID) !== session.nativeSessionId) {
        throw usageError("Global input mutation requires the current native caller Session.");
      }
    } else if (env.YUI_ROLE !== undefined || env.YUI_AGENT_ID !== undefined
      || env.YUI_NATIVE_SESSION_ID !== undefined) {
      throw usageError("Incomplete managed identity cannot acquire user authority.");
    }
  }
  switch (command) {
    case "add": return addRole(rest, store, options);
    case "list": return listRoles(rest, store);
    case "show": return showRole(rest, store);
    case "context": return roleContext(rest, store, options);
    case "update": return updateRole(rest, store, options);
    case "remove": return removeRole(rest, store);
    case "bind": return bindRole(rest, store);
    case "unbind": return unbindRole(rest, store);
    case "enter": return enterRole(rest, store);
    case "session": return roleSession(rest, store, options);
    case "message": return globalRoleMessage(rest, store, options);
    case "interrupt": return globalRoleInterrupt(rest, store, options);
    default:
      throw usageError(command === undefined
        ? "Role command is required."
        : `Unknown command: config role ${command}`);
  }
}

function roleContext(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions
): string {
  const [rawName, ...rest] = args;
  const name = roleName(rawName);
  assertNoArguments(rest, "Session context usage: yui session context <role>");
  const environment = options.env ?? process.env;
  // Context reads expose durable input and runtime facts without delivering it.
  const selfRead = environment.YUI_SESSION_SCOPE !== undefined;
  if (selfRead) {
    if (environment.YUI_SESSION_SCOPE !== "global" || environment.YUI_ROLE !== name) {
      throw usageError("Managed GlobalRole context is outside the exact Session authority.");
    }
    if (environment.YUI_SESSION_MANIFEST === undefined) {
      throw usageError("Managed GlobalRole context requires its Session Manifest.");
    }
  }
  const role = requireRole(name, store);
  const binding = activeRoleAgentBinding(role);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const sessions = store.getGlobalRoleSessionSet(name);
  const session = sessions?.sessions[role.activeAgentId];
  // Only the controlled Endpoint's accepted receipt consumes a queued Message.
  const queued = store.listGlobalRoleMessages(name).filter((message) => message.delivery === undefined
        && message.notDelivered === undefined
        && (message.interruptThen !== undefined || message.inputControl?.action === "queue"));
  const pendingQueue = queued.map((message) => ({
    id: message.id,
    requestId: message.interruptThen?.requestId ?? message.inputControl?.requestId,
    body: message.body,
    ...(message.control === undefined ? {} : { control: message.control }),
    ...(message.deliveryTarget === undefined ? {} : { deliveryTarget: message.deliveryTarget }),
    ...(message.interruptThen === undefined ? {} : { interruptThen: true }),
    ...(message.delivery === undefined ? {} : { deliveredAt: message.delivery.deliveredAt })
  }));
  const context = Object.freeze({
    schemaVersion: 1,
    protocol: "yui-managed-context/v1",
    identity: {
      scope: "global",
      roleName: role.name,
      roleKind: role.name === "operator" ? "operator" : "global",
      agentId: binding.agentId,
      adapterId: binding.adapterId,
      workspace: role.workspace,
      effectiveRevision: role.launchRevision,
      ...(session?.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: session.nativeSessionId })
    },
    profile: {
      description: role.description,
      responsibilities: role.responsibilities ?? [],
      constraints: role.constraints ?? [],
      expectedOutput: role.expectedOutput,
      skillIds: [
        "yui-runtime",
        ...(role.name === "operator" ? ["yui-operator"] : []),
        ...(role.skills ?? [])
      ]
    },
    authority: {
      view: role.name === "operator" ? "operator" : "global",
      taskImplementation: false,
      writableProjectIds: effective.writeProjectIds,
      allowedActions: role.name === "operator"
        ? ["route-request", "inspect-catalog", "answer-user-boundary"]
        : ["perform-global-role-request"]
    },
    // Reading pending input is neither delivery nor implementation.
    pendingMessages: pendingQueue,
    messages: store.listGlobalRoleMessages(name),
    nativeTurn: sessions?.providerBinding?.run ?? null,
    retry: providerRetryProjection(sessions?.providerBinding),
    interrupts: sessions?.interrupts ?? {},
    sessionManifestPath: environment.YUI_SESSION_MANIFEST,
    cliCommand: "yui"
  });
  if (options.jsonOutput === true) return `${JSON.stringify(context)}\n`;
  return [
    `Role Context: ${role.name}`,
    `Scope: global (${context.identity.roleKind})`,
    `Agent: ${binding.agentId}/${binding.adapterId}`,
    `Workspace: ${role.workspace}`,
    `Effective revision: ${role.launchRevision}`,
    `Skills: ${context.profile.skillIds.join(", ") || "none"}`,
    `Authority: ${context.authority.view}; Task implementation: no`,
    `Pending messages: ${pendingQueue.length === 0 ? "none"
      : pendingQueue.map((message) => message.id).join(", ")}`,
    ""
  ].join("\n");
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
    // An explicit --workspace is a user-chosen cwd and keeps its own semantics
    // (external roots stay external). When none is given, default to a
    // Home-internal Global Role working directory rather than the external
    // `defaultWorkspace` or the ambient process.cwd(), so Yui-auto-created
    // scratch never lands outside the canonical Home.
    const explicitWorkspace = trimmed(parsed.one("--workspace"));
    const workspace = explicitWorkspace
      ?? (options.yuiHome !== undefined
        ? managedGlobalRoleWorkspace(options.yuiHome)
        : tx.getConfig().defaultWorkspace ?? process.cwd());
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
  assertNoArguments(args, "Role list usage: yui config role list");
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
  assertNoArguments(rest, "Role show usage: yui config role show <role>");
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
  if (hasNoRoleMutation(parsed)) {
    throw usageError("At least one role update option is required.");
  }
  const workspace = trimmed(parsed.one("--workspace"));
  const next = store.transaction((tx) => {
    const role = requireRole(name, tx);
    const changesLaunchContext = hasRoleLaunchContextOptions(parsed);
    const changesAgentConfig = hasAgentConfigOptions(parsed);
    if (changesLaunchContext || changesAgentConfig) {
      assertRoleRuntimeMutationAllowed(tx, {
        scope: "global",
        roleName: role.name
      }, "desired launch configuration update");
      assertLiveRoleSessionAcknowledged({
        sessions: tx.getGlobalRoleSessionSet(role.name),
        roleName: role.name,
        desiredRevision: role.launchRevision,
        acknowledged: parsed.has(LIVE_SESSION_ACKNOWLEDGEMENT_OPTION),
        stopCommand: "yui session stop --all",
        endsSession: workspace !== undefined && workspace !== role.workspace
      });
    }
    let bindings = role.agentBindings;
    if (changesAgentConfig) {
      const agentId = parsed.one("--agent")?.trim() || role.activeAgentId;
      const agent = requireAgent(agentId, tx);
      const binding = role.agentBindings[agentId] ?? createRoleAgentBinding(definition(agent));
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
  assertNoArguments(rest, "Role bind usage: yui config role bind <role> <agent-id>");
  const now = new Date();
  const result = store.transaction((tx) => {
    const role = requireRole(name, tx);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "global",
      roleName: role.name
    }, "desired Agent binding update");
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
    const activeSession = existingSet?.sessions[existingSet.activeAgentId];
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
            && activeSession.status === "active"
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
  assertNoArguments(rest, "Role remove usage: yui config role remove <role>");
  if (isSystemRoleName(name)) throw usageError(`System role cannot be removed: ${name}`);
  store.transaction((tx) => {
    const role = requireRole(name, tx);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "global",
      roleName: role.name
    }, "removal");
    const sessions = tx.getGlobalRoleSessionSet(name);
    if (Object.values(sessions?.sessions ?? {}).some(({ status }) => status === "active")) {
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
  assertNoArguments(rest, "Role unbind usage: yui config role unbind <role> <agent-id>");
  store.transaction((tx) => {
    const role = requireRole(name, tx);
    const profileId = profileUsingWorkerBinding(tx, role, agentId);
    if (profileId !== null) {
      throw usageError(
        `Agent ${agentId} cannot be unbound from Global Role worker because Agent Profile `
        + `${profileId} derives non-model settings from that binding. `
        + "Update, inherit, or remove that Profile first."
      );
    }
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

function profileUsingWorkerBinding(
  store: GlobalRoleTransactionStore,
  role: GlobalRole,
  agentId: string
): string | null {
  if (role.name !== "worker") return null;
  if (!Object.hasOwn(role.agentBindings, agentId)) return null;
  if (agentId === role.activeAgentId) return null;
  const profile = store.listAgentProfiles().find((candidate) => (
    candidate.runtime.source === "explicit"
    && candidate.runtime.agentId === agentId
  ));
  return profile?.id ?? null;
}

function enterRole(
  args: string[],
  store: GlobalRoleStore
): GlobalRoleEnterControl {
  const [rawName, ...rest] = args;
  const name = roleName(rawName);
  assertNoArguments(rest, "Role enter usage: yui session enter <role>");
  const role = requireRole(name, store);
  return { kind: "enter", role };
}

function roleSession(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions
): string {
  const [command, rawName, ...tail] = args;
  if (command === "retry") {
    const name = roleName(rawName);
    const [action = "show", ...extra] = tail;
    if (extra.length > 0 || !["show", "cancel", "disable", "enable"].includes(action)) {
      throw usageError("Usage: yui session retry <role> [show|cancel|disable|enable]");
    }
    return store.transaction(tx => {
      requireRole(name, tx);
      const sessions = tx.getGlobalRoleSessionSet(name);
      let binding = sessions?.providerBinding ?? null;
      if (action !== "show") {
        if (sessions === null || binding === null) throw usageError("No current Provider Session.");
        binding = controlProviderRetry(binding, action as "cancel" | "disable" | "enable", Date.now());
        tx.saveGlobalRoleSessionSet({ ...sessions, providerBinding: binding });
        settleGlobalRetryInput(tx, name, binding, new Date());
      }
      return options.jsonOutput ? JSON.stringify({
        roleName: name, retry: providerRetryProjection(binding), disabled: binding?.retryDisabled ?? false
      }) + "\n" : renderProviderRetry(binding) + "\n";
    });
  }
  if (command !== "record" && command !== "replace") {
    throw usageError("Session usage: yui session record|replace <role> --native-id <id> [--reason <reason>].");
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
      status: "active" as const,
      effective: resolveEffectiveLaunch({ role, purpose: "execution" })
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
    if (existing.status !== "ended") {
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

/**
 * The shared application-layer primitive for a durable Global Role input
 * (decision-3 §7: CLI and Web/API share one entry, not per-surface fallbacks).
 * It persists the Global-owned Message with an explicit owner (the Role name)
 * and a stable requestId, idempotent exactly like a Task input: an exact repeat
 * of the same requestId returns the original Message, and any different body,
 * action, or expectedTarget under the same id is a conflicting reuse, never a
 * silent second input (decision-3 §6). It never fabricates a Task or a native
 * Turn; it only records intent.
 */
export function sendGlobalRoleMessageCommand(
  store: GlobalRoleTransactionStore,
  roleName: string,
  body: string,
  author: GlobalRoleMessageAuthor,
  inputControl: Readonly<{ action: TaskMessageInputAction; requestId: string; expectedTarget?: string }>,
  now: Date
): Readonly<{ message: GlobalRoleMessage; idempotentReplay: boolean }> {
  if (!body.trim()) throw usageError("Message body is required.");
  const existing = store.listGlobalRoleMessages(roleName).find(
    (entry) => (entry.inputControl ?? entry.interruptThen?.reusedInput)?.requestId === inputControl.requestId);
  if (existing !== undefined) {
    const original = existing.inputControl ?? existing.interruptThen?.reusedInput;
    if (original?.action !== inputControl.action
      || existing.body !== body
      || original.expectedTarget !== inputControl.expectedTarget) {
      throw usageError(
        `Input requestId ${inputControl.requestId} was already used with different content or target; use a new requestId for a new input.`);
    }
    return { message: existing, idempotentReplay: true };
  }
  const kind: GlobalRoleMessageKind = author.type;
  let message = createGlobalRoleMessage(
    store.nextGlobalRoleMessageId(), roleName, body, kind, author, now, { inputControl });
  const sessions = store.getGlobalRoleSessionSet(roleName);
  const session = sessions?.sessions[sessions.activeAgentId];
  if (session !== undefined) message = { ...message,
    deliveryTarget: { agentId: session.agentId, nativeSessionId: session.nativeSessionId } };
  store.saveGlobalRoleMessage(message);
  return { message, idempotentReplay: false };
}

/**
 * `yui role message queue|steer <role> ...` — the durable Global input actions.
 * `queue` persists and returns queued (delivered at the Role's next legal
 * execution opportunity by the existing global-role-runtime mailbox, never a new
 * private queue). `steer` persists then resolves the exact current native Turn
 * from durable state; on a ready resolution it returns a structured live intent
 * the CLI performs against the Agent Host with scope "global", and on any
 * explicit failure it returns the saved Message plus the exact code and never
 * falls back to interrupt or queue (decision-3 §1/§5).
 */
function globalRoleMessage(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions
): GlobalRoleCommandResult {
  const [action, rawName, ...tail] = args;
  if (action !== "queue" && action !== "steer") {
    throw usageError("Role message usage: yui role message queue|steer <role> (<body>|--body-file <path|->) --request-id <id> [--expected-target <turn>].");
  }
  const usage = action === "queue"
    ? "Role message queue usage: yui role message queue <role> (<body>|--body-file <path|->) --request-id <id>."
    : "Role message steer usage: yui role message steer <role> (<body>|--body-file <path|->) --request-id <id> --expected-target <turn>.";
  const name = roleName(rawName);
  // A leading positional before the flags is the inline body; the rest are flags.
  const positionalBody = tail.length > 0 && !tail[0].startsWith("--") ? tail[0] : undefined;
  const flags = positionalBody === undefined ? tail : tail.slice(1);
  const parsed = parseOptions(flags, new Map<string, OptionKind>([
    ["--body-file", false],
    ["--request-id", false],
    ...(action === "steer" ? [["--expected-target", false] as const] : [])
  ]));
  const body = readCommandText(positionalBody, parsed.one("--body-file"), "--body", usage);
  const requestId = required(parsed.one("--request-id"), "--request-id");
  const expectedTarget = action === "steer"
    ? required(parsed.one("--expected-target"), "--expected-target")
    : undefined;
  const now = new Date();
  // The durable Global input is authored as an operator input: a Global Role has
  // no Task Leader, and the operator is the human authority over Global Roles.
  const environment = options.env ?? process.env;
  const author: GlobalRoleMessageAuthor = { type: environment.YUI_SESSION_SCOPE === "global"
    ? environment.YUI_ROLE === "operator" ? "operator" : "agent" : "user" };
  const persisted = store.transaction((tx) => {
    requireRole(name, tx);
    return sendGlobalRoleMessageCommand(tx, name, body,
      author, { action, requestId, ...(expectedTarget === undefined ? {} : { expectedTarget }) }, now);
  });
  if (action === "queue") {
    const state = persisted.idempotentReplay ? "idempotent-replay" : "queued";
    return jsonOrText(options, `Queued Global message ${persisted.message.id} to ${name} (${state}).\n`,
      { roleName: name, message: persisted.message, delivery: { state } });
  }
  if (persisted.idempotentReplay) {
    return jsonOrText(options, `Steer Global message ${persisted.message.id} already recorded (idempotent-replay).\n`,
      { roleName: name, message: persisted.message, steer: { state: "idempotent-replay" } });
  }
  const resolution = resolveGlobalInputControl(store, name, "steer", expectedTarget!);
  if (resolution.outcome !== "ready") {
    return jsonOrText(options,
      `Steer Global message ${persisted.message.id} saved but not delivered (${resolution.code}: ${resolution.detail}).\n`,
      { roleName: name, message: persisted.message,
        steer: { state: "not-steered", code: resolution.code, detail: resolution.detail } });
  }
  store.updateGlobalRoleMessage({ ...persisted.message, control: {
    requestId, receiptId: `steer:${name}/${persisted.message.id}`,
    outcome: "pending", observedAt: now.toISOString()
  } });
  return {
    kind: "input-steer",
    roleName: name,
    messageId: persisted.message.id,
    target: resolution.target,
    receiptId: `steer:${name}/${persisted.message.id}`,
    text: body,
    output: `Steering ${name} at Turn ${resolution.target.nativeTurnId ?? resolution.target.attemptId} with message ${persisted.message.id}.\n`
  };
}

/**
 * `yui role interrupt <role> --expected-target <turn> [--then-message <ref>]` —
 * a live interrupt of a Global Role's exact current native Turn. A bare
 * interrupt persists no Message (it is pure control); a `--then-message` names
 * an already-persisted durable Global Message to deliver once after a proven
 * terminal — the ordered composition of interrupt and an existing queue, not a
 * fourth action and not an auto-fallback (decision-3 §4).
 */
function globalRoleInterrupt(
  args: string[],
  store: GlobalRoleStore,
  options: GlobalRoleCommandOptions
): GlobalRoleCommandResult {
  const usage = "Role interrupt usage: yui role interrupt <role> --expected-target <turn> [--then-message <global-message-id>] [--request-id <id>].";
  const [rawName, ...tail] = args;
  const name = roleName(rawName);
  const parsed = parseOptions(tail, new Map<string, OptionKind>([
    ["--expected-target", false],
    ["--then-message", false],
    ["--request-id", false]
  ]));
  const expectedTarget = required(parsed.one("--expected-target"), "--expected-target");
  const thenMessageId = trimmed(parsed.one("--then-message"));
  const requestId = trimmed(parsed.one("--request-id")) ?? `cancel:${encodeURIComponent(expectedTarget)}`;
  const fingerprint = JSON.stringify({ expectedTarget, thenMessageId });
  const prior = store.getGlobalRoleSessionSet(name)?.interrupts?.[requestId];
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) throw usageError("Interrupt requestId already names another control.");
    return jsonOrText(options, `Interrupt ${requestId} already recorded; no native control repeated.\n`,
      { roleName: name, interrupt: prior.receipt ?? { state: "interrupt-unknown" }, idempotentReplay: true });
  }
  const resolved = store.transaction((tx): InputControlResolution | Readonly<{
    outcome: "then-conflict"; code: "TARGET_CHANGED"; detail: string }> => {
    requireRole(name, tx);
    const resolution = resolveGlobalInputControl(tx, name, "interrupt", expectedTarget);
    if (resolution.outcome !== "ready") return resolution;
    const sessions = tx.getGlobalRoleSessionSet(name)!;
    if (Object.values(sessions.interrupts ?? {}).some(entry =>
      entry.attemptId === resolution.target.attemptId
      && entry.nativeSessionId === resolution.target.nativeSessionId
      && !(entry.receipt?.state === "interrupt-unavailable" && entry.receipt.outcome === "rejected"))) {
      return { outcome: "then-conflict", code: "TARGET_CHANGED",
        detail: "This exact native Turn already has a recorded cancel request; inspect it instead of repeating the control." };
    }
    // decision-3 §4: before the live cancel, register the continuation claim on
    // the already-persisted durable Global Message in one short transaction, so
    // the handoff relationship, its target Turn, and its stable requestId are
    // durable independent of the cancel outcome. An explicit then-Message must be
    // an already-persisted durable Global Message owned by this exact Role; it is
    // never created here and never a Task record (decision-3 §4/§9).
    if (thenMessageId !== undefined) {
      const claim = registerGlobalInterruptThen(
        tx, name, thenMessageId, resolution.target.attemptId,
        resolution.target.nativeTurnId, requestId, resolution.target);
      if (claim !== "claimed") return { outcome: "then-conflict", ...claim };
    }
    tx.saveGlobalRoleSessionSet({ ...sessions, interrupts: { ...sessions.interrupts,
      [requestId]: { fingerprint, attemptId: resolution.target.attemptId,
        nativeSessionId: resolution.target.nativeSessionId,
        receiptId: `interrupt:${name}/${requestId}` }
    } });
    return resolution;
  });
  if (resolved.outcome === "then-conflict") {
    return jsonOrText(options,
      `Interrupt not delivered (${resolved.code}: ${resolved.detail}).\n`,
      { roleName: name, interrupt: { state: "not-interrupted", code: resolved.code, detail: resolved.detail } });
  }
  if (resolved.outcome !== "ready") {
    return jsonOrText(options,
      `Interrupt not delivered (${resolved.code}: ${resolved.detail}).\n`,
      { roleName: name, interrupt: { state: "not-interrupted", code: resolved.code, detail: resolved.detail } });
  }
  return {
    kind: "input-interrupt",
    roleName: name,
    target: resolved.target,
    receiptId: `interrupt:${name}/${requestId}`,
    ...(thenMessageId === undefined ? {} : { thenMessageId }),
    output: `Interrupting ${name} at Turn ${resolved.target.nativeTurnId ?? resolved.target.attemptId}`
      + `${thenMessageId === undefined ? "" : `, then delivering ${thenMessageId} once after a proven terminal`}.\n`
  };
}

/**
 * Bind a saved durable Global Message as the single interrupt-then continuation
 * of an exact interrupted native Turn (decision-3 §4). The Global twin of the
 * Task `registerInterruptThen`: a Global Role has no AgentRun, so the
 * target is proven by the exact native Turn's attemptId under the Role's own
 * writer fence, never by a fabricated Task Run. Idempotent per interrupt
 * requestId; only one continuation may claim a given target Turn; a Message that
 * was already delivered or already claims another target is refused, never
 * silently dropped or duplicated.
 */
function registerGlobalInterruptThen(
  store: GlobalRoleTransactionStore, roleName: string, thenMessageId: string,
  targetAttemptId: string, targetNativeTurnId: string | undefined,
  requestId: string | undefined,
  target: ResolvedInputTarget
): "claimed" | Readonly<{ code: "TARGET_CHANGED"; detail: string }> {
  const message = store.listGlobalRoleMessages(roleName).find((entry) => entry.id === thenMessageId);
  if (message === undefined) {
    throw usageError(`Then-Message ${thenMessageId} is not a durable Global Message owned by ${roleName}.`);
  }
  if (message.notDelivered !== undefined) {
    return { code: "TARGET_CHANGED", detail: `The saved input is already settled not-delivered (${message.notDelivered.reason}).` };
  }
  if (message.control !== undefined && message.control.outcome !== "rejected") {
    return { code: "TARGET_CHANGED", detail: "The saved input is already accepted or its delivery remains unconfirmed." };
  }
  if (message.deliveryTarget !== undefined
    && (message.deliveryTarget.nativeSessionId !== target.nativeSessionId
      || message.deliveryTarget.agentId !== target.agentId)) {
    return { code: "TARGET_CHANGED", detail: "The saved input belongs to another native Session." };
  }
  // A synthesized fallback id is an opaque idempotency key (compared only for
  // equality, never parsed), so it must satisfy the same safe-identity rule as a
  // caller-supplied requestId: no path separators. Use `:` as the field joiner —
  // the receiptId carries the `/`-shaped human receipt, this key stays slash-free.
  const claimRequestId = requestId ?? `interrupt:${roleName}:${encodeURIComponent(targetAttemptId)}`;
  // Idempotent per interrupt requestId: an exact repeat of the same claim is a
  // no-op that still authorizes the live cancel.
  if (message.interruptThen !== undefined) {
    const claim = message.interruptThen;
    const prior = store.getGlobalRoleSessionSet(roleName)?.interrupts?.[claim.requestId];
    const canReferenceClaim = claim.requestId === claimRequestId
      || (prior?.receipt?.state === "interrupt-unavailable" && prior.receipt.outcome === "rejected");
    if (canReferenceClaim && message.delivery === undefined && message.notDelivered === undefined
      && claim.targetAttemptId === targetAttemptId
      && claim.targetAgentId === target.agentId && claim.targetNativeSessionId === target.nativeSessionId
      && claim.targetAuthorityEpoch === target.authority.epoch
      && claim.targetAuthorityHolderId === target.authority.holderId) return "claimed";
    return { code: "TARGET_CHANGED",
      detail: `Message ${thenMessageId} already claims a continuation of Turn ${message.interruptThen.targetAttemptId}.` };
  }
  // A Message that already delivered is a settled fact, not a fresh input to
  // reuse; reusing it would replay a consumed queue entry.
  if (message.delivery !== undefined) {
    return { code: "TARGET_CHANGED",
      detail: `Message ${thenMessageId} was already delivered at ${message.delivery.deliveredAt}.` };
  }
  // Only one continuation may claim a given target Turn.
  const existing = store.listGlobalRoleMessages(roleName).find((entry) =>
    entry.interruptThen?.targetAttemptId === targetAttemptId && entry.id !== message.id);
  if (existing !== undefined) {
    return { code: "TARGET_CHANGED",
      detail: `Turn ${targetAttemptId} is already the terminal target of Message ${existing.id}.` };
  }
  store.updateGlobalRoleMessage(
    claimGlobalRoleMessageInterruptThen(message, {
      requestId: claimRequestId, targetAttemptId,
      targetNativeSessionId: target.nativeSessionId, targetAgentId: target.agentId,
      targetAuthorityEpoch: target.authority.epoch,
      targetAuthorityHolderId: target.authority.holderId,
      ...(targetNativeTurnId === undefined ? {} : { targetNativeTurnId })
    }));
  return "claimed";
}

/** Emit a plain string or, under --json, a JSON envelope, matching the Global
 * Role command surface's existing string/JSON split. */
function jsonOrText(
  options: GlobalRoleCommandOptions,
  text: string,
  data: unknown
): string {
  const record = data as { steer?: { code?: string; detail?: string }; interrupt?: { code?: string; detail?: string } };
  const failure = record.steer?.code === undefined ? record.interrupt : record.steer;
  if (failure?.code !== undefined) options.onInputFailure?.({
    code: failure.code, detail: failure.detail ?? failure.code, data
  });
  return options.jsonOutput === true ? JSON.stringify(data) : text;
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
