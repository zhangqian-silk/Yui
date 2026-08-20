import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateHomeId } from "../repository/homeIdentity.js";

export function controllerSocketPath(homeId: string): string {
  const identity = validateHomeId(homeId);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const socketName = `${identity}.sock`;
  // Linux Unix-socket paths have a small fixed budget. A stable per-uid system
  // root is both short and independent of each caller's isolated TMPDIR.
  const root = process.platform === "linux" ? "/tmp" : tmpdir();
  return join(root, `yui-${uid}`, socketName);
}

/**
 * A protected Home discovery record owns the Controller endpoint. Linux uses
 * one fixed root, so every caller validates the exact Home/uid endpoint
 * independently of its own TMPDIR.
 */
export function isControllerSocketPathForHome(
  homeId: string,
  candidate: string
): boolean {
  try {
    return candidate === controllerSocketPath(validateHomeId(homeId));
  } catch {
    return false;
  }
}
