import {
  cloneJson,
  normalizedUniqueText,
  optionalText,
  requireIdentity,
  requirePositiveInteger,
  requireTimestamp
} from "../domain/validation.js";

export const BUILTIN_PROFILE_IDS = Object.freeze([
  "worker",
  "explorer",
  "implementer",
  "reviewer"
] as const);

export type BuiltinProfileId = typeof BUILTIN_PROFILE_IDS[number];
export type WorkerAccess = "read" | "write";

export type AgentProfileRuntime =
  | Readonly<{ source: "global-worker" }>
  | Readonly<{
      source: "explicit";
      agentId: string;
      model?: string;
      effort?: string;
    }>;

export type AgentProfile = Readonly<{
  schemaVersion: 3;
  id: string;
  revision: number;
  defaultAccess: WorkerAccess;
  description?: string;
  instructions?: string;
  skills?: readonly string[];
  runtime: AgentProfileRuntime;
  createdAt: string;
  updatedAt: string;
}>;

export type AgentProfileInput = Readonly<{
  id: string;
  defaultAccess?: WorkerAccess;
  description?: string;
  instructions?: string;
  skills?: readonly string[];
  runtime?: AgentProfileRuntime;
}>;

export function createAgentProfile(input: AgentProfileInput, now: Date): AgentProfile {
  const timestamp = now.toISOString();
  return validateAgentProfile({
    schemaVersion: 3,
    id: requireIdentity(input.id, "Agent Profile id"),
    revision: 1,
    ...normalizeInput(input),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function updateAgentProfile(
  profile: AgentProfile,
  patch: Readonly<Partial<Omit<AgentProfileInput, "id">>>,
  now: Date
): AgentProfile {
  validateAgentProfile(profile);
  const candidate = {
    ...cloneJson(profile),
    ...normalizePatch(patch),
    revision: profile.revision + 1,
    updatedAt: now.toISOString()
  };
  for (const key of ["description", "instructions", "skills"] as const) {
    if (candidate[key] === undefined) delete candidate[key];
  }
  return validateAgentProfile(candidate);
}

export function validateAgentProfile(profile: AgentProfile): AgentProfile {
  if (profile.schemaVersion !== 3) {
    throw new Error("AgentProfile must use schemaVersion 3.");
  }
  requireIdentity(profile.id, "Agent Profile id");
  requirePositiveInteger(profile.revision, "Agent Profile revision");
  validateAccess(profile.defaultAccess);
  if (profile.description !== undefined) optionalText(profile.description, "Profile description");
  if (profile.instructions !== undefined) optionalText(profile.instructions, "Profile instructions");
  if (profile.skills !== undefined) normalizedUniqueText(profile.skills, "Profile skill");
  validateAgentProfileRuntime(profile.runtime);
  requireTimestamp(profile.createdAt, "Agent Profile createdAt");
  requireTimestamp(profile.updatedAt, "Agent Profile updatedAt");
  if (Date.parse(profile.updatedAt) < Date.parse(profile.createdAt)) {
    throw new Error("Agent Profile updatedAt cannot precede createdAt.");
  }
  return profile;
}

export function builtinAgentProfileInputs(): readonly AgentProfileInput[] {
  return [
    {
      id: "worker",
      description: "Implement and validate one bounded delegated WorkItem.",
      defaultAccess: "write",
      runtime: { source: "global-worker" }
    },
    {
      id: "explorer",
      description: "Inspect sources and return evidence without modifying them.",
      instructions: "Do not modify files or external state.",
      defaultAccess: "read",
      runtime: { source: "global-worker" }
    },
    {
      id: "implementer",
      description: "Implement and validate one bounded result.",
      defaultAccess: "write",
      runtime: { source: "global-worker" }
    },
    {
      id: "reviewer",
      description: "Review one candidate against the user's core outcome, supported behavior, and direct evidence.",
      instructions: "Start from user intent and acceptance criteria. Inspect the complete relevant change and report only reachable, material, actionable problems with direct evidence. Separate defects from verification gaps, and prefer the smallest sufficient correction. Follow the bound Project's Policy and Knowledge for build, test, migration, release, and review expectations; do not import rules from another Project or Task. For normal software delivery, review the frozen Task result as one final ReviewRound rather than inventing a per-WorkItem protocol unless the Project Policy explicitly requires one. A Task-final Round has no synthetic WorkItem anchor, and the Reviewer Session and physical workspace continue across changed-head Rounds without reusing an earlier verdict. The current Turn's frozen candidate remains the only scope even if Task main advances. For Delta Recheck, return equivalent-and-accepted, finding, or requires-full-review with explicit reasoning; never create the next Round. Do not turn speculative or extreme edge cases into new state, retries, fallbacks, or protocol. In the Review workspace you may edit source or tests, run local checks, and optionally commit diagnostic evidence. Never push, integrate, mutate Task state, touch another workspace or stable checkout, or write the real Yui control-plane home. End the Provider turn with complete findings, checks actually run, uncertainty, and bounded next actions; Yui preserves the full free-form report automatically. Expose evidence and options to the Leader, who decides.",
      defaultAccess: "write",
      runtime: { source: "global-worker" }
    }
  ];
}

function normalizeInput(input: AgentProfileInput): Omit<
AgentProfile,
"schemaVersion" | "id" | "revision" | "createdAt" | "updatedAt"
> {
  return {
    defaultAccess: validatedAccess(input.defaultAccess ?? "read"),
    ...(input.description === undefined
      ? {}
      : { description: optionalText(input.description, "Profile description") }),
    ...(input.instructions === undefined
      ? {}
      : { instructions: optionalText(input.instructions, "Profile instructions") }),
    ...(input.skills === undefined
      ? {}
      : { skills: normalizedUniqueText(input.skills, "Profile skill") }),
    runtime: normalizeRuntime(input.runtime ?? { source: "global-worker" })
  };
}

function normalizePatch(
  patch: Readonly<Partial<Omit<AgentProfileInput, "id">>>
): Partial<AgentProfile> {
  const result: Record<string, unknown> = {};
  if (Object.hasOwn(patch, "defaultAccess")) {
    result.defaultAccess = validatedAccess(patch.defaultAccess);
  }
  for (const key of ["description", "instructions"] as const) {
    if (!Object.hasOwn(patch, key)) continue;
    result[key] = patch[key] === undefined
      ? undefined
      : optionalText(patch[key], `Profile ${key}`);
  }
  if (Object.hasOwn(patch, "skills")) {
    result.skills = patch.skills === undefined
      ? undefined
      : normalizedUniqueText(patch.skills, "Profile skill");
  }
  if (Object.hasOwn(patch, "runtime")) {
    if (patch.runtime === undefined) {
      throw new Error("Agent Profile runtime is required.");
    }
    result.runtime = normalizeRuntime(patch.runtime);
  }
  return result as Partial<AgentProfile>;
}

export type AgentProfileV2 = Readonly<{
  schemaVersion: 2;
  id: string;
  revision: number;
  defaultAccess: WorkerAccess;
  description?: string;
  instructions?: string;
  skills?: readonly string[];
  model?: string;
  effort?: string;
  createdAt: string;
  updatedAt: string;
}>;

/**
 * Migrate the only supported historical Profile contract. Profiles that did
 * not carry runtime hints become Worker-inherited. A legacy model or effort
 * followed the Role Agent selected at application time, so migration freezes
 * the current Worker Agent when available, otherwise the configured default
 * Agent, instead of keeping an Agent-less provider value.
 */
export function migrateAgentProfileV2ToV3(
  profile: AgentProfileV2,
  runtimeAgent?: Readonly<{ agentId: string }>
): AgentProfile {
  validateAgentProfileV2(profile);
  const {
    model,
    effort,
    schemaVersion: _schemaVersion,
    ...base
  } = cloneJson(profile);
  const runtime: AgentProfileRuntime = model === undefined && effort === undefined
    ? { source: "global-worker" }
    : {
        source: "explicit",
        agentId: requireIdentity(
          runtimeAgent?.agentId ?? "",
          "Legacy Agent Profile runtime Agent id"
        ),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort })
      };
  return validateAgentProfile({
    ...base,
    schemaVersion: 3,
    runtime
  });
}

function validateAgentProfileV2(profile: AgentProfileV2): void {
  if (profile.schemaVersion !== 2) {
    throw new Error("Legacy AgentProfile must use schemaVersion 2.");
  }
  requireIdentity(profile.id, "Agent Profile id");
  requirePositiveInteger(profile.revision, "Agent Profile revision");
  validateAccess(profile.defaultAccess);
  if (profile.description !== undefined) optionalText(profile.description, "Profile description");
  if (profile.instructions !== undefined) optionalText(profile.instructions, "Profile instructions");
  if (profile.skills !== undefined) normalizedUniqueText(profile.skills, "Profile skill");
  if (profile.model !== undefined) optionalText(profile.model, "Profile model");
  if (profile.effort !== undefined) optionalText(profile.effort, "Profile effort");
  requireTimestamp(profile.createdAt, "Agent Profile createdAt");
  requireTimestamp(profile.updatedAt, "Agent Profile updatedAt");
  if (Date.parse(profile.updatedAt) < Date.parse(profile.createdAt)) {
    throw new Error("Agent Profile updatedAt cannot precede createdAt.");
  }
}

function normalizeRuntime(runtime: AgentProfileRuntime): AgentProfileRuntime {
  validateAgentProfileRuntime(runtime);
  return runtime.source === "global-worker"
    ? { source: "global-worker" }
    : {
        source: "explicit",
        agentId: requireIdentity(runtime.agentId, "Profile Agent id"),
        ...(runtime.model === undefined
          ? {}
          : { model: optionalText(runtime.model, "Profile model") }),
        ...(runtime.effort === undefined
          ? {}
          : { effort: optionalText(runtime.effort, "Profile effort") })
      };
}

function validateAgentProfileRuntime(runtime: AgentProfileRuntime): void {
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error("Agent Profile runtime is invalid.");
  }
  const source = (runtime as Readonly<{ source?: unknown }>).source;
  if (source === "global-worker") {
    if (Object.keys(runtime).some((key) => key !== "source")) {
      throw new Error("Worker-inherited Agent Profile runtime cannot persist Agent settings.");
    }
    return;
  }
  if (source !== "explicit") {
    throw new Error(`Agent Profile runtime source is invalid: ${String(source)}.`);
  }
  if (Object.keys(runtime).some((key) => (
    key !== "source" && key !== "agentId" && key !== "model" && key !== "effort"
  ))) {
    throw new Error("Explicit Agent Profile runtime contains unsupported fields.");
  }
  const explicit = runtime as Extract<AgentProfileRuntime, { source: "explicit" }>;
  requireIdentity(explicit.agentId, "Profile Agent id");
  if (explicit.model !== undefined) optionalText(explicit.model, "Profile model");
  if (explicit.effort !== undefined) optionalText(explicit.effort, "Profile effort");
}

function validatedAccess(value: WorkerAccess | undefined): WorkerAccess {
  if (value === undefined) throw new Error("Agent Profile default access is required.");
  validateAccess(value);
  return value;
}

function validateAccess(value: WorkerAccess): void {
  if (value !== "read" && value !== "write") {
    throw new Error(`Agent Profile default access is invalid: ${String(value)}.`);
  }
}
