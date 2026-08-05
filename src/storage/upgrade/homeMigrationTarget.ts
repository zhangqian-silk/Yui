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
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeTextFileAtomically } from "../durableFile.js";
import { inspectStorageSchema, STORAGE_SCHEMA_FILE } from "../storageSchema.js";
import { FileTaskStore, STORAGE_STATE_FILE } from "../taskStore.js";
import { readUpgradeFence, type UpgradeFence } from "../upgradeFence.js";
import { scanSourceRecordVersions } from "./recordVersionScan.js";
import {
  clearSwitchProgress,
  writeSwitchProgress
} from "./switchProgress.js";
import {
  AmbiguousSwitchError,
  type DerivedStateSummary,
  type LiveRuntimeStatus,
  type MigrationTarget,
  type StorageVersionState,
  type SwitchOutcome,
  type ValidationSummary
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

/**
 * A `.state.lock` holder. The lock is acquired mkdir-first and the owner file is
 * written a moment later (see `taskStore.acquireStorageLock`), so a lock whose
 * owner is missing/unreadable/non-integer/empty is NOT provably absent — it may
 * be a writer mid-acquisition or a live process whose owner file we cannot read.
 * The quiesce gate must treat that as active and fail closed, never fail open.
 */
export type WriteLockHolder = Readonly<
  /** The owner file names a live foreign process. */
  | { state: "live"; ownerPid: number }
  /**
   * The lock directory exists but its owner cannot be determined (missing,
   * empty, non-integer, or unreadable). Fail-closed: treated as active.
   */
  | { state: "unknown" }
>;

/** Discovery of the per-home Controller from its `runtime/controller.json`. */
export type ControllerDiscovery = Readonly<
  /** The discovery file names a live process. */
  | { state: "live"; pid: number }
  /**
   * The discovery file exists but is malformed/unparseable, so we cannot rule
   * out a live Controller. Fail-closed: treated as active.
   */
  | { state: "unknown" }
>;

/** Layout-agnostic runtime signals used by the quiesce gate and the engine. */
export type HomeRuntimeSignals = Readonly<{
  /**
   * A `.state.lock` holder, or `null` only when the lock directory is provably
   * absent. A present-but-undeterminable lock is `{ state: "unknown" }`, not
   * `null`, so an ambiguous lock fails closed.
   */
  foreignWriteLock: WriteLockHolder | null;
  /**
   * The per-home Controller discovery, or `null` only when there is provably no
   * discovery file. A present-but-malformed file is `{ state: "unknown" }`.
   */
  liveController: ControllerDiscovery | null;
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

/**
 * True when any live-or-undeterminable runtime is holding the Home. A holder we
 * cannot positively clear (`unknown`) counts as active — fail closed.
 */
export function homeRuntimeIsActive(signals: HomeRuntimeSignals): boolean {
  return signals.foreignWriteLock !== null || signals.liveController !== null;
}

/** A human-readable description of why the runtime is considered active. */
export function describeActiveRuntime(signals: HomeRuntimeSignals): string {
  if (signals.liveController !== null) {
    return signals.liveController.state === "live"
      ? `Controller pid ${signals.liveController.pid} is running.`
      : `A ${CONTROLLER_DISCOVERY_FILE} exists but is malformed; a live Controller cannot be ruled out.`;
  }
  if (signals.foreignWriteLock !== null) {
    return signals.foreignWriteLock.state === "live"
      ? `Another writer holds ${STATE_LOCK_DIRECTORY} (pid ${signals.foreignWriteLock.ownerPid}).`
      : `${STATE_LOCK_DIRECTORY} exists but its owner is undeterminable; another writer cannot be ruled out.`;
  }
  return "A live runtime is holding the Home.";
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
  /**
   * Test seam for the atomic switch's renames. Defaults to `node:fs`
   * `renameSync`. Tests inject this to simulate a failure of the second rename
   * (staging -> home) after the first (home -> backup) committed, exercising the
   * partial-switch rollback / ambiguous-switch paths (P1-4). Production never
   * overrides it.
   */
  renameImpl?: (from: string, to: string) => void;
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
  // The promotion rename (staging -> home) is the only injectable one, so a test
  // can fail it after the backup rename committed. The backup and rollback
  // renames always use the real fs so rollback genuinely restores the original.
  const promoteRename = options.renameImpl ?? renameSync;

  return {
    stagingPath,

    inspectVersions(): StorageVersionState {
      const inspected = inspectSourceVersionState(home, latest);
      if ("corruption" in inspected) {
        // A structurally-damaged source cannot yield trustworthy versions. The
        // engine has no CORRUPTED outcome, so surface it as a hard error rather
        // than pretend the record axis is current (the classifier turns the same
        // structural damage into a CORRUPTED verdict for doctor/upgrade).
        throw new Error(inspected.corruption.detail);
      }
      return inspected.source;
    },

    detectLiveRuntime(): LiveRuntimeStatus {
      const signals = inspectHomeRuntime(home, callerPid);
      if (!homeRuntimeIsActive(signals)) return { active: false };
      return { active: true, detail: describeActiveRuntime(signals) };
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

      // COMPLETE HOME CONTENT PRESERVATION CONTRACT (P1-1)
      // -------------------------------------------------
      // The migration only TRANSFORMS schema.json + state.json, but the atomic
      // switch replaces the WHOLE Home directory (home -> backup, staging ->
      // home). If staging held only those two files, everything else the real
      // Home persists — runtime/inbox/* (AUTHORITATIVE, not-yet-applied events),
      // runtime/ discovery, cache/ and artifacts/ (rebuildable) — would be
      // silently lost on the first real migration.
      //
      // Chosen contract: staging carries a COMPLETE copy of the Home; only
      // schema.json + state.json are overwritten with their migrated bytes.
      // Every other entry (of any depth: dirs, files, symlinks) is copied
      // verbatim, so the switch preserves all authoritative and rebuildable
      // content. The two migrated files are written LAST so they always win over
      // any copied original. The transient `.state.lock` is NOT promoted (a lock
      // is per-instance coordination state, never authoritative Home content);
      // the upgrade fence under runtime/ is copied but cleared post-switch by
      // this process's fence release. See ARCHITECTURE.md "Complete Home content
      // preservation".
      copyHomeContentsExcept(
        home,
        stagingPath,
        new Set([
          STORAGE_SCHEMA_FILE,
          STORAGE_STATE_FILE,
          STATE_LOCK_DIRECTORY,
          basename(stagingPath)
        ])
      );

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
      // between them. A durable sibling marker records the phase so a reader can
      // distinguish not-started / interrupted / complete even if this process is
      // killed mid-switch (P1-4).
      writeSwitchProgress(home, {
        phase: "backing-up",
        homePath: home,
        backupPath,
        stagingPath,
        updatedAt: now().toISOString()
      });

      // Step 1: move the original aside. If this fails, nothing has moved and the
      // Home is genuinely unchanged — clear the marker and surface the error.
      try {
        renameSync(home, backupPath);
      } catch (error) {
        clearSwitchProgress(home);
        throw error;
      }
      fsyncDirectory(dirname(home));

      // The original is now at the backup: we are in the non-atomic window.
      writeSwitchProgress(home, {
        phase: "promoting",
        homePath: home,
        backupPath,
        stagingPath,
        updatedAt: now().toISOString()
      });

      // Step 2: promote the staged output into the Home path.
      try {
        promoteRename(stagingPath, home);
      } catch (promoteError) {
        // Promotion failed after the original was moved aside. The invariant
        // "the Home is unchanged" is now FALSE. Try to restore the original from
        // the backup so we can honestly report "rolled back, unchanged". The
        // rollback goes through the same rename seam: whatever fault blocked the
        // promotion (a read-only parent, a vanished path) would block the reverse
        // move too, so a test injecting a failing rename exercises both.
        try {
          promoteRename(backupPath, home);
          fsyncDirectory(dirname(home));
          clearSwitchProgress(home);
        } catch (rollbackError) {
          // Rollback ALSO failed: the switch is genuinely interrupted. Record the
          // interrupted phase durably and raise a precise, recoverable error —
          // never let the caller believe the Home is intact.
          writeSwitchProgress(home, {
            phase: "interrupted",
            homePath: home,
            backupPath,
            stagingPath,
            updatedAt: now().toISOString()
          });
          throw new AmbiguousSwitchError({
            homePath: home,
            backupPath,
            stagingPath,
            detail:
              `Storage switch is in an AMBIGUOUS, partially-applied state: the original Home was `
              + `moved to ${backupPath} but promoting the migrated output failed `
              + `(${messageOf(promoteError)}), and the automatic rollback also failed `
              + `(${messageOf(rollbackError)}). The Home path ${home} may be missing. Recover `
              + `manually by restoring the backup: mv "${backupPath}" "${home}".`
          });
        }
        // Rollback succeeded: the original is back in place, Home unchanged. Bubble
        // the original promotion error so the engine reports a failed switch with
        // the source intact (the engine's failure path never claims a switch).
        throw promoteError;
      }
      fsyncDirectory(dirname(home));

      // Both renames committed: the switch is complete. Clear the progress marker.
      clearSwitchProgress(home);
      return {
        status: "switched",
        backupPath,
        detail: `Original Home backed up at ${backupPath}.`
      };
    },

    discardFreshOutput(): void {
      rmSync(stagingPath, { recursive: true, force: true });
    }
  };
}

/**
 * The read-only source version state, or the structural corruption that blocks
 * reading it. Callers (the target's `inspectVersions`, the classifier) share this
 * so the three axes are read the same way in both places.
 */
export type SourceVersionInspection = Readonly<
  | { source: StorageVersionState }
  | { corruption: Readonly<{ corrupted: true; detail: string }> }
>;

/**
 * Read a source Home's full three-axis {@link StorageVersionState} read-only.
 *
 * The scalar `layout`/`aggregate` versions come from `schema.json`; the `record`
 * axis is extracted structurally from the raw `state.json` (never through the
 * strict `parseState`, which would conflate an older record family with
 * corruption — see P1-1 / `recordVersionScan.ts`). This is the single seam that
 * makes the record axis genuinely independent of the scalar axes: a record-only-
 * older Home yields an older `record` map here, so the planner produces a
 * record-axis verdict instead of the loader falsely reporting `CORRUPTED`.
 *
 * Returns `corruption` when the manifest is invalid, storage is uninitialized, or
 * `state.json` is structurally damaged; callers map that to a hard error (engine)
 * or a `CORRUPTED` verdict (classifier).
 */
export function inspectSourceVersionState(
  home: string,
  latest: StorageVersionState
): SourceVersionInspection {
  const schema = inspectStorageSchema(home);
  if (schema.status === "uninitialized") {
    return {
      corruption: {
        corrupted: true,
        detail: "Yui storage is not initialized. Run `yui setup`."
      }
    };
  }
  if (schema.status === "invalid") {
    return {
      corruption: {
        corrupted: true,
        detail: `Storage schema manifest is invalid: ${schema.detail}`
      }
    };
  }

  // schema.status is "current" or "unsupported": scalar axes are known. Read the
  // record axis structurally so an older/newer record family is a version fact,
  // not a parse failure.
  const scan = scanSourceRecordVersions(home, latest.record);
  if ("corruption" in scan) {
    return { corruption: scan.corruption };
  }
  return {
    source: {
      layout: schema.currentLayoutVersion,
      aggregate: schema.currentAggregateSchemaVersion,
      record: scan.record
    }
  };
}

/**
 * Inspect the `.state.lock` holder, fail-closed.
 *
 * Returns `null` ONLY when the lock directory is provably absent (no writer).
 * When the directory exists, the owner file is read: a clearly-live foreign pid
 * is `live`; a dead owner is reclaimable (`null`); but a missing, empty,
 * non-integer, or unreadable owner is `{ state: "unknown" }` — the lock is
 * acquired mkdir-first with the owner written a moment later, so an
 * undeterminable owner may be a writer mid-acquisition or a live process, and we
 * must not treat it as absent.
 */
function inspectForeignWriteLock(
  home: string,
  callerPid: number
): WriteLockHolder | null {
  const lockDir = join(home, STATE_LOCK_DIRECTORY);
  if (!existsSync(lockDir)) return null; // provably no lock: no writer.

  let raw: string;
  try {
    raw = readFileSync(join(lockDir, "owner"), "utf8");
  } catch (error) {
    // Lock dir exists but the owner file is missing/unreadable: a writer may be
    // mid-acquisition (mkdir done, owner not yet written). Fail closed.
    if (isEnoent(error)) return { state: "unknown" };
    return { state: "unknown" };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { state: "unknown" }; // empty/partial write.
  const ownerPid = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(ownerPid) || String(ownerPid) !== trimmed) {
    // Non-integer or malformed owner: undeterminable. Fail closed.
    return { state: "unknown" };
  }
  // Our own fence-exempt process re-pins under this lock; not a foreign writer.
  if (ownerPid === callerPid) return null;
  // Only a provably-dead owner is reclaimable (no writer); a live one is active.
  return processIsAlive(ownerPid) ? { state: "live", ownerPid } : null;
}

/**
 * Inspect the per-home Controller discovery, fail-closed.
 *
 * Returns `null` ONLY when there is provably no discovery file. A file naming a
 * live pid is `live`; a file naming a dead pid is `null` (no live Controller);
 * but a present-but-malformed/unparseable file is `{ state: "unknown" }` — we
 * cannot rule out a live Controller from unreadable discovery, so it fails
 * closed rather than being treated as "no controller".
 */
function inspectLiveController(home: string): ControllerDiscovery | null {
  const discoveryPath = join(home, CONTROLLER_DISCOVERY_FILE);
  let raw: string;
  try {
    raw = readFileSync(discoveryPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null; // provably no discovery file.
    return { state: "unknown" }; // present but unreadable: fail closed.
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: "unknown" }; // malformed JSON: cannot rule out a controller.
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { state: "unknown" };
  }
  const pid = (value as Record<string, unknown>).pid;
  if (!Number.isInteger(pid)) return { state: "unknown" }; // no usable pid.
  // A named pid that is dead means no live Controller; alive means active.
  return processIsAlive(pid as number) ? { state: "live", pid: pid as number } : null;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy every top-level entry of `sourceHome` into `destDir`, except the names in
 * `exclude`, preserving nested directories, files, symlinks, timestamps, and
 * modes. This implements the complete Home content preservation contract (P1-1):
 * the migrated schema.json/state.json are written by the caller afterward, and
 * everything else (runtime/inbox authoritative events, runtime/ discovery,
 * cache/, artifacts/) is carried verbatim so the atomic switch never drops it.
 *
 * Symlinks are copied as links (not dereferenced), so an in-Home symlink keeps
 * its target rather than duplicating content or escaping the Home. Copy failures
 * propagate: the engine aborts before the switch, leaving the source untouched.
 */
function copyHomeContentsExcept(
  sourceHome: string,
  destDir: string,
  exclude: ReadonlySet<string>
): void {
  for (const entry of readdirSync(sourceHome, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    cpSync(join(sourceHome, entry.name), join(destDir, entry.name), {
      recursive: true,
      // Copy symlinks as links rather than dereferencing them.
      dereference: false,
      // Preserve timestamps/mode so authoritative/rebuildable content is intact.
      preserveTimestamps: true,
      // The staging dir is fresh, so nothing should already exist; force keeps
      // the copy robust if a partial retry left a remnant.
      force: true,
      errorOnExist: false
    });
  }
}
