import { resolveYuiHome } from "../storage/taskStore.js";
import { createUpdatePorts, type UpdateSpawner } from "./updatePorts.js";
import { runUpdate, type UpdatePorts, type UpdateResult } from "./updateOrchestrator.js";

export type { UpdateSpawner } from "./updatePorts.js";

/**
 * Run `yui update` as a side-by-side, recoverable orchestration.
 *
 * The new package is staged beside the live install and used to run a read-only
 * preflight against the target Home. A current Home proceeds directly; a Home
 * inside the staged release's supported range is migrated after the exact
 * Controller handoff and before post-update verification.
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
  if (result.outcome === "aborted") return 5;
  return 0;
}

/** Render an {@link UpdateResult} as concise, CLI-style text. */
export function renderUpdateResult(result: UpdateResult): string {
  const rendered = (() => {
    switch (result.outcome) {
      case "already-current":
        return "Yui is already up to date; nothing to install.";
      case "updated":
        return result.backupPath === undefined
          ? `Updated Yui to ${result.version}; storage was already current.`
          : `Updated Yui to ${result.version} and migrated storage. Backup: ${result.backupPath}`;
      case "aborted":
        return [
          `Update aborted during ${result.phase}: ${result.message}`,
          result.phase === "migrate-storage"
            || (result.phase === "post-verify" && result.recoverable)
            ? "The target binary is installed; the Home remains quiesced pending successful verification."
            : result.recoverable
              ? "The current install and Home remain usable."
            : result.phase === "activate-binary"
              ? "The Home was unchanged, but binary health is unknown; do not assume the current install is usable."
              : "Manual recovery is required (see below).",
          ...(result.backupPath === undefined
            ? []
            : [`Storage backup: ${result.backupPath}`]),
          `Action: ${result.action}`
        ].join("\n");
    }
  })();
  return result.cleanupWarning === undefined
    ? rendered
    : `${rendered}\nWarning: ${result.cleanupWarning}`;
}
