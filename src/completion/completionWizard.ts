import { resolve } from "node:path";
import { usageError } from "../errors/cliError.js";
import type { CliIdentity } from "../cli/completion.js";
import { COMPLETION_SHELLS, type CompletionInstallation, type CompletionShell, type TaskStore } from "../storage/taskStore.js";
import { installCompletion, uninstallCompletion } from "./completionInstaller.js";
import {
  activationBlock,
  activationIsAutomatic,
  currentCompletionShell,
  inspectCompletionStates,
  renderCompletionStateTable,
  shellQuote,
  suggestedCompletionInstallation
} from "./completionState.js";

export type CompletionQuestion = (prompt: string) => Promise<string>;

export type CompletionWizardOptions = {
  width?: number;
  defaultSelection?: "current-shell" | "skip";
};

export async function runCompletionWizard(
  operation: "install" | "uninstall",
  store: TaskStore,
  env: NodeJS.ProcessEnv,
  identity: CliIdentity,
  question: CompletionQuestion,
  options: CompletionWizardOptions = {}
): Promise<string> {
  // Collect storage-backed completion state before awaiting terminal input. A
  // snapshot capability is synchronous and must never span the interaction.
  const states = store.runReadSnapshot((snapshot) =>
    inspectCompletionStates(snapshot.getConfig(), env, identity));
  const current = currentCompletionShell(env);
  const defaultSelection = options.defaultSelection ?? "current-shell";
  const defaultHint = defaultSelection === "skip" ? " [skip]" : current === undefined ? "" : ` [${current}]`;
  const skipHint = defaultSelection === "skip" ? "" : " (or skip)";
  const answer = await question(`${renderCompletionStateTable(states, options.width)}\nChoose shell by number or name${defaultHint}${skipHint}: `);
  const normalizedAnswer = answer.trim().toLowerCase();
  if (normalizedAnswer === "skip" || (normalizedAnswer.length === 0 && defaultSelection === "skip")) {
    return `Completion ${operation} skipped.\n`;
  }
  const shell = parseSelection(answer, current);
  const state = states.find((candidate) => candidate.shell === shell);
  if (state === undefined) throw usageError("Completion shell selection is invalid.");

  if (operation === "uninstall") {
    if (state.installation === undefined) {
      return `Completion ${shell} is not installed.\n`;
    }
    const confirm = (await question(
      `Remove managed ${shell} completion?\nScript: ${state.installation.scriptPath}\nActivation: ${state.installation.activationPath}\nRemove now? [y/N]: `
    )).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") return `Completion ${shell} uninstall skipped.\n`;
    uninstallCompletion(store, shell, identity);
    return `Completion ${shell} uninstalled.\n`;
  }

  const suggested = state.installation ?? suggestedCompletionInstallation(shell, env, identity);
  const automatic = activationIsAutomatic(shell, suggested, env, identity);
  const decision = (await question(
    `Selected: ${shell} (${state.action})\nScript: ${suggested.scriptPath}\nActivation: ${suggested.activationPath}${automatic ? " (automatic)" : " (managed startup block)"}\nInstall using these paths? [Y/n/customize]: `
  )).trim().toLowerCase();
  if (decision === "n" || decision === "no") return `Completion ${shell} installation skipped.\n`;
  let installation: CompletionInstallation = suggested;
  if (decision === "customize") {
    const scriptPath = resolve((await question(`Completion script path [${suggested.scriptPath}]: `)).trim() || suggested.scriptPath);
    const activationPath = resolve((await question(`Activation file path [${suggested.activationPath}]: `)).trim() || suggested.activationPath);
    installation = { scriptPath, activationPath };
  } else if (decision !== "" && decision !== "y" && decision !== "yes") {
    throw usageError("Choose Y, n, or customize.");
  }
  const needsActivation = !activationIsAutomatic(shell, installation, env, identity);
  let activate = false;
  if (needsActivation) {
    const activationAnswer = (await question(
      `${activationBlock(shell, installation, identity)}\nUpdate ${installation.activationPath} with the managed TaskMux block? [Y/n]: `
    )).trim().toLowerCase();
    activate = activationAnswer === "" || activationAnswer === "y" || activationAnswer === "yes";
  }
  installCompletion(store, shell, installation, env, identity, activate);
  if (needsActivation && !activate) {
    return `Completion ${shell} script installed; activation still required.\n`;
  }
  const result = `Completion ${shell} ${state.action.toLowerCase()}ed.\n`;
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
    : `${unchanged}Switch this terminal to ${shell} to activate completion (replaces the current shell process): exec ${shell}\n`;
}

function parseSelection(value: string, current: CompletionShell | undefined): CompletionShell {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 && current !== undefined) return current;
  if (/^[1-3]$/.test(normalized)) return COMPLETION_SHELLS[Number.parseInt(normalized, 10) - 1];
  if (COMPLETION_SHELLS.includes(normalized as CompletionShell)) return normalized as CompletionShell;
  throw usageError("Choose Bash, Zsh, or Fish by number or name.");
}
