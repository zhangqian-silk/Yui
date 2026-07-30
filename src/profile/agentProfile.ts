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

export type AgentProfile = Readonly<{
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

export type AgentProfileInput = Readonly<{
  id: string;
  defaultAccess?: WorkerAccess;
  description?: string;
  instructions?: string;
  skills?: readonly string[];
  model?: string;
  effort?: string;
}>;

export function createAgentProfile(input: AgentProfileInput, now: Date): AgentProfile {
  const timestamp = now.toISOString();
  return validateAgentProfile({
    schemaVersion: 2,
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
  for (const key of ["description", "instructions", "skills", "model", "effort"] as const) {
    if (candidate[key] === undefined) delete candidate[key];
  }
  return validateAgentProfile(candidate);
}

export function validateAgentProfile(profile: AgentProfile): AgentProfile {
  if (profile.schemaVersion !== 2) {
    throw new Error("AgentProfile must use schemaVersion 2.");
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
  return profile;
}

export function builtinAgentProfileInputs(): readonly AgentProfileInput[] {
  return [
    {
      id: "worker",
      description: "Complete one bounded delegated WorkItem.",
      defaultAccess: "read"
    },
    {
      id: "explorer",
      description: "Inspect sources and return evidence without modifying them.",
      instructions: "Do not modify files or external state.",
      defaultAccess: "read"
    },
    {
      id: "implementer",
      description: "Implement and validate one bounded result.",
      defaultAccess: "write"
    },
    {
      id: "reviewer",
      description: "Review behavior, evidence, and regression risk.",
      instructions: "Report actionable findings with direct evidence. Do not modify files.",
      defaultAccess: "read"
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
    ...(input.model === undefined ? {} : { model: optionalText(input.model, "Profile model") }),
    ...(input.effort === undefined ? {} : { effort: optionalText(input.effort, "Profile effort") })
  };
}

function normalizePatch(
  patch: Readonly<Partial<Omit<AgentProfileInput, "id">>>
): Partial<AgentProfile> {
  const result: Record<string, unknown> = {};
  if (Object.hasOwn(patch, "defaultAccess")) {
    result.defaultAccess = validatedAccess(patch.defaultAccess);
  }
  for (const key of ["description", "instructions", "model", "effort"] as const) {
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
  return result as Partial<AgentProfile>;
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
