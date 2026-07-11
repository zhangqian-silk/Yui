import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { GlobalRole } from "../role/role.js";
import { SYSTEM_ASSISTANT_ROLE, SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import type { RunnerEnvironment } from "../runner/runner.js";

export type AssistantLaunch = {
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function prepareGlobalRoleLaunch(
  role: GlobalRole,
  options: { taskmuxHome?: string; baseEnv?: NodeJS.ProcessEnv } = {}
): AssistantLaunch {
  if (![SYSTEM_OPERATOR_ROLE, SYSTEM_ASSISTANT_ROLE].includes(role.name) || options.taskmuxHome === undefined) {
    return {
      args: role.args,
      env: mergeEnv(options.baseEnv, role.env)
    };
  }

  const contextPath = writeAssistantContext(options.taskmuxHome, role.workspace);
  const taskmuxEnv = {
    TASKMUX_HOME: options.taskmuxHome,
    TASKMUX_ROLE: role.name,
    TASKMUX_WORKSPACE: role.workspace,
    TASKMUX_OPERATOR_CONTEXT: contextPath,
    TASKMUX_ASSISTANT_CONTEXT: contextPath
  };

  return {
    args: withAssistantPrompt(role, contextPath),
    env: mergeEnv(options.baseEnv, role.env, taskmuxEnv)
  };
}

function writeAssistantContext(taskmuxHome: string, workspace: string): string {
  const assistantDir = join(taskmuxHome, "operator");
  const contextPath = join(assistantDir, "TASKMUX_OPERATOR.md");

  mkdirSync(assistantDir, { recursive: true });
  writeFileSync(contextPath, `${renderAssistantContext(taskmuxHome, workspace)}\n`);

  return contextPath;
}

function renderAssistantContext(taskmuxHome: string, workspace: string): string {
  return `${readOperatorSkill()}

# TaskMux Operator runtime

You are the TaskMux Operator. Act as the user's CLI proxy and manage TaskMux without performing Task work.

Rules:

- Use \`taskmux\` commands to create tasks, list tasks, add roles, bind roles, assign task-local roles, and inspect state.
- Do not edit files under \`TASKMUX_HOME\` directly unless the user explicitly asks for low-level storage repair.
- Prefer \`taskmux task board --with-roles\`, \`taskmux task list\`, \`taskmux role list\`, and \`taskmux config show\` to inspect current state.
- When creating a task, use \`taskmux task create "<title>"\` with optional \`--description\`, \`--priority\`, \`--tag\`, and \`--due\`.
- When adding a reusable role preset, use \`taskmux role add <role> --agent <agent-id> --workspace <path>\`.
- When adding a role to one task, use \`taskmux task assign <task-id> <role> --agent <agent-id> --workspace <path>\`.
- When copying a global role preset into a task, use \`taskmux task bind <task-id> <role>\`.
- Every task has a protected \`leader\` role. The global \`operator\` and \`leader\` roles are system roles.
- Use input draft and submit as separate steps unless user intent is already explicit.
- Never act as a Task Leader or independent worker.

Environment:

- TASKMUX_HOME=${taskmuxHome}
- TASKMUX_WORKSPACE=${workspace}
`;
}

function readOperatorSkill(): string {
  return readFileSync(new URL("../../skills/taskmux-operator/SKILL.md", import.meta.url), "utf8").trim();
}

function withAssistantPrompt(role: GlobalRole, contextPath: string): string[] {
  if (!isCodexCommand(role.command) || role.args.length > 0) {
    return role.args;
  }

  return [
    `You are entering TaskMux Operator mode. Read and follow the instructions in ${contextPath}. Use taskmux CLI commands to manage tasks and roles. Do not perform Task work or edit TaskMux JSON storage directly.`
  ];
}

function isCodexCommand(command: string): boolean {
  const commandName = basename(command).toLowerCase().replace(/\.(cmd|exe)$/, "");

  return commandName === "codex";
}

function mergeEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  roleEnv: RunnerEnvironment,
  taskmuxEnv: RunnerEnvironment = {}
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...roleEnv,
    ...taskmuxEnv
  };
}
