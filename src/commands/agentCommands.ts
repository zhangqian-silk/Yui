import { isDeepStrictEqual } from "node:util";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import { isAgentAdapterId, supportedAgentAdapterIds } from "../agent/adapterCatalog.js";
import {
  createConfiguredAgent,
  validateConfiguredAgent,
  type ConfiguredAgent as ConfiguredAgentRecord,
  type EnvironmentBinding
} from "../agent/agent.js";
import {
  adapterIdForExecutionComponent,
  agentExecutionComponentLabel,
  defaultExecutionComponentForAdapter,
  isAgentExecutionComponentId,
  supportedAgentExecutionComponentIds,
  type AgentExecutionComponentId
} from "../agent/executionComponents.js";
import type {
  MailboxTarget,
  WorkMailbox
} from "../coordination/workMailbox.js";
import { agentNotFound, usageError } from "../errors/cliError.js";
import type {
  GlobalRoleSessionSet,
  TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { AgentProfile } from "../profile/agentProfile.js";
import type { GlobalRole, TaskRole } from "../role/role.js";
import {
  hasRuntimeLifecycleWork,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import { LIVE_SESSION_ACKNOWLEDGEMENT_OPTION } from "./roleRuntimeGuard.js";

export type { ConfiguredAgentRecord, EnvironmentBinding };

export type ConfiguredAgentPatch = Readonly<{
  adapterId?: AgentAdapterId;
  component?: AgentExecutionComponentId;
  command?: string;
  baseArgs?: readonly string[];
  environment?: readonly EnvironmentBinding[];
}>;

export type AgentCommandTransactionStore = Readonly<{
  createConfiguredAgentIfAbsent(agent: ConfiguredAgentRecord): ConfiguredAgentRecord | null;
  updateConfiguredAgent(
    id: string,
    patch: ConfiguredAgentPatch,
    now: Date
  ): Readonly<{ status: "updated" | "unchanged"; agent: ConfiguredAgentRecord }> | null;
  listConfiguredAgents(): ConfiguredAgentRecord[];
  getConfiguredAgent(id: string): ConfiguredAgentRecord | null;
  removeConfiguredAgent(id: string): boolean;
  listAgentProfiles(): AgentProfile[];
  getConfig(): Readonly<{ defaultAgent?: string; defaultWorkspace?: string }>;
  listGlobalRoles(): GlobalRole[];
  listGlobalRoleSessionSets(): GlobalRoleSessionSet[];
  listTasks(): ReadonlyArray<Readonly<{ id: string }>>;
  listRoles(taskId: string): TaskRole[];
  listRoleSessionSets(taskId: string): TaskRoleSessionSet[];
  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
}>;

export type AgentCommandStore = AgentCommandTransactionStore & Readonly<{
  transaction<T>(execute: (store: AgentCommandTransactionStore) => T): T;
}>;

export function runAgentCommand(args: string[], store: AgentCommandStore): string {
  const [command, ...rest] = args;
  switch (command) {
    case "add": return addAgent(rest, store);
    case "list": return listAgents(rest, store);
    case "show": return showAgent(rest, store);
    case "update": return updateAgent(rest, store);
    case "remove": return removeAgent(rest, store);
    default:
      throw usageError(command === undefined
        ? "Agent command is required."
        : `Unknown command: config agent ${command}`);
  }
}

function addAgent(args: string[], store: AgentCommandStore): string {
  const [rawId, ...tail] = args;
  const id = agentId(rawId);
  const parsed = parseAgentOptions(tail, "add");
  const component = parsed.one("--component")?.trim();
  if (component !== undefined) assertComponent(component);
  // Naming the component is enough: it determines its own connection plan, so
  // there is one fact to state rather than a pair that could contradict.
  const adapterId = parsed.one("--adapter")
    ?? (component === undefined ? undefined : adapterIdForExecutionComponent(component))
    ?? (isAgentAdapterId(id) ? id : undefined);
  if (adapterId === undefined) {
    throw usageError("--component or --adapter is required.");
  }
  assertAdapter(adapterId);
  const command = parsed.one("--command")?.trim();
  if (command === undefined || command.length === 0) throw usageError("--command is required.");
  let agent: ConfiguredAgentRecord;
  try {
    agent = createConfiguredAgent(
      id,
      adapterId,
      command,
      parsed.many("--arg"),
      parsed.many("--env").map(parseEnvironmentBinding),
      new Date(),
      component
    );
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const created = store.createConfiguredAgentIfAbsent(agent);
  if (created === null) {
    throw usageError(`Agent already exists: ${id}. Use yui config agent update to change it.`);
  }
  return renderAgent(`Added agent ${id}`, created);
}

function listAgents(args: string[], store: AgentCommandStore): string {
  assertNoArguments(args, "Agent list usage: yui config agent list");
  const agents = store.listConfiguredAgents();
  if (agents.length === 0) return "No agents configured.\n";
  return `${renderTable(
    "Agents",
    [
      { header: "Agent", minWidth: 5, maxWidth: 24 },
      { header: "Component", minWidth: 9, maxWidth: 20 },
      { header: "Adapter", minWidth: 7, maxWidth: 12 },
      { header: "Command", minWidth: 7, maxWidth: 48 },
      { header: "Environment", minWidth: 11, maxWidth: 32 }
    ],
    agents.map((agent) => [
      agent.id,
      agent.component,
      agent.adapterId,
      [agent.command, ...agent.baseArgs].join(" "),
      agent.environment.map((binding) => `${binding.target}<-${binding.sourceName}`).join(", ")
    ]),
    defaultTableWidth()
  )}\n`;
}

function showAgent(args: string[], store: AgentCommandStore): string {
  const [rawId, ...rest] = args;
  const id = agentId(rawId);
  assertNoArguments(rest, "Agent show usage: yui config agent show <agent-id>");
  const agent = store.getConfiguredAgent(id);
  if (agent === null) throw agentNotFound(id);
  return renderAgent(`Agent: ${id}`, agent);
}

function updateAgent(args: string[], store: AgentCommandStore): string {
  const [rawId, ...tail] = args;
  const id = agentId(rawId);
  const parsed = parseAgentOptions(tail, "update");
  if (parsed.seen.size === 0
    || [...parsed.seen].every((option) => option === LIVE_SESSION_ACKNOWLEDGEMENT_OPTION)) {
    throw usageError("Agent update requires at least one operational option.");
  }
  if (parsed.has("--arg") && parsed.has("--clear-args")) {
    throw usageError("--arg and --clear-args cannot be used together.");
  }
  if (parsed.has("--env") && parsed.has("--clear-env")) {
    throw usageError("--env and --clear-env cannot be used together.");
  }
  const adapterId = parsed.one("--adapter")?.trim();
  if (adapterId !== undefined) assertAdapter(adapterId);
  const component = parsed.one("--component")?.trim();
  if (component !== undefined) assertComponent(component);
  if (component !== undefined && adapterId !== undefined
    && adapterIdForExecutionComponent(component) !== adapterId) {
    throw usageError(
      `Agent execution component ${component} is reached over the `
      + `${adapterIdForExecutionComponent(component)} connection plan, not ${adapterId}. `
      + "Pass --component alone to move the Agent onto its own plan."
    );
  }
  const command = parsed.one("--command")?.trim();
  if (command !== undefined && command.length === 0) throw usageError("--command is required.");
  const requestedPatch: ConfiguredAgentPatch = {
    ...(adapterId === undefined ? {} : { adapterId }),
    // Changing the component can move the Agent onto its plan, which is the one
    // way the two stay consistent without asking the operator to restate both.
    ...(component === undefined
      ? {}
      : { component, adapterId: adapterIdForExecutionComponent(component) }),
    ...(command === undefined ? {} : { command }),
    ...(parsed.has("--arg")
      ? { baseArgs: parsed.many("--arg") }
      : parsed.has("--clear-args") ? { baseArgs: [] } : {}),
    ...(parsed.has("--env")
      ? { environment: parsed.many("--env").map(parseEnvironmentBinding) }
      : parsed.has("--clear-env") ? { environment: [] } : {})
  };
  const now = new Date();
  const result = store.transaction((tx) => {
    const existing = tx.getConfiguredAgent(id);
    if (existing === null) return null;
    // Derive a default only when actually leaving the stored plan. Restating
    // the same plan must preserve an explicitly identified ACP component.
    const patch: ConfiguredAgentPatch = {
      ...requestedPatch,
      ...(component === undefined && adapterId !== undefined && adapterId !== existing.adapterId
        ? { component: defaultExecutionComponentForAdapter(adapterId) }
        : {})
    };
    const changes = actualAgentChanges(existing, patch);
    if (!changes.operational) {
      return { status: "unchanged" as const, agent: existing };
    }
    const lifecycle = findRuntimeLifecycleReference(tx, id);
    if (lifecycle !== null) {
      throw usageError(
        `Agent ${id} cannot be updated because ${describeReference(lifecycle)} `
        + "has pending runtime lifecycle launch or cleanup work. "
        + "Wait for lifecycle reconciliation to finish before changing Agent launch settings."
      );
    }
    const liveSession = findNonStoppedSessionReference(tx, id);
    if (liveSession !== null && !parsed.has(LIVE_SESSION_ACKNOWLEDGEMENT_OPTION)) {
      throw usageError(
        `${describeReference(liveSession)} runs a live native session (${liveSession.status}) on `
        + `Agent ${id}, so this change applies to its next Host process instead of the `
        + "running one.\n"
        + `Re-run with ${LIVE_SESSION_ACKNOWLEDGEMENT_OPTION} to record the change and keep that `
        + "session.\n"
        + "Stop the affected Role session first to apply it to a fresh session instead."
      );
    }
    // A component change is refused on a referenced Agent for the same reason
    // an adapter change is, and the reason is not symmetry: the product identity
    // is copied into Role bindings and frozen into every Session snapshot at
    // launch. Rewriting only the Agent leaves those copies asserting the old
    // product while the new command runs, so a Session resumes against one
    // product under another's name. Rewriting the copies instead would relabel
    // history that really did run the old product. Neither is correctable here,
    // so the change is refused and the operator binds a new Agent explicitly —
    // which leaves existing Sessions pinned to what they actually ran.
    const identityChange = changes.adapter
      ? { axis: "adapter", target: "adapter" }
      : changes.component ? { axis: "execution component", target: "component" } : null;
    if (identityChange !== null) {
      const profile = findAgentProfileReference(tx, id);
      if (profile !== null) {
        throw usageError(
          `Agent ${id} ${identityChange.axis} cannot change because Agent Profile `
          + `${profile.id} references it. `
          + "Update that explicit Profile or create a new Agent ID instead."
        );
      }
      const binding = findRoleBindingReference(tx, id);
      if (binding !== null) {
        throw usageError(
          `Agent ${id} ${identityChange.axis} cannot change because `
          + `${describeReference(binding)} references it. `
          + `Create a new Agent ID with the target ${identityChange.target} and bind the Role `
          + "to it instead."
        );
      }
    }
    assertValidAgentCandidate(existing, patch, now);
    return tx.updateConfiguredAgent(id, patch, now);
  });
  if (result === null) throw agentNotFound(id);
  return result.status === "unchanged"
    ? `Agent ${id} unchanged\n`
    : renderAgent(`Updated agent ${id}`, result.agent);
}

function removeAgent(args: string[], store: AgentCommandStore): string {
  const [rawId, ...rest] = args;
  const id = agentId(rawId);
  assertNoArguments(rest, "Agent remove usage: yui config agent remove <agent-id>");
  const removed = store.transaction((tx) => {
    if (tx.getConfiguredAgent(id) === null) return false;
    if (tx.getConfig().defaultAgent === id) {
      throw usageError(
        `Agent ${id} cannot be removed because config.defaultAgent references it. `
        + "Set another default Agent first."
      );
    }
    const lifecycle = findRuntimeLifecycleReference(tx, id);
    if (lifecycle !== null) {
      throw usageError(
        `Agent ${id} cannot be removed because ${describeReference(lifecycle)} `
        + "has pending runtime lifecycle launch or cleanup work. "
        + "Wait for lifecycle reconciliation to finish first."
      );
    }
    const binding = findRoleBindingReference(tx, id);
    if (binding !== null) {
      throw usageError(
        `Agent ${id} cannot be removed because ${describeReference(binding)} references it. `
        + "Migrate or remove that Role binding before removing this Agent."
      );
    }
    const profile = findAgentProfileReference(tx, id);
    if (profile !== null) {
      throw usageError(
        `Agent ${id} cannot be removed because Agent Profile ${profile.id} references it. `
        + "Update, inherit, or remove that Profile first."
      );
    }
    const session = findNonStoppedSessionReference(tx, id);
    if (session !== null) {
      throw usageError(
        `Agent ${id} cannot be removed because ${describeReference(session)} `
        + `retains a native session (${session.status}). Stop that Role session first.`
      );
    }
    return tx.removeConfiguredAgent(id);
  });
  if (!removed) throw agentNotFound(id);
  return `Removed agent ${id}\n`;
}

type ActualAgentChanges = Readonly<{
  /**
   * The connection plan changed. Naming a component on another plan reports as
   * an adapter change too, because that is what it is: the stored Role bindings
   * hold plan-shaped configuration that the new plan cannot accept.
   */
  adapter: boolean;
  /** The product changed while staying on the same plan; new Sessions only. */
  component: boolean;
  operational: boolean;
}>;

function actualAgentChanges(
  existing: ConfiguredAgentRecord,
  patch: ConfiguredAgentPatch
): ActualAgentChanges {
  const adapter = patch.adapterId !== undefined && patch.adapterId !== existing.adapterId;
  const component = patch.component !== undefined && patch.component !== existing.component;
  const operational = adapter
    || component
    || (patch.command !== undefined && patch.command !== existing.command)
    || (patch.baseArgs !== undefined && !isDeepStrictEqual(patch.baseArgs, existing.baseArgs))
    || (patch.environment !== undefined
      && !isDeepStrictEqual(patch.environment, existing.environment));
  return { adapter, component, operational };
}

function assertValidAgentCandidate(
  existing: ConfiguredAgentRecord,
  patch: ConfiguredAgentPatch,
  now: Date
): void {
  try {
    validateConfiguredAgent({
      ...existing,
      ...structuredClone(patch),
      updatedAt: now.toISOString()
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

type RoleReference = Readonly<{
  scope: "global" | "task";
  roleName: string;
  taskId?: string;
}>;

type SessionReference = RoleReference & Readonly<{ status: string }>;

function findRuntimeLifecycleReference(
  store: AgentCommandTransactionStore,
  agentId: string
): RoleReference | null {
  for (const role of store.listGlobalRoles()) {
    if (
      role.activeAgentId === agentId
      && hasRuntimeLifecycleWork(store.getWorkMailbox(runtimeLifecycleTarget({
        scope: "global",
        roleName: role.name
      })))
    ) {
      return { scope: "global", roleName: role.name };
    }
  }
  for (const task of store.listTasks()) {
    for (const role of store.listRoles(task.id)) {
      if (
        role.activeAgentId === agentId
        && hasRuntimeLifecycleWork(store.getWorkMailbox(runtimeLifecycleTarget({
          scope: "task",
          taskId: task.id,
          roleName: role.name
        })))
      ) {
        return { scope: "task", taskId: task.id, roleName: role.name };
      }
    }
  }
  return null;
}

function findRoleBindingReference(
  store: AgentCommandTransactionStore,
  agentId: string
): RoleReference | null {
  for (const role of store.listGlobalRoles()) {
    if (Object.hasOwn(role.agentBindings, agentId)) {
      return { scope: "global", roleName: role.name };
    }
  }
  for (const task of store.listTasks()) {
    for (const role of store.listRoles(task.id)) {
      if (Object.hasOwn(role.agentBindings, agentId)) {
        return { scope: "task", taskId: task.id, roleName: role.name };
      }
    }
  }
  return null;
}

function findAgentProfileReference(
  store: AgentCommandTransactionStore,
  agentId: string
): AgentProfile | null {
  return store.listAgentProfiles().find((profile) =>
    profile.runtime.source === "explicit" && profile.runtime.agentId === agentId
  ) ?? null;
}

function findNonStoppedSessionReference(
  store: AgentCommandTransactionStore,
  agentId: string
): SessionReference | null {
  for (const set of store.listGlobalRoleSessionSets()) {
    const reference = sessionReference(
      set,
      agentId,
      { scope: "global", roleName: set.owner.roleName }
    );
    if (reference !== null) return reference;
  }
  for (const task of store.listTasks()) {
    for (const set of store.listRoleSessionSets(task.id)) {
      const reference = sessionReference(
        set,
        agentId,
        { scope: "task", taskId: task.id, roleName: set.owner.roleName }
      );
      if (reference !== null) return reference;
    }
  }
  return null;
}

function sessionReference(
  set: GlobalRoleSessionSet | TaskRoleSessionSet,
  agentId: string,
  reference: RoleReference
): SessionReference | null {
  const session = set.sessions[agentId];
  if (session === undefined || session.status === "ended") return null;
  return { ...reference, status: session.status };
}

function describeReference(reference: RoleReference): string {
  return reference.scope === "global"
    ? `Global Role ${reference.roleName}`
    : `Task ${reference.taskId ?? "?"} Role ${reference.roleName}`;
}

type ParsedOptions = Readonly<{
  seen: ReadonlySet<string>;
  has(option: string): boolean;
  one(option: string): string | undefined;
  many(option: string): string[];
}>;

function parseAgentOptions(args: string[], mode: "add" | "update"): ParsedOptions {
  const valueOptions = new Map([
    ["--adapter", { repeatable: false, allowOptionLikeValue: false }],
    ["--component", { repeatable: false, allowOptionLikeValue: false }],
    ["--command", { repeatable: false, allowOptionLikeValue: false }],
    ["--arg", { repeatable: true, allowOptionLikeValue: true }],
    ["--env", { repeatable: true, allowOptionLikeValue: false }]
  ]);
  const flags = mode === "update"
    ? new Set(["--clear-args", "--clear-env", LIVE_SESSION_ACKNOWLEDGEMENT_OPTION])
    : new Set<string>();
  const seen = new Set<string>();
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (flags.has(option)) {
      if (seen.has(option)) throw usageError(`Option may only be specified once: ${option}`);
      seen.add(option);
      continue;
    }
    const spec = valueOptions.get(option);
    if (spec === undefined) {
      throw usageError(option.startsWith("--")
        ? `Unsupported option: ${option}`
        : `Unexpected argument: ${option}`);
    }
    if (!spec.repeatable && seen.has(option)) {
      throw usageError(`Option may only be specified once: ${option}`);
    }
    const value = args[index + 1];
    if (value === undefined || (!spec.allowOptionLikeValue && value.startsWith("--"))) {
      throw usageError(`${option} is required.`);
    }
    seen.add(option);
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

function parseEnvironmentBinding(value: string): EnvironmentBinding {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw usageError("--env must use TARGET=PROCESS_NAME.");
  }
  const target = value.slice(0, separator).trim();
  const sourceName = value.slice(separator + 1).trim();
  if (!environmentName(target) || !environmentName(sourceName)) {
    throw usageError("--env must use valid environment names: TARGET=PROCESS_NAME.");
  }
  return { target, source: "process", sourceName, required: true };
}

function environmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function agentId(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9_-]+$/.test(value.trim())) {
    throw usageError(value === undefined || value.trim().length === 0
      ? "Agent id is required."
      : "Agent id may only contain letters, numbers, hyphens, and underscores.");
  }
  return value.trim();
}

function assertAdapter(value: string): asserts value is AgentAdapterId {
  if (!isAgentAdapterId(value)) {
    throw usageError(`Agent adapter is not supported: ${value}. Supported adapters: ${supportedAgentAdapterIds().join(", ")}.`);
  }
}

function assertComponent(value: string): asserts value is AgentExecutionComponentId {
  if (!isAgentExecutionComponentId(value)) {
    throw usageError(
      `Agent execution component is not supported: ${value}. Supported components: `
      + `${supportedAgentExecutionComponentIds().join(", ")}.`
    );
  }
}

function assertNoArguments(args: string[], message: string): void {
  if (args.length > 0) throw usageError(`${message}. Unexpected argument: ${args[0]}`);
}

function renderAgent(title: string, agent: ConfiguredAgentRecord): string {
  return [
    title,
    `Component: ${agent.component} (${agentExecutionComponentLabel(agent.component)})`,
    `Adapter: ${agent.adapterId}`,
    `Executable: ${agent.command}`,
    `Arguments: ${agent.baseArgs.join(" ")}`,
    `Environment bindings: ${agent.environment.length}`,
    ...agent.environment.map((binding) =>
      `  ${binding.target} <- process:${binding.sourceName} (${binding.required ? "required" : "optional"})`)
  ].join("\n").concat("\n");
}
