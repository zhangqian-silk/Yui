import type { EnvironmentPlan } from "../resources/projectResourceService.js";
import type { TaskEvent } from "../event/taskEvent.js";
import { SYSTEM_LEADER_ROLE } from "../role/systemRoles.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TaskActivationRequest } from "./taskActivation.js";
import type { Task } from "./task.js";
import type { TaskSubmissionIntent } from "../message/message.js";

/**
 * Requirement A phase and routing derivation (task-32 §2.1, §2.2).
 *
 * `Task.status` stays the only lifecycle statement. "Entered planning" is a
 * derived fact, never a writable second state: this module reads it from the
 * durable evidence a legitimate planning entry leaves behind, so idleness, a
 * failed or replaced Session, a Controller restart, or a trimmed Context can
 * never reset it to "not planned".
 */

/**
 * The never-compacted event that records a Draft was routed into planning by an
 * accepted user/operator submission, inside the same transaction that saved the
 * message. It is one of the three independent derivation sources below, and the
 * only one the shared submission service itself writes; the others are produced
 * by the planning Run and its Session. Migration appends the same event for
 * legitimate historical discussions so a post-upgrade develop cannot snatch a
 * mid-discussion Draft into auto-activation.
 */
export const TASK_PLANNING_ENTERED_EVENT = "task.planning-entered";

/**
 * Whether this Draft has already entered planning (task-32 §2.2).
 *
 * Derived — never a stored flag — from any of three independent, monotonic
 * sources, each of which only ever comes into existence and never legitimately
 * disappears:
 *
 *  (a) a persisted planning-entered event, written in the message-save
 *      transaction the first time an accepted submission routed to planning;
 *  (b) a Leader planning AgentRun in history (the first-discuss Run, once the
 *      Controller has created it);
 *  (c) a Leader Session whose frozen launch carried planning authority.
 *
 * A role being configured, a non-empty body, or a non-empty Brief are
 * deliberately NOT evidence: none of them proves the user's submission was ever
 * accepted and routed. Only a Draft can be "in planning"; an active or terminal
 * Task is past the question and answers false.
 */
export function draftHasEnteredPlanning(store: PlanningEvidenceReader, task: Task): boolean {
  if (task.status !== "draft") return false;
  return hasPlanningEnteredEvent(store.listEvents(task.id))
    || hasLeaderPlanningRun(store, task.id)
    || hasLeaderPlanningSession(store, task.id);
}

export type PlanningEvidenceReader = Pick<
  TaskStore,
  "listEvents" | "listRuns" | "getTaskRoleSessionSet"
>;

function hasPlanningEnteredEvent(events: readonly TaskEvent[]): boolean {
  return events.some((event) => event.type === TASK_PLANNING_ENTERED_EVENT);
}

function hasLeaderPlanningRun(
  store: Pick<TaskStore, "listRuns">,
  taskId: string
): boolean {
  return store.listRuns(taskId).some(
    (run) => run.roleName === SYSTEM_LEADER_ROLE && run.purpose === "planning"
  );
}

function hasLeaderPlanningSession(
  store: Pick<TaskStore, "getTaskRoleSessionSet">,
  taskId: string
): boolean {
  const sessions = store.getTaskRoleSessionSet(taskId, SYSTEM_LEADER_ROLE);
  if (sessions === null) return false;
  const candidates = [
    ...Object.values(sessions.sessions ?? {}),
    ...(sessions.history ?? [])
  ];
  return candidates.some(
    (session) => session.effective.executionAuthority === "planning"
  );
}

/**
 * The activation state that decides how a submission routes (task-32 §2.1).
 *
 * `none` covers both "never requested" and a request that settled without
 * leaving an active obligation, so a fresh submission is routed as if unplanned
 * unless a planning entry says otherwise.
 */
export type DraftActivationState = "none" | "pending" | "failed" | "adopted";

export function draftActivationState(request: TaskActivationRequest | undefined): DraftActivationState {
  if (request === undefined) return "none";
  switch (request.disposition) {
    case "pending": return "pending";
    case "failed": return "failed";
    case "adopted": return "adopted";
    case "cancelled": return "none";
    default: return "none";
  }
}

/**
 * The decision the shared submission service reaches for one submission, after
 * saving the message and re-reading the latest phase and activation in the same
 * transaction (task-32 §2.1). It names exactly what the transaction must do
 * next; it never merges outcomes into a single "started".
 */
export type SubmissionRouting =
  /** Save only. No Leader wake, no planning, no activation. */
  | Readonly<{ kind: "record" }>
  /** Save and record the first planning entry; the Leader is queued to plan. */
  | Readonly<{ kind: "enter-planning" }>
  /** Save and wake the Leader to continue an existing planning conversation. */
  | Readonly<{ kind: "continue-planning" }>
  /** Save only; already planned, so develop cannot auto-activate. Tell the user
   *  to activate explicitly. */
  | Readonly<{ kind: "planned-needs-manual-activation" }>
  /** Save and record a develop activation request, then queue only activation. */
  | Readonly<{ kind: "activate"; environmentPlan: EnvironmentPlan }>
  /** Save only; develop wanted to activate but the execution gate is stopped, so
   *  no activation is recorded. Tell the user to start execution first. */
  | Readonly<{ kind: "activation-blocked-execution-stopped" }>
  /** Save as a post-activation input; do not start a second planning entry. */
  | Readonly<{ kind: "await-activation"; state: "pending" | "failed" }>
  /** Save as delivery context on an already-active Task; do not re-activate. */
  | Readonly<{ kind: "active-context" }>;

/**
 * Decide how a user/operator submission routes, given its normalized intent and
 * the phase/activation facts read inside the save transaction.
 *
 * This is a pure decision over already-read facts, kept separate from the
 * transaction that saves the message and enqueues work so it can be unit-tested
 * exhaustively against the §2.1 table without a Store. The winner of a race is
 * decided by which submission's transaction commits first: the second one reads
 * the phase/activation the first one already wrote and routes accordingly.
 *
 * `executionEnabled` is the Task's own gate, read in the same transaction. It
 * only ever gates a *fresh* develop activation: recording an activation request
 * against a stopped Draft is refused at the activation boundary, so routing that
 * case to `activate` would abort the whole transaction and lose the saved
 * message. Planning and already-open activation obligations are unaffected — the
 * gate is enforced later at dispatch, exactly as it is for a plain message.
 */
export function decideSubmissionRouting(
  input: Readonly<{
    intent: TaskSubmissionIntent;
    status: Task["status"];
    enteredPlanning: boolean;
    activation: DraftActivationState;
    executionEnabled: boolean;
    developEnvironmentPlan: EnvironmentPlan;
  }>
): SubmissionRouting {
  // record never wakes anything, in any state (§2.1 first column).
  if (input.intent === "record") return { kind: "record" };

  if (input.status === "active") {
    // Neither discuss nor develop re-activates or downgrades an active Task.
    return { kind: "active-context" };
  }

  // Only Draft remains: terminal statuses are refused before routing (§2.1 last
  // row) by the caller's assertTaskOpen, so this function is never asked about
  // them.
  if (input.activation === "pending") {
    return input.intent === "develop"
      // A compatible pending request already exists; reference it, never a
      // second request (§2.3 "重复 develop 不产生第二个兼容激活请求").
      ? { kind: "await-activation", state: "pending" }
      // discuss becomes post-activation input; it does not start new planning.
      : { kind: "await-activation", state: "pending" };
  }
  if (input.activation === "failed") {
    // develop never auto-retries or downgrades to planning; discuss reports the
    // original failure and the explicit retry/cancel next step. Both save only.
    return { kind: "await-activation", state: "failed" };
  }

  if (input.intent === "develop") {
    // develop on an already-planned Draft never auto-activates — it needs
    // explicit manual activation. On an unplanned Draft with no open activation
    // it records the request and routes to activation, unless execution is
    // stopped: then the message is saved but no activation is recorded.
    if (input.enteredPlanning) return { kind: "planned-needs-manual-activation" };
    return input.executionEnabled
      ? { kind: "activate", environmentPlan: input.developEnvironmentPlan }
      : { kind: "activation-blocked-execution-stopped" };
  }

  // discuss (the default): first discussion records the planning entry; later
  // discussion continues the existing planning conversation.
  return input.enteredPlanning
    ? { kind: "continue-planning" }
    : { kind: "enter-planning" };
}

/**
 * Normalize a possibly-absent submission intent to its effective value.
 *
 * The current default is `discuss`. Body text is never inspected.
 */
export function normalizeSubmissionIntent(
  intent: TaskSubmissionIntent | undefined
): TaskSubmissionIntent {
  return intent ?? "discuss";
}

/**
 * The feedback a submission reports, with every task-32 §2.5 facet kept as its
 * own field so a surface can render each separately and none is ever collapsed
 * into a single "started"/"已开始".
 *
 * The facets are, in order: (1) the message was saved; (2) the Task's own
 * lifecycle phase, read in the save transaction and never downgraded; (3) what
 * happened to planning; (4) the activation obligation this submission left or
 * referenced; (5) whether the Leader was queued to act on this message now; and
 * (6) the exact next step the user must take, when one is required.
 */
export type SubmissionFeedback = Readonly<{
  saved: Readonly<{ taskId: string; messageId: string }>;
  phase: "active" | "draft-planning" | "draft-unplanned";
  planning: "none" | "entered" | "continued";
  activation: "none" | "requested" | "pending" | "failed" | "manual-required" | "execution-stopped";
  delivery: "none" | "queued";
  nextStep?: SubmissionNextStep;
}>;

/**
 * The single concrete action a submission asks the user to take next, when the
 * routing cannot proceed on its own. Each carries the exact reference the user
 * needs (task-32 §2.5 "精确阻塞引用 + 下一步"), never a vague prompt.
 */
export type SubmissionNextStep =
  /** develop reached an already-planned Draft: activation is manual (§2.1). */
  | Readonly<{ kind: "activate-manually"; taskId: string }>
  /** develop wanted to activate but execution is stopped; start it first. */
  | Readonly<{ kind: "start-execution"; taskId: string }>
  /** A compatible activation is already pending; this input waits for it. */
  | Readonly<{ kind: "await-pending-activation"; activationRef: string }>
  /** The prior activation failed; retry with a new request or cancel (§2.1). */
  | Readonly<{ kind: "resolve-failed-activation"; activationRef: string; failure: string }>;

/**
 * What the first input under a submission key was aimed at (task-32 §2.3).
 *
 * The key is bound to this target, so a later retry under the same key replays
 * only when it aims at the same target: a task-less create-new-Task retry finds
 * the Task the original created, while a key first used on an existing Task and
 * then reused to create a new one is a different target and conflicts. `create`
 * is a distinct target kind even after it resolves to a Task, so addressing that
 * resolved Task by id under the same key is still a different target.
 */
export type SubmissionTarget =
  | Readonly<{ kind: "task"; taskId: string }>
  | Readonly<{ kind: "create" }>;

/**
 * The durable receipt a keyed submission leaves, so a retry reproduces its
 * original outcome without recomputing from current state (task-32 §2.3).
 *
 * This is the minimal persistent fact §2.3 authorizes: the disposition the
 * submission actually received (`routing`, the effect) and the §2.5 feedback it
 * actually returned (`feedback`, the receipt), frozen at decision time and read
 * back verbatim on replay. Recomputing routing from the Task's *current* phase
 * or activation would fabricate a receipt for an effect that never happened (an
 * enabled gate or a cancelled request after the fact), so replay never calls
 * {@link decideSubmissionRouting} again. `target` binds the key to its first
 * input so the create-vs-existing scope is unambiguous.
 */
export type SubmissionReceipt = Readonly<{
  target: SubmissionTarget;
  routing: SubmissionRouting;
  feedback: SubmissionFeedback;
}>;

/**
 * Whether a retry aims at the same target the key was first bound to (§2.3). An
 * absent prior target (a keyed Message from before receipts existed) never
 * matches, so such a Message is treated as a conflict rather than replayed from
 * a fabricated disposition.
 */
export function sameSubmissionTarget(
  prior: SubmissionTarget | undefined,
  next: SubmissionTarget
): boolean {
  if (prior === undefined || prior.kind !== next.kind) return false;
  if (prior.kind === "task" && next.kind === "task") return prior.taskId === next.taskId;
  return true;
}

/**
 * Derive the §2.5 feedback for one committed submission from its routing and the
 * facts read in the save transaction.
 *
 * Pure over already-read facts, so it is unit-testable against the whole table
 * without a Store. `enteredPlanning` and `activationState` are the values read
 * before routing executed; the routing itself names what the transaction then
 * did, and phase is derived to reflect the post-commit truth (a just-entered
 * planning Draft reports `draft-planning`).
 */
export function describeSubmissionFeedback(
  input: Readonly<{
    taskId: string;
    messageId: string;
    status: Task["status"];
    enteredPlanning: boolean;
    activationState: DraftActivationState;
    routing: SubmissionRouting;
    activationRef?: string;
    activationFailure?: string;
  }>
): SubmissionFeedback {
  const { routing } = input;
  const phase: SubmissionFeedback["phase"] = input.status === "active"
    ? "active"
    : routing.kind === "enter-planning"
      || routing.kind === "continue-planning"
      || routing.kind === "planned-needs-manual-activation"
      || input.enteredPlanning
      ? "draft-planning"
      : "draft-unplanned";
  const planning: SubmissionFeedback["planning"] = routing.kind === "enter-planning"
    ? "entered"
    : routing.kind === "continue-planning"
      ? "continued"
      : "none";
  const activation: SubmissionFeedback["activation"] = routing.kind === "activate"
    ? "requested"
    : routing.kind === "planned-needs-manual-activation"
      ? "manual-required"
      : routing.kind === "activation-blocked-execution-stopped"
        ? "execution-stopped"
        : routing.kind === "await-activation"
          ? routing.state
          // record and the planning routes report the existing obligation, if
          // any, truthfully without acting on it.
          : input.activationState === "pending"
            ? "pending"
            : input.activationState === "failed"
              ? "failed"
              : "none";
  const delivery: SubmissionFeedback["delivery"] =
    routing.kind === "enter-planning"
      || routing.kind === "continue-planning"
      || routing.kind === "active-context"
      ? "queued"
      : "none";
  const nextStep = submissionNextStep(input);
  return {
    saved: { taskId: input.taskId, messageId: input.messageId },
    phase,
    planning,
    activation,
    delivery,
    ...(nextStep === undefined ? {} : { nextStep })
  };
}

function submissionNextStep(
  input: Readonly<{
    taskId: string;
    routing: SubmissionRouting;
    activationRef?: string;
    activationFailure?: string;
  }>
): SubmissionNextStep | undefined {
  if (input.routing.kind === "planned-needs-manual-activation") {
    return { kind: "activate-manually", taskId: input.taskId };
  }
  if (input.routing.kind === "activation-blocked-execution-stopped") {
    return { kind: "start-execution", taskId: input.taskId };
  }
  if (input.routing.kind === "await-activation") {
    if (input.routing.state === "failed") {
      return {
        kind: "resolve-failed-activation",
        activationRef: input.activationRef ?? "",
        failure: input.activationFailure ?? "activation failed"
      };
    }
    return { kind: "await-pending-activation", activationRef: input.activationRef ?? "" };
  }
  return undefined;
}
