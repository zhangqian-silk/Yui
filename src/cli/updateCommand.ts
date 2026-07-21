import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";

import { runtimeError } from "../errors/cliError.js";

export type UpdateSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions
) => SpawnSyncReturns<Buffer>;

/**
 * Update the published global package. This intentionally remains an exact,
 * shell-free npm invocation. In particular, yui-dev updates the published
 * Yui installation; it never rewrites the current checkout.
 */
export function runUpdateCommand(spawn: UpdateSpawner = spawnSync): number {
  const result = spawn(
    "npm",
    ["install", "--global", "@zq-silk/yui@latest"],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: "inherit"
    }
  );

  if (result.error !== undefined) {
    throw runtimeError(`Failed to start npm: ${result.error.message}`);
  }
  if (result.status === null) {
    throw runtimeError(
      `npm update terminated${result.signal === null ? "" : ` by ${result.signal}`}.`
    );
  }
  return result.status;
}
