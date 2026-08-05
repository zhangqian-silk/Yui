/**
 * The `yui update` orchestration.
 *
 * The previous implementation ran `npm install --global` *first*, which is
 * self-contradictory with "on failure the old CLI and Home are both unchanged":
 * once the global package is replaced there is nothing to fall back to. This
 * orchestrator replaces that with a side-by-side staging flow:
 *
 *   stage (side-by-side, never touches the live install)
 *     -> preflight  (the STAGED new binary inspects the target Home read-only)
 *     -> [only if safe] activate storage  (recoverable: backup + no auto-downgrade
 *                                           once the new version resumes writes)
 *     -> activate binary  (promote the staged package to the live install)
 *     -> post-verify  (the new binary's real loader + reference-graph health check)
 *
 * ## Rollback boundary (NARROWED — no versioned binary pointer is introduced)
 *
 * This release deliberately does NOT introduce a stable launcher or a versioned
 * binary pointer, so it does NOT claim binary+Home dual-resource atomicity. The
 * guarantees it DOES make, precisely:
 *
 *  - **Staging is isolated.** `stage` installs side-by-side and never mutates the
 *    live global install, so a stage/preflight failure leaves the old binary and
 *    the Home byte-for-byte unchanged.
 *  - **Storage activation is recoverable until writes resume.** The Home switch is
 *    atomic with a timestamped backup (see the migration engine). Before the new
 *    version resumes writes, recovery is a single restore of that backup.
 *  - **No auto-downgrade after writes.** Once the new version has resumed writes
 *    (a new Controller/first write against the migrated Home), the tool never
 *    auto-reverts; the migrated Home is authoritative.
 *
 * The one window it CANNOT make atomic is: storage already switched to the new
 * schema, but binary promotion then fails. Because the axes are version-gated,
 * the old binary fail-closes on the new Home rather than misreading it; recovery
 * is to restore the timestamped Home backup (the exact command is printed), after
 * which the old binary works again. This is stated in the failure output, not
 * hidden behind a false atomicity claim.
 */

/** A side-by-side staged package, isolated from the live global install. */
export type StagedPackage = Readonly<{
  /** Absolute path to the staged `yui` binary. */
  binaryPath: string;
  /** The staged package version (for reporting). */
  version: string;
  /** The staging root to remove on cleanup. */
  stagingPath?: string;
}>;

/** Read-only preflight verdict produced by the staged binary against the Home. */
export type UpdatePreflight = Readonly<
  | { status: "already-current" }
  | { status: "migratable"; summary: string }
  | { status: "blocked"; stage: string; message: string; action: string }
>;

/** The result of promoting the staged storage into place (recoverable step). */
export type StorageActivation = Readonly<
  | { status: "already-current" }
  | { status: "migrated"; backupPath?: string }
  | { status: "blocked"; stage: string; message: string; action: string }
  /**
   * The activation child did not return a parseable success/failure receipt
   * (e.g. killed by SIGTERM/OOM after the atomic switch, or crashed before
   * printing its JSON). The storage state is UNKNOWN: the switch may or may not
   * have committed. Never treat this as recoverable-and-unchanged (P1-2); the
   * orchestrator resolves the true state from the on-disk receipt + backup +
   * schema and reports an explicit manual recovery.
   */
  | { status: "ambiguous"; detail: string }
>;

/**
 * A read-only probe of the target Home's storage state, used to resolve an
 * ambiguous activation. `switched` is a durable receipt the activation writes
 * the instant its atomic switch commits; `backupPath` locates the pre-switch
 * Home; `schemaCurrent` says whether the Home now loads at the current version.
 */
export type StorageStateProbe = Readonly<{
  /** A completion receipt was found (the switch provably committed). */
  switched: boolean;
  /** The timestamped backup of the pre-switch Home, when known. */
  backupPath?: string;
  /** Whether the on-disk Home is now at the current, loadable schema. */
  schemaCurrent: boolean;
}>;

/**
 * Injected side effects. The real implementations spawn npm and the staged
 * binary; tests inject fakes so the ordering and recovery guarantees are
 * verifiable without a destructive global install.
 */
export type UpdatePorts = Readonly<{
  /** Install the latest package side-by-side; never touch the live install. */
  stage: () => StagedPackage;
  /** Run the staged binary's read-only preflight against the target Home. */
  preflight: (staged: StagedPackage, home: string) => UpdatePreflight;
  /** Promote the staged storage into place (atomic switch + backup). */
  activateStorage: (staged: StagedPackage, home: string) => StorageActivation;
  /** Promote the SAME staged artifact to the live global install (P1-3). */
  activateBinary: (staged: StagedPackage) => void;
  /**
   * New-binary health check over the migrated Home; throws on failure. Runs the
   * ACTUALLY-ACTIVATED global binary (not the staging path) and confirms its
   * version/identity matches the staged artifact (P1-3).
   */
  verify: (staged: StagedPackage, home: string) => void;
  /**
   * Read-only probe of the Home's storage state, to resolve an ambiguous
   * activation from the durable receipt + backup + current schema (P1-2).
   */
  probeStorage: (home: string) => StorageStateProbe;
  /** Best-effort staging cleanup. */
  cleanup: (staged: StagedPackage) => void;
}>;

/** The structured outcome of an update attempt. */
export type UpdateResult = Readonly<
  | { outcome: "already-current"; version: string }
  | { outcome: "updated"; version: string; storageBackupPath?: string }
  | {
      outcome: "aborted";
      phase: UpdatePhase;
      message: string;
      action: string;
      /** True while the old binary and Home are provably still intact. */
      recoverable: boolean;
      version?: string;
      storageBackupPath?: string;
    }
  /**
   * The storage activation's outcome could not be determined: the switch may or
   * may not have committed. This is NEITHER a clean recovery NOR a completed
   * update — it demands manual verification. Carries the best available evidence
   * (receipt/backup/schema) and the precise steps to resolve it (P1-2).
   */
  | {
      outcome: "ambiguous";
      phase: UpdatePhase;
      message: string;
      action: string;
      version?: string;
      storageBackupPath?: string;
      /** Whether the on-disk Home is now at the current, loadable schema. */
      schemaCurrent: boolean;
      /** Whether a durable completion receipt was found. */
      switched: boolean;
    }
>;

/** The precise phase an update aborted in. */
export type UpdatePhase =
  | "stage"
  | "preflight"
  | "activate-storage"
  | "activate-binary"
  | "post-verify";

/**
 * Run the update orchestration. Never performs an irreversible step before the
 * read-only preflight has proven the Home is safe, and reports the precise phase
 * plus a recovery action on any failure.
 */
export function runUpdate(
  ports: UpdatePorts,
  options: Readonly<{ home: string }>
): UpdateResult {
  const home = options.home;

  // 1) Stage side-by-side. A failure here leaves the live install untouched.
  let staged: StagedPackage;
  try {
    staged = ports.stage();
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "stage",
      message: `Failed to stage the new package: ${messageOf(error)}`,
      action: "The current install and Home are unchanged. Fix the staging error and retry.",
      recoverable: true
    };
  }

  try {
    // 2) Preflight — the staged binary inspects the Home read-only; no switch.
    const preflight = ports.preflight(staged, home);
    if (preflight.status === "blocked") {
      return {
        outcome: "aborted",
        phase: "preflight",
        message: preflight.message,
        action: preflight.action,
        recoverable: true,
        version: staged.version
      };
    }

    if (preflight.status === "already-current") {
      // Nothing to migrate; promote the binary and verify. Storage is untouched.
      return activateAndVerify(ports, staged, home, undefined);
    }

    // 3) Activate storage — recoverable: atomic switch + timestamped backup.
    const activation = ports.activateStorage(staged, home);
    if (activation.status === "blocked") {
      return {
        outcome: "aborted",
        phase: "activate-storage",
        message: activation.message,
        action: activation.action,
        // The engine guarantees the source Home is unchanged on a blocked/failed
        // migration, and the binary has not been promoted, so this is recoverable.
        recoverable: true,
        version: staged.version
      };
    }
    if (activation.status === "ambiguous") {
      // The activation child left no parseable receipt: the switch may or may not
      // have committed. Resolve the true state from the durable on-disk evidence
      // and report an explicit manual recovery — never a false "recoverable".
      return resolveAmbiguousActivation(ports, staged, home, activation.detail);
    }
    const backupPath = activation.status === "migrated" ? activation.backupPath : undefined;

    // 4/5) Promote the binary, then post-verify with the new binary's loader.
    return activateAndVerify(ports, staged, home, backupPath);
  } finally {
    ports.cleanup(staged);
  }
}

/**
 * Promote the staged binary and run the new-binary health check. This is the
 * last, non-atomic step: after storage has switched, binary promotion cannot be
 * made atomic with it, so a failure here is reported with the exact backup-based
 * recovery and is NOT auto-reverted once the new version would resume writes.
 */
function activateAndVerify(
  ports: UpdatePorts,
  staged: StagedPackage,
  home: string,
  storageBackupPath: string | undefined
): UpdateResult {
  try {
    ports.activateBinary(staged);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "activate-binary",
      message: `Failed to activate the new binary: ${messageOf(error)}`,
      action: storageBackupPath === undefined
        ? "Storage was not migrated; the current install may be partially replaced. "
          + "Re-run `yui update` to complete, or reinstall the package."
        : `Storage was migrated (backup at ${storageBackupPath}). The old binary `
          + "fail-closes on the new Home rather than misreading it. To fully revert, "
          + `restore the backup: mv "${storageBackupPath}" "${home}". Otherwise re-run `
          + "`yui update` to finish promoting the new binary.",
      // Recoverable ONLY while storage was not yet switched. Once storage is
      // migrated, this is a narrowed, backup-based manual recovery, not an
      // automatic downgrade.
      recoverable: storageBackupPath === undefined,
      version: staged.version,
      ...(storageBackupPath === undefined ? {} : { storageBackupPath })
    };
  }

  try {
    ports.verify(staged, home);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "post-verify",
      message: `Post-update health check failed: ${messageOf(error)}`,
      action: storageBackupPath === undefined
        ? "The new binary did not pass its health check. Investigate before using Yui."
        : `The migrated Home did not pass the new binary's health check. Restore the `
          + `backup to recover: mv "${storageBackupPath}" "${home}".`,
      recoverable: false,
      version: staged.version,
      ...(storageBackupPath === undefined ? {} : { storageBackupPath })
    };
  }

  return storageBackupPath === undefined
    ? { outcome: "updated", version: staged.version }
    : { outcome: "updated", version: staged.version, storageBackupPath };
}

/**
 * Resolve an ambiguous storage activation (P1-2): the activation child left no
 * parseable receipt, so the switch may or may not have committed. Probe the
 * durable on-disk evidence and report an explicit manual recovery — this is
 * NEVER reported as recoverable-and-unchanged.
 *
 * The verdict is driven by the completion receipt first (the switch writes it the
 * instant it commits), then corroborated by the on-disk schema:
 *  - receipt present  -> the switch committed; point at the backup and require
 *    the operator to verify the migrated Home before resuming (the binary was
 *    never promoted, so the old binary fail-closes on the new schema).
 *  - no receipt, schema already current -> most likely the switch never ran
 *    (or fully reverted); still require an explicit re-run rather than asserting
 *    "unchanged", because stdout was lost.
 *  - no receipt, schema not current -> genuinely indeterminate; give the
 *    operator the exact files to inspect.
 */
function resolveAmbiguousActivation(
  ports: UpdatePorts,
  staged: StagedPackage,
  home: string,
  detail: string
): UpdateResult {
  let probe: StorageStateProbe;
  try {
    probe = ports.probeStorage(home);
  } catch (error) {
    // Even the probe failed: report maximum uncertainty with the raw evidence.
    return {
      outcome: "ambiguous",
      phase: "activate-storage",
      message: `Storage activation result is unknown (${detail}); probing the Home also failed: ${messageOf(error)}.`,
      action:
        `Do NOT assume the update succeeded or was a no-op. Manually inspect ${home} and any `
        + `"${home}.backup-*" sibling and "${home}.upgrade-receipt.json"; if a receipt exists the `
        + `switch committed — verify the migrated Home with "yui doctor" before resuming, otherwise `
        + `restore the newest backup with mv before re-running "yui update".`,
      version: staged.version,
      schemaCurrent: false,
      switched: false
    };
  }

  if (probe.switched) {
    // The switch provably committed; the binary was not promoted.
    return {
      outcome: "ambiguous",
      phase: "activate-storage",
      message:
        `Storage was switched (a completion receipt is present) but the activation process `
        + `did not confirm success (${detail}). The new binary was NOT promoted.`,
      action:
        `Verify the migrated Home before resuming writes: run "yui doctor"`
        + `${probe.backupPath === undefined ? "" : ` (its timestamped backup is ${probe.backupPath})`}. `
        + `If it is healthy, finish by re-running "yui update" to promote the binary; if not, restore `
        + `the backup with mv "${probe.backupPath ?? "<home>.backup-*"}" "${home}". Do NOT resume `
        + `writes with the old binary against the migrated Home.`,
      version: staged.version,
      schemaCurrent: probe.schemaCurrent,
      switched: true,
      ...(probe.backupPath === undefined ? {} : { storageBackupPath: probe.backupPath })
    };
  }

  // No receipt: the switch most likely never committed, but stdout was lost so we
  // cannot assert "unchanged". Require an explicit, verified re-run.
  return {
    outcome: "ambiguous",
    phase: "activate-storage",
    message:
      `Storage activation did not confirm a result (${detail}) and no completion receipt was found`
      + `${probe.schemaCurrent ? "; the Home currently loads at the current schema" : ""}.`,
    action:
      `The switch most likely did not commit, but this was not confirmed. Verify with "yui doctor" `
      + `and check for any "${home}.backup-*" sibling before retrying; then re-run "yui update". Do `
      + `NOT assume the update completed.`,
    version: staged.version,
    schemaCurrent: probe.schemaCurrent,
    switched: false
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
