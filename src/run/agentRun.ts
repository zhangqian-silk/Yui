export type DispatchMode = "new" | "resume";
export type AgentRunStatus = "active" | "yielded" | "failed" | "expired";

export type AgentRun = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  roleName: string;
  mode: DispatchMode;
  input: string;
  workItemId?: string;
  topics?: string[];
  status: AgentRunStatus;
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
  context: { workItemId?: string; topics?: readonly string[] } = {}
): AgentRun {
  if (mode !== "new" && mode !== "resume") {
    throw new Error(`Agent run dispatch mode is invalid: ${mode}.`);
  }
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    id: requireSafeIdentity(id, "Agent run id"),
    taskId: requireSafeIdentity(taskId, "Task id"),
    roleName: requireSafeIdentity(roleName, "Role name"),
    mode,
    input: requireText(input, "Agent run input"),
    ...(context.workItemId === undefined
      ? {}
      : { workItemId: requireSafeIdentity(context.workItemId, "Work item id") }),
    ...(context.topics === undefined ? {} : { topics: uniqueStrings(context.topics) }),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function isActiveAgentRun(run: AgentRun): boolean {
  return run.status === "active";
}

export function yieldAgentRun(run: AgentRun, summary: string, now: Date): AgentRun {
  return finishAgentRun(run, "yielded", requireText(summary, "Agent run summary"), now);
}

export function failAgentRun(run: AgentRun, summary: string, now: Date): AgentRun {
  return finishAgentRun(run, "failed", requireText(summary, "Agent run summary"), now);
}

export function expireAgentRun(run: AgentRun, now: Date): AgentRun {
  return finishAgentRun(
    run,
    "expired",
    "Controller inferred that the run is idle after its execution TTL elapsed.",
    now
  );
}

function finishAgentRun(
  run: AgentRun,
  status: Exclude<AgentRunStatus, "active">,
  summary: string,
  now: Date
): AgentRun {
  if (run.status !== "active") {
    throw new Error(`Agent run is already terminal: ${run.id}.`);
  }
  const timestamp = now.toISOString();
  return {
    ...run,
    status,
    summary,
    updatedAt: timestamp,
    endedAt: timestamp
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => requireText(value, "Agent run topic")))];
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
