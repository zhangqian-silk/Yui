import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fsyncSync, fstatSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { renderTable } from "../output/table.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import { resolveAgent } from "../agent/agentRegistry.js";
import {
  assertTaskmuxHomeReady,
  FileTaskStore,
  inspectTaskmuxHome,
  resolveTaskmuxHome,
  type TaskmuxConfig
} from "../storage/taskStore.js";
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
  "requires storage capabilities from an upstream Linux kernel 5.6+ or a compatible vendor backport: openat2, filesystem statx(..., STATX_BTIME) birth-time support, O_TMPFILE plus linkat(..., AT_SYMLINK_FOLLOW) through accessible /proc/self/fd";
const TASKMUX_HOME_PROCFD_ERROR_KIND = "taskmux-home-procfd";
const TASKMUX_HOME_MODE = 0o700n;
const TASKMUX_HOME_REQUIREMENT =
  "TASKMUX_HOME must be an owned real directory with exact mode 0700.";

export function runDoctor(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  storageSchema: StorageSchemaState = inspectStorageSchema(resolveTaskmuxHome(env))
): string {
  return renderDoctor(getDoctorChecks(env, executor, storageSchema));
}

export function getDoctorChecks(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  storageSchema: StorageSchemaState = inspectStorageSchema(resolveTaskmuxHome(env))
): DoctorCheck[] {
  const rootDir = resolveTaskmuxHome(env);
  const taskmuxHome = checkTaskmuxHome(rootDir);
  const taskmuxHomeReady = taskmuxHome.status === "ok";
  const storageFacts = taskmuxHomeReady
    ? readDoctorStorageFacts(rootDir, storageSchema)
    : undefined;
  const agents = storageFacts?.kind === "data" ? storageFacts.agents : [];
  return [
    checkNode(),
    checkExecutable("tmux", env.TASKMUX_TMUX_BIN ?? "tmux", ["-V"], executor),
    ...agents.map((agent) =>
      checkExecutable(`agent:${agent.id}`, agent.command, ["--version"], executor)
    ),
    taskmuxHome,
    checkNativeStorage(rootDir),
    taskmuxHomeReady
      ? checkDefaultAgent(storageSchema, storageFacts)
      : taskmuxHomeBlockedCheck("default agent", taskmuxHome),
    checkStorageSchema(storageSchema),
    taskmuxHomeReady
      ? checkStoragePermissions(rootDir)
      : taskmuxHomeBlockedCheck("storage permissions", taskmuxHome),
    taskmuxHomeReady
      ? checkStorageRecords(storageSchema, storageFacts)
      : taskmuxHomeBlockedCheck("storage records", taskmuxHome)
  ];
}

type DoctorStorageFacts = Readonly<{
  kind: "data";
  config: TaskmuxConfig;
  agents: ConfiguredAgent[];
  taskCount: number;
  roleCount: number;
  globalRoleCount: number;
}> | Readonly<{
  kind: "error";
  detail: string;
}>;

function readDoctorStorageFacts(
  rootDir: string,
  state: StorageSchemaState
): DoctorStorageFacts | undefined {
  if (state.status !== "current") {
    return undefined;
  }
  try {
    return new FileTaskStore(rootDir).runReadSnapshot((snapshot) => {
      const tasks = snapshot.listTasks();
      return Object.freeze({
        kind: "data" as const,
        config: snapshot.getConfig(),
        agents: snapshot.listConfiguredAgents(),
        taskCount: tasks.length,
        roleCount: tasks.reduce((count, task) => count + snapshot.listRoles(task.id).length, 0),
        globalRoleCount: snapshot.listGlobalRoles().length
      });
    });
  } catch (error) {
    return Object.freeze({ kind: "error" as const, detail: errorMessage(error) });
  }
}

function checkDefaultAgent(
  state: StorageSchemaState,
  storageFacts: DoctorStorageFacts | undefined
): DoctorCheck {
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

  if (storageFacts?.kind === "error") {
    return {
      name: "default agent",
      status: "invalid",
      detail: storageFacts.detail
    };
  }
  const config = storageFacts?.config ?? { schemaVersion: 1 };
  const agents = storageFacts?.agents ?? [];

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
    const inspection = inspectTaskmuxHome(rootDir);
    switch (inspection.status) {
      case "ready":
        return {
          name: "taskmux home",
          status: "ok",
          detail: rootDir
        };
      case "missing":
        return {
          name: "taskmux home",
          status: "missing",
          detail: "run taskmux setup"
        };
      case "repair-required":
        return {
          name: "taskmux home",
          status: "invalid",
          detail: `TASKMUX_HOME must have exact mode 0700; current mode is ${inspection.mode}`
        };
    }
  } catch (error) {
    const procfdCode = taskmuxHomeProcfdSystemCode(error);
    if (procfdCode !== undefined) {
      return {
        name: "taskmux home",
        status: "unsupported",
        detail: procfdTraversalUnsupportedDetail(procfdCode)
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
  let taskmuxHomeAccepted = false;
  let failed = false;
  let failure: unknown;
  let failureOrigin: NativeStorageFailureOrigin | undefined;
  const rememberFailure = (error: unknown, origin: NativeStorageFailureOrigin): void => {
    if (!failed) {
      failed = true;
      failure = error;
      failureOrigin = origin;
    }
  };

  try {
    descriptor = openSync(
      rootDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch (error) {
    rememberFailure(error, "root-open");
  }

  if (!failed) {
    try {
      assertTaskmuxHomeReady(rootDir);
      assertPrivateTaskmuxHomeDescriptor(descriptor);
      taskmuxHomeAccepted = true;
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
      rememberFailure(error, "probe");
    }
  }

  if (probePath !== undefined) {
    try {
      unlinkSync(probePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") rememberFailure(error, "cleanup");
    }
  }
  if (probeDirectoryPath !== undefined) {
    try {
      rmdirSync(probeDirectoryPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") rememberFailure(error, "cleanup");
    }
  }
  if (descriptor >= 0 && taskmuxHomeAccepted) {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      rememberFailure(error, "cleanup");
    }
  }
  if (barrier !== undefined) {
    try {
      releaseStableAncestorBarrier(barrier);
    } catch (error) {
      rememberFailure(error, "cleanup");
    }
  }
  if (descriptor >= 0) {
    try {
      closeSync(descriptor);
    } catch (error) {
      rememberFailure(error, "cleanup");
    }
  }

  if (failed) return nativeStorageFailure(failure, failureOrigin);
  return {
    name: "native storage",
    status: "ok",
    detail: `openat2 + statx(STATX_BTIME) + O_TMPFILE + /proc/self/fd linkat verified for ${rootDir}`
  };
}

function taskmuxHomeBlockedCheck(name: string, taskmuxHome: DoctorCheck): DoctorCheck {
  return {
    name,
    status: taskmuxHome.status,
    detail: taskmuxHome.detail
  };
}

function assertPrivateTaskmuxHomeDescriptor(descriptor: number): void {
  const metadata = fstatSync(descriptor, { bigint: true });
  const euid = BigInt(process.geteuid?.() ?? -1);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== euid ||
    (metadata.mode & 0o7777n) !== TASKMUX_HOME_MODE
  ) {
    throw new Error(TASKMUX_HOME_REQUIREMENT);
  }
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

type NativeStorageFailureOrigin = "root-open" | "probe" | "cleanup";

function nativeStorageFailure(
  error: unknown,
  origin: NativeStorageFailureOrigin | undefined
): DoctorCheck {
  const code = errorCode(error);
  const procfdCode = taskmuxHomeProcfdSystemCode(error);
  if (procfdCode !== undefined) {
    return {
      name: "native storage",
      status: "unsupported",
      detail: procfdTraversalUnsupportedDetail(procfdCode)
    };
  }
  if (origin === "root-open" && code === "ENOENT") {
    return {
      name: "native storage",
      status: "missing",
      detail: "run taskmux setup"
    };
  }
  if (
    code === "ENOENT" &&
    errorKind(error) === "external-publication" &&
    errorStage(error) === "link-target"
  ) {
    return {
      name: "native storage",
      status: "unsupported",
      detail: `${NATIVE_STORAGE_REQUIREMENT}; /proc/self/fd link-target returned ENOENT`
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

function procfdTraversalUnsupportedDetail(code: string): string {
  return `${NATIVE_STORAGE_REQUIREMENT}; /proc/self/fd descriptor traversal returned ${code}`;
}

function taskmuxHomeProcfdSystemCode(error: unknown): string | undefined {
  if (errorKind(error) !== TASKMUX_HOME_PROCFD_ERROR_KIND) return undefined;
  return errorStringProperty(error, "systemCode");
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

function errorKind(error: unknown): string | undefined {
  return errorStringProperty(error, "kind");
}

function errorStage(error: unknown): string | undefined {
  return errorStringProperty(error, "stage");
}

function errorStringProperty(error: unknown, property: string): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" ? value : undefined;
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

function checkStorageRecords(
  state: StorageSchemaState,
  storageFacts: DoctorStorageFacts | undefined
): DoctorCheck {
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

  if (storageFacts?.kind === "error") {
    return {
      name: "storage records",
      status: "invalid",
      detail: storageFacts.detail
    };
  }
  const facts = storageFacts;
  if (facts === undefined) {
    return {
      name: "storage records",
      status: "invalid",
      detail: "TaskMux storage facts are unavailable."
    };
  }
  return {
    name: "storage records",
    status: "ok",
    detail: `tasks=${facts.taskCount} roles=${facts.roleCount} globalRoles=${facts.globalRoleCount} agents=${facts.agents.length}`
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
