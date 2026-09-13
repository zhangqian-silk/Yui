import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import WebSocket, { type RawData } from "ws";

import {
  CodexAppServerRequestError,
  CodexAppServerRuntime,
  codexClientInitialization,
  codexGoalNotification,
  codexAppServerErrorIsMissing,
  codexTurnInput,
  codexTurnOutput
} from "./codexAppServerRuntime.js";
import type {
  AgentHostLaunchPayload,
  AgentHostProviderControl
} from "./launchBroker.js";
import { serializeAgentErrorRaw } from "./agentError.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import { AcpStructuredProviderSession } from "./acpSession.js";
import { acpDesiredSessionConfiguration } from "./acpSessionConfiguration.js";
import {
  unsupportedAgentRunConfiguration,
  type AgentRunConfigurationObservation
} from "./agentRunConfiguration.js";
import { YUI_VERSION } from "../version.js";
import {
  JsonLineChannel,
  PROVIDER_MESSAGE_MAX_BYTES,
  terminateProcessGroup,
  type JsonObject
} from "./jsonLineChannel.js";
import { PROVIDER_ACCEPT_TIMEOUT_MS } from "./runtimeDeadlines.js";

const CODEX_PROXY_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * These Session implementations do not expose run-configuration observations.
 * Do not echo launch flags as Provider confirmation.
 */
const CODEX_RUN_CONFIGURATION = unsupportedAgentRunConfiguration(
  "The Codex app-server protocol"
);
const CLAUDE_RUN_CONFIGURATION = unsupportedAgentRunConfiguration(
  "Claude Code's stream-json interface"
);

export type StructuredProviderTurnReceipt = Readonly<{
  attemptId: string;
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId?: string;
  acceptedAt: string;
  acceptance: "provider" | "transport";
}>;

export type StructuredProviderTurnInput = Readonly<{
  attemptId: string;
  boundedText: string;
  /** Exact failed native Turn whose unfinished work this input continues. */
  expectedFailedNativeTurnId?: string;
  requireQuiescent?: boolean;
}>;

export type StructuredProviderTurnStarted = Readonly<{
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  clientOwned: boolean;
  observedAt: string;
  /** Provider-visible input when the start notification exposes it. */
  input?: string;
}>;

export type StructuredProviderInputObserved = Readonly<{
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  inputId: string;
  input: string;
  observedAt: string;
}>;

export type StructuredProviderActivity = Readonly<{
  conversationId: string;
  nativeSessionId: string;
  attemptId: string;
  nativeTurnId?: string;
  id: string;
  phase: "model" | "started" | "completed" | "failed";
  observedAt: string;
}>;

export type StructuredProviderTurnTerminal = Readonly<{
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId?: string;
  /** Exact local request on this owned transport, not a Provider Turn id. */
  attemptId?: string;
  /** True only when the protocol binds this terminal to this client's exact request. */
  clientOwned: boolean;
  status: "completed" | "failed" | "cancelled";
  observedAt: string;
  /** Provider-visible input only; internal reasoning and tool items are excluded. */
  input?: string;
  output?: string;
  /** Human-readable Provider error message. */
  error?: string;
  /** Complete serialized Provider exception as received by this Driver. */
  rawError?: string;
}>;

export type StructuredProviderGoal = Readonly<{
  conversationId: string;
  status: "active" | "paused" | "blocked" | "usage-limited" | "budget-limited" | "complete";
  objective: string;
  updatedAt: string;
  nativeTurnId?: string;
  tokenBudget?: number;
}>;

export type StructuredProviderProcessExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  processInstanceId: string;
}>;

export interface StructuredProviderSession {
  /** Exact process whose exit proves the dedicated local execution drained. */
  readonly ownedProcessId?: number;
  readonly nativeAccountHome?: string;
  readonly adapterId: AgentAdapterId;
  readonly conversationId: string;
  readonly nativeSessionId: string;
  readonly processInstanceId: string;
  readonly activeTurnId: string | undefined;
  /**
   * Whether *this* connection proved its Conversation can be rebound by a
   * later process.
   *
   * A Driver capability states what the protocol allows; some protocols settle
   * it per connection instead. ACP negotiates `agentCapabilities.loadSession`
   * during `initialize`, so two Agents on the same adapter can genuinely
   * disagree. A Session that knows the answer reports it here and the Host
   * prefers it; a Session that omits it leaves the Driver capability standing.
   */
  readonly conversationRecoverability?: "recoverable" | "unknown";
  /**
   * What this Session is running under, as the Agent itself reports it.
   *
   * Read on every access rather than stored, because an Agent may change its own
   * configuration mid-Session; a value cached at launch would keep being
   * presented as current. Implementations with no observation reader answer
   * `unsupported` with the reason, which is a
   * different fact from having nothing to say and must not be rendered as
   * agreement with what Yui requested.
   */
  readonly runConfiguration: AgentRunConfigurationObservation;
  submitTurn(turn: StructuredProviderTurnInput): Promise<StructuredProviderTurnReceipt>;
  steerTurn(turn: StructuredProviderTurnInput): Promise<StructuredProviderTurnReceipt>;
  cancelTurn(attemptId: string): Promise<"requested" | "not-active" | "unknown">;
  waitForExit(): Promise<StructuredProviderProcessExit>;
  terminate(signal: NodeJS.Signals): void;
}

export class ProviderDeliveryUnknownError extends Error {
  readonly name = "ProviderDeliveryUnknownError";

  constructor(
    message: string,
    readonly attemptId: string,
    // Wrapping must not become the end of the causal chain: the original
    // transport or Controller failure is the reason a reader needs.
    options?: Readonly<{ cause?: unknown }>
  ) {
    super(message, options);
  }
}

export class ProviderTurnRejectedError extends Error {
  readonly name = "ProviderTurnRejectedError";

  constructor(
    message: string,
    readonly attemptId: string,
    options?: Readonly<{ cause?: unknown }>
  ) {
    super(message, options);
  }
}

/** Another ordinary client currently owns the thread's active Turn. */
export class ProviderTurnBusyError extends Error {
  readonly name = "ProviderTurnBusyError";

  constructor(
    message: string,
    readonly attemptId: string,
    readonly activeTurnId?: string
  ) {
    super(message);
  }
}

export class ProviderConversationMissingError extends Error {
  readonly name = "ProviderConversationMissingError";

  constructor(readonly conversationId: string, message: string) {
    super(message);
  }
}

export async function startStructuredProviderSession(
  payload: AgentHostLaunchPayload,
  input: Readonly<{
    onAccepted?: (receipt: StructuredProviderTurnReceipt) => void;
    onActivity?: (activity: StructuredProviderActivity) => void;
    onStarted?: (started: StructuredProviderTurnStarted) => void;
    onTerminal?: (terminal: StructuredProviderTurnTerminal) => void;
    onGoal?: (goal: StructuredProviderGoal | null) => void;
    onInput?: (input: StructuredProviderInputObserved) => void;
    mirrorOutput?: (stream: "stdout" | "stderr", text: string) => void;
  }> = {}
): Promise<Readonly<{
  session: StructuredProviderSession;
  recoveredTerminal?: StructuredProviderTurnTerminal;
  goal?: StructuredProviderGoal | null;
}>> {
  const control = payload.providerControl;
  if (control === undefined) {
    throw new Error("Managed Agent Host launch requires Provider control metadata.");
  }
  const ownedClaude = control.adapterId === "claude" && control.transport !== "acp-stdio";
  const child = spawn(
    ownedClaude ? fileURLToPath(new URL("./claude-process-owner", import.meta.url)) : payload.command,
    ownedClaude ? [payload.command, ...payload.args] : [...payload.args], {
    cwd: payload.cwd,
    env: { ...payload.environment },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });
  const processInstanceId = randomUUID();
  const mirror = input.mirrorOutput ?? defaultMirrorOutput;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => mirror("stderr", chunk));
  const exit = childExit(child, processInstanceId);
  try {
    // Dispatch is on the negotiated transport, not on a product name: every
    // Agent that speaks a given transport is opened by the same code.
    if (control.transport === "acp-stdio") {
      const session = await AcpStructuredProviderSession.open({
        child,
        exit,
        processInstanceId,
        clientVersion: YUI_VERSION,
        cwd: payload.cwd,
        ...(control.acpSession?.additionalDirectories === undefined
          ? {}
          : { additionalDirectories: control.acpSession.additionalDirectories }),
        ...(control.acpSession?.sessionBootstrap === undefined
          ? {}
          : { sessionBootstrap: control.acpSession.sessionBootstrap }),
        ...(control.acpSession?.desiredConfiguration === undefined
          ? {}
          : {
              desiredConfiguration: acpDesiredSessionConfiguration(
                control.acpSession.desiredConfiguration
              )
            }),
        // The product identity comes from the Agent binding the launch was
        // compiled from. It is needed for one decision only — which mode value
        // grants bypass — and is never inferred from the command that was run.
        ...(control.component === undefined ? {} : { component: control.component }),
        ...(control.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: control.nativeSessionId }),
        ...(input.onTerminal === undefined ? {} : { onTerminal: input.onTerminal }),
        mirror
      });
      return Object.freeze({ session });
    }
    if (control.adapterId === "codex") {
      const opened = await CodexStructuredProviderSession.open(
          child,
          exit,
          processInstanceId,
          payload,
          control,
          input.onStarted,
          input.onTerminal,
          input.onGoal,
          input.onInput,
          input.onActivity,
          mirror
        );
      return Object.freeze({
        session: opened.session,
        ...(opened.recoveredTerminal === undefined
          ? {}
          : { recoveredTerminal: opened.recoveredTerminal }),
        goal: opened.goal
      });
    }
    const session = await ClaudeStructuredProviderSession.open(
          child,
          exit,
          processInstanceId,
          control,
          input.onAccepted,
          input.onTerminal,
          input.onGoal,
          input.onActivity,
          mirror
        );
    return Object.freeze({ session });
  } catch (error) {
    terminateProcessGroup(child, "SIGTERM");
    throw error;
  }
}

/**
 * Open an uninitialized, transparent connection for a native TUI. The TUI
 * owns its requests; Yui observes only its exact startup response.
 */
export async function openCodexInteractiveConnection(
  launch: Pick<AgentHostLaunchPayload, "command" | "args" | "environment" | "cwd">
): Promise<CodexProxyWebSocketChannel> {
  const child = spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: { ...launch.environment },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });
  child.stderr.resume();
  try {
    return await CodexProxyWebSocketChannel.connect(child, () => {});
  } catch (error) {
    terminateProcessGroup(child, "SIGTERM");
    throw error;
  }
}

class CodexProxyWebSocketChannel {
  readonly #pending = new Map<string, Readonly<{
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout | undefined;
  }>>();
  readonly #listeners = new Set<(message: JsonObject) => void>();
  readonly #closeListeners = new Set<(error: Error) => void>();
  #nextId = 1;
  #closedError: Error | undefined;
  #ready = false;
  readonly #readyPromise: Promise<void>;
  readonly #resolveReady: () => void;
  readonly #rejectReady: (error: Error) => void;
  readonly #webSocket: WebSocket;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly mirror: (stream: "stdout" | "stderr", text: string) => void
  ) {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.#readyPromise = new Promise<void>((resolvePromise, reject) => {
      resolveReady = resolvePromise;
      rejectReady = reject;
    });
    this.#resolveReady = resolveReady;
    this.#rejectReady = rejectReady;
    const transport = new ChildProcessDuplex(child);
    this.#webSocket = new WebSocket("ws://localhost/rpc", {
      createConnection: () => transport as unknown as Socket,
      handshakeTimeout: CODEX_PROXY_HANDSHAKE_TIMEOUT_MS,
      maxPayload: PROVIDER_MESSAGE_MAX_BYTES,
      perMessageDeflate: false
    });
    this.#webSocket.once("open", () => {
      this.#ready = true;
      this.#resolveReady();
    });
    this.#webSocket.on("message", (data, isBinary) => this.#receive(data, isBinary));
    this.#webSocket.on("error", (error) => this.#close(error));
    this.#webSocket.once("close", (code, reason) => this.#close(new Error(
      `Codex App Server proxy WebSocket closed (code=${code}, reason=${reason.toString() || "none"}).`
    )));
    child.once("error", (error) => this.#close(error));
    child.once("close", (code, signal) => this.#close(new Error(
      `Provider process exited before replying (code=${code ?? "none"}, signal=${signal ?? "none"}).`
    )));
  }

  static async connect(
    child: ChildProcessWithoutNullStreams,
    mirror: (stream: "stdout" | "stderr", text: string) => void
  ): Promise<CodexProxyWebSocketChannel> {
    const channel = new CodexProxyWebSocketChannel(child, mirror);
    await channel.#readyPromise;
    return channel;
  }

  onMessage(listener: (message: JsonObject) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.#closedError !== undefined) listener(this.#closedError);
    else this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    this.#webSocket.terminate();
    this.#close(new Error("Codex App Server proxy client closed."));
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    await this.#readyPromise;
    if (this.#closedError !== undefined) throw this.#closedError;
    const id = String(this.#nextId++);
    const response = new Promise<JsonObject>((resolvePromise, reject) => {
      // A live turn submission may legitimately outlast the observation
      // deadline. Retain its exact callback until acknowledgement or actual
      // disconnect; a clock alone is not evidence of unknown delivery.
      const timer = method === "turn/start" || method === "turn/steer" ? undefined : setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Provider request timed out: ${method}.`));
      }, PROVIDER_ACCEPT_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer });
    });
    try {
      await this.send({ id, method, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error as Error);
      }
    }
    return await response;
  }

  async notify(method: string, params?: JsonObject): Promise<void> {
    await this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  async send(message: JsonObject): Promise<void> {
    await this.#readyPromise;
    if (this.#closedError !== undefined) throw this.#closedError;
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, "utf8") > PROVIDER_MESSAGE_MAX_BYTES) {
      throw new Error("Provider request exceeds its message bound.");
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.#webSocket.send(encoded, (error) => {
        if (error === undefined || error === null) resolvePromise();
        else reject(error);
      });
    });
  }

  #receive(data: RawData, isBinary: boolean): void {
    const encoded = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.concat(data);
    if (isBinary || encoded.byteLength > PROVIDER_MESSAGE_MAX_BYTES) {
      this.#close(new Error(isBinary
        ? "Provider returned an unsupported binary WebSocket message."
        : "Provider response message exceeds its bound."));
      terminateProcessGroup(this.child, "SIGTERM");
      return;
    }
    const text = encoded.toString("utf8");
    this.mirror("stdout", `${text}\n`);
    let message: JsonObject;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as JsonObject;
    } catch {
      return;
    }
    const id = requestId(message.id);
    const pending = id === undefined ? undefined : this.#pending.get(id);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.#pending.delete(id!);
      const error = object(message.error);
      if (error !== null) {
        pending.reject(new CodexAppServerRequestError(
          typeof error.code === "number" || typeof error.code === "string"
            ? error.code
            : "UNKNOWN",
          typeof error.message === "string" ? error.message : "Provider request failed.",
          error.data
        ));
      } else {
        pending.resolve(object(message.result) ?? {});
      }
      return;
    }
    for (const listener of this.#listeners) listener(message);
  }

  #close(error: Error): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = error;
    if (!this.#ready) this.#rejectReady(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      terminateProcessGroup(this.child, "SIGTERM");
    }
  }
}

class ChildProcessDuplex extends Duplex {
  readonly connecting = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.once("end", () => this.push(null));
    child.once("error", (error) => this.destroy(error));
    child.once("close", () => this.destroy());
  }

  override _read(): void {
    this.child.stdout.resume();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.child.stdin.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end(callback);
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  setTimeout(_timeout: number, callback?: () => void): this {
    if (callback !== undefined) this.once("timeout", callback);
    return this;
  }
}

class CodexStructuredProviderSession implements StructuredProviderSession {
  readonly #turnAttempts = new Map<string, string>();
  readonly adapterId = "codex" as const;
  #activeTurnId: string | undefined;
  #clientOwnedTurnId: string | undefined;
  #clientOwnedAttemptId: string | undefined;
  #submissionPending = false;
  readonly #bufferedStarts: Array<Omit<StructuredProviderTurnStarted, "clientOwned">> = [];
  readonly #bufferedTerminals: Array<Omit<StructuredProviderTurnTerminal, "clientOwned">> = [];
  readonly #bufferedActivities: Array<Omit<StructuredProviderActivity, "attemptId"> & { nativeTurnId: string }> = [];

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exit: Promise<StructuredProviderProcessExit>,
    readonly processInstanceId: string,
    readonly conversationId: string,
    private readonly runtime: CodexAppServerRuntime,
    private readonly onStarted:
      | ((started: StructuredProviderTurnStarted) => void)
      | undefined,
    private readonly onTerminal:
      | ((terminal: StructuredProviderTurnTerminal) => void)
      | undefined,
    private readonly onGoal: ((goal: StructuredProviderGoal | null) => void) | undefined,
    private readonly onInput: ((input: StructuredProviderInputObserved) => void) | undefined,
    private readonly onActivity: ((activity: StructuredProviderActivity) => void) | undefined,
    readonly nativeAccountHome?: string
  ) {}

  static async open(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<StructuredProviderProcessExit>,
    processInstanceId: string,
    payload: AgentHostLaunchPayload,
    control: AgentHostProviderControl,
    onStarted: ((started: StructuredProviderTurnStarted) => void) | undefined,
    onTerminal: ((terminal: StructuredProviderTurnTerminal) => void) | undefined,
    onGoal: ((goal: StructuredProviderGoal | null) => void) | undefined,
    onInput: ((input: StructuredProviderInputObserved) => void) | undefined,
    onActivity: ((activity: StructuredProviderActivity) => void) | undefined,
    mirror: (stream: "stdout" | "stderr", text: string) => void
  ): Promise<Readonly<{
    session: CodexStructuredProviderSession;
    recoveredTerminal?: StructuredProviderTurnTerminal;
    goal: StructuredProviderGoal | null;
  }>> {
    const channel = await CodexProxyWebSocketChannel.connect(child, mirror);
    const openingMessages: JsonObject[] = [];
    const stopOpeningBuffer = channel.onMessage((message) => openingMessages.push(message));
    const initialized = await channel.request("initialize", codexClientInitialization());
    await channel.notify("initialized");
    const runtime = new CodexAppServerRuntime(channel);
    let conversationId: string;
    let resumedActiveTurnId: string | undefined;
    let resumedTurns: import("./codexAppServerRuntime.js").CodexThreadSnapshot["turns"] = [];
    if (control.mode === "new") {
      conversationId = (await runtime.openConversation({
        cwd: payload.cwd,
        ...control.codexThread!
      })).conversationId;
    } else {
      try {
        const resumed = await runtime.resumeConversation(control.nativeSessionId!, {
          cwd: payload.cwd,
          ...control.codexThread!
        });
        conversationId = resumed.threadId;
        resumedActiveTurnId = resumed.activeTurnId;
        resumedTurns = resumed.turns;
      } catch (error) {
        if (codexAppServerErrorIsMissing(error)) {
          throw new ProviderConversationMissingError(
            control.nativeSessionId!,
            `Codex Conversation is exactly missing: ${control.nativeSessionId}.`
          );
        }
        throw error;
      }
    }
    if (control.sessionTitle !== undefined) {
      await runtime.setConversationName({
        conversationId,
        name: control.sessionTitle
      });
    }
    const session = new CodexStructuredProviderSession(
      child,
      exit,
      processInstanceId,
      conversationId,
      runtime,
      onStarted,
      onTerminal,
      onGoal,
      onInput,
      onActivity,
      optionalId(initialized.codexHome)
    );
    session.#activeTurnId = resumedActiveTurnId;
    const ownedTurn = control.kind === "restore" ? control.ownedTurn : undefined;
    session.#clientOwnedTurnId = ownedTurn?.turnId;
    session.#clientOwnedAttemptId = ownedTurn?.attemptId;
    if (ownedTurn !== undefined) session.#turnAttempts.set(ownedTurn.turnId, ownedTurn.attemptId);
    stopOpeningBuffer();
    let recoveredTerminal: StructuredProviderTurnTerminal | undefined;
    for (const message of openingMessages) {
      const terminal = session.#observeMessage(message, false);
      if (terminal?.clientOwned === true) recoveredTerminal = terminal;
    }
    channel.onMessage((message) => {
      session.#observeMessage(message, true);
    });
    if (ownedTurn !== undefined && recoveredTerminal === undefined
      && session.#activeTurnId !== ownedTurn.turnId) {
      const recovered = resumedTurns.find((turn) => turn.turnId === ownedTurn.turnId);
      if (recovered?.status === "completed"
        || recovered?.status === "interrupted"
        || recovered?.status === "failed") {
        recoveredTerminal = {
          conversationId,
          nativeSessionId: conversationId,
          nativeTurnId: ownedTurn.turnId,
          attemptId: ownedTurn.attemptId,
          clientOwned: true,
          status: recovered.status === "failed"
            ? "failed"
            : recovered.status === "interrupted" ? "cancelled" : "completed",
          observedAt: new Date().toISOString(),
          ...(recovered.output === undefined ? {} : { output: recovered.output }),
          ...(recovered.status !== "failed"
            ? {}
            : {
                error: recovered.error ?? "Provider Turn failed.",
                ...(recovered.rawError === undefined ? {} : { rawError: recovered.rawError })
              })
        };
        session.#clientOwnedTurnId = undefined;
        session.#clientOwnedAttemptId = undefined;
      } else {
        throw new ProviderDeliveryUnknownError(
          `Codex resume could not recover the persisted Yui Turn ${ownedTurn.turnId}.`,
          ownedTurn.attemptId
        );
      }
    }
    const goal = await runtime.readGoal(conversationId);
    return Object.freeze({
      session,
      ...(recoveredTerminal === undefined ? {} : { recoveredTerminal }),
      goal
    });
  }

  #observeMessage(
    message: JsonObject,
    emit: boolean
  ): StructuredProviderTurnTerminal | undefined {
      const method = typeof message.method === "string" ? message.method : "";
      const params = object(message.params) ?? {};
      if (optionalId(params.threadId) !== this.conversationId) return undefined;
      const goal = codexGoalNotification({ method, params });
      if (goal !== undefined) {
        if (emit) this.onGoal?.(goal);
        return undefined;
      }
      if (emit && (method === "item/started" || method === "item/completed"
        || method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta")) {
        const item = object(params.item);
        const id = optionalId(item?.id) ?? optionalId(params.itemId);
        const nativeTurnId = optionalId(params.turnId);
        const tool = ["commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange"].includes(String(item?.type));
        const model = ["agentMessage", "reasoning"].includes(String(item?.type)) || method.endsWith("Delta") || method.endsWith("/delta");
        if (id !== undefined && nativeTurnId !== undefined && (tool || model)) {
          const activity = {
            conversationId: this.conversationId, nativeSessionId: this.conversationId,
            nativeTurnId, id, observedAt: new Date().toISOString(),
            phase: model ? "model" as const : method === "item/started" ? "started" as const
              : item?.status === "failed" || (typeof item?.exitCode === "number" && item.exitCode !== 0)
                ? "failed" as const : "completed" as const
          };
          if (this.#submissionPending) this.#bufferedActivities.push(activity);
          else this.#emitActivity(activity);
        }
      }
      if (method === "item/completed") {
        const item = object(params.item);
        const nativeTurnId = optionalId(params.turnId);
        const inputId = optionalId(item?.id);
        const input = item === null ? undefined : codexTurnInput({ items: [item] });
        if (emit && nativeTurnId !== undefined && inputId !== undefined && input !== undefined) {
          this.onInput?.({ conversationId: this.conversationId, nativeSessionId: this.conversationId,
            nativeTurnId, inputId, input, observedAt: new Date().toISOString() });
        }
        return undefined;
      }
      if (method === "turn/started") {
        const turnId = nestedId(params, "turn") ?? optionalId(params.turnId);
        if (turnId !== undefined) {
          this.#activeTurnId = turnId;
          const turn = object(params.turn) ?? {};
          const input = codexTurnInput(turn);
          const started = {
            conversationId: this.conversationId,
            nativeSessionId: this.conversationId,
            nativeTurnId: turnId,
            observedAt: new Date().toISOString(),
            ...(input === undefined ? {} : { input })
          };
          if (this.#submissionPending && emit) this.#bufferedStarts.push(started);
          else if (emit) this.#emitStarted(started);
        }
        return undefined;
      }
      if (method !== "turn/completed") return undefined;
      const turn = object(params.turn) ?? {};
      const nativeTurnId = optionalId(turn.id) ?? optionalId(params.turnId);
      if (nativeTurnId === undefined) return undefined;
      const status = turn.status === "failed"
        ? "failed"
        : turn.status === "interrupted" ? "cancelled" : "completed";
      const failure = status === "failed"
        ? providerErrorEvidence(turn.error)
        : undefined;
      const output = codexTurnOutput(turn);
      const input = codexTurnInput(turn);
      const terminal = {
        conversationId: this.conversationId,
        nativeSessionId: this.conversationId,
        nativeTurnId,
        status,
        observedAt: new Date().toISOString(),
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        ...(failure === undefined ? {} : failure)
      } as const;
      if (this.#submissionPending && emit) {
        this.#bufferedTerminals.push(terminal);
        return undefined;
      }
      return this.#completeTerminal(terminal, emit);
  }

  get nativeSessionId(): string {
    return this.conversationId;
  }

  get activeTurnId(): string | undefined {
    return this.#activeTurnId;
  }

  /**
   * This implementation has no run-configuration observation reader.
   */
  get runConfiguration(): AgentRunConfigurationObservation {
    return CODEX_RUN_CONFIGURATION;
  }

  async submitTurn(
    turn: StructuredProviderTurnInput
  ): Promise<StructuredProviderTurnReceipt> {
    if (this.#activeTurnId !== undefined) {
      throw new ProviderTurnBusyError(
        `Provider Conversation already has active Turn ${this.#activeTurnId}.`,
        turn.attemptId,
        this.#activeTurnId
      );
    }
    this.#submissionPending = true;
    try {
      const acceptance = await this.runtime.submitTurn({
        conversationId: this.conversationId,
        attemptId: turn.attemptId,
        text: turn.boundedText,
        expectedNoActiveTurn: true,
        ...(turn.requireQuiescent ? { requireQuiescent: true } : {}),
        ...(turn.expectedFailedNativeTurnId === undefined ? {} : {
          expectedFailedNativeTurnId: turn.expectedFailedNativeTurnId
        })
      });
      if (acceptance.status === "unknown") {
        throw new ProviderDeliveryUnknownError(acceptance.reason, turn.attemptId);
      }
      if (acceptance.status === "busy") {
        throw new ProviderTurnBusyError(
          acceptance.reason,
          turn.attemptId,
          acceptance.activeTurnId
        );
      }
      if (acceptance.status === "not-accepted") {
        throw new ProviderTurnRejectedError(acceptance.reason, turn.attemptId);
      }
      this.#activeTurnId = acceptance.turnId;
      this.#clientOwnedTurnId = acceptance.turnId;
      this.#clientOwnedAttemptId = turn.attemptId;
      this.#turnAttempts.set(acceptance.turnId, turn.attemptId);
      return Object.freeze({
        attemptId: turn.attemptId,
        conversationId: this.conversationId,
        nativeSessionId: this.conversationId,
        nativeTurnId: acceptance.turnId,
        acceptedAt: new Date().toISOString(),
        acceptance: "provider"
      });
    } finally {
      this.#submissionPending = false;
      const starts = this.#bufferedStarts.splice(0);
      for (const started of starts) this.#emitStarted(started);
      const buffered = this.#bufferedTerminals.splice(0);
      for (const activity of this.#bufferedActivities.splice(0)) this.#emitActivity(activity);
      for (const terminal of buffered) this.#emitTerminal(terminal);
    }
  }

  async steerTurn(turn: StructuredProviderTurnInput): Promise<StructuredProviderTurnReceipt> {
    const nativeTurnId = this.#activeTurnId;
    if (nativeTurnId === undefined) {
      throw new ProviderTurnRejectedError("Provider Conversation has no active Turn to steer.", turn.attemptId);
    }
    const acceptance = await this.runtime.steerTurn({
      conversationId: this.conversationId,
      expectedTurnId: nativeTurnId,
      text: turn.boundedText,
      clientUserMessageId: turn.attemptId
    });
    if (acceptance.status === "unknown") {
      throw new ProviderDeliveryUnknownError(acceptance.reason, turn.attemptId);
    }
    if (acceptance.status !== "accepted") {
      throw new ProviderTurnRejectedError(acceptance.reason, turn.attemptId);
    }
    return Object.freeze({
      attemptId: turn.attemptId,
      conversationId: this.conversationId,
      nativeSessionId: this.conversationId,
      nativeTurnId,
      acceptedAt: new Date().toISOString(),
      acceptance: "provider"
    });
  }

  #emitTerminal(terminal: Omit<StructuredProviderTurnTerminal, "clientOwned">): void {
    this.#completeTerminal(terminal, true);
  }

  #emitActivity(activity: Omit<StructuredProviderActivity, "attemptId"> & { nativeTurnId: string }): void {
    const attemptId = this.#turnAttempts.get(activity.nativeTurnId);
    if (attemptId !== undefined) this.onActivity?.({ ...activity, attemptId });
  }

  #emitStarted(started: Omit<StructuredProviderTurnStarted, "clientOwned">): void {
    this.onStarted?.({
      ...started,
      clientOwned: started.nativeTurnId === this.#clientOwnedTurnId
    });
  }

  #completeTerminal(
    terminal: Omit<StructuredProviderTurnTerminal, "clientOwned">,
    emit: boolean
  ): StructuredProviderTurnTerminal {
    const attemptId = terminal.nativeTurnId === undefined ? undefined
      : this.#turnAttempts.get(terminal.nativeTurnId);
    const clientOwned = attemptId !== undefined;
    if (terminal.nativeTurnId === this.#activeTurnId) this.#activeTurnId = undefined;
    if (terminal.nativeTurnId === this.#clientOwnedTurnId) {
      this.#clientOwnedTurnId = undefined;
      this.#clientOwnedAttemptId = undefined;
    }
    const completed = {
      ...terminal,
      clientOwned,
      ...(attemptId === undefined ? {} : { attemptId })
    };
    if (emit) this.onTerminal?.(completed);
    return completed;
  }

  waitForExit(): Promise<StructuredProviderProcessExit> {
    return this.exit;
  }

  async cancelTurn(attemptId: string): Promise<"requested" | "not-active" | "unknown"> {
    if (this.#clientOwnedAttemptId !== attemptId || this.#clientOwnedTurnId === undefined) {
      return this.#submissionPending ? "unknown" : "not-active";
    }
    const result = await this.runtime.interruptTurn({
      conversationId: this.conversationId,
      turnId: this.#clientOwnedTurnId
    });
    return result === "interrupted" ? "requested" : result;
  }

  terminate(signal: NodeJS.Signals): void {
    terminateProcessGroup(this.child, signal);
  }
}

class ClaudeStructuredProviderSession implements StructuredProviderSession {
  readonly adapterId = "claude" as const;
  get ownedProcessId(): number | undefined { return this.child.pid; }
  #activeAttemptId: string | undefined;
  #acceptedAttemptId: string | undefined;
  #cancelledAttemptId: string | undefined;
  readonly #seenAssistantIds = new Set<string>();
  readonly #openToolIds = new Set<string>();
  readonly #resultAttempts = new Map<string, string>();
  #lastGoalKey: string | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exit: Promise<StructuredProviderProcessExit>,
    readonly processInstanceId: string,
    readonly conversationId: string,
    private readonly channel: JsonLineChannel,
    private readonly onGoal: ((goal: StructuredProviderGoal | null) => void) | undefined
  ) {}

  static async open(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<StructuredProviderProcessExit>,
    processInstanceId: string,
    control: AgentHostProviderControl,
    onAccepted: ((receipt: StructuredProviderTurnReceipt) => void) | undefined,
    onTerminal: ((terminal: StructuredProviderTurnTerminal) => void) | undefined,
    onGoal: ((goal: StructuredProviderGoal | null) => void) | undefined,
    onActivity: ((activity: StructuredProviderActivity) => void) | undefined,
    mirror: (stream: "stdout" | "stderr", text: string) => void
  ): Promise<ClaudeStructuredProviderSession> {
    const channel = new JsonLineChannel(child, mirror);
    const nativeSessionId = control.nativeSessionId;
    if (nativeSessionId === undefined) {
      throw new Error("Managed Claude launch requires a preallocated native Session id.");
    }
    const session = new ClaudeStructuredProviderSession(
      child,
      exit,
      processInstanceId,
      nativeSessionId,
      channel,
      onGoal
    );
    channel.onMessage((message) => session.#receive(message, onTerminal, onAccepted, onActivity));
    // This client owns the whole Claude execution process, unlike a Codex
    // proxy. An exit without a result ends the exact local input as failure,
    // not as continuing work merely because the supervising Host is alive.
    void exit.then(result => {
      const attemptId = session.#activeAttemptId;
      if (attemptId === undefined) return;
      session.#activeAttemptId = undefined;
      onTerminal?.({
        conversationId: nativeSessionId, nativeSessionId, attemptId,
        clientOwned: true,
        status: session.#cancelledAttemptId === attemptId ? "cancelled" : "failed",
        observedAt: new Date().toISOString(),
        error: `Owned Provider process exited before a terminal result (code=${result.code}, signal=${result.signal}).`
      });
    });
    return session;
  }

  get nativeSessionId(): string {
    return this.conversationId;
  }

  get activeTurnId(): string | undefined {
    // stream-json result.uuid is a message identity, not an execution identity.
    return undefined;
  }

  /**
   * This implementation has no run-configuration observation reader.
   */
  get runConfiguration(): AgentRunConfigurationObservation {
    return CLAUDE_RUN_CONFIGURATION;
  }

  async submitTurn(
    turn: StructuredProviderTurnInput
  ): Promise<StructuredProviderTurnReceipt> {
    if (this.#activeAttemptId !== undefined) {
      throw new ProviderTurnBusyError(
        "Provider Conversation already has an unsettled Turn.",
        turn.attemptId
      );
    }
    // Reserve before the pipe write: a fast result can precede its callback.
    // A failed write is ambiguous and must retain the same occupancy.
    this.#activeAttemptId = turn.attemptId;
    try {
      await this.channel.send({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: turn.boundedText }]
        }
      });
    } catch (error) {
      throw new ProviderDeliveryUnknownError(
        `Claude input write did not complete: ${
          error instanceof Error ? error.message : String(error)
        }`,
        turn.attemptId,
        { cause: error }
      );
    }
    // AgentHost is the sole writer to this dedicated stream-json process.
    // A pipe write is transport evidence only. The later result establishes
    // native acceptance and completion through this exact serialized local
    // attempt. A main assistant response can confirm acceptance earlier, without
    // inventing a provider execution id or trusting the echoed user input.
    return Object.freeze({
      attemptId: turn.attemptId,
      conversationId: this.conversationId,
      nativeSessionId: this.conversationId,
      acceptedAt: new Date().toISOString(),
      acceptance: "transport"
    });
  }

  async steerTurn(turn: StructuredProviderTurnInput): Promise<StructuredProviderTurnReceipt> {
    throw new ProviderTurnRejectedError(
      "Claude stream-json does not expose an exact native Turn identity for steering.",
      turn.attemptId
    );
  }

  async cancelTurn(attemptId: string): Promise<"requested" | "not-active" | "unknown"> {
    if (this.#activeAttemptId !== attemptId) return "not-active";
    this.#cancelledAttemptId = attemptId;
    terminateProcessGroup(this.child, "SIGTERM");
    return "requested";
  }

  waitForExit(): Promise<StructuredProviderProcessExit> {
    return this.exit;
  }

  terminate(signal: NodeJS.Signals): void {
    terminateProcessGroup(this.child, signal);
  }

  #receive(
    message: JsonObject,
    onTerminal: ((terminal: StructuredProviderTurnTerminal) => void) | undefined,
    onAccepted: ((receipt: StructuredProviderTurnReceipt) => void) | undefined,
    onActivity: ((activity: StructuredProviderActivity) => void) | undefined
  ): void {
    const goal = claudeActiveGoal(message, this.conversationId);
    if (goal !== undefined) {
      const key = JSON.stringify(goal === null ? null : {
        status: goal.status,
        objective: goal.objective,
        tokenBudget: goal.tokenBudget
      });
      if (key !== this.#lastGoalKey) {
        this.#lastGoalKey = key;
        this.onGoal?.(goal);
      }
    }
    const activity = (id: string, phase: StructuredProviderActivity["phase"]) => {
      if (this.#activeAttemptId !== undefined) onActivity?.({
        conversationId: this.conversationId, nativeSessionId: this.conversationId,
        attemptId: this.#activeAttemptId, id, phase, observedAt: new Date().toISOString()
      });
    };
    if (message.type === "user") {
      if (optionalId(message.session_id) !== this.conversationId || message.parent_tool_use_id != null) return;
      const body = object(message.message);
      for (const raw of Array.isArray(body?.content) ? body.content : []) {
        const block = object(raw), id = optionalId(block?.tool_use_id);
        if (block?.type === "tool_result" && id !== undefined && this.#openToolIds.delete(id)) {
          activity(id, block.is_error === true ? "failed" : "completed");
        }
      }
      return;
    }
    if (message.type === "assistant") {
      if (optionalId(message.session_id) !== this.conversationId
        || message.parent_tool_use_id != null
        || object(message.message)?.role !== "assistant") return;
      const messageId = optionalId(message.uuid);
      if (messageId === undefined || this.#seenAssistantIds.has(messageId)) return;
      this.#seenAssistantIds.add(messageId);
      const attemptId = this.#activeAttemptId;
      if (attemptId === undefined) return;
      // This dedicated stream has exactly one owned input in flight. Main
      // assistant output proves it is being processed; init, echo and child
      // output do not. Keep the local attempt identity, not the message UUID,
      // as the correlation key (Claude exposes no exact native Turn id).
      if (this.#acceptedAttemptId !== attemptId) {
        this.#acceptedAttemptId = attemptId;
        onAccepted?.({
        attemptId,
        conversationId: this.conversationId,
        nativeSessionId: this.conversationId,
        acceptedAt: new Date().toISOString(),
        acceptance: "provider"
        });
      }
      const body = object(message.message);
      for (const raw of Array.isArray(body?.content) ? body.content : []) {
        const block = object(raw), id = optionalId(block?.id);
        if (block?.type === "tool_use" && id !== undefined && !this.#openToolIds.has(id)) {
          this.#openToolIds.add(id); activity(id, "started");
        } else if (block?.type === "text" || block?.type === "thinking") {
          activity(messageId, "model");
        }
      }
      return;
    }
    if (message.type !== "result"
      || optionalId(message.session_id) !== this.conversationId) return;
    // A result UUID identifies this message, not the Provider execution.
    // Retain its local association so a delayed duplicate cannot be assigned
    // to a successor request on the same long-lived process.
    const resultId = optionalId(message.uuid);
    const priorAttempt = resultId === undefined ? undefined : this.#resultAttempts.get(resultId);
    const attemptId = priorAttempt ?? this.#activeAttemptId;
    if (attemptId === undefined) return;
    if (resultId !== undefined) this.#resultAttempts.set(resultId, attemptId);
    if (attemptId === this.#activeAttemptId) {
      this.#activeAttemptId = undefined;
      this.#openToolIds.clear();
    }
    const failed = message.is_error === true || message.subtype === "error_during_execution";
    const result = typeof message.result === "string" && message.result.length > 0
      ? message.result
      : providerErrorEvidence(message).error;
    onTerminal?.({
      conversationId: this.conversationId,
      nativeSessionId: this.conversationId,
      attemptId,
      clientOwned: true,
      status: failed ? "failed" : "completed",
      observedAt: new Date().toISOString(),
      ...(failed
        ? { error: result, rawError: providerErrorEvidence(message).rawError }
        : typeof message.result === "string" && message.result.length > 0
          ? { output: message.result }
          : {})
    });
  }
}

function claudeActiveGoal(
  message: JsonObject,
  conversationId: string
): StructuredProviderGoal | null | undefined {
  if (!Object.hasOwn(message, "active_goal")) return undefined;
  if (message.active_goal === null) return null;
  const raw = object(message.active_goal);
  if (raw === null) return undefined;
  const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
  if (objective.length === 0) return undefined;
  const status = providerGoalStatus(raw.status);
  if (status === undefined) return undefined;
  const tokenBudget = positiveOptionalInteger(raw.token_budget ?? raw.tokenBudget);
  return Object.freeze({
    conversationId,
    status,
    objective,
    updatedAt: providerTimestamp(raw.updated_at ?? raw.updatedAt),
    ...(optionalId(raw.turn_id ?? raw.turnId) === undefined
      ? {}
      : { nativeTurnId: optionalId(raw.turn_id ?? raw.turnId) }),
    ...(tokenBudget === undefined ? {} : { tokenBudget })
  });
}

function providerGoalStatus(value: unknown): StructuredProviderGoal["status"] | undefined {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "complete":
      return value;
    case "usageLimited":
    case "usage_limited":
    case "usage-limited":
      return "usage-limited";
    case "budgetLimited":
    case "budget_limited":
    case "budget-limited":
      return "budget-limited";
    default:
      return undefined;
  }
}

function providerTimestamp(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (Number.isSafeInteger(value) && (value as number) >= 0) {
    const epoch = value as number;
    return new Date(epoch < 1_000_000_000_000 ? epoch * 1_000 : epoch).toISOString();
  }
  return new Date().toISOString();
}

function positiveOptionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function childExit(
  child: ChildProcessWithoutNullStreams,
  processInstanceId: string
): Promise<StructuredProviderProcessExit> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise(Object.freeze({
      code,
      signal,
      processInstanceId
    })));
  });
}

function defaultMirrorOutput(stream: "stdout" | "stderr", text: string): void {
  (stream === "stdout" ? process.stdout : process.stderr).write(text);
}

function requestId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nestedId(value: JsonObject, key: string): string | undefined {
  return optionalId(object(value[key])?.id);
}

function providerErrorEvidence(value: unknown): Readonly<{
  error: string;
  rawError: string;
}> {
  const error = object(value);
  const errors = Array.isArray(error?.errors)
    ? error.errors.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const message = typeof error?.message === "string" && error.message.length > 0
    ? error.message
    : errors.length > 0 ? errors.join("\n")
    : typeof value === "string" && value.length > 0
      ? value
      : "Provider Turn failed.";
  return { error: message, rawError: serializeAgentErrorRaw(value) };
}
