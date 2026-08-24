import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  CodexAppServerRequestError,
  CodexAppServerRuntime,
  codexAppServerErrorIsMissing
} from "./codexAppServerRuntime.js";
import type {
  AgentHostLaunchPayload,
  AgentHostProviderControl
} from "./launchBroker.js";
import { YUI_VERSION } from "../version.js";

const PROVIDER_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
const PROVIDER_ACCEPT_TIMEOUT_MS = 30_000;

export type StructuredProviderTurnReceipt = Readonly<{
  attemptId: string;
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  acceptedAt: string;
}>;

export type StructuredProviderTurnInput = NonNullable<
  AgentHostProviderControl["initialTurn"]
>;

export type StructuredProviderTurnTerminal = Readonly<{
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  status: "completed" | "failed" | "cancelled";
  observedAt: string;
  summary?: string;
  error?: string;
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
    const session = control.adapterId === "codex"
      ? await CodexStructuredProviderSession.open(
          child,
          exit,
          processInstanceId,
          payload,
          control,
          input.onTerminal,
          mirror
        )
      : await ClaudeStructuredProviderSession.open(
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

class JsonLineChannel {
  readonly #pending = new Map<string, Readonly<{
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>>();
  readonly #listeners = new Set<(message: JsonObject) => void>();
  #buffer = "";
  #nextId = 1;
  #closedError: Error | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly mirror: (stream: "stdout" | "stderr", text: string) => void
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#receive(chunk));
    child.once("error", (error) => this.#close(error));
    child.once("close", (code, signal) => this.#close(new Error(
      `Provider process exited before replying (code=${code ?? "none"}, signal=${signal ?? "none"}).`
    )));
  }

  onMessage(listener: (message: JsonObject) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
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
      let message: JsonObject;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        message = parsed as JsonObject;
      } catch {
        continue;
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
        continue;
      }
      for (const listener of this.#listeners) listener(message);
    }
  }

  #close(error: Error): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

class CodexStructuredProviderSession implements StructuredProviderSession {
  readonly adapterId = "codex" as const;
  #activeTurnId: string | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exit: Promise<StructuredProviderProcessExit>,
    readonly processInstanceId: string,
    readonly conversationId: string,
    private readonly runtime: CodexAppServerRuntime
  ) {}

  static async open(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<StructuredProviderProcessExit>,
    processInstanceId: string,
    payload: AgentHostLaunchPayload,
    control: AgentHostProviderControl,
    onTerminal: ((terminal: StructuredProviderTurnTerminal) => void) | undefined,
    mirror: (stream: "stdout" | "stderr", text: string) => void
  ): Promise<CodexStructuredProviderSession> {
    const channel = new JsonLineChannel(child, mirror);
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
    if (control.mode === "new") {
      conversationId = (await runtime.openConversation({ cwd: payload.cwd })).conversationId;
    } else {
      try {
        const resumed = await runtime.resumeConversation(control.nativeSessionId!);
        conversationId = resumed.threadId;
        resumedActiveTurnId = resumed.activeTurnId;
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
      runtime
    );
    session.#activeTurnId = resumedActiveTurnId;
    channel.onMessage((message) => {
      const method = typeof message.method === "string" ? message.method : "";
      const params = object(message.params) ?? {};
      if (optionalId(params.threadId) !== conversationId) return;
      if (method === "turn/started") {
        const turnId = nestedId(params, "turn") ?? optionalId(params.turnId);
        if (turnId !== undefined) session.#activeTurnId = turnId;
        return;
      }
      if (method !== "turn/completed") return;
      const turn = object(params.turn) ?? {};
      const nativeTurnId = optionalId(turn.id) ?? optionalId(params.turnId);
      if (nativeTurnId === undefined) return;
      session.#activeTurnId = undefined;
      const status = turn.status === "failed"
        ? "failed"
        : turn.status === "interrupted" ? "cancelled" : "completed";
      onTerminal?.({
        conversationId,
        nativeSessionId: conversationId,
        nativeTurnId,
        status,
        observedAt: new Date().toISOString(),
        ...(status !== "failed" ? {} : { error: providerErrorText(turn.error) })
      });
    });
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
        `Provider Conversation already has active Turn ${this.#activeTurnId}.`,
        turn.attemptId
      );
    }
    const acceptance = await this.runtime.submitTurn({
      conversationId: this.conversationId,
      attemptId: turn.attemptId,
      text: turn.boundedText,
      expectedNoActiveTurn: true
    });
    if (acceptance.status === "unknown") {
      throw new ProviderDeliveryUnknownError(acceptance.reason, turn.attemptId);
    }
    if (acceptance.status === "not-accepted") {
      throw new ProviderTurnRejectedError(acceptance.reason, turn.attemptId);
    }
    this.#activeTurnId = acceptance.turnId;
    return Object.freeze({
      attemptId: turn.attemptId,
      conversationId: this.conversationId,
      nativeSessionId: this.conversationId,
      nativeTurnId: acceptance.turnId,
      acceptedAt: new Date().toISOString()
    });
  }

  waitForExit(): Promise<StructuredProviderProcessExit> {
    return this.exit;
  }

  terminate(signal: NodeJS.Signals): void {
    terminateProcessGroup(this.child, signal);
  }
}

type ClaudeWaiter = Readonly<{
  attemptId: string;
  text: string;
  resolve: (receipt: StructuredProviderTurnReceipt) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>;

class ClaudeStructuredProviderSession implements StructuredProviderSession {
  readonly adapterId = "claude" as const;
  #activeTurnId: string | undefined;
  #waiter: ClaudeWaiter | undefined;

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
    exit.then(() => {
      const waiter = session.#waiter;
      if (waiter === undefined) return;
      clearTimeout(waiter.timer);
      session.#waiter = undefined;
      waiter.reject(new ProviderDeliveryUnknownError(
        "Claude process exited before replaying the submitted user message.",
        waiter.attemptId
      ));
    }).catch(() => {});
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
    if (this.#activeTurnId !== undefined || this.#waiter !== undefined) {
      throw new ProviderTurnRejectedError(
        "Provider Conversation already has an unsettled Turn.",
        turn.attemptId
      );
    }
    let deliveryTimer: NodeJS.Timeout | undefined;
    const receipt = new Promise<StructuredProviderTurnReceipt>((resolvePromise, reject) => {
      deliveryTimer = setTimeout(() => {
        if (this.#waiter?.attemptId === turn.attemptId) this.#waiter = undefined;
        reject(new ProviderDeliveryUnknownError(
          "Claude did not replay the submitted user message before the acknowledgement deadline.",
          turn.attemptId
        ));
      }, PROVIDER_ACCEPT_TIMEOUT_MS);
      this.#waiter = {
        attemptId: turn.attemptId,
        text: turn.boundedText,
        resolve: resolvePromise,
        reject,
        timer: deliveryTimer!
      };
    });
    try {
      await this.channel.send({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: turn.boundedText }]
        }
      });
    } catch (error) {
      if (deliveryTimer !== undefined) clearTimeout(deliveryTimer);
      this.#waiter = undefined;
      throw new ProviderDeliveryUnknownError(
        `Claude input write did not produce an exact replay acknowledgement: ${
          error instanceof Error ? error.message : String(error)
        }`,
        turn.attemptId
      );
    }
    return await receipt;
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
    if (message.type === "user") {
      const waiter = this.#waiter;
      if (waiter === undefined || claudeUserText(message) !== waiter.text) return;
      const observedSessionId = optionalId(message.session_id);
      if (observedSessionId !== this.conversationId) {
        clearTimeout(waiter.timer);
        this.#waiter = undefined;
        waiter.reject(new ProviderDeliveryUnknownError(
          "Claude replayed input for a different native Session.",
          waiter.attemptId
        ));
        return;
      }
      const nativeTurnId = `claude-input:${waiter.attemptId}`;
      this.#activeTurnId = nativeTurnId;
      clearTimeout(waiter.timer);
      this.#waiter = undefined;
      waiter.resolve(Object.freeze({
        attemptId: waiter.attemptId,
        conversationId: this.conversationId,
        nativeSessionId: this.conversationId,
        nativeTurnId,
        acceptedAt: new Date().toISOString()
      }));
      return;
    }
    if (message.type !== "result" || this.#activeTurnId === undefined
      || optionalId(message.session_id) !== this.conversationId) return;
    const nativeTurnId = this.#activeTurnId;
    this.#activeTurnId = undefined;
    const failed = message.is_error === true || message.subtype === "error_during_execution";
    onTerminal?.({
      conversationId: this.conversationId,
      nativeSessionId: this.conversationId,
      nativeTurnId,
      status: failed ? "failed" : "completed",
      observedAt: new Date().toISOString(),
      ...(typeof message.result === "string" && message.result.length > 0
        ? failed ? { error: message.result } : { summary: message.result }
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

function providerErrorText(value: unknown): string {
  const error = object(value);
  if (typeof error?.message === "string" && error.message.length > 0) return error.message;
  return "Provider Turn failed.";
}

function claudeUserText(message: JsonObject): string | undefined {
  const content = object(message.message)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((entry) => {
    const block = object(entry);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
  return text.length === 1 ? text[0] : text.join("");
}
