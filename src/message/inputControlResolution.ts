import type { TaskStore } from "../storage/taskStore.js";
import type { GlobalRoleSessionSet, RoleSessionSet } from "../executor/agentExecutor.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import type { ProviderAuthorityFence } from "../runtime/providerAuthorityFence.js";

/** Shared application input; CLI and Web parse their own transport into this. */
export type InputControlRequest =
  | Readonly<{ action: "queue"; body: string; requestId: string;
      to?: string; workItem?: string; reviewRound?: string }>
  | Readonly<{ action: "steer"; body: string; requestId: string; expectedTarget: string;
      to: string; workItem?: string; reviewRound?: string }>
  | Readonly<{ action: "interrupt"; requestId?: string; expectedTarget: string;
      role: string; thenMessage?: string }>;

/** The minimal read a Global input-control resolution needs: a Global Role's own
 * Session set, keyed by Role name and never by a Task (decision-3 §9). Narrower
 * than {@link TaskStore} so a Global command's transaction store satisfies it
 * directly without pretending to be a Task-scoped store. */
export type GlobalRoleSessionReader = Readonly<{
  getGlobalRoleSessionSet(roleName: string): GlobalRoleSessionSet | null;
}>;

/**
 * One coherent resolution for the two live input-control actions that target an
 * exact current native Turn — steer and interrupt. decision-3 §9 requires the
 * message ref, the owner/authority fence, and the settlement target to be
 * decided together, not reconstructed independently by each CLI subcommand:
 * this module is that single connection point.
 *
 * The resolution is scope-generic. A Task Role and a Global Role read the same
 * capability flags, the same present-Turn gate, and the same authority fence
 * from their own Session set (decision-3 §6/§9); only where the set is fetched
 * and whether a taskId decorates the target differ. A Global control never
 * fabricates a taskId or runId to reuse the Task-shaped path.
 *
 * Everything here is readable synchronously from durable state at command time,
 * with no live Endpoint. That is deliberate: the capability gate, the
 * "no fabricated Turn/Run", and the "no automatic fallback" invariants are the
 * testable contract, and the actual Provider call is a separate live edge.
 */

/** Which control is being resolved; the two read different capability flags. */
export type InputControlKind = "steer" | "interrupt";

/**
 * The exact current native Turn a live control must target. It never invents a
 * Turn: it is produced only from an observed, active ProviderTurn under the
 * caller's own current Session and writer fence.
 */
export type ResolvedInputTarget = Readonly<{
  /** Present for a Task Role target; absent for a Global Role, which has no
   * owning Task and never synthesizes one (decision-3 §9). */
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  /** The current Turn's native id, when the Provider surfaced one. */
  nativeTurnId?: string;
  /** The exact local input identity of the current Turn; never a Provider id. */
  attemptId: string;
  authority: ProviderAuthorityFence;
}>;

/**
 * A resolution outcome. `ready` carries the exact fence for the live call; every
 * other variant is an explicit, visible failure (decision-3 §5/§10) and never a
 * silent downgrade to a different action.
 */
export type InputControlResolution =
  | Readonly<{ outcome: "ready"; target: ResolvedInputTarget }>
  | Readonly<{ outcome: "unsupported"; code: "STEER_UNSUPPORTED" | "INTERRUPT_UNSUPPORTED"; detail: string }>
  | Readonly<{ outcome: "no-active-turn"; code: "NO_ACTIVE_TURN"; detail: string }>
  | Readonly<{ outcome: "target-changed"; code: "TARGET_CHANGED"; detail: string }>
  | Readonly<{ outcome: "delivery-unknown"; code: "DELIVERY_UNKNOWN"; detail: string }>;

/**
 * Turn statuses that mean a Turn record is present and not yet terminal. This is
 * only "there is something here", not "it is safe to target": `submitting` is a
 * call still in flight and `delivery-unknown` is an outbound whose acceptance was
 * never proven. Both are separated from `accepted` below (decision-3 §3/§8) so an
 * unconfirmed delivery is reported as DELIVERY_UNKNOWN, never silently steered or
 * cancelled as if it were a clean active Turn.
 */
const PRESENT_TURN_STATUSES = new Set(["submitting", "accepted", "delivery-unknown"]);

/**
 * The scope-generic core. It takes an already-fetched Session set and the owner
 * decoration for a resolved target, so Task and Global callers share the exact
 * same capability, present-Turn, authority, and target-match logic.
 *
 * @param decorate Adds the owner-specific fields to a resolved target. For a
 *   Task Role it attaches the taskId; for a Global Role it attaches nothing.
 */
function resolveInputControl(
  sessions: RoleSessionSet | null,
  kind: InputControlKind,
  expectedTarget: string,
  roleName: string
): InputControlResolution {
  const active = sessions?.sessions[sessions.activeAgentId];
  // Capability is read from the declared Driver of the current active Session,
  // never hardcoded by Agent name (decision-3 §7). When there is no active
  // Session at all there is also no current Turn to target.
  if (sessions == null || active === undefined || active.status !== "active") {
    return { outcome: "no-active-turn", code: "NO_ACTIVE_TURN",
      detail: "No active native Session holds a current Turn for this Role." };
  }
  const capabilities = builtinAgentDriverRegistry().requireByAdapterId(active.adapterId).capabilities;
  if (kind === "steer" && capabilities.input.steer !== "fenced") {
    return { outcome: "unsupported", code: "STEER_UNSUPPORTED",
      detail: `Agent plan '${active.adapterId}' cannot steer its current Turn; `
        + "the input is saved for an explicit interrupt --then-message or a queue." };
  }
  if (kind === "interrupt" && capabilities.control.interruptDelivery !== "native") {
    return { outcome: "unsupported", code: "INTERRUPT_UNSUPPORTED",
      detail: `Agent plan '${active.adapterId}' has no native interrupt; Yui will not `
        + "stop the owned process, kill, restart, or detach it." };
  }
  // Both scopes use the same explicit null for an uncontrolled Session.
  const binding = sessions.providerBinding;
  const turn = binding?.run ?? null;
  if (binding === null || turn === null || !PRESENT_TURN_STATUSES.has(turn.status)) {
    return { outcome: "no-active-turn", code: "NO_ACTIVE_TURN",
      detail: "The Provider is not running a Turn now; there is nothing to steer or interrupt." };
  }
  // A human writer fence (an interactive takeover) owns the Turn; the Controller
  // must not steer or cancel across it.
  if (binding.authority.owner !== "controller") {
    return { outcome: "target-changed", code: "TARGET_CHANGED",
      detail: `Provider authority is ${binding.authority.owner}-held; release the takeover before a managed control.` };
  }
  const observedId = turn.nativeTurnId ?? turn.attemptId;
  if (expectedTarget !== observedId
    && !(turn.nativeTurnId !== undefined && expectedTarget === turn.attemptId)) {
    return { outcome: "target-changed", code: "TARGET_CHANGED",
      detail: `The current Turn is ${observedId}, not ${expectedTarget}; re-read the Session before retrying.` };
  }
  // The right Turn is confirmed; now report its own delivery state. decision-3
  // §3/§8, message-3 #7: an original Turn still in flight (`submitting`) or whose
  // acceptance was never proven (`delivery-unknown`) is not a safe target.
  // Steering it would push a second input onto an unconfirmed one; cancelling it
  // would guess a stop against an attempt that may not have landed. Report
  // DELIVERY_UNKNOWN so the caller confirms the original attempt first — never a
  // silent downgrade to another action (§10).
  if (turn.status !== "accepted") {
    return { outcome: "delivery-unknown", code: "DELIVERY_UNKNOWN",
      detail: `The current Turn's own delivery is ${turn.status}; confirm the original attempt `
        + "before steering or interrupting. Do not reissue under a new requestId or a different action." };
  }
  if (kind === "steer" && turn.nativeTurnId === undefined) {
    return { outcome: "delivery-unknown", code: "DELIVERY_UNKNOWN",
      detail: "The Provider has not supplied an exact native Turn id for steering." };
  }
  return { outcome: "ready", target: {
    roleName, agentId: active.agentId, adapterId: active.adapterId,
    nativeSessionId: active.nativeSessionId,
    ...(turn.nativeTurnId === undefined ? {} : { nativeTurnId: turn.nativeTurnId }),
    attemptId: turn.attemptId,
    authority: { epoch: binding.authority.epoch, owner: "controller",
      holderId: binding.authority.holderId! }
  } };
}

/**
 * Resolve a live steer/interrupt against a Task Role's current native Turn.
 *
 * @param expectedTarget The Leader's exact expectation for the current Turn,
 *   as observed (its nativeTurnId, or its attemptId when no native id exists).
 *   A steer/interrupt that no longer matches is TARGET_CHANGED, never retargeted.
 */
export function resolveTaskInputControl(
  store: TaskStore,
  taskId: string,
  roleName: string,
  kind: InputControlKind,
  expectedTarget: string
): InputControlResolution {
  const resolution = resolveInputControl(
    store.getTaskRoleSessionSet(taskId, roleName), kind, expectedTarget, roleName);
  // A Task target carries its taskId so the live edge addresses the exact Host.
  return resolution.outcome === "ready"
    ? { outcome: "ready", target: { taskId, ...resolution.target } }
    : resolution;
}

/**
 * Resolve a live steer/interrupt against a Global Role's current native Turn
 * (decision-3 §6/§9). Identical contract to the Task resolver, reading the
 * Global Role's own Session set; the resolved target carries no taskId because a
 * Global Role has no owning Task and never fabricates one.
 */
export function resolveGlobalInputControl(
  store: GlobalRoleSessionReader,
  roleName: string,
  kind: InputControlKind,
  expectedTarget: string
): InputControlResolution {
  return resolveInputControl(
    store.getGlobalRoleSessionSet(roleName), kind, expectedTarget, roleName);
}
