import { normalizeRuntimeOwner, type RuntimeOwner } from "./runtimeOwner.js";
import { requireSafeIdentity, requireText } from "./validation.js";

type SessionLaunchRequestBase = Readonly<{
  launchId: string;
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  workspace: string;
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
    workspace: requireText(input.workspace, "Session workspace")
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
