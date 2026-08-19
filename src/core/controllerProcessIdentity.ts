import { readFileSync, readdirSync } from "node:fs";

import { readLinuxProcessStartIdentity } from "../controller/domainIdentity.js";
import {
  readHomeFilesystemId,
  validateHomeFilesystemId
} from "./homeFilesystemIdentity.js";

export type LiveControllerProcess = Readonly<{
  pid: number;
  processStartIdentity: string;
}>;

/** Exact live-process fence used only at Controller startup and v3 handoff. */
export function inspectLiveControllerProcess(
  pid: number,
  homeFilesystemId: string,
  expectedProcessStartIdentity?: string
): LiveControllerProcess | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return undefined;
  const expectedFilesystemId = validateHomeFilesystemId(homeFilesystemId);
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const processUid = /^Uid:\s+([0-9]+)/mu.exec(status)?.[1];
    if (processUid === undefined || Number(processUid) !== uid) return undefined;

    const args = readFileSync(`/proc/${pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter((argument) => argument.length > 0);
    if (!args.some((argument) => /(?:^|\/)controllerMain\.js$/u.test(argument))) {
      return undefined;
    }

    const environment = readFileSync(`/proc/${pid}/environ`)
      .toString("utf8")
      .split("\0");
    const yuiHome = environment
      .find((entry) => entry.startsWith("YUI_HOME="))
      ?.slice("YUI_HOME=".length);
    if (yuiHome === undefined || readHomeFilesystemId(yuiHome) !== expectedFilesystemId) {
      return undefined;
    }

    const processStartIdentity = readLinuxProcessStartIdentity(pid);
    if (
      processStartIdentity === undefined
      || (
        expectedProcessStartIdentity !== undefined
        && processStartIdentity !== expectedProcessStartIdentity
      )
    ) return undefined;
    return Object.freeze({ pid, processStartIdentity });
  } catch {
    return undefined;
  }
}

/** Finds an older/current Controller whose discovery record was lost. */
export function findLiveControllerProcessForHome(
  homeFilesystemId: string
): LiveControllerProcess | undefined {
  validateHomeFilesystemId(homeFilesystemId);
  if (process.platform !== "linux") return undefined;
  const entries = readdirSync("/proc", { encoding: "utf8" });
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    const match = inspectLiveControllerProcess(Number(entry), homeFilesystemId);
    if (match !== undefined) return match;
  }
  return undefined;
}
