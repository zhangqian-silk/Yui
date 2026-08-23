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
  parentThreadId?: string;
  ancestorThreadIds: readonly string[];
  raw: JsonRpcObject;
}>;

export type CodexTurnAcceptance =
  | Readonly<{ status: "accepted"; turnId: string }>
  | Readonly<{ status: "not-accepted"; reason: string }>
  | Readonly<{ status: "unknown"; reason: string }>;

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

  async openConversation(input: Readonly<{
    cwd: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    developerInstructions?: string;
    runtimeWorkspaceRoots?: readonly string[];
  }>): Promise<Readonly<{ conversationId: string }>> {
    const result = await this.transport.request("thread/start", {
      cwd: text(input.cwd, "Codex thread cwd"),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
      ...(input.developerInstructions === undefined
        ? {}
        : { developerInstructions: input.developerInstructions }),
      ...(input.runtimeWorkspaceRoots === undefined
        ? {}
        : { runtimeWorkspaceRoots: [...input.runtimeWorkspaceRoots] })
    });
    return { conversationId: threadId(result) };
  }

  async resumeConversation(conversationId: string): Promise<CodexThreadSnapshot> {
    const id = text(conversationId, "Codex thread id");
    const result = await this.transport.request("thread/resume", { threadId: id });
    return parseThreadSnapshot(result, id, true);
  }

  async readConversation(conversationId: string): Promise<CodexThreadSnapshot> {
    const id = text(conversationId, "Codex thread id");
    const result = await this.transport.request("thread/read", {
      threadId: id,
      includeTurns: true
    });
    return parseThreadSnapshot(result, id, "unknown");
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
  }>): Promise<ProviderTurnAcceptance> {
    return this.startTurn({
      conversationId: input.conversationId,
      text: input.text,
      expectedNoActiveTurn: input.expectedNoActiveTurn,
      clientUserMessageId: input.attemptId
    });
  }

  async startTurn(input: Readonly<{
    conversationId: string;
    text: string;
    expectedNoActiveTurn: boolean;
    clientUserMessageId?: string;
  }>): Promise<CodexTurnAcceptance> {
    const requestedThreadId = text(input.conversationId, "Codex thread id");
    let threadId = requestedThreadId;
    try {
      const snapshot = await this.readConversation(requestedThreadId);
      threadId = snapshot.threadId;
      if (input.expectedNoActiveTurn && snapshot.activeTurnId !== undefined) {
        return { status: "not-accepted", reason: `active-turn:${snapshot.activeTurnId}` };
      }
    } catch (error) {
      // A new App Server thread has no materialized Turn history yet. This
      // exact response proves there cannot be an active Turn, so its first
      // mutation can proceed without weakening unknown-delivery handling.
      if (!codexAppServerErrorIsUnmaterialized(error)) throw error;
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
    const snapshot = await this.readConversation(threadId);
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
    activationId: string;
    continuations: readonly Readonly<{ continuationId: string; generation: number }>[];
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
            input.activationId,
            continuation.continuationId,
            continuation.generation
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

/** thread/closed means the loaded Activation ended; the durable thread remains resumable. */
export function codexNotificationBoundary(input: Readonly<{
  method: string;
  params: JsonRpcObject;
}>): Readonly<{
  kind: "activation-ended" | "turn-started" | "turn-completed" | "other";
  conversationId?: string;
  turnId?: string;
}> {
  const conversationId = optionalId(input.params.threadId)
    ?? optionalId(objectMember(input.params, "thread")?.id);
  const turnId = optionalId(input.params.turnId)
    ?? optionalId(objectMember(input.params, "turn")?.id);
  if (input.method === "thread/closed") return { kind: "activation-ended", conversationId };
  if (input.method === "turn/started") return { kind: "turn-started", conversationId, turnId };
  if (input.method === "turn/completed") return { kind: "turn-completed", conversationId, turnId };
  return { kind: "other", conversationId, turnId };
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
  return {
    threadId: id,
    loaded,
    status: threadStatus(thread.status),
    ...(optionalId(active?.id) === undefined ? {} : { activeTurnId: optionalId(active?.id) }),
    ...(latestStatus === undefined ? {} : { latestTurnStatus: latestStatus }),
    ...(optionalId(thread.parentThreadId) === undefined
      ? {}
      : { parentThreadId: optionalId(thread.parentThreadId) }),
    ancestorThreadIds: Object.freeze(arrayMember(thread, "ancestorThreadIds").flatMap((entry) => (
      optionalId(entry) === undefined ? [] : [optionalId(entry)!]
    ))),
    raw: result
  };
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

function codexAppServerErrorIsUnmaterialized(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRequestError) || Number(error.code) !== -32600) {
    return false;
  }
  return /\bthread\b.*\bnot materialized yet\b.*\bbefore first user message\b/iu.test(
    error.message
  );
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
