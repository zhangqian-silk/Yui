import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import type { AgentRun } from "../agentRun/agentRun.js";
import type { SubmissionReceipt } from "../task/taskSubmission.js";

export const TASK_MESSAGE_KINDS = ["user", "operator", "role-result", "system"] as const;

export type TaskMessageKind = typeof TASK_MESSAGE_KINDS[number];

/**
 * How a user/operator submission asks its Task to react (task-32 Requirement A).
 *
 * - `record`: save only. No Leader wake, no planning, no activation.
 * - `discuss`: save and route to planning (the default when a submission omits
 *   an intent).
 * - `develop`: save the requirement and its activation intent; an unplanned
 *   Draft records an activation request and queues only activation processing.
 *
 * The intent is never inferred from body text and is only meaningful on a
 * user/operator submission: a role-result or system Message can never carry one,
 * so an internal Agent report cannot acquire develop authority.
 */
export const TASK_SUBMISSION_INTENTS = ["record", "discuss", "develop"] as const;

export type TaskSubmissionIntent = typeof TASK_SUBMISSION_INTENTS[number];
/** The two durable input actions an authorized caller can choose (decision-3).
 * `interrupt` is a control operation, not a persisted Message action, so it is
 * absent here. */
export const TASK_MESSAGE_INPUT_ACTIONS = ["queue", "steer"] as const;

export type TaskMessageInputAction = typeof TASK_MESSAGE_INPUT_ACTIONS[number];

/** The recordable outcomes of a steer's one live control attempt (message-5 gap
 * D). `not-submitted` is not here: it is the absence of a record, not a value. */
export const TASK_MESSAGE_INPUT_CONTROL_OUTCOMES = ["pending", "accepted", "rejected", "delivery-unknown"] as const;

/**
 * The durable business input action and its stable idempotency key.
 *
 * Absent on ordinary submissions. `queue` is delivered at the recipient's next
 * legal execution opportunity. `steer` targets only the exact current native Turn: it is saved
 * but is never auto-delivered as a queued continuation, so an unsupported steer
 * cannot silently become a queue.
 *
 * `expectedTarget` durably binds a steer to the exact Turn it named
 * (decision-3 §6): a replay under the same requestId that names a different
 * target is a conflicting reuse. This record stays frozen at send time; the
 * *observed* disposition of the live attempt is recorded separately on the
 * Message's sibling {@link TaskMessageControlOutcome} (decision-3 §3/§8, message-5
 * gap D), so the intent is immutable while a later reader still learns whether
 * the steer was submitted (pending) / accepted / rejected / delivery-unknown —
 * and an unknown steer is never silently retried through a new requestId.
 */
export type TaskMessageInputControl = Readonly<{
  action: TaskMessageInputAction;
  requestId: string;
  /** The Leader's exact expected current Turn for a steer; absent for queue. */
  expectedTarget?: string;
}>;

/**
 * The observed durable disposition of a steer's one live control attempt
 * (decision-3 §3/§8, message-5 gap D). It is the "independent control attempt":
 * a control op distinct from the frozen business {@link TaskMessageInputControl}
 * intent, so the intent stays immutable while the attempt's outcome is recorded
 * as it becomes known. `pending` is the live attempt made, its acceptance not
 * yet proven; the three terminals are read from the Host's own control result,
 * never guessed. The absence of any outcome is the fourth visible state,
 * `not-submitted` — the input was saved but no live attempt landed (see
 * {@link taskMessageInputControlState}).
 */
export type TaskMessageInputControlOutcome =
  | "pending"
  | "accepted"
  | "rejected"
  | "delivery-unknown";

/** The four visible states a later reader distinguishes for a steer input: the
 * three recorded outcomes plus `not-submitted`, which is the absence of any
 * recorded live attempt (message-5 gap D). */
export type TaskMessageInputControlState =
  | "not-submitted"
  | TaskMessageInputControlOutcome;

/**
 * The durable control op for a steer Message: its stable idempotency key, the
 * messageRef the live edge and the Host settlement both name, and the observed
 * outcome. `requestId` matches the Message's own input identity (its live
 * `inputControl.requestId`, or the `interruptThen.reusedInput.requestId` a
 * handoff preserved) so a replay never forks a second control op; `receiptId`
 * is the exact `steer:<taskId>/<messageId>` fence the live edge names, so the
 * outcome binds to this exact Message and never to another (message-5 gap D).
 * Terminals are monotonic — a proven outcome is never downgraded back to
 * `pending` or overwritten by a weaker terminal (decision-3 §8).
 */
export type TaskMessageControlOutcome = Readonly<{
  requestId: string;
  receiptId: string;
  outcome: TaskMessageInputControlOutcome;
  observedAt: string;
}>;

/**
 * A claimed "stop the exact old Turn, then deliver this Message once" handoff
 * (decision-3 §4). The claim is registered before the interrupt's cancel, and
 * the Message is delivered exactly once in the same Session after the target
 * native Turn reaches a proven terminal, without the prior queue preempting it.
 * Only one claim may reference a given target Turn.
 */
export type TaskMessageInterruptThen = Readonly<{
  /** Stable requestId of the interrupt that owns this continuation claim. */
  requestId: string;
  /**
   * The exact interrupted native Turn's local input attempt id — the identity
   * `resolveTaskInputControl` surfaced for the current Turn (decision-3 §3/§4).
   * The handoff's terminal is proven from the Role's own ProviderTurn keyed by
   * this attemptId, so a no-Run Leader turn (a native turn with no owning
   * AgentRun) can still claim and release a continuation.
   */
  targetAttemptId: string;
  targetRoleName: string;
  targetAgentId: string;
  targetAdapterId: string;
  targetNativeSessionId: string;
  targetAuthorityEpoch: number;
  targetAuthorityHolderId: string;
  targetNativeTurnId?: string;
  notDeliveredReason?: string;
  /**
   * The owning AgentRun of the interrupted Turn, when one exists. A Worker/
   * Reviewer turn is owned by an AgentRun whose `delivery-unknown` terminal makes
   * the cancel outcome unprovable; a no-Run Leader turn carries none, and its
   * terminal is proven from the native ProviderTurn alone. Present so the terminal
   * gate can additionally reject an unprovable AgentRun terminal (decision-3 §8).
   */
  targetRunId?: string;
  /**
   * The saved input this handoff reuses, kept as provenance (decision-3 §3).
   * The claim is a new op that references the original input rather than erasing
   * it: preserving the original requestId here keeps a replay of that requestId
   * resolving to this same Message, so a reused input never becomes a second
   * input. Absent when the interrupt named a Message that carried no input
   * action of its own.
   */
  reusedInput?: TaskMessageInputControl;
}>;

export type TaskMessageAuthor =
  | Readonly<{ type: "user" }>
  | Readonly<{ type: "operator" }>
  | Readonly<{ type: "role"; roleName: string }>
  | Readonly<{ type: "system" }>;

/** Logical ownership is frozen at send time, never inferred from the latest
 * native process occupying a Role. The referenced Run supplies the Assignment. */
export type TaskMessageRecipient = Readonly<{
  roleName: string;
  /** Absent for a scoped Leader notification, which is not an Assignment. */
  ownerRunId?: string;
  workItemId?: string;
  reviewRoundId?: string;
}>;

export type TaskMessage = {
  schemaVersion: 3;
  id: string;
  taskId: string;
  kind: TaskMessageKind;
  author: TaskMessageAuthor;
  body: string;
  /**
   * Required on user/operator Messages; absent on role-result/system Messages.
   * Persisted so the routing a submission received stays auditable
   * after the fact, independent of the Task's current phase.
   */
  intent?: TaskSubmissionIntent;
  /**
   * The client-chosen idempotency key for a user/operator submission (task-32
   * §2.3): the narrow persistent fact that lets a retry replay its original
   * outcome. Absent on role-result/system Messages and on keyless submissions, so
   * keyless submissions deliberately do not promise retry deduplication.
   */
  submissionKey?: string;
  /**
   * The receipt a keyed submission received, frozen at decision time (task-32
   * §2.3): the routing it actually got, the §2.5 feedback it actually returned,
   * and the target its key was bound to. A retry under the same key replays this
   * verbatim instead of recomputing from the Task's current phase or activation,
   * so a later gate change or cancelled request can never fabricate a different
   * outcome. Recorded on every keyed submission and absent only on keyless ones,
   * without inventing a receipt for an operation that never recorded one.
   */
  submissionReceipt?: SubmissionReceipt;
  /**
   * The durable input action and stable requestId chosen by the authorized
   * caller. Absent on ordinary submissions. Frozen at send time and immutable
   * for a given requestId.
   */
  inputControl?: TaskMessageInputControl;
  /**
   * A claimed interrupt-then handoff that delivers this Message once after the
   * exact target AgentRun terminates (decision-3 §4). Set atomically before the
   * interrupt's cancel; never a second queue.
   */
  interruptThen?: TaskMessageInterruptThen;
  /**
   * The observed disposition of a steer's one live control attempt (decision-3
   * §3/§8, message-5 gap D). Absent until a live attempt is made; a later reader
   * distinguishes the four visible states via {@link taskMessageInputControlState}.
   * It is the independent control op, never the frozen business intent, so
   * recording an outcome never mutates {@link TaskMessageInputControl}.
   */
  control?: TaskMessageControlOutcome;
  runId?: string;
  resultRef?: Readonly<{ type: "agent-run-result"; runId: string }>;
  workItemId?: string;
  recipient?: TaskMessageRecipient;
  continuation?: Readonly<{
    runId?: string;
    notDeliveredReason?: string;
  }>;
  handovers?: readonly Readonly<{ from: TaskMessageRecipient; at: string }>[];
  createdAt: string;
};

export type TaskMessageContext = Readonly<{
  runId?: string;
  resultRef?: Readonly<{ type: "agent-run-result"; runId: string }>;
  workItemId?: string;
  intent?: TaskSubmissionIntent;
  submissionKey?: string;
  recipient?: TaskMessageRecipient;
  inputControl?: TaskMessageInputControl;
  interruptThen?: TaskMessageInterruptThen;
}>;

export type TaskMessageDraftUpdate = Readonly<{
  body: string;
}>;

export function createTaskMessage(
  id: string,
  taskId: string,
  body: string,
  kind: TaskMessageKind,
  author: TaskMessageAuthor,
  now: Date,
  context: TaskMessageContext = {}
): TaskMessage {
  validateKindAndAuthor(kind, author);
  const message: TaskMessage = {
    schemaVersion: 3,
    id: requireSafeIdentity(id, "Message id"),
    taskId: requireSafeIdentity(taskId, "Message Task id"),
    kind,
    author: normalizeAuthor(author),
    body: requireBody(body),
    ...(kind === "user" || kind === "operator"
      ? { intent: context.intent ?? "discuss" }
      : context.intent === undefined ? {} : { intent: context.intent }),
    ...(context.submissionKey === undefined
      ? {}
      : { submissionKey: requireText(context.submissionKey, "Message submission key") }),
    ...(context.inputControl === undefined
      ? {}
      : { inputControl: {
          action: context.inputControl.action,
          requestId: requireSafeIdentity(context.inputControl.requestId, "Message input requestId"),
          ...(context.inputControl.expectedTarget === undefined
            ? {} : { expectedTarget: requireText(context.inputControl.expectedTarget, "Message input expectedTarget") })
        } }),
    ...(context.interruptThen === undefined
      ? {}
      : { interruptThen: {
          requestId: requireSafeIdentity(context.interruptThen.requestId, "Message interrupt requestId"),
          targetAttemptId: requireText(context.interruptThen.targetAttemptId, "Message interrupt targetAttemptId"),
          targetRoleName: context.interruptThen.targetRoleName,
          targetAgentId: context.interruptThen.targetAgentId,
          targetAdapterId: context.interruptThen.targetAdapterId,
          targetNativeSessionId: context.interruptThen.targetNativeSessionId,
          targetAuthorityEpoch: context.interruptThen.targetAuthorityEpoch,
          targetAuthorityHolderId: context.interruptThen.targetAuthorityHolderId,
          ...(context.interruptThen.targetNativeTurnId === undefined ? {} : {
            targetNativeTurnId: context.interruptThen.targetNativeTurnId
          }),
          ...(context.interruptThen.notDeliveredReason === undefined ? {} : {
            notDeliveredReason: context.interruptThen.notDeliveredReason
          }),
          ...(context.interruptThen.targetRunId === undefined
            ? {} : { targetRunId: context.interruptThen.targetRunId }),
          ...(context.interruptThen.reusedInput === undefined ? {} : { reusedInput: {
            action: context.interruptThen.reusedInput.action,
            requestId: requireSafeIdentity(context.interruptThen.reusedInput.requestId, "Reused input requestId")
          } })
        } }),
    ...(context.runId === undefined
      ? {}
      : { runId: requireSafeIdentity(context.runId, "Message AgentRun id") }),
    ...(context.resultRef === undefined ? {} : { resultRef: { ...context.resultRef } }),
    ...(context.workItemId === undefined
      ? {}
      : { workItemId: requireSafeIdentity(context.workItemId, "Message Work item id") }),
    ...(context.recipient === undefined ? {} : { recipient: { ...context.recipient },
      ...(context.recipient.ownerRunId === undefined ? {} : { continuation: {} }) }),
    createdAt: now.toISOString()
  };
  validateTaskMessage(message);
  return message;
}

export function taskMessageAuthorLabel(author: TaskMessageAuthor): string {
  return author.type === "role" ? author.roleName : author.type;
}

/**
 * The four visible states a later reader distinguishes for a steer input
 * (message-5 gap D): the absence of any live attempt is `not-submitted`, and a
 * recorded attempt reports its own observed outcome. A non-steer Message has no
 * control state and returns `undefined`. This is the single reader other CLI
 * invocations, the Web surface, and the Leader's Context read all use, so no
 * consumer reconstructs the state from raw fields.
 */
export function taskMessageInputControlState(
  message: TaskMessage
): TaskMessageInputControlState | undefined {
  const wasSteer = message.inputControl?.action === "steer"
    || message.interruptThen?.reusedInput?.action === "steer";
  if (!wasSteer) return undefined;
  return message.control?.outcome ?? "not-submitted";
}

/**
 * Record the observed disposition of a steer's one live control attempt as an
 * independent, idempotent, monotonic control op (decision-3 §3/§8, message-5 gap
 * D). The op is keyed by the exact `receiptId` fence and the steer's own
 * `requestId`; a record naming a different Message's receipt or a different
 * input identity is refused, so an outcome can never be folded onto the wrong
 * Message or fork a second op. Terminals never rewind to `pending` and never
 * overwrite a different terminal — a repeated or out-of-order live/Host record
 * is absorbed, never a conflicting second write. The frozen business
 * {@link TaskMessageInputControl} intent is left untouched.
 */
export function recordTaskMessageControlOutcome(
  message: TaskMessage,
  record: Readonly<{ requestId: string; receiptId: string; outcome: TaskMessageInputControlOutcome; observedAt: Date }>
): TaskMessage {
  const inputRequestId = message.inputControl?.requestId ?? message.interruptThen?.reusedInput?.requestId;
  const wasSteer = message.inputControl?.action === "steer"
    || message.interruptThen?.reusedInput?.action === "steer";
  if (!wasSteer || inputRequestId === undefined) {
    throw new Error("Only a steer input Message records a live control outcome.");
  }
  if (record.requestId !== inputRequestId) {
    throw new Error("Control outcome requestId must match the steer input identity.");
  }
  const existing = message.control;
  if (existing !== undefined && existing.receiptId !== record.receiptId) {
    throw new Error("Control outcome receiptId cannot name another control op.");
  }
  // Monotonic freeze (decision-3 §8, message-5 gap D). Once any terminal is
  // proven it is final: a later `pending` never rewinds it and a different
  // terminal never overwrites it — the first proven terminal wins. While still
  // `pending`, an identical repeat is idempotent. Each frozen/absorbed case
  // returns the Message unchanged so a fold can persist without a second write.
  if (existing !== undefined) {
    if (existing.outcome === "accepted" || existing.outcome === "rejected") return message;
    if (record.outcome === "pending" || record.outcome === existing.outcome) return message;
  }
  const updated: TaskMessage = {
    ...message,
    control: {
      requestId: requireSafeIdentity(record.requestId, "Message control requestId"),
      receiptId: requireText(record.receiptId, "Message control receiptId"),
      outcome: record.outcome,
      observedAt: record.observedAt.toISOString()
    }
  };
  validateTaskMessage(updated);
  return updated;
}

/** A role-result reference never duplicates the execution's report body. */
export function expandTaskMessageResult(
  message: TaskMessage,
  getRun: (taskId: string, runId: string) => AgentRun | null
) {
  if (message.resultRef === undefined) return message;
  const run = getRun(message.taskId, message.resultRef.runId);
  if (run === null || run.taskId !== message.taskId
    || message.author.type !== "role" || run.roleName !== message.author.roleName
    || run.status === "active" || run.result === undefined) {
    throw new Error(`Result Message has no matching terminal execution: ${message.id}.`);
  }
  return { ...message, result: run.result };
}

/** Edit unkeyed Draft context. Once an input has a request identity, its body
 * is the retry comparison and must stay frozen, including through a handoff. */
export function updateDraftTaskMessage(
  message: TaskMessage,
  update: TaskMessageDraftUpdate
): TaskMessage {
  validateTaskMessage(message);
  if (message.kind !== "user" && message.kind !== "operator") {
    throw new Error(`Only user/operator Task Messages can be updated: ${message.id}.`);
  }
  const body = requireBody(update.body);
  if (body === message.body) return message;
  if (message.submissionKey !== undefined || message.inputControl !== undefined || message.interruptThen !== undefined) {
    throw new Error(`Message ${message.id} has a request identity; submit a new Message with a new request ID to change its content.`);
  }
  const updated: TaskMessage = {
    ...message,
    body
  };
  validateTaskMessage(updated);
  return updated;
}

/**
 * Attach the §2.3 receipt a keyed submission earned, in the same transaction that
 * saved and routed the Message. The receipt is a write-once fact: it is only set
 * on a keyed Message that has none yet, so a replay (which never re-routes) can
 * never overwrite the disposition the original submission recorded.
 */
export function withSubmissionReceipt(
  message: TaskMessage,
  receipt: SubmissionReceipt
): TaskMessage {
  validateTaskMessage(message);
  if (message.submissionKey === undefined) {
    throw new Error(`A submission receipt requires a submission key: ${message.id}.`);
  }
  if (message.submissionReceipt !== undefined) {
    throw new Error(`Submission receipt is already recorded: ${message.id}.`);
  }
  const updated: TaskMessage = { ...message, submissionReceipt: receipt };
  validateTaskMessage(updated);
  return updated;
}

export function validateTaskMessage(message: TaskMessage): void {
  if (message.schemaVersion !== 3) throw new Error("Task Message must use schemaVersion 3.");
  validateTaskRecordReference({ taskId: message.taskId, localId: message.id }, "message");
  requireText(message.body, "Message body");
  validateKindAndAuthor(message.kind, message.author);
  normalizeAuthor(message.author);
  if (Object.hasOwn(message, "wakePolicy")) {
    throw new Error("Message contains a retired wake policy; use the storage upgrade boundary.");
  }
  if ((message.kind === "user" || message.kind === "operator") && message.intent === undefined) {
    throw new Error("User/operator Message intent is required.");
  }
  if (message.intent !== undefined
    && !TASK_SUBMISSION_INTENTS.includes(message.intent)) {
    throw new Error(`Message intent is invalid: ${String(message.intent)}.`);
  }
  if (message.intent !== undefined
    && message.kind !== "user"
    && message.kind !== "operator") {
    throw new Error("Message intent is only valid for user/operator messages.");
  }
  if (message.submissionKey !== undefined) {
    requireText(message.submissionKey, "Message submission key");
    if (message.kind !== "user" && message.kind !== "operator") {
      throw new Error("Message submission key is only valid for user/operator messages.");
    }
  }
  if (message.submissionReceipt !== undefined && message.submissionKey === undefined) {
    throw new Error("Message submission receipt requires a submission key.");
  }
  if (message.inputControl !== undefined) {
    if (!TASK_MESSAGE_INPUT_ACTIONS.includes(message.inputControl.action)) {
      throw new Error(`Message input action is invalid: ${String(message.inputControl.action)}.`);
    }
    requireSafeIdentity(message.inputControl.requestId, "Message input requestId");
    if (message.inputControl.expectedTarget !== undefined) {
      requireText(message.inputControl.expectedTarget, "Message input expectedTarget");
      if (message.inputControl.action !== "steer") {
        throw new Error("Only a steer input binds an expectedTarget.");
      }
    }
  }
  if (message.interruptThen !== undefined) {
    requireSafeIdentity(message.interruptThen.requestId, "Message interrupt requestId");
    requireText(message.interruptThen.targetAttemptId, "Message interrupt targetAttemptId");
    requireSafeIdentity(message.interruptThen.targetRoleName, "Message interrupt target Role");
    requireSafeIdentity(message.interruptThen.targetAgentId, "Message interrupt target Agent");
    requireSafeIdentity(message.interruptThen.targetAdapterId, "Message interrupt target Adapter");
    requireText(message.interruptThen.targetNativeSessionId, "Message interrupt target Session");
    requireText(message.interruptThen.targetAuthorityHolderId, "Message interrupt authority holder");
    if (message.interruptThen.notDeliveredReason !== undefined) {
      requireText(message.interruptThen.notDeliveredReason, "Message interrupt nondelivery reason");
    }
    if (!Number.isSafeInteger(message.interruptThen.targetAuthorityEpoch)
      || message.interruptThen.targetAuthorityEpoch < 1) throw new Error("Invalid interrupt authority epoch.");
    if (message.interruptThen.targetRunId !== undefined) {
      validateTaskRecordReference(
        { taskId: message.taskId, localId: message.interruptThen.targetRunId }, "run");
    }
    if (message.interruptThen.reusedInput !== undefined) {
      if (!TASK_MESSAGE_INPUT_ACTIONS.includes(message.interruptThen.reusedInput.action)) {
        throw new Error(`Reused input action is invalid: ${String(message.interruptThen.reusedInput.action)}.`);
      }
      requireSafeIdentity(message.interruptThen.reusedInput.requestId, "Reused input requestId");
    }
    // A then-handoff is an explicit deliverable Message, never an auto-queued
    // steer: the two intents are mutually exclusive by construction. The prior
    // steer identity, when one existed, is preserved as reusedInput provenance
    // rather than left live on inputControl.
    if (message.inputControl?.action === "steer") {
      throw new Error("An interrupt-then handoff cannot also be a steer input.");
    }
  }
  if (message.control !== undefined) {
    requireSafeIdentity(message.control.requestId, "Message control requestId");
    requireText(message.control.receiptId, "Message control receiptId");
    if (!TASK_MESSAGE_INPUT_CONTROL_OUTCOMES.includes(message.control.outcome)) {
      throw new Error(`Message control outcome is invalid: ${String(message.control.outcome)}.`);
    }
    if (typeof message.control.observedAt !== "string" || Number.isNaN(Date.parse(message.control.observedAt))) {
      throw new Error("Message control observedAt is invalid.");
    }
    // A recorded control outcome is the disposition of a live steer attempt; it
    // only exists for a steer input, or for the reused-steer provenance a
    // handoff preserved. It is never fabricated on a plain queue or a Message
    // that never carried a steer (decision-3 §3, message-5 gap D).
    const inputRequestId = message.inputControl?.requestId ?? message.interruptThen?.reusedInput?.requestId;
    const wasSteer = message.inputControl?.action === "steer"
      || message.interruptThen?.reusedInput?.action === "steer";
    if (!wasSteer || inputRequestId === undefined) {
      throw new Error("Only a steer input Message records a live control outcome.");
    }
    if (message.control.requestId !== inputRequestId) {
      throw new Error("Message control requestId must match the steer input identity.");
    }
  }
  if (message.runId !== undefined) requireSafeIdentity(message.runId, "Message AgentRun id");
  if (message.recipient !== undefined) {
    requireSafeIdentity(message.recipient.roleName, "Recipient Role");
    if (message.recipient.ownerRunId !== undefined) {
      validateTaskRecordReference({ taskId: message.taskId, localId: message.recipient.ownerRunId }, "run");
    } else if (message.recipient.roleName !== "leader") {
      throw new Error("An execution recipient requires an owner Assignment.");
    }
    if (message.recipient.workItemId !== undefined) {
      validateTaskRecordReference({ taskId: message.taskId, localId: message.recipient.workItemId }, "workItem");
    }
    if (message.recipient.reviewRoundId !== undefined) {
      requireSafeIdentity(message.recipient.reviewRoundId, "Recipient ReviewRound");
    }
    if (message.recipient.workItemId === undefined && message.recipient.reviewRoundId === undefined) {
      throw new Error("A recipient requires an exact WorkItem or ReviewRound.");
    }
  }
  if (message.continuation !== undefined && message.recipient?.ownerRunId === undefined) {
    throw new Error("Message continuation requires an owner Assignment.");
  }
  if (message.continuation?.runId !== undefined) {
    validateTaskRecordReference({ taskId: message.taskId, localId: message.continuation.runId }, "run");
  }
  if (message.continuation?.notDeliveredReason !== undefined) {
    requireText(message.continuation.notDeliveredReason, "Message nondelivery reason");
    if (message.continuation.runId !== undefined) throw new Error("Assigned Message delivery is observed from its AgentRun.");
  }
  for (const handover of message.handovers ?? []) {
    requireSafeIdentity(handover.from.roleName, "Previous Message Role");
    requireSafeIdentity(handover.from.ownerRunId!, "Previous Message Assignment");
    if (Number.isNaN(Date.parse(handover.at))) throw new Error("Message handover timestamp is invalid.");
  }
  if (message.resultRef !== undefined) {
    if (message.kind !== "role-result" || message.resultRef.type !== "agent-run-result") {
      throw new Error("Execution result references require a role-result Message.");
    }
    validateTaskRecordReference({ taskId: message.taskId, localId: message.resultRef.runId }, "run");
  }
  if (message.workItemId !== undefined) {
    validateTaskRecordReference({
      taskId: message.taskId,
      localId: message.workItemId
    }, "workItem");
  }
  if (message.runId !== undefined) {
    validateTaskRecordReference({ taskId: message.taskId, localId: message.runId }, "run");
  }
  if (typeof message.createdAt !== "string" || Number.isNaN(Date.parse(message.createdAt))) {
    throw new Error("Message createdAt is invalid.");
  }
}

/**
 * The author kinds a Global Role input can carry. A Global Role has no Task
 * Assignment, so a `role-result` (which references a Task AgentRun) is not one
 * of them; user/operator/system inputs are (decision-3 §9/§11).
 */
export const GLOBAL_ROLE_MESSAGE_KINDS = ["user", "operator", "system", "agent"] as const;

export type GlobalRoleMessageKind = typeof GLOBAL_ROLE_MESSAGE_KINDS[number];

export type GlobalRoleMessageAuthor =
  | Readonly<{ type: "user" }>
  | Readonly<{ type: "operator" }>
  | Readonly<{ type: "agent" }>
  | Readonly<{ type: "system" }>;

/**
 * A durable Global Role input. Its explicit owner is the Global Role name
 * (decision-3 §11: "Global Role 消息的明确 owner 和可授权引用"), never a
 * fabricated Task (decision-3 §9): this is how a Global input becomes
 * authorizable and referenceable without reusing Task permissions or Task
 * record shapes. It extends the Message store to a Global owner exactly as the
 * Role store already parallels Task and Global Roles — persisted in the
 * Global-owned message store and dispatched through the existing
 * global-role-runtime mailbox, not a new private queue.
 */
export type GlobalRoleMessage = {
  schemaVersion: 1;
  id: string;
  /** The explicit Global owner; a Global Role name, never a Task id. */
  roleName: string;
  kind: GlobalRoleMessageKind;
  author: GlobalRoleMessageAuthor;
  body: string;
  control?: TaskMessageControlOutcome;
  deliveryTarget?: Readonly<{ agentId: string; nativeSessionId: string }>;
  /**
   * The scope-generic durable input action and stable requestId, reused from
   * the Task shape so a Global queue/steer is immutable and idempotent per
   * requestId exactly like a Task input (decision-3 §6). `queue` is delivered
   * at the Role's next legal execution opportunity; `steer` is saved but never
   * auto-delivered as a queued continuation.
   */
  inputControl?: TaskMessageInputControl;
  /**
   * Delivery evidence for this input. Transport is weaker than Provider
   * acceptance; Context reads never create either receipt.
   */
  delivery?: Readonly<{ deliveredAt: string; via: "provider" | "transport" }>;
  /**
   * A claimed interrupt-then handoff (decision-3 §4). Set atomically before the
   * live cancel by `yui role interrupt --then-message`, it binds this already
   * saved durable Global Message as the single continuation of an exact
   * interrupted native Turn, keyed by the interrupt's own stable requestId and
   * the target's attemptId. It is never a fourth action and never a second queue.
   */
  interruptThen?: GlobalRoleMessageInterruptThen;
  /**
   * A visible not-delivered fact for a durable Global input (decision-3 §5/§10,
   * the Global twin of the Task {@link TaskMessage.continuation.notDeliveredReason}).
   * A queued Message or a claimed interrupt-then handoff whose target can never
   * prove a safe boundary — its interrupted Turn's terminal is unprovable
   * (delivery-unknown) or its durable evidence is gone — fails visibly here and
   * stops holding the queue, rather than silently wedging the Role's pending set.
   * It is never released or replayed across that boundary; the Operator re-chooses
   * with a fresh input. Absent means still pending or already delivered.
   */
  notDelivered?: Readonly<{ reason: string; at: string }>;
  createdAt: string;
};

/**
 * The Global twin of {@link TaskMessageInterruptThen}. A Global Role has no
 * owning AgentRun, so the interrupted target is proven by the exact native Turn's
 * attemptId under the Role's own writer fence, never by a fabricated Task Run.
 */
export type GlobalRoleMessageInterruptThen = Readonly<{
  /** Stable requestId of the interrupt that owns this continuation claim. */
  requestId: string;
  /** The exact interrupted native Turn's local input attempt id. */
  targetAttemptId: string;
  targetNativeSessionId: string;
  targetAgentId: string;
  targetAuthorityEpoch: number;
  targetAuthorityHolderId: string;
  /**
   * The interrupted native Turn's provider Turn id, captured from the resolved
   * target when the Provider surfaced one (decision-3 §6, "若存在则 native
   * Turn"). The local attempt and fixed Session remain authoritative; a
   * historical native id never releases input into another Session.
   */
  targetNativeTurnId?: string;
  /** The saved input this handoff reuses, kept as provenance (decision-3 §3). */
  reusedInput?: TaskMessageInputControl;
}>;

export type GlobalRoleMessageContext = Readonly<{
  inputControl?: TaskMessageInputControl;
}>;

export function createGlobalRoleMessage(
  id: string,
  roleName: string,
  body: string,
  kind: GlobalRoleMessageKind,
  author: GlobalRoleMessageAuthor,
  now: Date,
  context: GlobalRoleMessageContext = {}
): GlobalRoleMessage {
  validateGlobalKindAndAuthor(kind, author);
  const message: GlobalRoleMessage = {
    schemaVersion: 1,
    id: validateGlobalRoleMessageId(id),
    roleName: requireSafeIdentity(roleName, "Global message Role name"),
    kind,
    author: { type: author.type },
    body: requireBody(body),
    ...(context.inputControl === undefined
      ? {}
      : { inputControl: {
          action: context.inputControl.action,
          requestId: requireSafeIdentity(context.inputControl.requestId, "Message input requestId"),
          ...(context.inputControl.expectedTarget === undefined
            ? {} : { expectedTarget: requireText(context.inputControl.expectedTarget, "Message input expectedTarget") })
        } }),
    createdAt: now.toISOString()
  };
  validateGlobalRoleMessage(message);
  return message;
}

export function validateGlobalRoleMessage(message: GlobalRoleMessage): void {
  if (message.schemaVersion !== 1) throw new Error("Global Role Message must use schemaVersion 1.");
  validateGlobalRoleMessageId(message.id);
  requireSafeIdentity(message.roleName, "Global message Role name");
  requireBody(message.body);
  validateGlobalKindAndAuthor(message.kind, message.author);
  if (message.deliveryTarget !== undefined) {
    requireText(message.deliveryTarget.agentId, "Global input Agent");
    requireText(message.deliveryTarget.nativeSessionId, "Global input Session");
  }
  if (message.control !== undefined) {
    requireSafeIdentity(message.control.requestId, "Global input requestId");
    requireText(message.control.receiptId, "Global input receiptId");
    if (!TASK_MESSAGE_INPUT_CONTROL_OUTCOMES.includes(message.control.outcome)
      || !Number.isFinite(Date.parse(message.control.observedAt))) throw new Error("Global input disposition is invalid.");
  }
  if (message.inputControl !== undefined) {
    if (!TASK_MESSAGE_INPUT_ACTIONS.includes(message.inputControl.action)) {
      throw new Error(`Message input action is invalid: ${String(message.inputControl.action)}.`);
    }
    requireSafeIdentity(message.inputControl.requestId, "Message input requestId");
    if (message.inputControl.expectedTarget !== undefined) {
      requireText(message.inputControl.expectedTarget, "Message input expectedTarget");
      if (message.inputControl.action !== "steer") {
        throw new Error("Only a steer input binds an expectedTarget.");
      }
    }
  }
  if (message.delivery !== undefined) {
    if (message.delivery.via !== "provider" && message.delivery.via !== "transport") {
      throw new Error(`Global message delivery via is invalid: ${String(message.delivery.via)}.`);
    }
    if (typeof message.delivery.deliveredAt !== "string"
      || Number.isNaN(Date.parse(message.delivery.deliveredAt))) {
      throw new Error("Global message delivery deliveredAt is invalid.");
    }
    // Receipt evidence is shared by queue, explicit then and native steer.
    if (message.inputControl === undefined && message.interruptThen === undefined) {
      throw new Error("Only a durable Global input records Provider delivery.");
    }
  }
  if (message.interruptThen !== undefined) {
    requireSafeIdentity(message.interruptThen.requestId, "Global message interrupt requestId");
    requireText(message.interruptThen.targetAttemptId, "Global message interrupt targetAttemptId");
    requireText(message.interruptThen.targetNativeSessionId, "Global interrupt target Session");
    requireText(message.interruptThen.targetAgentId, "Global interrupt target Agent");
    requireText(message.interruptThen.targetAuthorityHolderId, "Global interrupt writer");
    if (!Number.isSafeInteger(message.interruptThen.targetAuthorityEpoch)
      || message.interruptThen.targetAuthorityEpoch < 1) throw new Error("Global interrupt epoch is invalid.");
    if (message.interruptThen.targetNativeTurnId !== undefined) {
      requireText(message.interruptThen.targetNativeTurnId, "Global message interrupt targetNativeTurnId");
    }
    if (message.interruptThen.reusedInput !== undefined) {
      if (!TASK_MESSAGE_INPUT_ACTIONS.includes(message.interruptThen.reusedInput.action)) {
        throw new Error(`Reused input action is invalid: ${String(message.interruptThen.reusedInput.action)}.`);
      }
      requireSafeIdentity(message.interruptThen.reusedInput.requestId, "Reused input requestId");
    }
  }
  if (message.notDelivered !== undefined) {
    requireText(message.notDelivered.reason, "Global message nondelivery reason");
    if (typeof message.notDelivered.at !== "string"
      || Number.isNaN(Date.parse(message.notDelivered.at))) {
      throw new Error("Global message nondelivery timestamp is invalid.");
    }
    // A delivered Message is a settled positive fact; a not-delivered fact is its
    // visible negative twin. The two are mutually exclusive on one Message.
    if (message.delivery !== undefined) {
      throw new Error("A Global message cannot be both delivered and not-delivered.");
    }
    if (message.inputControl?.action !== "queue" && message.interruptThen === undefined) {
      throw new Error("Only a queued or interrupt-then Global message records a nondelivery.");
    }
  }
  if (typeof message.createdAt !== "string" || Number.isNaN(Date.parse(message.createdAt))) {
    throw new Error("Message createdAt is invalid.");
  }
}

/** A Global message local id is `global-message-<n>`; it carries no Task id. */
export function validateGlobalRoleMessageId(localId: string): string {
  const normalized = requireSafeIdentity(localId, "Global message id");
  if (!/^global-message-[1-9]\d*$/.test(normalized)) {
    throw new Error(`Global message id is invalid: ${localId}.`);
  }
  return normalized;
}

/**
 * Return a copy of a queued Global Message marked delivered at its next legal
 * opportunity — the Role's own authorized Context read (decision-3 §9). Only a
 * `queue` input may be consumed this way and only once: a Message that already
 * carries a delivery is returned unchanged, so a repeated self-read is
 * idempotent and never re-delivers. A steer/interrupt Message, which targets the
 * exact current Turn rather than a queued next opportunity, is never delivered
 * here.
 */
export function markGlobalRoleMessageDelivered(
  message: GlobalRoleMessage, now: Date, via: "provider" | "transport" = "provider"
): GlobalRoleMessage {
  if (message.inputControl === undefined && message.interruptThen === undefined) {
    throw new Error("Only a durable Global input is delivered by a Provider.");
  }
  if (message.delivery?.via === "provider" || message.delivery?.via === via) return message;
  const delivered: GlobalRoleMessage = {
    ...message,
    ...(message.control === undefined ? {} : { control: {
      ...message.control, outcome: via === "provider" ? "accepted" : "pending", observedAt: now.toISOString()
    } }),
    delivery: { deliveredAt: now.toISOString(), via }
  };
  validateGlobalRoleMessage(delivered);
  return delivered;
}

/**
 * Return a copy of an already-saved durable Global Message that claims the single
 * interrupt-then continuation of an exact interrupted native Turn (decision-3
 * §4). The original input identity, when the Message carried one, is preserved as
 * `reusedInput` provenance rather than erased, so a replay of that requestId
 * keeps resolving to this same Message and never creates a second input.
 */
export function claimGlobalRoleMessageInterruptThen(
  message: GlobalRoleMessage,
  claim: Omit<GlobalRoleMessageInterruptThen, "reusedInput">
): GlobalRoleMessage {
  const { inputControl, notDelivered: _priorNondelivery, ...rest } = message;
  const claimed: GlobalRoleMessage = {
    ...rest,
    interruptThen: {
      requestId: requireSafeIdentity(claim.requestId, "Global message interrupt requestId"),
      targetAttemptId: requireText(claim.targetAttemptId, "Global message interrupt targetAttemptId"),
      targetNativeSessionId: claim.targetNativeSessionId,
      targetAgentId: claim.targetAgentId,
      targetAuthorityEpoch: claim.targetAuthorityEpoch,
      targetAuthorityHolderId: claim.targetAuthorityHolderId,
      ...(claim.targetNativeTurnId === undefined
        ? {}
        : { targetNativeTurnId: requireText(claim.targetNativeTurnId, "Global message interrupt targetNativeTurnId") }),
      ...(inputControl === undefined ? {} : { reusedInput: inputControl })
    }
  };
  validateGlobalRoleMessage(claimed);
  return claimed;
}

/**
 * Return a copy of a durable Global Message marked visibly not-delivered
 * (decision-3 §5/§10), the Global twin of the Task {@link markNotDelivered}. An
 * ordinary queue entry or a claimed interrupt-then handoff whose target can never
 * prove a safe boundary fails here and stops holding the Role's pending set,
 * rather than silently wedging it. It is idempotent for the same reason — a
 * Message already carrying this exact reason is returned unchanged — and a
 * delivered Message is never overwritten with a nondelivery.
 */
export function markGlobalRoleMessageNotDelivered(
  message: GlobalRoleMessage, reason: string, now: Date
): GlobalRoleMessage {
  if (message.delivery !== undefined) {
    throw new Error("A delivered Global message cannot be marked not-delivered.");
  }
  if (message.notDelivered?.reason === reason) return message;
  const marked: GlobalRoleMessage = {
    ...message,
    notDelivered: { reason: requireText(reason, "Global message nondelivery reason"), at: now.toISOString() }
  };
  validateGlobalRoleMessage(marked);
  return marked;
}

function validateGlobalKindAndAuthor(
  kind: GlobalRoleMessageKind,
  author: GlobalRoleMessageAuthor
): void {
  if (!GLOBAL_ROLE_MESSAGE_KINDS.includes(kind)) {
    throw new Error(`Global message kind is invalid: ${String(kind)}.`);
  }
  if (author?.type !== kind) {
    throw new Error(`Global message kind ${kind} requires a ${kind} author.`);
  }
}

function validateKindAndAuthor(kind: TaskMessageKind, author: TaskMessageAuthor): void {
  if (!TASK_MESSAGE_KINDS.includes(kind)) throw new Error(`Message kind is invalid: ${String(kind)}.`);
  const expectedType = kind === "role-result" ? "role" : kind;
  if (author?.type !== expectedType) {
    const label = kind === "role-result" ? "Role result" : `Message kind ${kind}`;
    throw new Error(`${label} requires a ${expectedType} author.`);
  }
}

function normalizeAuthor(author: TaskMessageAuthor): TaskMessageAuthor {
  return author.type === "role"
    ? { type: "role", roleName: requireSafeIdentity(author.roleName, "Message Role name") }
    : { type: author.type };
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function requireBody(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Message body is invalid.");
  }
  if (value.trim().length === 0) throw new Error("Message body is required.");
  return value;
}
