import { normalizeRuntimeOwner, type RuntimeOwner } from "./runtimeOwner.js";
import { requireSafeIdentity, requireText } from "./validation.js";

type SessionLaunchRequestBase = Readonly<{
  launchId: string;
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  workspace: string;
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
  const common = {
    launchId: requireSafeIdentity(input.launchId, "Launch id"),
    owner: normalizeRuntimeOwner(input.owner),
    agentId: requireSafeIdentity(input.agentId, "Agent id"),
    adapterId: requireSafeIdentity(input.adapterId, "Agent adapter id"),
    workspace: requireText(input.workspace, "Session workspace"),
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
