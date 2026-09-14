import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import type { AgentExecutionComponentId } from "../agent/executionComponents.js";
import { MAX_RUN_RESULT_OUTPUT_BYTES } from "../domain/agentResultTransport.js";
import {
  ACP_METHOD_NOT_FOUND_CODE,
  acpCancelNotification,
  acpDeclinePermission,
  acpInitializeRequest,
  acpNewSessionRequest,
  acpPermissionResult,
  acpPermissionSummary,
  acpPromptRequest,
  acpSetConfigOptionRequest,
  acpStopReasonDetail,
  acpTerminalStatus,
  asObject,
  optionalText,
  readAcpConfigOptions,
  readAcpInitializeResult,
  readAcpPermissionRequest,
  readAcpSessionConfiguration,
  readAcpSessionUpdate,
  readAcpStopReason,
  type AcpConfigOption,
  type AcpInitializeResult
} from "./acpProtocol.js";
import {
  ACP_CONFIGURATION_ORDER,
  acpRunConfigurationOptions,
  confirmAcpConfigurationStep,
  describeAcpConfigurationRejections,
  resolveAcpConfigurationField,
  verifyAcpConfiguration,
  type AcpConfigurationOutcome,
  type AcpDesiredSessionConfiguration
} from "./acpSessionConfiguration.js";
import {
  handshakeObservationFrom,
  unknownAgentRunConfiguration,
  type AgentRunConfigurationCurrentValue,
  type AgentRunConfigurationObservation
} from "./agentRunConfiguration.js";
import {
  JsonLineChannel,
  terminateProcessGroup,
  type JsonObject
} from "./jsonLineChannel.js";
import { ProviderDeliveryUnknownError, ProviderTurnRejectedError } from "./providerErrors.js";
import {
  type StructuredProviderProcessExit,
  type StructuredProviderSession,
  type StructuredProviderTurnInput,
  type StructuredProviderTurnReceipt,
  type StructuredProviderTurnTerminal
} from "./structuredProviderHost.js";

export type AcpSessionOpenInput = Readonly<{
  child: ChildProcessWithoutNullStreams;
  exit: Promise<StructuredProviderProcessExit>;
  processInstanceId: string;
  clientVersion: string;
  cwd: string;
  /**
   * Extra workspace roots this launch is scoped to, already absolute. They are
   * sent only when the Agent advertises the capability; an Agent without it
   * still receives a valid request, and the caller learns from
   * `unsentAdditionalDirectories` that the roots did not reach it.
   */
  additionalDirectories?: readonly string[];
  /**
   * Instructions the Session must read before its first Turn. ACP has no
   * system prompt, so this is prepended to the first prompt's text; there is
   * nowhere else in the protocol for it to go.
   */
  sessionBootstrap?: string;
  /**
   * Run configuration this launch asks the Session for, applied through ACP's
   * own config options after the Session exists and before any prompt is sent.
   * Absent fields state no opinion and send nothing.
   */
  desiredConfiguration?: AcpDesiredSessionConfiguration;
  /**
   * Which product is on the other end, as recorded by the Agent binding. Needed
   * because one configuration fact — the mode value that grants bypass — is a
   * product decision that no ACP field carries.
   */
  component?: AgentExecutionComponentId;
  /** Present for resume; the Agent's own Session id from a previous launch. */
  nativeSessionId?: string;
  onTerminal?: (terminal: StructuredProviderTurnTerminal) => void;
  mirror: (stream: "stdout" | "stderr", text: string) => void;
}>;

/**
 * One Agent Client Protocol Session over an Agent's stdio.
 *
 * This class implements the protocol and nothing else. It never names a
 * product: which executable sits on the other end is a launch descriptor fact,
 * so a second ACP product reuses this code unchanged.
 *
 * Three identities are deliberately kept apart:
 *  - the JSON-RPC request id, which correlates one message pair on this pipe;
 *  - the Yui attemptId, which is the durable local request;
 *  - the ACP `sessionId`, which is the Agent's own native Session identity.
 *
 * ACP v1 defines no native *Turn* identity: a Turn is the `session/prompt`
 * request itself, and its response is that Turn's terminal. Yui therefore
 * reports no `nativeTurnId` for an ACP Turn rather than promoting a JSON-RPC
 * request id or minting a value no Agent would recognize.
 */
export class AcpStructuredProviderSession implements StructuredProviderSession {
  readonly adapterId = "acp" as const;
  readonly #pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  #sessionId = "";
  #negotiated: AcpInitializeResult | undefined;
  #nextRequestId = 1;
  #activeAttemptId: string | undefined;
  #promptRequestId: number | undefined;
  #closed: Error | undefined;
  /**
   * Settles the in-flight `submitTurn` call. ACP proves acceptance only by
   * answering the prompt, so the promise this resolves is the caller's only
   * honest acceptance signal, and it is deliberately left unresolved while the
   * Agent is still working.
   */
  #promptSettle: ((outcome: PromptOutcome) => void) | undefined;
  /**
   * Text from `agent_message_chunk` for the Turn currently in flight, in
   * arrival order. Reset per attempt so one Turn's answer can never be
   * archived as another's, and never fed by thought or tool updates.
   */
  #answer: string[] = [];
  #answerBytes = 0;
  #answerOverflowed = false;
  /**
   * Roots this launch asked for that the Agent never advertised support for.
   * Recorded rather than dropped silently: the workspace the Agent can actually
   * reach is narrower than the one Yui scoped, and that is a fact the Session
   * must be able to report instead of one the caller has to guess.
   */
  #unsentAdditionalDirectories: readonly string[] = [];
  /**
   * Bootstrap still owed to the model, cleared once a prompt has carried it.
   * ACP offers no system prompt, so the first prompt on each connection
   * carries the manifest pointer. Later Turns on that connection do not repeat it.
   */
  #pendingBootstrap: string | undefined;
  /**
   * The Session's config options as the Agent last reported them, from setup,
   * from a set call's answer or from an Agent-initiated update. ACP always sends
   * the complete list, so this is replaced wholesale and never merged.
   */
  #configOptions: readonly AcpConfigOption[] = [];
  /**
   * What Yui asked this Session for and what the Agent did with it, recorded so
   * a launch reports the configuration it actually runs under rather than the
   * one it requested. Requested changes require a reported current value.
   */
  #appliedConfiguration: readonly AcpConfigurationOutcome[] = [];

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly exit: Promise<StructuredProviderProcessExit>,
    readonly processInstanceId: string,
    private readonly channel: JsonLineChannel,
    private readonly onTerminal:
      ((terminal: StructuredProviderTurnTerminal) => void) | undefined,
    private readonly mirror: (stream: "stdout" | "stderr", text: string) => void
  ) {}

  static async open(input: AcpSessionOpenInput): Promise<AcpStructuredProviderSession> {
    const channel = new JsonLineChannel(input.child, input.mirror);
    const session = new AcpStructuredProviderSession(
      input.child,
      input.exit,
      input.processInstanceId,
      channel,
      input.onTerminal,
      input.mirror
    );
    channel.onMessage((message) => session.#receive(message));
    channel.onClose((error) => session.#fail(error));

    const negotiated = readAcpInitializeResult(
      await session.#request("initialize", acpInitializeRequest(input.clientVersion))
    );
    session.#negotiated = negotiated;
    const requested = input.additionalDirectories ?? [];
    // ACP requires every workspace root to be absolute, and an Agent that never
    // advertised the field must not receive it. Both are decided here, once,
    // from what this Agent actually said during `initialize`.
    for (const path of requested) {
      if (!isAbsolute(path)) {
        throw new Error(
          `ACP additional workspace root must be an absolute path: ${path}`
        );
      }
    }
    session.#unsentAdditionalDirectories = negotiated.capabilities.additionalDirectories
      ? []
      : Object.freeze([...requested]);
    session.#sessionId = input.nativeSessionId === undefined
      ? await session.#create(input.cwd, requested)
      : await session.#restore(input.nativeSessionId, input.cwd, negotiated, requested);
    // The Session now exists, so its configurable surface is known — and no
    // prompt has been sent yet, so nothing has run under the wrong settings.
    // This is the only point where both are true.
    if (input.desiredConfiguration !== undefined) {
      await session.#applyConfiguration(
        input.desiredConfiguration,
        // An unnamed component is the unidentified ACP product, which is exactly
        // what an Agent Yui cannot identify should be treated as: it has no known
        // bypass value, so such a request is refused rather than guessed.
        input.component ?? "unknown-acp-agent"
      );
    }
    // A restored Conversation may have disconnected before its first prompt.
    // Repeat the short manifest pointer on attachment rather than assuming it
    // was delivered or adding persistent acknowledgement state.
    session.#pendingBootstrap = input.sessionBootstrap;
    return session;
  }

  /** Capabilities the Agent actually advertised during `initialize`. */
  get negotiated(): AcpInitializeResult {
    if (this.#negotiated === undefined) throw new Error("ACP Session is not initialized.");
    return this.#negotiated;
  }

  get conversationId(): string {
    return this.#sessionId;
  }

  get nativeSessionId(): string {
    return this.#sessionId;
  }

  get activeTurnId(): string | undefined {
    // ACP has no native Turn id. Returning the local attempt or a JSON-RPC
    // request id here would present a Yui-owned value as a Provider identity.
    return undefined;
  }

  /**
   * Rebinding this Conversation from a later process means calling
   * `session/load`, which ACP gates on `agentCapabilities.loadSession`. This
   * Agent either advertised it during `initialize` or it did not, so the answer
   * is a negotiated fact rather than an adapter-wide assumption.
   */
  get conversationRecoverability(): "recoverable" | "unknown" {
    return this.negotiated.capabilities.loadSession ? "recoverable" : "unknown";
  }

  async submitTurn(turn: StructuredProviderTurnInput): Promise<StructuredProviderTurnReceipt> {
    if (this.#activeAttemptId !== undefined) {
      throw new ProviderTurnRejectedError(
        "ACP Session already has an unsettled Turn.",
        turn.attemptId
      );
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    // Reserve before the pipe write: a fast Agent can answer before the write
    // callback runs, and an ambiguous write must retain the same occupancy so
    // that no successor input is bound to this slot.
    this.#activeAttemptId = turn.attemptId;
    this.#promptRequestId = requestId;
    this.#resetAnswer();
    // Registered before the write so a response that arrives during the await
    // below still finds someone to settle.
    const settled = new Promise<PromptOutcome>((resolvePromise) => {
      this.#promptSettle = resolvePromise;
    });
    // The bootstrap rides the first prompt. It stays owed until the write
    // completes, so a Turn that never left Yui does not silently consume the
    // only instructions the Session was going to receive.
    const bootstrap = this.#pendingBootstrap;
    const text = bootstrap === undefined
      ? turn.boundedText
      : `${bootstrap}\n\n${turn.boundedText}`;
    try {
      await this.channel.send({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/prompt",
        params: acpPromptRequest(this.#sessionId, text)
      });
      this.#pendingBootstrap = undefined;
    } catch (error) {
      // The write itself failed, so the Agent may or may not have read it.
      // Release the slot only through the unknown path: this Turn is never
      // resent, and no successor may claim the slot as if it were free.
      this.#promptSettle = undefined;
      throw new ProviderDeliveryUnknownError(
        `ACP prompt write did not complete: ${
          error instanceof Error ? error.message : String(error)
        }`,
        turn.attemptId,
        { cause: error }
      );
    }
    // A completed pipe write proves only that bytes left Yui. ACP acknowledges
    // a prompt by answering it, so this call stays unresolved until that answer
    // arrives: a long-running Turn is reported as pending by the caller's own
    // deadline, and a transport that dies first is reported as unknown. Neither
    // is an acceptance, and neither may be invented here.
    const outcome = await settled;
    if (outcome.kind === "unknown") {
      throw new ProviderDeliveryUnknownError(outcome.message, turn.attemptId, {
        ...(outcome.cause === undefined ? {} : { cause: outcome.cause })
      });
    }
    return Object.freeze({
      attemptId: turn.attemptId,
      conversationId: this.#sessionId,
      nativeSessionId: this.#sessionId,
      acceptedAt: outcome.observedAt,
      // The Agent answered this exact request: that is Provider acceptance,
      // not merely a transport fact.
      acceptance: "provider"
    });
  }

  async steerTurn(turn: StructuredProviderTurnInput): Promise<StructuredProviderTurnReceipt> {
    throw new ProviderTurnRejectedError(
      "ACP v1 defines no mid-Turn steering: a Turn is one `session/prompt` request "
      + "and accepts no further input until it answers.",
      turn.attemptId
    );
  }

  async cancelTurn(attemptId: string): Promise<"requested" | "not-active" | "unknown"> {
    if (this.#activeAttemptId !== attemptId) return "not-active";
    try {
      await this.channel.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: acpCancelNotification(this.#sessionId)
      });
    } catch {
      // A notification carries no acknowledgement, so a failed write leaves it
      // genuinely unknown whether the Agent ever saw the request.
      return "unknown";
    }
    // `session/cancel` requests a stop; it does not prove one. ACP requires
    // only that the Agent *answer* the prompt with `cancelled`, while halting
    // the underlying work is a SHOULD. The Turn settles on that answer, and
    // only that answer decides the terminal: this local intent is deliberately
    // not remembered, because a request is not evidence of its own outcome.
    return "requested";
  }

  waitForExit(): Promise<StructuredProviderProcessExit> {
    return this.exit;
  }

  terminate(signal: NodeJS.Signals): void {
    terminateProcessGroup(this.child, signal);
  }

  async #create(cwd: string, additionalDirectories: readonly string[]): Promise<string> {
    await this.#request(
      "session/new",
      acpNewSessionRequest(cwd, this.#sendableDirectories(additionalDirectories)),
      (response) => {
        const setup = asObject(response);
        const id = setup === null ? undefined : optionalText(setup.sessionId);
        if (id === undefined) throw new Error("ACP `session/new` returned no sessionId.");
        this.#sessionId = id;
        this.#readConfiguration(setup);
      }
    );
    return this.#sessionId;
  }

  /**
   * Reattach to an existing Agent Session. `session/load` is the only method
   * ACP defines for this, and it is gated by `agentCapabilities.loadSession`;
   * an Agent without it cannot restore the Conversation, and saying so is more
   * useful than silently starting a different Session under the old id.
   */
  async #restore(
    sessionId: string,
    cwd: string,
    negotiated: AcpInitializeResult,
    additionalDirectories: readonly string[]
  ): Promise<string> {
    if (!negotiated.capabilities.loadSession) {
      throw new Error(
        "ACP Agent does not support `session/load` (agentCapabilities.loadSession is "
        + "false), so this native Session cannot be reattached. Start a new Session "
        + "explicitly instead."
      );
    }
    // `session/load` replays the whole Conversation as `session/update`
    // notifications before it answers. Those replays are history: the receive
    // path only settles a Turn from a `session/prompt` response, so replayed
    // content can never be mistaken for a new terminal.
    this.#sessionId = sessionId;
    await this.#request("session/load", {
      sessionId,
      ...(acpNewSessionRequest(cwd, this.#sendableDirectories(additionalDirectories)) as JsonObject)
    }, (response) => this.#readConfiguration(asObject(response)));
    // A resumed Session reports its own current configuration, which is the
    // Agent's state after the earlier launch — not this launch's request. Both
    // are read the same way so a resume is configured from what is true now.
    return sessionId;
  }

  /** Record the option list from a session setup or set-option result. */
  #readConfiguration(result: object | null): void {
    const configuration = readAcpSessionConfiguration(result);
    this.#configOptions = configuration.options;
  }

  /**
   * Push this launch's requested run configuration and verify the Agent applied
   * it, before any prompt exists to be affected by it.
   *
   * Ordering matters and is not incidental. ACP reports a Session's options only
   * once the Session exists, so the request cannot be made at `initialize`; and
   * a prompt sent before the options are set would run under the Agent's
   * defaults while reporting the user's selection. So this sits exactly between
   * the two, and any failure here stops the launch rather than degrading it.
   *
   * Within that window, each field is resolved against the option list the Agent
   * reports at that moment, not against the list the Session opened with. This is
   * what a single up-front plan cannot do: setting a model resets the reasoning
   * effort on real Agents and can change which effort values exist at all, so a
   * plan fixed before the model call would either re-send a now-stale value or
   * reject a value that the new model does offer. Resolving one field at a time
   * against the newest list handles both without guessing.
   *
   * The pass is bounded — each field is decided once, in a fixed order, and there
   * is no retry or repair loop. What makes that sufficient is the final
   * verification against the Agent's last complete list: it covers every
   * explicitly requested value, so an axis moved by a later call is caught even
   * though its own step had already been confirmed.
   */
  async #applyConfiguration(
    desired: AcpDesiredSessionConfiguration,
    component: AgentExecutionComponentId
  ): Promise<void> {
    const outcomes: AcpConfigurationOutcome[] = [];
    for (const field of ACP_CONFIGURATION_ORDER) {
      const resolution = resolveAcpConfigurationField(
        field,
        desired,
        this.#configOptions,
        component
      );
      if (resolution.kind === "unrequested") continue;
      if (resolution.kind === "rejection") {
        // The user asked for something this Agent cannot deliver. Continuing
        // would run the Turn under a configuration nobody chose, so the launch
        // stops with the Agent's own enumeration in the message.
        throw new Error(
          `ACP Agent cannot apply the requested run configuration. `
          + describeAcpConfigurationRejections([resolution.rejection])
        );
      }
      if (resolution.kind === "satisfied") {
        outcomes.push(Object.freeze({
          field,
          configId: resolution.step.configId,
          value: resolution.step.value,
          confirmation: "already" as const
        }));
        continue;
      }
      const step = resolution.step;
      const result = await this.#request(
        "session/set_config_option",
        acpSetConfigOptionRequest(this.#sessionId, step.configId, step.value),
        (response) => {
          const options = readAcpConfigOptions(asObject(response)?.configOptions);
          if (options !== undefined) this.#configOptions = options;
        }
      );
      // The answer is the whole option list, so it both confirms this step and
      // carries any change the Agent made alongside it.
      const options = readAcpConfigOptions(asObject(result)?.configOptions);
      const mismatch = confirmAcpConfigurationStep(step, options ?? this.#configOptions);
      if (mismatch !== undefined) throw new Error(mismatch);
      outcomes.push(Object.freeze({
        field,
        configId: step.configId,
        value: step.value,
        confirmation: "observed" as const
      }));
    }
    // Every call has landed, so this is the configuration the prompt would run
    // under. Re-checking all requested values here is what catches an axis that a
    // later call reset after its own step had already been confirmed.
    const failures = verifyAcpConfiguration(desired, this.#configOptions, component);
    if (failures.length > 0) {
      throw new Error(`ACP Session run configuration did not hold. ${failures.join(" ")}`);
    }
    this.#appliedConfiguration = Object.freeze(outcomes);
  }

  /** The Session config options the Agent last reported. */
  get configOptions(): readonly AcpConfigOption[] {
    return this.#configOptions;
  }

  /** Requested configuration this Session confirmed, in application order. */
  get appliedConfiguration(): readonly AcpConfigurationOutcome[] {
    return this.#appliedConfiguration;
  }

  /**
   * What this Session is actually running under, read fresh on every call.
   *
   * Two facts are combined and kept labelled. Each requested value carries the
   * confirmation its own step earned, which is history and does not change. The
   * current value beside it is read from the option list the Agent reports right
   * now, so an axis the Agent has since moved shows as a different current value
   * rather than as the launch's confirmed one. Reading the private field on every
   * call rather than caching a projection is what makes that true: a snapshot
   * taken at launch would keep reporting a configuration this Session has left.
   */
  get runConfiguration(): AgentRunConfigurationObservation {
    if (this.#closed !== undefined) {
      return unknownAgentRunConfiguration("The ACP connection is closed; its reports are no longer current.");
    }
    return Object.freeze({
      status: "observed",
      observedAt: new Date().toISOString(),
      handshake: handshakeObservationFrom(this.negotiated),
      requested: Object.freeze(this.#appliedConfiguration.map((outcome) => Object.freeze({
        field: outcome.field,
        key: outcome.configId,
        value: outcome.value,
        confirmation: outcome.confirmation,
        current: this.#currentValue(outcome)
      }))),
      axes: Object.freeze(acpRunConfigurationOptions(this.#configOptions).map((option) => Object.freeze({
        key: option.id,
        ...(option.category === undefined ? {} : { category: option.category }),
        current: this.#axisValue(option),
        offered: Object.freeze(option.options.map(({ value }) => value))
      })))
    });
  }

  /** The current complete option list is the Agent's own report. */
  #axisValue(option: AcpConfigOption): AgentRunConfigurationCurrentValue {
    return Object.freeze({ status: "observed", value: option.currentValue });
  }

  /** Read current evidence independently of the request's historical confirmation. */
  #currentValue(outcome: AcpConfigurationOutcome): AgentRunConfigurationCurrentValue {
    const option = this.#configOptions.find((candidate) => candidate.id === outcome.configId);
    if (option !== undefined) {
      return this.#axisValue(option);
    }
    return Object.freeze({
      status: "unobserved",
      reason: `The Agent no longer reports an option \`${outcome.configId}\` in its configuration.`
    });
  }

  /**
   * The subset of requested roots this Agent is allowed to receive. Gating here
   * rather than at the call sites keeps `session/new` and `session/load` from
   * ever disagreeing about what this connection negotiated.
   */
  #sendableDirectories(requested: readonly string[]): readonly string[] {
    return this.negotiated.capabilities.additionalDirectories ? requested : [];
  }

  /** Requested roots this Agent cannot be told about. Empty when all were sent. */
  get unsentAdditionalDirectories(): readonly string[] {
    return this.#unsentAdditionalDirectories;
  }

  #request(method: string, params: JsonObject, receive?: (result: unknown) => void): Promise<unknown> {
    return new Promise<unknown>((resolvePromise, reject) => {
      if (this.#closed !== undefined) {
        reject(this.#closed);
        return;
      }
      const id = this.#nextRequestId;
      this.#nextRequestId += 1;
      this.#pending.set(id, {
        resolve: (result) => {
          try {
            // Apply response facts in wire order, before a following notification.
            receive?.(result);
            resolvePromise(result);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject
      });
      void this.channel.send({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  #receive(message: JsonObject): void {
    const method = optionalText(message.method);
    if (method === undefined) {
      this.#response(message);
      return;
    }
    if (message.id === undefined) this.#notification(method, message.params);
    else void this.#serve(method, message);
  }

  #response(message: JsonObject): void {
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id === undefined) return;
    if (id === this.#promptRequestId) {
      this.#settlePrompt(message);
      return;
    }
    const waiter = this.#pending.get(id);
    if (waiter === undefined) return;
    this.#pending.delete(id);
    const error = asObject(message.error);
    if (error === null) {
      waiter.resolve(message.result);
      return;
    }
    waiter.reject(new Error(
      `ACP ${optionalText(error.message) ?? "request failed"}`
      + `${typeof error.code === "number" ? ` (code ${error.code})` : ""}`
    ));
  }

  /** A `session/prompt` response is the Turn's terminal; nothing else is. */
  #settlePrompt(message: JsonObject): void {
    const attemptId = this.#activeAttemptId;
    if (attemptId === undefined) return;
    this.#activeAttemptId = undefined;
    this.#promptRequestId = undefined;
    const answer = this.#takeAnswer();
    const settle = this.#promptSettle;
    this.#promptSettle = undefined;
    const observedAt = new Date().toISOString();
    // The Agent answered this exact request, so the submission is accepted
    // whatever the answer says. A refusal or an error is an accepted Turn that
    // finished badly, not a failed delivery.
    settle?.({ kind: "answered", observedAt });
    const base = {
      conversationId: this.#sessionId,
      nativeSessionId: this.#sessionId,
      // The exact local request this response answers. ACP publishes no native
      // Turn id, so `nativeTurnId` is absent rather than invented.
      attemptId,
      // The JSON-RPC id binds this response to this client's exact request.
      clientOwned: true,
      observedAt
    } as const;
    const error = asObject(message.error);
    if (error !== null) {
      // A local cancel request does not reclassify a failure. ACP proves
      // cancellation exactly one way — `stopReason: "cancelled"` on a
      // successful response — and an error returned after a cancel request is
      // still the error the Agent reported.
      this.onTerminal?.({
        ...base,
        status: "failed",
        error: optionalText(error.message) ?? "ACP prompt failed.",
        rawError: JSON.stringify(error)
      });
      return;
    }
    const reason = readAcpStopReason(message.result);
    if (reason === undefined) {
      this.onTerminal?.({
        ...base,
        status: "failed",
        error: "ACP prompt response carried no recognized stopReason."
      });
      return;
    }
    const status = acpTerminalStatus(reason);
    this.onTerminal?.({
      ...base,
      status,
      // The Agent's own answer for this attempt, assembled from the
      // `agent_message_chunk` updates that preceded this response.
      ...(answer === undefined ? {} : { output: answer }),
      ...(status === "completed" ? {} : { error: acpStopReasonDetail(reason) })
    });
  }

  #resetAnswer(): void {
    this.#answer = [];
    this.#answerBytes = 0;
    this.#answerOverflowed = false;
  }

  /**
   * The streamed answer for the attempt that just settled.
   *
   * Returns nothing when the Agent streamed no message text, so a Turn without
   * an answer is reported as having none rather than as an empty one. An answer
   * past the durable limit is dropped whole: the durable contract keeps Agent
   * text exact or not at all, and a silently truncated answer would read as a
   * complete one.
   */
  #takeAnswer(): string | undefined {
    const chunks = this.#answer;
    const overflowed = this.#answerOverflowed;
    this.#resetAnswer();
    if (overflowed || chunks.length === 0) return undefined;
    const text = chunks.join("");
    return text.length === 0 ? undefined : text;
  }

  #notification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const update = readAcpSessionUpdate(params, this.#sessionId);
    // An Agent may change the Session's configuration itself, and ACP sends the
    // complete option list when it does. Tracking it keeps this Session's view
    // of what it is running under accurate; it is not treated as a failure,
    // because the Agent is entitled to do this and Yui's own requests were
    // already confirmed before any prompt was sent.
    if (update?.kind === "config-options") {
      this.#configOptions = update.options;
      return;
    }
    // Streamed content is Provider-visible progress, mirrored for the Turn
    // record. It never settles a Turn: only the prompt response does.
    if (update?.kind !== "agent-message") return;
    this.mirror("stdout", update.text);
    // Only `agent_message_chunk` reaches here: thought, tool-call and plan
    // updates decode to other kinds and are deliberately not part of the
    // Agent's answer. Chunks outside a Turn are history — most visibly the
    // replay `session/load` performs — and are mirrored without being adopted
    // as this attempt's output.
    if (this.#activeAttemptId === undefined || this.#answerOverflowed) return;
    const bytes = Buffer.byteLength(update.text, "utf8");
    if (this.#answerBytes + bytes > MAX_RUN_RESULT_OUTPUT_BYTES) {
      // Stop retaining rather than keep a prefix: a truncated answer that still
      // looked complete would be worse than an explicit absence.
      this.#answerOverflowed = true;
      this.#answer = [];
      this.#answerBytes = 0;
      return;
    }
    this.#answer.push(update.text);
    this.#answerBytes += bytes;
  }

  async #serve(method: string, message: JsonObject): Promise<void> {
    if (method === "session/request_permission") {
      const request = readAcpPermissionRequest(message.params);
      if (request === undefined) {
        await this.#reply(message.id, undefined, {
          code: ACP_METHOD_NOT_FOUND_CODE,
          message: "ACP permission request was malformed."
        });
        return;
      }
      // Yui carries no interactive consent on this transport. Declining is the
      // only answer that does not grant authority the user never gave.
      const decision = acpDeclinePermission(request);
      this.mirror("stderr", `${acpPermissionSummary(request, decision)}\n`);
      await this.#reply(message.id, acpPermissionResult(decision), undefined);
      return;
    }
    // Yui advertised no filesystem and no terminal capability, so such a call
    // is outside what this client agreed to serve. A method-not-found error is
    // the protocol's own way to say that plainly.
    await this.#reply(message.id, undefined, {
      code: ACP_METHOD_NOT_FOUND_CODE,
      message: `Yui does not implement ACP method ${method}.`
    });
  }

  async #reply(id: unknown, result: unknown, error: JsonObject | undefined): Promise<void> {
    if (typeof id !== "number" && typeof id !== "string") return;
    try {
      await this.channel.send({
        jsonrpc: "2.0",
        id,
        ...(error === undefined ? { result: result ?? {} } : { error })
      });
    } catch {
      // The pipe is gone; the closure path already reports that fact.
    }
  }

  #fail(error: Error): void {
    this.#closed = error;
    for (const [id, waiter] of [...this.#pending]) {
      this.#pending.delete(id);
      waiter.reject(error);
    }
    // A prompt in flight when the transport died has no known outcome: the
    // Agent may have completed the work or never started it. Report that as
    // unknown delivery so the Turn is never resent and never recorded as a
    // result nobody observed. No terminal is emitted, because none was seen.
    const settle = this.#promptSettle;
    if (settle === undefined) return;
    this.#promptSettle = undefined;
    this.#resetAnswer();
    settle({
      kind: "unknown",
      message: `ACP transport closed while a Turn was in flight: ${error.message}`,
      cause: error
    });
  }
}

/** How one `session/prompt` call ended, from the transport's point of view. */
type PromptOutcome =
  | Readonly<{ kind: "answered"; observedAt: string }>
  | Readonly<{ kind: "unknown"; message: string; cause?: unknown }>;
