import type { Project } from "../../repository/project.js";

/** Frozen pre-33 plan reader. Only migrations may interpret missing versions
 * and rollout modes; current execution must never import this module. */
export type HistoricalVerificationStep = Readonly<{
  name: string; argv: readonly string[]; cwd?: string;
  env?: Readonly<Record<string, string>>; shell?: boolean;
}>;
type Category = Readonly<{ id: string; paths: readonly string[]; checks: readonly HistoricalVerificationStep[] }>;
export type HistoricalVerificationPlan = Readonly<{
  schemaVersion: 1; kind: "verification-plan"; id: string; version: string;
  mode: "record" | "reuse" | "enforce";
  toolchain: Readonly<{ node?: string; npm?: string; platform?: string }>;
  bootstrap: readonly HistoricalVerificationStep[];
  l1: Readonly<{ categories: readonly Category[] }>;
  l2: Readonly<{ steps: readonly HistoricalVerificationStep[] }>;
  l3?: Readonly<{ steps: readonly HistoricalVerificationStep[] }>;
  excludedRealResourceChecks?: readonly string[];
  artifactTtlDays?: number;
}>;

export function readHistoricalVerificationPlan(raw: unknown): HistoricalVerificationPlan {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("VerificationPlan must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== "verification-plan") throw new Error('VerificationPlan kind must be "verification-plan".');
  if ((record.schemaVersion ?? 1) !== 1) throw new Error("VerificationPlan schemaVersion must be 1.");
  const mode = record.mode ?? "record";
  if (mode !== "record" && mode !== "reuse" && mode !== "enforce") {
    throw new Error(`VerificationPlan mode is invalid: ${String(mode)}.`);
  }
  const plan: HistoricalVerificationPlan = {
    schemaVersion: 1, kind: "verification-plan",
    id: identity(record.id, "VerificationPlan id"),
    version: text(record.version, "VerificationPlan version"),
    mode,
    toolchain: toolchain(record.toolchain),
    bootstrap: steps(record.bootstrap, "bootstrap"),
    l1: { categories: categories(record.l1) },
    l2: { steps: steps((record.l2 as Record<string, unknown> | undefined)?.steps, "l2") },
    ...(record.l3 === undefined ? {} : {
      l3: { steps: steps((record.l3 as Record<string, unknown> | undefined)?.steps, "l3") }
    }),
    ...(record.excludedRealResourceChecks === undefined ? {} : {
      excludedRealResourceChecks: textList(record.excludedRealResourceChecks, "VerificationPlan excludedRealResourceChecks")
    }),
    ...(record.artifactTtlDays === undefined ? {} : {
      artifactTtlDays: positive(Number(record.artifactTtlDays), "VerificationPlan artifactTtlDays")
    })
  };
  if (plan.l2.steps.length === 0) throw new Error("VerificationPlan l2 requires at least one step.");
  return plan;
}

export function resolveHistoricalVerificationPlan(project: Pick<Project, "id" | "knowledge">): HistoricalVerificationPlan | undefined {
  let found: HistoricalVerificationPlan | undefined;
  for (const entry of project.knowledge) {
    if (entry.status !== "active") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(entry.body); } catch { continue; }
    if (typeof parsed !== "object" || parsed === null
      || (parsed as Record<string, unknown>).kind !== "verification-plan") continue;
    const plan = readHistoricalVerificationPlan(parsed);
    if (found !== undefined) throw new Error(`Project ${project.id} declares multiple VerificationPlans; only one is allowed.`);
    found = plan;
  }
  return found;
}

function toolchain(raw: unknown): HistoricalVerificationPlan["toolchain"] {
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("VerificationPlan toolchain must be an object.");
  const record = raw as Record<string, unknown>;
  return {
    ...(record.node === undefined ? {} : { node: text(record.node, "VerificationPlan toolchain node") }),
    ...(record.npm === undefined ? {} : { npm: text(record.npm, "VerificationPlan toolchain npm") }),
    ...(record.platform === undefined ? {} : { platform: text(record.platform, "VerificationPlan toolchain platform") })
  };
}

function steps(raw: unknown, label: string): readonly HistoricalVerificationStep[] {
  if (!Array.isArray(raw)) throw new Error(`VerificationPlan ${label} steps must be an array.`);
  const names = new Set<string>();
  return Object.freeze(raw.map(entry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`VerificationPlan ${label} step must be an object.`);
    const record = entry as Record<string, unknown>;
    const name = identity(record.name, `VerificationPlan ${label} step name`);
    if (names.has(name)) throw new Error(`VerificationPlan ${label} step names must be unique: ${name}.`);
    names.add(name);
    if (!Array.isArray(record.argv) || record.argv.length === 0) {
      throw new Error(`VerificationPlan ${label} step ${name} requires a non-empty argv.`);
    }
    const step: HistoricalVerificationStep = {
      name, argv: Object.freeze(record.argv.map(value => text(value, `VerificationPlan ${label} step ${name} argv`))),
      ...(record.cwd === undefined ? {} : { cwd: text(record.cwd, `VerificationPlan ${label} step ${name} cwd`) }),
      ...(record.env === undefined ? {} : { env: stepEnv(record.env, `${label} step ${name}`) }),
      ...(record.shell === undefined ? {} : { shell: record.shell === true })
    };
    if (step.cwd?.startsWith("/")) throw new Error(`VerificationPlan ${label} step ${name} cwd must be workspace-relative.`);
    return step;
  }));
}

function stepEnv(raw: unknown, label: string): Readonly<Record<string, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`VerificationPlan ${label} env must be a map.`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error(`VerificationPlan ${label} env values must be strings: ${key}.`);
    env[identity(key, `VerificationPlan ${label} env key`)] = value;
  }
  return Object.freeze(env);
}

function categories(raw: unknown): readonly Category[] {
  if (raw === undefined) return Object.freeze([]);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("VerificationPlan l1 must be an object.");
  const values = (raw as Record<string, unknown>).categories;
  if (!Array.isArray(values)) throw new Error("VerificationPlan l1 categories must be an array.");
  const ids = new Set<string>();
  return Object.freeze(values.map(entry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("VerificationPlan l1 category must be an object.");
    const record = entry as Record<string, unknown>;
    const id = identity(record.id, "VerificationPlan l1 category id");
    if (ids.has(id)) throw new Error(`VerificationPlan l1 category ids must be unique: ${id}.`);
    ids.add(id);
    return Object.freeze({
      id, paths: textList(record.paths, `VerificationPlan l1 category ${id} paths`),
      checks: steps(record.checks, `l1 ${id}`)
    });
  }));
}

function textList(raw: unknown, label: string): readonly string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array.`);
  const seen = new Set<string>();
  return Object.freeze(raw.map(value => {
    const next = text(value, label);
    if (seen.has(next)) throw new Error(`${label} must be unique: ${next}.`);
    seen.add(next);
    return next;
  }));
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
function identity(value: unknown, label: string): string {
  const normalized = text(value, label);
  if ([".", "..", "__proto__", "prototype", "constructor"].includes(normalized) || /[\/\\\0]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}
