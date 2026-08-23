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
  /** Exact Task Run whose first structured Turn was acknowledged during launch. */
  initialTurnRunId?: string;
  /** Exact Task Run whose first structured Turn may have reached the Provider. */
  initialTurnDeliveryUnknownRunId?: string;
  /** Exact Task Run whose first structured Turn received a definitive negative acknowledgement. */
  initialTurnRejectedRunId?: string;
  nativeSessionId?: string;
  /** Exact durable single-writer fence used by structured Provider mutation. */
  providerAuthority?: ProviderAuthorityFence;
}>;

export function createRuntimeBinding(input: RuntimeBinding): RuntimeBinding {
  const hostCreated = input.hostCreated === undefined
    ? undefined
    : requireBoolean(input.hostCreated, "Runtime host-created flag");
  const initialTurnRunId = input.initialTurnRunId === undefined
    ? undefined
    : requireSafeIdentity(input.initialTurnRunId, "Initial Turn Run id");
  const initialTurnDeliveryUnknownRunId = input.initialTurnDeliveryUnknownRunId === undefined
    ? undefined
    : requireSafeIdentity(
        input.initialTurnDeliveryUnknownRunId,
        "Delivery-unknown initial Turn Run id"
      );
  const initialTurnRejectedRunId = input.initialTurnRejectedRunId === undefined
    ? undefined
    : requireSafeIdentity(input.initialTurnRejectedRunId, "Rejected initial Turn Run id");
  if ([initialTurnRunId, initialTurnDeliveryUnknownRunId, initialTurnRejectedRunId]
    .filter((value) => value !== undefined).length > 1) {
    throw new TypeError("Runtime binding must report at most one initial Turn outcome.");
  }
  return {
    id: requireSafeIdentity(input.id, "Runtime binding id"),
    launchId: requireSafeIdentity(input.launchId, "Launch id"),
    owner: normalizeRuntimeOwner(input.owner),
    agentId: requireSafeIdentity(input.agentId, "Agent id"),
    adapterId: requireSafeIdentity(input.adapterId, "Agent adapter id"),
    hostRef: requireText(input.hostRef, "Session host reference"),
    ...(hostCreated === undefined ? {} : { hostCreated }),
    ...(initialTurnRunId === undefined ? {} : { initialTurnRunId }),
    ...(initialTurnDeliveryUnknownRunId === undefined
      ? {}
      : { initialTurnDeliveryUnknownRunId }),
    ...(initialTurnRejectedRunId === undefined ? {} : { initialTurnRejectedRunId }),
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
