export type AgentSessionStatus = "unknown" | "ready" | "running" | "stopped" | "broken";

export type AgentSession = {
  schemaVersion: 1;
  taskId: string;
  roleName: string;
  agent: string;
  nativeSessionId: string;
  policy: "fixed" | "leader-controlled";
  status: AgentSessionStatus;
  previousSessionIds: string[];
  replacementReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ExecutorCapabilities = {
  recover: boolean;
  interrupt: boolean;
  nativeSessionDiscovery: boolean;
};

export interface AgentExecutor {
  readonly id: string;
  readonly capabilities: ExecutorCapabilities;
  start(input: string): Promise<string>;
  recover(nativeSessionId: string): Promise<void>;
  send(input: string): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<AgentSessionStatus>;
  discoverNativeSessionId(): Promise<string | null>;
}

export function recordAgentSession(
  taskId: string,
  roleName: string,
  agent: string,
  nativeSessionId: string,
  now: Date,
  existing: AgentSession | null,
  replacementReason?: string
): AgentSession {
  const trimmedId = nativeSessionId.trim();
  if (trimmedId.length === 0) {
    throw new Error("Native session id is required.");
  }

  const timestamp = now.toISOString();
  const replacing = existing !== null && existing.nativeSessionId !== trimmedId;

  return {
    schemaVersion: 1,
    taskId,
    roleName,
    agent,
    nativeSessionId: trimmedId,
    policy: roleName === "leader" ? "fixed" : "leader-controlled",
    status: "ready",
    previousSessionIds: replacing
      ? [...existing.previousSessionIds, existing.nativeSessionId]
      : existing?.previousSessionIds ?? [],
    ...(replacementReason === undefined ? {} : { replacementReason: replacementReason.trim() }),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}
