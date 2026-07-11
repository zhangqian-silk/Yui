import type { DispatchMode } from "../executor/launchPlan.js";

export type AgentRun = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  roleName: string;
  mode: DispatchMode;
  input: string;
  status: "active" | "yielded" | "failed" | "expired";
  summary?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export function createAgentRun(
  id: string,
  taskId: string,
  roleName: string,
  mode: DispatchMode,
  input: string,
  now: Date
): AgentRun {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    id,
    taskId,
    roleName,
    mode,
    input,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function yieldAgentRun(run: AgentRun, summary: string, now: Date): AgentRun {
  const trimmedSummary = summary.trim();
  if (trimmedSummary.length === 0) {
    throw new Error("Agent run summary is required.");
  }

  const timestamp = now.toISOString();
  return {
    ...run,
    status: "yielded",
    summary: trimmedSummary,
    updatedAt: timestamp,
    endedAt: timestamp
  };
}
