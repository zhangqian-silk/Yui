import { YUI_VERSION } from "../version.js";
import { serializeAgentErrorRaw } from "./agentError.js";
import type {
  ProviderContinuationMetadataPort,
  ProviderContinuationQueryResult
} from "./providerRuntimeReconciler.js";
import type {
  ProviderControlAdapter,
  ProviderConversationProbe,
  ProviderTurnAcceptance
} from "./providerControl.js";

export type JsonRpcObject = Readonly<Record<string, unknown>>;

/**
 * Preserve the native non-interactive Codex identity used by our historical
 * execution adapter. A proxy's environment cannot set the daemon's originator;
 * the daemon derives it from initialization (and can retain its first identity).
 * Keep Yui's title/version explicit and do not opt into unsupported attestation.
 */
export function codexClientInitialization(): JsonRpcObject {
  return {
    clientInfo: { name: "codex_exec", title: "Yui", version: YUI_VERSION },
    capabilities: { experimentalApi: true, requestAttestation: false }
  };
}

/** Per-thread settings for a Yui-guided ordinary Codex conversation. */
export type CodexThreadOptions = Readonly<{
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  developerInstructions?: string;
  runtimeWorkspaceRoots?: readonly string[];
  config?: JsonRpcObject;
}>;

export interface CodexAppServerTransport {
  request(method: string, params: JsonRpcObject): Promise<JsonRpcObject>;
}

export class CodexAppServerRequestError extends Error {
  readonly name = "CodexAppServerRequestError";

  constructor(
    readonly code: number | string,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

export type CodexThreadSnapshot = Readonly<{
  threadId: string;
  loaded: boolean | "unknown";
  activeTurnId?: string;
  status: "active" | "idle" | "systemError" | "notLoaded" | "unknown";
  latestTurnStatus?: "completed" | "interrupted" | "failed" | "inProgress";
  turns: readonly CodexThreadTurnSnapshot[];
  parentThreadId?: string;
  ancestorThreadIds: readonly string[];
  raw: JsonRpcObject;
}>;

export type CodexThreadTurnSnapshot = Readonly<{
  turnId: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  output?: string;
  error?: string;
  rawError?: string;
}>;

export type CodexTurnAcceptance =
  | Readonly<{ status: "accepted"; turnId: string }>
  | Readonly<{ status: "busy"; activeTurnId?: string; reason: string }>
  | Readonly<{ status: "not-accepted"; reason: string }>
  | Readonly<{ status: "unknown"; reason: string }>;

/** The pre-submit read failed; no mutation request was issued. */
export class CodexPreSubmissionError extends Error {
  readonly name = "CodexPreSubmissionError";
}

export type CodexThreadGoal = Readonly<{
  conversationId: string;
  status: "active" | "paused" | "blocked" | "usage-limited" | "budget-limited" | "complete";
  objective: string;
  updatedAt: string;
  tokenBudget?: number;
}>;

/**
 * Continuable Codex integration over App Server. A transport connection is
 * deliberately not an Activation identity: callers supply the persisted
 * Conversation/Activation fence on every state-changing request.
 */
export class CodexAppServerRuntime implements
  ProviderControlAdapter,
  ProviderContinuationMetadataPort {
  readonly providerNamespace = "openai/codex";

  constructor(private readonly transport: CodexAppServerTransport) {}

  async openConversation(input: CodexThreadOptions & Readonly<{
    cwd: string;
  }>): Promise<Readonly<{ conversationId: string }>> {
    const result = await this.transport.request("thread/start", {
      cwd: text(input.cwd, "Codex thread cwd"),
      ...threadOptions(input)
    });
    return { conversationId: threadId(result) };
  }

  async resumeConversation(
    conversationId: string,
    options: CodexThreadOptions & Readonly<{ cwd?: string }> = {}
  ): Promise<CodexThreadSnapshot> {
    const id = text(conversationId, "Codex thread id");
    const result = await this.transport.request("thread/resume", {
      threadId: id,
      ...(options.cwd === undefined ? {} : { cwd: text(options.cwd, "Codex thread cwd") }),
      ...threadOptions(options)
    });
    return parseThreadSnapshot(result, id, true);
  }

  async setConversationName(input: Readonly<{
    conversationId: string;
    name: string;
  }>): Promise<void> {
    await this.transport.request("thread/name/set", {
      threadId: text(input.conversationId, "Codex thread id"),
      name: text(input.name, "Codex thread name")
    });
  }

  async readConversation(
    conversationId: string,
    options: Readonly<{ includeTurns?: boolean }> = {}
  ): Promise<CodexThreadSnapshot> {
    const id = text(conversationId, "Codex thread id");
    const result = await this.transport.request("thread/read", {
      threadId: id,
      includeTurns: options.includeTurns ?? true
    });
    return parseThreadSnapshot(result, id, "unknown");
  }

  async readGoal(conversationId: string): Promise<CodexThreadGoal | null> {
    const id = text(conversationId, "Codex thread id");
    const result = await this.transport.request("thread/goal/get", { threadId: id });
    const goal = objectMember(result, "goal");
    return goal === null ? null : codexThreadGoal(goal, id);
  }

  async inspectConversation(conversationId: string): Promise<ProviderConversationProbe> {
    const id = text(conversationId, "Codex thread id");
    try {
      const snapshot = await this.readConversation(id);
      return {
        state: "exists",
        conversationId: snapshot.threadId,
        ...(snapshot.activeTurnId === undefined ? {} : { activeTurnId: snapshot.activeTurnId })
      };
    } catch (error) {
      return {
        state: codexAppServerErrorIsMissing(error) ? "missing" : "unknown",
        conversationId: id
      };
    }
  }

  async submitTurn(input: Readonly<{
    conversationId: string;
    attemptId: string;
    text: string;
    expectedNoActiveTurn: boolean;
    expectedFailedNativeTurnId?: string;
    requireQuiescent?: boolean;
  }>): Promise<ProviderTurnAcceptance> {
    return this.startTurn({
      conversationId: input.conversationId,
      text: input.text,
      expectedNoActiveTurn: input.expectedNoActiveTurn,
      ...(input.requireQuiescent ? { requireQuiescent: true } : {}),
      ...(input.expectedFailedNativeTurnId === undefined ? {} : {
        expectedFailedNativeTurnId: input.expectedFailedNativeTurnId
      }),
      clientUserMessageId: input.attemptId
    });
  }

  async startTurn(input: Readonly<{
    conversationId: string;
    text: string;
    expectedNoActiveTurn: boolean;
    clientUserMessageId?: string;
    expectedFailedNativeTurnId?: string;
    requireQuiescent?: boolean;
  }>): Promise<CodexTurnAcceptance> {
    const requestedThreadId = text(input.conversationId, "Codex thread id");
    let threadId = requestedThreadId;
    try {
      const expectedFailedTurn = input.expectedFailedNativeTurnId === undefined ? undefined
        : text(input.expectedFailedNativeTurnId, "Expected failed Codex Turn id");
      // Submission needs current availability, not historical Turns. Some
      // App Server transports expose status without supporting history reads.
      const snapshot = await this.readConversation(requestedThreadId, { includeTurns: false });
      threadId = snapshot.threadId;
      if ((input.expectedNoActiveTurn || expectedFailedTurn !== undefined || input.requireQuiescent)
        && (snapshot.status === "active" || snapshot.activeTurnId !== undefined)) {
        return {
          status: "busy",
          ...(snapshot.activeTurnId === undefined ? {} : { activeTurnId: snapshot.activeTurnId }),
          reason: snapshot.activeTurnId === undefined
            ? "Provider Conversation has an active Turn."
            : `active-turn:${snapshot.activeTurnId}`
        };
      }
      if (snapshot.status !== "idle" && snapshot.status !== "active"
        && !(snapshot.status === "systemError" && expectedFailedTurn !== undefined)) {
        throw new Error(`Codex Session availability is ${snapshot.status}; no input was submitted.`);
      }
      if (expectedFailedTurn !== undefined) {
        // systemError alone proves neither terminal execution nor permission
        // to replay. Only the exact latest failed Turn permits this recovery.
        const page = await this.transport.request("thread/turns/list", {
          threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded"
        });
        const latest = object(arrayMember(page, "data")[0]);
        if (latest?.id !== expectedFailedTurn || latest.status !== "failed") {
          throw new Error("Codex retry has no exact failed latest Turn proof; no input was submitted.");
        }
      }
      if (expectedFailedTurn !== undefined || input.requireQuiescent) {
        const backgrounds = await this.transport.request("thread/backgroundTerminals/list", {
          threadId, limit: 1
        });
        if (!Array.isArray(backgrounds.data) || backgrounds.data.length !== 0
          || backgrounds.nextCursor !== null) {
          throw new Error("Codex retry background execution is not proven empty; no input was submitted.");
        }
      }
    } catch (error) {
      throw new CodexPreSubmissionError("Codex Session inspection failed before input submission.", { cause: error });
    }
    try {
      const result = await this.transport.request("turn/start", {
        threadId,
        ...(input.clientUserMessageId === undefined
          ? {}
          : { clientUserMessageId: text(input.clientUserMessageId, "Codex input attempt id") }),
        input: [{
          type: "text",
          text: text(input.text, "Codex Turn input"),
          text_elements: []
        }]
      });
      const turnId = optionalId(result.turnId)
        ?? optionalId(objectMember(result, "turn")?.id);
      return turnId === undefined
        ? { status: "unknown", reason: "turn/start returned no durable turn id" }
        : { status: "accepted", turnId };
    } catch (error) {
      return classifyMutationError(error);
    }
  }

  async steerTurn(input: Readonly<{
    conversationId: string;
    expectedTurnId: string;
    text: string;
    clientUserMessageId?: string;
  }>): Promise<CodexTurnAcceptance> {
    const threadId = text(input.conversationId, "Codex thread id");
    const expectedTurnId = text(input.expectedTurnId, "Codex expected Turn id");
    const snapshot = await this.readConversation(threadId).catch((error: unknown) => {
      throw new CodexPreSubmissionError("Codex Session inspection failed before native steer.", { cause: error });
    });
    if (snapshot.activeTurnId !== expectedTurnId) {
      return {
        status: "not-accepted",
        reason: snapshot.activeTurnId === undefined
          ? "expected Turn is no longer active"
          : `active Turn changed to ${snapshot.activeTurnId}`
      };
    }
    try {
      const result = await this.transport.request("turn/steer", {
        threadId,
        expectedTurnId,
        ...(input.clientUserMessageId === undefined
          ? {}
          : { clientUserMessageId: text(input.clientUserMessageId, "Codex input attempt id") }),
        input: [{
          type: "text",
          text: text(input.text, "Codex steer input"),
          text_elements: []
        }]
      });
      const acceptedTurnId = optionalId(result.turnId);
      if (acceptedTurnId === expectedTurnId) return { status: "accepted", turnId: acceptedTurnId };
      return acceptedTurnId === undefined
        ? { status: "unknown", reason: "turn/steer returned no acceptance Turn id" }
        : { status: "unknown", reason: `turn/steer returned mismatched Turn ${acceptedTurnId}` };
    } catch (error) {
      return classifyMutationError(error);
    }
  }

  async injectItems(input: Readonly<{
    conversationId: string;
    text: string;
  }>): Promise<"accepted" | "not-accepted" | "unknown" | "unavailable"> {
    const threadId = text(input.conversationId, "Codex thread id");
    try {
      await this.transport.request("thread/inject_items", {
        threadId,
        items: [{ type: "text", text: text(input.text, "Codex injected input") }]
      });
      return "accepted";
    } catch (error) {
      const classified = classifyMutationError(error);
      if (classified.status === "unknown") return "unknown";
      return isNotLoaded(error) ? "unavailable" : "not-accepted";
    }
  }

  async interruptTurn(input: Readonly<{
    conversationId: string;
    turnId: string;
  }>): Promise<"interrupted" | "not-active" | "unknown"> {
    try {
      await this.transport.request("turn/interrupt", {
        threadId: text(input.conversationId, "Codex thread id"),
        turnId: text(input.turnId, "Codex Turn id")
      });
      return "interrupted";
    } catch (error) {
      const classified = classifyMutationError(error);
      return classified.status === "not-accepted" ? "not-active" : "unknown";
    }
  }

  async listKnownDescendants(input: Readonly<{
    conversationId: string;
  }>): Promise<Readonly<{
    quality: "partial";
    threadIds: readonly string[];
  }>> {
    const threadId = text(input.conversationId, "Codex thread id");
    const result = await this.transport.request("thread/list", {
      ancestorThreadId: threadId
    });
    const candidates = arrayMember(result, "threads")
      .flatMap((entry) => optionalId(object(entry)?.id) === undefined
        ? []
        : [optionalId(object(entry)?.id)!]);
    // Ancestor filters are experimental: absence is never exact settlement.
    return { quality: "partial", threadIds: Object.freeze([...new Set(candidates)]) };
  }

  /** Exact readback for child thread IDs already persisted by Yui. */
  async queryKnownContinuations(input: Readonly<{
    providerNamespace: string;
    accountScope: string;
    conversationId: string;
    continuations: readonly Readonly<{ continuationId: string }>[];
  }>): Promise<ProviderContinuationQueryResult> {
    if (input.providerNamespace !== "openai/codex") {
      return { quality: "unavailable", continuations: [], detail: "provider mismatch" };
    }
    const observed: ProviderContinuationQueryResult["continuations"][number][] = [];
    try {
      for (const continuation of input.continuations) {
        const snapshot = await this.readConversation(continuation.continuationId);
        const state = codexContinuationState(snapshot);
        observed.push({
          key: [
            input.providerNamespace,
            input.accountScope,
            input.conversationId,
            continuation.continuationId
          ].join("\u0000"),
          ...state
        });
      }
    } catch (error) {
      return {
        quality: "unavailable",
        continuations: [],
        detail: error instanceof Error ? error.message : String(error)
      };
    }
    return { quality: "exact", continuations: Object.freeze(observed) };
  }

}

/** thread/closed unloads the client attachment; the durable thread remains resumable. */
export function codexNotificationBoundary(input: Readonly<{
  method: string;
  params: JsonRpcObject;
}>): Readonly<{
  kind: "attachment-closed" | "goal-updated" | "goal-cleared" | "turn-started" | "turn-completed" | "other";
  conversationId?: string;
  turnId?: string;
}> {
  const conversationId = optionalId(input.params.threadId)
    ?? optionalId(objectMember(input.params, "thread")?.id);
  const turnId = optionalId(input.params.turnId)
    ?? optionalId(objectMember(input.params, "turn")?.id);
  if (input.method === "thread/closed") return { kind: "attachment-closed", conversationId };
  if (input.method === "thread/goal/updated") return { kind: "goal-updated", conversationId, turnId };
  if (input.method === "thread/goal/cleared") return { kind: "goal-cleared", conversationId };
  if (input.method === "turn/started") return { kind: "turn-started", conversationId, turnId };
  if (input.method === "turn/completed") return { kind: "turn-completed", conversationId, turnId };
  return { kind: "other", conversationId, turnId };
}

export function codexGoalNotification(input: Readonly<{
  method: string;
  params: JsonRpcObject;
}>): CodexThreadGoal | null | undefined {
  const conversationId = optionalId(input.params.threadId);
  if (conversationId === undefined) return undefined;
  if (input.method === "thread/goal/cleared") return null;
  if (input.method !== "thread/goal/updated") return undefined;
  const goal = objectMember(input.params, "goal");
  if (goal === null) return undefined;
  return codexThreadGoal(goal, conversationId);
}

function parseThreadSnapshot(
  result: JsonRpcObject,
  expectedThreadId: string,
  loaded: boolean | "unknown"
): CodexThreadSnapshot {
  const thread = objectMember(result, "thread") ?? result;
  const id = optionalId(thread.id) ?? expectedThreadId;
  if (id !== expectedThreadId) throw new Error("Codex App Server returned a different thread.");
  const turns = arrayMember(thread, "turns").map(object).filter((entry): entry is JsonRpcObject => (
    entry !== null
  ));
  const active = [...turns].reverse().find((turn) => (
    ["inProgress", "in_progress", "running", "active"].includes(String(turn.status))
  ));
  const latestStatus = optionalTurnStatus(turns.at(-1)?.status);
  const turnSnapshots = turns.flatMap((turn): CodexThreadTurnSnapshot[] => {
    const turnId = optionalId(turn.id);
    if (turnId === undefined) return [];
    const status = optionalTurnStatus(turn.status);
    const output = codexTurnOutput(turn);
    const error = providerError(turn.error);
    return [{
      turnId,
      ...(status === undefined ? {} : { status }),
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
      ...(turn.error === undefined || turn.error === null ? {} : {
        rawError: serializeAgentErrorRaw(turn.error)
      })
    }];
  });
  return {
    threadId: id,
    loaded,
    status: threadStatus(thread.status),
    ...(optionalId(active?.id) === undefined ? {} : { activeTurnId: optionalId(active?.id) }),
    ...(latestStatus === undefined ? {} : { latestTurnStatus: latestStatus }),
    turns: Object.freeze(turnSnapshots),
    ...(optionalId(thread.parentThreadId) === undefined
      ? {}
      : { parentThreadId: optionalId(thread.parentThreadId) }),
    ancestorThreadIds: Object.freeze(arrayMember(thread, "ancestorThreadIds").flatMap((entry) => (
      optionalId(entry) === undefined ? [] : [optionalId(entry)!]
    ))),
    raw: result
  };
}

/** Extract the last assistant message from one native Codex Turn without rewriting it. */
export function codexTurnOutput(turn: JsonRpcObject): string | undefined {
  for (const value of [...arrayMember(turn, "items")].reverse()) {
    const item = object(value);
    if (item === null) continue;
    const type = item.type;
    const message = object(item.message);
    const agentMessage = type === "agentMessage"
      || type === "agent_message"
      || (type === "message" && (item.role === "assistant" || message?.role === "assistant"));
    if (!agentMessage) continue;
    const text = messageOutput(item) ?? (message === null ? undefined : messageOutput(message));
    if (text !== undefined) return text;
  }
  return undefined;
}

function messageOutput(message: JsonRpcObject): string | undefined {
  for (const value of [message.text, message.content]) {
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (!Array.isArray(value)) continue;
    const parts = value.flatMap((part) => {
      if (typeof part === "string" && part.trim().length > 0) return [part];
      const record = object(part);
      const text = record?.text ?? record?.content;
      return typeof text === "string" && text.trim().length > 0 ? [text] : [];
    });
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

/** Extract the provider-visible human input without copying tool or reasoning items. */
export function codexTurnInput(turn: JsonRpcObject): string | undefined {
  for (const value of arrayMember(turn, "items")) {
    const item = object(value);
    if (item === null) continue;
    const type = item.type;
    const message = object(item.message);
    const userMessage = type === "userMessage"
      || type === "user_message"
      || (type === "message" && (item.role === "user" || message?.role === "user"));
    if (!userMessage) continue;
    const text = messageText(item) ?? (message === null ? undefined : messageText(message));
    if (text !== undefined) return text;
  }
  return undefined;
}

function messageText(message: JsonRpcObject): string | undefined {
  for (const value of [message.text, message.content]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (!Array.isArray(value)) continue;
    const parts = value.flatMap((part) => {
      if (typeof part === "string" && part.trim().length > 0) return [part];
      const record = object(part);
      const text = record?.text ?? record?.content;
      return typeof text === "string" && text.trim().length > 0 ? [text] : [];
    });
    if (parts.length > 0) return parts.join("\n").trim();
  }
  return undefined;
}

function providerError(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const record = object(value);
  if (record === null) return undefined;
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }
  return JSON.stringify(record);
}

function codexThreadGoal(goal: JsonRpcObject, expectedThreadId: string): CodexThreadGoal {
  const conversationId = text(goal.threadId, "Codex Goal thread id");
  if (conversationId !== expectedThreadId) {
    throw new Error("Codex Goal belongs to a different thread.");
  }
  const status = codexGoalStatus(goal.status);
  const tokenBudget = goal.tokenBudget;
  return Object.freeze({
    conversationId,
    status,
    objective: text(goal.objective, "Codex Goal objective"),
    updatedAt: codexEpochTimestamp(goal.updatedAt),
    ...(tokenBudget === null || tokenBudget === undefined
      ? {}
      : { tokenBudget: positiveInteger(tokenBudget, "Codex Goal token budget") })
  });
}

function codexGoalStatus(value: unknown): CodexThreadGoal["status"] {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "complete":
      return value;
    case "usageLimited": return "usage-limited";
    case "budgetLimited": return "budget-limited";
    default: throw new Error("Codex Goal status is invalid.");
  }
}

function codexEpochTimestamp(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Codex Goal updatedAt is invalid.");
  }
  const epoch = value as number;
  return new Date(epoch < 1_000_000_000_000 ? epoch * 1_000 : epoch).toISOString();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} is invalid.`);
  return value as number;
}

function codexContinuationState(
  snapshot: CodexThreadSnapshot
): Omit<ProviderContinuationQueryResult["continuations"][number], "key"> {
  if (snapshot.status === "active" || snapshot.latestTurnStatus === "inProgress") {
    return {
      execution: "active",
      outcome: "pending",
      mayWriteWorkspace: true
    };
  }
  switch (snapshot.latestTurnStatus) {
    case "completed":
      return {
        execution: "quiescent",
        outcome: "succeeded",
        resultRef: snapshot.threadId,
        mayWriteWorkspace: false
      };
    case "interrupted":
      return {
        execution: "quiescent",
        outcome: "cancelled",
        resultRef: snapshot.threadId,
        mayWriteWorkspace: false
      };
    case "failed":
      return {
        execution: "quiescent",
        outcome: "failed",
        resultRef: snapshot.threadId,
        mayWriteWorkspace: false
      };
    default:
      // notLoaded and thread/closed describe App Server attachment only. An
      // idle thread without a terminal Turn is therefore still unknown.
      return {
        execution: "unknown",
        outcome: "unknown",
        mayWriteWorkspace: true
      };
  }
}

function threadStatus(value: unknown): CodexThreadSnapshot["status"] {
  const record = object(value);
  const type = record?.type;
  return type === "active" || type === "idle" || type === "systemError" || type === "notLoaded"
    ? type
    : "unknown";
}

function optionalTurnStatus(
  value: unknown
): CodexThreadSnapshot["latestTurnStatus"] | undefined {
  return value === "completed" || value === "interrupted"
    || value === "failed" || value === "inProgress"
    ? value
    : undefined;
}

function classifyMutationError(error: unknown): CodexTurnAcceptance {
  if (error instanceof CodexAppServerRequestError) {
    if (["INVALID_PARAMS", "NOT_FOUND", "TURN_NOT_ACTIVE", -32602].includes(error.code)) {
      return { status: "not-accepted", reason: error.message };
    }
  }
  return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
}

function isNotLoaded(error: unknown): boolean {
  return error instanceof CodexAppServerRequestError
    && (String(error.code).toLowerCase().includes("not_loaded")
      || error.message.toLowerCase().includes("not loaded"));
}

export function codexAppServerErrorIsMissing(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRequestError)) return false;
  if (error.code === "NOT_FOUND") return true;
  const message = error.message.toLowerCase();
  return /\b(thread|conversation)\b.*\b(not found|missing|does not exist)\b/u.test(message)
    || /\b(not found|missing|does not exist)\b.*\b(thread|conversation)\b/u.test(message);
}

function threadId(result: JsonRpcObject): string {
  return text(
    optionalId(result.threadId) ?? optionalId(objectMember(result, "thread")?.id),
    "Codex thread id"
  );
}

function object(value: unknown): JsonRpcObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRpcObject
    : null;
}

function objectMember(value: JsonRpcObject, key: string): JsonRpcObject | null {
  return object(value[key]);
}

function arrayMember(value: JsonRpcObject, key: string): readonly unknown[] {
  return Array.isArray(value[key]) ? value[key] as readonly unknown[] : [];
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.trim().length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function threadOptions(input: CodexThreadOptions): JsonRpcObject {
  return {
    ...(input.model === undefined ? {} : { model: text(input.model, "Codex model") }),
    ...(input.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: text(input.approvalPolicy, "Codex approval policy") }),
    ...(input.sandbox === undefined ? {} : { sandbox: text(input.sandbox, "Codex sandbox") }),
    ...(input.developerInstructions === undefined
      ? {}
      : {
          developerInstructions: text(
            input.developerInstructions,
            "Codex developer instructions"
          )
        }),
    ...(input.runtimeWorkspaceRoots === undefined
      ? {}
      : {
          runtimeWorkspaceRoots: input.runtimeWorkspaceRoots.map((root) => (
            text(root, "Codex runtime workspace root")
          ))
        }),
    ...(input.config === undefined ? {} : { config: { ...input.config } })
  };
}
