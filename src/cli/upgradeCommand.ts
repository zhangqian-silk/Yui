/**
 * `yui upgrade` — the diagnostic/manual storage upgrade entry point.
 *
 * `yui upgrade --dry-run` first classifies read-only. Compatible-old validates
 * through the in-memory current-model gate and returns without staging a Home;
 * migration-required also proves the offline runtime inventory before it stages
 * and validates a fresh copy. The hidden `--update-preflight` contract stops at
 * classification, compatible-source validation, or offline inventory as required
 * by the classified path, so a staged updater can run it while the old Controller
 * remains live without a false staged-output validation claim. Execute enters
 * fence/quiesce/switch only for the offline path. Only explicitly declared
 * production paths can run; the aggregate `16→17` and execution record-family
 * transitions remain offline migrations.
 *
 * Like `doctor`/`controller`, this command needs a Home but manages its own
 * schema check (it must run against a non-current Home), so it is dispatched
 * before the unconditional `requireStorageSchema` gate in `cli.ts`.
 */

import { createProductionStorageRegistry } from "../storage/compatibleTaskStore.js";
import { latestStorageVersionState } from "../storage/upgrade/recordVersions.js";
import {
  runStorageUpgrade,
  type UpgradeResult
} from "../storage/upgrade/upgradeOrchestrator.js";
import { usageError } from "../errors/cliError.js";

export type UpgradeCommandResult = Readonly<{
  output: string;
  data: UpgradeResult;
  exitCode: number;
}>;

/**
 * Run the upgrade command. Parses the public `[--dry-run]` form plus the staged
 * updater's internal `--update-preflight` form, then returns rendered text,
 * structured data, and an exit code (0 for a safe result, 5 for a blocker).
 */
export async function runUpgradeCommand(
  args: readonly string[],
  home: string,
  options: Readonly<{
    now?: () => Date;
    controllerLifecycle?: "owned" | "externally-quiesced";
    externalUpgradeFenceOwnerPid?: number;
  }> = {}
): Promise<UpgradeCommandResult> {
  const mode = parseUpgradeArgs(args);
  const result = await runStorageUpgrade({
    home,
    registry: createProductionStorageRegistry(),
    latest: latestStorageVersionState(),
    mode,
    ...(options.controllerLifecycle === undefined
      ? {}
      : { controllerLifecycle: options.controllerLifecycle }),
    ...(options.externalUpgradeFenceOwnerPid === undefined
      ? {}
      : { externalUpgradeFenceOwnerPid: options.externalUpgradeFenceOwnerPid }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  return {
    output: renderUpgradeResult(result, mode),
    data: result,
    exitCode: result.outcome === "blocked" ? 5 : 0
  };
}

export type UpgradeCommandMode = "dry-run" | "execute" | "update-preflight";

function parseUpgradeArgs(args: readonly string[]): UpgradeCommandMode {
  if (args.length === 0) return "execute";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  // Intentionally omitted from public command help: this is the machine contract
  // used by a staged `yui update`, not a replacement for user-facing dry-run.
  if (args.length === 1 && args[0] === "--update-preflight") return "update-preflight";
  throw usageError("Upgrade usage: yui upgrade [--dry-run]");
}

/** Render an {@link UpgradeResult} as concise, CLI-style text. */
export function renderUpgradeResult(
  result: UpgradeResult,
  mode: UpgradeCommandMode
): string {
  const header = versionHeader(result);
  switch (result.outcome) {
    case "already-current":
      return `${header}\nStorage is already at the current version; nothing to upgrade.`;
    case "compatible":
      return `${header}\nStorage is compatible-old and can be opened by the current loader. `
        + "No Home migration, backup, or switch is required.";
    case "update-preflight": {
      const evidence = result.status === "already-current"
        ? "four-state classification"
        : result.status === "compatible"
          ? "four-state classification plus compatible-source validation"
          : result.status === "in-place-migration"
            ? "SQLite ledger classification plus a clear offline runtime inventory"
            : "four-state classification plus a clear offline runtime inventory";
      return `${header}\nUpdate preflight: ${result.status} (${result.stepCount} step(s)); `
        + `${evidence}. No staged Home was created, `
        + "no staged-output loader validation was performed, and storage was not switched.";
    }
    case "dry-run": {
      const steps = result.classification.sqliteMigration?.pendingVersions.length
        ?? (result.report.outcome === "dry-run" ? result.report.steps.length : 0);
      return `${header}\nDry run: validated ${steps} migration step(s) through the loader gate. `
        + "Staged output discarded; storage was not switched.";
    }
    case "upgraded":
      return result.migrationMode === "in-place"
        ? `${header}\nUpgraded SQLite in place in one transaction; no database rebuild or backup copy was created.`
        : `${header}\nUpgraded storage. Original Home backed up at `
          + `${result.backupPath ?? "(unspecified)"}.`;
    case "blocked": {
      // Most blockers guarantee the source is untouched. A partial switch or a
      // post-switch ambiguity explicitly carries the committed boundary and
      // named recovery evidence; never print a false unchanged claim there.
      const unchangedNote = result.storageCommitted === true
        ? "The SQLite transaction committed in place; the old Controller was not restored (see Action)."
        : result.switchCommitted === true
          ? "The storage switch committed, but post-switch completion is ambiguous; the old Controller was not restored (see Action and recovery evidence)."
          : result.stage === "switch-ambiguous"
            ? "The switch did not complete and could not be rolled back; the authoritative Home is NOT intact (see Action)."
            : "Storage was not switched; the authoritative Home is unchanged.";
      return [
        header,
        `${mode === "dry-run" ? "Dry run" : mode === "update-preflight" ? "Update preflight" : "Upgrade"} blocked at ${result.stage}: ${result.message}`,
        `Action: ${result.action}`,
        unchangedNote
      ].join("\n");
    }
  }
}

function versionHeader(result: UpgradeResult): string {
  const classification = result.classification;
  const layout = classification.layoutVersion ?? classification.latestLayoutVersion;
  const aggregate = classification.aggregateVersion ?? classification.latestAggregateVersion;
  const verdict = classification.classification.verdict;
  const incompatible = classification.incompatibleComponent === undefined
    ? ""
    : ` incompatibleComponent=${classification.incompatibleComponent}`;
  return `Storage: ${verdict} layout=${layout}/${classification.latestLayoutVersion} `
    + `aggregate=${aggregate}/${classification.latestAggregateVersion}${incompatible}`;
}
