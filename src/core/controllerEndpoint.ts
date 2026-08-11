import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export function controllerSocketPath(home: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `yui-${uid}`, `${controllerSocketIdentity(home)}.sock`);
}

/**
 * A protected Home discovery record owns the Controller endpoint. Clients may
 * run with an isolated TMPDIR, so validate the published Home/uid identity
 * without recomputing the Controller process's temporary root.
 */
export function isControllerSocketPathForHome(
  home: string,
  candidate: string
): boolean {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return basename(dirname(candidate)) === `yui-${uid}`
    && basename(candidate) === `${controllerSocketIdentity(home)}.sock`;
}

function controllerSocketIdentity(home: string): string {
  return createHash("sha256")
    .update(resolve(home))
    .digest("hex")
    .slice(0, 24);
}
