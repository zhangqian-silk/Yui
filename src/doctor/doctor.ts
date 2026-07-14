import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fsyncSync, fstatSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderTable } from "../output/table.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import { resolveAgent } from "../agent/agentRegistry.js";
import { FileTaskStore, resolveTaskmuxHome } from "../storage/taskStore.js";
import { inspectStorageSchema, type StorageSchemaState } from "../storage/storageSchema.js";
import {
  acquireStableAncestorExclusiveBarrier,
  inspectDirectoryAt,
  mkdirExactNoReplace,
  publishAnonymousFileNoReplace,
  releaseStableAncestorBarrier,
  type NativeExactIdentity,
  type NativeStableAncestorBarrier
} from "../storage/nativeStorageFs.js";
import type { CommandExecutor } from "../tmux/commandExecutor.js";

const SUPPORTED_NODE_DETAIL = "requires Node.js 20.17+ (20.x), 22.9+ (22.x), or 24.x";
const NATIVE_STORAGE_REQUIREMENT =
  "requires Linux kernel 5.6+ with openat2, filesystem O_TMPFILE plus linkat(..., AT_SYMLINK_FOLLOW) through accessible /proc/self/fd";

export function runDoctor(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  agents: ConfiguredAgent[] = [],
  storageSchema: StorageSchemaState = inspectStorageSchema(resolveTaskmuxHome(env))
): string {
  return renderDoctor(getDoctorChecks(env, executor, agents, storageSchema));
}

export function getDoctorChecks(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  agents: ConfiguredAgent[] = [],
  storageSchema: StorageSchemaState = inspectStorageSchema(resolveTaskmuxHome(env))
): DoctorCheck[] {
  const rootDir = resolveTaskmuxHome(env);
  return [
    checkNode(),
    checkExecutable("tmux", env.TASKMUX_TMUX_BIN ?? "tmux", ["-V"], executor),
    ...agents.map((agent) =>
      checkExecutable(`agent:${agent.id}`, agent.command, ["--version"], executor)
    ),
    checkTaskmuxHome(rootDir),
    checkNativeStorage(rootDir),
    checkDefaultAgent(rootDir, storageSchema, agents),
    checkStorageSchema(storageSchema),
    checkStoragePermissions(rootDir),
    checkStorageRecords(rootDir, storageSchema)
  ];
}

function checkDefaultAgent(rootDir: string, state: StorageSchemaState, agents: ConfiguredAgent[]): DoctorCheck {
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

    if (resolveAgent(config.defaultAgent, agents) === null) {
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
  status: "ok" | "missing" | "unsupported" | "invalid";
  detail: string;
};

function checkNode(): DoctorCheck {
  if (!isSupportedNodeVersion(process.version)) {
    return {
      name: "node",
      status: "unsupported",
      detail: `${process.version}; ${SUPPORTED_NODE_DETAIL}`
    };
  }
  return {
    name: "node",
    status: "ok",
    detail: process.version
  };
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 20) return minor > 17 || (minor === 17 && patch >= 0);
  if (major === 22) return minor > 9 || (minor === 9 && patch >= 0);
  return major === 24;
}

function checkExecutable(
  name: string,
  executable: string,
  args: string[],
  executor: CommandExecutor
): DoctorCheck {
  try {
    return {
      name,
      status: "ok",
      detail: firstLine(executor.run(executable, args))
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

function checkNativeStorage(rootDir: string): DoctorCheck {
  let descriptor = -1;
  let barrier: NativeStableAncestorBarrier | undefined;
  let probeDirectoryPath: string | undefined;
  let probePath: string | undefined;
  let failed = false;
  let failure: unknown;
  const rememberFailure = (error: unknown): void => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };

  try {
    descriptor = openSync(
      rootDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const identity = nativeDescriptorIdentity(descriptor);
    barrier = acquireStableAncestorExclusiveBarrier(descriptor, identity);
    const directoryName = `.taskmux-doctor-native-storage-${randomUUID()}`;
    const candidateProbeDirectoryPath = join(`/proc/self/fd/${descriptor}`, directoryName);
    try {
      mkdirExactNoReplace(barrier, ".", identity, directoryName);
      probeDirectoryPath = candidateProbeDirectoryPath;
    } catch (error) {
      if (nativeMkdirConfirmedProbeDirectory(error)) {
        probeDirectoryPath = candidateProbeDirectoryPath;
      }
      throw error;
    }
    const probeDirectoryIdentity = inspectDirectoryAt(barrier, directoryName);
    if (probeDirectoryIdentity === undefined) {
      throw new Error("Native storage could not inspect TASKMUX_HOME.");
    }
    const fileName = "probe";
    probePath = join(probeDirectoryPath, fileName);
    publishAnonymousFileNoReplace(
      barrier,
      directoryName,
      probeDirectoryIdentity,
      fileName,
      Buffer.alloc(0)
    );
  } catch (error) {
    rememberFailure(error);
  }

  if (probePath !== undefined) {
    try {
      unlinkSync(probePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") rememberFailure(error);
    }
  }
  if (probeDirectoryPath !== undefined) {
    try {
      rmdirSync(probeDirectoryPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") rememberFailure(error);
    }
  }
  if (descriptor >= 0) {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      rememberFailure(error);
    }
  }
  if (barrier !== undefined) {
    try {
      releaseStableAncestorBarrier(barrier);
    } catch (error) {
      rememberFailure(error);
    }
  }
  if (descriptor >= 0) {
    try {
      closeSync(descriptor);
    } catch (error) {
      rememberFailure(error);
    }
  }

  if (failed) return nativeStorageFailure(failure);
  return {
    name: "native storage",
    status: "ok",
    detail: `openat2 + O_TMPFILE + /proc/self/fd linkat verified for ${rootDir}`
  };
}

function nativeDescriptorIdentity(descriptor: number): NativeExactIdentity {
  const identity = fstatSync(descriptor, { bigint: true });
  return Object.freeze({
    dev: identity.dev,
    ino: identity.ino,
    uid: identity.uid,
    mode: identity.mode,
    nlink: identity.nlink,
    birthtimeNs: identity.birthtimeNs
  });
}

function nativeStorageFailure(error: unknown): DoctorCheck {
  const code = errorCode(error);
  if (code === "ENOENT") {
    return {
      name: "native storage",
      status: "missing",
      detail: "run taskmux setup"
    };
  }
  if (code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS") {
    return {
      name: "native storage",
      status: "unsupported",
      detail: `${NATIVE_STORAGE_REQUIREMENT}; ${code}`
    };
  }
  return {
    name: "native storage",
    status: "invalid",
    detail: errorMessage(error)
  };
}

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function nativeMkdirConfirmedProbeDirectory(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const stage = "stage" in error && typeof error.stage === "string" ? error.stage : undefined;
  const state = "state" in error && typeof error.state === "string" ? error.state : undefined;
  return stage === "verify-directory" ||
    stage === "open-created" ||
    stage === "fsync-parent" ||
    state === "published-not-durable";
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
    const agentCount = store.listConfiguredAgents().length;
    const globalRoleCount = store.listGlobalRoles().length;

    return {
      name: "storage records",
      status: "ok",
      detail: `tasks=${tasks.length} roles=${roleCount} globalRoles=${globalRoleCount} agents=${agentCount}`
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
