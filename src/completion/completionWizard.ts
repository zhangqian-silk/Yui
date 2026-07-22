import { resolve } from "node:path";

import type { CliIdentity } from "../cli/completion.js";
import { usageError } from "../errors/cliError.js";
import { installCompletion, uninstallCompletion, type CompletionStore } from "./completionInstaller.js";
import {
  COMPLETION_SHELLS,
  activationBlock,
  activationIsAutomatic,
  currentCompletionShell,
  inspectCompletionStates,
  renderCompletionStateTable,
  shellQuote,
  suggestedCompletionInstallation,
  type CompletionInstallation,
  type CompletionShell
} from "./completionState.js";

export type CompletionQuestion = (prompt: string) => Promise<string>;

export type CompletionWizardOptions = Readonly<{
  width?: number;
  defaultSelection?: "current-shell" | "skip";
  shell?: CompletionShell;
}>;

export async function runCompletionWizard(
  operation: "install" | "uninstall",
  store: CompletionStore,
  env: NodeJS.ProcessEnv,
  identity: CliIdentity,
  question: CompletionQuestion,
  options: CompletionWizardOptions = {}
): Promise<string> {
  const states = inspectCompletionStates(store.getConfig(), env, identity);
  const current = currentCompletionShell(env);
  let shell: CompletionShell;
  if (options.shell === undefined) {
    const defaultSelection = options.defaultSelection ?? "current-shell";
    const defaultHint = defaultSelection === "skip"
      ? " [skip]"
      : current === undefined ? "" : ` [${current}]`;
    const skipHint = defaultSelection === "skip" ? "" : " (or skip)";
    const answer = await question(
      `${renderCompletionStateTable(states, options.width)}\n`
        + `Choose shell by number or name${defaultHint}${skipHint}: `
    );
    const normalized = answer.trim().toLowerCase();
    if (normalized === "skip" || (normalized.length === 0 && defaultSelection === "skip")) {
      return `Completion ${operation} skipped.\n`;
    }
    shell = parseSelection(answer, current);
  } else {
    shell = options.shell;
  }

  const state = states.find((candidate) => candidate.shell === shell);
  if (state === undefined) throw usageError("Completion shell selection is invalid.");

  if (operation === "uninstall") {
    if (state.installation === undefined) {
      return `Completion ${shell} is not installed.\n`;
    }
    const confirm = normalize(await question(
      `Remove managed ${shell} completion?\n`
        + `Script: ${state.installation.scriptPath}\n`
        + `Activation: ${state.installation.activationPath}\n`
        + "Remove now? [y/N]: "
    ));
    if (confirm !== "y" && confirm !== "yes") {
      return `Completion ${shell} uninstall skipped.\n`;
    }
    uninstallCompletion(store, shell, identity);
    return `Completion ${shell} uninstalled.\n`;
  }

  const suggested = state.installation
    ?? suggestedCompletionInstallation(shell, env, identity);
  const automatic = activationIsAutomatic(shell, suggested, env, identity);
  const decision = normalize(await question(
    `Selected: ${shell} (${state.action})\n`
      + `Script: ${suggested.scriptPath}\n`
      + `Activation: ${suggested.activationPath}`
      + `${automatic ? " (automatic)" : " (managed startup block)"}\n`
      + "Install using these paths? [Y/n/customize]: "
  ));
  if (decision === "n" || decision === "no") {
    return `Completion ${shell} installation skipped.\n`;
  }

  let installation: CompletionInstallation = suggested;
  let customized = false;
  if (decision === "customize") {
    const scriptPath = resolve(
      (await question(`Completion script path [${suggested.scriptPath}]: `)).trim()
        || suggested.scriptPath
    );
    const activationPath = resolve(
      (await question(`Activation file path [${suggested.activationPath}]: `)).trim()
        || suggested.activationPath
    );
    installation = { scriptPath, activationPath };
    customized = true;
  } else if (decision !== "" && decision !== "y" && decision !== "yes") {
    throw usageError("Choose Y, n, or customize.");
  }

  const needsActivation = !activationIsAutomatic(shell, installation, env, identity);
  let activate = false;
  let activationReady = !needsActivation;
  if (needsActivation) {
    const activationAnswer = normalize(await question(
      `${activationBlock(shell, installation, identity)}\n`
        + `Update ${installation.activationPath} with the managed Yui block? [Y/n]: `
    ));
    if (
      activationAnswer !== ""
      && activationAnswer !== "y"
      && activationAnswer !== "yes"
      && activationAnswer !== "n"
      && activationAnswer !== "no"
    ) {
      throw usageError("Choose Y or n.");
    }
    activate = activationAnswer === ""
      || activationAnswer === "y"
      || activationAnswer === "yes";
    activationReady = activate || (!customized && state.status === "Installed");
  }

  installCompletion(store, shell, installation, env, identity, activate);
  if (!activationReady) {
    return `Completion ${shell} script installed; activation still required.\n`;
  }
  const result = `Completion ${shell} ${pastTense(state.action)}.\n`;
  return needsActivation
    ? `${result}${activationGuidance(shell, installation, env, identity)}`
    : result;
}

function activationGuidance(
  shell: CompletionShell,
  installation: CompletionInstallation,
  env: NodeJS.ProcessEnv,
  identity: CliIdentity
): string {
  const unchanged = "The current shell is unchanged.\n";
  const defaultActivationPath = suggestedCompletionInstallation(shell, env, identity).activationPath;
  if (installation.activationPath !== defaultActivationPath) {
    return `${unchanged}From a ${shell} session, load the custom activation file: source ${shellQuote(installation.activationPath)}\n`;
  }
  return currentCompletionShell(env) === shell
    ? `${unchanged}Restart the current shell to activate completion: exec ${shell}\n`
    : `${unchanged}Switch this terminal to ${shell} to activate completion: exec ${shell}\n`;
}

function parseSelection(value: string, current: CompletionShell | undefined): CompletionShell {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 && current !== undefined) return current;
  if (/^[1-3]$/.test(normalized)) {
    return COMPLETION_SHELLS[Number.parseInt(normalized, 10) - 1] as CompletionShell;
  }
  if (COMPLETION_SHELLS.includes(normalized as CompletionShell)) {
    return normalized as CompletionShell;
  }
  throw usageError("Choose Bash, Zsh, or Fish by number or name.");
}

function pastTense(action: "Refresh" | "Install" | "Repair"): string {
  switch (action) {
    case "Install": return "installed";
    case "Refresh": return "refreshed";
    case "Repair": return "repaired";
  }
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
