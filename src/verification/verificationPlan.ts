import { createHash } from "node:crypto";

import {
  requireIdentity,
  requirePositiveInteger,
  requireText
} from "../domain/validation.js";
import type { DurableJobStep } from "../job/durableJob.js";
import type { Project } from "../repository/project.js";

/**
 * Issue 08: the per-Project VerificationPlan contract.
 *
 * A Project's verification knowledge lives in its Yui-maintained Project
 * record (a `verification-plan` knowledge entry, see
 * {@link resolveProjectVerificationPlan}). The plan is Project Policy: it is
 * never a hardcoded Yui default. A Project without a plan keeps the existing
 * explicit `--check <shell>` path, which is marked unstructured and is not
 * reusable across stages.
 */

export const VERIFICATION_PLAN_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_PLAN_KIND = "verification-plan";

/** The reserved knowledge marker that carries a Project's VerificationPlan. */
export const VERIFICATION_PLAN_KNOWLEDGE_KIND = VERIFICATION_PLAN_KIND;

/**
 * Rollout switch for a configured Project.
 *
 * - `record`: always run the plan gate; record the GateArtifact and count
 *   potential reuses (shadow metrics) without skipping execution.
 * - `reuse`: return an existing successful artifact for the same identity
 *   tuple instead of re-running the gate.
 * - `enforce`: `reuse` plus rejecting ad-hoc full-suite shell checks that
 *   duplicate the plan's L2 steps (targeted diagnostic checks stay allowed).
 */
export type VerificationMode = "record" | "reuse" | "enforce";

/**
 * A structured verification step. `argv` is executed without a shell so a
 * path or flag can never be misinterpreted as a shell token. A step that
 * genuinely needs shell semantics must declare `shell: true` explicitly.
 */
export type VerificationStep = Readonly<{
  name: string;
  argv: readonly string[];
  /** Working directory relative to the workspace root. */
  cwd?: string;
  /** Extra environment merged over the gate job's environment. */
  env?: Readonly<Record<string, string>>;
  /** Declare that this step genuinely needs shell semantics. */
  shell?: boolean;
}>;

/** L1: a change category (matched by changed path prefix) and its checks. */
export type VerificationL1Category = Readonly<{
  id: string;
  paths: readonly string[];
  checks: readonly VerificationStep[];
}>;

/** Toolchain identity requirements the plan declares. */
export type VerificationToolchain = Readonly<{
  node?: string;
  npm?: string;
  platform?: string;
}>;

export type VerificationPlan = Readonly<{
  schemaVersion: typeof VERIFICATION_PLAN_SCHEMA_VERSION;
  kind: typeof VERIFICATION_PLAN_KIND;
  id: string;
  version: string;
  mode: VerificationMode;
  toolchain: VerificationToolchain;
  /** Workspace preparation (e.g. `npm ci`) run before any gate step. */
  bootstrap: readonly VerificationStep[];
  /** L1 change-related targeted checks. */
  l1: Readonly<{ categories: readonly VerificationL1Category[] }>;
  /** L2 exact-SHA hermetic gate steps. */
  l2: Readonly<{ steps: readonly VerificationStep[] }>;
  /** L3 package/release smoke steps (release-unique only). */
  l3?: Readonly<{ steps: readonly VerificationStep[] }>;
  /** Real-resource checks this plan deliberately does not run. */
  excludedRealResourceChecks?: readonly string[];
  /** Retention window for unreferenced successful artifacts, in days. */
  artifactTtlDays?: number;
}>;

/** The resolved runtime toolchain a gate actually ran under. */
export type ResolvedToolchain = Readonly<{
  node: string;
  npm?: string;
  platform: string;
  arch: string;
}>;

export function normalizeVerificationPlan(raw: unknown): VerificationPlan {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("VerificationPlan must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== VERIFICATION_PLAN_KIND) {
    throw new Error(`VerificationPlan kind must be "${VERIFICATION_PLAN_KIND}".`);
  }
  const schemaVersion = record.schemaVersion ?? VERIFICATION_PLAN_SCHEMA_VERSION;
  if (schemaVersion !== VERIFICATION_PLAN_SCHEMA_VERSION) {
    throw new Error(
      `VerificationPlan schemaVersion must be ${VERIFICATION_PLAN_SCHEMA_VERSION}.`
    );
  }
  const mode = record.mode ?? "record";
  if (mode !== "record" && mode !== "reuse" && mode !== "enforce") {
    throw new Error(`VerificationPlan mode is invalid: ${String(mode)}.`);
  }
  const plan: VerificationPlan = {
    schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
    kind: VERIFICATION_PLAN_KIND,
    id: requireIdentity(record.id as string, "VerificationPlan id"),
    version: requireText(record.version as string, "VerificationPlan version"),
    mode,
    toolchain: normalizeToolchain(record.toolchain),
    bootstrap: normalizeSteps(record.bootstrap, "bootstrap"),
    l1: {
      categories: normalizeL1Categories(record.l1)
    },
    l2: {
      steps: normalizeSteps(
        (record.l2 as Record<string, unknown> | undefined)?.steps,
        "l2"
      )
    },
    ...(record.l3 === undefined
      ? {}
      : {
          l3: {
            steps: normalizeSteps(
              (record.l3 as Record<string, unknown> | undefined)?.steps,
              "l3"
            )
          }
        }),
    ...(record.excludedRealResourceChecks === undefined
      ? {}
      : {
          excludedRealResourceChecks: normalizedTextList(
            record.excludedRealResourceChecks,
            "VerificationPlan excludedRealResourceChecks"
          )
        }),
    ...(record.artifactTtlDays === undefined
      ? {}
      : {
          artifactTtlDays: requirePositiveInteger(
            Number(record.artifactTtlDays),
            "VerificationPlan artifactTtlDays"
          )
        })
  };
  if (plan.l2.steps.length === 0) {
    throw new Error("VerificationPlan l2 requires at least one step.");
  }
  return plan;
}

function normalizeToolchain(raw: unknown): VerificationToolchain {
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("VerificationPlan toolchain must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const toolchain: VerificationToolchain = {
    ...(record.node === undefined ? {} : { node: requireText(record.node as string, "VerificationPlan toolchain node") }),
    ...(record.npm === undefined ? {} : { npm: requireText(record.npm as string, "VerificationPlan toolchain npm") }),
    ...(record.platform === undefined ? {} : { platform: requireText(record.platform as string, "VerificationPlan toolchain platform") })
  };
  return toolchain;
}

function normalizeSteps(raw: unknown, label: string): readonly VerificationStep[] {
  if (!Array.isArray(raw)) {
    throw new Error(`VerificationPlan ${label} steps must be an array.`);
  }
  const names = new Set<string>();
  return Object.freeze(raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`VerificationPlan ${label} step must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const name = requireIdentity(record.name as string, `VerificationPlan ${label} step name`);
    if (names.has(name)) {
      throw new Error(`VerificationPlan ${label} step names must be unique: ${name}.`);
    }
    names.add(name);
    if (!Array.isArray(record.argv) || record.argv.length === 0) {
      throw new Error(`VerificationPlan ${label} step ${name} requires a non-empty argv.`);
    }
    const argv = Object.freeze((record.argv as unknown[]).map((value) => requireText(value as string, `VerificationPlan ${label} step ${name} argv`)));
    const step: VerificationStep = {
      name,
      argv,
      ...(record.cwd === undefined ? {} : { cwd: requireText(record.cwd as string, `VerificationPlan ${label} step ${name} cwd`) }),
      ...(record.env === undefined ? {} : { env: normalizeStepEnv(record.env, `${label} step ${name}`) }),
      ...(record.shell === undefined ? {} : { shell: record.shell === true })
    };
    if (step.cwd !== undefined && step.cwd.startsWith("/")) {
      throw new Error(`VerificationPlan ${label} step ${name} cwd must be workspace-relative.`);
    }
    return step;
  }));
}

function normalizeStepEnv(raw: unknown, label: string): Readonly<Record<string, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`VerificationPlan ${label} env must be a map.`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`VerificationPlan ${label} env values must be strings: ${key}.`);
    }
    env[requireIdentity(key, `VerificationPlan ${label} env key`)] = value;
  }
  return Object.freeze(env);
}

function normalizeL1Categories(raw: unknown): readonly VerificationL1Category[] {
  if (raw === undefined) return Object.freeze([]);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("VerificationPlan l1 must be an object.");
  }
  const categoriesRaw = (raw as Record<string, unknown>).categories;
  if (!Array.isArray(categoriesRaw)) {
    throw new Error("VerificationPlan l1 categories must be an array.");
  }
  const ids = new Set<string>();
  return Object.freeze(categoriesRaw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("VerificationPlan l1 category must be an object.");
    }
    const record = entry as Record<string, unknown>;
    const id = requireIdentity(record.id as string, "VerificationPlan l1 category id");
    if (ids.has(id)) {
      throw new Error(`VerificationPlan l1 category ids must be unique: ${id}.`);
    }
    ids.add(id);
    return Object.freeze({
      id,
      paths: normalizedTextList(record.paths, `VerificationPlan l1 category ${id} paths`),
      checks: normalizeSteps(record.checks, `l1 ${id}`)
    });
  }));
}

function normalizedTextList(raw: unknown, label: string): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array.`);
  }
  const seen = new Set<string>();
  return Object.freeze(raw.map((value) => {
    const text = requireText(value, label);
    if (seen.has(text)) throw new Error(`${label} must be unique: ${text}.`);
    seen.add(text);
    return text;
  }));
}

/**
 * The stable digest of the gate contract. It deliberately excludes the
 * rollout `mode`, retention window, and documentation fields: changing the
 * rollout switch must not invalidate proven gate evidence.
 */
export function verificationPlanDigest(plan: VerificationPlan): string {
  const canonical = canonicalJson({
    id: plan.id,
    version: plan.version,
    toolchain: plan.toolchain,
    bootstrap: plan.bootstrap,
    l1: plan.l1,
    l2: plan.l2,
    ...(plan.l3 === undefined ? {} : { l3: plan.l3 })
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Resolve the runtime toolchain identity from the current process. */
export function resolveToolchain(_environment: NodeJS.ProcessEnv = process.env): ResolvedToolchain {
  return Object.freeze({
    node: process.version,
    platform: process.platform,
    arch: process.arch
  });
}

/**
 * Digest of the toolchain a gate actually ran under, bound to the plan's
 * declared requirements. A Node upgrade, platform change, or plan toolchain
 * edit changes the digest and invalidates reuse.
 */
export function toolchainDigest(plan: VerificationPlan, toolchain: ResolvedToolchain): string {
  const canonical = canonicalJson({
    constraints: plan.toolchain,
    node: toolchain.node,
    ...(toolchain.npm === undefined ? {} : { npm: toolchain.npm }),
    platform: toolchain.platform,
    arch: toolchain.arch
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Select the L1 checks for a change: every category whose path prefixes match
 * a changed path. A category with no path prefixes matches nothing (it must
 * be selected explicitly by the caller).
 */
export function selectL1Checks(
  plan: VerificationPlan,
  changedPaths: readonly string[]
): readonly VerificationStep[] {
  const selected = new Map<string, VerificationStep>();
  for (const category of plan.l1.categories) {
    if (category.paths.length === 0) continue;
    const matches = changedPaths.some((path) =>
      category.paths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    );
    if (!matches) continue;
    for (const check of category.checks) {
      if (!selected.has(check.name)) selected.set(check.name, check);
    }
  }
  return Object.freeze([...selected.values()]);
}

/** Bootstrap steps as DurableJob steps, named `bootstrap-N`. */
export function planBootstrapJobSteps(plan: VerificationPlan): readonly DurableJobStep[] {
  return plan.bootstrap.map((step, index) => toDurableJobStep(step, `bootstrap-${index + 1}`));
}

/** L2 gate steps as DurableJob steps, named `gate-N`. */
export function planL2JobSteps(plan: VerificationPlan): readonly DurableJobStep[] {
  return plan.l2.steps.map((step, index) => toDurableJobStep(step, `gate-${index + 1}`));
}

/** L1 steps as DurableJob steps, named `l1-N`. */
export function planL1JobSteps(steps: readonly VerificationStep[]): readonly DurableJobStep[] {
  return steps.map((step, index) => toDurableJobStep(step, `l1-${index + 1}`));
}

function toDurableJobStep(step: VerificationStep, name: string): DurableJobStep {
  return {
    name,
    // The shell-equivalent command stays as the human-readable fallback and
    // the coverage-matching string; argv is the executable form.
    command: step.shell === true ? step.argv.join(" ") : shellQuote(step.argv),
    argv: step.argv,
    ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
    ...(step.env === undefined ? {} : { env: step.env })
  };
}

/** The shell-equivalent of a structured step, for display and coverage. */
export function verificationStepCommand(step: VerificationStep): string {
  return step.shell === true ? step.argv.join(" ") : shellQuote(step.argv);
}

function shellQuote(argv: readonly string[]): string {
  return argv.map((value) => (/^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)).join(" ");
}

/**
 * Resolve a Project's VerificationPlan from its Yui-maintained knowledge.
 * A knowledge entry whose JSON body declares `kind: verification-plan` is
 * the plan; malformed plan bodies fail closed. Free-text knowledge entries
 * are ignored. A Project without a plan returns `undefined` (unstructured
 * explicit-check mode).
 */
export function resolveProjectVerificationPlan(project: Project): VerificationPlan | undefined {
  let found: VerificationPlan | undefined;
  for (const entry of project.knowledge) {
    if (entry.status !== "active") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.body) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null
      || (parsed as Record<string, unknown>).kind !== VERIFICATION_PLAN_KIND) {
      continue;
    }
    const plan = normalizeVerificationPlan(parsed);
    if (found !== undefined) {
      throw new Error(
        `Project ${project.id} declares multiple VerificationPlans; only one is allowed.`
      );
    }
    found = plan;
  }
  return found;
}

/** Serialize a plan for storage in a Project knowledge entry body. */
export function verificationPlanKnowledgeBody(plan: VerificationPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}
