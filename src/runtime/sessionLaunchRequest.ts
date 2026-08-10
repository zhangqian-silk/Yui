import { normalizeRuntimeOwner, type RuntimeOwner } from "./runtimeOwner.js";
import { requireSafeIdentity, requireText } from "./validation.js";
import {
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import {
  parseTaskRuntimeIsolationDescriptor,
  type TaskRuntimeIsolationDescriptor
} from "./taskRuntimeIsolation.js";

type SessionLaunchRequestBase = Readonly<{
  launchId: string;
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  effective: EffectiveLaunchSnapshot;
  workspace: string;
  runtimeIsolation?: TaskRuntimeIsolationDescriptor;
  runId?: string;
  environment?: Readonly<Record<string, string>>;
}>;

export type NewSessionLaunchRequest = SessionLaunchRequestBase & Readonly<{
  mode: "new";
}>;

export type ResumeSessionLaunchRequest = SessionLaunchRequestBase & Readonly<{
  mode: "resume";
  nativeSessionId: string;
}>;

export type SessionLaunchRequest = NewSessionLaunchRequest | ResumeSessionLaunchRequest;

export function createSessionLaunchRequest(
  input: SessionLaunchRequest
): SessionLaunchRequest {
  const agentId = requireSafeIdentity(input.agentId, "Agent id");
  const adapterId = requireSafeIdentity(input.adapterId, "Agent adapter id");
  const workspace = requireText(input.workspace, "Session workspace");
  const effective = validateEffectiveLaunchSnapshot(input.effective);
  if (effective.agentId !== agentId
    || effective.adapterId !== adapterId
    || effective.workspace.root !== workspace) {
    throw new TypeError("Session launch request does not match its effective snapshot.");
  }
  const runtimeIsolation = input.runtimeIsolation === undefined
    ? undefined
    : parseTaskRuntimeIsolationDescriptor(JSON.stringify(input.runtimeIsolation));
  if (runtimeIsolation !== undefined && (
    input.owner.scope !== "task"
    || runtimeIsolation.taskId !== input.owner.taskId
    || runtimeIsolation.workspace.root !== workspace
    || runtimeIsolation.generation.launchId !== input.launchId
    || runtimeIsolation.generation.runId !== input.runId
  )) {
    throw new TypeError(
      "Session launch request does not match its Task runtime isolation descriptor."
    );
  }
  const common = {
    launchId: requireSafeIdentity(input.launchId, "Launch id"),
    owner: normalizeRuntimeOwner(input.owner),
    agentId,
    adapterId,
    effective,
    workspace,
    ...(runtimeIsolation === undefined ? {} : { runtimeIsolation }),
    ...(input.runId === undefined
      ? {}
      : { runId: requireSafeIdentity(input.runId, "Run id") }),
    ...(input.environment === undefined
      ? {}
      : { environment: copyEnvironment(input.environment) })
  };
  if (input.mode === "new") return { mode: "new", ...common };
  if (input.mode === "resume") {
    return {
      mode: "resume",
      ...common,
      nativeSessionId: requireText(input.nativeSessionId, "Native session id")
    };
  }
  throw new Error("Session launch mode is invalid.");
}

function copyEnvironment(
  input: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof value !== "string"
      || value.includes("\0")
    ) {
      throw new TypeError("Session environment override is invalid.");
    }
    result[name] = value;
  }
  return result;
}
