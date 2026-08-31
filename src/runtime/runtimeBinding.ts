import { normalizeRuntimeOwner, type RuntimeOwner } from "./runtimeOwner.js";
import { requireSafeIdentity, requireText } from "./validation.js";
import {
  validateProviderAuthorityFence,
  type ProviderAuthorityFence
} from "./providerAuthorityFence.js";

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
  nativeSessionId?: string;
  /** Exact durable single-writer fence used by structured Provider mutation. */
  providerAuthority?: ProviderAuthorityFence;
}>;

export function createRuntimeBinding(input: RuntimeBinding): RuntimeBinding {
  const hostCreated = input.hostCreated === undefined
    ? undefined
    : requireBoolean(input.hostCreated, "Runtime host-created flag");
  return {
    id: requireSafeIdentity(input.id, "Runtime binding id"),
    launchId: requireSafeIdentity(input.launchId, "Launch id"),
    owner: normalizeRuntimeOwner(input.owner),
    agentId: requireSafeIdentity(input.agentId, "Agent id"),
    adapterId: requireSafeIdentity(input.adapterId, "Agent adapter id"),
    hostRef: requireText(input.hostRef, "Session host reference"),
    ...(hostCreated === undefined ? {} : { hostCreated }),
    ...(input.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireText(input.nativeSessionId, "Native session id") }),
    ...(input.providerAuthority === undefined
      ? {}
      : { providerAuthority: validateProviderAuthorityFence(input.providerAuthority) })
  };
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}
