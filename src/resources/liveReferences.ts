/**
 * Live-reference detection for Resource GC (Issue 10).
 *
 * GC proves liveness itself, every apply, from OS/Git/durable facts — it never
 * consumes another Issue's completion flag. Any source that cannot be read
 * fails closed: the resource is treated as referenced and retained.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseExactTaskRuntimeDescriptor } from "../runtime/exactControlPlane.js";
import {
  readRuntimeIdentity,
  releasesDirectory,
  resolveActiveRelease
} from "../release/runtimeRelease.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import { isControllerSocketPathForHome } from "../core/controllerEndpoint.js";
import { parseControllerDiscovery } from "../core/protocol.js";
import { readCompatibleHomeIdentity } from "../storage/compatibleTaskStore.js";

const executeFile = promisify(execFile);

/** A diagnostic explaining why a source could not be fully trusted. */
export type LiveReferenceDiagnostic = Readonly<{
  source: "proc" | "tmux" | "controller" | "durable";
  severity: "error" | "warning";
  message: string;
}>;

export type LiveReferenceScan = Readonly<{
  /** Per-path reference tokens; a path is live when its list is non-empty. */
  refsByPath: ReadonlyMap<string, readonly string[]>;
  /** Paths explicitly protected by Controller/descriptor ownership. */
  protectedPaths: readonly string[];
  /** Source-level diagnostics; an error means the scan is fail-closed. */
  diagnostics: readonly LiveReferenceDiagnostic[];
}>;

export type LiveReferencePorts = Readonly<{
  /** Override the /proc scan (tests). */
  processCwdRefs?: (paths: readonly string[]) => ReadonlyMap<string, readonly string[]>;
  /** Override the tmux pane cwd scan (tests). */
  tmuxPaneCwds?: () => Promise<readonly string[]>;
  /** Override durable managed-workspace enumeration (tests). */
  managedWorkspaces?: () => readonly ManagedWorkspace[];
  /** Override active durable workspace owners (tests). */
  activeWorkspaceOwners?: () => readonly string[];
}>;

export type LiveReferenceInput = Readonly<{
  home: string;
  paths: readonly string[];
  environment?: NodeJS.ProcessEnv;
  tmuxServerName?: string;
  ports?: LiveReferencePorts;
}>;

/**
 * Collect every live reference for the given paths. The scan is fail-closed:
 * an unreadable /proc entry or an unavailable tmux is reported as a reference
 * rather than silently ignored.
 */
export async function scanLiveReferences(
  input: LiveReferenceInput
): Promise<LiveReferenceScan> {
  const home = resolve(input.home);
  const paths = input.paths.map((path) => resolve(path));
  const refs = new Map<string, Set<string>>();
  const protectedPaths = new Set<string>();
  const diagnostics: LiveReferenceDiagnostic[] = [];

  const addRef = (path: string, token: string): void => {
    const set = refs.get(path) ?? new Set<string>();
    set.add(token);
    refs.set(path, set);
  };

  // 1. Physical process inventory: cwd and open file descriptors.
  let processResult: ProcessScanResult;
  if (input.ports?.processCwdRefs !== undefined) {
    try {
      processResult = Object.freeze({
        refs: input.ports.processCwdRefs(paths),
        diagnostics: Object.freeze([])
      });
    } catch (error) {
      processResult = Object.freeze({
        refs: new Map<string, readonly string[]>(),
        diagnostics: Object.freeze([{
          source: "proc" as const,
          severity: "error" as const,
          message: `process cwd scan failed: ${error instanceof Error ? error.message : "unknown error"}`
        }])
      });
    }
  } else {
    processResult = scanProcessPathRefs(paths);
  }
  for (const [path, tokens] of processResult.refs) {
    for (const token of tokens) addRef(path, token);
  }
  diagnostics.push(...processResult.diagnostics);

  // 2. tmux pane working directories (best effort; tmux may be absent).
  let tmuxResult: TmuxScanResult;
  if (input.ports?.tmuxPaneCwds !== undefined) {
    try {
      tmuxResult = Object.freeze({
        cwds: Object.freeze(await input.ports.tmuxPaneCwds()),
        diagnostics: Object.freeze([])
      });
    } catch (error) {
      tmuxResult = Object.freeze({
        cwds: Object.freeze([]),
        diagnostics: Object.freeze([{
          source: "tmux" as const,
          severity: "error" as const,
          message: `tmux scan failed: ${error instanceof Error ? error.message : "unknown error"}`
        }])
      });
    }
  } else {
    tmuxResult = await scanTmuxPaneCwds(home, input.tmuxServerName, input.environment ?? process.env);
  }
  for (const cwd of tmuxResult.cwds) {
    for (const path of paths) {
      if (isPathWithin(cwd, path)) addRef(path, `tmux-pane:${cwd}`);
    }
  }
  diagnostics.push(...tmuxResult.diagnostics);

  // 3. Controller discovery: a running Controller protects only its own
  //    discovery record. Its cwd and open files are covered by the /proc
  //    scan above, so a live Controller does not blanket-protect legacy
  //    deployments and worktrees that no descriptor references — automatic
  //    GC (which runs inside the Controller) would otherwise be a no-op.
  const discovery = readControllerDiscovery(home);
  if (discovery.protects) {
    for (const path of paths) {
      if (discovery.protectedPaths.some(
        (claim) => isPathWithin(claim, path) || isPathWithin(path, claim)
      )) {
        addRef(path, discovery.token);
      }
    }
  }
  if (discovery.diagnostic !== undefined) diagnostics.push(discovery.diagnostic);

  // 4. Runtime identity and exact Task descriptors are durable live-ownership
  //    claims. Resolved runtime paths and descriptor workspaces stay protected
  //    while their owning process identity is alive.
  const runtimeClaims = readRuntimeIdentityClaims(home);
  diagnostics.push(...runtimeClaims.diagnostics);
  const descriptorClaims = readExactTaskRuntimeClaims(home);
  diagnostics.push(...descriptorClaims.diagnostics);
  const activeReleaseClaims = readActiveReleaseClaims(home);
  diagnostics.push(...activeReleaseClaims.diagnostics);
  const sessionOwnerClaims = readSessionOwnerClaims(home);
  diagnostics.push(...sessionOwnerClaims.diagnostics);
  for (const claim of [
    ...runtimeClaims.claims,
    ...descriptorClaims.claims,
    ...activeReleaseClaims.claims,
    ...sessionOwnerClaims.claims
  ]) {
    protectedPaths.add(claim.path);
    for (const path of paths) {
      if (isPathWithin(claim.path, path) || isPathWithin(path, claim.path)) {
        addRef(path, claim.token);
      }
    }
  }

  // 5. Durable managed workspaces: their roots and entries are claimed while
  //    the durable record exists, regardless of Task terminal state.
  const workspaces = input.ports?.managedWorkspaces !== undefined
    ? input.ports.managedWorkspaces()
    : [];
  for (const workspace of workspaces) {
    const claimed = [workspace.root, ...workspace.entries.map((entry) => entry.path)];
    for (const claim of claimed) {
      protectedPaths.add(claim);
      for (const path of paths) {
        if (isPathWithin(claim, path) || isPathWithin(path, claim)) {
          addRef(path, `durable-managed-workspace:${workspace.owner.type}`);
        }
      }
    }
  }

  // 6. Active durable workspace owners (e.g. an active AgentRun launch).
  const activeOwners = input.ports?.activeWorkspaceOwners !== undefined
    ? input.ports.activeWorkspaceOwners()
    : [];
  for (const owner of activeOwners) {
    for (const path of paths) {
      if (path.includes(owner)) addRef(path, `active-owner:${owner}`);
    }
  }

  const refsByPath = new Map<string, readonly string[]>();
  for (const path of paths) {
    const tokens = refs.get(path);
    refsByPath.set(path, tokens === undefined ? Object.freeze([]) : Object.freeze([...tokens]));
  }
  return Object.freeze({
    refsByPath,
    protectedPaths: Object.freeze([...protectedPaths]),
    diagnostics: Object.freeze(diagnostics)
  });
}

type PathClaim = Readonly<{ path: string; token: string }>;

type ClaimReadResult = Readonly<{
  claims: readonly PathClaim[];
  diagnostics: readonly LiveReferenceDiagnostic[];
}>;

function readRuntimeIdentityClaims(home: string): ClaimReadResult {
  try {
    const identity = readRuntimeIdentity(home);
    if (identity === null) {
      return Object.freeze({ claims: Object.freeze([]), diagnostics: Object.freeze([]) });
    }
    if (!isProcessAlive(identity.pid)) {
      return Object.freeze({ claims: Object.freeze([]), diagnostics: Object.freeze([]) });
    }
    const currentIdentity = readLinuxProcessStartIdentity(identity.pid);
    if (currentIdentity === undefined || currentIdentity !== identity.processStartIdentity) {
      return Object.freeze({
        claims: Object.freeze([]),
        diagnostics: Object.freeze([{
          source: "controller" as const,
          severity: "error" as const,
          message: `runtime-identity pid ${identity.pid} start identity mismatch (PID reuse?)`
        }])
      });
    }
    const claims: PathClaim[] = [
      { path: resolve(identity.cliRealpath), token: `runtime-identity:cli:${identity.pid}` },
      { path: resolve(identity.controllerRealpath), token: `runtime-identity:controller:${identity.pid}` }
    ];
    if (identity.activeRelease !== null) {
      claims.push({
        path: join(releasesDirectory(home), identity.activeRelease.releaseId),
        token: `runtime-identity:active-release:${identity.pid}`
      });
    }
    return Object.freeze({ claims: Object.freeze(claims), diagnostics: Object.freeze([]) });
  } catch (error) {
    return Object.freeze({
      claims: Object.freeze([]),
      diagnostics: Object.freeze([{
        source: "controller" as const,
        severity: "error" as const,
        message: `runtime-identity is unreadable: ${error instanceof Error ? error.message : "unknown error"}`
      }])
    });
  }
}

function readExactTaskRuntimeClaims(home: string): ClaimReadResult {
  const directory = join(home, "runtime", "exact-task-runtime");
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ claims: Object.freeze([]), diagnostics: Object.freeze([]) });
    }
    return Object.freeze({
      claims: Object.freeze([]),
      diagnostics: Object.freeze([{
        source: "controller" as const,
        severity: "error" as const,
        message: `exact Task runtime descriptors are unreadable: ${error instanceof Error ? error.message : "unknown error"}`
      }])
    });
  }

  const claims: PathClaim[] = [];
  const diagnostics: LiveReferenceDiagnostic[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    try {
      const descriptor = parseExactTaskRuntimeDescriptor(readFileSync(path, "utf8"));
      claims.push({ path, token: `exact-task-runtime:${descriptor.taskId}` });
      claims.push({
        path: resolve(descriptor.workspace),
        token: `exact-task-runtime:workspace:${descriptor.taskId}`
      });
    } catch (error) {
      diagnostics.push({
        source: "controller" as const,
        severity: "error" as const,
        message: `exact Task runtime descriptor is unreadable at ${path}: ${error instanceof Error ? error.message : "unknown error"}`
      });
    }
  }
  return Object.freeze({
    claims: Object.freeze(claims),
    diagnostics: Object.freeze(diagnostics)
  });
}

function readActiveReleaseClaims(home: string): ClaimReadResult {
  try {
    const active = resolveActiveRelease(home);
    if (active === null) {
      return Object.freeze({ claims: Object.freeze([]), diagnostics: Object.freeze([]) });
    }
    return Object.freeze({
      claims: Object.freeze([{
        path: active.releaseDir,
        token: "active-release"
      }]),
      diagnostics: Object.freeze([])
    });
  } catch (error) {
    return Object.freeze({
      claims: Object.freeze([]),
      diagnostics: Object.freeze([{
        source: "controller" as const,
        severity: "error" as const,
        message: `active release is unreadable: ${error instanceof Error ? error.message : "unknown error"}`
      }])
    });
  }
}

/**
 * Read Session owner records (`runtime/session-owners/<launchId>.json`). A
 * record whose Provider root is physically alive with a matching start
 * identity protects its runtime root. A dead PID is stale (reconciliation
 * removes those records); an identity conflict or unreadable record fails
 * closed because liveness can no longer be proven.
 */
function readSessionOwnerClaims(home: string): ClaimReadResult {
  const directory = join(home, "runtime", "session-owners");
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ claims: Object.freeze([]), diagnostics: Object.freeze([]) });
    }
    return Object.freeze({
      claims: Object.freeze([]),
      diagnostics: Object.freeze([{
        source: "controller" as const,
        severity: "error" as const,
        message: `session owner records are unreadable: ${error instanceof Error ? error.message : "unknown error"}`
      }])
    });
  }

  const claims: PathClaim[] = [];
  const diagnostics: LiveReferenceDiagnostic[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    let record: {
      launchId?: unknown;
      runtimeRoot?: unknown;
      providerRoot?: { pid?: unknown; startIdentity?: unknown };
    };
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as typeof record;
    } catch (error) {
      diagnostics.push({
        source: "controller" as const,
        severity: "error" as const,
        message: `session owner record is unreadable at ${path}: ${error instanceof Error ? error.message : "unknown error"}`
      });
      continue;
    }
    const pid = record.providerRoot?.pid;
    const startIdentity = record.providerRoot?.startIdentity;
    if (typeof pid !== "number" || pid <= 0 || typeof startIdentity !== "string") {
      diagnostics.push({
        source: "controller" as const,
        severity: "error" as const,
        message: `session owner record at ${path} has no valid provider root identity`
      });
      continue;
    }
    if (!isProcessAlive(pid)) {
      // Dead Provider root: the record is stale; reconciliation removes it.
      continue;
    }
    const currentIdentity = readLinuxProcessStartIdentity(pid);
    if (currentIdentity === undefined || currentIdentity !== startIdentity) {
      diagnostics.push({
        source: "controller" as const,
        severity: "error" as const,
        message: `session owner record pid ${pid} start identity mismatch (PID reuse?)`
      });
      continue;
    }
    if (typeof record.runtimeRoot === "string" && record.runtimeRoot.length > 0) {
      claims.push({
        path: resolve(record.runtimeRoot),
        token: `session-owner:${typeof record.launchId === "string" ? record.launchId : entry.name}`
      });
    }
  }
  return Object.freeze({
    claims: Object.freeze(claims),
    diagnostics: Object.freeze(diagnostics)
  });
}

export type ProcessScanResult = Readonly<{
  refs: ReadonlyMap<string, readonly string[]>;
  diagnostics: readonly LiveReferenceDiagnostic[];
}>;

/**
 * Scan /proc for processes whose cwd or open fd is within one of the paths.
 * The current process is included: an operator running GC from inside a
 * candidate directory must protect it. When /proc itself cannot be read the
 * scan fails closed: every candidate path receives a protective ref.
 */
export function scanProcessPathRefs(
  paths: readonly string[]
): ProcessScanResult {
  const refs = new Map<string, Set<string>>();
  const diagnostics: LiveReferenceDiagnostic[] = [];
  const add = (path: string, token: string): void => {
    const set = refs.get(path) ?? new Set<string>();
    set.add(token);
    refs.set(path, set);
  };
  let entries: readonly string[];
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    // /proc is unreadable: fail closed — protect every candidate path.
    const message = `/proc cannot be read: ${error instanceof Error ? error.message : "unknown error"}`;
    diagnostics.push({ source: "proc" as const, severity: "error" as const, message });
    for (const path of paths) add(path, "proc:unreadable");
    return freezeResult(refs, diagnostics);
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cwd: string | undefined;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = undefined;
    }
    if (cwd !== undefined) {
      for (const path of paths) {
        if (isPathWithin(cwd, path)) add(path, `proc:cwd:${pid}`);
      }
    }
    // Open file descriptors. A resource with an open fd is in use even when
    // no process has it as cwd.
    let fds: readonly string[] = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      fds = [];
    }
    for (const fd of fds) {
      let target: string | undefined;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (target.startsWith("socket:") || target.startsWith("pipe:")
        || target.startsWith("anon_inode:")) {
        continue;
      }
      for (const path of paths) {
        if (isPathWithin(target, path)) add(path, `proc:fd:${pid}`);
      }
    }
  }
  return freezeResult(refs, diagnostics);
}

function freezeResult(
  refs: ReadonlyMap<string, Set<string>>,
  diagnostics: readonly LiveReferenceDiagnostic[]
): ProcessScanResult {
  const frozen = new Map<string, readonly string[]>();
  for (const [path, tokens] of refs) frozen.set(path, Object.freeze([...tokens]));
  return Object.freeze({
    refs: frozen,
    diagnostics: Object.freeze(diagnostics)
  });
}

export type TmuxScanResult = Readonly<{
  cwds: readonly string[];
  diagnostics: readonly LiveReferenceDiagnostic[];
}>;

/** Enumerate tmux pane cwds for the Home's namespace. */
export async function scanTmuxPaneCwds(
  home: string,
  tmuxServerName: string | undefined,
  environment: NodeJS.ProcessEnv
): Promise<TmuxScanResult> {
  const server = tmuxServerName ?? defaultTmuxServerName(home);
  try {
    const { stdout } = await executeFile(
      "tmux",
      ["-L", server, "list-panes", "-a", "-F", "#{pane_current_path}"],
      { env: environment, timeout: 5_000 }
    );
    return Object.freeze({
      cwds: Object.freeze(stdout.split("\n").map((line) => line.trim()).filter(Boolean)),
      diagnostics: Object.freeze([])
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    // tmux binary not found or no server: the namespace is genuinely absent.
    if (code === "ENOENT" || isNoServerError(error)) {
      return Object.freeze({ cwds: Object.freeze([]), diagnostics: Object.freeze([]) });
    }
    // Any other failure (permission, timeout, unexpected exit) is untrusted.
    const message = `tmux scan failed: ${error instanceof Error ? error.message : "unknown error"}`;
    return Object.freeze({
      cwds: Object.freeze([]),
      diagnostics: Object.freeze([{ source: "tmux" as const, severity: "error" as const, message }])
    });
  }
}

function isNoServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no server") || message.includes("error connecting to");
}

function defaultTmuxServerName(home: string): string {
  return `yui-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24)}`;
}

export type ControllerDiscoveryResult = Readonly<{
  protects: boolean;
  token: string;
  /** Precise paths owned by the live Controller (the discovery record). */
  protectedPaths: readonly string[];
  diagnostic?: LiveReferenceDiagnostic;
}>;

/**
 * Read the Controller discovery record. A live Controller process protects
 * only its own discovery record; the process's cwd and open files are proven
 * by the /proc scan. When the record exists but the PID is dead the record is
 * stale. A live PID without a provable start identity is fail-closed.
 */
export function readControllerDiscovery(home: string): ControllerDiscoveryResult {
  const path = join(resolve(home), "runtime", "controller.json");
  if (!existsSync(path)) {
    return Object.freeze({ protects: false, token: "", protectedPaths: Object.freeze([]) });
  }
  let record: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("controller.json is not an object");
    }
    record = value as Record<string, unknown>;
  } catch (error) {
    return Object.freeze({
      protects: false,
      token: "",
      protectedPaths: Object.freeze([]),
      diagnostic: {
        source: "controller" as const,
        severity: "error" as const,
        message: `controller.json is unreadable: ${error instanceof Error ? error.message : "unknown error"}`
      }
    });
  }
  if (typeof record.pid !== "number" || record.pid <= 0) {
    return Object.freeze({
      protects: false,
      token: "",
      protectedPaths: Object.freeze([]),
      diagnostic: { source: "controller" as const, severity: "error" as const, message: "controller.json has no valid pid" }
    });
  }
  try {
    process.kill(record.pid, 0);
  } catch {
    // PID is dead: the Controller is not running; no protection, no diagnostic.
    return Object.freeze({ protects: false, token: "", protectedPaths: Object.freeze([]) });
  }
  if (typeof record.processStartIdentity !== "string") {
    return Object.freeze({
      protects: false,
      token: "",
      protectedPaths: Object.freeze([]),
      diagnostic: {
        source: "controller" as const,
        severity: "error" as const,
        message: `controller.json pid ${record.pid} has no processStartIdentity`
      }
    });
  }
  // PID is alive. When a start identity is recorded, verify it to guard
  // against PID reuse.
  const currentIdentity = readLinuxProcessStartIdentity(record.pid);
  if (currentIdentity === undefined || currentIdentity !== record.processStartIdentity) {
    return Object.freeze({
      protects: false,
      token: "",
      protectedPaths: Object.freeze([]),
      diagnostic: {
        source: "controller" as const,
        severity: "error" as const,
        message: `controller.json pid ${record.pid} start identity mismatch (PID reuse?)`
      }
    });
  }
  let discovery;
  try {
    const homeId = readCompatibleHomeIdentity(home).homeId;
    const socketPath = record.socketPath;
    if (
      typeof socketPath !== "string"
      || !isControllerSocketPathForHome(homeId, socketPath)
    ) {
      throw new Error("Controller endpoint identity is invalid.");
    }
    discovery = parseControllerDiscovery(record, { homeId, socketPath });
  } catch (error) {
    return Object.freeze({
      protects: false,
      token: "",
      protectedPaths: Object.freeze([]),
      diagnostic: {
        source: "controller" as const,
        severity: "error" as const,
        message: `controller.json identity is invalid: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      }
    });
  }
  return Object.freeze({
    protects: true,
    token: `controller:${discovery.homeId}:${discovery.controllerInstanceId}:${record.pid}`,
    protectedPaths: Object.freeze([path])
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read /proc/<pid>/stat start time (field 22), the Linux process identity. */
function readLinuxProcessStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field (2) can contain spaces and parentheses, so find the last ")".
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const fields = afterComm.split(" ");
    return fields[19]; // field 22 (1-indexed) = index 20 after comm; fields[19]
  } catch {
    return undefined;
  }
}

function isPathWithin(child: string, parent: string): boolean {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  return resolvedChild.startsWith(`${resolvedParent}/`);
}
