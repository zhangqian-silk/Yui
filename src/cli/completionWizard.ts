import { resolve } from "node:path";

import {
  type CompletionOverview,
  type CompletionPort,
  type CompletionPortState
} from "../completion/completionPort.js";
import {
  COMPLETION_SHELLS,
  activationBlock,
  shellQuote,
  type CompletionAction,
  type CompletionInstallation,
  type CompletionShell,
} from "../completion/completionState.js";
import { renderTable } from "../output/table.js";
import type { SelectionIo } from "./interactiveSelection.js";

export class CompletionWizardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionWizardError";
  }
}

export type CompletionWizardOptions = Readonly<{
  shell?: CompletionShell;
  defaultSelection?: "current-shell" | "skip";
}>;

export async function runCompletionWizard(
  port: CompletionPort,
  io: SelectionIo,
  options: CompletionWizardOptions = {}
): Promise<string> {
  if (!io.interactive || io.json) {
    throw new CompletionWizardError(
      "Completion configuration requires an interactive terminal."
    );
  }

  const overview = await port.inspect();
  const state = options.shell === undefined
    ? await chooseShell(overview, io, options.defaultSelection ?? "current-shell")
    : overview.states.find((candidate) => candidate.shell === options.shell);
  if (state === undefined) {
    return "Completion setup skipped.\n";
  }

  const decision = normalize(await io.question(
    `Selected: ${label(state.shell)} (${state.action})\n`
      + `Script: ${state.installation.scriptPath}\n`
      + `Startup: ${state.installation.activationPath}`
      + `${activationIsAutomatic(state.shell, state.installation, state.suggested)
        ? " (automatic)"
        : " (managed startup block)"}\n`
      + "Use these paths? [Y/n/customize]: "
  ));
  if (decision === "n" || decision === "no") {
    return `Completion ${state.shell} setup skipped.\n`;
  }

  let installation = state.installation;
  let customized = false;
  if (decision === "customize") {
    installation = await customizeInstallation(state.installation, io);
    customized = true;
  } else if (decision !== "" && decision !== "y" && decision !== "yes") {
    throw new CompletionWizardError("Choose Y, n, or customize.");
  }

  const automatic = activationIsAutomatic(state.shell, installation, state.suggested);
  let activate = false;
  let activationReady = automatic;
  if (!automatic) {
    const activationAnswer = normalize(await io.question(
      `${activationBlock(state.shell, installation, overview.identity)}\n`
        + `Update ${installation.activationPath} with this managed Yui block? [Y/n]: `
    ));
    if (
      activationAnswer !== ""
      && activationAnswer !== "y"
      && activationAnswer !== "yes"
      && activationAnswer !== "n"
      && activationAnswer !== "no"
    ) {
      throw new CompletionWizardError("Choose Y or n.");
    }
    activate = activationAnswer === ""
      || activationAnswer === "y"
      || activationAnswer === "yes";
    activationReady = activate || (!customized && state.activationCurrent);
  }

  await port.install({ shell: state.shell, installation, activate });
  if (!activationReady) {
    return `Completion ${state.shell} script installed; startup activation still required.\n`;
  }

  const result = `Completion ${state.shell} ${pastTense(state.action)}.\n`;
  return automatic
    ? result
    : `${result}${activationGuidance(state.shell, installation, state.suggested, overview)}`;
}

async function chooseShell(
  overview: CompletionOverview,
  io: SelectionIo,
  defaultSelection: "current-shell" | "skip"
): Promise<CompletionPortState | undefined> {
  io.write(`${renderCompletionStateTable(overview.states, io.width)}\n\n`);
  const defaultHint = defaultSelection === "skip"
    ? " [skip]"
    : overview.currentShell === undefined ? "" : ` [${overview.currentShell}]`;
  const skipHint = defaultSelection === "skip" ? "" : " (or skip)";
  const answer = normalize(await io.question(
    `Choose shell by number or name${defaultHint}${skipHint}: `
  ));
  if (answer === "skip" || (answer === "" && defaultSelection === "skip")) {
    return undefined;
  }
  const shell = parseShell(answer, overview.currentShell);
  const state = overview.states.find((candidate) => candidate.shell === shell);
  if (state === undefined) throw new CompletionWizardError("Completion shell is unavailable.");
  return state;
}

function renderCompletionStateTable(
  states: readonly CompletionPortState[],
  width: number
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
      label(state.shell),
      state.status,
      state.action,
      state.current ? "yes" : "",
      state.installation.scriptPath
    ]),
    width
  );
}

async function customizeInstallation(
  suggested: CompletionInstallation,
  io: SelectionIo
): Promise<CompletionInstallation> {
  const scriptAnswer = (await io.question(
    `Completion script path [${suggested.scriptPath}]: `
  ))?.trim() ?? "";
  const activationAnswer = (await io.question(
    `Startup file path [${suggested.activationPath}]: `
  ))?.trim() ?? "";
  return Object.freeze({
    scriptPath: resolve(scriptAnswer || suggested.scriptPath),
    activationPath: resolve(activationAnswer || suggested.activationPath)
  });
}

function parseShell(
  value: string,
  current: CompletionShell | undefined
): CompletionShell {
  if (value.length === 0 && current !== undefined) return current;
  if (/^[1-3]$/.test(value)) {
    return COMPLETION_SHELLS[Number.parseInt(value, 10) - 1] as CompletionShell;
  }
  if (COMPLETION_SHELLS.includes(value as CompletionShell)) {
    return value as CompletionShell;
  }
  throw new CompletionWizardError("Choose Bash, Zsh, or Fish by number or name.");
}

function activationGuidance(
  shell: CompletionShell,
  installation: CompletionInstallation,
  suggested: CompletionInstallation,
  overview: CompletionOverview
): string {
  const unchanged = "The current shell is unchanged.\n";
  if (installation.activationPath !== suggested.activationPath) {
    return `${unchanged}Load the custom startup file from ${shell}: source ${shellQuote(installation.activationPath)}\n`;
  }
  return overview.currentShell === shell
    ? `${unchanged}Restart the current shell to activate completion: exec ${shell}\n`
    : `${unchanged}Switch this terminal to ${shell} to activate completion: exec ${shell}\n`;
}

function pastTense(action: CompletionAction): string {
  switch (action) {
    case "Install": return "installed";
    case "Refresh": return "refreshed";
    case "Repair": return "repaired";
  }
}

function label(shell: CompletionShell): string {
  return `${shell[0]?.toUpperCase() ?? ""}${shell.slice(1)}`;
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function activationIsAutomatic(
  shell: CompletionShell,
  installation: CompletionInstallation,
  suggested: CompletionInstallation
): boolean {
  return shell === "fish" && installation.scriptPath === suggested.scriptPath;
}
