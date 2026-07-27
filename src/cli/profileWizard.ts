import type {
  ResolvedAgentConfigurationCatalog
} from "../executor/agentConfigurationCatalog.js";
import {
  selectAgentModelAndEffort
} from "./agentConfigurationPicker.js";
import type { SelectionIo } from "./interactiveSelection.js";
import type { SelectionPorts } from "./selectionPorts.js";

export type ProfileWizardResolution =
  | Readonly<{ kind: "unchanged"; args: string[] }>
  | Readonly<{ kind: "resolved"; args: string[] }>
  | Readonly<{ kind: "cancelled"; args: string[] }>;

type Entity = Readonly<Record<string, unknown>>;

export async function resolveProfileWizardArguments(
  commandArgs: readonly string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<ProfileWizardResolution> {
  const args = [...commandArgs];
  if (!io.interactive || io.json) return { kind: "unchanged", args };
  if (isAdd(args)) return addProfile(args, ports, io);
  if (isUpdate(args)) return updateProfile(args, ports, io);
  return { kind: "unchanged", args };
}

async function addProfile(
  args: string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<ProfileWizardResolution> {
  if (hasExplicitProfileSettings(args)) return { kind: "unchanged", args };
  const agentId = optionValue(args, "--agent");
  if (agentId === undefined) return { kind: "unchanged", args };
  const agent = await configuredAgent(ports, agentId);
  if (agent === undefined) return { kind: "unchanged", args };
  const catalog = await agentCatalog(ports, agentId, {
    adapterId: stringField(agent, "adapterId") ?? "codex"
  });
  if (catalog === undefined) return { kind: "cancelled", args };
  const selection = await selectAgentModelAndEffort(catalog, io, {});
  return selection.kind === "cancelled"
    ? { kind: "cancelled", args }
    : {
        kind: "resolved",
        args: [
          ...args,
          ...(selection.model === undefined ? [] : ["--model", selection.model]),
          ...(selection.effort === undefined ? [] : ["--effort", selection.effort])
        ]
      };
}

async function updateProfile(
  args: string[],
  ports: SelectionPorts,
  io: SelectionIo
): Promise<ProfileWizardResolution> {
  const profile = entity(await ports.call("profile.show", { id: args[2] }));
  const agentId = stringField(profile, "agentId");
  if (profile === undefined || agentId === undefined) return { kind: "unchanged", args };
  const agent = await configuredAgent(ports, agentId);
  if (agent === undefined) return { kind: "unchanged", args };
  const adapterId = stringField(agent, "adapterId") ?? "codex";
  const currentModel = stringField(profile, "model");
  const currentEffort = stringField(profile, "effort");
  const catalog = await agentCatalog(ports, agentId, {
    adapterId,
    ...(currentModel === undefined ? {} : { model: currentModel }),
    ...(currentEffort === undefined ? {} : { effort: currentEffort })
  });
  if (catalog === undefined) return { kind: "cancelled", args };
  const selection = await selectAgentModelAndEffort(catalog, io, {
    currentModel,
    currentEffort
  });
  return selection.kind === "cancelled"
    ? { kind: "cancelled", args }
    : {
        kind: "resolved",
        args: [
          ...args,
          ...(selection.model === undefined
            ? ["--clear-model"] : ["--model", selection.model]),
          ...(selection.effort === undefined
            ? ["--clear-effort"] : ["--effort", selection.effort])
        ]
      };
}

async function configuredAgent(
  ports: SelectionPorts,
  agentId: string
): Promise<Entity | undefined> {
  const value = await ports.call("agent.list", {});
  return Array.isArray(value)
    ? value.map(entity).find((agent) => stringField(agent, "id") === agentId)
    : undefined;
}

async function agentCatalog(
  ports: SelectionPorts,
  agentId: string,
  config: Readonly<Record<string, unknown>>
): Promise<ResolvedAgentConfigurationCatalog | undefined> {
  const value = await ports.call("agent.capabilities", { agentId, config });
  const input = entity(value);
  return input !== undefined
    && (input.source === "live" || input.source === "cache" || input.source === "fallback")
    && entity(input.catalog) !== undefined
    ? value as ResolvedAgentConfigurationCatalog
    : undefined;
}

function isAdd(args: readonly string[]): boolean {
  return args[0] === "profile" && args[1] === "add"
    && typeof args[2] === "string" && !args[2].startsWith("--");
}

function isUpdate(args: readonly string[]): boolean {
  return args.length === 3 && args[0] === "profile" && args[1] === "update"
    && typeof args[2] === "string" && !args[2].startsWith("--");
}

function hasExplicitProfileSettings(args: readonly string[]): boolean {
  return args.slice(3).some((value) => value.startsWith("--") && value !== "--agent");
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  const value = index < 0 ? undefined : args[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : undefined;
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
