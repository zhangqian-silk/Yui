import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentDefinition } from "../agent/agent.js";
import { resolveAgentAdapter } from "../executor/agentAdapter.js";
import {
  classifyRoleAgentSessionResume,
  createRoleAgentSession,
  type RoleAgentSession
} from "../executor/agentExecutor.js";
import { resolveAgentLaunchEnvironment, resolveAgentSessionRoot } from "../executor/executorRegistry.js";
import { activeRoleAgentBinding, type GlobalRole } from "../role/role.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";

export type OperatorLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  explicitEnv: Record<string, string>;
  session: RoleAgentSession | null;
  mode: "new" | "resume";
};

export function prepareGlobalRoleLaunch(
  role: GlobalRole,
  agent: AgentDefinition,
  options: {
    taskmuxHome?: string;
    baseEnv?: NodeJS.ProcessEnv;
    session?: RoleAgentSession | null;
    permissionBroadeningConfirmed?: boolean;
  } = {}
): OperatorLaunch {
  const binding = activeRoleAgentBinding(role);
  if (binding.agentId !== agent.id || binding.adapterId !== agent.adapterId) {
    throw new Error(`Global Role active Agent does not match AgentDefinition: ${role.name}.`);
  }
  const adapter = resolveAgentAdapter(agent.adapterId);
  const canonicalConfig = adapter.canonicalizeConfig(binding.config);
  const now = new Date();
  const installation = adapter.probeInstallation(agent, now);
  if (installation.status !== "installed" &&
    installation.status !== "probe-failed" &&
    installation.status !== "unavailable") {
    throw new Error(installation.reason ?? `Agent installation is unavailable: ${agent.id}.`);
  }
  const snapshot = installation.status === "installed" && installation.version !== undefined
    ? adapter.discoverCapabilities({ agent, version: installation.version, now })
    : {
        ...adapter.unavailableCapabilities(
          { agent, version: adapter.supportedVersion, now },
          installation.reason ?? "Agent installation probe failed."
        ),
        installation
      };
  const inheritedEnvironment = options.baseEnv ?? process.env;
  const agentEnvironment = resolveAgentLaunchEnvironment(agent, inheritedEnvironment);
  const baseEnv = { ...inheritedEnvironment, ...agentEnvironment };
  const existing = options.session ?? null;
  const mode = existing === null || existing.status === "reserved" ? "new" : "resume";
  const compiled = mode === "resume"
    ? adapter.compileResume({
        agent,
        config: canonicalConfig,
        workspace: role.workspace,
        systemPrompt: role.systemPrompt,
        snapshot,
        validationMode: "replay",
        nativeSessionId: requireGlobalSession(role, binding.agentId, binding.adapterId, existing).nativeSessionId
      })
    : adapter.compileNew({
        agent,
        config: canonicalConfig,
        workspace: role.workspace,
        systemPrompt: role.systemPrompt,
        snapshot,
        validationMode: "replay"
      });
  let session = existing;
  let argv = compiled.argv;
  if (mode === "new" && adapter.capabilities.nativeSessionDiscovery === "preallocated") {
    const nativeSessionId = existing?.status === "reserved" ? existing.nativeSessionId : randomUUID();
    session = createRoleAgentSession({
      agentId: binding.agentId,
      adapterId: binding.adapterId,
      nativeSessionId,
      policy: "fixed",
      status: "reserved",
      sessionRoot: resolveAgentSessionRoot(binding.adapterId, baseEnv),
      configFingerprint: compiled.fingerprint,
      permissionEnvelope: adapter.permissionEnvelope(canonicalConfig)
    }, now, existing);
    argv = [...argv, "--session-id", nativeSessionId];
  }
  if (mode === "resume") {
    const current = requireGlobalSession(role, binding.agentId, binding.adapterId, existing);
    if (current.sessionRoot !== resolveAgentSessionRoot(binding.adapterId, baseEnv)) {
      throw new Error(`Native session root changed for Agent: ${current.agentId}.`);
    }
    const permissionEnvelope = adapter.permissionEnvelope(canonicalConfig);
    const assessment = classifyRoleAgentSessionResume(current, compiled.fingerprint, permissionEnvelope);
    if (assessment.decision === "requires-replacement") {
      throw new Error(`Global Role session configuration changed at a session-bound boundary: ${current.agentId}.`);
    }
    if (assessment.decision === "requires-confirmation" && options.permissionBroadeningConfirmed !== true) {
      throw new Error(`Global Role permission change requires explicit confirmation: ${current.agentId}.`);
    }
    session = {
      ...current,
      lastLaunchConfigHash: { ...compiled.fingerprint },
      permissionEnvelope,
      updatedAt: now.toISOString()
    };
  }
  if (role.name !== SYSTEM_OPERATOR_ROLE || options.taskmuxHome === undefined) {
    const nativeSessionRoot = resolveAgentSessionRoot(binding.adapterId, baseEnv);
    const roleEnvironment: Record<string, string> = options.taskmuxHome === undefined ? {} : {
      TASKMUX_HOME: options.taskmuxHome,
      TASKMUX_ROLE: role.name,
      TASKMUX_AGENT_ID: binding.agentId,
      TASKMUX_ADAPTER_ID: binding.adapterId,
      TASKMUX_NATIVE_SESSION_ROOT: nativeSessionRoot,
      TASKMUX_WORKSPACE: role.workspace
    };
    return {
      command: agent.command,
      args: argv,
      env: { ...baseEnv, ...roleEnvironment },
      explicitEnv: { ...agentEnvironment, ...roleEnvironment },
      session,
      mode
    };
  }

  const contextPath = writeOperatorContext(options.taskmuxHome, role.workspace);
  const taskmuxEnv = {
    TASKMUX_HOME: options.taskmuxHome,
    TASKMUX_ROLE: role.name,
    TASKMUX_AGENT_ID: binding.agentId,
    TASKMUX_ADAPTER_ID: binding.adapterId,
    TASKMUX_NATIVE_SESSION_ROOT: resolveAgentSessionRoot(binding.adapterId, baseEnv),
    TASKMUX_WORKSPACE: role.workspace,
    TASKMUX_OPERATOR_CONTEXT: contextPath
  };

  return {
    command: agent.command,
    args: withOperatorPrompt(agent.command, argv, contextPath),
    env: { ...baseEnv, ...taskmuxEnv },
    explicitEnv: { ...agentEnvironment, ...taskmuxEnv },
    session,
    mode
  };
}

function requireGlobalSession(
  role: GlobalRole,
  agentId: string,
  adapterId: string,
  session: RoleAgentSession | null
): RoleAgentSession {
  if (session === null) throw new Error(`No native session is recorded for Global Role: ${role.name}.`);
  if (session.agentId !== agentId || session.adapterId !== adapterId) {
    throw new Error(`Global Role session Agent does not match active binding: ${role.name}.`);
  }
  return session;
}

function writeOperatorContext(taskmuxHome: string, workspace: string): string {
  const operatorDir = join(taskmuxHome, "operator");
  const contextPath = join(operatorDir, "TASKMUX_OPERATOR.md");
  mkdirSync(operatorDir, { recursive: true });
  writeFileSync(contextPath, `${renderOperatorContext(taskmuxHome, workspace)}\n`);
  return contextPath;
}

function renderOperatorContext(taskmuxHome: string, workspace: string): string {
  return `${readOperatorSkill()}

# TaskMux Operator runtime

You are the TaskMux Operator. Act as the user's CLI proxy and manage TaskMux without performing Task work.

Rules:

- Use \`taskmux\` commands to create tasks, list tasks, add roles, bind roles, assign task-local roles, and inspect state.
- Do not edit files under \`TASKMUX_HOME\` directly unless the user explicitly asks for low-level storage repair.
- Prefer \`taskmux task board --with-roles\`, \`taskmux task list\`, \`taskmux role list\`, and \`taskmux config show\` to inspect current state.
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

function withOperatorPrompt(command: string, args: string[], contextPath: string): string[] {
  if (!isCodexCommand(command)) return args;
  return [...args, `You are entering TaskMux Operator mode. Read and follow the instructions in ${contextPath}. Before other work, if CODEX_THREAD_ID is available, run: taskmux role session record "$TASKMUX_ROLE" --native-id "$CODEX_THREAD_ID" --session-root "$TASKMUX_NATIVE_SESSION_ROOT". Use taskmux CLI commands to manage tasks and roles. Do not perform Task work or edit TaskMux JSON storage directly.`];
}

function isCodexCommand(command: string): boolean {
  return basename(command).toLowerCase().replace(/\.(cmd|exe)$/, "") === "codex";
}
