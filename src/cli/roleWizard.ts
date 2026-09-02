import { renderTable, type TableColumn } from "../output/table.js";
import type {
  AgentConfigurationCatalog,
  ResolvedAgentConfigurationCatalog
} from "../executor/agentConfigurationCatalog.js";
import {
  selectAgentEffort,
  selectAgentModelAndEffort
} from "./agentConfigurationPicker.js";
import type { SelectionIo } from "./interactiveSelection.js";
import type { SelectionPorts } from "./selectionPorts.js";

export type RoleWizardResolution =
  | Readonly<{ kind: "unchanged"; args: string[] }>
  | Readonly<{ kind: "resolved"; args: string[] }>
  | Readonly<{ kind: "cancelled"; args: string[] }>;

type Entity = Readonly<Record<string, unknown>>;
type AgentChoice = Readonly<{ id: string; adapterId: string }>;
type AgentSelection = Readonly<{
  agents: readonly AgentChoice[];
  defaultAgent?: string;
}>;
type RoleBinding = Readonly<{
  agentId: string;
  adapterId: string;
  config: Entity;
}>;
type RoleView = Readonly<{
  name: string;
  activeAgentId: string;
  agentBindings: Readonly<Record<string, RoleBinding>>;
  workspace?: string;
  description?: string;
  responsibilities?: readonly string[];
  constraints?: readonly string[];
  expectedOutput?: string;
  systemPrompt?: string;
}>;

type Choice = Readonly<{ value: string; cells: readonly string[] }>;

const TEXT_COLUMN: TableColumn = { header: "Selection", minWidth: 12, maxWidth: 34 };

export async function resolveRoleWizardArguments(
  commandArgs: readonly string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const args = [...commandArgs];
  if (!io.interactive || io.json) return { kind: "unchanged", args };

  if (isGlobalRoleAdd(args)) {
    return addGlobalRole(args, ports, io);
  }
  if (isTaskRoleAdd(args)) {
    return addTaskRole(args, ports, io);
  }
  if (isGlobalRoleUpdate(args)) {
    return updateGlobalRole(args, ports, io);
  }
  if (isTaskRoleUpdate(args)) {
    return updateTaskRole(args, ports, io);
  }
  return { kind: "unchanged", args };
}

export async function resolveGlobalRoleAgentConfigurationArguments(
  roleName: string,
  agentId: string,
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const args = ["config", "role", "update", roleName];
  if (!io.interactive || io.json) return { kind: "unchanged", args };
  const role = asRole(await ports.call("role.show", { name: roleName }));
  const binding = role?.agentBindings[agentId];
  if (role === undefined || binding === undefined) {
    return { kind: "cancelled", args };
  }
  return updateAgentBindingSettings(args, role, binding, ports, io);
}

function isGlobalRoleAdd(args: readonly string[]): boolean {
  return args[0] === "config" && args[1] === "role" && args[2] === "add";
}

function isTaskRoleAdd(args: readonly string[]): boolean {
  return args[0] === "task" && args[1] === "role" && args[2] === "add";
}

// Explicit update options always win. This keeps scripts and deliberate
// non-interactive invocations out of the wizard even when run from a TTY.
function isGlobalRoleUpdate(args: readonly string[]): boolean {
  return args.length === 4 && args[0] === "config" && args[1] === "role"
    && args[2] === "update" && isValue(args[3]);
}

function isTaskRoleUpdate(args: readonly string[]): boolean {
  return args.length === 5 && args[0] === "task" && args[1] === "role"
    && args[2] === "update" && isValue(args[3]) && isValue(args[4]);
}

async function addGlobalRole(
  args: string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const named = await ensureRoleName(args, 3, io);
  if (named === undefined) return { kind: "cancelled", args };
  const explicitSettings = hasExplicitAddSettings(named, 4);

  const agents = await loadAgentSelection(ports);
  const explicitAgent = optionValue(named, "--agent");
  const selected = explicitAgent ?? await selectConfiguredAgent(
    ports,
    io,
    "Create Global Role from Agent",
    agents
  );
  if (selected === undefined) return { kind: "cancelled", args: named };
  const withAgent = explicitAgent === undefined
    ? [...named, "--agent", selected]
    : named;
  if (explicitSettings) return { kind: "resolved", args: withAgent };
  const agent = agents.agents.find((candidate) => candidate.id === selected);
  return agent === undefined
    ? { kind: "resolved", args: withAgent }
    : configureRoleCreation(withAgent, agent, ports, io, false);
}

async function addTaskRole(
  args: string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const withTask = await ensureTask(args, ports, io);
  if (withTask === undefined) return { kind: "cancelled", args };
  const named = await ensureRoleName(withTask, 4, io);
  if (named === undefined) return { kind: "cancelled", args: withTask };
  if (hasExplicitAddSettings(named, 5)) return { kind: "resolved", args: named };

  const [workerRoleValue, agents] = await Promise.all([
    Promise.resolve(ports.call("role.show", { name: "worker" })),
    loadAgentSelection(ports)
  ]);
  const workerRole = asRole(workerRoleValue);
  const explicitAgent = optionValue(named, "--agent");
  if (workerRole !== undefined && explicitAgent === undefined) {
    const source = await choose(
      "Create Task Role from",
      [
        {
          value: "copy",
          cells: ["Copy Global Worker", `Active Agent: ${workerRole.activeAgentId}`]
        },
        {
          value: "agent",
          cells: ["Create from Agent", `Default Agent: ${agents.defaultAgent ?? "none"}`]
        }
      ],
      [TEXT_COLUMN, { header: "Details", minWidth: 18, maxWidth: 42 }],
      io,
      "copy",
      "source"
    );
    if (source === undefined) return { kind: "cancelled", args: named };
    if (source === "copy") return { kind: "resolved", args: named };
  }

  const selected = explicitAgent ?? await selectConfiguredAgent(
    ports, io, "Create Task Role from Agent", agents
  );
  if (selected === undefined) return { kind: "cancelled", args: named };
  const withAgent = explicitAgent === undefined
    ? [...named, "--agent", selected]
    : named;
  const agent = agents.agents.find((candidate) => candidate.id === selected);
  return agent === undefined
    ? { kind: "resolved", args: withAgent }
    : configureRoleCreation(withAgent, agent, ports, io, true);
}

async function ensureTask(
  args: string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<string[] | undefined> {
  if (isValue(args[3])) return args;
  const value = await ports.call("task.list", {});
  const tasks = Array.isArray(value) ? value.flatMap((candidate): Choice[] => {
    const input = entity(candidate);
    const id = stringField(input, "id");
    if (id === undefined) return [];
    return [{
      value: id,
      cells: [id, stringField(input, "title") ?? "", stringField(input, "status") ?? ""]
    }];
  }) : [];
  const selected = await choose(
    "Select Task",
    tasks,
    [
      { header: "Task", minWidth: 5, maxWidth: 24 },
      { header: "Title", minWidth: 8, maxWidth: 42 },
      { header: "Status", minWidth: 6, maxWidth: 12 }
    ],
    io,
    tasks[0]?.value,
    "Task"
  );
  if (selected === undefined) return undefined;
  const resolved = [...args];
  resolved.splice(3, 0, selected);
  return resolved;
}

async function ensureRoleName(
  args: string[],
  index: number,
  io: SelectionIo
): Promise<string[] | undefined> {
  if (isValue(args[index])) return args;
  const name = (await io.question("Role name: "))?.trim();
  if (name === undefined || name.length === 0) return undefined;
  const resolved = [...args];
  resolved.splice(index, 0, name);
  return resolved;
}

async function configureRoleCreation(
  args: string[],
  agent: AgentChoice,
  ports: SelectionPorts,
  io: SelectionIo,
  taskRole: boolean
): Promise<RoleWizardResolution> {
  const mode = await choose(
    "Create Role",
    [
      { value: "defaults", cells: ["Create with CLI defaults", "No Agent overrides"] },
      { value: "configure", cells: ["Configure Role", "Set one Role or Agent field"] }
    ],
    [TEXT_COLUMN, { header: "Result", minWidth: 18, maxWidth: 40 }],
    io,
    "defaults",
    "creation mode"
  );
  if (mode === undefined) return { kind: "cancelled", args };
  if (mode === "defaults") return { kind: "resolved", args };

  const section = await settingsSection("Configure Role", io, taskRole);
  if (section === undefined) return { kind: "cancelled", args };
  return section === "role"
    ? configureNewRoleField(args, agent, ports, io, taskRole)
    : configureNewAgentField(args, agent, ports, io);
}

async function configureNewRoleField(
  args: string[],
  agent: AgentChoice,
  ports: SelectionPorts,
  io: SelectionIo,
  taskRole: boolean
): Promise<RoleWizardResolution> {
  const field = await choose(
    "Role settings",
    [
      { value: "description", cells: ["Description"] },
      { value: "responsibilities", cells: ["Responsibilities"] },
      { value: "constraints", cells: ["Constraints"] },
      { value: "expected-output", cells: ["Expected output"] },
      { value: "system-prompt", cells: ["System prompt"] },
      { value: "active-agent", cells: ["Active Agent"] },
      ...(taskRole ? [] : [{ value: "workspace", cells: ["Workspace"] }])
    ],
    [TEXT_COLUMN],
    io,
    undefined,
    "field"
  );
  if (field === undefined) return { kind: "cancelled", args };
  if (field === "active-agent") {
    const selected = await selectConfiguredAgent(ports, io, "Select Active Agent");
    return selected === undefined
      ? { kind: "cancelled", args }
      : { kind: "resolved", args: replaceOptionValue(args, "--agent", selected) };
  }
  if (field === "workspace") {
    const workspace = (await io.question("Workspace: "))?.trim();
    return workspace === undefined || workspace.length === 0
      ? { kind: "cancelled", args }
      : { kind: "resolved", args: [...args, "--workspace", workspace] };
  }
  void agent;
  return setProfileField(args, field, io);
}

async function configureNewAgentField(
  args: string[],
  agent: AgentChoice,
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const binding = {
    agentId: agent.id,
    adapterId: agent.adapterId,
    config: {
      adapterId: agent.adapterId,
      permission: { strategy: "bypass" }
    }
  };
  const resolved = await loadAgentCatalog(ports, binding);
  const fields = agentFields(binding, resolved?.catalog);
  const field = await choose(
    `Agent settings: ${agent.id}`,
    fields.map((candidate) => ({ value: candidate.value, cells: [candidate.label, "CLI default"] })),
    [TEXT_COLUMN, { header: "Current", minWidth: 12, maxWidth: 24 }],
    io,
    undefined,
    "field"
  );
  const selected = fields.find((candidate) => candidate.value === field);
  if (selected === undefined) return { kind: "cancelled", args };
  if (selected.value === "model") {
    if (resolved === undefined) return { kind: "cancelled", args };
    const selection = await selectAgentModelAndEffort(resolved, io, {});
    return selection.kind === "cancelled"
      ? { kind: "cancelled", args }
      : { kind: "resolved", args: appendModelEffortPatch(args, selection, false) };
  }
  if (selected.value === "effort") {
    if (resolved === undefined) return { kind: "cancelled", args };
    const selection = await selectAgentEffort(resolved, io, {});
    return selection.kind === "cancelled"
      ? { kind: "cancelled", args }
      : {
          kind: "resolved",
          args: selection.effort === undefined ? args : [...args, "--effort", selection.effort]
        };
  }
  if (selected.value === "permission-strategy") {
    const strategy = await promptAgentFieldValue(selected, io);
    if (strategy === undefined || strategy.length === 0) return { kind: "cancelled", args };
    const permissionArgs = await configuredPermissionArgs(binding, resolved?.catalog, strategy, io);
    return permissionArgs === undefined
      ? { kind: "cancelled", args }
      : { kind: "resolved", args: [...args, ...permissionArgs] };
  }
  const value = await promptAgentFieldValue(selected, io);
  return value === undefined
    ? { kind: "cancelled", args }
    : { kind: "resolved", args: [...args, selected.set, value] };
}

async function updateGlobalRole(
  args: string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const role = asRole(await ports.call("role.show", { name: args[3] }));
  if (role === undefined) return { kind: "unchanged", args };
  return updateRole(args, role, ports, io, false);
}

async function updateTaskRole(
  args: string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const role = asRole(await ports.call("task.role.show", {
    taskId: args[3],
    roleName: args[4]
  }));
  if (role === undefined) return { kind: "unchanged", args };
  return updateRole(args, role, ports, io, true);
}

async function updateRole(
  args: string[],
  role: RoleView,
  ports: SelectionPorts,
  io: SelectionIo,
  taskRole: boolean
): Promise<RoleWizardResolution> {
  const section = await settingsSection(`Update Role: ${role.name}`, io, taskRole);
  if (section === undefined) return { kind: "cancelled", args };
  return section === "role"
    ? updateRoleSettings(args, role, ports, io, taskRole)
    : updateAgentSettings(args, role, ports, io);
}

async function settingsSection(
  title: string,
  io: SelectionIo,
  taskRole: boolean
): Promise<string | undefined> {
  return choose(
    title,
    [
      {
        value: "role",
        cells: ["Role settings", taskRole ? "Profile, Active Agent" : "Profile, Active Agent, workspace"]
      },
      { value: "agent", cells: ["Agent settings", "Model, effort, permissions"] }
    ],
    [TEXT_COLUMN, { header: "Includes", minWidth: 18, maxWidth: 46 }],
    io,
    "role",
    "settings"
  );
}

async function updateRoleSettings(
  args: string[],
  role: RoleView,
  ports: SelectionPorts,
  io: SelectionIo,
  taskRole: boolean
): Promise<RoleWizardResolution> {
  const fields: Choice[] = [
    profileChoice("description", "Description", role.description),
    profileChoice("responsibilities", "Responsibilities", role.responsibilities),
    profileChoice("constraints", "Constraints", role.constraints),
    profileChoice("expected-output", "Expected output", role.expectedOutput),
    profileChoice("system-prompt", "System prompt", role.systemPrompt),
    { value: "active-agent", cells: ["Active Agent", role.activeAgentId] },
    ...(taskRole ? [] : [{ value: "workspace", cells: ["Workspace", roleDisplay(role.workspace)] }])
  ];
  const field = await choose(
    "Role settings",
    fields,
    [TEXT_COLUMN, { header: "Current", minWidth: 12, maxWidth: 52 }],
    io,
    undefined,
    "field"
  );
  if (field === undefined) return { kind: "cancelled", args };

  if (field === "active-agent") {
    const target = await selectActiveAgent(role, ports, io);
    if (target === undefined) return { kind: "cancelled", args };
    return taskRole
      ? { kind: "resolved", args: ["task", "role", "bind", args[3] ?? "", args[4] ?? "", target] }
      : { kind: "resolved", args: ["config", "role", "bind", args[3] ?? "", target] };
  }
  if (field === "workspace") {
    const value = (await io.question(`Workspace [${roleDisplay(role.workspace)}]: `))?.trim();
    return value === undefined || value.length === 0
      ? { kind: "cancelled", args }
      : { kind: "resolved", args: [...args, "--workspace", value] };
  }
  return updateProfileField(args, field, io);
}

async function updateProfileField(
  args: string[],
  field: string,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const action = await choose(
    `Update ${profileLabel(field)}`,
    [
      { value: "keep", cells: ["Keep current"] },
      { value: "clear", cells: ["Clear"] },
      { value: "set", cells: ["Set value"] }
    ],
    [TEXT_COLUMN],
    io,
    "keep",
    "action"
  );
  if (action === undefined || action === "keep") return { kind: "cancelled", args };
  const options = profileOptions(field);
  if (action === "clear") {
    return { kind: "resolved", args: [...args, options.clear] };
  }
  return setProfileField(args, field, io);
}

async function setProfileField(
  args: string[],
  field: string,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const options = profileOptions(field);
  const hint = options.repeatable ? " (comma-separated)" : "";
  const value = (await io.question(`${profileLabel(field)}${hint}: `))?.trim();
  if (value === undefined || value.length === 0) return { kind: "cancelled", args };
  const values = options.repeatable
    ? value.split(",").map((part) => part.trim()).filter(Boolean)
    : [value];
  if (values.length === 0) return { kind: "cancelled", args };
  return {
    kind: "resolved",
    args: [...args, ...values.flatMap((entry) => [options.set, entry])]
  };
}

async function updateAgentSettings(
  args: string[],
  role: RoleView,
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const bindings = Object.values(role.agentBindings);
  const selectedId = await choose(
    "Select Role Agent binding",
    bindings.map((binding) => ({
      value: binding.agentId,
      cells: [binding.agentId, binding.adapterId, binding.agentId === role.activeAgentId ? "active" : "bound"]
    })),
    [
      { header: "Agent", minWidth: 5, maxWidth: 24 },
      { header: "Adapter", minWidth: 7, maxWidth: 12 },
      { header: "State", minWidth: 6, maxWidth: 8 }
    ],
    io,
    role.activeAgentId,
    "binding"
  );
  if (selectedId === undefined) return { kind: "cancelled", args };
  const binding = role.agentBindings[selectedId];
  if (binding === undefined) return { kind: "cancelled", args };
  return updateAgentBindingSettings(args, role, binding, ports, io);
}

async function updateAgentBindingSettings(
  args: string[],
  role: RoleView,
  binding: RoleBinding,
  ports: SelectionPorts,
  io: SelectionIo
): Promise<RoleWizardResolution> {
  const resolved = await loadAgentCatalog(ports, binding, role.workspace);
  const fields = agentFields(binding, resolved?.catalog);
  const field = await choose(
    `Agent settings: ${binding.agentId}`,
    [
      ...fields.map((candidate) => ({
        value: candidate.value,
        cells: [candidate.label, candidate.current]
      })),
      { value: "clear-all", cells: ["Clear all overrides", "Use CLI defaults"] }
    ],
    [TEXT_COLUMN, { header: "Current", minWidth: 12, maxWidth: 36 }],
    io,
    undefined,
    "field"
  );
  if (field === undefined) return { kind: "cancelled", args };
  if (field === "clear-all") {
    return {
      kind: "resolved",
      args: [...args, "--agent", binding.agentId, "--clear-agent-config"]
    };
  }
  const selectedField = fields.find((candidate) => candidate.value === field);
  if (selectedField === undefined) return { kind: "cancelled", args };
  if (selectedField.value === "model") {
    if (resolved === undefined) return { kind: "cancelled", args };
    const selection = await selectAgentModelAndEffort(resolved, io, {
      currentModel: stringField(binding.config, "model"),
      currentEffort: stringField(binding.config, "effort")
    });
    return selection.kind === "cancelled"
      ? { kind: "cancelled", args }
      : {
          kind: "resolved",
          args: appendModelEffortPatch(
            [...args, "--agent", binding.agentId],
            selection,
            true
          )
        };
  }
  if (selectedField.value === "effort") {
    if (resolved === undefined) return { kind: "cancelled", args };
    const selection = await selectAgentEffort(resolved, io, {
      model: stringField(binding.config, "model"),
      currentEffort: stringField(binding.config, "effort")
    });
    if (selection.kind === "cancelled") return { kind: "cancelled", args };
    return {
      kind: "resolved",
      args: [
        ...args,
        "--agent", binding.agentId,
        ...(selection.effort === undefined
          ? ["--clear-effort"] : ["--effort", selection.effort])
      ]
    };
  }
  if (selectedField.value === "permission-strategy") {
    const strategy = await promptAgentFieldValue(selectedField, io);
    if (strategy === undefined || strategy.length === 0) return { kind: "cancelled", args };
    const permissionArgs = await configuredPermissionArgs(binding, resolved?.catalog, strategy, io);
    if (permissionArgs === undefined) return { kind: "cancelled", args };
    return {
      kind: "resolved",
      args: [...args, "--agent", binding.agentId, ...permissionArgs]
    };
  }

  const action = await choose(
    `Update ${selectedField.label}`,
    [
      { value: "keep", cells: ["Keep current", selectedField.current] },
      { value: "clear", cells: ["Use CLI default", "Remove override"] },
      { value: "set", cells: ["Set value", "Override CLI default"] }
    ],
    [TEXT_COLUMN, { header: "Result", minWidth: 14, maxWidth: 36 }],
    io,
    "keep",
    "action"
  );
  if (action === undefined || action === "keep") return { kind: "cancelled", args };
  if (action === "clear") {
    return {
      kind: "resolved",
      args: [...args, "--agent", binding.agentId, ...selectedField.clear]
    };
  }
  const value = await promptAgentFieldValue(selectedField, io);
  if (value === undefined || value.length === 0) return { kind: "cancelled", args };
  return {
    kind: "resolved",
    args: [...args, "--agent", binding.agentId, selectedField.set, value]
  };
}

type AgentField = Readonly<{
  value: string;
  label: string;
  current: string;
  set: string;
  clear: readonly string[];
  choices?: readonly string[];
}>;

function agentFields(
  binding: RoleBinding,
  catalog?: AgentConfigurationCatalog
): AgentField[] {
  const config = binding.config;
  const permission = entity(config.permission) ?? {};
  return [
    agentField("model", "Model", config.model, "--model", ["--clear-model"]),
    agentField("effort", "Effort", config.effort, "--effort", ["--clear-effort"]),
    agentField(
      "permission-strategy",
      "Permission strategy",
      permission.strategy,
      "--permission-strategy",
      ["--permission-strategy", "default"],
      catalogChoices(catalog, "permission.strategy", ["default", "bypass", "configured"])
    ),
    ...(binding.adapterId === "codex" && permission.strategy === "configured" ? [
      agentField("sandbox", "Sandbox", permission.sandbox, "--sandbox", ["--permission-strategy", "default"],
        catalogChoices(catalog, "permission.sandbox", [
          "read-only", "workspace-write", "danger-full-access"
        ])),
      agentField("approval", "Approval", permission.approval, "--approval", ["--permission-strategy", "default"],
        catalogChoices(catalog, "permission.approval", [
          "untrusted", "on-request", "never"
        ]))
    ] : []),
    ...(binding.adapterId === "codex" ? [
      agentField("search", "Web search", config.search, "--search", ["--clear-search"], [
        ...catalogChoices(catalog, "search", ["true"])
      ])
    ] : []),
    ...(binding.adapterId === "claude" && permission.strategy === "configured" ? [
      agentField(
        "permission-mode",
        "Permission mode",
        permission.mode,
        "--permission-mode",
        ["--permission-strategy", "default"],
        catalogChoices(catalog, "permission.mode")
      )
    ] : [])
  ];
}

async function loadAgentCatalog(
  ports: SelectionPorts,
  binding: RoleBinding,
  cwd?: string
): Promise<ResolvedAgentConfigurationCatalog | undefined> {
  const value = await ports.call("agent.capabilities", {
    agentId: binding.agentId,
    config: binding.config,
    ...(cwd === undefined ? {} : { cwd })
  });
  const input = entity(value);
  return input !== undefined
    && (input.source === "live" || input.source === "cache" || input.source === "fallback")
    && entity(input.catalog) !== undefined
    ? value as ResolvedAgentConfigurationCatalog
    : undefined;
}

function catalogChoices(
  catalog: AgentConfigurationCatalog | undefined,
  key: string,
  fallback: readonly string[] = []
): string[] {
  const field = catalog?.fields.find((candidate) => candidate.key === key);
  return field === undefined ? [...fallback] : field.choices.map(({ value }) => value);
}

function appendModelEffortPatch(
  args: string[],
  selection: Readonly<{ model: string | undefined; effort: string | undefined }>,
  update: boolean
): string[] {
  return [
    ...args,
    ...(selection.model === undefined
      ? update ? ["--clear-model"] : []
      : ["--model", selection.model]),
    ...(selection.effort === undefined
      ? update ? ["--clear-effort"] : []
      : ["--effort", selection.effort])
  ];
}

function agentField(
  value: string,
  label: string,
  current: unknown,
  set: string,
  clear: readonly string[],
  choices?: readonly string[]
): AgentField {
  return { value, label, current: display(current), set, clear, ...(choices === undefined ? {} : { choices }) };
}

async function configuredPermissionArgs(
  binding: RoleBinding,
  catalog: AgentConfigurationCatalog | undefined,
  strategy: string,
  io: SelectionIo
): Promise<string[] | undefined> {
  if (strategy !== "configured") return ["--permission-strategy", strategy];
  if (binding.adapterId === "codex") {
    const field = await choose(
      "Native permission option",
      [
        { value: "sandbox", cells: ["Sandbox"] },
        { value: "approval", cells: ["Approval"] }
      ],
      [TEXT_COLUMN],
      io,
      "sandbox",
      "option"
    );
    if (field === undefined) return undefined;
    const option = field === "sandbox" ? "--sandbox" : "--approval";
    const value = await promptAgentFieldValue(agentField(
      field,
      field === "sandbox" ? "Sandbox" : "Approval",
      undefined,
      option,
      ["--permission-strategy", "default"],
      field === "sandbox"
        ? catalogChoices(catalog, "permission.sandbox", [
            "read-only", "workspace-write", "danger-full-access"
          ])
        : catalogChoices(catalog, "permission.approval", [
            "untrusted", "on-request", "never"
          ])
    ), io);
    return value === undefined
      ? undefined
      : ["--permission-strategy", "configured", option, value];
  }
  const field = await choose(
    "Native permission option",
    [
      { value: "mode", cells: ["Permission mode"] },
      { value: "allowed", cells: ["Allowed tool"] },
      { value: "disallowed", cells: ["Disallowed tool"] }
    ],
    [TEXT_COLUMN],
    io,
    "mode",
    "option"
  );
  if (field === undefined) return undefined;
  const option = field === "mode"
    ? "--permission-mode"
    : field === "allowed" ? "--allowed-tool" : "--disallowed-tool";
  const value = field === "mode"
    ? await promptAgentFieldValue(agentField(
        "permission-mode",
        "Permission mode",
        undefined,
        option,
        ["--permission-strategy", "default"],
        catalogChoices(catalog, "permission.mode")
      ), io)
    : (await io.question(`${field === "allowed" ? "Allowed" : "Disallowed"} tool: `))?.trim();
  return value === undefined || value.length === 0
    ? undefined
    : ["--permission-strategy", "configured", option, value];
}

async function promptAgentFieldValue(
  field: AgentField,
  io: SelectionIo
): Promise<string | undefined> {
  return field.choices === undefined
    ? (await io.question(`${field.label}: `))?.trim()
    : choose(
      `Set ${field.label}`,
      field.choices.map((choice) => ({ value: choice, cells: [choice] })),
      [TEXT_COLUMN],
      io,
      field.choices[0],
      "value"
    );
}

async function selectActiveAgent(
  role: RoleView,
  ports: SelectionPorts,
  io: SelectionIo
): Promise<string | undefined> {
  const configured = await configuredAgents(ports);
  const byId = new Map(configured.map((agent) => [agent.id, agent]));
  for (const binding of Object.values(role.agentBindings)) {
    if (!byId.has(binding.agentId)) {
      byId.set(binding.agentId, { id: binding.agentId, adapterId: binding.adapterId });
    }
  }
  return choose(
    "Select Active Agent",
    [...byId.values()].map((agent) => ({
      value: agent.id,
      cells: [
        agent.id,
        agent.adapterId,
        agent.id === role.activeAgentId ? "active" : role.agentBindings[agent.id] === undefined ? "new" : "bound"
      ]
    })),
    [
      { header: "Agent", minWidth: 5, maxWidth: 24 },
      { header: "Adapter", minWidth: 7, maxWidth: 12 },
      { header: "State", minWidth: 5, maxWidth: 8 }
    ],
    io,
    role.activeAgentId,
    "Agent"
  );
}

async function selectConfiguredAgent(
  ports: SelectionPorts,
  io: SelectionIo,
  title: string,
  loaded?: AgentSelection
): Promise<string | undefined> {
  const selection = loaded ?? await loadAgentSelection(ports);
  return choose(
    title,
    selection.agents.map((agent) => ({
      value: agent.id,
      cells: [agent.id, agent.adapterId, agent.id === selection.defaultAgent ? "yes" : ""]
    })),
    [
      { header: "Agent", minWidth: 5, maxWidth: 24 },
      { header: "Adapter", minWidth: 7, maxWidth: 12 },
      { header: "Default", minWidth: 7, maxWidth: 7 }
    ],
    io,
    selection.defaultAgent,
    "Agent"
  );
}

async function loadAgentSelection(ports: SelectionPorts): Promise<AgentSelection> {
  const [agents, config] = await Promise.all([
    configuredAgents(ports),
    ports.call("config.get", {})
  ]);
  const configuredDefault = stringField(entity(config), "defaultAgent");
  const defaultAgent = agents.some((agent) => agent.id === configuredDefault)
    ? configuredDefault
    : agents[0]?.id;
  return {
    agents,
    ...(defaultAgent === undefined ? {} : { defaultAgent })
  };
}

async function configuredAgents(ports: SelectionPorts): Promise<AgentChoice[]> {
  const value = await ports.call("agent.list", {});
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): AgentChoice[] => {
    const input = entity(candidate);
    const id = stringField(input, "id");
    const adapterId = stringField(input, "adapterId");
    return id === undefined || adapterId === undefined ? [] : [{ id, adapterId }];
  });
}

async function choose(
  title: string,
  choices: readonly Choice[],
  columns: readonly TableColumn[],
  io: SelectionIo,
  defaultValue: string | undefined,
  label: string
): Promise<string | undefined> {
  if (choices.length === 0) {
    io.write(`○ No ${label}s are available.\n`);
    return undefined;
  }
  io.write(`${renderTable(
    title,
    [{ header: "#", minWidth: 1, maxWidth: 4 }, ...columns],
    choices.map((choice, index) => [String(index + 1), ...choice.cells]),
    io.width
  )}\n\n`);
  const answer = (await io.question(
    `Choose ${label} [1-${choices.length}/value, q]: `
  ))?.trim();
  if (answer === undefined || answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
    return undefined;
  }
  if (answer.length === 0) {
    return choices.find((choice) => choice.value === defaultValue)?.value
      ?? choices[0]?.value;
  }
  const numeric = Number(answer);
  if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1]?.value;
  }
  return choices.find((choice) => choice.value === answer)?.value;
}

function asRole(value: unknown): RoleView | undefined {
  const input = entity(value);
  const name = stringField(input, "name");
  const activeAgentId = stringField(input, "activeAgentId");
  const rawBindings = entity(input?.agentBindings);
  if (input === undefined || name === undefined || activeAgentId === undefined || rawBindings === undefined) {
    return undefined;
  }
  const agentBindings = Object.fromEntries(Object.entries(rawBindings).flatMap(([id, raw]): [string, RoleBinding][] => {
    const binding = entity(raw);
    const agentId = stringField(binding, "agentId");
    const adapterId = stringField(binding, "adapterId");
    const config = entity(binding?.config);
    return agentId === undefined || adapterId === undefined || config === undefined
      ? []
      : [[id, { agentId, adapterId, config }]];
  }));
  return {
    name,
    activeAgentId,
    agentBindings,
    ...(stringField(input, "workspace") === undefined ? {} : { workspace: stringField(input, "workspace") }),
    ...(stringField(input, "description") === undefined ? {} : { description: stringField(input, "description") }),
    ...(stringArray(input.responsibilities) === undefined ? {} : { responsibilities: stringArray(input.responsibilities) }),
    ...(stringArray(input.constraints) === undefined ? {} : { constraints: stringArray(input.constraints) }),
    ...(stringField(input, "expectedOutput") === undefined ? {} : { expectedOutput: stringField(input, "expectedOutput") }),
    ...(stringField(input, "systemPrompt") === undefined ? {} : { systemPrompt: stringField(input, "systemPrompt") })
  };
}

function profileChoice(value: string, label: string, current: unknown): Choice {
  return { value, cells: [label, roleDisplay(current)] };
}

function profileLabel(field: string): string {
  return ({
    description: "Description",
    responsibilities: "Responsibilities",
    constraints: "Constraints",
    "expected-output": "Expected output",
    "system-prompt": "System prompt"
  } as Readonly<Record<string, string>>)[field] ?? field;
}

function profileOptions(field: string): Readonly<{
  set: string;
  clear: string;
  repeatable: boolean;
}> {
  switch (field) {
    case "description": return { set: "--description", clear: "--clear-description", repeatable: false };
    case "responsibilities": return { set: "--responsibility", clear: "--clear-responsibilities", repeatable: true };
    case "constraints": return { set: "--constraint", clear: "--clear-constraints", repeatable: true };
    case "expected-output": return { set: "--expected-output", clear: "--clear-expected-output", repeatable: false };
    case "system-prompt": return { set: "--system-prompt", clear: "--clear-system-prompt", repeatable: false };
    default: throw new Error(`Unsupported Role profile field: ${field}.`);
  }
}

function entity(value: unknown): Entity | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Entity
    : undefined;
}

function stringField(value: Entity | undefined, field: string): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function display(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  if (typeof value === "string") return value.length === 0 ? "—" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "CLI default";
}

function roleDisplay(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  if (typeof value === "string") return value.length === 0 ? "—" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "—";
}

function isValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.startsWith("--");
}

function hasExplicitAddSettings(args: readonly string[], optionStart: number): boolean {
  return args.slice(optionStart).some((value) => value.startsWith("--") && value !== "--agent");
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 || !isValue(args[index + 1]) ? undefined : args[index + 1];
}

function replaceOptionValue(args: readonly string[], option: string, value: string): string[] {
  const replaced = [...args];
  const index = replaced.indexOf(option);
  if (index < 0) return [...replaced, option, value];
  replaced[index + 1] = value;
  return replaced;
}
