import { usageError } from "../errors/cliError.js";
import type { GitWorkspacePort } from "../repository/gitWorkspace.js";
import {
  inspectTaskBaseFreshness,
  renderTaskBaseFreshnessReport
} from "../repository/taskBaseFreshness.js";
import type { TaskStore } from "../storage/taskStore.js";

export type TaskBaseCommandOptions = Readonly<{
  git?: GitWorkspacePort;
}>;

export type TaskBaseCommandExecution = Readonly<{
  kind: "output";
  output: string;
  data?: unknown;
}>;

export async function runTaskBaseStatusCommand(
  args: readonly string[],
  store: TaskStore,
  options: TaskBaseCommandOptions = {}
): Promise<TaskBaseCommandExecution> {
  const usage = "Task base status usage: yui task base status <task> [--refresh].";
  const refresh = args.includes("--refresh");
  const positionals = args.filter((arg) => arg !== "--refresh");
  if (positionals.length !== 1 || positionals[0]?.trim() === "") {
    throw usageError(usage);
  }
  const report = await inspectTaskBaseFreshness(positionals[0]!, store, {
    git: options.git,
    refresh
  });
  return {
    kind: "output",
    output: renderTaskBaseFreshnessReport(report),
    data: report
  };
}
