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
  ProviderTurnBusyError,
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
const CODEX_CLIENT_STABLE_MS = 5_000;
const MAX_CONSECUTIVE_CODEX_DISCONNECTS = 3;

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
  | "busy"
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
  let activeTurnAttemptId: string | undefined;
  let activeNativeTurnId: string | undefined;
  let codexClientAttachedAt: number | undefined;
  let consecutiveCodexDisconnects = 0;
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
    if (!terminal.clientOwned) {
      const busyPayload = sessionPayload;
      if (
        busyPayload === undefined
        || session === undefined
        || terminal.conversationId !== session.conversationId
      ) return;
      // Another ordinary client completed a Turn. It never enters Yui's Run
      // observation path; it only removes backpressure from retained work.
      if (snapshot.state === "busy") {
        updateSnapshot(hostSnapshot("idle", {
          launchId: busyPayload.launchId,
          adapterId: session.adapterId,
          processInstanceId: session.processInstanceId,
          nativeSessionId: session.nativeSessionId,
          conversationId: session.conversationId,
          ...authorityFields()
        }));
      }
      signalRoleMailbox(input.home, busyPayload);
      return;
    }
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
        activeTurnAttemptId = undefined;
        activeNativeTurnId = undefined;
        if (session === undefined) return;
        const currentPayload = sessionPayload ?? terminalPayload;
        updateSnapshot(hostSnapshot(session.activeTurnId === undefined ? "idle" : "busy", {
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

  const reconnectCodexClient = async (
    disconnectedSession: StructuredProviderSession,
    currentPayload: AgentHostLaunchPayload
  ): Promise<void> => {
    const previousControl = currentPayload.providerControl;
    if (previousControl?.adapterId !== "codex" || authority === undefined) {
      throw new Error("Codex client reconnect lost its Provider control identity.");
    }
    const ownedTurn = activeTurnPayload === undefined
      || activeTurnAttemptId === undefined
      || activeNativeTurnId === undefined
      ? undefined
      : { attemptId: activeTurnAttemptId, turnId: activeNativeTurnId };
    const reconnectPayload: AgentHostLaunchPayload = {
      ...currentPayload,
      environment: activeTurnPayload?.environment ?? currentPayload.environment,
      providerControl: {
        schemaVersion: 1,
        adapterId: "codex",
        transport: "codex-app-server-proxy",
        kind: "ensure",
        mode: "resume",
        nativeSessionId: disconnectedSession.nativeSessionId,
        ...(previousControl.sessionTitle === undefined
          ? {}
          : { sessionTitle: previousControl.sessionTitle }),
        codexThread: previousControl.codexThread!,
        ...(ownedTurn === undefined ? {} : { ownedTurn }),
        authority
      }
    };
    const delays = [0, 250, 1_000] as const;
    let lastError: unknown;
    for (const delayMs of delays) {
      if (hostStopRequested) return;
      if (delayMs !== 0) await delay(delayMs);
      if (hostStopRequested) return;
      try {
        const started = await startStructuredProviderSession(reconnectPayload, {
          onTerminal: handleTerminal
        });
        session = started.session;
        sessionPayload = currentPayload;
        conversationRecoverability = "recoverable";
        codexClientAttachedAt = Date.now();
        observeExit(started.session, currentPayload);
        const reconnectState = activeTurnPayload !== undefined
          ? ownedTurn === undefined ? "delivery-unknown" : "ready"
          : started.session.activeTurnId === undefined ? "idle" : "busy";
        updateSnapshot(hostSnapshot(reconnectState, {
          launchId: currentPayload.launchId,
          adapterId: "codex",
          processInstanceId: started.session.processInstanceId,
          nativeSessionId: started.session.nativeSessionId,
          conversationId: started.session.conversationId,
          ...(activeTurnAttemptId === undefined ? {} : { attemptId: activeTurnAttemptId }),
          ...(activeNativeTurnId === undefined ? {} : { nativeTurnId: activeNativeTurnId }),
          ...authorityFields(),
          ...(ownedTurn !== undefined || activeTurnPayload === undefined
            ? {}
            : {
                detail: "Codex client reattached, but the in-flight Turn has no exact native identity."
              })
        }));
        if (started.recoveredTerminal !== undefined) {
          handleTerminal(started.recoveredTerminal);
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    updateSnapshot(hostSnapshot("failed", {
      launchId: currentPayload.launchId,
      adapterId: "codex",
      processInstanceId: disconnectedSession.processInstanceId,
      nativeSessionId: disconnectedSession.nativeSessionId,
      conversationId: disconnectedSession.conversationId,
      ...(activeTurnAttemptId === undefined ? {} : { attemptId: activeTurnAttemptId }),
      ...(activeNativeTurnId === undefined ? {} : { nativeTurnId: activeNativeTurnId }),
      ...authorityFields(),
      detail: `Codex client could not reattach after bounded retries: ${errorText(lastError)}`
    }));
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
      const stopReceipt = readRuntimeStopReceipt(input.home, currentPayload.launchId);
      const reconnectableCodexClient = ownsCurrentSession
        && providerSession.adapterId === "codex"
        && !hostStopRequested
        && stopReceipt === null;
      if (reconnectableCodexClient) {
        session = undefined;
        if (codexClientAttachedAt !== undefined
          && Date.now() - codexClientAttachedAt >= CODEX_CLIENT_STABLE_MS) {
          consecutiveCodexDisconnects = 0;
        }
        consecutiveCodexDisconnects += 1;
        if (consecutiveCodexDisconnects > MAX_CONSECUTIVE_CODEX_DISCONNECTS) {
          updateSnapshot(hostSnapshot("failed", {
            launchId: currentPayload.launchId,
            adapterId: "codex",
            processInstanceId: result.processInstanceId,
            nativeSessionId: providerSession.nativeSessionId,
            conversationId: providerSession.conversationId,
            ...(activeTurnAttemptId === undefined ? {} : { attemptId: activeTurnAttemptId }),
            ...(activeNativeTurnId === undefined ? {} : { nativeTurnId: activeNativeTurnId }),
            ...exitAuthority,
            detail: "Codex client repeatedly disconnected before reaching a stable attachment."
          }));
          return;
        }
        updateSnapshot(hostSnapshot("starting", {
          launchId: currentPayload.launchId,
          adapterId: "codex",
          processInstanceId: result.processInstanceId,
          nativeSessionId: providerSession.nativeSessionId,
          conversationId: providerSession.conversationId,
          ...(activeTurnAttemptId === undefined ? {} : { attemptId: activeTurnAttemptId }),
          ...(activeNativeTurnId === undefined ? {} : { nativeTurnId: activeNativeTurnId }),
          ...exitAuthority,
          detail: "Codex App Server proxy disconnected; attaching a replacement client."
        }));
        await reconnectCodexClient(providerSession, currentPayload);
        return;
      }
      if (ownsCurrentSession) {
        session = undefined;
        activationId = undefined;
        conversationRecoverability = "unknown";
        authority = undefined;
      }
      hostSequence += 1;
      const observedAt = new Date().toISOString();
      const failures: string[] = [];
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
    if (replacesCurrentConversation) {
      throw new Error(
        "Agent Host cannot replace a live Provider Session; stop it before starting a fresh Session."
      );
    }
    if (authority === undefined) authority = requestedAuthority;
    else if (authority !== undefined
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
        if (providerControl.kind === "ensure" && providerControl.ownedTurn !== undefined) {
          activeTurnPayload = next;
          activeTurnAttemptId = providerControl.ownedTurn.attemptId;
          activeNativeTurnId = providerControl.ownedTurn.turnId;
        }
        const started = await startStructuredProviderSession(next, { onTerminal: handleTerminal });
        session = started.session;
        sessionPayload = next;
        if (started.session.adapterId === "codex") {
          codexClientAttachedAt = Date.now();
          consecutiveCodexDisconnects = 0;
        }
        observeExit(started.session, next);
        if (started.recoveredTerminal !== undefined) {
          handleTerminal(started.recoveredTerminal);
        }
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
        activeTurnAttemptId = providerControl.initialTurn.attemptId;
        activeNativeTurnId = undefined;
        try {
          receipt = await session.submitTurn(providerControl.initialTurn);
          providerAcceptedAttemptId = receipt.attemptId;
          activeNativeTurnId = receipt.nativeTurnId;
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
      const ensuredOwnedTurn = providerControl.kind === "ensure"
        ? providerControl.ownedTurn
        : undefined;
      const providerState = receipt !== undefined || ensuredOwnedTurn !== undefined
        ? "ready"
        : session.activeTurnId === undefined ? "idle" : "busy";
      updateSnapshot(hostSnapshot(providerState, {
        launchId: next.launchId,
        adapterId: providerControl.adapterId,
        processInstanceId: session.processInstanceId,
        nativeSessionId: receipt?.nativeSessionId ?? session.nativeSessionId,
        conversationId: receipt?.conversationId ?? session.conversationId,
        ...(receipt !== undefined
          ? { attemptId: receipt.attemptId, nativeTurnId: receipt.nativeTurnId }
          : ensuredOwnedTurn === undefined
            ? {}
            : {
                attemptId: ensuredOwnedTurn.attemptId,
                nativeTurnId: ensuredOwnedTurn.turnId
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
        : error instanceof ProviderTurnBusyError
          ? "busy"
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
      if (state !== "delivery-unknown") {
        activeTurnPayload = undefined;
        activeTurnAttemptId = undefined;
        activeNativeTurnId = undefined;
      }
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
    activeTurnAttemptId = request.turn.attemptId;
    activeNativeTurnId = undefined;
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
      activeNativeTurnId = receipt.nativeTurnId;
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
        : error instanceof ProviderTurnBusyError
          ? "busy"
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
      if (state !== "delivery-unknown") {
        activeTurnPayload = undefined;
        activeTurnAttemptId = undefined;
        activeNativeTurnId = undefined;
      }
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
        if (snapshot.state === "delivery-unknown"
          || snapshot.state === "busy"
          || snapshot.state === "rejected") {
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
    || !["idle", "starting", "ready", "settling", "delivery-unknown", "busy", "rejected", "failed", "exited"]
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

function signalRoleMailbox(home: string, payload: AgentHostLaunchPayload): void {
  const taskId = payload.environment.YUI_TASK_ID;
  const roleName = payload.environment.YUI_ROLE;
  if (taskId === undefined || roleName === undefined) return;
  const key = `role:${encodeURIComponent(taskId)}/${encodeURIComponent(roleName)}`;
  void callController(home, "scheduler.signal", { key }).catch(() => {
    // This is a low-latency hint. Durable mailbox state and periodic
    // reconciliation remain the recovery path across a Controller handover.
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref();
  });
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
