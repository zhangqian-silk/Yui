import { normalizeRuntimeOwner, type RuntimeOwner } from "./runtimeOwner.js";
import { requireSafeIdentity, requireText } from "./validation.js";

export type RuntimeBinding = Readonly<{
  id: string;
  launchId: string;
  owner: RuntimeOwner;
  agentId: string;
  adapterId: string;
  /** Opaque reference interpreted only by the configured session host. */
  hostRef: string;
  nativeSessionId?: string;
}>;

export function createRuntimeBinding(input: RuntimeBinding): RuntimeBinding {
  return {
    id: requireSafeIdentity(input.id, "Runtime binding id"),
    launchId: requireSafeIdentity(input.launchId, "Launch id"),
    owner: normalizeRuntimeOwner(input.owner),
    agentId: requireSafeIdentity(input.agentId, "Agent id"),
    adapterId: requireSafeIdentity(input.adapterId, "Agent adapter id"),
    hostRef: requireText(input.hostRef, "Session host reference"),
    ...(input.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireText(input.nativeSessionId, "Native session id") })
  };
}
