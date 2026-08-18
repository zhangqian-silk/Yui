import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";

import {
  createSessionOwnerIdentity,
  type SessionOwnerIdentity
} from "./sessionOwnerIdentity.js";
import type { RuntimeOwner } from "./runtimeOwner.js";

/**
 * Durable, enumerable physical owner records for runtime generations.
 *
 * One JSON file per launch id under `<home>/runtime/session-owners/`. The
 * directory is runtime state (like the tmux socket), not aggregate domain
 * state, so it needs no schema migration; it survives a Controller restart and
 * stays enumerable after the durable Session map or history is cleared, which
 * is exactly the gap the audit proved (durable pointers empty, physical
 * processes still live).
 */
export class FileSessionOwnerRegistry {
  readonly #directory: string;

  constructor(home: string) {
    this.#directory = join(resolve(home), "runtime", "session-owners");
  }

  get directory(): string {
    return this.#directory;
  }

  /** Atomically records (or replaces) one generation's owner identity. */
  record(identity: SessionOwnerIdentity): void {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const target = this.#path(identity.launchId);
    const temporary = `${target}.tmp-${process.pid}`;
    writeFileSync(
      temporary,
      JSON.stringify(identity, null, 2) + "\n",
      { mode: 0o600 }
    );
    renameSync(temporary, target);
  }

  get(launchId: string): SessionOwnerIdentity | null {
    if (!isSafeLaunchId(launchId)) return null;
    try {
      return parseOwnerRecord(readFileSync(this.#path(launchId), "utf8"));
    } catch {
      return null;
    }
  }

  list(): SessionOwnerIdentity[] {
    let entries: string[];
    try {
      entries = readdirSync(this.#directory, { encoding: "utf8" });
    } catch {
      return [];
    }
    const records: SessionOwnerIdentity[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        records.push(parseOwnerRecord(
          readFileSync(join(this.#directory, entry), "utf8")
        ));
      } catch {
        // A malformed record must not hide the exact candidates beside it.
      }
    }
    records.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
    return records;
  }

  listForOwner(owner: RuntimeOwner): SessionOwnerIdentity[] {
    return this.list().filter((record) => (
      record.owner.scope === owner.scope
      && (owner.scope === "global"
        || record.owner.taskId === owner.taskId)
      && record.owner.roleName === owner.roleName
    ));
  }

  /** Removes a record whose physical resources were proven absent. */
  remove(launchId: string): void {
    if (!isSafeLaunchId(launchId)) return;
    try {
      rmSync(this.#path(launchId), { force: true });
    } catch {
      // A stale record is harmless: reconciliation re-verifies physical
      // identity before acting on it.
    }
  }

  exists(): boolean {
    return existsSync(this.#directory);
  }

  #path(launchId: string): string {
    return join(this.#directory, `${launchId}.json`);
  }
}

function isSafeLaunchId(launchId: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/u.test(launchId);
}

function parseOwnerRecord(raw: string): SessionOwnerIdentity {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Session owner record is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  const owner = record.owner as Record<string, unknown>;
  const tmux = record.tmux as Record<string, unknown>;
  const providerRoot = record.providerRoot as Record<string, unknown>;
  return createSessionOwnerIdentity({
    owner: {
      scope: owner.scope === "global" ? "global" : "task",
      ...(owner.taskId === undefined ? {} : { taskId: String(owner.taskId) }),
      roleName: String(owner.roleName)
    },
    agentId: String(record.agentId),
    adapterId: String(record.adapterId),
    launchId: String(record.launchId),
    ...(record.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: String(record.nativeSessionId) }),
    tmux: {
      serverName: String(tmux.serverName),
      socketPath: String(tmux.socketPath),
      sessionName: String(tmux.sessionName),
      windowName: String(tmux.windowName),
      ...(tmux.panePid === undefined ? {} : { panePid: Number(tmux.panePid) })
    },
    providerRoot: {
      pid: Number(providerRoot.pid),
      startIdentity: String(providerRoot.startIdentity),
      ...(providerRoot.processGroupId === undefined
        ? {}
        : { processGroupId: Number(providerRoot.processGroupId) }),
      ...(providerRoot.processSessionId === undefined
        ? {}
        : { processSessionId: Number(providerRoot.processSessionId) }),
      attribution: providerRoot.attribution === "pane-pid" ? "pane-pid" : "launch-env"
    },
    ...(record.runtimeRoot === undefined ? {} : { runtimeRoot: String(record.runtimeRoot) }),
    recordedAt: new Date(String(record.recordedAt))
  });
}
