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
  /** True only when this lifecycle request created the external Role host. */
  hostCreated?: boolean;
  /** Exact Task Run whose first prompt was submitted by process launch. */
  initialPromptRunId?: string;
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
    ...(input.hostCreated === undefined
      ? {}
      : { hostCreated: requireBoolean(input.hostCreated, "Runtime host-created flag") }),
    ...(input.initialPromptRunId === undefined
      ? {}
      : { initialPromptRunId: requireSafeIdentity(input.initialPromptRunId, "Initial prompt Run id") }),
    ...(input.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireText(input.nativeSessionId, "Native session id") })
  };
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}
