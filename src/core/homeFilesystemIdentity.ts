import { statSync } from "node:fs";

const HOME_FILESYSTEM_ID_PATTERN = /^[0-9]{1,32}:[0-9]{1,32}$/u;

/**
 * Runtime-only identity of the physical Home directory.
 *
 * Durable `homeId` names the logical Home. Device + inode distinguishes an
 * accidental filesystem copy while allowing symlink aliases of the same
 * directory to share one Controller. It is deliberately not persisted in the
 * Home aggregate because replacing or copying the directory must change this
 * runtime fence.
 */
export function readHomeFilesystemId(home: string): string {
  const metadata = statSync(home, { bigint: true });
  if (!metadata.isDirectory()) {
    throw new Error("YUI_HOME is not a directory.");
  }
  return `${metadata.dev}:${metadata.ino}`;
}

export function validateHomeFilesystemId(value: unknown): string {
  if (typeof value !== "string" || !HOME_FILESYSTEM_ID_PATTERN.test(value)) {
    throw new Error("Home filesystem identity is invalid.");
  }
  return value;
}
