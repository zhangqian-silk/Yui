export type Milestone = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  title: string;
  summary: string;
  topics: string[];
  createdBy: "leader";
  createdAt: string;
};

export function createMilestone(
  id: string,
  taskId: string,
  title: string,
  summary: string,
  topics: string[],
  now: Date
): Milestone {
  const trimmedTitle = title.trim();
  const trimmedSummary = summary.trim();
  if (trimmedTitle.length === 0 || trimmedSummary.length === 0) {
    throw new Error("Milestone title and summary are required.");
  }

  return {
    schemaVersion: 1,
    id,
    taskId,
    title: trimmedTitle,
    summary: trimmedSummary,
    topics: [...new Set(topics)],
    createdBy: "leader",
    createdAt: now.toISOString()
  };
}

export function renderMilestoneTimelineEntry(milestone: Milestone): string {
  const topics = milestone.topics.length === 0 ? "" : ` [${milestone.topics.join(", ")}]`;
  return `## ${milestone.createdAt} — ${milestone.title}${topics}\n\n${milestone.summary}\n\n`;
}
