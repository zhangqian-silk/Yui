import { resolveYuiHome } from "../storage/taskStore.js";
import { createUpdatePorts, type UpdateSpawner } from "./updatePorts.js";
import { runUpdate, type UpdatePorts, type UpdateResult } from "./updateOrchestrator.js";

export type { UpdateSpawner } from "./updatePorts.js";

/**
 * Run `yui update` as a side-by-side, recoverable orchestration.
 *
 * The new package is staged beside the live install and used to run a read-only
 * preflight against the target Home. Current/compatible-old storage promotes the
 * binary through the exact Controller handoff without a Home switch; only a
 * migration-required verdict enters the offline backup/switch path. On failure
 * it reports the precise phase and recovery boundary. See
 * {@link runUpdate} for the exact, narrowed rollback boundary (this release does
 * not introduce a versioned binary pointer, so it does not claim binary+Home
 * dual-resource atomicity).
 *
 * Returns a process exit code: 0 on success or already-current, 5 on abort.
 */
export function runUpdateCommand(
  environment: NodeJS.ProcessEnv = process.env,
  spawn?: UpdateSpawner,
  write: (text: string) => void = (text) => process.stdout.write(text),
  ports?: UpdatePorts
): number {
  const home = resolveYuiHome(environment);
  const resolvedPorts = ports ?? createUpdatePorts(environment, spawn);
  const result = runUpdate(resolvedPorts, { home });
  write(`${renderUpdateResult(result)}\n`);
  // Both an abort and an ambiguous result are non-success exits; ambiguous is
  // distinct (manual verification required), so it gets its own exit code.
  if (result.outcome === "aborted") return 5;
  if (result.outcome === "ambiguous") return 6;
  return 0;
}

/** Render an {@link UpdateResult} as concise, CLI-style text. */
export function renderUpdateResult(result: UpdateResult): string {
  const rendered = (() => {
    switch (result.outcome) {
      case "already-current":
        return "Yui is already up to date; nothing to install.";
      case "updated":
        return result.storageBackupPath === undefined
          ? result.path === "compatible-fast"
            ? `Updated Yui to ${result.version} via the compatible fast path; the Home was not migrated.`
            : `Updated Yui to ${result.version}; storage was already current.`
          : `Updated Yui to ${result.version}. Storage was migrated; original Home backed up at `
            + `${result.storageBackupPath}.`;
      case "aborted":
        return [
          `Update aborted during ${result.phase}: ${result.message}`,
          result.recoverable
            ? "The current install and Home remain usable."
            : result.phase === "activate-binary" && result.storageBackupPath === undefined
              ? "The Home was not migrated, but binary health is unknown; do not assume the current install is usable."
              : "Manual recovery is required (see below).",
          `Action: ${result.action}`
        ].join("\n");
      case "ambiguous":
        return [
          `Update result is UNKNOWN after ${result.phase}: ${result.message}`,
          "Manual verification is required — do NOT assume the update succeeded or was a no-op.",
          `Action: ${result.action}`
        ].join("\n");
    }
  })();
  return result.cleanupWarning === undefined
    ? rendered
    : `${rendered}\nWarning: ${result.cleanupWarning}`;
}
