/**
 * Real {@link UpdatePorts} for `yui update`: side-by-side npm staging plus a
 * staged-binary read-only preflight, wired into the recoverable orchestration in
 * {@link runUpdate}.
 *
 * Staging installs the latest package into a throwaway prefix with
 * `npm install --global --prefix <tmp>`, so the live global install is never
 * touched until the binary-activation step. Preflight and post-verify invoke the
 * STAGED binary (`yui upgrade --dry-run` / `yui doctor`) so the new version — not
 * the running one — decides whether the target Home is safe.
 */

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeError } from "../errors/cliError.js";
import type {
  StagedPackage,
  StorageActivation,
  UpdatePorts,
  UpdatePreflight
} from "./updateOrchestrator.js";

const PACKAGE_SPEC = "@zq-silk/yui@latest";

export type UpdateSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions
) => SpawnSyncReturns<Buffer>;

/** Build the real ports. `spawn` is injectable so tests avoid real installs. */
export function createUpdatePorts(
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner = spawnSync
): UpdatePorts {
  return {
    stage(): StagedPackage {
      const stagingPath = mkdtempSync(join(tmpdir(), "yui-update-stage-"));
      const result = spawn(
        "npm",
        ["install", "--global", "--prefix", stagingPath, PACKAGE_SPEC],
        { cwd: process.cwd(), env: environment, shell: false, stdio: "inherit" }
      );
      assertSpawnOk(result, "stage the new package");
      return {
        binaryPath: join(stagingPath, "bin", "yui"),
        version: "latest",
        stagingPath
      };
    },

    preflight(staged: StagedPackage, home: string): UpdatePreflight {
      const result = spawn(
        staged.binaryPath,
        ["--json", "upgrade", "--dry-run"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      return interpretPreflight(result);
    },

    activateStorage(staged: StagedPackage, home: string): StorageActivation {
      const result = spawn(
        staged.binaryPath,
        ["--json", "upgrade"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      return interpretActivation(result);
    },

    activateBinary(staged: StagedPackage): void {
      const result = spawn(
        "npm",
        ["install", "--global", PACKAGE_SPEC],
        { cwd: process.cwd(), env: environment, shell: false, stdio: "inherit" }
      );
      assertSpawnOk(result, "activate the new binary");
      void staged;
    },

    verify(staged: StagedPackage, home: string): void {
      const result = spawn(
        staged.binaryPath,
        ["--json", "doctor"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      assertSpawnOk(result, "run the post-update health check");
    },

    cleanup(staged: StagedPackage): void {
      if (staged.stagingPath !== undefined) {
        rmSync(staged.stagingPath, { recursive: true, force: true });
      }
    }
  };
}

function interpretPreflight(result: SpawnSyncReturns<Buffer>): UpdatePreflight {
  const parsed = parseJsonResult(result);
  const data = parsed?.data as Record<string, unknown> | undefined;
  const outcome = typeof data?.outcome === "string" ? data.outcome : undefined;
  if (outcome === "already-current") return { status: "already-current" };
  if (outcome === "dry-run") {
    return { status: "migratable", summary: describe(data) };
  }
  return {
    status: "blocked",
    stage: typeof data?.stage === "string" ? data.stage : "preflight",
    message: typeof data?.message === "string" ? data.message : "Preflight was not safe.",
    action: typeof data?.action === "string"
      ? data.action
      : "Resolve the reported condition and retry."
  };
}

function interpretActivation(result: SpawnSyncReturns<Buffer>): StorageActivation {
  const parsed = parseJsonResult(result);
  const data = parsed?.data as Record<string, unknown> | undefined;
  const outcome = typeof data?.outcome === "string" ? data.outcome : undefined;
  if (outcome === "already-current") return { status: "already-current" };
  if (outcome === "upgraded") {
    return {
      status: "migrated",
      ...(typeof data?.backupPath === "string" ? { backupPath: data.backupPath } : {})
    };
  }
  return {
    status: "blocked",
    stage: typeof data?.stage === "string" ? data.stage : "activate-storage",
    message: typeof data?.message === "string" ? data.message : "Storage activation was refused.",
    action: typeof data?.action === "string"
      ? data.action
      : "Resolve the reported condition and retry."
  };
}

function parseJsonResult(
  result: SpawnSyncReturns<Buffer>
): Record<string, unknown> | null {
  if (result.error !== undefined) {
    throw runtimeError(`Failed to run the staged Yui binary: ${result.error.message}`);
  }
  try {
    const text = result.stdout.toString("utf8").trim();
    const value = JSON.parse(text) as Record<string, unknown>;
    return value;
  } catch {
    return null;
  }
}

function describe(data: Record<string, unknown> | undefined): string {
  const report = data?.report as Record<string, unknown> | undefined;
  const steps = Array.isArray(report?.steps) ? report?.steps.length : 0;
  return `${steps} migration step(s) validated`;
}

function assertSpawnOk(result: SpawnSyncReturns<Buffer>, action: string): void {
  if (result.error !== undefined) {
    throw runtimeError(`Failed to ${action}: ${result.error.message}`);
  }
  if (result.status === null) {
    throw runtimeError(
      `Failed to ${action}: process terminated${result.signal === null ? "" : ` by ${result.signal}`}.`
    );
  }
  if (result.status !== 0) {
    throw runtimeError(`Failed to ${action}: exited with status ${result.status}.`);
  }
}
