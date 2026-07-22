import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlobalRole } from "../role/role.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";

export type OperatorLaunchContext = Readonly<{
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  systemPrompt?: string;
  contextPath?: string;
}>;

/**
 * Prepares durable Operator instructions without turning them into Codex's
 * positional first prompt. Interactive Operator entry must open at the native
 * Agent composer; launch code can pass systemPrompt through an adapter-native
 * instruction channel when one is available.
 */
export function prepareGlobalRoleLaunch(
  role: GlobalRole & Readonly<{
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }>,
  options: { yuiHome?: string; baseEnv?: NodeJS.ProcessEnv } = {}
): OperatorLaunchContext {
  const args = [...(role.args ?? [])];
  const base = mergeEnv(options.baseEnv, role.env ?? {});
  if (role.name !== SYSTEM_OPERATOR_ROLE || options.yuiHome === undefined) {
    return { args, env: base };
  }

  const contextPath = writeOperatorContext(options.yuiHome, role.workspace);
  return {
    args,
    env: mergeEnv(base, {
      YUI_HOME: options.yuiHome,
      YUI_ROLE: role.name,
      YUI_WORKSPACE: role.workspace,
      YUI_OPERATOR_CONTEXT: contextPath
    }),
    systemPrompt: renderOperatorLaunchInstruction(contextPath),
    contextPath
  };
}

export function writeOperatorContext(yuiHome: string, workspace: string): string {
  const operatorDir = join(yuiHome, "operator");
  const contextPath = join(operatorDir, "YUI_OPERATOR.md");
  mkdirSync(operatorDir, { recursive: true });
  writeFileSync(contextPath, `${renderOperatorContext(yuiHome, workspace)}\n`, { mode: 0o600 });
  return contextPath;
}

export function renderOperatorLaunchInstruction(contextPath: string): string {
  return [
    `Read and follow the Yui Operator instructions in ${contextPath}.`,
    "Manage Yui through its CLI; do not perform Task work."
  ].join(" ");
}

function renderOperatorContext(yuiHome: string, workspace: string): string {
  return `${readOperatorSkill()}

# Yui Operator runtime

You are the Yui Operator. Act as the user's CLI proxy and manage Yui without performing Task work.

Rules:

- Use Yui commands to create and inspect Tasks, manage global and Task Roles, choose Agents, and submit user input.
- Do not edit files under YUI_HOME directly.
- Every Task has a protected leader Role; Operator is global and never acts as a Task Leader or Worker.
- Keep native Agent session interaction intact. Do not emulate Agent slash commands or terminal input.

Environment:

- YUI_HOME=${yuiHome}
- YUI_WORKSPACE=${workspace}`;
}

function readOperatorSkill(): string {
  return readFileSync(new URL("../../skills/yui-operator/SKILL.md", import.meta.url), "utf8").trim();
}

function mergeEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  roleEnv: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  return { ...baseEnv, ...roleEnv };
}
