/** `yui upgrade` validates the exact storage contract supported by this release. */
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
  home: string
): Promise<UpgradeCommandResult> {
  const mode = parseUpgradeArgs(args);
  const result = await runStorageUpgrade({
    home,
    latest: latestStorageVersionState(),
    mode
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
  // used by a staged `yui update`, not a replacement for user-facing dry-turn.
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
    case "update-preflight":
      return `${header}\nUpdate preflight: ${result.status} (${result.stepCount} steps). Storage was not modified.`;
    case "blocked": {
      return [
        header,
        `${mode === "dry-run" ? "Dry run" : mode === "update-preflight" ? "Update preflight" : "Upgrade"} blocked at ${result.stage}: ${result.message}`,
        `Action: ${result.action}`,
        "The authoritative Home is unchanged."
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
