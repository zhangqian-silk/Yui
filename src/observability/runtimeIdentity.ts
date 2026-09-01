/**
 * Read-only runtime identity facts for `controller status` and `execution audit`.
 *
 * Issue 11 boundary: this module only collects facts (manifest, process
 * realpath/env, on-disk store evidence, Git). It never mutates state, never
 * starts or stops a Controller, and never asks a producer to change. A fact
 * that cannot be resolved is the literal string `"unsupported"` (the Issue 11
 * fallback rule), and contradictory facts fail closed as findings with exact
 * remediation actions.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../storage/storageVersions.js";
import { resolveStoreWorkerEnabledForHome } from "../storage/storeRpc.js";

export const UNSUPPORTED = "unsupported" as const;
export type Unsupported = typeof UNSUPPORTED;
export type OptionalFact = string | Unsupported;

/**
 * Feature flag for the Issue 11 read-only status/audit presentation.
 *
 * Everything behind this flag is observe-only: identity fields, storage
 * evidence, and metrics snapshots. The flag defaults ON because the fields
 * change no behavior; set `YUI_STATUS_IDENTITY=0` (or `false`) to hide the new
 * sections and the fail-closed health exit. `execution audit` is an explicit
 * command and is not gated by this flag.
 */
export function resolveStatusIdentityEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env.YUI_STATUS_IDENTITY;
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

export type RuntimeBuildIdentity = Readonly<{
  packageName: string;
  packageVersion: string;
  /** sha256 of package.json — stable per release artifact. */
  packageDigest: OptionalFact;
  /** Resolved realpath of the running entry file (cli.js / controllerMain.js). */
  entryPath: OptionalFact;
  /** sha256 of the running entry file. */
  entryDigest: OptionalFact;
  /** Git HEAD of the package tree, when the runtime is a checkout. */
  sourceCommit: OptionalFact;
  nodeVersion: string;
  platform: string;
}>;

export type StorageIdentityFinding = Readonly<{
  code: string;
  severity: "contradiction" | "needs-repair" | "warning";
  message: string;
  remediation: string;
}>;

export type StorageIdentity = Readonly<{
  home: string;
  manifestStatus: "current" | "uninitialized" | "invalid" | "unsupported";
  logicalLayout: number | Unsupported;
  aggregateSchemaVersion: number | Unsupported;
  /** The one backend ordinary startup opens. */
  configuredBackend: "sqlite";
  /** Worker selected by THIS process environment (YUI_STORE_WORKER). */
  workerEnabled: boolean;
  physicalStateJson: Readonly<{ present: boolean; bytes: number | Unsupported }>;
  physicalDatabase: Readonly<{
    present: boolean;
    bytes: number | Unsupported;
    wal: boolean;
    shm: boolean;
    /** `PRAGMA quick_check` result when yui.db exists, else `unsupported`. */
    health: "ok" | "corrupt" | "unopenable" | Unsupported;
  }>;
  findings: readonly StorageIdentityFinding[];
}>;

export type StorageHealth = Readonly<{
  status: "ok" | "degraded" | "fail";
  healthy: boolean;
  contradictions: readonly StorageIdentityFinding[];
  needsRepair: readonly StorageIdentityFinding[];
  warnings: readonly StorageIdentityFinding[];
}>;

export function evaluateStorageHealth(identity: StorageIdentity): StorageHealth {
  const contradictions = identity.findings.filter(
    ({ severity }) => severity === "contradiction"
  );
  const needsRepair = identity.findings.filter(
    ({ severity }) => severity === "needs-repair"
  );
  const warnings = identity.findings.filter(
    ({ severity }) => severity === "warning"
  );
  const status = contradictions.length > 0
    ? "fail"
    : needsRepair.length > 0
      ? "degraded"
      : "ok";
  return { status, healthy: status === "ok", contradictions, needsRepair, warnings };
}

/**
 * Filesystem/Git ports. Production uses direct fs + a bounded git call; tests
 * inject fakes. Every port fails soft (null / undefined) so a permission or
 * race error degrades the fact to `unsupported` instead of changing state.
 */
export type RuntimeIdentityPorts = Readonly<{
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  entryPath: string;
  readText(path: string): string | null;
  fileSize(path: string): number | null;
  exists(path: string): boolean;
  realpath(path: string): string | null;
  gitHead(packageRoot: string): string | null;
}>;

export function createProductionRuntimeIdentityPorts(
  packageRoot: string,
  entryPath: string,
  env: NodeJS.ProcessEnv = process.env
): RuntimeIdentityPorts {
  return {
    env,
    packageRoot,
    entryPath,
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    fileSize: (path) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(path),
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    },
    gitHead: (root) => readGitHead(root)
  };
}

function readGitHead(packageRoot: string): string | null {
  try {
    const resolvedPackageRoot = realpathSync(packageRoot);
    const rootResult = spawnSync(
      "git",
      ["-C", resolvedPackageRoot, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 1_500, stdio: ["ignore", "pipe", "ignore"] }
    );
    if (rootResult.status !== 0) return null;
    const repositoryRoot = realpathSync(rootResult.stdout.trim());
    // `git -C` searches parent directories. A globally installed package may
    // therefore appear to belong to an unrelated repository that happens to
    // contain the package manager directory (for example ~/.nvm). Only the
    // package's own checkout is valid source identity evidence.
    if (repositoryRoot !== resolvedPackageRoot) return null;

    const headResult = spawnSync(
      "git",
      ["-C", resolvedPackageRoot, "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 1_500, stdio: ["ignore", "pipe", "ignore"] }
    );
    if (headResult.status !== 0) return null;
    const head = headResult.stdout.trim();
    return /^[a-f0-9]{7,40}$/u.test(head) ? head : null;
  } catch {
    return null;
  }
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function collectRuntimeBuildIdentity(
  ports: RuntimeIdentityPorts
): RuntimeBuildIdentity {
  const packageJsonText = ports.readText(join(ports.packageRoot, "package.json"));
  let packageName = "unknown";
  let packageVersion = "0.0.0";
  let packageDigest: OptionalFact = UNSUPPORTED;
  if (packageJsonText !== null) {
    packageDigest = `sha256:${sha256Hex(packageJsonText)}`;
    try {
      const parsed = JSON.parse(packageJsonText) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof parsed.name === "string" && parsed.name.length > 0) {
        packageName = parsed.name;
      }
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        packageVersion = parsed.version;
      }
    } catch {
      // Damaged package metadata still leaves the digest as evidence.
    }
  }
  const entryRealpath = ports.realpath(ports.entryPath);
  const entryText = entryRealpath === null ? null : ports.readText(entryRealpath);
  return {
    packageName,
    packageVersion,
    packageDigest,
    entryPath: entryRealpath ?? UNSUPPORTED,
    entryDigest: entryText === null
      ? UNSUPPORTED
      : `sha256:${sha256Hex(entryText)}`,
    sourceCommit: ports.gitHead(ports.packageRoot) ?? UNSUPPORTED,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`
  };
}

export type StorageIdentityPorts = Readonly<{
  env: NodeJS.ProcessEnv;
  readText(path: string): string | null;
  fileSize(path: string): number | null;
  exists(path: string): boolean;
  /** Open yui.db read-only and run PRAGMA quick_check. Null when absent. */
  probeDatabaseHealth(path: string): "ok" | "corrupt" | "unopenable" | null;
}>;

export function createProductionStorageIdentityPorts(
  env: NodeJS.ProcessEnv = process.env
): StorageIdentityPorts {
  return {
    env,
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    fileSize: (path) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(path),
    probeDatabaseHealth: (path) => {
      if (!existsSync(path)) return null;
      try {
        const db = new Database(path, { readonly: true });
        try {
          const integrity = db.pragma("quick_check", { simple: true });
          return integrity === "ok" ? "ok" : "corrupt";
        } finally {
          db.close();
        }
      } catch {
        return "unopenable";
      }
    }
  };
}

/**
 * Collect read-only evidence for the exact current SQLite contract. Old files
 * are never treated as an alternate authority or a repair source.
 */
export function collectStorageIdentity(
  home: string,
  ports: StorageIdentityPorts = createProductionStorageIdentityPorts()
): StorageIdentity {
  const manifestPath = join(home, "schema.json");
  const manifestText = ports.readText(manifestPath);
  let manifestStatus: StorageIdentity["manifestStatus"] = "uninitialized";
  let logicalLayout: number | Unsupported = UNSUPPORTED;
  let aggregateSchemaVersion: number | Unsupported = UNSUPPORTED;
  if (manifestText !== null) {
    manifestStatus = "current";
    try {
      const manifest = JSON.parse(manifestText) as {
        storageVersion?: unknown;
        aggregateSchemaVersion?: unknown;
      };
      if (
        typeof manifest.storageVersion === "number"
        && Number.isFinite(manifest.storageVersion)
      ) {
        logicalLayout = manifest.storageVersion;
      }
      if (
        typeof manifest.aggregateSchemaVersion === "number"
        && Number.isFinite(manifest.aggregateSchemaVersion)
      ) {
        aggregateSchemaVersion = manifest.aggregateSchemaVersion;
      }
      if (typeof logicalLayout !== "number"
        || typeof aggregateSchemaVersion !== "number"
        || logicalLayout !== CURRENT_STORAGE_LAYOUT_VERSION
        || aggregateSchemaVersion !== CURRENT_AGGREGATE_SCHEMA_VERSION) {
        manifestStatus = "unsupported";
      }
    } catch {
      manifestStatus = "invalid";
      logicalLayout = UNSUPPORTED;
      aggregateSchemaVersion = UNSUPPORTED;
    }
  }

  const statePath = join(home, "state.json");
  const statePresent = ports.exists(statePath);
  const stateBytes = ports.fileSize(statePath);
  const dbPath = join(home, "yui.db");
  const dbPresent = ports.exists(dbPath);
  const dbBytes = ports.fileSize(dbPath);
  const walPresent = ports.exists(`${dbPath}-wal`);
  const shmPresent = ports.exists(`${dbPath}-shm`);

  const configuredBackend = "sqlite" as const;
  const workerEnabled = resolveStoreWorkerEnabledForHome(home, ports.env);
  const dbHealth = dbPresent ? ports.probeDatabaseHealth(dbPath) : null;
  const findings: StorageIdentityFinding[] = [];
  if (manifestStatus === "current" && !dbPresent) {
    findings.push({
      code: "current-database-missing",
      severity: "contradiction",
      message: `The current storage contract requires ${dbPath}, but it is missing.`,
      remediation: "Preserve this Home for diagnosis and initialize a new Home."
    });
  }
  if (manifestStatus === "unsupported") {
    findings.push({
      code: "unsupported-storage-contract",
      severity: "contradiction",
      message: "The Home does not match this release's exact storage contract.",
      remediation: "Open it read-only with its original Yui version, then let the Operator recreate unfinished work in a new Home."
    });
  }
  if (manifestStatus === "invalid") {
    findings.push({
      code: "invalid-storage-manifest",
      severity: "contradiction",
      message: "schema.json is invalid.",
      remediation: "Preserve this Home for diagnosis and initialize a new Home."
    });
  }
  if (dbPresent && dbHealth !== null && dbHealth !== "ok") {
    findings.push({
      code: "database-unhealthy",
      severity: "contradiction",
      message: `yui.db exists but failed integrity check (${dbHealth}).`,
      remediation: "Preserve this Home for diagnosis and initialize a new Home."
    });
  }
  if (statePresent) {
    findings.push({
      code: "ignored-historical-store",
      severity: "warning",
      message: "state.json is present but is not read or written by the current store.",
      remediation: "Keep it only as read-only historical evidence or archive it outside the active Home."
    });
  }
  const rawWorkerFlag = ports.env.YUI_STORE_WORKER;
  if (rawWorkerFlag !== undefined && !["0", "1", "false", "true"].includes(rawWorkerFlag.toLowerCase())) {
    findings.push({
      code: "invalid-worker-flag",
      severity: "warning",
      message: `YUI_STORE_WORKER=${rawWorkerFlag} is invalid.`,
      remediation: "Use 1/true, 0/false, or unset YUI_STORE_WORKER."
    });
  }

  return {
    home,
    manifestStatus,
    logicalLayout,
    aggregateSchemaVersion,
    configuredBackend,
    workerEnabled,
    physicalStateJson: {
      present: statePresent,
      bytes: stateBytes ?? UNSUPPORTED
    },
    physicalDatabase: {
      present: dbPresent,
      bytes: dbBytes ?? UNSUPPORTED,
      wal: walPresent,
      shm: shmPresent
      ,
      health: dbHealth ?? UNSUPPORTED
    },
    findings
  };
}

/**
 * Count telemetry events the runtime inbox rejected into
 * `runtime/inbox-invalid/`. Dropped telemetry must stay countable and must
 * never affect the semantic lane (Issue 11 §4). A missing directory means no
 * drops (the inbox was never used); an unreadable directory is `unsupported`.
 */
export function countDroppedInboxEvents(
  home: string,
  listDirectory: (path: string) => string[] = (path) => readdirSync(path)
): number | Unsupported {
  if (!existsSync(join(home, "runtime", "inbox-invalid"))) return 0;
  try {
    return listDirectory(join(home, "runtime", "inbox-invalid")).length;
  } catch {
    return UNSUPPORTED;
  }
}
