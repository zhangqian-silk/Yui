import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveYuiHome } from "../storage/taskStore.js";
import {
  handoverCandidateFromEnvironment,
  runHandoverCandidate
} from "./handoverCandidate.js";
import { startFileTaskControllerRuntime } from "./runtime.js";

export async function runFileTaskControllerProcess(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const home = resolveYuiHome(environment);
  // Issue 02: a handover candidate runs the read-only prelude and promotes
  // itself once the old owner exits. It never binds the main socket first.
  const candidate = handoverCandidateFromEnvironment(environment);
  if (candidate !== null) {
    const result = await runHandoverCandidate(home, candidate.handoverId, { environment });
    if (result.outcome === "aborted") {
      process.stderr.write(`Controller handover candidate aborted: ${result.reason}\n`);
      process.exitCode = 5;
    }
    return;
  }
  const controller = await startFileTaskControllerRuntime(home, {
    environment,
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Controller scheduler error: ${message}\n`);
    }
  });
  const stop = (): void => {
    void controller.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await controller.closed;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function isEntrypoint(): boolean {
  // Node's ESM loader resolves symlinks for import.meta.url, while
  // process.argv[1] keeps the path as invoked. A release installed under a
  // symlinked Home (e.g. /home -> /data00/home) must still detect itself as
  // the entrypoint, so compare realpaths on both sides.
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntrypoint()) {
  void runFileTaskControllerProcess().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Controller failed to start.";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
