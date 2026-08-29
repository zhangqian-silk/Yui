import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection, createServer, type Server } from "node:net";
import { createInterface } from "node:readline";

import {
  callController,
  controllerCallMayHaveApplied,
  ControllerClientError
} from "../core/controllerClient.js";
import { readHomeFilesystemId } from "../core/homeFilesystemIdentity.js";
import { callFileTaskController } from "../controller/clientRuntime.js";
import { isForeignHandoverLockHeld } from "../release/runtimeRelease.js";
import {
  publishStructuredProviderAccepted,
  publishStructuredProviderActivationTerminal,
  publishStructuredConversationRecoverability,
  publishStructuredProviderOpened,
  publishStructuredProviderTerminal
} from "../controller/structuredProviderObservation.js";
import {
  validateAgentHostLaunchPayload,
  type AgentHostLaunchPayload
} from "./launchBroker.js";
import {
  ProviderDeliveryUnknownError,
  ProviderConversationMissingError,
  ProviderTurnRejectedError,
  startStructuredProviderSession,
  type StructuredProviderSession,
  type StructuredProviderTurnInput,
  type StructuredProviderTurnTerminal
} from "./structuredProviderHost.js";
import {
  sameProviderAuthorityFence,
  validateProviderAuthorityFence,
  type ProviderAuthorityFence
} from "./providerAuthorityFence.js";
import {
  validateRuntimeProcessExitObservation,
  type RuntimeProcessExitObservation
} from "./processExitObservation.js";
import {
  persistRuntimeProcessExitObservation,
  replayRuntimeProcessExitOutbox
} from "./processExitOutbox.js";
import {
  readRuntimeStopReceipt,
  removeRuntimeStopReceipt,
  writeRuntimeStopReceipt
} from "./runtimeStopReceipt.js";
import {
  AGENT_HOST_CONTROL_TIMEOUT_MS,
  AGENT_HOST_READY_TIMEOUT_MS
} from "./runtimeDeadlines.js";

export const AGENT_HOST_CONTROL_PROTOCOL = "yui-agent-host/v2" as const;
const HOST_CONTROL_MAX_BYTES = 32 * 1024;

export type AgentHostLaunchControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "launch";
  launchId: string;
  ticket: string;
}>;

export type AgentHostStatusControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "status";
}>;

export type AgentHostSubmitTurnControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "submit-turn";
  launchId: string;
  nativeSessionId: string;
  authority: ProviderAuthorityFence;
  turn: StructuredProviderTurnInput;
}>;

export type AgentHostSetAuthorityControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "set-authority";
  nativeSessionId: string;
  authority: ProviderAuthorityFence;
}>;

export type AgentHostControl =
  | AgentHostLaunchControl
  | AgentHostStatusControl
  | AgentHostSubmitTurnControl
  | AgentHostSetAuthorityControl;

export type AgentHostProviderState =
  | "idle"
  | "starting"
  | "ready"
  | "settling"
  | "delivery-unknown"
  | "rejected"
  | "failed"
  | "exited";

export type AgentHostSnapshot = Readonly<{
  schemaVersion: 1;
  state: AgentHostProviderState;
  launchId?: string;
  adapterId?: "codex" | "claude";
  processInstanceId?: string;
  nativeSessionId?: string;
  conversationId?: string;
  attemptId?: string;
  nativeTurnId?: string;
  authorityEpoch?: number;
  authorityOwner?: ProviderAuthorityFence["owner"];
  authorityHolderId?: string;
  detail?: string;
  updatedAt: string;
}>;

export type AgentHostControlOutcome =
  | "status"
  | "accepted"
  | "rejected"
  | "active-same-launch"
  | "active-other-launch";

export type AgentHostControlResult = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  outcome: AgentHostControlOutcome;
  snapshot: AgentHostSnapshot;
}>;

export function serializeAgentHostLaunchControl(control: AgentHostLaunchControl): string {
  return JSON.stringify(validateControl(control));
}

export async function runAgentHost(input: Readonly<{
  home: string;
  launchId: string;
  ticket: string;
}>): Promise<number> {
  const hostInstanceId = randomUUID();
  let hostSequence = 0;
  let payload = await redeem(input.home, input.launchId, input.ticket);
  let session: StructuredProviderSession | undefined;
  let sessionPayload: AgentHostLaunchPayload | undefined;
  let activeTurnPayload: AgentHostLaunchPayload | undefined;
  const switchDetachedSessions = new WeakSet<StructuredProviderSession>();
  let activationId: string | undefined;
  let conversationRecoverability: "unknown" | "recoverable" = "unknown";
  let authority: ProviderAuthorityFence | undefined;
  let hostStopRequested = false;
  let snapshot = hostSnapshot("idle");
  let dispatchTail = Promise.resolve();
  let promptHuman = (): void => {};
  await replayExitOutbox(input.home);

  const updateSnapshot = (next: AgentHostSnapshot): void => {
    snapshot = validateSnapshot(next);
  };

  const authorityFields = (): Pick<
    AgentHostSnapshot,
    "authorityEpoch" | "authorityOwner" | "authorityHolderId"
  > => authority === undefined ? {} : {
    authorityEpoch: authority.epoch,
    authorityOwner: authority.owner,
    authorityHolderId: authority.holderId
  };

  const handleTerminal = (terminal: StructuredProviderTurnTerminal): void => {
    const terminalPayload = activeTurnPayload;
    if (terminalPayload === undefined) return;
    const terminalActivationId = activationId ?? terminalPayload.launchId;
    void enqueueSerialized(async () => {
      if (activeTurnPayload !== terminalPayload) return;
      if (session !== undefined) {
        updateSnapshot(hostSnapshot("settling", {
          launchId: terminalPayload.launchId,
          adapterId: terminalPayload.providerControl!.adapterId,
          processInstanceId: session.processInstanceId,
          nativeSessionId: terminal.nativeSessionId,
          conversationId: terminal.conversationId,
          nativeTurnId: terminal.nativeTurnId,
          ...authorityFields()
        }));
      }
      try {
        await publishStructuredProviderTerminal({
          home: input.home,
          environment: terminalPayload.environment,
          activationId: terminalActivationId,
          terminal
        });
        if (activeTurnPayload !== terminalPayload) return;
        activeTurnPayload = undefined;
        if (session === undefined) return;
        const currentPayload = sessionPayload ?? terminalPayload;
        updateSnapshot(hostSnapshot("idle", {
          launchId: currentPayload.launchId,
          adapterId: currentPayload.providerControl!.adapterId,
          processInstanceId: session.processInstanceId,
          nativeSessionId: terminal.nativeSessionId,
          conversationId: terminal.conversationId,
          ...authorityFields()
        }));
        promptHuman();
      } catch (error) {
        updateSnapshot(hostSnapshot("failed", {
          launchId: terminalPayload.launchId,
          adapterId: terminalPayload.providerControl!.adapterId,
          processInstanceId: session?.processInstanceId,
          nativeSessionId: terminal.nativeSessionId,
          conversationId: terminal.conversationId,
          nativeTurnId: terminal.nativeTurnId,
          ...authorityFields(),
          detail: errorText(error)
        }));
      }
    }).catch(() => {});
  };

  const observeExit = (
    providerSession: StructuredProviderSession,
    launched: AgentHostLaunchPayload
  ): void => {
    void providerSession.waitForExit().then((result) => enqueueSerialized(async () => {
      const ownsCurrentSession = session === providerSession;
      const currentPayload = ownsCurrentSession ? sessionPayload ?? launched : launched;
      const currentActivationId = ownsCurrentSession
        ? activationId ?? launched.launchId
        : launched.launchId;
      const exitAuthority = authorityFields();
      if (ownsCurrentSession) {
        session = undefined;
        activationId = undefined;
        conversationRecoverability = "unknown";
        authority = undefined;
      }
      hostSequence += 1;
      const stopReceipt = readRuntimeStopReceipt(input.home, currentPayload.launchId);
      const observedAt = new Date().toISOString();
      const failures: string[] = [];
      if (!switchDetachedSessions.has(providerSession)) {
        try {
          await publishStructuredProviderActivationTerminal({
            home: input.home,
            environment: currentPayload.environment,
            conversationId: providerSession.conversationId,
            nativeSessionId: providerSession.nativeSessionId,
            activationId: currentActivationId,
            status: stopReceipt !== null || hostStopRequested ? "ended" : "failed",
            observedAt
          });
        } catch (error) {
          failures.push(`activation terminal: ${errorText(error)}`);
        }
      }
      let exitPersisted = false;
      try {
        await persistAndSubmitExit(input.home, validateRuntimeProcessExitObservation({
          schemaVersion: 1,
          observationId: `${hostInstanceId}-${hostSequence}`,
          hostSequence,
          hostInstanceId,
          providerProcessInstanceId: result.processInstanceId,
          ...(currentPayload.environment.YUI_TASK_ID === undefined
            ? {}
            : { taskId: currentPayload.environment.YUI_TASK_ID }),
          roleName: currentPayload.environment.YUI_ROLE ?? "unknown-role",
          ...(currentPayload.environment.YUI_RUN_ID === undefined
            ? {}
            : { runId: currentPayload.environment.YUI_RUN_ID }),
          launchId: currentPayload.launchId,
          ...(providerSession.nativeSessionId.length === 0
            ? {}
            : { nativeSessionId: providerSession.nativeSessionId }),
          processKind: "provider-child",
          ...(result.code === null ? {} : { exitCode: result.code }),
          ...(result.signal === null ? {} : { signal: result.signal }),
          ...(stopReceipt === null ? {} : { stopReceiptId: stopReceipt.receiptId }),
          observedAt
        }));
        exitPersisted = true;
      } catch (error) {
        failures.push(`process exit: ${errorText(error)}`);
      }
      if (stopReceipt !== null && exitPersisted) {
        removeRuntimeStopReceipt(input.home, currentPayload.launchId);
      }
      if (hostStopRequested || !ownsCurrentSession) return;
      updateSnapshot(hostSnapshot(failures.length === 0 ? "exited" : "failed", {
        launchId: currentPayload.launchId,
        adapterId: currentPayload.providerControl?.adapterId,
        processInstanceId: result.processInstanceId,
        nativeSessionId: providerSession.nativeSessionId,
        conversationId: providerSession.conversationId,
        ...exitAuthority,
        ...(failures.length !== 0
          ? { detail: failures.join("; ") }
          : activeTurnPayload === undefined
            ? {}
            : { detail: "Provider process exited before the active Turn reached a terminal boundary." })
      }));
    })).catch((error) => updateSnapshot(hostSnapshot("failed", {
      launchId: launched.launchId,
      adapterId: launched.providerControl?.adapterId,
      processInstanceId: providerSession.processInstanceId,
      ...authorityFields(),
      detail: errorText(error)
    })));
  };

  const dispatch = async (next: AgentHostLaunchPayload): Promise<AgentHostSnapshot> => {
    const providerControl = next.providerControl;
    if (providerControl === undefined) {
      throw new Error("Agent Host accepts only managed Provider control launches.");
    }
    if (activeTurnPayload !== undefined
      || ["starting", "ready", "settling", "delivery-unknown"].includes(snapshot.state)) {
      throw new Error("Agent Host still owns an unsettled Provider Turn.");
    }
    const requestedAuthority = validateProviderAuthorityFence(providerControl.authority);
    const replacesCurrentConversation = session !== undefined && providerControl.kind === "new";
    if (!replacesCurrentConversation && authority === undefined) authority = requestedAuthority;
    else if (!replacesCurrentConversation
      && authority !== undefined
      && !sameProviderAuthorityFence(authority, requestedAuthority)) {
      throw new Error("Agent Host launch carries a stale Provider authority fence.");
    }
    updateSnapshot(hostSnapshot("starting", {
      launchId: next.launchId,
      adapterId: providerControl.adapterId,
      ...(providerControl.initialTurn === undefined
        ? {}
        : { attemptId: providerControl.initialTurn.attemptId }),
      ...(session === undefined ? {} : {
        processInstanceId: session.processInstanceId,
        nativeSessionId: session.nativeSessionId,
        conversationId: session.conversationId
      }),
      ...authorityFields()
    }));
    let providerAcceptedAttemptId: string | undefined;
    let durableInitialTurn:
      | Readonly<Record<string, string | number>>
      | undefined;
    try {
      if (replacesCurrentConversation) {
        const previousSession = session!;
        const previousPayload = sessionPayload;
        const previousActivationId = activationId ?? previousPayload?.launchId;
        if (previousPayload === undefined || previousActivationId === undefined
          || authority?.owner !== "controller") {
          throw new Error("Agent Host cannot detach an inexact Provider Activation.");
        }
        await detachDurableProviderForConversationSwitch(input.home, {
          taskId: requiredEnvironment(next.environment.YUI_TASK_ID, "Task id"),
          roleName: requiredEnvironment(next.environment.YUI_ROLE, "Role name"),
          runId: requiredEnvironment(next.environment.YUI_RUN_ID, "Run id"),
          agentId: requiredEnvironment(next.environment.YUI_AGENT_ID, "Agent id"),
          launchId: next.launchId,
          previousConversationId: previousSession.conversationId,
          previousNativeSessionId: previousSession.nativeSessionId,
          previousActivationId,
          nextAuthorityEpoch: requestedAuthority.epoch,
          nextAuthorityHolderId: requestedAuthority.holderId,
          observedAt: new Date().toISOString()
        });
        switchDetachedSessions.add(previousSession);
        // The persistent Provider child belongs to the Activation that first
        // created it, not to the most recent resume Run payload. The exit
        // observer carries that Activation launch id, so the stop receipt must
        // use the same identity or the expected switch detach is misclassified
        // as an abnormal child exit and generic cleanup can kill the Host.
        writeRuntimeStopReceipt(input.home, previousActivationId, new Date());
        authority = undefined;
        await terminateProviderSessionForConversationSwitch(previousSession);
        if (session === previousSession) session = undefined;
        sessionPayload = undefined;
        activationId = undefined;
        conversationRecoverability = "unknown";
        authority = requestedAuthority;
      }
      if (session !== undefined) {
        if (session.adapterId !== providerControl.adapterId
          || providerControl.mode !== "resume"
          || providerControl.nativeSessionId !== session.nativeSessionId) {
          throw new Error("Agent Host launch does not match its live Provider Conversation.");
        }
        sessionPayload = next;
      } else {
        activationId = next.launchId;
        conversationRecoverability = providerControl.adapterId === "codex"
          ? "recoverable"
          : "unknown";
        const started = await startStructuredProviderSession(next, { onTerminal: handleTerminal });
        session = started.session;
        sessionPayload = next;
        observeExit(started.session, next);
      }
      await publishStructuredProviderOpened({
        home: input.home,
        environment: next.environment,
        conversationId: session.conversationId,
        nativeSessionId: session.nativeSessionId,
        activationId: activationId ?? next.launchId,
        recoverability: conversationRecoverability,
        observedAt: new Date().toISOString()
      });
      let receipt;
      if (providerControl.initialTurn !== undefined) {
        durableInitialTurn = hostTurnControlParams(
          next,
          session.nativeSessionId,
          requestedAuthority,
          providerControl.initialTurn.attemptId
        );
        await beginDurableProviderTurn(input.home, durableInitialTurn);
        activeTurnPayload = next;
        try {
          receipt = await session.submitTurn(providerControl.initialTurn);
          providerAcceptedAttemptId = receipt.attemptId;
        } catch (error) {
          await resolveProviderTurnSubmission(input.home, durableInitialTurn, error);
          throw error;
        }
      }
      if (receipt !== undefined) {
        conversationRecoverability = "recoverable";
        try {
          await publishStructuredProviderAccepted({
            home: input.home,
            environment: next.environment,
            activationId: activationId ?? next.launchId,
            receipt
          });
        } catch (error) {
          await resolveProviderTurnSubmission(
            input.home,
            durableInitialTurn!,
            new ProviderDeliveryUnknownError(
              `Provider accepted input but its durable acknowledgement could not be confirmed: ${
                errorText(error)
              }`,
              receipt.attemptId
            )
          );
          throw error;
        }
      }
      updateSnapshot(hostSnapshot(receipt === undefined ? "idle" : "ready", {
        launchId: next.launchId,
        adapterId: providerControl.adapterId,
        processInstanceId: session.processInstanceId,
        nativeSessionId: receipt?.nativeSessionId ?? session.nativeSessionId,
        conversationId: receipt?.conversationId ?? session.conversationId,
        ...(receipt === undefined ? {} : {
          attemptId: receipt.attemptId,
          nativeTurnId: receipt.nativeTurnId
        }),
        ...authorityFields()
      }));
      return snapshot;
    } catch (error) {
      if (error instanceof ProviderConversationMissingError) {
        await publishStructuredConversationRecoverability({
          home: input.home,
          environment: next.environment,
          conversationId: error.conversationId,
          activationId: activationId ?? next.launchId,
          recoverability: "unrecoverable",
          observedAt: new Date().toISOString()
        }).catch(() => {});
      }
      if (session === undefined) {
        activationId = undefined;
        conversationRecoverability = "unknown";
        authority = undefined;
      }
      const deliveryUnknown = error instanceof ProviderDeliveryUnknownError
        || providerAcceptedAttemptId !== undefined;
      const state = deliveryUnknown
        ? "delivery-unknown"
        : error instanceof ProviderTurnRejectedError ? "rejected" : "failed";
      updateSnapshot(hostSnapshot(state, {
        launchId: next.launchId,
        adapterId: providerControl.adapterId,
        processInstanceId: session?.processInstanceId,
        nativeSessionId: session?.nativeSessionId ?? providerControl.nativeSessionId,
        conversationId: session?.conversationId ?? providerControl.nativeSessionId,
        ...(providerControl.initialTurn === undefined
          ? {}
          : { attemptId: providerControl.initialTurn.attemptId }),
        ...authorityFields(),
        detail: errorText(error)
      }));
      if (state !== "delivery-unknown") activeTurnPayload = undefined;
      if (deliveryUnknown && !(error instanceof ProviderDeliveryUnknownError)) {
        throw new ProviderDeliveryUnknownError(
          `Provider accepted input but its durable acknowledgement could not be confirmed: ${
            errorText(error)
          }`,
          providerAcceptedAttemptId!
        );
      }
      throw error;
    }
  };

  const enqueueSerialized = <T>(action: () => Promise<T>): Promise<T> => {
    const operation = dispatchTail.then(action);
    dispatchTail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const enqueueDispatch = (next: AgentHostLaunchPayload): Promise<AgentHostSnapshot> => (
    enqueueSerialized(() => dispatch(next))
  );

  const submitTurn = async (request: AgentHostSubmitTurnControl): Promise<AgentHostSnapshot> => {
    if (session === undefined || sessionPayload === undefined) {
      throw new Error("Agent Host has no live Provider Conversation.");
    }
    if (request.nativeSessionId !== session.nativeSessionId) {
      throw new Error("Agent Host Turn targets a different Provider Conversation.");
    }
    if (authority === undefined
      || !sameProviderAuthorityFence(authority, request.authority)) {
      throw new Error("Agent Host rejected a stale Provider writer fence.");
    }
    if (activeTurnPayload !== undefined || snapshot.state === "settling") {
      throw new Error("Agent Host still owns an unsettled Provider Turn.");
    }
    activeTurnPayload = sessionPayload;
    updateSnapshot(hostSnapshot("starting", {
      launchId: request.launchId,
      adapterId: session.adapterId,
      processInstanceId: session.processInstanceId,
      nativeSessionId: session.nativeSessionId,
      conversationId: session.conversationId,
      attemptId: request.turn.attemptId,
      ...authorityFields()
    }));
    let providerAccepted = false;
    try {
      const receipt = await session.submitTurn(request.turn);
      providerAccepted = true;
      await publishStructuredProviderAccepted({
        home: input.home,
        environment: sessionPayload.environment,
        activationId: activationId ?? sessionPayload.launchId,
        receipt
      });
      updateSnapshot(hostSnapshot("ready", {
        launchId: request.launchId,
        adapterId: session.adapterId,
        processInstanceId: session.processInstanceId,
        nativeSessionId: receipt.nativeSessionId,
        conversationId: receipt.conversationId,
        attemptId: receipt.attemptId,
        nativeTurnId: receipt.nativeTurnId,
        ...authorityFields()
      }));
      return snapshot;
    } catch (error) {
      const deliveryUnknown = error instanceof ProviderDeliveryUnknownError || providerAccepted;
      const state = deliveryUnknown
        ? "delivery-unknown"
        : error instanceof ProviderTurnRejectedError ? "rejected" : "failed";
      updateSnapshot(hostSnapshot(state, {
        launchId: request.launchId,
        adapterId: session.adapterId,
        processInstanceId: session.processInstanceId,
        nativeSessionId: session.nativeSessionId,
        conversationId: session.conversationId,
        attemptId: request.turn.attemptId,
        ...authorityFields(),
        detail: errorText(error)
      }));
      if (state !== "delivery-unknown") activeTurnPayload = undefined;
      if (deliveryUnknown && !(error instanceof ProviderDeliveryUnknownError)) {
        throw new ProviderDeliveryUnknownError(
          `Provider accepted input but its durable acknowledgement could not be confirmed: ${
            errorText(error)
          }`,
          request.turn.attemptId
        );
      }
      throw error;
    }
  };

  const setAuthority = (request: AgentHostSetAuthorityControl): AgentHostSnapshot => {
    if (session === undefined || request.nativeSessionId !== session.nativeSessionId) {
      throw new Error("Agent Host authority targets a different Provider Conversation.");
    }
    if (activeTurnPayload !== undefined
      || ["starting", "ready", "settling", "delivery-unknown"].includes(snapshot.state)) {
      throw new Error("Agent Host authority cannot transfer while a Turn is unsettled.");
    }
    const next = validateProviderAuthorityFence(request.authority);
    if (authority !== undefined) {
      if (sameProviderAuthorityFence(authority, next)) return snapshot;
      if (next.epoch <= authority.epoch) {
        throw new Error("Agent Host authority epoch did not advance monotonically.");
      }
    }
    authority = next;
    updateSnapshot(hostSnapshot("idle", {
      launchId: sessionPayload?.launchId ?? snapshot.launchId,
      adapterId: session.adapterId,
      processInstanceId: session.processInstanceId,
      nativeSessionId: session.nativeSessionId,
      conversationId: session.conversationId,
      ...authorityFields()
    }));
    promptHuman();
    return snapshot;
  };

  const control = await openAgentHostControl(input.home, payload, () => snapshot, async (request) => {
    if (request.type === "status") {
      return controlResult("status", snapshot);
    }
    if (request.type === "submit-turn") {
      const accepted = await enqueueSerialized(() => submitTurn(request));
      return controlResult("accepted", accepted);
    }
    if (request.type === "set-authority") {
      const accepted = await enqueueSerialized(async () => setAuthority(request));
      return controlResult("accepted", accepted);
    }
    if (snapshot.launchId === request.launchId
      && ["starting", "ready", "settling", "delivery-unknown"].includes(snapshot.state)) {
      return controlResult("active-same-launch", snapshot);
    }
    const redeemed = await redeem(input.home, request.launchId, request.ticket);
    if (activeTurnPayload !== undefined
      || ["starting", "ready", "settling", "delivery-unknown"].includes(snapshot.state)) {
      return controlResult("active-other-launch", snapshot);
    }
    const accepted = await enqueueDispatch(redeemed);
    return controlResult("accepted", accepted);
  });

  const humanConsole = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    : undefined;
  promptHuman = (): void => {
    if (humanConsole !== undefined && authority?.owner === "human"
      && activeTurnPayload === undefined
      && ["idle", "rejected", "failed"].includes(snapshot.state)) {
      humanConsole.setPrompt("yui(provider)> ");
      humanConsole.prompt();
    }
  };
  humanConsole?.on("line", (line) => {
    void enqueueSerialized(async () => {
      const currentAuthority = authority;
      const currentSession = session;
      const currentPayload = sessionPayload;
      if (currentAuthority?.owner !== "human"
        || currentSession === undefined
        || currentPayload === undefined) {
        process.stderr.write("Provider input rejected: human authority is not active.\n");
        return;
      }
      const boundedText = line.trim();
      if (boundedText.length === 0) return;
      const attemptId = `human:${currentAuthority.holderId}:${randomUUID()}`;
      const turnControl = {
        protocol: AGENT_HOST_CONTROL_PROTOCOL,
        type: "submit-turn" as const,
        launchId: currentPayload.launchId,
        nativeSessionId: currentSession.nativeSessionId,
        authority: currentAuthority,
        turn: {
          attemptId,
          boundedText
        }
      };
      const durableTurn = hostTurnControlParams(
        currentPayload,
        currentSession.nativeSessionId,
        currentAuthority,
        attemptId
      );
      await beginDurableProviderTurn(input.home, durableTurn);
      try {
        await submitTurn(turnControl);
      } catch (error) {
        await resolveProviderTurnSubmission(input.home, durableTurn, error);
        throw error;
      }
      process.stdout.write("Provider accepted the human Turn; waiting for its terminal boundary.\n");
    }).catch((error) => {
      process.stderr.write(`Provider input failed: ${errorText(error)}\n`);
      promptHuman();
    });
  });
  promptHuman();

  let stopResolve!: () => void;
  const stopped = new Promise<void>((resolvePromise) => {
    stopResolve = resolvePromise;
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  let forceKillTimer: NodeJS.Timeout | undefined;
  for (const signal of signals) {
    const handler = () => {
      if (hostStopRequested) return;
      hostStopRequested = true;
      session?.terminate(signal);
      forceKillTimer = setTimeout(() => session?.terminate("SIGKILL"), 10_000);
      forceKillTimer.unref();
      stopResolve();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    if (payload.startMode === "provider") {
      void enqueueDispatch(payload).catch(() => {});
    }
    await stopped;
    return 0;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    humanConsole?.close();
    session?.terminate("SIGTERM");
    await control.close();
    void sessionPayload;
  }
}

export function agentHostControlSocketPath(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
}>): string {
  const owner = input.scope === "task" ? input.taskId ?? "missing-task" : "global";
  const homeDigest = createHash("sha256")
    .update(readHomeFilesystemId(resolve(input.home)))
    .digest("hex")
    .slice(0, 16);
  const ownerDigest = createHash("sha256")
    .update(`${input.scope}\0${owner}\0${input.roleName}`)
    .digest("hex")
    .slice(0, 16);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  // Linux sockaddr_un paths have a small fixed budget. Keep the endpoint
  // independent of a potentially deep YUI_HOME while fencing aliases and
  // copied Homes by their physical filesystem identity.
  const root = process.platform === "linux" ? "/tmp" : tmpdir();
  return join(root, `yui-${uid}`, "agent-host", `${homeDigest}-${ownerDigest}.sock`);
}

export async function sendAgentHostLaunchControl(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  control: AgentHostLaunchControl;
}>): Promise<AgentHostControlResult> {
  return await sendAgentHostControl(input);
}

export async function sendAgentHostTurnControl(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  control: AgentHostSubmitTurnControl;
}>): Promise<AgentHostControlResult> {
  return await sendAgentHostControl(input);
}

export async function sendAgentHostAuthorityControl(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  control: AgentHostSetAuthorityControl;
}>): Promise<AgentHostControlResult> {
  return await sendAgentHostControl(input);
}

export async function inspectAgentHost(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
}>): Promise<AgentHostSnapshot> {
  const result = await sendAgentHostControl({
    ...input,
    control: { protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "status" }
  });
  return result.snapshot;
}

export async function waitForAgentHostLaunchAck(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  launchId: string;
  requireTurnAck?: boolean;
  timeoutMs?: number;
}>): Promise<AgentHostSnapshot> {
  const deadline = Date.now() + (input.timeoutMs ?? AGENT_HOST_READY_TIMEOUT_MS);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const snapshot = await inspectAgentHost(input);
      if (snapshot.launchId === input.launchId) {
        if (snapshot.state === "ready"
          || (input.requireTurnAck !== true && snapshot.state === "idle")) return snapshot;
        if (snapshot.state === "delivery-unknown" || snapshot.state === "rejected") {
          return snapshot;
        }
        if (snapshot.state === "failed" || snapshot.state === "exited") {
          throw new Error(
            `Agent Host Provider launch ${snapshot.state}: ${snapshot.detail ?? "no detail"}.`
          );
        }
      }
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(
    `Agent Host did not acknowledge Provider launch ${input.launchId}: ${errorText(lastError)}.`
  );
}

async function sendAgentHostControl(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  control: AgentHostControl;
}>): Promise<AgentHostControlResult> {
  const path = agentHostControlSocketPath(input);
  return await new Promise((resolvePromise, reject) => {
    const client = createConnection(path);
    let response = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("Agent Host control request timed out."));
    }, AGENT_HOST_CONTROL_TIMEOUT_MS);
    let settled = false;
    const settle = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    client.setEncoding("utf8");
    client.once("connect", () => client.end(`${JSON.stringify(validateControl(input.control))}\n`));
    client.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > HOST_CONTROL_MAX_BYTES) {
        client.destroy(new Error("Agent Host control response exceeds its bound."));
      }
    });
    client.once("error", (error) => settle(reject, error));
    client.once("close", () => {
      try {
        settle(resolvePromise, validateControlResult(JSON.parse(response.trim()) as AgentHostControlResult));
      } catch (error) {
        settle(reject, error as Error);
      }
    });
  });
}

async function redeem(home: string, launchId: string, ticket: string): Promise<AgentHostLaunchPayload> {
  const result = await callController(home, "runtime.launch-redeem", {
    launchId,
    ticket,
    hostPid: process.pid
  });
  return validateAgentHostLaunchPayload(result);
}

async function persistAndSubmitExit(home: string, observation: RuntimeProcessExitObservation): Promise<void> {
  try {
    await persistRuntimeProcessExitObservation(
      home,
      observation,
      (value) => callController(home, "runtime.process-exit-observe", value).then(() => undefined)
    );
  } catch (error) {
    // The durable outbox is the acknowledgement during a planned Controller
    // gap. The replacement Controller drains it before accepting new work.
    if (isForeignHandoverLockHeld(home)) return;
    throw error;
  }
}

async function replayExitOutbox(home: string): Promise<void> {
  await replayRuntimeProcessExitOutbox(
    home,
    (observation) => callController(
      home,
      "runtime.process-exit-observe",
      observation
    ).then(() => undefined)
  );
}

/** Internal socket boundary exported for transport-level verification. */
export async function openAgentHostControl(
  home: string,
  payload: AgentHostLaunchPayload,
  snapshot: () => AgentHostSnapshot,
  dispatch: (control: AgentHostControl) => Promise<AgentHostControlResult>
): Promise<Readonly<{ close(): Promise<void> }>> {
  const path = agentHostControlSocketPath({
    home,
    scope: payload.environment.YUI_SESSION_SCOPE ?? "task",
    ...(payload.environment.YUI_TASK_ID === undefined
      ? {}
      : { taskId: payload.environment.YUI_TASK_ID }),
    roleName: payload.environment.YUI_ROLE ?? "unknown-role"
  });
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (await hostControlSocketIsLive(path)) {
    throw new Error(`Agent Host control socket is already owned: ${path}.`);
  }
  rmSync(path, { force: true });
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    // A control client can disappear after sending its bounded request. Keep
    // that connection-local failure from terminating the persistent Host.
    socket.on("error", () => {});
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > HOST_CONTROL_MAX_BYTES) {
        socket.destroy(new Error("Agent Host control request exceeds its bound."));
      }
    });
    socket.once("end", () => {
      void (async () => {
        try {
          const request = validateControl(JSON.parse(body.trim()) as AgentHostControl);
          socket.end(`${JSON.stringify(await dispatch(request))}\n`);
        } catch (error) {
          const current = snapshot();
          socket.end(`${JSON.stringify(controlResult("rejected", validateSnapshot({
            ...current,
            detail: errorText(error),
            updatedAt: new Date().toISOString()
          })))}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolvePromise());
  });
  chmodSync(path, 0o600);
  return Object.freeze({
    close: async (): Promise<void> => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      rmSync(path, { force: true });
    }
  });
}

async function hostControlSocketIsLive(path: string): Promise<boolean> {
  return await new Promise((resolvePromise, reject) => {
    const client = createConnection(path);
    const timer = setTimeout(() => finish(false), 1_000);
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      client.removeAllListeners();
      client.destroy();
      resolvePromise(value);
    };
    client.once("connect", () => finish(true));
    client.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish(false);
      else reject(error);
    });
  });
}

function validateControl(control: AgentHostControl): AgentHostControl {
  if (control.protocol !== AGENT_HOST_CONTROL_PROTOCOL) {
    throw new Error("Agent Host control protocol is invalid.");
  }
  if (control.type === "status") return Object.freeze({ ...control });
  if (control.type === "submit-turn") {
    validateLaunchId(control.launchId);
    validateIdentity(control.nativeSessionId, "native Session id");
    validateProviderAuthorityFence(control.authority);
    validateIdentity(control.turn.attemptId, "Provider input attempt id");
    if (typeof control.turn.boundedText !== "string"
      || control.turn.boundedText.includes("\0")
      || Buffer.byteLength(control.turn.boundedText, "utf8") > 32 * 1024) {
      throw new Error("Agent Host Provider input is invalid.");
    }
    return Object.freeze({
      ...control,
      turn: Object.freeze({ ...control.turn })
    });
  }
  if (control.type === "set-authority") {
    validateIdentity(control.nativeSessionId, "native Session id");
    return Object.freeze({
      ...control,
      authority: validateProviderAuthorityFence(control.authority)
    });
  }
  if (control.type !== "launch") throw new Error("Agent Host control type is invalid.");
  validateLaunchId(control.launchId);
  if (typeof control.ticket !== "string" || !/^[a-f0-9]{64}$/u.test(control.ticket)) {
    throw new Error("Agent Host launch control ticket is invalid.");
  }
  return Object.freeze({ ...control });
}

function validateLaunchId(value: string): void {
  if (typeof value !== "string" || value.length === 0
    || value.length > 256 || value.includes("\0")) {
    throw new Error("Agent Host launch control identity is invalid.");
  }
}

function validateIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Agent Host ${label} is invalid.`);
  }
}

function validateControlResult(result: AgentHostControlResult): AgentHostControlResult {
  if (result.protocol !== AGENT_HOST_CONTROL_PROTOCOL
    || !["status", "accepted", "rejected", "active-same-launch", "active-other-launch"].includes(
      result.outcome
    )) {
    throw new Error("Agent Host control response is invalid.");
  }
  return Object.freeze({ ...result, snapshot: validateSnapshot(result.snapshot) });
}

function validateSnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot {
  if (snapshot.schemaVersion !== 1
    || !["idle", "starting", "ready", "settling", "delivery-unknown", "rejected", "failed", "exited"]
      .includes(snapshot.state)) {
    throw new Error("Agent Host snapshot is invalid.");
  }
  if (!Number.isFinite(Date.parse(snapshot.updatedAt))) {
    throw new Error("Agent Host snapshot timestamp is invalid.");
  }
  const authorityFields = [
    snapshot.authorityEpoch,
    snapshot.authorityOwner,
    snapshot.authorityHolderId
  ];
  if (authorityFields.some((value) => value !== undefined)) {
    if (authorityFields.some((value) => value === undefined)) {
      throw new Error("Agent Host snapshot authority is incomplete.");
    }
    validateProviderAuthorityFence({
      epoch: snapshot.authorityEpoch!,
      owner: snapshot.authorityOwner!,
      holderId: snapshot.authorityHolderId!
    });
  }
  return Object.freeze({ ...snapshot });
}

function hostSnapshot(
  state: AgentHostProviderState,
  fields: Partial<Omit<AgentHostSnapshot, "schemaVersion" | "state" | "updatedAt">> = {}
): AgentHostSnapshot {
  return validateSnapshot({
    schemaVersion: 1,
    state,
    ...definedFields(fields),
    updatedAt: new Date().toISOString()
  });
}

function controlResult(
  outcome: AgentHostControlOutcome,
  snapshot: AgentHostSnapshot
): AgentHostControlResult {
  return Object.freeze({ protocol: AGENT_HOST_CONTROL_PROTOCOL, outcome, snapshot });
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined)
  ) as Partial<T>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function hostTurnControlParams(
  payload: AgentHostLaunchPayload,
  nativeSessionId: string,
  authority: ProviderAuthorityFence,
  attemptId: string
): Readonly<Record<string, string | number>> {
  const environment = payload.environment;
  return Object.freeze({
    taskId: requiredEnvironment(environment.YUI_TASK_ID, "Task id"),
    roleName: requiredEnvironment(environment.YUI_ROLE, "Role name"),
    runId: requiredEnvironment(environment.YUI_RUN_ID, "Run id"),
    agentId: requiredEnvironment(environment.YUI_AGENT_ID, "Agent id"),
    launchId: payload.launchId,
    nativeSessionId: requiredEnvironment(nativeSessionId, "native Session id"),
    attemptId,
    authorityEpoch: authority.epoch,
    authorityOwner: authority.owner,
    holderId: authority.holderId,
    observedAt: new Date().toISOString()
  });
}

async function beginDurableProviderTurn(
  home: string,
  durableTurn: Readonly<Record<string, string | number>>
): Promise<void> {
  try {
    await callControllerIdempotently(home, "runtime.provider-turn-begin", durableTurn);
  } catch (error) {
    if (!(error instanceof ControllerAcknowledgementUnknownError)) throw error;
    await resolveProviderTurnSubmission(
      home,
      durableTurn,
      new Error(`Provider Turn intent acknowledgement failed before Provider write: ${errorText(error)}`)
    );
    throw error;
  }
}

async function detachDurableProviderForConversationSwitch(
  home: string,
  request: Readonly<Record<string, string | number>>
): Promise<void> {
  await callControllerIdempotently(home, "runtime.conversation-switch-detach", request);
}

async function callControllerIdempotently(
  home: string,
  method: string,
  request: Readonly<Record<string, string | number>>
): Promise<void> {
  try {
    await callAgentController(home, method, request);
  } catch (error) {
    if (!(error instanceof ControllerClientError)
      || (error.code !== "INTERNAL_ERROR" && !controllerCallMayHaveApplied(error))) {
      throw error;
    }
    const firstCallMayHaveApplied = controllerCallMayHaveApplied(error);
    // These methods carry exact attempt, launch, and authority fences. A
    // bounded replay confirms a commit whose acknowledgement may have been lost.
    try {
      await callAgentController(home, method, request);
    } catch (replayError) {
      if (firstCallMayHaveApplied || controllerCallMayHaveApplied(replayError)) {
        throw new ControllerAcknowledgementUnknownError(
          `${method} may have been committed, but its acknowledgement could not be confirmed: ${
            errorText(replayError)
          }`
        );
      }
      throw replayError;
    }
  }
}

class ControllerAcknowledgementUnknownError extends Error {
  readonly name = "ControllerAcknowledgementUnknownError";
}

async function terminateProviderSessionForConversationSwitch(
  providerSession: StructuredProviderSession
): Promise<void> {
  providerSession.terminate("SIGTERM");
  const forceKill = setTimeout(() => providerSession.terminate("SIGKILL"), 3_000);
  forceKill.unref();
  let hardTimeout: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    hardTimeout = setTimeout(() => reject(new Error(
      "Old Provider Activation did not exit after its switch authority was revoked."
    )), 8_000);
    hardTimeout.unref();
  });
  try {
    await Promise.race([providerSession.waitForExit(), timeout]);
  } finally {
    clearTimeout(forceKill);
    if (hardTimeout !== undefined) clearTimeout(hardTimeout);
  }
}

async function resolveProviderTurnSubmission(
  home: string,
  durableTurn: Readonly<Record<string, string | number>>,
  error: unknown
): Promise<void> {
  const attemptId = durableTurn.attemptId;
  if (typeof attemptId !== "string") {
    throw new Error("Provider Turn resolution has no attempt id.");
  }
  const request = {
    ...durableTurn,
    status: error instanceof ProviderDeliveryUnknownError
      ? "delivery-unknown"
      : "rejected",
    reason: errorText(error),
    observedAt: new Date().toISOString()
  } as const;
  try {
    await callControllerIdempotently(
      home,
      "runtime.provider-turn-submission-resolve",
      request
    );
  } catch (resolutionError) {
    throw new ProviderDeliveryUnknownError(
      `Provider submission outcome could not be durably resolved: ${
        errorText(resolutionError)
      }. Original outcome: ${errorText(error)}`,
      attemptId
    );
  }
}

/**
 * Existing in-flight launches keep using the old Controller while it drains.
 * If the socket is already gone under an explicit handover fence, wait for
 * the replacement and retry the domain-idempotent Agent Host operation.
 */
async function callAgentController(
  home: string,
  method: string,
  params: Readonly<Record<string, string | number>>
): Promise<void> {
  try {
    await callController(home, method, params);
    return;
  } catch (error) {
    if (!isControllerUnavailable(error) || !isForeignHandoverLockHeld(home)) {
      throw error;
    }
  }
  await callFileTaskController(home, method, params);
}

function isControllerUnavailable(error: unknown): boolean {
  return error instanceof ControllerClientError
    && (error.code === "CONTROLLER_NOT_RUNNING"
      || error.code === "CONTROLLER_UNAVAILABLE"
      || error.code === "CONTROLLER_DRAINING");
}

function requiredEnvironment(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Agent Host ${label} is unavailable.`);
  }
  return value.trim();
}
