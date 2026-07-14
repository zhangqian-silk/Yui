import type { DispatchMode } from "../executor/launchPlan.js";

export type AgentRun = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  roleName: string;
  mode: DispatchMode;
  input: string;
  workItemId?: string;
  topics?: string[];
  status: "active" | "blocked" | "yielded" | "failed" | "expired";
  blockedBy?: {
    type: "input-request";
    requestId: string;
    blockedAt: string;
  };
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
  now: Date,
  context: { workItemId?: string; topics?: string[] } = {}
): AgentRun {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    id,
    taskId,
    roleName,
    mode,
    input,
    ...(context.workItemId === undefined ? {} : { workItemId: context.workItemId }),
    ...(context.topics === undefined ? {} : { topics: [...new Set(context.topics)] }),
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
    blockedBy: undefined,
    updatedAt: timestamp,
    endedAt: timestamp
  };
}

export function expireAgentRun(run: AgentRun, now: Date): AgentRun {
  const timestamp = now.toISOString();
  return {
    ...run,
    status: "expired",
    summary: "Controller inferred that the run is idle after its execution TTL elapsed.",
    blockedBy: undefined,
    updatedAt: timestamp,
    endedAt: timestamp
  };
}

export function failAgentRun(run: AgentRun, summary: string, now: Date): AgentRun {
  const timestamp = now.toISOString();
  return {
    ...run,
    status: "failed",
    summary,
    blockedBy: undefined,
    updatedAt: timestamp,
    endedAt: timestamp
  };
}

export function blockAgentRunForInput(
  run: AgentRun,
  requestId: string,
  now: Date
): AgentRun {
  if (run.status !== "active") {
    throw new Error(`Agent run ${run.id} is not active.`);
  }
  const trimmedRequestId = requestId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmedRequestId)) {
    throw new Error("Input request id is invalid.");
  }
  const timestamp = now.toISOString();
  if (timestamp < run.createdAt) {
    throw new Error(`Agent run ${run.id} block cannot predate run creation.`);
  }
  return {
    ...run,
    status: "blocked",
    blockedBy: {
      type: "input-request",
      requestId: trimmedRequestId,
      blockedAt: timestamp
    },
    updatedAt: timestamp
  };
}

export function resumeBlockedAgentRun(
  run: AgentRun,
  requestId: string,
  now: Date
): AgentRun {
  if (
    run.status !== "blocked" ||
    run.blockedBy?.type !== "input-request" ||
    run.blockedBy.requestId !== requestId
  ) {
    throw new Error(`Agent run ${run.id} is not blocked on input request ${requestId}.`);
  }
  const timestamp = now.toISOString();
  if (timestamp < run.updatedAt) {
    throw new Error(`Agent run ${run.id} resume cannot predate its blocked state.`);
  }
  const { blockedBy: _blockedBy, ...rest } = run;
  return {
    ...rest,
    status: "active",
    updatedAt: timestamp
  };
}
