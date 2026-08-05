/**
 * `yui upgrade` — the diagnostic/manual storage upgrade entry point.
 *
 * `yui upgrade --dry-run` runs a read-only preflight + plan, validates through
 * the staged loader gate, prints the {@link MigrationReport}, and discards the
 * staged output without ever switching. `yui upgrade` (execute) runs the full
 * fence + quiesce/drain + re-pin + snapshot/switch + post-verify flow, and on any
 * failure reports the precise blocker stage and recovery action without
 * switching. The registry ships EMPTY, so against a current Home this is a
 * no-op and against any strictly-older Home it is a fail-closed
 * `NEEDS_NEW_VERSION`.
 *
 * Like `doctor`/`controller`, this command needs a Home but manages its own
 * schema check (it must run against a non-current Home), so it is dispatched
 * before the unconditional `requireStorageSchema` gate in `cli.ts`.
 */

import { createEmptyRegistry } from "../storage/migration/index.js";
import type { HomeSnapshot } from "../storage/upgrade/homeMigrationTarget.js";
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
 * Run the upgrade command. Parses `[--dry-run]`, runs the orchestrator against
 * the resolved Home, and returns rendered text + structured data + an exit code
 * (0 for success/already-current/dry-run, 5 for a blocked upgrade).
 */
export async function runUpgradeCommand(
  args: readonly string[],
  home: string,
  options: Readonly<{ now?: () => Date }> = {}
): Promise<UpgradeCommandResult> {
  const mode = parseUpgradeArgs(args);
  const result = await runStorageUpgrade({
    home,
    registry: createEmptyRegistry<HomeSnapshot>(),
    latest: latestStorageVersionState(),
    mode,
    ...(options.now === undefined ? {} : { now: options.now })
  });
  return {
    output: renderUpgradeResult(result, mode),
    data: result,
    exitCode: result.outcome === "blocked" ? 5 : 0
  };
}

function parseUpgradeArgs(args: readonly string[]): "dry-run" | "execute" {
  if (args.length === 0) return "execute";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  throw usageError("Upgrade usage: yui upgrade [--dry-run]");
}

/** Render an {@link UpgradeResult} as concise, CLI-style text. */
export function renderUpgradeResult(
  result: UpgradeResult,
  mode: "dry-run" | "execute"
): string {
  const header = versionHeader(result);
  switch (result.outcome) {
    case "already-current":
      return `${header}\nStorage is already at the current version; nothing to upgrade.`;
    case "dry-run": {
      const steps = result.report.outcome === "dry-run" ? result.report.steps.length : 0;
      return `${header}\nDry run: validated ${steps} migration step(s) through the loader gate. `
        + "Staged output discarded; storage was not switched.";
    }
    case "upgraded":
      return `${header}\nUpgraded storage. Original Home backed up at `
        + `${result.backupPath ?? "(unspecified)"}.`;
    case "blocked":
      return [
        header,
        `${mode === "dry-run" ? "Dry run" : "Upgrade"} blocked at ${result.stage}: ${result.message}`,
        `Action: ${result.action}`,
        "Storage was not switched; the authoritative Home is unchanged."
      ].join("\n");
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
