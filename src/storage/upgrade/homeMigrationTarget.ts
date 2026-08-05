/**
 * The real, canonical {@link MigrationTarget} bound to a Yui Home.
 *
 * This is the single seam where the generic, domain-free migration engine
 * (`../migration`) meets a real authoritative store. The engine holds no list of
 * Yui records or derived-state fields; all of that domain knowledge lives here,
 * behind the injected boundary:
 *
 *  - `inspectVersions`      reads the on-disk versions read-only via
 *    `inspectStorageSchema` plus the current record map.
 *  - `readSource`           reads `schema.json` + `state.json` read-only; it never
 *    writes the source.
 *  - `writeFreshOutput`     stages the migrated snapshot into a fresh sibling
 *    directory and REFUSES to overwrite an existing staged output.
 *  - `rebuildDerivedState`  is the canonical derived-state rebuild; Yui's
 *    authoritative state is self-contained in `state.json`, so it rebuilds only
 *    the effects a step declared (none, while the registry is empty).
 *  - `validateCurrentState` constructs `new FileTaskStore(outputHome)` and reads
 *    it once, which forces the strict `parseState` gate (record validation,
 *    id counters, and the full reference graph). Any failure throws and the
 *    engine aborts before switching.
 *  - `atomicSwitchWithBackup` promotes the staged output into the same logical
 *    Home path, backing up the original under a timestamped sibling, using the
 *    durable temp+rename+fsync discipline.
 *
 * The registry ships EMPTY, so against a real current Home the engine is a
 * no-op and none of the write paths run; they are exercised by tests that inject
 * a synthetic registry, and are ready for the first real historical step.
 */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeTextFileAtomically } from "../durableFile.js";
import { inspectStorageSchema, STORAGE_SCHEMA_FILE } from "../storageSchema.js";
import { FileTaskStore, STORAGE_STATE_FILE } from "../taskStore.js";
import { readUpgradeFence, type UpgradeFence } from "../upgradeFence.js";
import type {
  DerivedStateSummary,
  LiveRuntimeStatus,
  MigrationTarget,
  StorageVersionState,
  SwitchOutcome,
  ValidationSummary
} from "../migration/index.js";

/** The read-only, structural snapshot of a source Home. */
export type HomeSnapshot = Readonly<{
  /** Parsed `schema.json` manifest. */
  schemaManifest: Readonly<Record<string, unknown>>;
  /** Parsed `state.json`, or `null` when the source has none yet. */
  state: Readonly<Record<string, unknown>> | null;
}>;

const STATE_LOCK_DIRECTORY = ".state.lock";
const CONTROLLER_DISCOVERY_FILE = "runtime/controller.json";

/** Layout-agnostic runtime signals used by the quiesce gate and the engine. */
export type HomeRuntimeSignals = Readonly<{
  /** A `.state.lock` held by a live foreign process (another writer). */
  foreignWriteLock: Readonly<{ ownerPid: number }> | null;
  /** A live per-home Controller (its discovery file names a live process). */
  liveController: Readonly<{ pid: number }> | null;
  /** The current upgrade fence, if any. */
  fence: UpgradeFence | null;
}>;

/**
 * Inspect the layout-agnostic runtime signals of a Home. These files
 * (`.state.lock`, `runtime/controller.json`) do not depend on the storage
 * version, so this is safe to call against an older, not-yet-migrated Home.
 */
export function inspectHomeRuntime(
  home: string,
  callerPid: number = process.pid
): HomeRuntimeSignals {
  return {
    foreignWriteLock: inspectForeignWriteLock(home, callerPid),
    liveController: inspectLiveController(home),
    fence: readUpgradeFence(home)
  };
}

/** True when any live runtime is actively holding the Home right now. */
export function homeRuntimeIsActive(signals: HomeRuntimeSignals): boolean {
  return signals.foreignWriteLock !== null || signals.liveController !== null;
}

export type HomeMigrationTargetOptions = Readonly<{
  /** The authoritative source Home (never written until the atomic switch). */
  home: string;
  /** The latest supported version state (scalar axes + current record map). */
  latest: StorageVersionState;
  /** Injected clock for deterministic backup stamps. */
  now?: () => Date;
  /** Where to stage the fresh output; defaults to a sibling of `home`. */
  stagingPath?: string;
  /** This process's pid, for foreign-writer detection. */
  callerPid?: number;
}>;

export type HomeMigrationTarget = MigrationTarget<HomeSnapshot> & Readonly<{
  /** The staged fresh-output directory this target writes/promotes/discards. */
  stagingPath: string;
}>;

/** Build the real Home-bound migration target. */
export function createHomeMigrationTarget(
  options: HomeMigrationTargetOptions
): HomeMigrationTarget {
  const home = options.home;
  const latest = options.latest;
  const now = options.now ?? (() => new Date());
  const callerPid = options.callerPid ?? process.pid;
  const stagingPath = options.stagingPath ?? `${home}.upgrade-staging`;

  return {
    stagingPath,

    inspectVersions(): StorageVersionState {
      const schema = inspectStorageSchema(home);
      switch (schema.status) {
        case "current":
        case "unsupported":
          return {
            layout: schema.currentLayoutVersion,
            aggregate: schema.currentAggregateSchemaVersion,
            // Record families are validated per-version by parseState, so a
            // readable current Home is provably at the current record map; an
            // older/newer scalar axis blocks first in planner order, so the
            // source record map is only consulted when it is already current.
            record: latest.record
          };
        case "uninitialized":
          throw new Error(
            "Cannot inspect versions: Yui storage is not initialized. Run `yui setup`."
          );
        case "invalid":
          throw new Error(`Storage schema manifest is invalid: ${schema.detail}`);
      }
    },

    detectLiveRuntime(): LiveRuntimeStatus {
      const signals = inspectHomeRuntime(home, callerPid);
      if (!homeRuntimeIsActive(signals)) return { active: false };
      const detail = signals.liveController !== null
        ? `Controller pid ${signals.liveController.pid} is running.`
        : `Another writer holds ${STATE_LOCK_DIRECTORY} (pid ${signals.foreignWriteLock?.ownerPid}).`;
      return { active: true, detail };
    },

    readSource(): HomeSnapshot {
      const manifestRaw = readFileSync(join(home, STORAGE_SCHEMA_FILE), "utf8");
      const schemaManifest = parseJsonObject(manifestRaw, STORAGE_SCHEMA_FILE);
      const statePath = join(home, STORAGE_STATE_FILE);
      const state = existsSync(statePath)
        ? parseJsonObject(readFileSync(statePath, "utf8"), STORAGE_STATE_FILE)
        : null;
      return Object.freeze({ schemaManifest, state });
    },

    writeFreshOutput(snapshot: HomeSnapshot): void {
      if (existsSync(stagingPath)) {
        throw new Error(
          `Refusing to overwrite an existing staged upgrade output: ${stagingPath}. `
            + "Delete it and retry."
        );
      }
      mkdirSync(stagingPath, { recursive: true, mode: 0o700 });
      writeTextFileAtomically(
        join(stagingPath, STORAGE_SCHEMA_FILE),
        `${JSON.stringify(snapshot.schemaManifest, null, 2)}\n`
      );
      if (snapshot.state !== null) {
        writeTextFileAtomically(
          join(stagingPath, STORAGE_STATE_FILE),
          `${JSON.stringify(snapshot.state, null, 2)}\n`
        );
      }
    },

    rebuildDerivedState(effects: readonly string[]): DerivedStateSummary {
      // Yui's authoritative data is fully contained in state.json; id counters
      // and the reference graph are validated by parseState in the next step.
      // There is no separate on-disk derived index to rebuild, so this echoes
      // the effects a step declared (none while the registry is empty). New
      // record families that introduce out-of-band derived state extend here.
      return { rebuiltEffects: [...effects] };
    },

    validateCurrentState(): ValidationSummary {
      // The real post-migration loader gate: constructing the store runs the
      // strict schema check, and a single read forces parseState across every
      // record family plus the full reference graph. Any failure throws.
      const store = new FileTaskStore(stagingPath);
      store.getConfig();
      const tasks = store.listTasks();
      store.listProjects();
      store.listConfiguredAgents();
      store.listWorkMailboxes();
      return {
        checks: [
          {
            name: "FileTaskStore loader",
            outcome: "passed",
            detail: `parsed state, reference graph, and ${tasks.length} task(s)`
          }
        ]
      };
    },

    atomicSwitchWithBackup(): SwitchOutcome {
      if (!existsSync(stagingPath)) {
        throw new Error(`No staged output to promote: ${stagingPath}.`);
      }
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      const backupPath = join(dirname(home), `${basename(home)}.backup-${stamp}`);
      if (existsSync(backupPath)) {
        throw new Error(`Refusing to overwrite an existing backup: ${backupPath}.`);
      }
      // Two atomic renames on the same filesystem. The only non-atomic window is
      // between them; if interrupted there, the source lives intact at the
      // backup path and recovery is a single `mv <backup> <home>`.
      renameSync(home, backupPath);
      fsyncDirectory(dirname(home));
      renameSync(stagingPath, home);
      fsyncDirectory(dirname(home));
      return {
        backupPath,
        detail: `Original Home backed up at ${backupPath}.`
      };
    },

    discardFreshOutput(): void {
      rmSync(stagingPath, { recursive: true, force: true });
    }
  };
}

function inspectForeignWriteLock(
  home: string,
  callerPid: number
): Readonly<{ ownerPid: number }> | null {
  const ownerPath = join(home, STATE_LOCK_DIRECTORY, "owner");
  let ownerPid: number;
  try {
    ownerPid = Number.parseInt(readFileSync(ownerPath, "utf8"), 10);
  } catch (error) {
    // No lock directory (or no owner file yet) means no foreign writer.
    if (isEnoent(error)) return null;
    throw error;
  }
  if (!Number.isInteger(ownerPid) || ownerPid === callerPid) return null;
  return processIsAlive(ownerPid) ? { ownerPid } : null;
}

function inspectLiveController(home: string): Readonly<{ pid: number }> | null {
  let raw: string;
  try {
    raw = readFileSync(join(home, CONTROLLER_DISCOVERY_FILE), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const pid = value.pid;
    if (Number.isInteger(pid) && processIsAlive(pid as number)) {
      return { pid: pid as number };
    }
  } catch {
    // A malformed discovery file is treated as no live controller.
  }
  return null;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
