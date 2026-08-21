import { existsSync, renameSync, rmSync } from "node:fs";

const SQLITE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * Move a SQLite database together with any live WAL/SHM sidecars.
 *
 * A WAL database is one logical file set. Moving only the main file can leave
 * the old WAL under the promoted database name, causing SQLite to replay it
 * against an unrelated database. The migration fence guarantees there are no
 * writers while this bounded rename runs.
 */
export function moveSqliteFileSet(
  sourcePath: string,
  targetPath: string,
  rename: (source: string, target: string) => void = renameSync
): void {
  const suffixes = SQLITE_FILE_SUFFIXES.filter((suffix) => existsSync(`${sourcePath}${suffix}`));
  for (const suffix of suffixes) {
    if (existsSync(`${targetPath}${suffix}`)) {
      throw new Error(`Refusing to overwrite an existing SQLite switch target: ${targetPath}${suffix}.`);
    }
  }

  const moved: string[] = [];
  try {
    for (const suffix of suffixes) {
      rename(`${sourcePath}${suffix}`, `${targetPath}${suffix}`);
      moved.push(suffix);
    }
  } catch (error) {
    let rollbackError: unknown;
    for (const suffix of moved.reverse()) {
      try {
        rename(`${targetPath}${suffix}`, `${sourcePath}${suffix}`);
      } catch (candidate) {
        rollbackError ??= candidate;
      }
    }
    if (rollbackError !== undefined) {
      throw new Error(
        `SQLite file-set move failed and rollback was incomplete: ${messageOf(error)}; `
        + `rollback failed: ${messageOf(rollbackError)}`
      );
    }
    throw error;
  }
}

/** Remove a promoted SQLite file set before restoring its timestamped backup. */
export function removeSqliteFileSet(databasePath: string): void {
  for (const suffix of SQLITE_FILE_SUFFIXES) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
