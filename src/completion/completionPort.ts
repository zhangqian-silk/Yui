import type { CliIdentity } from "../cli/completion.js";
import type {
  CompletionAction,
  CompletionInstallation,
  CompletionShell,
  CompletionStatus
} from "./completionState.js";

export type CompletionPortState = Readonly<{
  shell: CompletionShell;
  status: CompletionStatus;
  action: CompletionAction;
  current: boolean;
  configured: boolean;
  activationCurrent: boolean;
  installation: CompletionInstallation;
  suggested: CompletionInstallation;
}>;

export type CompletionOverview = Readonly<{
  identity: CliIdentity;
  currentShell?: CompletionShell;
  states: readonly CompletionPortState[];
}>;

export type CompletionInstallRequest = Readonly<{
  shell: CompletionShell;
  installation: CompletionInstallation;
  activate: boolean;
}>;

export type CompletionPort = Readonly<{
  inspect(): CompletionOverview | PromiseLike<CompletionOverview>;
  install(request: CompletionInstallRequest): void | PromiseLike<void>;
}>;
