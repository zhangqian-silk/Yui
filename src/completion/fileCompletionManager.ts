import type { CliIdentity } from "../cli/completion.js";
import type {
  CompletionInstallRequest,
  CompletionOverview,
  CompletionPort,
  CompletionPortState
} from "./completionPort.js";
import { installCompletion, type CompletionStore } from "./completionInstaller.js";
import {
  COMPLETION_SHELLS,
  completionActivationIsCurrent,
  completionScriptIsCurrent,
  currentCompletionShell,
  suggestedCompletionInstallation,
  type CompletionAction,
  type CompletionStatus
} from "./completionState.js";

/** FileTaskStore-backed completion port used by the interactive CLI wizard. */
export class FileCompletionManager implements CompletionPort {
  readonly #store: CompletionStore;
  readonly #env: NodeJS.ProcessEnv;
  readonly #identity: CliIdentity;

  constructor(
    store: CompletionStore,
    env: NodeJS.ProcessEnv,
    identity: CliIdentity
  ) {
    this.#store = store;
    this.#env = { ...env };
    this.#identity = identity;
  }

  inspect(): CompletionOverview {
    const config = this.#store.getConfig();
    const currentShell = currentCompletionShell(this.#env);
    const states = COMPLETION_SHELLS.map((shell): CompletionPortState => {
      const suggested = suggestedCompletionInstallation(shell, this.#env, this.#identity);
      const stored = config.completionInstallations?.[shell];
      const installation = stored ?? suggested;
      const scriptCurrent = completionScriptIsCurrent(shell, installation, this.#identity);
      const activationCurrent = completionActivationIsCurrent(
        shell,
        installation,
        this.#env,
        this.#identity
      );
      const status: CompletionStatus = scriptCurrent && activationCurrent
        ? "Installed"
        : stored === undefined ? "Not installed" : "Needs repair";
      const action: CompletionAction = status === "Installed"
        ? "Refresh"
        : status === "Needs repair" ? "Repair" : "Install";
      return Object.freeze({
        shell,
        status,
        action,
        current: shell === currentShell,
        configured: stored !== undefined,
        activationCurrent,
        installation,
        suggested
      });
    });
    return Object.freeze({
      identity: this.#identity,
      ...(currentShell === undefined ? {} : { currentShell }),
      states: Object.freeze(states)
    });
  }

  install(request: CompletionInstallRequest): void {
    installCompletion(
      this.#store,
      request.shell,
      request.installation,
      this.#env,
      this.#identity,
      request.activate
    );
  }
}

export function resolveCliIdentity(env: NodeJS.ProcessEnv): CliIdentity {
  return env.TASKMUX_CLI_NAME === "taskmux-dev" ? "taskmux-dev" : "taskmux";
}
