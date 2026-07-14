export type TaskManualSessionRegistration = {
  scope: "task";
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  agentDefinitionUpdatedAt: string;
  sessionRoot: string;
};

export type GlobalManualSessionRegistration = {
  scope: "global";
  roleName: string;
  agentId: string;
  adapterId: string;
  agentDefinitionUpdatedAt: string;
  sessionRoot: string;
};

export type ManualSessionRegistration =
  | TaskManualSessionRegistration
  | GlobalManualSessionRegistration;
