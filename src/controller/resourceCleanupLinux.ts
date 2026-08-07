import { lstatSync, readFileSync, unlinkSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { NodeCommandExecutor } from "../tmux/commandExecutor.js";
import { TmuxManager } from "../tmux/tmuxManager.js";
import type { RuntimeResource } from "./resourceInventory.js";
import { controllerSocketPath } from "../core/controllerEndpoint.js";
import {
  CONTROLLER_DOMAIN_PATH,
  domainIdentityPath,
  readEphemeralDomainIdentity
} from "./domainIdentity.js";

const DEFAULT_TERM_GRACE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_POLL_MS = 50;

export type ControllerCleanupPorts = Readonly<{
  processStartIdentity(pid: number): string | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(milliseconds: number): Promise<void>;
  artifactFingerprint(path: string): string | undefined;
  socketActive(path: string): boolean;
  removeArtifact(path: string): void;
  killPane(resource: RuntimeResource): Promise<void>;
  inspectTmuxServerPanes(resource: RuntimeResource): Promise<readonly string[]>;
}>;

export type ControllerResourceCleanupOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  ports?: ControllerCleanupPorts;
}>;

export async function cleanControllerResource(
  resource: RuntimeResource,
  options: ControllerResourceCleanupOptions = {}
): Promise<void> {
  if (resource.disposition !== "safe" && resource.disposition !== "review") {
    throw new Error(`Resource is not eligible for cleanup: ${resource.id}.`);
  }
  assertEphemeralDomainFence(resource);
  const environment = options.environment ?? process.env;
  const ports = options.ports ?? linuxCleanupPorts(environment);
  if (resource.artifact !== undefined) {
    cleanArtifact(resource, ports);
    return;
  }
  if (resource.kind === "agent-session") {
    assertProcessIdentities(resource, ports);
    await ports.killPane(resource);
    return;
  }
  if (resource.processes.length === 0) {
    throw new Error(`Resource has no cleanup target: ${resource.id}.`);
  }
  if (resource.kind === "tmux-server") {
    const panes = await ports.inspectTmuxServerPanes(resource);
    if (panes.length > 0) {
      throw new Error(
        `Tmux server still owns Role panes: ${panes.join(", ")}.`
      );
    }
    // Close the small inspect-to-signal race without inventing a wait or
    // broad process-name rule. A target appearing on the second exact query
    // keeps the server protected for the next bounded pass.
    const recheckedPanes = await ports.inspectTmuxServerPanes(resource);
    if (recheckedPanes.length > 0) {
      throw new Error(
        `Tmux server still owns Role panes: ${recheckedPanes.join(", ")}.`
      );
    }
  }
  assertProcessIdentities(resource, ports);
  for (const process of [...resource.processes].reverse()) {
    signalIfOwned(process.pid, process.startIdentity, "SIGTERM", ports);
  }
  const termGraceMs = positiveDuration(
    options.termGraceMs,
    DEFAULT_TERM_GRACE_MS,
    "termGraceMs"
  );
  const killGraceMs = positiveDuration(
    options.killGraceMs,
    DEFAULT_KILL_GRACE_MS,
    "killGraceMs"
  );
  const pollMs = positiveDuration(options.pollMs, DEFAULT_POLL_MS, "pollMs");
  await waitForProcesses(resource, ports, termGraceMs, pollMs);
  for (const process of [...resource.processes].reverse()) {
    signalIfOwned(process.pid, process.startIdentity, "SIGKILL", ports);
  }
  await waitForProcesses(resource, ports, killGraceMs, pollMs);
  const remaining = resource.processes.filter((process) => (
    ports.processStartIdentity(process.pid) === process.startIdentity
  ));
  if (remaining.length > 0) {
    throw new Error(
      `Resource processes did not stop: ${remaining.map(({ pid }) => pid).join(", ")}.`
    );
  }
}

function assertEphemeralDomainFence(resource: RuntimeResource): void {
  const domain = resource.domain;
  if (domain?.kind !== "ephemeral-test") return;
  const home = resource.yuiHome;
  if (home === undefined || domain.token === undefined) {
    throw new Error(`Ephemeral domain identity is unavailable: ${resource.id}.`);
  }
  const identity = readEphemeralDomainIdentity(home);
  if (identity.status !== "valid" || identity.identity?.token !== domain.token) {
    throw new Error(`Resource changed since scan: ${resource.id}.`);
  }
}

function cleanArtifact(resource: RuntimeResource, ports: ControllerCleanupPorts): void {
  const artifact = resource.artifact;
  if (artifact === undefined) throw new Error(`Artifact is unavailable: ${resource.id}.`);
  assertOwnedArtifactPath(resource);
  const currentFingerprint = ports.artifactFingerprint(artifact.path);
  // A concurrent exact cleanup may have already removed this artifact. The
  // desired state is still satisfied; only a changed live inode is ambiguous.
  if (currentFingerprint === undefined) return;
  if (currentFingerprint !== artifact.fingerprint) {
    throw new Error(`Resource changed since scan: ${resource.id}.`);
  }
  if (artifact.artifactKind === "domain-identity") {
    const home = resource.yuiHome;
    const expectedToken = resource.domain?.token;
    if (home === undefined || expectedToken === undefined) {
      throw new Error(`Ephemeral domain identity is unavailable: ${resource.id}.`);
    }
    const identity = readEphemeralDomainIdentity(home);
    if (identity.status !== "valid" || identity.identity?.token !== expectedToken) {
      throw new Error(`Resource changed since scan: ${resource.id}.`);
    }
  }
  if (
    artifact.artifactKind.endsWith("-socket")
    && ports.socketActive(artifact.path)
  ) {
    throw new Error(`Resource socket is active: ${artifact.path}.`);
  }
  ports.removeArtifact(artifact.path);
}

function assertProcessIdentities(
  resource: RuntimeResource,
  ports: ControllerCleanupPorts
): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  for (const candidate of resource.processes) {
    if (
      candidate.pid <= 1
      || candidate.pid === process.pid
      || candidate.uid !== uid
      || ports.processStartIdentity(candidate.pid) !== candidate.startIdentity
    ) {
      throw new Error(`Resource changed since scan: ${resource.id}.`);
    }
  }
}

function signalIfOwned(
  pid: number,
  startIdentity: string,
  signal: NodeJS.Signals,
  ports: ControllerCleanupPorts
): void {
  if (ports.processStartIdentity(pid) !== startIdentity) return;
  try {
    ports.signal(pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function waitForProcesses(
  resource: RuntimeResource,
  ports: ControllerCleanupPorts,
  graceMs: number,
  pollMs: number
): Promise<void> {
  for (let elapsed = 0; elapsed < graceMs; elapsed += pollMs) {
    if (resource.processes.every((candidate) => (
      ports.processStartIdentity(candidate.pid) !== candidate.startIdentity
    ))) {
      return;
    }
    await ports.sleep(Math.min(pollMs, graceMs - elapsed));
  }
}

function linuxCleanupPorts(environment: NodeJS.ProcessEnv): ControllerCleanupPorts {
  return {
    processStartIdentity: readProcessStartIdentity,
    signal: (pid, signal) => process.kill(pid, signal),
    sleep: (milliseconds) => new Promise((resolveSleep) => {
      setTimeout(resolveSleep, milliseconds);
    }),
    artifactFingerprint: (path) => {
      try {
        return statFingerprint(lstatSync(path));
      } catch {
        return undefined;
      }
    },
    socketActive: unixSocketIsActive,
    removeArtifact: (path) => unlinkSync(path),
    inspectTmuxServerPanes: async (resource) => {
      const manager = tmuxManagerForResource(resource, environment);
      return manager.inspectRolePaneInventory().map((pane) => (
        `${pane.taskId}/${pane.roleName}`
      ));
    },
    killPane: async (resource) => {
      const target = resource.target;
      if (target === undefined) {
        throw new Error(`Role pane identity is unavailable: ${resource.id}.`);
      }
      const manager = tmuxManagerForResource(resource, environment);
      const pane = manager.inspectRolePaneInventory().find((candidate) => (
        candidate.target === target
      ));
      if (pane === undefined) return;
      if (
        resource.paneDead !== undefined
        && pane.dead !== resource.paneDead
      ) {
        throw new Error(`Resource changed since scan: ${resource.id}.`);
      }
      if (
        resource.paneCommand !== undefined
        && pane.currentCommand !== resource.paneCommand
      ) {
        throw new Error(`Resource changed since scan: ${resource.id}.`);
      }
      const expectedPid = resource.processes[0]?.pid;
      if (expectedPid !== undefined && pane.pid !== expectedPid) {
        throw new Error(`Resource changed since scan: ${resource.id}.`);
      }
      manager.killRole(pane.taskId, pane.roleName);
      if (manager.inspectRolePaneInventory().some((candidate) => candidate.target === target)) {
        throw new Error(`Role pane did not stop: ${target}.`);
      }
    }
  };
}

function tmuxManagerForResource(
  resource: RuntimeResource,
  environment: NodeJS.ProcessEnv
): TmuxManager {
  const home = resource.yuiHome;
  if (home === undefined) {
    throw new Error(`Tmux resource home is unavailable: ${resource.id}.`);
  }
  return new TmuxManager(
    environment.YUI_TMUX_BIN ?? "tmux",
    new NodeCommandExecutor(),
    { yuiHome: home }
  );
}

function readProcessStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    if (closing < 0) return undefined;
    const identity = stat.slice(closing + 1).trim().split(/\s+/u)[19];
    return identity !== undefined && /^[0-9]{1,32}$/u.test(identity)
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

function unixSocketIsActive(expectedPath: string): boolean {
  try {
    return readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)
      .some((line) => line.trim().split(/\s+/u)[7] === expectedPath);
  } catch {
    // Without a liveness proof, refuse socket deletion.
    return true;
  }
}

function assertOwnedArtifactPath(resource: RuntimeResource): void {
  const artifact = resource.artifact;
  if (artifact === undefined) throw new Error(`Artifact is unavailable: ${resource.id}.`);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const path = resolve(artifact.path);
  if (artifact.artifactKind === "tmux-socket") {
    const directory = join(tmpdir(), `tmux-${uid}`);
    if (
      dirname(path) !== directory
      || !/^yui-[a-f0-9]{24}$/u.test(basename(path))
    ) {
      throw new Error(`Artifact path is outside the Yui tmux namespace: ${path}.`);
    }
    return;
  }
  const home = resource.yuiHome;
  if (
    home !== undefined
    && artifact.artifactKind === "controller-socket"
    && path === controllerSocketPath(home)
  ) {
    return;
  }
  if (
    home !== undefined
    && artifact.artifactKind === "domain-identity"
    && path === domainIdentityPath(home)
    && basename(path) === basename(join(resolve(home), CONTROLLER_DOMAIN_PATH))
  ) {
    return;
  }
  if (
    home === undefined
    || dirname(path) !== join(resolve(home), "runtime")
    || !/^controller\.(?:json|sock)$/u.test(basename(path))
  ) {
    throw new Error(`Artifact path is outside the Yui Controller namespace: ${path}.`);
  }
}

function statFingerprint(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    Math.trunc(metadata.mtimeMs)
  ].join(":");
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return resolved;
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "ESRCH";
}
