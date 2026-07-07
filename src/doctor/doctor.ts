import { accessSync, constants } from "node:fs";
import { renderTable } from "../output/table.js";
import type { CustomRunner } from "../runner/runner.js";
import { resolveRunner } from "../runner/runnerRegistry.js";
import { FileTaskStore, resolveTaskmuxHome } from "../storage/taskStore.js";
import { inspectStorageSchema, type StorageSchemaState } from "../storage/storageSchema.js";
import type { CommandRunner } from "../tmux/commandRunner.js";

export function runDoctor(
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
  customRunners: CustomRunner[] = [],
  storageSchema: StorageSchemaState = inspectStorageSchema(resolveTaskmuxHome(env))
): string {
  return renderDoctor(getDoctorChecks(env, runner, customRunners, storageSchema));
}

export function getDoctorChecks(
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
  customRunners: CustomRunner[] = [],
  storageSchema: StorageSchemaState = inspectStorageSchema(resolveTaskmuxHome(env))
): DoctorCheck[] {
  return [
    checkNode(),
    checkExecutable("tmux", env.TASKMUX_TMUX_BIN ?? "tmux", ["-V"], runner),
    ...customRunners.map((customRunner) =>
      checkExecutable(`agent:${customRunner.id}`, customRunner.command, ["--version"], runner)
    ),
    checkTaskmuxHome(resolveTaskmuxHome(env)),
    checkDefaultAgent(resolveTaskmuxHome(env), storageSchema, customRunners),
    checkStorageSchema(storageSchema),
    checkStoragePermissions(resolveTaskmuxHome(env)),
    checkStorageRecords(resolveTaskmuxHome(env), storageSchema)
  ];
}

function checkDefaultAgent(rootDir: string, state: StorageSchemaState, customRunners: CustomRunner[]): DoctorCheck {
  if (state.status === "upgrade-required") {
    return {
      name: "default agent",
      status: "upgrade-required",
      detail: "run taskmux migrate"
    };
  }

  if (state.status === "unsupported") {
    return {
      name: "default agent",
      status: "unsupported",
      detail: `current=${state.currentVersion} latest=${state.latestVersion}`
    };
  }

  if (state.status === "invalid") {
    return {
      name: "default agent",
      status: "invalid",
      detail: state.detail
    };
  }

  try {
    const config = new FileTaskStore(rootDir).getConfig();

    if (config.defaultAgent === undefined || config.defaultAgent.length === 0) {
      return {
        name: "default agent",
        status: "missing",
        detail: "run taskmux setup"
      };
    }

    if (resolveRunner(config.defaultAgent, customRunners) === null) {
      return {
        name: "default agent",
        status: "invalid",
        detail: `${config.defaultAgent} is not configured`
      };
    }

    return {
      name: "default agent",
      status: "ok",
      detail: config.defaultAgent
    };
  } catch (error) {
    return {
      name: "default agent",
      status: "invalid",
      detail: errorMessage(error)
    };
  }
}

export function renderDoctor(checks: DoctorCheck[]): string {
  return `TaskMux doctor\n${renderTable(
    "Checks",
    [
      { header: "Check", minWidth: 8, maxWidth: 22 },
      { header: "Status", minWidth: 7, maxWidth: 16 },
      { header: "Detail", minWidth: 12, maxWidth: 88 }
    ],
    checks.map((check) => [check.name, check.status, check.detail]),
    Math.max(54, Math.min(process.stdout.columns ?? 100, 140))
  )}\n`;
}

export type DoctorCheck = {
  name: string;
  status: "ok" | "missing" | "upgrade-required" | "unsupported" | "invalid";
  detail: string;
};

function checkNode(): DoctorCheck {
  return {
    name: "node",
    status: "ok",
    detail: process.version
  };
}

function checkExecutable(
  name: string,
  executable: string,
  args: string[],
  runner: CommandRunner
): DoctorCheck {
  try {
    return {
      name,
      status: "ok",
      detail: firstLine(runner.run(executable, args))
    };
  } catch {
    return {
      name,
      status: "missing",
      detail: executable
    };
  }
}

function firstLine(output: string): string {
  return output.trim().split("\n")[0] ?? "";
}

function checkTaskmuxHome(rootDir: string): DoctorCheck {
  try {
    accessSync(rootDir, constants.R_OK);

    return {
      name: "taskmux home",
      status: "ok",
      detail: rootDir
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        name: "taskmux home",
        status: "missing",
        detail: "run taskmux setup"
      };
    }

    return {
      name: "taskmux home",
      status: "invalid",
      detail: errorMessage(error)
    };
  }
}

function checkStorageSchema(state: StorageSchemaState): DoctorCheck {
  switch (state.status) {
    case "uninitialized":
      return {
        name: "storage schema",
        status: "missing",
        detail: "run taskmux setup"
      };
    case "current":
      return {
        name: "storage schema",
        status: "ok",
        detail: `current=${state.currentVersion} latest=${state.latestVersion}`
      };
    case "upgrade-required":
      return {
        name: "storage schema",
        status: "upgrade-required",
        detail: `current=${state.currentVersion} latest=${state.latestVersion}; run taskmux migrate`
      };
    case "unsupported":
      return {
        name: "storage schema",
        status: "unsupported",
        detail: `current=${state.currentVersion} latest=${state.latestVersion}`
      };
    case "invalid":
      return {
        name: "storage schema",
        status: "invalid",
        detail: state.detail
      };
  }
}

function checkStoragePermissions(rootDir: string): DoctorCheck {
  try {
    accessSync(rootDir, constants.R_OK | constants.W_OK);

    return {
      name: "storage permissions",
      status: "ok",
      detail: "read-write"
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        name: "storage permissions",
        status: "missing",
        detail: "run taskmux setup"
      };
    }

    return {
      name: "storage permissions",
      status: "invalid",
      detail: errorMessage(error)
    };
  }
}

function checkStorageRecords(rootDir: string, state: StorageSchemaState): DoctorCheck {
  if (state.status === "uninitialized") {
    return {
      name: "storage records",
      status: "missing",
      detail: "run taskmux setup"
    };
  }

  if (state.status === "upgrade-required") {
    return {
      name: "storage records",
      status: "upgrade-required",
      detail: "run taskmux migrate"
    };
  }

  if (state.status === "unsupported") {
    return {
      name: "storage records",
      status: "unsupported",
      detail: `current=${state.currentVersion} latest=${state.latestVersion}`
    };
  }

  if (state.status === "invalid") {
    return {
      name: "storage records",
      status: "invalid",
      detail: state.detail
    };
  }

  try {
    const store = new FileTaskStore(rootDir);
    const tasks = store.listTasks();
    const roleCount = tasks.reduce((count, task) => count + store.listRoles(task.id).length, 0);
    const runnerCount = store.listCustomRunners().length;
    const globalRoleCount = store.listGlobalRoles().length;

    return {
      name: "storage records",
      status: "ok",
      detail: `tasks=${tasks.length} roles=${roleCount} globalRoles=${globalRoleCount} agents=${runnerCount}`
    };
  } catch (error) {
    return {
      name: "storage records",
      status: "invalid",
      detail: errorMessage(error)
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
