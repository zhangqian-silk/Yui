import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { validateHomeId } from "../repository/homeIdentity.js";

const LINUX_UNIX_SOCKET_PATH_BUDGET = 100;

export function controllerSocketPath(homeId: string): string {
  const identity = validateHomeId(homeId);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const socketName = `${identity}.sock`;
  const isolatedPath = join(tmpdir(), `yui-${uid}`, socketName);
  if (
    process.platform !== "linux"
    || Buffer.byteLength(isolatedPath) < LINUX_UNIX_SOCKET_PATH_BUDGET
  ) {
    return isolatedPath;
  }

  // Linux limits Unix-socket paths to a small fixed budget. Managed Task
  // runtimes intentionally use isolated TMPDIR roots, which may themselves
  // be nested deeply enough to exhaust that budget. Keep the Home/uid/name
  // fence while using the compact system temporary root only for this
  // exceptional path; clients follow the Home-owned discovery record.
  return join("/tmp", `yui-${uid}`, socketName);
}

/**
 * A protected Home discovery record owns the Controller endpoint. Clients may
 * run with an isolated TMPDIR, so validate the published Home/uid identity
 * without recomputing the Controller process's temporary root.
 */
export function isControllerSocketPathForHome(
  homeId: string,
  candidate: string
): boolean {
  let identity: string;
  try {
    identity = validateHomeId(homeId);
  } catch {
    return false;
  }
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return basename(dirname(candidate)) === `yui-${uid}`
    && basename(candidate) === `${identity}.sock`;
}
