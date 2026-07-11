import { readdirSync, watch, type FSWatcher } from "node:fs";
import { join, relative, resolve } from "node:path";

export function startTaskmuxFileWatcher(
  rootDir: string,
  onReload: () => void,
  onError: (error: unknown) => void
): () => void {
  const root = resolve(rootDir);
  const watchers = new Map<string, FSWatcher>();
  let reloadTimer: NodeJS.Timeout | undefined;
  let rescanTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const scheduleReload = (): void => {
    if (reloadTimer !== undefined) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      try {
        onReload();
      } catch (error) {
        onError(error);
      }
    }, 25);
    reloadTimer.unref();
  };

  const scheduleRescan = (): void => {
    if (rescanTimer !== undefined) {
      clearTimeout(rescanTimer);
    }
    rescanTimer = setTimeout(() => {
      rescanTimer = undefined;
      scanDirectories(root);
    }, 25);
    rescanTimer.unref();
  };

  const scanDirectories = (directory: string): void => {
    if (stopped || isIgnoredDirectory(root, directory)) {
      return;
    }
    if (!watchers.has(directory)) {
      try {
        const watcher = watch(directory, { persistent: false }, (eventType) => {
          scheduleReload();
          if (eventType === "rename") {
            scheduleRescan();
          }
        });
        watcher.on("error", onError);
        watcher.on("close", () => watchers.delete(directory));
        watchers.set(directory, watcher);
      } catch (error) {
        onError(error);
        return;
      }
    }

    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          scanDirectories(join(directory, entry.name));
        }
      }
    } catch (error) {
      onError(error);
    }
  };

  scanDirectories(root);
  return () => {
    stopped = true;
    if (reloadTimer !== undefined) {
      clearTimeout(reloadTimer);
    }
    if (rescanTimer !== undefined) {
      clearTimeout(rescanTimer);
    }
    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
  };
}

function isIgnoredDirectory(root: string, directory: string): boolean {
  const path = relative(root, directory);
  return ["runtime", "backups", "trash"].some(
    (name) => path === name || path.startsWith(`${name}/`) || path.startsWith(`${name}\\`)
  );
}
