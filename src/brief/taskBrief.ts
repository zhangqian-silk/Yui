export type TaskBrief = {
  schemaVersion: 1;
  objective: string;
  boundaries: string[];
  currentFocus: string;
  leaderSummary: string;
  updatedAt: string;
  updatedBy: string;
};

export type TaskBriefContent = Pick<
  TaskBrief,
  "objective" | "boundaries" | "currentFocus" | "leaderSummary" | "updatedBy"
>;

export type TaskBriefPatch = Partial<Pick<
  TaskBrief,
  "objective" | "boundaries" | "currentFocus" | "leaderSummary"
>>;

export function createTaskBrief(input: TaskBriefContent, now: Date): TaskBrief {
  return {
    schemaVersion: 1,
    objective: requireText(input.objective, "Task objective"),
    boundaries: normalizeBoundaries(input.boundaries),
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
