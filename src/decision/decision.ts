export type Decision = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  title: string;
  rationale: string;
  topics: string[];
  status: "active" | "superseded";
  supersededReason?: string;
  createdAt: string;
  updatedAt: string;
};

export function createDecision(
  id: string,
  taskId: string,
  title: string,
  rationale: string,
  topics: string[],
  now: Date
): Decision {
  const trimmedTitle = title.trim();
  const trimmedRationale = rationale.trim();
  if (trimmedTitle.length === 0 || trimmedRationale.length === 0) {
    throw new Error("Decision title and rationale are required.");
  }
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    id,
    taskId,
    title: trimmedTitle,
    rationale: trimmedRationale,
    topics: [...new Set(topics)],
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function supersedeDecision(decision: Decision, reason: string, now: Date): Decision {
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0) {
    throw new Error("Decision supersede reason is required.");
  }
  return {
    ...decision,
    status: "superseded",
    supersededReason: trimmedReason,
    updatedAt: now.toISOString()
  };
}

export function renderDecisionTimelineEntry(decision: Decision): string {
  const topics = decision.topics.length === 0 ? "" : ` [${decision.topics.join(", ")}]`;
  return `## ${decision.createdAt} — Decision: ${decision.title}${topics}\n\n${decision.rationale}\n\n`;
}
