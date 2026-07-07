import { inspectStorageSchema, runStorageMigrations } from "../storage/storageSchema.js";
import { createStorageBackup } from "../storage/storageBackup.js";

export function runBackupCommand(rootDir: string): string {
  const backup = createStorageBackup(rootDir);

  return `Created backup ${backup.path}\n`;
}

export function runMigrateCommand(rootDir: string, args: string[] = []): string {
  if (args.includes("--dry-run")) {
    return dryRunMigrateCommand(rootDir);
  }

  const result = runStorageMigrations(rootDir);

  if (!result.changed) {
    return `Storage schema already up to date: ${result.toVersion}\n`;
  }

  return [
    `Migrated storage schema ${result.fromVersion} -> ${result.toVersion}`,
    result.backup === undefined ? null : `Backup: ${result.backup.path}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
    .concat("\n");
}

function dryRunMigrateCommand(rootDir: string): string {
  const state = inspectStorageSchema(rootDir);

  switch (state.status) {
    case "uninitialized":
      return "TaskMux is not initialized. Run `taskmux setup`.\n";
    case "current":
      return `Storage schema already up to date: ${state.currentVersion}\n`;
    case "upgrade-required":
      return [
        `Storage migration dry run ${state.currentVersion} -> ${state.latestVersion}`,
        "Backup would be created"
      ].join("\n").concat("\n");
    case "unsupported":
      return `Unsupported storage schema version: ${state.currentVersion}. This TaskMux supports storage schema ${state.latestVersion}.\n`;
    case "invalid":
      return `Invalid storage schema manifest: ${state.manifestPath}.\n`;
  }
}
