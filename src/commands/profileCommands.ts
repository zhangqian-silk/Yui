import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  BUILTIN_PROFILE_IDS,
  builtinAgentProfileInputs,
  createAgentProfile,
  updateAgentProfile,
  type AgentProfile,
  type AgentProfileInput,
  type WorkerAccess
} from "../profile/agentProfile.js";
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
>;

export function runProfileCommand(
  args: readonly string[],
  store: ProfileCommandStore,
  now: () => Date = () => new Date()
): Readonly<{ output: string; data: unknown }> {
  const [command, ...rest] = args;
  switch (command) {
    case "add": return addProfile(rest, store, now());
    case "list": return listProfiles(rest, store);
    case "show": return showProfile(rest, store);
    case "update": return updateProfile(rest, store, now());
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
  now: Date
): Readonly<{ output: string; data: unknown }> {
  const usage = "Profile add usage: yui config profile add <id> [--access <read|write>] [Profile settings].";
  const [id, ...tail] = args;
  if (id === undefined || id.startsWith("--")) throw usageError("Profile id is required.", usage);
  const parsed = parseProfileOptions(tail, false, usage);
  const profile = createAgentProfile({
    id,
    defaultAccess: parseAccess(parsed.one("--access") ?? "read"),
    ...profileValues(parsed)
  }, now);
  store.transaction((tx) => {
    if (tx.getAgentProfile(profile.id) !== null) {
      throw usageError(`Agent Profile already exists: ${profile.id}.`);
    }
    tx.saveAgentProfile(profile);
  });
  return { output: `Added Agent Profile ${profile.id}\n`, data: { profile } };
}

function listProfiles(
  args: readonly string[],
  store: ProfileCommandStore
): Readonly<{ output: string; data: unknown }> {
  noArgs(args, "Profile list usage: yui config profile list.");
  const profiles = store.listAgentProfiles();
  const output = profiles.length === 0
    ? "No Agent Profiles found.\n"
    : `${renderTable(
        "Agent Profiles",
        [
          { header: "Profile", minWidth: 7, maxWidth: 24 },
          { header: "Revision", minWidth: 8, maxWidth: 10 },
          { header: "Access", minWidth: 6, maxWidth: 8 },
          { header: "Description", minWidth: 12, maxWidth: 54 }
        ],
        profiles.map((profile) => [
          profile.id,
          String(profile.revision),
          profile.defaultAccess,
          profile.description ?? "-"
        ]),
        defaultTableWidth()
      )}\n`;
  return { output, data: { profiles } };
}

function showProfile(
  args: readonly string[],
  store: ProfileCommandStore
): Readonly<{ output: string; data: unknown }> {
  const profile = requireProfile(store, oneArg(args, "Profile show usage: yui config profile show <id>."));
  return {
    output: `${[
      `Agent Profile: ${profile.id}`,
      `Revision: ${profile.revision}`,
      `Default access: ${profile.defaultAccess}`,
      `Description: ${profile.description ?? "-"}`,
      `Instructions: ${profile.instructions ?? "-"}`,
      `Skills: ${profile.skills?.join(", ") || "-"}`,
      `Model: ${profile.model ?? "-"}`,
      `Effort: ${profile.effort ?? "-"}`
    ].join("\n")}\n`,
    data: { profile }
  };
}

function updateProfile(
  args: readonly string[],
  store: ProfileCommandStore,
  now: Date
): Readonly<{ output: string; data: unknown }> {
  const usage = "Profile update usage: yui config profile update <id> [--access <read|write>] [Profile settings].";
  const [id, ...tail] = args;
  if (id === undefined || id.startsWith("--")) throw usageError("Profile id is required.", usage);
  const parsed = parseProfileOptions(tail, true, usage);
  if (parsed.seen.size === 0) throw usageError("At least one Profile option is required.", usage);
  assertOptionPairs(parsed);
  const current = requireProfile(store, id);
  const updated = updateAgentProfile(current, {
    ...(parsed.has("--access") ? { defaultAccess: parseAccess(parsed.one("--access")) } : {}),
    ...profilePatch(parsed)
  }, now);
  store.saveAgentProfile(updated);
  return {
    output: `Updated Agent Profile ${updated.id} to revision ${updated.revision}\n`,
    data: { profile: updated }
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
            model: desired.model,
            effort: desired.effort
          }, now));
    }
  });
  const profiles = BUILTIN_PROFILE_IDS.map((id) => requireProfile(store, id));
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
  ["--model", "value"],
  ["--effort", "value"]
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
    ...(parsed.has("--skill") ? { skills: parsed.many("--skill").map(requiredText) } : {}),
    ...(parsed.has("--model") ? { model: requiredText(parsed.one("--model")) } : {}),
    ...(parsed.has("--effort") ? { effort: requiredText(parsed.one("--effort")) } : {})
  };
}

function profilePatch(parsed: ParsedRoleOptions): Partial<AgentProfileInput> {
  return {
    ...profileValues(parsed),
    ...(parsed.has("--clear-description") ? { description: undefined } : {}),
    ...(parsed.has("--clear-instructions") ? { instructions: undefined } : {}),
    ...(parsed.has("--clear-skills") ? { skills: undefined } : {}),
    ...(parsed.has("--clear-model") ? { model: undefined } : {}),
    ...(parsed.has("--clear-effort") ? { effort: undefined } : {})
  };
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
