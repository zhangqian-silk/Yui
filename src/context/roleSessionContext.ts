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
}>;

export type RoleSessionOwner = Readonly<
  { scope: "global" } | { scope: "task"; taskId: string }
>;

/**
 * Compiles stable Role policy for an Agent-native instruction channel.
 * Dynamic wakeups and Run assignments deliberately remain outside this value.
 */
export function compileRoleSessionContext(
  yuiHome: string | undefined,
  role: GlobalRole | TaskRole,
  owner: RoleSessionOwner
): RoleSessionContext {
  const kind = role.name === SYSTEM_OPERATOR_ROLE && owner.scope === "global"
    ? "operator"
    : role.name === SYSTEM_LEADER_ROLE
      ? "leader"
      : "worker";
  const skillIds = unique([`yui-${kind}`, ...(role.skills ?? [])]);
  const skills = skillIds.map((id) => loadSkill(yuiHome, id, id === `yui-${kind}`));
  return {
    developerInstructions: renderDeveloperInstructions(kind, role, owner),
    skills
  };
}

function renderDeveloperInstructions(
  kind: "operator" | "leader" | "worker",
  role: GlobalRole | TaskRole,
  owner: RoleSessionOwner
): string {
  const core = kind === "operator"
    ? [
        "You are the global Yui Operator and the user's CLI proxy.",
        "Manage Yui through its CLI; do not perform Task implementation work.",
        "Follow the injected yui-operator Skill when coordinating Yui."
      ]
    : kind === "leader"
      ? [
          `You are the Yui Leader for Task ${owner.scope === "task" ? owner.taskId : role.name}.`,
          "Own Task stewardship and delegate bounded implementation work.",
          "Follow the injected yui-leader Skill for Yui coordination."
        ]
      : [
          `You are Yui Role ${role.name}${owner.scope === "task" ? ` for Task ${owner.taskId}` : ""}.`,
          "Execute only the work delegated to this Role and report through Yui.",
          "Follow the injected yui-worker Skill while handling Yui work."
        ];
  const profile = [
    role.description === undefined ? null : `Role description: ${role.description}`,
    ...(role.responsibilities ?? []).map((value) => `Role responsibility: ${value}`),
    ...(role.constraints ?? []).map((value) => `Role constraint: ${value}`),
    role.expectedOutput === undefined ? null : `Expected output: ${role.expectedOutput}`,
    role.systemPrompt === undefined ? null : `Additional Role instructions:\n${role.systemPrompt}`
  ].filter((value): value is string => value !== null);
  return [...core, ...profile].join("\n");
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
