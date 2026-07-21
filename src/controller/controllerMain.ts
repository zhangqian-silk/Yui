import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveYuiHome } from "../storage/taskStore.js";
import { startFileTaskControllerRuntime } from "./runtime.js";

export async function runFileTaskControllerProcess(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const home = resolveYuiHome(environment);
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
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  void runFileTaskControllerProcess().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Controller failed to start.";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
