import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";

import WebSocket, { type RawData } from "ws";

import {
  CodexAppServerRequestError,
  CodexAppServerRuntime,
  codexAppServerErrorIsMissing
} from "./codexAppServerRuntime.js";
import type {
  AgentHostLaunchPayload,
  AgentHostProviderControl
} from "./launchBroker.js";
import { serializeAgentErrorRaw } from "./agentError.js";
import { PROVIDER_ACCEPT_TIMEOUT_MS } from "./runtimeDeadlines.js";
import { YUI_VERSION } from "../version.js";

const PROVIDER_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
const CODEX_PROXY_HANDSHAKE_TIMEOUT_MS = 10_000;

export type StructuredProviderTurnReceipt = Readonly<{
  attemptId: string;
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  acceptedAt: string;
}>;

export type StructuredProviderTurnInput = Readonly<{
  attemptId: string;
  boundedText: string;
}>;

export type StructuredProviderTurnTerminal = Readonly<{
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  /** True only when this client received the exact acceptance for the Turn. */
  clientOwned: boolean;
  status: "completed" | "failed" | "cancelled";
  observedAt: string;
  summary?: string;
  /** Human-readable Provider error message. */
  error?: string;
  /** Complete serialized Provider exception as received by this Driver. */
  rawError?: string;
}>;

export type StructuredProviderProcessExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  processInstanceId: string;
}>;

export interface StructuredProviderSession {
  readonly adapterId: "codex" | "claude";
  readonly conversationId: string;
  readonly nativeSessionId: string;
  readonly processInstanceId: string;
  readonly activeTurnId: string | undefined;
  submitTurn(turn: StructuredProviderTurnInput): Promise<StructuredProviderTurnReceipt>;
  waitForExit(): Promise<StructuredProviderProcessExit>;
  terminate(signal: NodeJS.Signals): void;
}

export class ProviderDeliveryUnknownError extends Error {
  readonly name = "ProviderDeliveryUnknownError";

  constructor(
    message: string,
    readonly attemptId: string
  ) {
    super(message);
  }
}

export class ProviderTurnRejectedError extends Error {
  readonly name = "ProviderTurnRejectedError";

  constructor(
    message: string,
    readonly attemptId: string
  ) {
    super(message);
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
    onTerminal?: (terminal: StructuredProviderTurnTerminal) => void;
    mirrorOutput?: (stream: "stdout" | "stderr", text: string) => void;
  }> = {}
): Promise<Readonly<{
  session: StructuredProviderSession;
  recoveredTerminal?: StructuredProviderTurnTerminal;
}>> {
  const control = payload.providerControl;
  if (control === undefined) {
    throw new Error("Managed Agent Host launch requires Provider control metadata.");
  }
  const child = spawn(payload.command, [...payload.args], {
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
    if (control.adapterId === "codex") {
      const opened = await CodexStructuredProviderSession.open(
          child,
          exit,
          processInstanceId,
          payload,
          control,
          input.onTerminal,
          mirror
        );
      return Object.freeze({
        session: opened.session,
        ...(opened.recoveredTerminal === undefined
          ? {}
          : { recoveredTerminal: opened.recoveredTerminal })
      });
    }
    const session = await ClaudeStructuredProviderSession.open(
          child,
          exit,
          processInstanceId,
          control,
          input.onTerminal,
          mirror
        );
    return Object.freeze({ session });
  } catch (error) {
    terminateProcessGroup(child, "SIGTERM");
    throw error;
  }
}

type JsonObject = Record<string, unknown>;

class CodexProxyWebSocketChannel {
  readonly #pending = new Map<string, Readonly<{
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>>();
  readonly #listeners = new Set<(message: JsonObject) => void>();
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

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    await this.#readyPromise;
    if (this.#closedError !== undefined) throw this.#closedError;
    const id = String(this.#nextId++);
    const response = new Promise<JsonObject>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
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

class JsonLineChannel {
  readonly #listeners = new Set<(message: JsonObject) => void>();
  #buffer = "";
  #closedError: Error | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly mirror: (stream: "stdout" | "stderr", text: string) => void
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#receive(chunk));
    child.once("error", (error) => this.#close(error));
    child.once("close", (code, signal) => this.#close(new Error(
      `Provider process exited (code=${code ?? "none"}, signal=${signal ?? "none"}).`
    )));
  }

  onMessage(listener: (message: JsonObject) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(message: JsonObject): Promise<void> {
    if (this.#closedError !== undefined) throw this.#closedError;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > PROVIDER_MESSAGE_MAX_BYTES) {
      throw new Error("Provider request exceeds its message bound.");
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error === null || error === undefined) resolvePromise();
        else reject(error);
      });
    });
  }

  #receive(chunk: string): void {
    this.mirror("stdout", chunk);
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > PROVIDER_MESSAGE_MAX_BYTES) {
      this.#close(new Error("Provider response line exceeds its message bound."));
      terminateProcessGroup(this.child, "SIGTERM");
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        for (const listener of this.#listeners) listener(parsed as JsonObject);
      } catch {
        continue;
      }
    }
  }

  #close(error: Error): void {
    if (this.#closedError === undefined) this.#closedError = error;
  }
}

class CodexStructuredProviderSession implements StructuredProviderSession {
  readonly adapterId = "codex" as const;
  #activeTurnId: string | undefined;
  #clientOwnedTurnId: string | undefined;
  #submissionPending = false;
  readonly #bufferedTerminals: Array<Omit<StructuredProviderTurnTerminal, "clientOwned">> = [];

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exit: Promise<StructuredProviderProcessExit>,
    readonly processInstanceId: string,
    readonly conversationId: string,
    private readonly runtime: CodexAppServerRuntime,
    private readonly onTerminal:
      | ((terminal: StructuredProviderTurnTerminal) => void)
      | undefined
  ) {}

  static async open(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<StructuredProviderProcessExit>,
    processInstanceId: string,
    payload: AgentHostLaunchPayload,
    control: AgentHostProviderControl,
    onTerminal: ((terminal: StructuredProviderTurnTerminal) => void) | undefined,
    mirror: (stream: "stdout" | "stderr", text: string) => void
  ): Promise<Readonly<{
    session: CodexStructuredProviderSession;
    recoveredTerminal?: StructuredProviderTurnTerminal;
  }>> {
    const channel = await CodexProxyWebSocketChannel.connect(child, mirror);
    const openingMessages: JsonObject[] = [];
    const stopOpeningBuffer = channel.onMessage((message) => openingMessages.push(message));
    await channel.request("initialize", {
      clientInfo: { name: "yui", title: "Yui", version: YUI_VERSION },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
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
      onTerminal
    );
    session.#activeTurnId = resumedActiveTurnId;
    const ownedTurn = control.kind === "restore" ? control.ownedTurn : undefined;
    session.#clientOwnedTurnId = ownedTurn?.turnId;
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
          clientOwned: true,
          status: recovered.status === "failed"
            ? "failed"
            : recovered.status === "interrupted" ? "cancelled" : "completed",
          observedAt: new Date().toISOString(),
          ...(recovered.status !== "failed"
            ? {}
            : {
                error: recovered.error ?? "Provider Turn failed.",
                rawError: serializeAgentErrorRaw(recovered)
              })
        };
        session.#clientOwnedTurnId = undefined;
      } else {
        throw new ProviderDeliveryUnknownError(
          `Codex resume could not recover the persisted Yui Turn ${ownedTurn.turnId}.`,
          ownedTurn.attemptId
        );
      }
    }
    return Object.freeze({
      session,
      ...(recoveredTerminal === undefined ? {} : { recoveredTerminal })
    });
  }

  #observeMessage(
    message: JsonObject,
    emit: boolean
  ): StructuredProviderTurnTerminal | undefined {
      const method = typeof message.method === "string" ? message.method : "";
      const params = object(message.params) ?? {};
      if (optionalId(params.threadId) !== this.conversationId) return undefined;
      if (method === "turn/started") {
        const turnId = nestedId(params, "turn") ?? optionalId(params.turnId);
        if (turnId !== undefined) this.#activeTurnId = turnId;
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
      const terminal = {
        conversationId: this.conversationId,
        nativeSessionId: this.conversationId,
        nativeTurnId,
        status,
        observedAt: new Date().toISOString(),
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
        expectedNoActiveTurn: true
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
      return Object.freeze({
        attemptId: turn.attemptId,
        conversationId: this.conversationId,
        nativeSessionId: this.conversationId,
        nativeTurnId: acceptance.turnId,
        acceptedAt: new Date().toISOString()
      });
    } finally {
      this.#submissionPending = false;
      const buffered = this.#bufferedTerminals.splice(0);
      for (const terminal of buffered) this.#emitTerminal(terminal);
    }
  }

  #emitTerminal(terminal: Omit<StructuredProviderTurnTerminal, "clientOwned">): void {
    this.#completeTerminal(terminal, true);
  }

  #completeTerminal(
    terminal: Omit<StructuredProviderTurnTerminal, "clientOwned">,
    emit: boolean
  ): StructuredProviderTurnTerminal {
    const clientOwned = terminal.nativeTurnId === this.#clientOwnedTurnId;
    if (terminal.nativeTurnId === this.#activeTurnId) this.#activeTurnId = undefined;
    if (clientOwned) this.#clientOwnedTurnId = undefined;
    const completed = { ...terminal, clientOwned };
    if (emit) this.onTerminal?.(completed);
    return completed;
  }

  waitForExit(): Promise<StructuredProviderProcessExit> {
    return this.exit;
  }

  terminate(signal: NodeJS.Signals): void {
    terminateProcessGroup(this.child, signal);
  }
}

class ClaudeStructuredProviderSession implements StructuredProviderSession {
  readonly adapterId = "claude" as const;
  #activeTurnId: string | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exit: Promise<StructuredProviderProcessExit>,
    readonly processInstanceId: string,
    readonly conversationId: string,
    private readonly channel: JsonLineChannel
  ) {}

  static async open(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<StructuredProviderProcessExit>,
    processInstanceId: string,
    control: AgentHostProviderControl,
    onTerminal: ((terminal: StructuredProviderTurnTerminal) => void) | undefined,
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
      channel
    );
    channel.onMessage((message) => session.#receive(message, onTerminal));
    return session;
  }

  get nativeSessionId(): string {
    return this.conversationId;
  }

  get activeTurnId(): string | undefined {
    return this.#activeTurnId;
  }

  async submitTurn(
    turn: StructuredProviderTurnInput
  ): Promise<StructuredProviderTurnReceipt> {
    if (this.#activeTurnId !== undefined) {
      throw new ProviderTurnRejectedError(
        "Provider Conversation already has an unsettled Turn.",
        turn.attemptId
      );
    }
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
        turn.attemptId
      );
    }
    // AgentHost is the sole writer to this dedicated stream-json process.
    // A completed pipe write is the smallest reliable acceptance boundary;
    // Claude's later `result` is the matching terminal for this serialized
    // Turn. Requiring an echoed user-message creates a second, brittle
    // protocol without improving delivery safety.
    const nativeTurnId = `claude-stream:${turn.attemptId}`;
    this.#activeTurnId = nativeTurnId;
    return Object.freeze({
      attemptId: turn.attemptId,
      conversationId: this.conversationId,
      nativeSessionId: this.conversationId,
      nativeTurnId,
      acceptedAt: new Date().toISOString()
    });
  }

  waitForExit(): Promise<StructuredProviderProcessExit> {
    return this.exit;
  }

  terminate(signal: NodeJS.Signals): void {
    terminateProcessGroup(this.child, signal);
  }

  #receive(
    message: JsonObject,
    onTerminal: ((terminal: StructuredProviderTurnTerminal) => void) | undefined
  ): void {
    if (message.type === "user") return;
    if (message.type !== "result" || this.#activeTurnId === undefined
      || optionalId(message.session_id) !== this.conversationId) return;
    const nativeTurnId = this.#activeTurnId;
    this.#activeTurnId = undefined;
    const failed = message.is_error === true || message.subtype === "error_during_execution";
    const result = typeof message.result === "string" && message.result.length > 0
      ? message.result
      : "Provider Turn failed.";
    onTerminal?.({
      conversationId: this.conversationId,
      nativeSessionId: this.conversationId,
      nativeTurnId,
      clientOwned: true,
      status: failed ? "failed" : "completed",
      observedAt: new Date().toISOString(),
      ...(failed
        ? { error: result, rawError: providerErrorEvidence(message).rawError }
        : typeof message.result === "string" && message.result.length > 0
          ? { summary: message.result }
          : {})
    });
  }
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

function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void {
  if (child.pid === undefined) return;
  // Managed Providers are spawned detached and therefore own a process group.
  // Kill that exact group so a CLI helper cannot outlive the Agent Host. The
  // direct-child fallback covers embedded runtimes that cannot create setsid.
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    child.kill(signal);
  }
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
  const message = typeof error?.message === "string" && error.message.length > 0
    ? error.message
    : typeof value === "string" && value.length > 0
      ? value
      : "Provider Turn failed.";
  return { error: message, rawError: serializeAgentErrorRaw(value) };
}
