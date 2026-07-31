export type TaskBrief = {
  schemaVersion: 2;
  objective: string;
  boundaries: string[];
  technicalApproach: string;
  currentFocus: string;
  leaderSummary: string;
  updatedAt: string;
  updatedBy: string;
};

export type TaskBriefContent = Omit<Pick<
  TaskBrief,
  | "objective"
  | "boundaries"
  | "technicalApproach"
  | "currentFocus"
  | "leaderSummary"
  | "updatedBy"
>, "technicalApproach"> & Readonly<{ technicalApproach?: string }>;

export type TaskBriefPatch = Partial<Pick<
  TaskBrief,
  "objective" | "boundaries" | "technicalApproach" | "currentFocus" | "leaderSummary"
>>;

export function createTaskBrief(input: TaskBriefContent, now: Date): TaskBrief {
  return {
    schemaVersion: 2,
    objective: requireText(input.objective, "Task objective"),
    boundaries: normalizeBoundaries(input.boundaries),
    technicalApproach: optionalText(input.technicalApproach, "Task technical approach"),
    currentFocus: requireText(input.currentFocus, "Current focus"),
    leaderSummary: requireText(input.leaderSummary, "Leader summary"),
    updatedAt: now.toISOString(),
    updatedBy: requireText(input.updatedBy, "Task Brief updated by")
  };
}

export function updateTaskBrief(
  brief: TaskBrief,
  patch: TaskBriefPatch,
  updatedBy: string,
  now: Date
): TaskBrief {
  return createTaskBrief({
    objective: patch.objective ?? brief.objective,
    boundaries: patch.boundaries ?? brief.boundaries,
    technicalApproach: patch.technicalApproach ?? brief.technicalApproach,
    currentFocus: patch.currentFocus ?? brief.currentFocus,
    leaderSummary: patch.leaderSummary ?? brief.leaderSummary,
    updatedBy
  }, now);
}

function normalizeBoundaries(values: readonly string[]): string[] {
  const normalized = values.map((value) => {
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error("Task boundary is invalid.");
    }
    return value.trim();
  }).filter(Boolean);
  return [...new Set(normalized)];
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function optionalText(value: string | undefined, label: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}
