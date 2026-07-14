import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataError } from "../errors/cliError.js";
import type { Role } from "../role/role.js";
import { resolveTaskmuxHome, type TaskReader } from "../storage/taskStore.js";

export function compileDispatchInput(
  store: TaskReader,
  taskId: string,
  role: Role,
  input: string
): string {
  const systemSkill = readSystemSkill(role.name === "leader" ? "taskmux-leader" : "taskmux-worker");
  const profileLines = [
    role.description === undefined ? null : `Description: ${role.description}`,
    ...(role.responsibilities ?? []).map((item) => `Responsibility: ${item}`),
    ...(role.constraints ?? []).map((item) => `Constraint: ${item}`),
    role.expectedOutput === undefined ? null : `Expected output: ${role.expectedOutput}`,
    role.systemPrompt === undefined ? null : `Role instruction: ${role.systemPrompt}`,
    role.skills === undefined || role.skills.length === 0
      ? null
      : `Configured role skills: ${role.skills.join(", ")}`
  ].filter((line): line is string => line !== null);
  const childSections = store.listChildRoles(taskId)
    .filter((child) => child.parentRole === role.name)
    .map((child) => [
      `Child role constraint: ${child.name}`,
      `Description: ${child.description}`,
      ...child.responsibilities.map((item) => `Responsibility: ${item}`),
      ...child.constraints.map((item) => `Constraint: ${item}`),
      `Expected output: ${child.expectedOutput}`
    ].join("\n"));
  const configuredSkills = readConfiguredSkills(role.skills ?? []);
  const sessionRegistration = role.agent === "codex"
    ? [
        "Native session bookkeeping:",
        "Before doing Task work, if CODEX_THREAD_ID is available, register it with:",
        "taskmux task session record \"$TASKMUX_TASK_ID\" \"$TASKMUX_ROLE\" --native-id \"$CODEX_THREAD_ID\""
      ].join("\n")
    : null;

  return [
    systemSkill,
    ...profileLines,
    ...configuredSkills,
    ...childSections,
    ...(sessionRegistration === null ? [] : [sessionRegistration]),
    "TaskMux dispatch:",
    input
  ].join("\n\n");
}

function readConfiguredSkills(skills: string[]): string[] {
  const taskmuxHome = resolveTaskmuxHome(process.env);
  return skills.map((skill) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(skill)) {
      throw dataError(`Invalid configured Skill id: ${skill}`);
    }
    const path = join(taskmuxHome, "skills", skill, "SKILL.md");
    try {
      return readFileSync(path, "utf8").trim();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw dataError(`Configured Skill not found: ${skill}`);
      }
      throw error;
    }
  });
}

function readSystemSkill(name: "taskmux-leader" | "taskmux-worker"): string {
  return readFileSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8").trim();
}
