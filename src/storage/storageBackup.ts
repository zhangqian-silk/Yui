import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
  const entries = readdirSync(rootDir, { withFileTypes: true });

  mkdirSync(backupPath, { recursive: true });

  for (const entry of entries) {
    if (entry.name === "backups") {
      continue;
    }

    cpSync(join(rootDir, entry.name), join(backupPath, entry.name), { recursive: true });
  }

  writeFileSync(
    join(backupPath, "backup.json"),
    `${JSON.stringify({ schemaVersion: 1, id, createdAt, source: rootDir }, null, 2)}\n`
  );

  return {
    id,
    path: backupPath,
    createdAt
  };
}
