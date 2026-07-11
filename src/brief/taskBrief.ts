export type TaskBrief = {
  objective: string;
  boundaries: string[];
  currentFocus: string;
  leaderSummary: string;
  updatedAt: string;
};

export function createTaskBrief(
  input: Omit<TaskBrief, "updatedAt">,
  now: Date
): TaskBrief {
  return {
    objective: required(input.objective, "Task objective"),
    boundaries: input.boundaries.map((item) => item.trim()).filter(Boolean),
    currentFocus: required(input.currentFocus, "Current focus"),
    leaderSummary: required(input.leaderSummary, "Leader summary"),
    updatedAt: now.toISOString()
  };
}

export function renderTaskBrief(brief: TaskBrief): string {
  const boundaries = brief.boundaries.length === 0
    ? "- None recorded"
    : brief.boundaries.map((boundary) => `- ${boundary}`).join("\n");

  return [
    "# Task Brief",
    "",
    "## Objective",
    "",
    brief.objective,
    "",
    "## Boundaries",
    "",
    boundaries,
    "",
    "## Current focus",
    "",
    brief.currentFocus,
    "",
    "## Leader summary",
    "",
    brief.leaderSummary,
    "",
    `Updated: ${brief.updatedAt}`,
    ""
  ].join("\n");
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}
