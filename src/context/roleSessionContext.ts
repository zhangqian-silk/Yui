import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GlobalRole, TaskRole } from "../role/role.js";
import {
  SYSTEM_LEADER_ROLE,
  SYSTEM_OPERATOR_ROLE
} from "../role/systemRoles.js";

export type RoleSkillContext = Readonly<{
  id: string;
  path: string;
  content: string;
}>;

export type RoleSessionContext = Readonly<{
  developerInstructions: string;
  skills: readonly RoleSkillContext[];
  managedContextFile?: string;
  sessionManifestPath?: string;
  sessionManifestDigest?: string;
  sessionCliPath?: string;
}>;

export type RoleSessionOwner = Readonly<
  { scope: "global" } | { scope: "task"; taskId: string }
>;

export type RoleSessionContextOptions = Readonly<{
  purpose?: "execution" | "review";
}>;

type RoleSessionKind = "operator" | "global" | "leader" | "worker" | "reviewer";

const BUILTIN_YUI_SKILLS = new Set([
  "yui-runtime",
  "yui-operator",
  "yui-leader",
  "yui-worker",
  "yui-reviewer"
]);

/**
 * Compiles stable Role policy for an Agent-native instruction channel.
 * Dynamic wakeups and Turn assignments deliberately remain outside this value.
 */
export function compileRoleSessionContext(
  yuiHome: string | undefined,
  role: GlobalRole | TaskRole,
  owner: RoleSessionOwner,
  options: RoleSessionContextOptions = {}
): RoleSessionContext {
  const kind = roleSessionKind(role, owner, options.purpose ?? "execution");
  const builtInSkillId = kind === "global" ? undefined : `yui-${kind}`;
  const skillIds = unique([
    "yui-runtime",
    ...(builtInSkillId === undefined ? [] : [builtInSkillId]),
    ...(role.skills ?? [])
  ]);
  const skills = loadYuiSkillContexts(yuiHome, skillIds);
  return {
    developerInstructions: renderDeveloperInstructions(kind, role, owner),
    skills,
    ...(yuiHome === undefined
      ? {}
      : { managedContextFile: roleContextFile(yuiHome, role, owner, kind) })
  };
}

function renderDeveloperInstructions(
  kind: RoleSessionKind,
  role: GlobalRole | TaskRole,
  owner: RoleSessionOwner
): string {
  const core = renderRoleCore(kind, role, owner);
  const profile = [
    role.description === undefined ? null : `Role description: ${role.description}`,
    ...(role.responsibilities ?? []).map((value) => `Role responsibility: ${value}`),
    ...(role.constraints ?? []).map((value) => `Role constraint: ${value}`),
    role.expectedOutput === undefined ? null : `Expected output: ${role.expectedOutput}`,
    role.systemPrompt === undefined ? null : `Additional Role instructions:\n${role.systemPrompt}`
  ].filter((value): value is string => value !== null);
  return [...core, ...profile].join("\n");
}

export function roleSessionKind(
  role: GlobalRole | TaskRole,
  owner: RoleSessionOwner,
  purpose: "execution" | "review"
): RoleSessionKind {
  if (owner.scope === "global") {
    return role.name === SYSTEM_OPERATOR_ROLE ? "operator" : "global";
  }
  if (purpose === "review") return "reviewer";
  return role.name === SYSTEM_LEADER_ROLE ? "leader" : "worker";
}

function renderRoleCore(
  kind: RoleSessionKind,
  role: GlobalRole | TaskRole,
  owner: RoleSessionOwner
): string[] {
  switch (kind) {
    case "operator":
      return [
        "You are the global Yui Operator and the user's CLI proxy.",
        "Manage Yui through its CLI; do not perform Task implementation work.",
        "Follow the injected yui-operator Skill when coordinating Yui."
      ];
    case "global":
      return [
        `You are global Yui Role ${role.name}.`,
        "Follow the configured Role profile and the user's instructions."
      ];
    case "leader":
      return [
        `You are the Yui Leader for Task ${owner.scope === "task" ? owner.taskId : role.name}.`,
        "Own Task stewardship and delegate bounded implementation work.",
        "Follow the injected yui-leader Skill for Yui coordination."
      ];
    case "reviewer":
      return [
        `You are Yui review Role ${role.name} for Task ${owner.scope === "task" ? owner.taskId : role.name}.`,
        "Review only the exact frozen ReviewRound scope assigned to this Turn.",
        "Follow the injected yui-reviewer Skill while reviewing Yui work."
      ];
    case "worker":
      return [
        `You are Yui Role ${role.name}${owner.scope === "task" ? ` for Task ${owner.taskId}` : ""}.`,
        "Execute only the work delegated to this Role and report through Yui.",
        "Follow the injected yui-worker Skill while handling Yui work."
      ];
  }
}

export function loadYuiSkillContexts(
  yuiHome: string | undefined,
  skillIds: readonly string[]
): RoleSkillContext[] {
  return unique(skillIds).map((id) => loadSkill(
    yuiHome,
    id,
    BUILTIN_YUI_SKILLS.has(id)
  ));
}

function loadSkill(yuiHome: string | undefined, id: string, builtIn: boolean): RoleSkillContext {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid configured Skill id: ${id}.`);
  }
  if (!builtIn && yuiHome === undefined) {
    throw new Error("YUI_HOME is required to load configured Role skills.");
  }
  const path = builtIn
    ? resolve(fileURLToPath(new URL(`../../skills/${id}/`, import.meta.url)))
    : resolve(join(yuiHome!, "skills", id));
  try {
    return { id, path, content: readFileSync(join(path, "SKILL.md"), "utf8").trim() };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Configured Skill not found: ${id}.`);
    }
    throw error;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function roleContextFile(
  yuiHome: string,
  role: GlobalRole | TaskRole,
  owner: RoleSessionOwner,
  kind: RoleSessionKind
): string {
  const identity = createHash("sha256").update(JSON.stringify([
    owner.scope,
    ...(owner.scope === "task" ? [owner.taskId] : []),
    kind,
    role.name,
    role.activeAgentId
  ])).digest("hex");
  return resolve(join(yuiHome, "runtime", "session-contexts", `${identity}.md`));
}
