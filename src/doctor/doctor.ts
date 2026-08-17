import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import Database from "better-sqlite3";

import {
  configuredAgentToDefinition,
  resolveAgentEnvironment,
  type ConfiguredAgent
} from "../agent/agent.js";
import { operationalAgentEnvironment } from "../agent/launchEnvironment.js";
import {
  inspectAgentCapabilities,
  resolveAgentAdapter,
  type AgentProbeResult,
  type CapabilitySnapshot
} from "../executor/agentAdapter.js";
import { inspectCodexLaunchConfig } from "../executor/codexConfigConflict.js";
import { resolveEffectiveLaunch } from "../executor/effectiveLaunch.js";
import { compileRoleSessionContext } from "../context/roleSessionContext.js";
import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  resolveYuiHome,
  STORAGE_STATE_FILE
} from "../storage/taskStore.js";
import {
  createProductionStorageRegistry,
  openCompatibleFileTaskStore,
  validateCompatibleFileTaskStore,
  type OpenCompatibleFileTaskStoreOptions
} from "../storage/compatibleTaskStore.js";
import {
  inspectStorageSchema,
  type StorageSchemaState
} from "../storage/storageSchema.js";
import { resolveTaskStoreBackendForHome } from "../storage/sqliteStore.js";
import { resolveStoreWorkerEnabledForHome } from "../storage/storeRpc.js";
import { classifyHome } from "../storage/upgrade/homeClassification.js";
import {
  readMigrationReceipt,
  type PersistentMigrationReceipt
} from "../storage/upgrade/migrationReceipt.js";
import { latestStorageVersionState } from "../storage/upgrade/recordVersions.js";
import { COMMITTED_DATABASE_FILENAME } from "../storage/upgrade/sqliteStateMigration.js";
import {
  CommandExecutionError,
  type CommandExecutor
} from "../tmux/commandExecutor.js";
import {
  EPHEMERAL_DOMAIN_GRACE_MS,
  readEphemeralDomainIdentity,
  readLinuxProcessStartIdentity
} from "../controller/domainIdentity.js";
import type { GlobalRole } from "../role/role.js";
import type { ReviewConfig } from "../review/reviewConfig.js";

export type DoctorStatus = "ok" | "missing" | "unsupported" | "invalid";

export type DoctorCheck = Readonly<{
  name: string;
  status: DoctorStatus;
  detail: string;
}>;

export type DoctorReviewStatus = "ready" | "disabled" | "misconfigured";

/** Static Review configuration health. Provider-native acceptance is never inferred here. */
export type DoctorReviewReport = Readonly<{
  status: DoctorReviewStatus;
  policy?: ReviewConfig;
  roleName?: string;
  activeAgentId?: string;
  adapterId?: string;
  command?: string;
  /** Always unverified: doctor never creates a Reviewer Session or calls a model. */
  providerNative: "unverified";
  detail: string;
}>;

/**
 * The storage-relevant doctor checks, in the order they are produced. Post-update
 * verification (P1-3) keys off exactly these: a green `yui doctor` for the update
 * flow means every one of these is `ok`. Tool/agent checks are diagnostic only
 * and never block an update.
 */
export const STORAGE_DOCTOR_CHECK_NAMES = Object.freeze([
  "storage schema",
  "storage compatibility",
  "storage state"
] as const);

/** A machine-readable summary of storage health, embedded in `--json doctor`. */
export type StorageHealthSummary = Readonly<{
  /** True iff every storage check is `ok`. */
  healthy: boolean;
  /** The storage checks that are not `ok` (empty when healthy). */
  blocking: readonly DoctorCheck[];
  /** Physical-backend facts for the Home (Issue 01 observability). */
  details?: StorageDetails;
}>;

/**
 * The physical-backend facts `doctor --json` reports so an operator can prove
 * which backend is authoritative without inferring it from the manifest alone
 * (Issue 01). Every field is read-only evidence; `null` means "not applicable
 * or unreadable", never a guess.
 */
export type StorageDetails = Readonly<{
  /** The layout version the manifest declares (null when unreadable). */
  logicalLayout: number | null;
  /** The backend ordinary startup opens for this Home. */
  authoritativeBackend: "sqlite" | "file";
  /** The absolute `yui.db` path when it exists, else null. */
  databasePath: string | null;
  /** The SQLite journal mode (null for the file store or an unreadable DB). */
  journalMode: string | null;
  /** Whether the persistence worker is enabled for this Home. */
  workerEnabled: boolean;
  /** The persistent migration receipt, when one exists and is well-formed. */
  migrationReceipt: PersistentMigrationReceipt | null;
  /** The last committed revision (home_meta for SQLite, state.json for file). */
  lastCommittedRevision: number | null;
}>;

/** The full machine-readable doctor result surfaced by `yui --json doctor`. */
export type DoctorReport = Readonly<{
  checks: readonly DoctorCheck[];
  storage: StorageHealthSummary;
  review: DoctorReviewReport;
}>;

/**
 * Classify the storage checks into a machine-readable health verdict. This is the
 * canonical, parseable signal the update post-verify consumes (P1-3): storage is
 * healthy only when schema, compatibility, and state are all `ok`. Any
 * `unsupported` (version mismatch / needs-new-version), `invalid` (corrupted /
 * unreadable), or `missing` (uninitialized) storage check is blocking — even
 * though `yui doctor` itself exits 0.
 */
export function summarizeStorageHealth(
  checks: readonly DoctorCheck[]
): StorageHealthSummary {
  const names = new Set<string>(STORAGE_DOCTOR_CHECK_NAMES);
  const blocking = checks.filter(
    (check) => names.has(check.name) && check.status !== "ok"
  );
  return { healthy: blocking.length === 0, blocking };
}

/** Build the full machine-readable doctor report (checks + storage health). */
export function buildDoctorReport(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  storageOptions: OpenCompatibleFileTaskStoreOptions = {}
): DoctorReport {
  const inspection = inspectDoctor(env, executor, storageOptions);
  const home = resolveYuiHome(env);
  return {
    checks: inspection.checks,
    storage: {
      ...summarizeStorageHealth(inspection.checks),
      details: inspectStorageDetails(home, env)
    },
    review: inspection.review
  };
}

/**
 * Read the physical-backend facts for a Home (Issue 01 observability). Every
 * field is best-effort read-only evidence: an unreadable database or manifest
 * yields `null` for that field, and the `storage state` check reports the
 * structural problem separately.
 */
function inspectStorageDetails(
  home: string,
  env: NodeJS.ProcessEnv
): StorageDetails {
  const schema = inspectStorageSchema(home);
  const logicalLayout = schema.status === "current" || schema.status === "unsupported"
    ? schema.currentLayoutVersion
    : null;
  const authoritativeBackend = resolveTaskStoreBackendForHome(home, env);
  const dbPath = join(home, COMMITTED_DATABASE_FILENAME);
  const databasePath = existsSync(dbPath) ? dbPath : null;
  let journalMode: string | null = null;
  let lastCommittedRevision: number | null = null;
  if (databasePath !== null) {
    try {
      const db = new Database(databasePath, { readonly: true });
      try {
        const mode = db.pragma("journal_mode", { simple: true });
        journalMode = typeof mode === "string" ? mode : String(mode);
        const row = db.prepare("SELECT revision FROM home_meta WHERE id = 1").get() as
          | { revision?: number }
          | undefined;
        lastCommittedRevision = typeof row?.revision === "number" ? row.revision : null;
      } finally {
        db.close();
      }
    } catch {
      // Leave both null; the storage state check surfaces the corruption.
    }
  } else {
    try {
      const state = JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8")) as {
        revision?: unknown;
      };
      lastCommittedRevision = typeof state.revision === "number" ? state.revision : null;
    } catch {
      lastCommittedRevision = null;
    }
  }
  return {
    logicalLayout,
    authoritativeBackend,
    databasePath,
    journalMode,
    workerEnabled: resolveStoreWorkerEnabledForHome(home, env),
    migrationReceipt: readMigrationReceipt(home),
    lastCommittedRevision
  };
}

type StorageInspection = Readonly<{
  check: DoctorCheck;
  agents: readonly ConfiguredAgent[];
  review: ReviewSource;
}>;

type ReviewSource = Readonly<{
  storageReady: boolean;
  storageDetail: string;
  home?: string;
  policy?: ReviewConfig;
  role?: GlobalRole | null;
  agent?: ConfiguredAgent | null;
}>;

type SchemaInspection = StorageSchemaState | Readonly<{
  status: "read-error";
  detail: string;
}>;

type StorageCompatibilityStatus =
  | "current"
  | "compatible-old"
  | "migration-required"
  | "needs-storage-repair"
  | "unsupported";

type ResolvedStorageOptions = Required<
  Pick<OpenCompatibleFileTaskStoreOptions, "registry" | "latest">
>;

type CompatibilityInspection = Readonly<{
  check: DoctorCheck;
  storageStatus?: StorageCompatibilityStatus;
  storageOptions?: ResolvedStorageOptions;
}>;

/** Runs the read-only FileTaskStore diagnostics used by `yui doctor`. */
export function runDoctorCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  storageOptions: OpenCompatibleFileTaskStoreOptions = {}
): string {
  if (args.length !== 0) throw usageError("Doctor usage: yui doctor");
  const inspection = inspectDoctor(env, executor, storageOptions);
  return renderDoctor(inspection.checks, inspection.review);
}

export function getDoctorChecks(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  storageOptions: OpenCompatibleFileTaskStoreOptions = {}
): DoctorCheck[] {
  return inspectDoctor(env, executor, storageOptions).checks;
}

type DoctorInspection = Readonly<{
  checks: DoctorCheck[];
  review: DoctorReviewReport;
}>;

function inspectDoctor(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor,
  storageOptions: OpenCompatibleFileTaskStoreOptions = {}
): DoctorInspection {
  const home = resolveYuiHome(env);
  const homeCheck = checkHome(home);
  const schema = readSchema(home);
  const compatibility = inspectCompatibility(
    home,
    homeCheck,
    schema,
    storageOptions
  );
  const schemaCheck = checkSchema(schema, compatibility);
  const storage = inspectState(
    home,
    homeCheck,
    schema,
    compatibility
  );
  const domain = checkEphemeralDomain(home);
  const toolChecks = [
    checkExecutable("git", env.YUI_GIT_BIN ?? "git", ["--version"], executor),
    checkExecutable("tmux", env.YUI_TMUX_BIN ?? "tmux", ["-V"], executor)
  ];
  const agentChecks = storage.agents.flatMap((agent) => checkAgent(agent, executor, env));
  const review = inspectReview({ ...storage.review, home }, agentChecks, env);
  return {
    checks: [
      homeCheck,
      schemaCheck,
      compatibility.check,
      storage.check,
      ...(domain === undefined ? [] : [domain]),
      ...toolChecks,
      ...agentChecks,
      ...review.checks
    ],
    review: review.report
  };
}

function checkEphemeralDomain(home: string): DoctorCheck | undefined {
  const identity = readEphemeralDomainIdentity(home);
  if (identity.status === "absent") return undefined;
  if (identity.status === "invalid" || identity.identity === undefined) {
    return {
      name: "ephemeral domain",
      status: "invalid",
      detail: "runtime/domain.json is invalid; recreate the isolated test domain."
    };
  }
  const host = readLinuxProcessStartIdentity(identity.identity.hostPid);
  if (host === identity.identity.hostProcessStartIdentity) {
    return {
      name: "ephemeral domain",
      status: "ok",
      detail: `active host=${identity.identity.hostPid}:${host} token=${identity.identity.token.slice(0, 12)}`
    };
  }
  if (host === undefined && existsSync(`/proc/${identity.identity.hostPid}`)) {
    return {
      name: "ephemeral domain",
      status: "invalid",
      detail: "host process is present but its start identity is unreadable; keep the domain protected and retry."
    };
  }
  const ageMs = Math.max(0, Date.now() - Date.parse(identity.identity.createdAt));
  return {
    name: "ephemeral domain",
    status: ageMs >= EPHEMERAL_DOMAIN_GRACE_MS ? "missing" : "invalid",
    detail: ageMs >= EPHEMERAL_DOMAIN_GRACE_MS
      ? "host is expired; run yui controller cleanup --all or wait for Controller recovery."
      : "host identity is unavailable; bounded grace is still in progress."
  };
}

export function renderDoctor(
  checks: readonly DoctorCheck[],
  review?: DoctorReviewReport
): string {
  const reviewLine = review === undefined
    ? ""
    : `Reviewer: ${review.status} (${review.detail})\n`;
  return `Yui doctor\n${reviewLine}${renderTable(
    "Checks",
    [
      { header: "Check", minWidth: 8, maxWidth: 28 },
      { header: "Status", minWidth: 7, maxWidth: 11 },
      { header: "Detail", minWidth: 12, maxWidth: 88 }
    ],
    checks.map((check) => [check.name, check.status, check.detail]),
    defaultTableWidth()
  )}\n`;
}

function checkHome(home: string): DoctorCheck {
  try {
    const metadata = lstatSync(home);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return {
        name: "yui home",
        status: "invalid",
        detail: "YUI_HOME must be a real directory."
      };
    }
    accessSync(home, constants.R_OK);
    return { name: "yui home", status: "ok", detail: home };
  } catch (error) {
    if (systemCode(error) === "ENOENT") {
      return { name: "yui home", status: "missing", detail: "run yui setup" };
    }
    return { name: "yui home", status: "invalid", detail: errorMessage(error) };
  }
}

function readSchema(home: string): SchemaInspection {
  try {
    return inspectStorageSchema(home);
  } catch (error) {
    return { status: "read-error", detail: errorMessage(error) };
  }
}

function checkSchema(
  state: SchemaInspection,
  compatibility: CompatibilityInspection
): DoctorCheck {
  switch (state.status) {
    case "uninitialized":
      return { name: "storage schema", status: "missing", detail: "run yui setup" };
    case "current":
      return {
        name: "storage schema",
        status: "ok",
        detail: `current=${state.currentVersion} latest=${state.latestVersion}`
      };
    case "unsupported":
      if (
        (compatibility.storageStatus === "compatible-old"
          || compatibility.storageStatus === "needs-storage-repair")
        && compatibility.check.status === "ok"
      ) {
        return {
          name: "storage schema",
          status: "ok",
          detail:
            `current=${state.currentVersion} latest=${state.latestVersion} `
            + `direction=${state.direction}; ${compatibility.storageStatus} validated`
        };
      }
      return {
        name: "storage schema",
        status: "unsupported",
        detail: `current=${state.currentVersion} latest=${state.latestVersion} direction=${state.direction}`
      };
    case "invalid":
      return { name: "storage schema", status: "invalid", detail: state.detail };
    case "read-error":
      return { name: "storage schema", status: "invalid", detail: state.detail };
  }
}

/**
 * The four-state storage compatibility check: USABLE / MIGRATABLE /
 * NEEDS_NEW_VERSION / CORRUPTED. This complements the raw "storage schema" check
 * with the migration framework's verdict, so a user sees whether a Home can be
 * used as-is, upgraded with `yui upgrade`, needs a newer release, or is damaged.
 * Doctor uses the same explicit production registry as `yui upgrade`; tests
 * may inject a synthetic registry so the same classification and validation
 * path proves compatible-old behavior. Missing paths fail closed, and
 * CORRUPTED is reserved for structural or reference failure.
 */
function inspectCompatibility(
  home: string,
  homeCheck: DoctorCheck,
  schema: SchemaInspection,
  storageOptions: OpenCompatibleFileTaskStoreOptions
): CompatibilityInspection {
  const name = "storage compatibility";
  if (homeCheck.status !== "ok") {
    return { check: { name, status: homeCheck.status, detail: homeCheck.detail } };
  }
  if (schema.status === "uninitialized") {
    return { check: { name, status: "missing", detail: "run yui setup" } };
  }
  if (schema.status === "read-error") {
    return { check: { name, status: "invalid", detail: schema.detail } };
  }
  let classification;
  let resolvedStorageOptions: ResolvedStorageOptions;
  try {
    resolvedStorageOptions = {
      registry: storageOptions.registry ?? createProductionStorageRegistry(),
      latest: storageOptions.latest ?? latestStorageVersionState()
    };
    classification = classifyHome({
      home,
      registry: resolvedStorageOptions.registry,
      latest: resolvedStorageOptions.latest
    });
  } catch (error) {
    return { check: { name, status: "invalid", detail: errorMessage(error) } };
  }
  const storageStatus = classification.classification.status;
  // A pseudo-layout-7 Home (needs-storage-repair) opens through the same
  // normalization path as compatible-old, so its records get the same eager
  // validation before the schema check can treat a version mismatch as
  // validated (Issue 01).
  if (storageStatus === "compatible-old" || storageStatus === "needs-storage-repair") {
    try {
      validateCompatibleFileTaskStore(home, resolvedStorageOptions);
    } catch (error) {
      return {
        storageStatus,
        storageOptions: resolvedStorageOptions,
        check: {
          name,
          status: "invalid",
          detail: `unsupported ${storageStatus} shape: ${errorMessage(error)}`
        }
      };
    }
  }
  const versions =
    `layout=${classification.layoutVersion ?? "?"}/${classification.latestLayoutVersion}`
    + ` aggregate=${classification.aggregateVersion ?? "?"}/${classification.latestAggregateVersion}`;
  const incompatible = classification.incompatibleComponent === undefined
    ? ""
    : ` incompatibleComponent=${classification.incompatibleComponent}`;
  switch (storageStatus) {
    case "current":
      return {
        storageStatus,
        storageOptions: resolvedStorageOptions,
        check: { name, status: "ok", detail: `current (USABLE) ${versions}` }
      };
    case "compatible-old":
      return {
        storageStatus,
        storageOptions: resolvedStorageOptions,
        check: {
          name,
          status: "ok",
          detail: `compatible-old (COMPATIBLE) ${versions}; ordinary commands are supported`
        }
      };
    case "migration-required":
      return {
        storageStatus,
        storageOptions: resolvedStorageOptions,
        check: {
          name,
          status: "ok",
          detail: `migration-required (MIGRATABLE) ${versions}; run yui update when Sessions are clear`
        }
      };
    case "needs-storage-repair":
      return {
        storageStatus,
        storageOptions: resolvedStorageOptions,
        check: {
          name,
          // Diagnostic mode (Issue 01 rollout step 1): the Home is readable
          // and usable, but the manifest claims layout 7 without a yui.db.
          // Surface the repair need in the detail while keeping the Home
          // healthy so ordinary commands keep working.
          status: "ok",
          detail:
            `needs-storage-repair (NEEDS_STORAGE_REPAIR) ${versions}; `
            + "the manifest claims layout 7 but yui.db is missing. Run `yui upgrade` to rebuild it from state.json."
        }
      };
    case "unsupported": {
      const unsupported = classification.classification;
      return {
        storageStatus,
        storageOptions: resolvedStorageOptions,
        check: unsupported.verdict === "CORRUPTED"
          ? {
              name,
              status: "invalid",
              detail: `unsupported (CORRUPTED): ${unsupported.detail}`
            }
          : {
              name,
              status: "unsupported",
              detail:
                `unsupported (NEEDS_NEW_VERSION) ${versions}${incompatible}; ` +
                `${unsupported.blocker.reason}`
            }
      };
    }
  }
}

function inspectState(
  home: string,
  homeCheck: DoctorCheck,
  schema: SchemaInspection,
  compatibility: CompatibilityInspection
): StorageInspection {
  if (homeCheck.status !== "ok") {
    return blockedStorage(homeCheck.status, homeCheck.detail);
  }
  if (schema.status === "uninitialized") {
    return blockedStorage("missing", "run yui setup");
  }
  if (schema.status === "invalid") return blockedStorage("invalid", schema.detail);
  if (schema.status === "read-error") return blockedStorage("invalid", schema.detail);
  // A pseudo-layout-7 Home (needs-storage-repair) has a readable state.json;
  // the compatibility check surfaces the repair need, but the store itself is
  // readable, so the state and review checks must still run (Issue 01).
  if (
    compatibility.check.status !== "ok"
    && compatibility.storageStatus !== "needs-storage-repair"
  ) {
    return blockedStorage(
      compatibility.check.status,
      storageBlockerDetail(compatibility.check)
    );
  }
  if (
    compatibility.storageStatus !== "current"
    && compatibility.storageStatus !== "compatible-old"
    && compatibility.storageStatus !== "needs-storage-repair"
  ) {
    return blockedStorage("unsupported", compatibility.check.detail);
  }
  if (compatibility.storageOptions === undefined) {
    return blockedStorage("invalid", "Storage compatibility options were not resolved.");
  }

  const statePath = join(home, STORAGE_STATE_FILE);
  // A repaired layout-7 Home archived state.json; yui.db is the authoritative
  // backend then, so the state.json gate is skipped (Issue 01).
  const sqliteAuthoritative = !existsSync(statePath)
    && existsSync(join(home, COMMITTED_DATABASE_FILENAME));
  if (!sqliteAuthoritative) {
    if (!existsSync(statePath)) return blockedStorage("missing", "run yui setup");
    try {
      const metadata = lstatSync(statePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return blockedStorage("invalid", `${STORAGE_STATE_FILE} must be a regular file.`);
      }
      accessSync(statePath, constants.R_OK);
    } catch (error) {
      return blockedStorage("invalid", errorMessage(error));
    }
  }
  try {
    const store = openCompatibleFileTaskStore(home, compatibility.storageOptions);
    const config = store.getConfig();
    const agents = store.listConfiguredAgents();
    const tasks = store.listTasks();
    const globalRoles = store.listGlobalRoles();
    const roleCount = tasks.reduce(
      (count, task) => count + store.listRoles(task.id).length,
      0
    );
    return {
      check: {
        name: "storage state",
        status: "ok",
        detail: `${sqliteAuthoritative ? "yui.db readable" : "readable"} agents=${agents.length} tasks=${tasks.length} roles=${roleCount} globalRoles=${globalRoles.length} defaultAgent=${config.defaultAgent ?? "none"}`
      },
      agents,
      review: {
        storageReady: true,
        storageDetail: sqliteAuthoritative ? "yui.db is readable" : "state.json is readable",
        ...(config.review === undefined ? {} : { policy: config.review }),
        ...(config.review === undefined
          ? {}
          : {
              role: store.getGlobalRole(config.review.roleName),
              agent: (() => {
                const role = store.getGlobalRole(config.review.roleName);
                return role === null
                  ? null
                  : store.getConfiguredAgent(role.activeAgentId);
              })()
            })
      }
    };
  } catch (error) {
    return blockedStorage("invalid", errorMessage(error));
  }
}

function storageBlockerDetail(check: DoctorCheck): string {
  const corruptionPrefix = "unsupported (CORRUPTED): ";
  return check.status === "invalid" && check.detail.startsWith(corruptionPrefix)
    ? `Invalid state.json: ${check.detail.slice(corruptionPrefix.length)}`
    : check.detail;
}

function blockedStorage(status: Exclude<DoctorStatus, "ok">, detail: string): StorageInspection {
  return {
    check: { name: "storage state", status, detail },
    agents: [],
    review: {
      storageReady: false,
      storageDetail: detail
    }
  };
}

type ReviewInspection = Readonly<{
  report: DoctorReviewReport;
  checks: readonly DoctorCheck[];
}>;

function inspectReview(
  source: ReviewSource,
  agentChecks: readonly DoctorCheck[],
  environment: NodeJS.ProcessEnv
): ReviewInspection {
  if (!source.storageReady) {
    const raw = source.home === undefined
      ? null
      : inspectRawReview(source.home, source.storageDetail);
    if (raw !== null) return raw;
    return {
      report: {
        status: "misconfigured",
        providerNative: "unverified",
        detail: `Review configuration unavailable: ${source.storageDetail}`
      },
      checks: [{
        name: "review policy",
        status: "invalid",
        detail: `unavailable: ${source.storageDetail}`
      }]
    };
  }

  const policy = source.policy;
  if (policy === undefined) {
    return {
      report: {
        status: "disabled",
        providerNative: "unverified",
        detail: "Review policy is disabled; no Reviewer dispatch is scheduled."
      },
      checks: [{
        name: "review policy",
        status: "ok",
        detail: "disabled"
      }]
    };
  }

  const checks: DoctorCheck[] = [{
    name: "review policy",
    status: "ok",
    detail: `role=${policy.roleName} trigger=${policy.trigger}`
  }];
  const role = source.role ?? null;
  if (role === null) {
    checks.push({
      name: "reviewer role",
      status: "missing",
      detail: `Global Role not found: ${policy.roleName}.`
    });
    return reviewMisconfigured(policy, checks, `Reviewer Role is missing: ${policy.roleName}.`);
  }
  checks.push({
    name: "reviewer role",
    status: "ok",
    detail: `name=${role.name} activeAgent=${role.activeAgentId}`
  });

  const binding = role.agentBindings[role.activeAgentId];
  if (binding === undefined) {
    checks.push({
      name: "reviewer binding",
      status: "missing",
      detail: `active Agent binding is missing: ${role.activeAgentId}.`
    });
    return reviewMisconfigured(policy, checks, "Reviewer active Agent binding is missing.", role);
  }
  checks.push({
    name: "reviewer binding",
    status: "ok",
    detail: `agent=${binding.agentId} adapter=${binding.adapterId}`
  });

  const agent = source.agent ?? null;
  if (agent === null) {
    checks.push({
      name: "reviewer agent",
      status: "missing",
      detail: `Configured Agent not found: ${binding.agentId}.`
    });
    return reviewMisconfigured(policy, checks, `Reviewer Agent is missing: ${binding.agentId}.`, role, binding.agentId, binding.adapterId);
  }
  checks.push({
    name: "reviewer agent",
    status: "ok",
    detail: `id=${agent.id} adapter=${agent.adapterId} command=${agent.command}`
  });

  if (agent.adapterId !== binding.adapterId) {
    checks.push({
      name: "reviewer adapter",
      status: "invalid",
      detail: `binding adapter=${binding.adapterId} does not match Agent adapter=${agent.adapterId}.`
    });
    return reviewMisconfigured(policy, checks, "Reviewer adapter identity does not match its Agent binding.", role, agent.id, agent.adapterId, agent.command);
  }
  let adapter;
  try {
    adapter = resolveAgentAdapter(agent.adapterId);
    checks.push({
      name: "reviewer adapter",
      status: "ok",
      detail: `adapter=${adapter.id} nativeSession=${adapter.capabilities.nativeSessionDiscovery}`
    });
  } catch (error) {
    checks.push({
      name: "reviewer adapter",
      status: "unsupported",
      detail: errorMessage(error)
    });
    return reviewMisconfigured(policy, checks, `Reviewer adapter is unavailable: ${errorMessage(error)}`,
      role, agent.id, agent.adapterId, agent.command);
  }

  const commandCheck = agentChecks.find((check) => check.name === `agent:${agent.id}:command`);
  const capabilityCheck = agentChecks.find((check) => check.name === `agent:${agent.id}:capability`);
  checks.push({
    name: "reviewer command",
    status: commandCheck?.status ?? "invalid",
    detail: commandCheck === undefined
      ? `No command inspection was recorded for ${agent.id}.`
      : commandCheck.detail
  });
  checks.push({
    name: "reviewer capability",
    status: capabilityCheck?.status ?? "invalid",
    detail: capabilityCheck === undefined
      ? `No capability inspection was recorded for ${agent.id}.`
      : capabilityCheck.detail
  });

  const launch = checkReviewerLaunch(
    agent,
    role,
    binding,
    adapter,
    environment,
    source.home
  );
  checks.push(launch);
  const dispatch = checkReviewerDispatch(policy, role, binding, agent, launch, commandCheck, capabilityCheck);
  checks.push(dispatch);
  const failedCheck = checks.find((check) => check.status !== "ok");
  if (failedCheck !== undefined) {
    return reviewMisconfigured(
      policy,
      checks,
      `${failedCheck.name}: ${failedCheck.detail}`,
      role,
      agent.id,
      agent.adapterId,
      agent.command
    );
  }
  return {
    report: {
      status: "ready",
      policy,
      roleName: role.name,
      activeAgentId: agent.id,
      adapterId: agent.adapterId,
      command: agent.command,
      providerNative: "unverified",
      detail: "Static Reviewer configuration and exact dispatch prerequisites are ready; provider-native acceptance is unverified."
    },
    checks
  };
}

/**
 * Preserve a bounded Reviewer diagnosis when another malformed record prevents
 * FileTaskStore from opening. This is read-only evidence, never a compatibility
 * path: the storage check remains invalid and the review projection cannot be
 * reported as ready from unvalidated bytes.
 */
function inspectRawReview(home: string, storageDetail: string): ReviewInspection | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.config)) return null;
    const rawPolicy = parsed.config.review;
    if (!isRecord(rawPolicy)
      || typeof rawPolicy.roleName !== "string"
      || typeof rawPolicy.trigger !== "string") {
      return {
        report: {
          status: "misconfigured",
          providerNative: "unverified",
          detail: `Storage state is invalid; Review policy is unavailable: ${storageDetail}`
        },
        checks: [{
          name: "review policy",
          status: "invalid",
          detail: `storage state invalid: ${storageDetail}`
        }]
      };
    }
    const policy = {
      roleName: rawPolicy.roleName,
      trigger: rawPolicy.trigger
    } as ReviewConfig;
    const roles = isRecord(parsed.globalRoles) ? parsed.globalRoles : {};
    const roleValue = roles[policy.roleName];
    if (!isRecord(roleValue)) {
      return rawReviewMisconfigured(policy, storageDetail, [{
        name: "review policy",
        status: "ok",
        detail: `role=${policy.roleName} trigger=${policy.trigger}`
      }, {
        name: "reviewer role",
        status: "missing",
        detail: `Global Role not found: ${policy.roleName}.`
      }]);
    }
    const roleName = typeof roleValue.name === "string" ? roleValue.name : policy.roleName;
    const activeAgentId = typeof roleValue.activeAgentId === "string"
      ? roleValue.activeAgentId
      : "";
    const checks: DoctorCheck[] = [{
      name: "review policy",
      status: "ok",
      detail: `role=${policy.roleName} trigger=${policy.trigger}`
    }, {
      name: "reviewer role",
      status: "ok",
      detail: `name=${roleName} activeAgent=${activeAgentId || "missing"}`
    }];
    const bindings = isRecord(roleValue.agentBindings) ? roleValue.agentBindings : {};
    const bindingValue = activeAgentId.length === 0 ? undefined : bindings[activeAgentId];
    if (!isRecord(bindingValue)) {
      checks.push({
        name: "reviewer binding",
        status: "missing",
        detail: `active Agent binding is missing: ${activeAgentId || "unknown"}.`
      });
      return rawReviewMisconfigured(policy, storageDetail, checks, roleName, activeAgentId || undefined);
    }
    const bindingAgentId = typeof bindingValue.agentId === "string"
      ? bindingValue.agentId
      : activeAgentId;
    const adapterId = typeof bindingValue.adapterId === "string"
      ? bindingValue.adapterId
      : "unknown";
    checks.push({
      name: "reviewer binding",
      status: "ok",
      detail: `agent=${bindingAgentId} adapter=${adapterId}`
    });
    const configuredAgents = isRecord(parsed.configuredAgents)
      ? parsed.configuredAgents
      : {};
    const agentValue = configuredAgents[bindingAgentId];
    if (!isRecord(agentValue)) {
      checks.push({
        name: "reviewer agent",
        status: "missing",
        detail: `Configured Agent not found: ${bindingAgentId}.`
      });
      return rawReviewMisconfigured(policy, storageDetail, checks, roleName, bindingAgentId, adapterId);
    }
    checks.push({
      name: "reviewer agent",
      status: "invalid",
      detail: `Storage state is invalid; configured Agent ${bindingAgentId} cannot be validated.`
    });
    return rawReviewMisconfigured(policy, storageDetail, checks, roleName, bindingAgentId, adapterId,
      typeof agentValue.command === "string" ? agentValue.command : undefined);
  } catch {
    return null;
  }
}

function rawReviewMisconfigured(
  policy: ReviewConfig,
  storageDetail: string,
  checks: readonly DoctorCheck[],
  roleName?: string,
  activeAgentId?: string,
  adapterId?: string,
  command?: string
): ReviewInspection {
  return {
    report: {
      status: "misconfigured",
      policy,
      ...(roleName === undefined ? {} : { roleName }),
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      ...(adapterId === undefined ? {} : { adapterId }),
      ...(command === undefined ? {} : { command }),
      providerNative: "unverified",
      detail: `Storage state is invalid; ${checks.at(-1)?.detail ?? storageDetail}`
    },
    checks
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reviewMisconfigured(
  policy: ReviewConfig,
  checks: readonly DoctorCheck[],
  detail: string,
  role?: GlobalRole,
  activeAgentId?: string,
  adapterId?: string,
  command?: string
): ReviewInspection {
  return {
    report: {
      status: "misconfigured",
      policy,
      roleName: role?.name ?? policy.roleName,
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      ...(adapterId === undefined ? {} : { adapterId }),
      ...(command === undefined ? {} : { command }),
      providerNative: "unverified",
      detail
    },
    checks
  };
}

function checkReviewerLaunch(
  agent: ConfiguredAgent,
  role: GlobalRole,
  binding: GlobalRole["agentBindings"][string],
  adapter: ReturnType<typeof resolveAgentAdapter>,
  environment: NodeJS.ProcessEnv,
  home: string | undefined
): DoctorCheck {
  try {
    const workspace = role.workspace;
    if (!isAbsolute(workspace)) {
      return {
        name: "reviewer launch",
        status: "invalid",
        detail: "Reviewer Role workspace must be absolute."
      };
    }
    const metadata = lstatSync(workspace);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return {
        name: "reviewer launch",
        status: "invalid",
        detail: "Reviewer Role workspace must be an existing real directory."
      };
    }
    const definition = configuredAgentToDefinition(agent);
    const launchEnvironment = resolveDoctorAgentEnvironment(definition, environment);
    const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
    const agentWorkspace = effective.workspace.entries.length === 1
      ? effective.workspace.entries[0]!.path
      : effective.workspace.root;
    const codexConfig = adapter.id === "codex"
      ? inspectCodexLaunchConfig({
          environment: launchEnvironment,
          workspace: agentWorkspace,
          profile: binding.config.adapterId === "codex" ? binding.config.profile : undefined,
          trustWorkspace: true
        })
      : undefined;
    if (codexConfig?.notify.status === "configured") {
      return {
        name: "reviewer launch",
        status: "invalid",
        detail: "Codex notify is already configured by "
          + `${codexConfig.notify.source}; Yui requires exclusive ownership of the structured `
          + "notify callback and refuses to replace or be replaced by native configuration."
      };
    }
    const reviewerContext = adapter.id === "codex"
      ? compileRoleSessionContext(home, role, { scope: "global" }, { purpose: "review" })
      : undefined;
    const compiled = adapter.compileNew({
      agent: definition,
      config: binding.config,
      workspace: agentWorkspace,
      sessionTitle: "reviewer",
      ...(reviewerContext === undefined
        ? {}
        : {
            developerInstructions: reviewerContext.developerInstructions,
            skills: reviewerContext.skills,
            codexDeveloperInstructions: codexConfig?.developerInstructions
          })
    });
    if (compiled.argv.length === 0) throw new Error("compiled launch argv is empty");
    return {
      name: "reviewer launch",
      status: "ok",
      detail: `adapter=${adapter.id} strategy=${compiled.sessionStrategy} command=${agent.command}`
    };
  } catch (error) {
    return {
      name: "reviewer launch",
      status: "invalid",
      detail: errorMessage(error)
    };
  }
}

function checkReviewerDispatch(
  _policy: ReviewConfig,
  role: GlobalRole,
  binding: GlobalRole["agentBindings"][string],
  agent: ConfiguredAgent,
  launch: DoctorCheck,
  command: DoctorCheck | undefined,
  capability: DoctorCheck | undefined
): DoctorCheck {
  if (role.defaultAccess !== "write") {
    return {
      name: "reviewer dispatch",
      status: "invalid",
      detail: "Reviewer Role must retain write access for an isolated ReviewRound workspace."
    };
  }
  if (binding.agentId !== agent.id) {
    return {
      name: "reviewer dispatch",
      status: "invalid",
      detail: `active binding Agent id does not match configured Agent: ${binding.agentId}/${agent.id}.`
    };
  }
  if (launch.status !== "ok" || command?.status !== "ok" || capability?.status !== "ok") {
    return {
      name: "reviewer dispatch",
      status: "invalid",
      detail: "Reviewer exact dispatch is blocked until command, capability, and launch checks are ok."
    };
  }
  return {
    name: "reviewer dispatch",
    status: "ok",
    detail: "static exact dispatch prerequisites confirmed; no Session or model was launched."
  };
}

function checkExecutable(
  name: "git" | "tmux",
  command: string,
  args: string[],
  executor: CommandExecutor
): DoctorCheck {
  try {
    const output = firstLine(executor.run(command, args));
    return {
      name,
      status: "ok",
      detail: output.length === 0 ? command : `${command}: ${output}`
    };
  } catch (error) {
    return {
      name,
      status: isMissingCommand(error) ? "missing" : "invalid",
      detail: `${command}: ${commandFailure(error)}`
    };
  }
}

function checkAgent(
  agent: ConfiguredAgent,
  executor: CommandExecutor,
  environment: NodeJS.ProcessEnv
): DoctorCheck[] {
  let snapshot: CapabilitySnapshot;
  try {
    const definition = configuredAgentToDefinition(agent);
    const launchEnvironment = resolveDoctorAgentEnvironment(definition, environment);
    snapshot = inspectAgentCapabilities(definition, {
      run: (command, args) => runAgentProbe(executor, command, args, launchEnvironment)
    });
  } catch (error) {
    return [{
      name: `agent:${agent.id}`,
      status: "invalid",
      detail: `${agent.command}: ${errorMessage(error)}`
    }];
  }

  const installation = snapshot.installation;
  const status: DoctorStatus = installation.status === "installed"
    ? "ok"
    : installation.status === "missing"
      ? "missing"
      : installation.status === "unsupported-version" ? "unsupported" : "invalid";
  const commandDetail = [
    `command=${installation.command}`,
    `adapter=${snapshot.adapterId}`,
    ...(installation.version === undefined ? [] : [`version=${installation.version}`]),
    ...(installation.reason === undefined ? [] : [`reason=${installation.reason}`])
  ].join(" ");
  const available = snapshot.fields.filter((field) => field.status === "available").length;
  const degraded = snapshot.fields.filter((field) => field.status === "degraded").length;
  const unavailable = snapshot.fields.filter((field) => field.status === "unavailable").length;
  return [
    { name: `agent:${agent.id}:command`, status, detail: commandDetail },
    {
      name: `agent:${agent.id}:capability`,
      status,
      detail: [
        `start resume interrupt nativeSession=${snapshot.lifecycle.nativeSessionDiscovery}`,
        `preInputReady=${snapshot.lifecycle.preInputReadiness.status}`,
        `fields=${available}/${degraded}/${unavailable}`,
        ...snapshot.warnings.map((warning) => `warning=${warning}`)
      ].join(" ")
    }
  ];
}

function runAgentProbe(
  executor: CommandExecutor,
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>
): AgentProbeResult {
  try {
    return {
      status: 0,
      stdout: executor.run(command, [...args], { environment }),
      stderr: ""
    };
  } catch (error) {
    const missing = isMissingCommand(error);
    const probeError = Object.assign(new Error(errorMessage(error)), {
      ...(missing ? { code: "ENOENT" } : {})
    });
    return {
      status: error instanceof CommandExecutionError ? error.exitStatus ?? null : null,
      stdout: "",
      stderr: error instanceof CommandExecutionError ? error.stderr : "",
      error: probeError
    };
  }
}

/**
 * Resolve the complete environment used by FileRoleLaunchPlanner for an Agent.
 * Doctor probes must inspect the same command resolution context as a native
 * launch; inheriting the Doctor process PATH would allow a shell-installed
 * command to mask a missing configured binding.
 */
function resolveDoctorAgentEnvironment(
  agent: Pick<ConfiguredAgent, "adapterId" | "environment">,
  environment: NodeJS.ProcessEnv
): Record<string, string> {
  return {
    ...operationalAgentEnvironment(agent.adapterId, environment),
    ...resolveAgentEnvironment(agent, environment)
  };
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof CommandExecutionError
    ? error.code === "COMMAND_NOT_FOUND"
    : systemCode(error) === "ENOENT";
}

function commandFailure(error: unknown): string {
  if (error instanceof CommandExecutionError) {
    return error.stderr.trim() || error.message;
  }
  return errorMessage(error);
}

function firstLine(output: string): string {
  return output.trim().split(/\r?\n/, 1)[0] ?? "";
}

function systemCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
