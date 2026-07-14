import { join } from "node:path";
import { createStorageBackup } from "../storage/storageBackup.js";

export function runBackupCommand(
  workingRoot: string,
  publishedRoot = workingRoot,
  now = new Date()
): string {
  const backup = createStorageBackup(workingRoot, now);

  return `Created backup ${join(publishedRoot, "backups", backup.id)}\n`;
}
