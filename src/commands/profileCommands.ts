import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  BUILTIN_PROFILE_IDS,
  builtinAgentProfileInputs,
  createAgentProfile,
  updateAgentProfile,
  type AgentProfile,
  type AgentProfileInput,
  type AgentProfileRuntime,
  type WorkerAccess
} from "../profile/agentProfile.js";
import {
  resolveAgentProfileRuntime,
  resolveAgentProfileView,
  type AgentProfileView
} from "../profile/agentProfileRuntime.js";
import type { RoleAgentConfig } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  parseRoleOptions,
  type ParsedRoleOptions,
  type RoleOptionKind
} from "./roleConfiguration.js";

export type ProfileCommandStore = Pick<
TaskStore,
| "transaction"
| "getAgentProfile"
| "listAgentProfiles"
| "saveAgentProfile"
| "removeAgentProfile"
| "getConfiguredAgent"
| "getGlobalRole"
| "getConfig"
>;

export type ProfileAgentConfigurationMutation = Readonly<{
  agentId: string;
  config: RoleAgentConfig;
  cwd: string;
}>;

export type ProfileCommandOptions = Readonly<{
  validateAgentConfiguration?: (
    input: ProfileAgentConfigurationMutation
  ) => void;
}>;

/** Build the exact explicit Profile runtime that a command would persist. */
export function previewProfileAgentConfigurationMutation(
  args: readonly string[],
  store: ProfileCommandStore
): ProfileAgentConfigurationMutation | undefined {
  const [command, ...rest] = args;
  let profile: AgentProfile | undefined;
  if (command === "add") {
    const usage = "Profile add usage: yui config profile add <id> [--access <read|write>] [Profile settings].";
    const [id, ...tail] = rest;
    if (id === undefined || id.startsWith("--")) throw usageError("Profile id is required.", usage);
    const parsed = parseProfileOptions(tail, false, usage);
    assertOptionPairs(parsed);
    const runtime = addedRuntime(parsed, usage);
    if (runtime.source === "global-worker") return undefined;
    profile = createAgentProfile({ id, runtime }, new Date(0));
  } else if (command === "update") {
    const usage = "Profile update usage: yui config profile update <id> [--access <read|write>] [Profile settings].";
    const [id, ...tail] = rest;
    if (id === undefined || id.startsWith("--")) throw usageError("Profile id is required.", usage);
    const parsed = parseProfileOptions(tail, true, usage);
    assertOptionPairs(parsed);
    const current = requireProfile(store, id);
    const runtime = updatedRuntime(current, parsed, usage);
    if (runtime === undefined || runtime.source === "global-worker") return undefined;
    profile = updateAgentProfile(current, { runtime }, new Date(
      Math.max(Date.parse(current.updatedAt) + 1, 1)
    ));
  } else {
    return undefined;
  }
  const runtime = resolveAgentProfileRuntime(profile, store);
  if (runtime.status === "unavailable") throw usageError(runtime.reason);
  return {
    agentId: runtime.binding.agentId,
    config: runtime.binding.config,
    cwd: store.getConfig().defaultWorkspace ?? process.cwd()
  };
}

export function runProfileCommand(
  args: readonly string[],
  store: ProfileCommandStore,
  now: () => Date = () => new Date(),
  options: ProfileCommandOptions = {}
): Readonly<{ output: string; data: unknown }> {
  const [command, ...rest] = args;
  switch (command) {
    case "add": return addProfile(rest, store, now(), options);
    case "list": return listProfiles(rest, store);
    case "show": return showProfile(rest, store);
    case "update": return updateProfile(rest, store, now(), options);
    case "remove": return removeProfile(rest, store);
    case "reset": return resetProfiles(rest, store, now());
    default:
      throw usageError(command === undefined
        ? "Profile command is required."
        : `Unknown command: config profile ${command}`);
  }
}

function addProfile(
  args: readonly string[],
  store: ProfileCommandStore,
  now: Date,
  options: ProfileCommandOptions
): Readonly<{ output: string; data: unknown }> {
  const usage = "Profile add usage: yui config profile add <id> [--access <read|write>] [Profile settings].";
  const [id, ...tail] = args;
  if (id === undefined || id.startsWith("--")) throw usageError("Profile id is required.", usage);
  const parsed = parseProfileOptions(tail, false, usage);
  assertOptionPairs(parsed);
  const profile = createAgentProfile({
    id,
    defaultAccess: parseAccess(parsed.one("--access") ?? "read"),
    ...profileValues(parsed),
    runtime: addedRuntime(parsed, usage)
  }, now);
  validateExplicitRuntime(profile, store, options);
  store.transaction((tx) => {
    if (tx.getAgentProfile(profile.id) !== null) {
      throw usageError(`Agent Profile already exists: ${profile.id}.`);
    }
    tx.saveAgentProfile(profile);
  });
  return {
    output: `Added Agent Profile ${profile.id}\n`,
    data: resolveAgentProfileView(profile, store)
  };
}

function listProfiles(
  args: readonly string[],
  store: ProfileCommandStore
): Readonly<{ output: string; data: unknown }> {
  noArgs(args, "Profile list usage: yui config profile list.");
  const profiles = store.listAgentProfiles().map((profile) =>
    resolveAgentProfileView(profile, store));
  const output = profiles.length === 0
    ? "No Agent Profiles found.\n"
    : `${renderTable(
        "Agent Profiles",
        [
          { header: "Profile", minWidth: 7, maxWidth: 24 },
          { header: "Revision", minWidth: 8, maxWidth: 10 },
          { header: "Access", minWidth: 6, maxWidth: 8 },
          { header: "Runtime", minWidth: 9, maxWidth: 14 },
          { header: "Worker r", minWidth: 8, maxWidth: 10 },
          { header: "Agent", minWidth: 7, maxWidth: 18 },
          { header: "Model", minWidth: 7, maxWidth: 24 },
          { header: "Effort", minWidth: 7, maxWidth: 12 },
          { header: "Description", minWidth: 12, maxWidth: 48 }
        ],
        profiles.map(profileListRow),
        defaultTableWidth()
      )}\n`;
  return { output, data: { profiles } };
}

function showProfile(
  args: readonly string[],
  store: ProfileCommandStore
): Readonly<{ output: string; data: unknown }> {
  const profile = requireProfile(store, oneArg(args, "Profile show usage: yui config profile show <id>."));
  const view = resolveAgentProfileView(profile, store);
  const runtime = view.runtime;
  return {
    output: `${[
      `Agent Profile: ${profile.id}`,
      `Revision: ${profile.revision}`,
      `Default access: ${profile.defaultAccess}`,
      `Description: ${profile.description ?? "-"}`,
      `Instructions: ${profile.instructions ?? "-"}`,
      `Skills: ${profile.skills?.join(", ") || "-"}`,
      `Runtime source: ${runtime.source}`,
      `Worker revision: ${runtime.source === "global-worker"
        ? runtime.workerRevision ?? "unavailable"
        : "-"}`,
      `Runtime status: ${runtime.status}`,
      ...(runtime.status === "resolved"
        ? [
            `Effective Agent: ${runtime.binding.agentId}/${runtime.binding.adapterId}`,
            `Effective Model: ${runtime.binding.config.model ?? "CLI default"}`,
            `Effective Effort: ${runtime.binding.config.effort ?? "CLI default"}`
          ]
        : [`Runtime unavailable: ${runtime.reason}`])
    ].join("\n")}\n`,
    data: view
  };
}

function updateProfile(
  args: readonly string[],
  store: ProfileCommandStore,
  now: Date,
  options: ProfileCommandOptions
): Readonly<{ output: string; data: unknown }> {
  const usage = "Profile update usage: yui config profile update <id> [--access <read|write>] [Profile settings].";
  const [id, ...tail] = args;
  if (id === undefined || id.startsWith("--")) throw usageError("Profile id is required.", usage);
  const parsed = parseProfileOptions(tail, true, usage);
  if (parsed.seen.size === 0) throw usageError("At least one Profile option is required.", usage);
  assertOptionPairs(parsed);
  const current = requireProfile(store, id);
  const runtime = updatedRuntime(current, parsed, usage);
  const updated = updateAgentProfile(current, {
    ...(parsed.has("--access") ? { defaultAccess: parseAccess(parsed.one("--access")) } : {}),
    ...profilePatch(parsed),
    ...(runtime === undefined ? {} : { runtime })
  }, now);
  if (runtime !== undefined) {
    validateExplicitRuntime(updated, store, options);
  }
  store.saveAgentProfile(updated);
  return {
    output: `Updated Agent Profile ${updated.id} to revision ${updated.revision}\n`,
    data: resolveAgentProfileView(updated, store)
  };
}

function removeProfile(
  args: readonly string[],
  store: ProfileCommandStore
): Readonly<{ output: string; data: unknown }> {
  const id = oneArg(args, "Profile remove usage: yui config profile remove <id>.");
  if ((BUILTIN_PROFILE_IDS as readonly string[]).includes(id)) {
    throw usageError(`Built-in Agent Profile cannot be removed: ${id}. Use yui config profile reset instead.`);
  }
  if (!store.removeAgentProfile(id)) throw usageError(`Agent Profile not found: ${id}.`);
  return { output: `Removed Agent Profile ${id}\n`, data: { profileId: id } };
}

function resetProfiles(
  args: readonly string[],
  store: ProfileCommandStore,
  now: Date
): Readonly<{ output: string; data: unknown }> {
  noArgs(args, "Profile reset usage: yui config profile reset.");
  store.transaction((tx) => {
    for (const desired of builtinAgentProfileInputs()) {
      const existing = tx.getAgentProfile(desired.id);
      tx.saveAgentProfile(existing === null
        ? createAgentProfile(desired, now)
        : updateAgentProfile(existing, {
            defaultAccess: desired.defaultAccess,
            description: desired.description,
            instructions: desired.instructions,
            skills: desired.skills,
            runtime: desired.runtime
          }, now));
    }
  });
  const profiles = BUILTIN_PROFILE_IDS.map((id) =>
    resolveAgentProfileView(requireProfile(store, id), store));
  return {
    output: `Reset ${BUILTIN_PROFILE_IDS.length} built-in Agent Profiles\n`,
    data: { profiles }
  };
}

const BASE_OPTIONS: readonly [string, RoleOptionKind][] = [
  ["--access", "value"],
  ["--description", "value"],
  ["--instructions", "value"],
  ["--skill", "repeatable"],
  ["--agent", "value"],
  ["--model", "value"],
  ["--effort", "value"],
  ["--inherit-worker", "flag"]
];

const CLEAR_OPTIONS: readonly [string, RoleOptionKind][] = [
  ["--clear-description", "flag"],
  ["--clear-instructions", "flag"],
  ["--clear-skills", "flag"],
  ["--clear-model", "flag"],
  ["--clear-effort", "flag"]
];

function parseProfileOptions(
  args: readonly string[],
  update: boolean,
  usage: string
): ParsedRoleOptions {
  return parseRoleOptions(args, new Map([
    ...BASE_OPTIONS,
    ...(update ? CLEAR_OPTIONS : [])
  ]), usage);
}

function profileValues(parsed: ParsedRoleOptions): Partial<AgentProfileInput> {
  return {
    ...(parsed.has("--description") ? { description: requiredText(parsed.one("--description")) } : {}),
    ...(parsed.has("--instructions") ? { instructions: requiredText(parsed.one("--instructions")) } : {}),
    ...(parsed.has("--skill") ? { skills: parsed.many("--skill").map(requiredText) } : {})
  };
}

function profilePatch(parsed: ParsedRoleOptions): Partial<AgentProfileInput> {
  return {
    ...profileValues(parsed),
    ...(parsed.has("--clear-description") ? { description: undefined } : {}),
    ...(parsed.has("--clear-instructions") ? { instructions: undefined } : {}),
    ...(parsed.has("--clear-skills") ? { skills: undefined } : {})
  };
}

function addedRuntime(parsed: ParsedRoleOptions, usage: string): AgentProfileRuntime {
  assertRuntimeSourceOptions(parsed, usage);
  const agentId = parsed.one("--agent")?.trim();
  if (parsed.has("--inherit-worker") || agentId === undefined) {
    if (parsed.has("--model") || parsed.has("--effort")) {
      throw usageError("--model and --effort require --agent for an explicit Profile.", usage);
    }
    return { source: "global-worker" };
  }
  return {
    source: "explicit",
    agentId: requiredText(agentId),
    ...(parsed.has("--model") ? { model: requiredText(parsed.one("--model")) } : {}),
    ...(parsed.has("--effort") ? { effort: requiredText(parsed.one("--effort")) } : {})
  };
}

function updatedRuntime(
  profile: AgentProfile,
  parsed: ParsedRoleOptions,
  usage: string
): AgentProfileRuntime | undefined {
  assertRuntimeSourceOptions(parsed, usage);
  if (parsed.has("--inherit-worker")) return { source: "global-worker" };
  const runtimeOptions = [
    "--agent", "--model", "--effort", "--clear-model", "--clear-effort"
  ].some((option) => parsed.has(option));
  if (!runtimeOptions) return undefined;

  const agentId = parsed.one("--agent")?.trim();
  if (profile.runtime.source === "global-worker") {
    if (agentId === undefined) {
      throw usageError(
        "An inherited Profile requires --agent before model or effort can be customized.",
        usage
      );
    }
    return {
      source: "explicit",
      agentId: requiredText(agentId),
      ...(parsed.has("--model") ? { model: requiredText(parsed.one("--model")) } : {}),
      ...(parsed.has("--effort") ? { effort: requiredText(parsed.one("--effort")) } : {})
    };
  }

  const nextAgentId = agentId ?? profile.runtime.agentId;
  const changesAgent = nextAgentId !== profile.runtime.agentId;
  if (changesAgent) {
    for (const [field, setOption, clearOption] of [
      ["model", "--model", "--clear-model"],
      ["effort", "--effort", "--clear-effort"]
    ] as const) {
      if (profile.runtime[field] !== undefined
        && !parsed.has(setOption)
        && !parsed.has(clearOption)) {
        throw usageError(
          `Changing --agent requires ${setOption} or ${clearOption} so the old ${field} is not reused.`,
          usage
        );
      }
    }
    return {
      source: "explicit",
      agentId: requiredText(nextAgentId),
      ...(parsed.has("--model") ? { model: requiredText(parsed.one("--model")) } : {}),
      ...(parsed.has("--effort") ? { effort: requiredText(parsed.one("--effort")) } : {})
    };
  }

  return {
    source: "explicit",
    agentId: profile.runtime.agentId,
    ...(parsed.has("--clear-model")
      ? {}
      : parsed.has("--model")
        ? { model: requiredText(parsed.one("--model")) }
        : profile.runtime.model === undefined ? {} : { model: profile.runtime.model }),
    ...(parsed.has("--clear-effort")
      ? {}
      : parsed.has("--effort")
        ? { effort: requiredText(parsed.one("--effort")) }
        : profile.runtime.effort === undefined ? {} : { effort: profile.runtime.effort })
  };
}

function assertRuntimeSourceOptions(parsed: ParsedRoleOptions, usage: string): void {
  if (!parsed.has("--inherit-worker")) return;
  if (["--agent", "--model", "--effort", "--clear-model", "--clear-effort"]
    .some((option) => parsed.has(option))) {
    throw usageError(
      "--inherit-worker cannot be combined with explicit Agent, model, or effort options.",
      usage
    );
  }
}

function validateExplicitRuntime(
  profile: AgentProfile,
  store: ProfileCommandStore,
  options: ProfileCommandOptions
): void {
  if (profile.runtime.source !== "explicit") return;
  const runtime = resolveAgentProfileRuntime(profile, store);
  if (runtime.status === "unavailable") throw usageError(runtime.reason);
  options.validateAgentConfiguration?.({
    agentId: runtime.binding.agentId,
    config: runtime.binding.config,
    cwd: store.getConfig().defaultWorkspace ?? process.cwd()
  });
}

function profileListRow(view: AgentProfileView): string[] {
  const { profile, runtime } = view;
  return [
    profile.id,
    String(profile.revision),
    profile.defaultAccess,
    runtime.source,
    runtime.source === "global-worker"
      ? runtime.workerRevision === undefined ? "-" : String(runtime.workerRevision)
      : "-",
    runtime.status === "resolved" ? runtime.binding.agentId : "unavailable",
    runtime.status === "resolved" ? runtime.binding.config.model ?? "CLI default" : "-",
    runtime.status === "resolved" ? runtime.binding.config.effort ?? "CLI default" : "-",
    profile.description ?? "-"
  ];
}

function assertOptionPairs(parsed: ParsedRoleOptions): void {
  for (const [value, clear] of [
    ["--description", "--clear-description"],
    ["--instructions", "--clear-instructions"],
    ["--skill", "--clear-skills"],
    ["--model", "--clear-model"],
    ["--effort", "--clear-effort"]
  ] as const) {
    if (parsed.has(value) && parsed.has(clear)) {
      throw usageError(`${value} and ${clear} cannot be used together.`);
    }
  }
}

function requireProfile(store: ProfileCommandStore, id: string): AgentProfile {
  const profile = store.getAgentProfile(id);
  if (profile === null) throw usageError(`Agent Profile not found: ${id}.`);
  return profile;
}

function parseAccess(value: string | undefined): WorkerAccess {
  if (value === "read" || value === "write") return value;
  throw usageError(`Invalid Profile access: ${String(value)}.`);
}

function requiredText(value: string | undefined): string {
  const result = value?.trim();
  if (result === undefined || result.length === 0) throw usageError("Profile option value is required.");
  return result;
}

function oneArg(args: readonly string[], usage: string): string {
  if (args.length !== 1 || args[0].trim().length === 0) throw usageError(usage);
  return args[0];
}

function noArgs(args: readonly string[], usage: string): void {
  if (args.length !== 0) throw usageError(usage);
}
