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
  /** Exact Task Run whose prompt was submitted by the newly-created host. */
  initialPromptRunId?: string;
  /** Controller-derived recovery fence for a reused launch-submitted host. */
  launchPromptUncertainRunId?: string;
  nativeSessionId?: string;
}>;

export function createRuntimeBinding(input: RuntimeBinding): RuntimeBinding {
  const hostCreated = input.hostCreated === undefined
    ? undefined
    : requireBoolean(input.hostCreated, "Runtime host-created flag");
  const initialPromptRunId = input.initialPromptRunId === undefined
    ? undefined
    : requireSafeIdentity(input.initialPromptRunId, "Initial prompt Run id");
  if (initialPromptRunId !== undefined && hostCreated !== true) {
    throw new TypeError(
      "An initial prompt Run id requires a newly-created runtime host."
    );
  }
  const launchPromptUncertainRunId = input.launchPromptUncertainRunId === undefined
    ? undefined
    : requireSafeIdentity(input.launchPromptUncertainRunId, "Uncertain launch prompt Run id");
  return {
    id: requireSafeIdentity(input.id, "Runtime binding id"),
    launchId: requireSafeIdentity(input.launchId, "Launch id"),
    owner: normalizeRuntimeOwner(input.owner),
    agentId: requireSafeIdentity(input.agentId, "Agent id"),
    adapterId: requireSafeIdentity(input.adapterId, "Agent adapter id"),
    hostRef: requireText(input.hostRef, "Session host reference"),
    ...(hostCreated === undefined ? {} : { hostCreated }),
    ...(initialPromptRunId === undefined ? {} : { initialPromptRunId }),
    ...(launchPromptUncertainRunId === undefined
      ? {}
      : { launchPromptUncertainRunId }),
    ...(input.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireText(input.nativeSessionId, "Native session id") })
  };
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}
