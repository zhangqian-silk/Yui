import { listAgentDefinitions, resolveAgent } from "../agent/agentRegistry.js";
import {
  ROLE_AGENT_INHERIT_OPTION,
  ROLE_AGENT_OPTION_SPECS,
  roleAgentOptionSpecsForAdapter,
  type FirstClassRoleAgentAdapterId
} from "./roleOptionCatalog.js";
import { findAgentAdapter, inspectAgentCapabilities, type CapabilitySnapshot } from "../executor/agentAdapter.js";
import type { AgentDefinition } from "../agent/agent.js";
import type { Role, GlobalRole } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import { ROOT_COMMAND, type CommandNode } from "./commandCatalog.js";

export type DynamicCompletionInput = {
  words: string[];
  current: string;
  store: TaskStore;
  inspectCapabilities?: (agent: AgentDefinition) => CapabilitySnapshot;
  taskIdScope?: string;
};

export function resolveCompletionCandidates(input: DynamicCompletionInput): string[] {
  const resolved = resolveCommand(input.words);
  if (resolved.node.completionProvider !== "role-agent") return [];
  const args = input.words.slice(resolved.consumed);
  const definitions = listAgentDefinitions(input.store.listConfiguredAgents());
  const previous = pendingValueOption(args);

  if (previous === "--agent") {
    return prefix(definitions.filter(({ adapterId }) => findAgentAdapter(adapterId) !== null).map(({ id }) => id).sort(), input.current);
  }

  const existing = resolveExistingRole(resolved.node, args, input.store, input.taskIdScope);
  if (previous === "--active-agent") {
    return prefix(existing === null ? [] : Object.keys(existing.agentBindings).sort(), input.current);
  }

  const selectedAgentId = optionValue(args, "--agent") ??
    optionValue(args, "--active-agent") ?? existing?.activeAgentId ??
    (resolved.node.completionUsesDefaultAgent ? input.store.getConfig().defaultAgent : undefined);
  const selected = selectedAgentId === undefined ? null : resolveAgent(selectedAgentId, definitions);
  const adapterId = selected?.adapterId === "codex" || selected?.adapterId === "claude"
    ? selected.adapterId
    : undefined;

  if (input.current.startsWith("-")) {
    return prefix(filterOptions(resolved.node, adapterId), input.current);
  }

  if (previous === "--inherit") {
    const fields = adapterId === undefined
      ? []
      : [
        ...roleAgentOptionSpecsForAdapter(adapterId).map(({ fieldKey }) => fieldKey),
        "systemPrompt"
      ];
    return prefix(unique(fields), input.current);
  }

  const option = ROLE_AGENT_OPTION_SPECS.find(({ option }) => option === previous);
  if (option === undefined || selected === null || adapterId === undefined ||
    !option.adapters.includes(adapterId)) {
    return [];
  }

  let snapshot: CapabilitySnapshot;
  try {
    snapshot = (input.inspectCapabilities ?? inspectAgentCapabilities)(selected);
  } catch {
    return [];
  }
  if (snapshot.installation.status !== "installed") return [];
  const field = snapshot.fields.find(({ key }) => key === option.fieldKey);
  if (field === undefined || field.status === "unavailable") return [];
  const model = optionValue(args, "--model") ??
    (selected === null ? undefined : readBindingModel(existing, selected.id));
  const choices = field.choicesByModel === undefined
    ? field.choices
    : model === undefined ? [] : field.choicesByModel[model];
  return prefix((choices ?? []).filter(({ available }) => available).map(({ value }) => value), input.current);
}

function resolveCommand(words: string[]): { node: CommandNode; consumed: number } {
  let node = ROOT_COMMAND;
  let consumed = 0;
  while (consumed < words.length) {
    const child = node.children.find(({ name }) => name === words[consumed]);
    if (child === undefined) break;
    node = child;
    consumed += 1;
  }
  return { node, consumed };
}

function resolveExistingRole(
  node: CommandNode,
  args: string[],
  store: TaskStore,
  taskIdScope?: string
): Role | GlobalRole | null {
  const path = node.path.slice(1).join(" ");
  if (path === "role update") return args[0] === undefined ? null : store.getGlobalRole(args[0]);
  if (path === "task role update") {
    if (taskIdScope !== undefined) {
      const scopedRoleName = args[1] === undefined || args[1].startsWith("--") ? args[0] : undefined;
      if (scopedRoleName !== undefined) return store.getRole(taskIdScope, scopedRoleName);
    }
    return args[0] === undefined || args[1] === undefined ? null : store.getRole(args[0], args[1]);
  }
  return null;
}

function readBindingModel(role: Role | GlobalRole | null, agentId: string): string | undefined {
  const config = role?.agentBindings[agentId]?.config;
  return config !== undefined && "model" in config && typeof config.model === "string"
    ? config.model
    : undefined;
}

function filterOptions(node: CommandNode, adapterId: FirstClassRoleAgentAdapterId | undefined): string[] {
  return node.options.filter((option) => {
    if (option === ROLE_AGENT_INHERIT_OPTION) return adapterId !== undefined;
    const spec = ROLE_AGENT_OPTION_SPECS.find(({ option: candidate }) => candidate === option);
    if (spec === undefined) return true;
    return adapterId !== undefined && spec.adapters.includes(adapterId);
  });
}

function optionValue(args: string[], option: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const candidate = args[index];
    if (!candidate.startsWith("--")) continue;
    const value = args[index + 1];
    if (candidate === option) return value === undefined || value.startsWith("--") ? undefined : value;
    index += 1;
  }
  return undefined;
}

function pendingValueOption(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const candidate = args[index];
    if (!candidate.startsWith("--")) continue;
    if (index === args.length - 1) return candidate;
    index += 1;
  }
  return undefined;
}

function prefix(values: readonly string[], current: string): string[] {
  return unique(values).filter((value) => value.startsWith(current));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
