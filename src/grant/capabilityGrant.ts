import {
  requireIdentity,
  requireText,
  requireTimestamp,
  requirePositiveInteger
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export const CAPABILITY_GRANT_SCHEMA_VERSION = 2 as const;

export type CapabilityGrantIrreversibilityCeiling = "none" | "reversible" | "irreversible";
export type CapabilityGrantIrreversibility = CapabilityGrantIrreversibilityCeiling;

const IRREVERSIBILITY_RANK: Readonly<Record<CapabilityGrantIrreversibility, number>> = {
  none: 0,
  reversible: 1,
  irreversible: 2
};

export type CapabilityGrantRepository = Readonly<{
  owner: string;
  name: string;
}>;

/**
 * The resource selectors a grant bounds. At least one selector is required; a
 * grant with no explicit selectors is scoped to its owning Task. The release
 * workflow (a later contract) interprets the selectors; the authorization
 * decision in this module treats the scope as recorded evidence.
 */
export type CapabilityGrantScope = Readonly<{
  taskId?: string;
  projectIds?: readonly string[];
  repositories?: readonly CapabilityGrantRepository[];
  packages?: readonly string[];
  homePath?: string;
}>;

export type CapabilityGrant = Readonly<{
  schemaVersion: typeof CAPABILITY_GRANT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  /** The authorizing user who granted the capability. */
  granter: string;
  scope: CapabilityGrantScope;
  /** Opaque allowed action names; the release-workflow catalog arrives later. */
  actions: readonly string[];
  /**
   * Maps a parameter name to its exhaustive allowed values. A key absent from
   * this record means that parameter is unconstrained.
   */
  parameterBounds: Readonly<Record<string, readonly string[]>>;
  expiresAt?: string;
  maxUses?: number;
  usesUsed: number;
  /**
   * Durable attempt identities for which a use was recorded. Each release
   * workflow submission appends one key (`<workflow>/<step>#<attempt>`) so a
   * resume can recognize an already-committed use instead of charging again.
   */
  useReservations: readonly string[];
  irreversibilityCeiling: CapabilityGrantIrreversibilityCeiling;
  revokedAt?: string;
  revokedBy?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type CapabilityGrantRequest = Readonly<{
  action: string;
  params?: Readonly<Record<string, string>>;
  irreversibility?: CapabilityGrantIrreversibility;
}>;

export type CapabilityGrantDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: string }>;

export function createCapabilityGrant(
  id: string,
  taskId: string,
  input: Readonly<{
    granter: string;
    scope?: CapabilityGrantScope;
    actions: readonly string[];
    parameterBounds?: Readonly<Record<string, readonly string[]>>;
    expiresAt?: string;
    maxUses?: number;
    irreversibilityCeiling?: CapabilityGrantIrreversibilityCeiling;
  }>,
  now: Date
): CapabilityGrant {
  const timestamp = now.toISOString();
  return validateCapabilityGrant({
    schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
    id: validateTaskRecordReference({ taskId, localId: id }, "capabilityGrant").localId,
    taskId: requireIdentity(taskId, "Task id"),
    granter: requireText(input.granter, "Capability grant granter"),
    scope: normalizeScope(input.scope, taskId),
    actions: normalizeActions(input.actions),
    parameterBounds: normalizeParameterBounds(input.parameterBounds),
    ...(input.expiresAt === undefined ? {} : { expiresAt: requireTimestamp(input.expiresAt, "Capability grant expiresAt") }),
    ...(input.maxUses === undefined ? {} : { maxUses: requirePositiveInteger(input.maxUses, "Capability grant maxUses") }),
    usesUsed: 0,
    useReservations: Object.freeze([]),
    irreversibilityCeiling: normalizeCeiling(input.irreversibilityCeiling),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * The pure authorization decision. Every denial carries a distinct
 * machine-readable reason so a release workflow can fail closed precisely.
 *
 * `skipUsesCheck` is used when re-attempting a step that was already running:
 * the grant use was already consumed for this step before the crash, so the
 * uses check is skipped to avoid stranding the workflow.
 */
export function checkGrant(
  grant: CapabilityGrant,
  request: CapabilityGrantRequest,
  now: Date,
  options?: { skipUsesCheck?: boolean }
): CapabilityGrantDecision {
  validateCapabilityGrant(grant);
  if (grant.revokedAt !== undefined) {
    return { allowed: false, reason: "grant-revoked" };
  }
  if (grant.expiresAt !== undefined && now.getTime() > Date.parse(grant.expiresAt)) {
    return { allowed: false, reason: "grant-expired" };
  }
  if (!options?.skipUsesCheck && grant.maxUses !== undefined && grant.usesUsed >= grant.maxUses) {
    return { allowed: false, reason: "grant-uses-exhausted" };
  }
  if (!grant.actions.includes(request.action)) {
    return { allowed: false, reason: "grant-action-not-allowed" };
  }
  for (const [name, allowedValues] of Object.entries(grant.parameterBounds)) {
    const value = request.params?.[name];
    if (value === undefined) {
      return { allowed: false, reason: "grant-parameter-missing" };
    }
    if (!allowedValues.includes(value)) {
      return { allowed: false, reason: "grant-parameter-value-not-allowed" };
    }
  }
  const requested = IRREVERSIBILITY_RANK[request.irreversibility ?? "none"];
  if (requested > IRREVERSIBILITY_RANK[grant.irreversibilityCeiling]) {
    return { allowed: false, reason: "grant-irreversibility-exceeds-ceiling" };
  }
  return { allowed: true };
}

/** The reservation keys recorded on a grant. */
export function grantUseReservations(grant: CapabilityGrant): readonly string[] {
  return grant.useReservations;
}

/**
 * Record one use against the grant, failing closed once the limit is reached.
 * The reservation key is appended to the grant's durable reservations so a
 * later resume recognizes this exact attempt and avoids a double charge.
 */
export function recordGrantUse(
  grant: CapabilityGrant,
  now: Date,
  reservationKey: string
): CapabilityGrant {
  validateCapabilityGrant(grant);
  if (grant.maxUses !== undefined && grant.usesUsed >= grant.maxUses) {
    throw new Error(`Capability grant is exhausted: ${grant.id}.`);
  }
  return validateCapabilityGrant({
    ...grant,
    usesUsed: grant.usesUsed + 1,
    useReservations: Object.freeze([...grantUseReservations(grant), reservationKey]),
    updatedAt: now.toISOString()
  });
}

/**
 * Revoke a grant. Re-revoking an already-revoked grant is idempotent: the
 * original revocation stands and the record is returned unchanged.
 */
export function revokeGrant(
  grant: CapabilityGrant,
  revokedBy: string,
  now: Date
): CapabilityGrant {
  validateCapabilityGrant(grant);
  if (grant.revokedAt !== undefined) return grant;
  const actor = requireText(revokedBy, "Capability grant revokedBy");
  const timestamp = now.toISOString();
  return validateCapabilityGrant({
    ...grant,
    revokedAt: timestamp,
    revokedBy: actor,
    updatedAt: timestamp
  });
}

export function validateCapabilityGrant(grant: CapabilityGrant): CapabilityGrant {
  if (grant.schemaVersion !== CAPABILITY_GRANT_SCHEMA_VERSION) {
    throw new Error("Capability grant must use schemaVersion 2.");
  }
  validateTaskRecordReference({ taskId: grant.taskId, localId: grant.id }, "capabilityGrant");
  requireIdentity(grant.taskId, "Task id");
  requireText(grant.granter, "Capability grant granter");
  validateScope(grant.scope, grant.taskId);
  normalizeActions(grant.actions);
  normalizeParameterBounds(grant.parameterBounds);
  if (grant.expiresAt !== undefined) {
    requireTimestamp(grant.expiresAt, "Capability grant expiresAt");
  }
  if (grant.maxUses !== undefined) {
    requirePositiveInteger(grant.maxUses, "Capability grant maxUses");
  }
  if (!Number.isSafeInteger(grant.usesUsed) || grant.usesUsed < 0) {
    throw new Error("Capability grant usesUsed must be a non-negative integer.");
  }
  if (grant.maxUses !== undefined && grant.usesUsed > grant.maxUses) {
    throw new Error("Capability grant usesUsed cannot exceed maxUses.");
  }
  if (!Array.isArray(grant.useReservations)) {
    throw new Error("Capability grant useReservations must be an array.");
  }
  for (const key of grant.useReservations) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("Capability grant useReservations must be non-empty strings.");
    }
  }
  if (new Set(grant.useReservations).size !== grant.useReservations.length) {
    throw new Error("Capability grant useReservations must be unique.");
  }
  if (grant.useReservations.length > grant.usesUsed) {
    throw new Error("Capability grant useReservations cannot outnumber usesUsed.");
  }
  normalizeCeiling(grant.irreversibilityCeiling);
  if ((grant.revokedAt === undefined) !== (grant.revokedBy === undefined)) {
    throw new Error("Capability grant revocation requires both revokedAt and revokedBy.");
  }
  if (grant.revokedAt !== undefined) {
    requireTimestamp(grant.revokedAt, "Capability grant revokedAt");
    requireText(grant.revokedBy!, "Capability grant revokedBy");
  }
  requireTimestamp(grant.createdAt, "Capability grant createdAt");
  requireTimestamp(grant.updatedAt, "Capability grant updatedAt");
  return grant;
}

function normalizeCeiling(
  value: CapabilityGrantIrreversibilityCeiling | undefined
): CapabilityGrantIrreversibilityCeiling {
  if (value === undefined) return "none";
  if (!Object.hasOwn(IRREVERSIBILITY_RANK, value)) {
    throw new Error(`Capability grant irreversibility ceiling is invalid: ${String(value)}.`);
  }
  return value;
}

function normalizeActions(actions: readonly string[]): readonly string[] {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("Capability grant actions must be a non-empty array.");
  }
  const normalized = actions.map((action) => requireText(action, "Capability grant action"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Capability grant actions must be unique.");
  }
  return Object.freeze(normalized);
}

function normalizeParameterBounds(
  bounds: Readonly<Record<string, readonly string[]>> | undefined
): Readonly<Record<string, readonly string[]>> {
  if (bounds === undefined) return Object.freeze({});
  if (typeof bounds !== "object" || bounds === null || Array.isArray(bounds)) {
    throw new Error("Capability grant parameterBounds must be an object.");
  }
  const normalized: Record<string, readonly string[]> = {};
  for (const [name, values] of Object.entries(bounds)) {
    const key = requireIdentity(name, "Capability grant parameter");
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`Capability grant parameter bound must list allowed values: ${name}.`);
    }
    const allowed = values.map((value) => requireText(value, `Capability grant parameter ${name} value`));
    if (new Set(allowed).size !== allowed.length) {
      throw new Error(`Capability grant parameter bound values must be unique: ${name}.`);
    }
    normalized[key] = Object.freeze(allowed);
  }
  return Object.freeze(normalized);
}

function normalizeScope(scope: CapabilityGrantScope | undefined, taskId: string): CapabilityGrantScope {
  if (scope === undefined) return Object.freeze({ taskId });
  validateScope(scope, taskId);
  const normalized: CapabilityGrantScope = {
    ...(scope.taskId === undefined ? {} : { taskId: requireIdentity(scope.taskId, "Capability grant scope taskId") }),
    ...(scope.projectIds === undefined || scope.projectIds.length === 0
      ? {}
      : { projectIds: normalizeScopeIdentities(scope.projectIds, "Capability grant scope Project") }),
    ...(scope.repositories === undefined || scope.repositories.length === 0
      ? {}
      : { repositories: normalizeRepositories(scope.repositories) }),
    ...(scope.packages === undefined || scope.packages.length === 0
      ? {}
      : { packages: normalizeScopeText(scope.packages, "Capability grant scope package") }),
    ...(scope.homePath === undefined ? {} : { homePath: requireText(scope.homePath, "Capability grant scope homePath") })
  };
  if (!hasScopeSelector(normalized)) {
    return Object.freeze({ taskId });
  }
  return Object.freeze(normalized);
}

function validateScope(scope: CapabilityGrantScope, taskId: string): void {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw new Error("Capability grant scope must be an object.");
  }
  if (scope.taskId !== undefined) {
    requireIdentity(scope.taskId, "Capability grant scope taskId");
  }
  if (scope.projectIds !== undefined) {
    normalizeScopeIdentities(scope.projectIds, "Capability grant scope Project");
  }
  if (scope.repositories !== undefined) {
    normalizeRepositories(scope.repositories);
  }
  if (scope.packages !== undefined) {
    normalizeScopeText(scope.packages, "Capability grant scope package");
  }
  if (scope.homePath !== undefined) {
    requireText(scope.homePath, "Capability grant scope homePath");
  }
  if (!hasScopeSelector(scope) && scope.taskId === undefined) {
    throw new Error(`Capability grant scope requires at least one selector: ${taskId}.`);
  }
}

function hasScopeSelector(scope: CapabilityGrantScope): boolean {
  return scope.taskId !== undefined
    || (scope.projectIds?.length ?? 0) > 0
    || (scope.repositories?.length ?? 0) > 0
    || (scope.packages?.length ?? 0) > 0
    || scope.homePath !== undefined;
}

function normalizeScopeIdentities(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label} ids must be an array.`);
  const normalized = values.map((value) => requireIdentity(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} ids must be unique.`);
  }
  return Object.freeze(normalized);
}

function normalizeScopeText(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label}s must be an array.`);
  const normalized = values.map((value) => requireText(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label}s must be unique.`);
  }
  return Object.freeze(normalized);
}

function normalizeRepositories(
  repositories: readonly CapabilityGrantRepository[]
): readonly CapabilityGrantRepository[] {
  if (!Array.isArray(repositories)) {
    throw new Error("Capability grant scope repositories must be an array.");
  }
  const normalized = repositories.map((repository) => {
    if (typeof repository !== "object" || repository === null) {
      throw new Error("Capability grant scope repository is invalid.");
    }
    return Object.freeze({
      owner: requireText(repository.owner, "Capability grant scope repository owner"),
      name: requireText(repository.name, "Capability grant scope repository name")
    });
  });
  const keys = new Set(normalized.map(({ owner, name }) => `${owner}/${name}`));
  if (keys.size !== normalized.length) {
    throw new Error("Capability grant scope repositories must be unique.");
  }
  return Object.freeze(normalized);
}
