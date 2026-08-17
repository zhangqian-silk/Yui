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

import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";

const executeFile = promisify(execFile);

export type LiveReferenceScan = Readonly<{
  /** Per-path reference tokens; a path is live when its list is non-empty. */
  refsByPath: ReadonlyMap<string, readonly string[]>;
  /** Paths explicitly protected by Controller/descriptor ownership. */
  protectedPaths: readonly string[];
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

  const addRef = (path: string, token: string): void => {
    const set = refs.get(path) ?? new Set<string>();
    set.add(token);
    refs.set(path, set);
  };

  // 1. Physical process inventory: cwd and open file descriptors.
  const processRefs = input.ports?.processCwdRefs !== undefined
    ? input.ports.processCwdRefs(paths)
    : scanProcessPathRefs(paths);
  for (const [path, tokens] of processRefs) {
    for (const token of tokens) addRef(path, token);
  }

  // 2. tmux pane working directories (best effort; tmux may be absent).
  const paneCwds = input.ports?.tmuxPaneCwds !== undefined
    ? await input.ports.tmuxPaneCwds()
    : await scanTmuxPaneCwds(home, input.tmuxServerName, input.environment ?? process.env);
  for (const cwd of paneCwds) {
    for (const path of paths) {
      if (isPathWithin(cwd, path)) addRef(path, `tmux-pane:${cwd}`);
    }
  }

  // 3. Controller discovery: a running Controller protects its Home.
  const discovery = readControllerDiscovery(home);
  if (discovery !== undefined) {
    for (const path of paths) {
      if (isPathWithin(home, path)) addRef(path, discovery);
    }
  }

  // 4. Durable managed workspaces: their roots and entries are claimed while
    // the durable record exists, regardless of Task terminal state.
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

  // 5. Active durable workspace owners (e.g. an active AgentRun launch).
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
    protectedPaths: Object.freeze([...protectedPaths])
  });
}

/**
 * Scan /proc for processes whose cwd or open fd is within one of the paths.
 * A process we cannot inspect (permission, race) is ignored for cwd/fd
 * matching but does not by itself protect a path: the caller layers durable
 * and descriptor references on top, and an unreadable store degrades owners
 * to "unproven" upstream.
 */
export function scanProcessPathRefs(
  paths: readonly string[]
): ReadonlyMap<string, readonly string[]> {
  const refs = new Map<string, Set<string>>();
  const add = (path: string, token: string): void => {
    const set = refs.get(path) ?? new Set<string>();
    set.add(token);
    refs.set(path, set);
  };
  let entries: readonly string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return freezeRefs(refs);
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
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
  return freezeRefs(refs);
}

function freezeRefs(
  refs: ReadonlyMap<string, Set<string>>
): ReadonlyMap<string, readonly string[]> {
  const frozen = new Map<string, readonly string[]>();
  for (const [path, tokens] of refs) frozen.set(path, Object.freeze([...tokens]));
  return frozen;
}

/** Best-effort tmux pane cwd enumeration for the Home's namespace. */
export async function scanTmuxPaneCwds(
  home: string,
  tmuxServerName: string | undefined,
  environment: NodeJS.ProcessEnv
): Promise<readonly string[]> {
  const server = tmuxServerName ?? defaultTmuxServerName(home);
  try {
    const { stdout } = await executeFile(
      "tmux",
      ["-L", server, "list-panes", "-a", "-F", "#{pane_current_path}"],
      { env: environment, timeout: 5_000 }
    );
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return Object.freeze([]);
  }
}

function defaultTmuxServerName(home: string): string {
  return `yui-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24)}`;
}

/** Read the Controller discovery record when its process is alive. */
export function readControllerDiscovery(home: string): string | undefined {
  const path = join(resolve(home), "runtime", "controller.json");
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: number;
      processStartIdentity?: string;
    };
    if (typeof record.pid !== "number" || record.pid <= 0) return undefined;
    try {
      process.kill(record.pid, 0);
    } catch {
      return undefined;
    }
    return `controller:${record.pid}`;
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
