import type { AgentAdapterId } from "./adapterCatalog.js";
import {
  resolveAgentEnvironment,
  type ConfiguredAgent
} from "./agent.js";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { usableInteractiveTerminal } from "../output/terminal.js";

/**
 * Non-secret process context needed by native Agent CLIs after tmux starts
 * them with an empty environment. Keep this list explicit: arbitrary parent
 * variables can contain credentials belonging to a different Agent.
 */
export const AGENT_OPERATIONAL_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TMUX_TMPDIR",
  "TERM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_ADDRESS",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NAME",
  "LC_NUMERIC",
  "LC_PAPER",
  "LC_TELEPHONE",
  "LC_TIME",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "SSH_AUTH_SOCK"
] as const;

export const NATIVE_AGENT_ENVIRONMENT_NAMES = [
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR"
] as const;

/** Control-plane values owned by Yui, never by user Agent source bindings. */
export const YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES = [
  "YUI_HOME",
  "YUI_SESSION_SCOPE",
  "YUI_TASK_ID",
  "YUI_ROLE",
  "YUI_AGENT_ID",
  "YUI_ADAPTER_ID",
  "YUI_WORKSPACE",
  "YUI_RUN_ID",
  "YUI_LAUNCH_ID",
  "YUI_NATIVE_SESSION_ID",
  "YUI_CONTROL_PLANE_DESCRIPTOR",
  "YUI_TASK_RUNTIME_DESCRIPTOR",
  "YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR",
  "YUI_TASK_RUNTIME_SERVICE_NAMESPACE"
] as const;

export function nativeAgentEnvironmentNames(
  adapterId: AgentAdapterId
): readonly string[] {
  switch (adapterId) {
    case "codex": return ["CODEX_HOME"];
    case "claude": return ["CLAUDE_CONFIG_DIR"];
  }
}

export function selectEnvironment(
  source: NodeJS.ProcessEnv,
  names: Iterable<string>
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

function selectNonEmptyEnvironment(
  source: NodeJS.ProcessEnv,
  names: Iterable<string>
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value.length > 0) selected[name] = value;
  }
  return selected;
}

export function operationalAgentEnvironment(
  adapterId: AgentAdapterId,
  source: NodeJS.ProcessEnv
): Record<string, string> {
  return {
    ...selectNonEmptyEnvironment(source, [
      ...AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
      ...nativeAgentEnvironmentNames(adapterId)
    ]),
    PATH: source.PATH
      || `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: source.HOME || homedir(),
    TERM: usableInteractiveTerminal(source.TERM),
    TMPDIR: source.TMPDIR || tmpdir()
  };
}

export function configuredAgentLaunchEnvironment(
  agent: ConfiguredAgent,
  source: NodeJS.ProcessEnv
): Record<string, string> {
  const {
    SSH_AUTH_SOCK: _sshAgent,
    ...operational
  } = operationalAgentEnvironment(agent.adapterId, source);
  return {
    ...operational,
    ...resolveAgentEnvironment(agent, source)
  };
}
