import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildRole } from "../role/childRole.js";
import type { Role } from "../role/role.js";
import { dataError } from "../errors/cliError.js";

export type DispatchContextStore = Readonly<{
  listChildRoles?(taskId: string): readonly ChildRole[];
}>;

export type BuildRoleContextInput = Readonly<{
  taskId: string;
  role: Role;
  input: string;
  childRoles?: readonly ChildRole[];
  configuredSkillBodies?: readonly string[];
}>;

/** Compatibility entry point used by the restored Task workflow. */
export function compileDispatchInput(
  store: DispatchContextStore,
  taskId: string,
  role: Role,
  input: string
): string {
  const childRoles = (store.listChildRoles?.(taskId) ?? [])
    .filter((child) => child.parentRole === role.name);
  const configuredSkillBodies = readConfiguredSkills(role.skills ?? []);
  return buildRoleContext({ taskId, role, input, childRoles, configuredSkillBodies });
}

export function buildRoleContext(context: BuildRoleContextInput): string {
  return context.role.name === "leader"
    ? buildLeaderContext(context)
    : buildWorkerContext(context);
}

export function buildLeaderContext(context: BuildRoleContextInput): string {
  return renderDispatchContext("leader", context);
}

export function buildWorkerContext(context: BuildRoleContextInput): string {
  return renderDispatchContext("worker", context);
}

function renderDispatchContext(
  kind: "leader" | "worker",
  context: BuildRoleContextInput
): string {
  const profile = context.role;
  const profileLines = [
    `Task: ${context.taskId}`,
    `Role: ${profile.name}`,
    `Active Agent: ${profile.activeAgentId}`,
    profile.description === undefined ? null : `Description: ${profile.description}`,
    ...(profile.responsibilities ?? []).map((item) => `Responsibility: ${item}`),
    ...(profile.constraints ?? []).map((item) => `Constraint: ${item}`),
    profile.expectedOutput === undefined ? null : `Expected output: ${profile.expectedOutput}`,
    profile.systemPrompt === undefined ? null : `Role instruction: ${profile.systemPrompt}`,
    profile.skills === undefined || profile.skills.length === 0
      ? null
      : `Configured role skills: ${profile.skills.join(", ")}`
  ].filter((line): line is string => line !== null);
  const childSections = kind === "leader"
    ? (context.childRoles ?? []).map(renderChildRole)
    : [];

  return [
    readSystemSkill(kind),
    profileLines.join("\n"),
    ...(context.configuredSkillBodies ?? []).map((body) => body.trim()).filter(Boolean),
    ...childSections,
    "TaskMux dispatch:",
    requireText(context.input, "dispatch input")
  ].filter(Boolean).join("\n\n");
}

function renderChildRole(child: ChildRole): string {
  return [
    `Child role: ${child.name}`,
    `Description: ${child.description}`,
    ...child.responsibilities.map((item) => `Responsibility: ${item}`),
    ...child.constraints.map((item) => `Constraint: ${item}`),
    `Expected output: ${child.expectedOutput}`
  ].join("\n");
}

function readConfiguredSkills(skills: readonly string[]): string[] {
  const taskmuxHome = process.env.TASKMUX_HOME;
  if (skills.length === 0) return [];
  if (taskmuxHome === undefined) {
    throw dataError("TASKMUX_HOME is required to load configured Role skills.");
  }
  return skills.map((skill) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skill)) {
      throw dataError(`Invalid configured Skill id: ${skill}`);
    }
    try {
      return readFileSync(join(taskmuxHome, "skills", skill, "SKILL.md"), "utf8").trim();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw dataError(`Configured Skill not found: ${skill}`);
      }
      throw error;
    }
  });
}

function readSystemSkill(kind: "leader" | "worker"): string {
  return readFileSync(
    new URL(`../../skills/taskmux-${kind}/SKILL.md`, import.meta.url),
    "utf8"
  ).trim();
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
