import { createStorageBackup } from "../storage/storageBackup.js";

export function runBackupCommand(rootDir: string): string {
  const backup = createStorageBackup(rootDir);

  return `Created backup ${backup.path}\n`;
}
