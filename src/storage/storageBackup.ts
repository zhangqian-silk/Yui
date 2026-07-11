import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StorageBackupResult = {
  id: string;
  path: string;
  createdAt: string;
};

export function createStorageBackup(rootDir: string, now = new Date()): StorageBackupResult {
  const createdAt = now.toISOString();
  const id = `backup-${createdAt.replaceAll(":", "-").replaceAll(".", "-")}`;
  const backupRoot = join(rootDir, "backups");
  const backupPath = join(backupRoot, id);
  const pendingPath = join(backupRoot, `.pending-${id}-${process.pid}`);
  const entries = readdirSync(rootDir, { withFileTypes: true });

  mkdirSync(pendingPath, { recursive: true });

  try {
    for (const entry of entries) {
      if (entry.name === "backups") {
        continue;
      }

      cpSync(join(rootDir, entry.name), join(pendingPath, entry.name), { recursive: true });
    }

    writeFileSync(
      join(pendingPath, "backup.json"),
      `${JSON.stringify({ schemaVersion: 1, id, createdAt, source: rootDir }, null, 2)}\n`
    );

    if (process.env.TASKMUX_BACKUP_FAILPOINT === "before-publish") {
      throw new Error(`Backup ${id} stopped before publish.`);
    }
    renameSync(pendingPath, backupPath);
  } catch (error) {
    rmSync(pendingPath, { recursive: true, force: true });
    throw error;
  }

  return {
    id,
    path: backupPath,
    createdAt
  };
}
