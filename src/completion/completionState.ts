import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { CliIdentity } from "../cli/completion.js";
import { renderCompletion } from "../cli/completion.js";
import { dataError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";

export const COMPLETION_SHELLS = Object.freeze(["bash", "zsh", "fish"] as const);

export type CompletionShell = typeof COMPLETION_SHELLS[number];
export type CompletionStatus = "Installed" | "Not installed" | "Needs repair";
export type CompletionAction = "Refresh" | "Install" | "Repair";

export type CompletionInstallation = Readonly<{
  scriptPath: string;
  activationPath: string;
}>;

export type CompletionConfig = Readonly<{
  schemaVersion?: number;
  defaultAgent?: string;
  defaultWorkspace?: string;
  completionInstallations?: Partial<Record<CompletionShell, CompletionInstallation>>;
}>;

export type CompletionState = Readonly<{
  shell: CompletionShell;
  status: CompletionStatus;
  action: CompletionAction;
  current: boolean;
  installation?: CompletionInstallation;
}>;

export function currentCompletionShell(env: NodeJS.ProcessEnv): CompletionShell | undefined {
  const value = basename(env.SHELL ?? "").toLowerCase();
  return COMPLETION_SHELLS.includes(value as CompletionShell)
    ? value as CompletionShell
    : undefined;
}

export function suggestedCompletionInstallation(
  shell: CompletionShell,
  env: NodeJS.ProcessEnv,
  identity: CliIdentity
): CompletionInstallation {
  const home = absoluteEnvRoot("HOME", env.HOME);
  if (shell === "bash") {
    const data = env.XDG_DATA_HOME === undefined
      ? join(home, ".local", "share")
      : absoluteEnvRoot("XDG_DATA_HOME", env.XDG_DATA_HOME);
    return {
      scriptPath: join(data, "bash-completion", "completions", identity),
      activationPath: join(home, ".bashrc")
    };
  }
  if (shell === "zsh") {
    const zshRoot = env.ZDOTDIR === undefined
      ? home
      : absoluteEnvRoot("ZDOTDIR", env.ZDOTDIR);
    return {
      scriptPath: join(zshRoot, ".zfunc", `_${identity}`),
      activationPath: join(zshRoot, ".zshrc")
    };
  }
  const config = env.XDG_CONFIG_HOME === undefined
    ? join(home, ".config")
    : absoluteEnvRoot("XDG_CONFIG_HOME", env.XDG_CONFIG_HOME);
  return {
    scriptPath: join(config, "fish", "completions", `${identity}.fish`),
    activationPath: join(config, "fish", "config.fish")
  };
}

export function inspectCompletionStates(
  config: CompletionConfig,
  env: NodeJS.ProcessEnv,
  identity: CliIdentity
): CompletionState[] {
  const current = currentCompletionShell(env);
  return COMPLETION_SHELLS.map((shell) => {
    const installation = config.completionInstallations?.[shell];
    if (installation === undefined) {
      return {
        shell,
        status: "Not installed",
        action: "Install",
        current: shell === current
      };
    }
    const installed = completionScriptIsCurrent(shell, installation, identity)
      && completionActivationIsCurrent(shell, installation, env, identity);
    return {
      shell,
      status: installed ? "Installed" : "Needs repair",
      action: installed ? "Refresh" : "Repair",
      current: shell === current,
      installation
    };
  });
}

export function renderCompletionStateTable(
  states: readonly CompletionState[],
  width = defaultTableWidth()
): string {
  return renderTable(
    "Completion installation",
    [
      { header: "#", minWidth: 1, maxWidth: 3 },
      { header: "Shell", minWidth: 4, maxWidth: 6 },
      { header: "Status", minWidth: 12, maxWidth: 13 },
      { header: "Action", minWidth: 7, maxWidth: 7 },
      { header: "Current", minWidth: 7, maxWidth: 7 },
      { header: "Script", minWidth: 8, maxWidth: 88 }
    ],
    states.map((state, index) => [
      String(index + 1),
      shellLabel(state.shell),
      state.status,
      state.action,
      state.current ? "yes" : "",
      state.installation?.scriptPath ?? ""
    ]),
    width
  );
}

export function managedCompletionScript(
  shell: CompletionShell,
  identity: CliIdentity
): string {
  return `${completionMarker(shell, identity)}\n${renderCompletion(shell, identity)}`;
}

export function completionMarker(shell: CompletionShell, identity: CliIdentity): string {
  return `# yui-completion: managed shell=${shell} identity=${identity} format=1`;
}

export function activationBlock(
  shell: CompletionShell,
  installation: CompletionInstallation,
  identity: CliIdentity
): string {
  const start = activationStart(shell, identity);
  const end = activationEnd(shell, identity);
  const source = `source ${shellQuote(installation.scriptPath)}`;
  const functionName = basename(installation.scriptPath);
  const body = shell === "zsh"
    ? `fpath=(${shellQuote(dirname(installation.scriptPath))} $fpath)\nautoload -Uz compinit\n(( $+functions[compdef] )) || compinit\nautoload -Uz -- ${shellQuote(functionName)}\ncompdef ${shellQuote(functionName)} ${shellQuote(identity)}`
    : source;
  return `${start}\n${body}\n${end}`;
}

export function activationStart(shell: CompletionShell, identity: CliIdentity): string {
  return `# >>> yui completion shell=${shell} identity=${identity} >>>`;
}

export function activationEnd(shell: CompletionShell, identity: CliIdentity): string {
  return `# <<< yui completion shell=${shell} identity=${identity} <<<`;
}

export function activationIsAutomatic(
  shell: CompletionShell,
  installation: CompletionInstallation,
  env: NodeJS.ProcessEnv,
  identity: CliIdentity
): boolean {
  return shell === "fish"
    && installation.scriptPath === suggestedCompletionInstallation(shell, env, identity).scriptPath;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function completionScriptIsCurrent(
  shell: CompletionShell,
  installation: CompletionInstallation,
  identity: CliIdentity
): boolean {
  return safeRegularFile(installation.scriptPath)
    && readFileSync(installation.scriptPath, "utf8") === managedCompletionScript(shell, identity);
}

export function completionActivationIsCurrent(
  shell: CompletionShell,
  installation: CompletionInstallation,
  env: NodeJS.ProcessEnv,
  identity: CliIdentity
): boolean {
  if (activationIsAutomatic(shell, installation, env, identity)) return true;
  if (!safeRegularFile(installation.activationPath)) return false;
  const contents = readFileSync(installation.activationPath, "utf8");
  const block = activationBlock(shell, installation, identity);
  return contents.split(block).length === 2;
}

function safeRegularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

function absoluteEnvRoot(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0 || !isAbsolute(value)) {
    throw dataError(`${name} must be an absolute path for completion installation.`);
  }
  return resolve(value);
}

function shellLabel(shell: CompletionShell): string {
  return `${shell[0]?.toUpperCase() ?? ""}${shell.slice(1)}`;
}
