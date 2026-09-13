import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { withSessionContextPointer } from "../context/sessionBootstrapManifest.js";


import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import {
  publishStructuredConversationRecoverability,
  publishStructuredProviderAccepted,
  publishStructuredProviderActivity,
  publishStructuredProviderAttachmentExit,
  publishStructuredProviderConnection,
  publishStructuredProviderGoal,
  publishStructuredProviderInputObserved,
  publishStructuredProviderInputSettlement,
  publishStructuredProviderOpened,
  publishStructuredProviderStarted,
  publishStructuredProviderTerminal,
  structuredProviderEventDelivery
} from "../controller/structuredProviderObservation.js";
import {
  callController,
  controllerCallMayHaveApplied,
  ControllerClientError
} from "../core/controllerClient.js";
import { readHomeFilesystemId } from "../core/homeFilesystemIdentity.js";
import { FILE_TASK_CONTROLLER_PROTOCOL_VERSION, type JsonValue } from "../core/protocol.js";
import type { ImplementationRef } from "../kernel/instanceHost.js";
import { isForeignHandoverLockHeld } from "../release/runtimeRelease.js";
import { yuiTmuxServerName, yuiTmuxSessionName } from "../tmux/tmuxManager.js";
import { tmuxSocketDirectory } from "../tmux/tmuxSocketEndpoint.js";
import {
  type AgentEndpoint,
  type AgentEndpointCancellation,
  type AgentEndpointSubmission
} from "./agentEndpoint.js";
import {
  createAgentEndpointOwner,
  type AgentEndpointLease
} from "./agentEndpointOwnership.js";
import {
  providerDeliveryFailure,
  providerDeliveryFailureFrom,
  redactAgentErrorText,
  serializeAgentErrorRaw,
  type AgentErrorPhase,
  type ProviderDeliveryFailure
} from "./agentError.js";
import type { AgentHostCompatibility, AgentHostEventDelivery } from "./agentHostProtocol.js";
import { AGENT_HOST_CONTROL_PROTOCOL, AGENT_HOST_EVENT_PROTOCOL } from "./agentHostProtocol.js";
import {
  readAgentRunConfigurationObservation,
  unknownAgentRunConfiguration,
  type AgentRunConfigurationObservation
} from "./agentRunConfiguration.js";
import { CodexPreSubmissionError } from "./codexAppServerRuntime.js";
import { runCodexInteractiveHost } from "./codexInteractiveHost.js";
import {
  validateAgentHostLaunchPayload,
  type AgentHostLaunchPayload
} from "./launchBroker.js";
import type { PromptPushOutcome } from "./ports.js";
import {
  validateRuntimeProcessExitObservation,
  type RuntimeProcessExitObservation
} from "./processExitObservation.js";
import {
  persistRuntimeProcessExitObservation,
  replayRuntimeProcessExitOutbox
} from "./processExitOutbox.js";
import {
  sameProviderAuthorityFence,
  validateProviderAuthorityFence,
  type ProviderAuthorityFence
} from "./providerAuthorityFence.js";
import {
  ProviderConversationMissingError,
  ProviderDeliveryUnknownError,
  ProviderTurnBusyError,
  ProviderTurnRejectedError
} from "./providerErrors.js";
import {
  AGENT_HOST_CLIENT_EXIT_GRACE_MS,
  AGENT_HOST_CONTROL_TIMEOUT_MS,
  AGENT_HOST_READY_TIMEOUT_MS,
  ENDPOINT_DRAIN_TIMEOUT_MS,
  PROVIDER_ACCEPT_TIMEOUT_MS
} from "./runtimeDeadlines.js";
import { createSessionOwnerIdentity, readLinuxProcessIdentity } from "./sessionOwnerIdentity.js";
import {
  type StructuredProviderActivity,
  type StructuredProviderGoal,
  type StructuredProviderTurnInput,
  type StructuredProviderTurnReceipt,
  type StructuredProviderTurnStarted,
  type StructuredProviderTurnTerminal
} from "./structuredProviderHost.js";
export { AGENT_HOST_CONTROL_PROTOCOL } from "./agentHostProtocol.js";

const HOST_CONTROL_MAX_BYTES = 32 * 1024;
const CODEX_CLIENT_STABLE_MS = 5_000;
const MAX_CONSECUTIVE_CODEX_DISCONNECTS = 3;

export type AgentHostLaunchControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "launch";
  ticket: string;
}>;

export type AgentHostStatusControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "status";
}>;

export type AgentHostSubmitRunControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "submit-turn";
  nativeSessionId: string;
  /** Current durable AgentRun; a reused Host must not inherit its launch-time AgentRun. */
  runId?: string;
  authority: ProviderAuthorityFence;
  run: StructuredProviderTurnInput;
}>;

export type AgentHostSteerRunControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "steer-turn";
  nativeSessionId: string;
  nativeTurnId: string;
  authority: ProviderAuthorityFence;
  run: StructuredProviderTurnInput;
}>;

export type AgentHostSetAuthorityControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "set-authority";
  nativeSessionId: string;
  authority: ProviderAuthorityFence;
}>;

export type AgentHostCancelControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "cancel";
  nativeSessionId: string;
  attemptId: string;
  authority: ProviderAuthorityFence;
  nativeOnly?: boolean;
}>;

export type AgentHostControl =
  | AgentHostLaunchControl
  | AgentHostStatusControl
  | AgentHostSubmitRunControl
  | AgentHostSteerRunControl
  | AgentHostCancelControl
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
  schemaVersion: 2;
  state: AgentHostProviderState;
  adapterId?: AgentAdapterId;
  processInstanceId?: string;
  nativeSessionId?: string;
  conversationId?: string;
  attemptId?: string;
  nativeTurnId?: string;
  inputAcceptance?: "provider" | "transport";
  authorityEpoch?: number;
  authorityOwner?: ProviderAuthorityFence["owner"];
  authorityHolderId?: string;
  endpointImplementation?: ImplementationRef;
  /** Live-only status reading, rebuilt on each query and never persisted. */
  runConfiguration?: AgentRunConfigurationObservation;
  /** Live capabilities describe this pinned process, not the installed CLI. */
  compatibility?: AgentHostCompatibility;
  hostProcess?: Readonly<{ pid: number; startIdentity: string }>;
  owner?: Readonly<{ scope: string; taskId?: string; roleName: string }>;
  eventDelivery?: AgentHostEventDelivery;
  detail?: string;
  updatedAt: string;
}>;

/**
 * What the control request itself did. This is deliberately independent of
 * `snapshot.state` (whether the Provider Conversation is usable) and of
 * whether the Provider accepted managed input: a request can be received and
 * answered while the Session is still starting and no input was ever written.
 */
export type AgentHostControlOutcome =
  | "status"
  | "accepted"
  | "pending"
  | "cancel-requested"
  | "rejected"
  | "busy";

export type AgentHostControlResult = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  outcome: AgentHostControlOutcome;
  snapshot: AgentHostSnapshot;
  /**
   * Structured cause when the Host could not complete the request. Additive
   * and optional: a Host from an older build omits it and every consumer
   * falls back to `snapshot.detail`, so an in-flight Host survives an upgrade
   * without a protocol break.
   */
  failure?: ProviderDeliveryFailure;
  cancellation?: AgentEndpointCancellation;
}>;

/**
 * decision-3 §7 live acceptance layer for a steer edge. The static resolver
 * (`resolveInputControl`) is the pre-flight gate proven from durable state; this
 * is the *actual* acceptance the live Endpoint reported, which is a distinct
 * fact and must not be assumed to be success. `accepted` is the only proven
 * delivery of the exact Turn. `pending` is delivery-unknown — the Host holds the
 * steer but has not yet proven the Provider took it; the durable settlement fold
 * resolves it later. `rejected`/`busy`/anything else did not deliver. This only
 * *reports*: there is no retarget, no queue, and no interrupt fallback.
 */
export type SteerLiveReceipt = Readonly<{
  state: "steered" | "steer-unknown" | "steer-rejected" | "steer-unavailable";
  outcome: AgentHostControlOutcome;
  detail?: string;
}>;

export function foldSteerLiveReceipt(control: AgentHostControlResult): SteerLiveReceipt {
  const detail = control.failure?.detail ?? control.snapshot.detail;
  const withDetail = detail === undefined ? {} : { detail };
  switch (control.outcome) {
    case "accepted":
      // The only ok state. A live-accepted steer keeps `not-steered` (static,
      // pre-flight) and this live disposition strictly separate phases.
      return { state: "steered", outcome: "accepted" };
    case "pending":
      return { state: "steer-unknown", outcome: "pending", ...withDetail };
    case "rejected":
      return { state: "steer-rejected", outcome: "rejected", ...withDetail };
    default:
      // A steer edge only ever answers accepted/pending/rejected; `busy`,
      // `status`, or `cancel-requested` here means the Host could not run the
      // steer. Report it faithfully rather than flattening to success.
      return { state: "steer-unavailable", outcome: control.outcome, ...withDetail };
  }
}

/**
 * decision-3 §7 live acceptance layer for an interrupt (native cancel) edge. The
 * Host answers `cancel-requested`, but the *proof* is `cancellation.status`: only
 * `requested` (a stop was actually asked of an active Turn) is the ok state.
 * `not-active` means there was no active Turn to stop; `unknown` means the stop
 * could not be proven. The stop-proof (`control.cancellation`) is preserved on
 * the receipt rather than discarded. A then-handoff, if any, was already claimed
 * durably by Core independent of this outcome and is delivered once by the
 * ordinary continuation path after a proven terminal — never re-driven here.
 */
export type InterruptLiveReceipt = Readonly<{
  state: "interrupt-requested" | "interrupt-not-active" | "interrupt-unknown" | "interrupt-unavailable";
  outcome: AgentHostControlOutcome;
  cancellation?: AgentEndpointCancellation;
  detail?: string;
}>;

export function foldInterruptLiveReceipt(control: AgentHostControlResult): InterruptLiveReceipt {
  const cancellation = control.cancellation;
  const withCancellation = cancellation === undefined ? {} : { cancellation };
  if (control.outcome !== "cancel-requested") {
    const detail = control.failure?.detail ?? control.snapshot.detail;
    return { state: "interrupt-unavailable", outcome: control.outcome,
      ...withCancellation, ...(detail === undefined ? {} : { detail }) };
  }
  // A transport outcome without native cancellation evidence proves no stop.
  const state = cancellation?.status === "not-active" ? "interrupt-not-active"
    : cancellation?.status === "requested" ? "interrupt-requested"
    : "interrupt-unknown";
  return { state, outcome: "cancel-requested", ...withCancellation };
}

export function serializeAgentHostLaunchControl(control: AgentHostLaunchControl): string {
  return JSON.stringify(validateControl(control));
}

export async function runAgentHost(input: Readonly<{
  home: string;
  ticket: string;
}>): Promise<number> {
  const hostInstanceId = randomUUID();
  let hostSequence = 0;
  let payload = await redeem(input.home, input.ticket);
  if (payload.environment.YUI_SESSION_SCOPE === "global" && payload.providerControl !== undefined) {
    process.stdout.write("Yui controlled Global Session: this is the Host console, not the native Agent TUI. "
      + "Type a line to submit to this Session; model, permissions and workspace remain as configured. "
      + "Queued inputs and live controls use the same Endpoint.\n");
  }
  if (payload.environment.YUI_SESSION_SCOPE === "global"
    && payload.environment.YUI_ADAPTER_ID === "codex"
    && payload.providerControl === undefined) {
    return runCodexInteractiveHost(input.home, payload, openAgentHostControl);
  }
  let session: AgentEndpoint | undefined;
  // This process really holds the Endpoint code its Session runs on. The lease
  // spans the Session's Turns, so installing a newer generation does not change
  // the implementation under a Session that is still using this one.
  const endpointOwner = createAgentEndpointOwner();
  let endpointLease: AgentEndpointLease | undefined;
  /** The adapter this process actually pinned, so the drain below reports the
   * implementation genuinely held rather than whichever one a later payload names. */
  let endpointAdapterId: AgentHostSnapshot["adapterId"];
  let sessionPayload: AgentHostLaunchPayload | undefined;
  let activeRunPayload: AgentHostLaunchPayload | undefined;
  let lastTerminalPayload: AgentHostLaunchPayload | undefined;
  let lastTerminal: StructuredProviderTurnTerminal | undefined;
  let activeRunAttemptId: string | undefined;
  let activeNativeTurnId: string | undefined;
  let codexClientAttachedAt: number | undefined;
  let consecutiveCodexDisconnects = 0;
  let conversationRecoverability: "unknown" | "recoverable" = "unknown";
  let authority: ProviderAuthorityFence | undefined;
  let hostStopRequested = false;
  let snapshot = hostSnapshot("idle");
  let dispatchTail = Promise.resolve();
  let promptHuman = (): void => {};
  const recentSteerAttempts = new Map<string, {
    request: AgentHostSteerRunControl;
    outcome: PromptPushOutcome;
  }>();
  await replayExitOutbox(input.home);

  const updateSnapshot = (next: AgentHostSnapshot): void => {
    snapshot = validateSnapshot(next);
  };

  const authorityFields = (): Pick<
    AgentHostSnapshot,
    "authorityEpoch" | "authorityOwner" | "authorityHolderId" | "endpointImplementation"
  > => ({
    ...(session === undefined ? {} : { endpointImplementation: session.configuration.implementation }),
    ...(authority === undefined ? {} : {
      authorityEpoch: authority.epoch,
      authorityOwner: authority.owner,
      authorityHolderId: authority.holderId
    })
  });

  const handleAccepted = (receipt: StructuredProviderTurnReceipt): void => {
    const observedPayload = activeRunPayload;
    if (observedPayload === undefined || receipt.acceptance !== "provider"
      || receipt.attemptId !== activeRunAttemptId
      || receipt.nativeSessionId !== session?.nativeSessionId) return;
    void enqueueSerialized(async () => {
      if (activeRunPayload !== observedPayload || activeRunAttemptId !== receipt.attemptId
        || snapshot.attemptId === receipt.attemptId && snapshot.inputAcceptance === "provider") return;
      await publishStructuredProviderAccepted({
        home: input.home, environment: observedPayload.environment, receipt
      });
      updateSnapshot(hostSnapshot("ready", {
        adapterId: session!.adapterId,
        processInstanceId: session!.processInstanceId,
        nativeSessionId: receipt.nativeSessionId,
        conversationId: receipt.conversationId,
        attemptId: receipt.attemptId,
        nativeTurnId: receipt.nativeTurnId,
        inputAcceptance: "provider",
        ...authorityFields()
      }));
      signalRoleMailbox(input.home, observedPayload);
    }).catch(() => {});
  };

  const handleActivity = (activity: StructuredProviderActivity): void => {
    const observedPayload = activeRunPayload;
    if (observedPayload === undefined || activity.attemptId !== activeRunAttemptId
      || activity.nativeSessionId !== session?.nativeSessionId) return;
    void enqueueSerialized(async () => {
      if (activeRunPayload !== observedPayload || activity.attemptId !== activeRunAttemptId) return;
      await publishStructuredProviderActivity({ home: input.home, environment: observedPayload.environment, activity });
    }).catch(() => {});
  };

  const handleStarted = (
    started: StructuredProviderTurnStarted,
    observedPayload: AgentHostLaunchPayload | undefined = sessionPayload
  ): void => {
    if (started.clientOwned || observedPayload === undefined) return;
    updateSnapshot(hostSnapshot("busy", {
      adapterId: observedPayload.providerControl?.adapterId,
      processInstanceId: session?.processInstanceId,
      nativeSessionId: started.nativeSessionId,
      conversationId: started.conversationId,
      nativeTurnId: started.nativeTurnId,
      ...authorityFields()
    }));
    void enqueueSerialized(async () => {
      await publishStructuredProviderStarted({
        home: input.home,
        environment: observedPayload.environment,
        started
      });
      signalRoleMailbox(input.home, observedPayload);
    }).catch(() => {});
  };

  const handleTerminal = (terminal: StructuredProviderTurnTerminal): void => {
    if (!terminal.clientOwned) {
      const busyPayload = sessionPayload;
      if (
        busyPayload === undefined
        || session === undefined
        || terminal.conversationId !== session.conversationId
      ) return;
      // A direct Provider client shares the Session but still produces a Yui
      // AgentRun audit record. It has no WorkItem ownership and no managed input
      // fence; the runtime observer records only visible input/output.
      void enqueueSerialized(async () => {
        await publishStructuredProviderTerminal({
          home: input.home,
          environment: busyPayload.environment,
          terminal
        });
        if (session !== undefined && terminal.conversationId === session.conversationId) {
          updateSnapshot(hostSnapshot(session.inspect().activeNativeTurnId === undefined ? "idle" : "busy", {
            adapterId: session.adapterId,
            processInstanceId: session.processInstanceId,
            nativeSessionId: session.nativeSessionId,
            conversationId: session.conversationId,
            ...authorityFields()
          }));
        }
        signalRoleMailbox(input.home, busyPayload);
      }).catch(() => {});
      return;
    }
    const terminalPayload = activeRunPayload;
    if (terminal.attemptId !== undefined && terminal.attemptId !== activeRunAttemptId
      && sessionPayload !== undefined && terminal.nativeSessionId === session?.nativeSessionId) {
      // A duplicate/late terminal retains the Driver's exact old attempt.
      // The durable observer validates that binding; it must not alter the
      // current Host occupancy or inherit the successor's managed AgentRun.
      const observedPayload = sessionPayload;
      void enqueueSerialized(async () => {
        await publishStructuredProviderTerminal({
          home: input.home,
          environment: observedPayload.environment,
          terminal
        });
        signalRoleMailbox(input.home, observedPayload);
      }).catch(() => {});
      return;
    }
    if (terminalPayload === undefined
      || terminal.attemptId !== activeRunAttemptId
      || terminal.nativeSessionId !== session?.nativeSessionId
      || (terminal.nativeTurnId !== undefined && activeNativeTurnId !== undefined
        && terminal.nativeTurnId !== activeNativeTurnId)) return;
    const terminalAttemptId = terminal.attemptId;
    lastTerminalPayload = terminalPayload;
    lastTerminal = terminal;
    void enqueueSerialized(async () => {
      if (activeRunPayload !== terminalPayload
        || activeRunAttemptId !== terminalAttemptId) return;
      if (session !== undefined) {
        updateSnapshot(hostSnapshot("settling", {
          adapterId: terminalPayload.providerControl!.adapterId,
          processInstanceId: session.processInstanceId,
          nativeSessionId: terminal.nativeSessionId,
          conversationId: terminal.conversationId,
          attemptId: terminalAttemptId,
          nativeTurnId: terminal.nativeTurnId,
          ...authorityFields()
        }));
      }
      try {
        await publishStructuredProviderTerminal({
          home: input.home,
          environment: terminalPayload.environment,
          terminal
        });
        if (activeRunPayload !== terminalPayload) return;
        activeRunPayload = undefined;
        activeRunAttemptId = undefined;
        activeNativeTurnId = undefined;
        if (session === undefined) return;
        const currentPayload = sessionPayload ?? terminalPayload;
        updateSnapshot(hostSnapshot(session.inspect().activeNativeTurnId === undefined ? "idle" : "busy", {
          adapterId: currentPayload.providerControl!.adapterId,
          processInstanceId: session.processInstanceId,
          nativeSessionId: terminal.nativeSessionId,
          conversationId: terminal.conversationId,
          ...authorityFields()
        }));
        promptHuman();
      } catch (error) {
        updateSnapshot(hostSnapshot("failed", {
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

  const handleGoal = (goal: StructuredProviderGoal | null): void => {
    const currentPayload = activeRunPayload ?? sessionPayload;
    const currentSession = session;
    if (currentPayload === undefined || currentSession === undefined) return;
    void enqueueSerialized(async () => {
      await publishStructuredProviderGoal({
        home: input.home,
        environment: currentPayload.environment,
        conversationId: currentSession.conversationId,
        goal
      });
      signalRoleMailbox(input.home, currentPayload);
    }).catch(() => {});
  };

  const reconnectCodexClient = async (
    disconnectedSession: AgentEndpoint,
    currentPayload: AgentHostLaunchPayload
  ): Promise<void> => {
    const previousControl = currentPayload.providerControl;
    if (previousControl?.adapterId !== "codex" || authority === undefined) {
      throw new Error("Codex client reconnect lost its Provider control identity.");
    }
    const ownedTurn = activeRunPayload === undefined
      || activeRunAttemptId === undefined
      || activeNativeTurnId === undefined
      ? undefined
      : { attemptId: activeRunAttemptId, turnId: activeNativeTurnId };
    const reconnectPayload: AgentHostLaunchPayload = {
      ...currentPayload,
      command: disconnectedSession.configuration.command,
      args: disconnectedSession.configuration.args,
      cwd: disconnectedSession.configuration.cwd,
      environment: activeRunPayload?.environment ?? currentPayload.environment,
      providerControl: {
        schemaVersion: 1,
        adapterId: "codex",
        // Reconnecting reaches the same product the disconnected Session was
        // pinned to. Rebuilding the control without the component would quietly
        // drop that identity halfway through a Session's life.
        ...(previousControl.component === undefined
          ? {}
          : { component: previousControl.component }),
        transport: "codex-app-server-proxy",
        kind: "restore",
        mode: "resume",
        nativeSessionId: disconnectedSession.nativeSessionId,
        ...(previousControl.sessionTitle === undefined
          ? {}
          : { sessionTitle: previousControl.sessionTitle }),
        codexThread: disconnectedSession.configuration.threadOptions!,
        endpointImplementation: disconnectedSession.configuration.implementation,
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
        await assertHostExecutionEnvironment(input.home, reconnectPayload, disconnectedSession.nativeSessionId);
        // Reattaching a dropped client continues the same Session on the same
        // pinned generation; it never re-selects an implementation.
        if (endpointLease === undefined) {
          throw new Error("Codex client reconnect lost its Endpoint implementation lease.");
        }
        const started = await endpointLease.resume(reconnectPayload);
        session = started.session;
        sessionPayload = currentPayload;
        started.session.events((event) => {
          if (session !== started.session && event.type !== "terminal") return;
          if (event.type === "accepted") handleAccepted(event.value);
          else if (event.type === "activity") handleActivity(event.value);
          else if (event.type === "started") handleStarted(event.value, currentPayload);
          else if (event.type === "terminal") handleTerminal(event.value);
          else if (event.type === "goal") handleGoal(event.value);
          else void enqueueSerialized(() => publishStructuredProviderInputObserved({
            home: input.home, environment: currentPayload.environment, observed: event.value
          })).catch(() => {});
        });
        conversationRecoverability = "recoverable";
        codexClientAttachedAt = Date.now();
        observeExit(started.session, currentPayload);
        const reconnectState = activeRunPayload !== undefined
          ? ownedTurn === undefined ? "delivery-unknown" : "ready"
          : started.session.inspect().activeNativeTurnId === undefined ? "idle" : "busy";
        updateSnapshot(hostSnapshot(reconnectState, {
          adapterId: "codex",
          processInstanceId: started.session.processInstanceId,
          nativeSessionId: started.session.nativeSessionId,
          conversationId: started.session.conversationId,
          ...(activeRunAttemptId === undefined ? {} : { attemptId: activeRunAttemptId }),
          ...(activeNativeTurnId === undefined ? {} : { nativeTurnId: activeNativeTurnId }),
          ...authorityFields(),
          ...(ownedTurn !== undefined || activeRunPayload === undefined
            ? {}
            : {
                detail: "Codex client reattached, but the in-flight AgentRun has no exact native identity."
              })
        }));
        if (started.recoveredTerminal !== undefined) {
          handleTerminal(started.recoveredTerminal);
        }
        if (ownedTurn === undefined && started.session.inspect().activeNativeTurnId !== undefined) {
          handleStarted({
            conversationId: started.session.conversationId,
            nativeSessionId: started.session.nativeSessionId,
            nativeTurnId: started.session.inspect().activeNativeTurnId!,
            clientOwned: false,
            observedAt: new Date().toISOString()
          }, currentPayload);
        }
        if (started.goal !== undefined) handleGoal(started.goal);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    updateSnapshot(hostSnapshot("failed", {
      adapterId: "codex",
      processInstanceId: disconnectedSession.processInstanceId,
      nativeSessionId: disconnectedSession.nativeSessionId,
      conversationId: disconnectedSession.conversationId,
      ...(activeRunAttemptId === undefined ? {} : { attemptId: activeRunAttemptId }),
      ...(activeNativeTurnId === undefined ? {} : { nativeTurnId: activeNativeTurnId }),
      ...authorityFields(),
      detail: `Codex client could not reattach after bounded retries: ${errorText(lastError)}`
    }));
  };

  const observeExit = (
    providerSession: AgentEndpoint,
    launched: AgentHostLaunchPayload
  ): void => {
    void providerSession.waitForExit().then((result) => enqueueSerialized(async () => {
      const ownsCurrentSession = session === providerSession;
      const currentPayload = ownsCurrentSession
        ? activeRunPayload ?? lastTerminalPayload ?? sessionPayload ?? launched : launched;
      const exitAuthority = authorityFields();
      const stopRequested = hostStopRequested || providerSession.inspect().cancellation === "requested";
      const reconnectableCodexClient = ownsCurrentSession
        && providerSession.adapterId === "codex"
        && !hostStopRequested;
      if (reconnectableCodexClient) {
        session = undefined;
        if (codexClientAttachedAt !== undefined
          && Date.now() - codexClientAttachedAt >= CODEX_CLIENT_STABLE_MS) {
          consecutiveCodexDisconnects = 0;
        }
        consecutiveCodexDisconnects += 1;
        if (consecutiveCodexDisconnects > MAX_CONSECUTIVE_CODEX_DISCONNECTS) {
          updateSnapshot(hostSnapshot("failed", {
            adapterId: "codex",
            processInstanceId: result.processInstanceId,
            nativeSessionId: providerSession.nativeSessionId,
            conversationId: providerSession.conversationId,
            ...(activeRunAttemptId === undefined ? {} : { attemptId: activeRunAttemptId }),
            ...(activeNativeTurnId === undefined ? {} : { nativeTurnId: activeNativeTurnId }),
            ...exitAuthority,
            detail: "Codex client repeatedly disconnected before reaching a stable attachment."
          }));
          return;
        }
        updateSnapshot(hostSnapshot("starting", {
          adapterId: "codex",
          processInstanceId: result.processInstanceId,
          nativeSessionId: providerSession.nativeSessionId,
          conversationId: providerSession.conversationId,
          ...(activeRunAttemptId === undefined ? {} : { attemptId: activeRunAttemptId }),
          ...(activeNativeTurnId === undefined ? {} : { nativeTurnId: activeNativeTurnId }),
          ...exitAuthority,
          detail: "Codex App Server proxy disconnected; attaching a replacement client."
        }));
        await reconnectCodexClient(providerSession, currentPayload);
        return;
      }
      if (ownsCurrentSession) {
        session = undefined;
        conversationRecoverability = "unknown";
        authority = undefined;
        // The client is gone for good, so this Session stops holding the
        // implementation. Keeping the reference would report work in progress
        // that no longer exists; a later launch pins again explicitly.
        const ending = endpointLease;
        endpointLease = undefined;
        await ending?.release().catch(() => undefined);
      }
      hostSequence += 1;
      const observedAt = new Date().toISOString();
      const failures: string[] = [];
      try {
        await persistAndSubmitExit(input.home, validateRuntimeProcessExitObservation({
          schemaVersion: 2,
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
          ...(providerSession.nativeSessionId.length === 0
            ? {}
            : { nativeSessionId: providerSession.nativeSessionId }),
          processKind: "provider-child",
          ...(result.code === null ? {} : { exitCode: result.code }),
          ...(result.signal === null ? {} : { signal: result.signal }),
          ...(stopRequested ? { stopRequested: true } : {}),
          observedAt
        }));
      } catch (error) {
        failures.push(`process exit: ${errorText(error)}`);
      }
      if (ownsCurrentSession && currentPayload.environment.YUI_SESSION_SCOPE === "task") {
        try {
          await publishStructuredProviderAttachmentExit({
            home: input.home, environment: currentPayload.environment,
            nativeSessionId: providerSession.nativeSessionId,
            attemptId: activeRunAttemptId ?? lastTerminal?.attemptId,
            nativeTurnId: activeNativeTurnId ?? lastTerminal?.nativeTurnId,
            failed: !stopRequested, observedAt
          });
        } catch (error) { failures.push(`attachment exit: ${errorText(error)}`); }
      }
      if (hostStopRequested || !ownsCurrentSession) return;
      updateSnapshot(hostSnapshot(failures.length === 0 ? "exited" : "failed", {
        adapterId: currentPayload.providerControl?.adapterId,
        processInstanceId: result.processInstanceId,
        nativeSessionId: providerSession.nativeSessionId,
        conversationId: providerSession.conversationId,
        ...exitAuthority,
        ...(failures.length !== 0
          ? { detail: failures.join("; ") }
          : activeRunPayload === undefined
            ? {}
            : { detail: "Provider process exited before the active AgentRun reached a terminal boundary." })
      }));
    })).catch((error) => updateSnapshot(hostSnapshot("failed", {
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
    if (activeRunPayload !== undefined
      || ["starting", "ready", "settling", "delivery-unknown"].includes(snapshot.state)) {
      throw new Error("Agent Host still owns an unsettled Provider Turn.");
    }
    const requestedAuthority = validateProviderAuthorityFence(providerControl.authority);
    const replacesCurrentConversation = session !== undefined && providerControl.kind === "start";
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
      adapterId: providerControl.adapterId,
      ...(session === undefined ? {} : {
        processInstanceId: session.processInstanceId,
        nativeSessionId: session.nativeSessionId,
        conversationId: session.conversationId
      }),
      ...authorityFields()
    }));
    let recoveredGoal: StructuredProviderGoal | null | undefined;
    try {
      if (session !== undefined) {
        if (session.adapterId !== providerControl.adapterId
          || providerControl.mode !== "resume"
          || providerControl.nativeSessionId !== session.nativeSessionId
          || (providerControl.endpointImplementation !== undefined
            && (providerControl.endpointImplementation.id !== session.configuration.implementation.id
              || providerControl.endpointImplementation.generation !== session.configuration.implementation.generation))) {
          throw new Error("Agent Host launch does not match its live Provider Conversation.");
        }
        sessionPayload = next;
      } else {
        if (providerControl.kind === "restore" && providerControl.ownedTurn !== undefined) {
          activeRunPayload = next;
          activeRunAttemptId = providerControl.ownedTurn.attemptId;
          activeNativeTurnId = providerControl.ownedTurn.turnId;
        }
        // The Controller revalidates the adopted execution environment while
        // redeeming this launch; a persistent Host must not reopen its schema.
        // Pin before opening: the Session holds this exact generation for every
        // later Turn. A pinned reference naming code this process is not running
        // fails here, rather than silently starting on a different generation.
        endpointLease ??= endpointOwner.pin(providerControl.adapterId, providerControl.endpointImplementation);
        endpointAdapterId = providerControl.adapterId;
        const started = await (providerControl.mode === "new"
          ? endpointLease.open(next) : endpointLease.resume(next));
        session = started.session;
        sessionPayload = next;
        await recordProviderConnection(input.home, next, started.session);
        lastTerminalPayload = undefined;
        lastTerminal = undefined;
        // Recoverable means a later process can rebind this Conversation by
        // its native id. The Endpoint answers that from the Driver capability
        // or, where the protocol settles it per connection, from what this
        // Agent actually negotiated — so it is read after the handshake, never
        // predicted before it.
        conversationRecoverability = started.session.conversationRecoverability;
        started.session.events((event) => {
          if (session !== started.session && event.type !== "terminal") return;
          if (event.type === "accepted") handleAccepted(event.value);
          else if (event.type === "activity") handleActivity(event.value);
          else if (event.type === "started") handleStarted(event.value, next);
          else if (event.type === "terminal") handleTerminal(event.value);
          else if (event.type === "goal") handleGoal(event.value);
          else void enqueueSerialized(() => publishStructuredProviderInputObserved({
            home: input.home, environment: next.environment, observed: event.value
          })).catch(() => {});
        });
        recoveredGoal = started.goal;
        if (started.session.adapterId === "codex") {
          codexClientAttachedAt = Date.now();
          consecutiveCodexDisconnects = 0;
        }
        observeExit(started.session, next);
        if (started.recoveredTerminal !== undefined) {
          handleTerminal(started.recoveredTerminal);
        }
        if ((providerControl.kind !== "restore" || providerControl.ownedTurn === undefined)
          && started.session.inspect().activeNativeTurnId !== undefined) {
          handleStarted({
            conversationId: started.session.conversationId,
            nativeSessionId: started.session.nativeSessionId,
            nativeTurnId: started.session.inspect().activeNativeTurnId!,
            clientOwned: false,
            observedAt: new Date().toISOString()
          }, next);
        }
      }
      if (!providerControl.sessionOnly) await publishStructuredProviderOpened({
        home: input.home,
        environment: next.environment,
        startupRunId: next.startupRunId,
        conversationId: session.conversationId,
        nativeSessionId: session.nativeSessionId,
        recoverability: conversationRecoverability,
        observedAt: new Date().toISOString()
      });
      if (recoveredGoal !== undefined && !providerControl.sessionOnly) {
        await publishStructuredProviderGoal({
          home: input.home,
          environment: next.environment,
          conversationId: session.conversationId,
          goal: recoveredGoal
        });
      }
      const restoredOwnedRun = providerControl.kind === "restore"
        ? providerControl.ownedTurn
        : undefined;
      const providerState = restoredOwnedRun !== undefined
        ? "ready"
        : session.inspect().activeNativeTurnId === undefined ? "idle" : "busy";
      updateSnapshot(hostSnapshot(providerState, {
        adapterId: providerControl.adapterId,
        processInstanceId: session.processInstanceId,
        nativeSessionId: session.nativeSessionId,
        conversationId: session.conversationId,
        ...(restoredOwnedRun === undefined
          ? {}
          : {
              attemptId: restoredOwnedRun.attemptId,
              nativeTurnId: restoredOwnedRun.turnId
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
          recoverability: "unrecoverable",
          observedAt: new Date().toISOString()
        }).catch(() => {});
      }
      if (session === undefined) {
        conversationRecoverability = "unknown";
        authority = undefined;
      }
      const state = error instanceof ProviderTurnBusyError
          ? "busy"
          : error instanceof ProviderTurnRejectedError ? "rejected" : "failed";
      updateSnapshot(hostSnapshot(state, {
        adapterId: providerControl.adapterId,
        processInstanceId: session?.processInstanceId,
        nativeSessionId: session?.nativeSessionId ?? providerControl.nativeSessionId,
        conversationId: session?.conversationId ?? providerControl.nativeSessionId,
        ...authorityFields(),
        detail: errorText(error)
      }));
      activeRunPayload = undefined;
      activeRunAttemptId = undefined;
      activeNativeTurnId = undefined;
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

  const submitRun = async (
    request: AgentHostSubmitRunControl,
    operation: { failure?: ProviderDeliveryFailure }
  ): Promise<AgentHostSnapshot> => {
    if (session === undefined || sessionPayload === undefined) {
      throw new Error("Agent Host has no live Provider Conversation.");
    }
    if (request.nativeSessionId !== session.nativeSessionId) {
      throw new Error("Agent Host AgentRun targets a different Provider Conversation.");
    }
    if (authority === undefined
      || !sameProviderAuthorityFence(authority, request.authority)) {
      throw new Error("Agent Host rejected a stale Provider writer fence.");
    }
    if (activeRunPayload !== undefined || snapshot.state === "settling"
      || session.inspect().activeNativeTurnId !== undefined) {
      operation.failure = providerDeliveryFailure({
        detail: "Agent Host still owns an unsettled Provider Turn.",
        errorName: "ProviderTurnBusyError",
        phase: "turn-submit",
        hostState: snapshot.state === "settling" ? "settling" : snapshot.state,
        attemptId: request.run.attemptId,
        inputDisposition: "not-accepted",
        registrationDisposition: "not-committed",
        // Busy is a healthy Session doing work, never a reason to stop it.
        sessionDisposition: "recoverable"
      });
      throw new ProviderTurnBusyError(
        "Agent Host still owns an unsettled Provider Turn.",
        request.run.attemptId,
        activeNativeTurnId
      );
    }
    const { YUI_RUN_ID: _launchRunId, ...baseEnvironment } = sessionPayload.environment;
    // Steer attempts belong to the active native Turn. Never evict an unknown
    // attempt while that AgentRun remains active, but don't retain another AgentRun's
    // completed steering history after a new exact submission begins.
    recentSteerAttempts.clear();
    activeRunPayload = {
      ...sessionPayload,
      environment: {
        ...baseEnvironment,
        ...(request.runId === undefined ? {} : { YUI_RUN_ID: request.runId })
      }
    };
    activeRunAttemptId = request.run.attemptId;
    activeNativeTurnId = undefined;
    updateSnapshot(hostSnapshot("starting", {
      adapterId: session.adapterId,
      processInstanceId: session.processInstanceId,
      nativeSessionId: session.nativeSessionId,
      conversationId: session.conversationId,
      attemptId: request.run.attemptId,
      ...authorityFields()
    }));
    const durableRun = { ...hostRunControlParams(
      sessionPayload,
      session.nativeSessionId,
      request.authority,
      request.run.attemptId,
      request.runId
    ), boundedText: request.run.boundedText,
      retrySupport: session.adapterId === "codex" ? "codex-failed-turn-v1" : "unsupported" };
    let recoveryInput: { text: string; expectedFailedNativeTurnId?: string } | undefined;
    // Registration precedes the Provider write, so its failure modes are not
    // the Provider's. A definite failure means the Provider never saw this
    // input and the occupancy must be released; anything unconfirmed leaves
    // durable state ambiguous and keeps it held.
    try {
      const admitted = await beginDurableProviderTurn(input.home, durableRun);
      if (admitted !== null && typeof admitted === "object" && !Array.isArray(admitted)) {
        const retry = (admitted as Readonly<Record<string, JsonValue>>).retryInput as
          Readonly<{ text?: JsonValue; expectedFailedNativeTurnId?: JsonValue }> | undefined;
        if (retry !== null && typeof retry === "object" && !Array.isArray(retry)
          && typeof retry.text === "string") recoveryInput = {
          text: retry.text,
          ...(typeof retry.expectedFailedNativeTurnId === "string"
            ? { expectedFailedNativeTurnId: retry.expectedFailedNativeTurnId } : {})
        };
      }
    } catch (error) {
      // Registration ends in one of three states and they are not
      // interchangeable. A definite refusal committed nothing. A lost
      // acknowledgement whose compensating resolve also failed is genuinely
      // unknown, and releasing that occupancy would discard a durable record
      // that may exist. A lost acknowledgement whose resolve succeeded is
      // neither: the resolve is fenced on this exact attempt id and could not
      // have succeeded unless the registration committed, so that attempt is
      // known committed and already settled.
      const registrationSettled = error instanceof ProviderTurnRegistrationSettledError;
      const registrationUnknown = !registrationSettled
        && (error instanceof ControllerAcknowledgementUnknownError
          || error instanceof ProviderDeliveryUnknownError);
      updateSnapshot(hostSnapshot(registrationUnknown ? "delivery-unknown"
        : error instanceof ProviderTurnBusyError ? "busy" : "failed", {
        adapterId: session.adapterId,
        processInstanceId: session.processInstanceId,
        nativeSessionId: session.nativeSessionId,
        conversationId: session.conversationId,
        attemptId: request.run.attemptId,
        ...authorityFields(),
        detail: registrationUnknown
          ? `Provider Turn registration acknowledgement is unconfirmed; the Provider was not sent this input: ${
            errorText(error)
          }`
          : registrationSettled
            ? `Provider Turn registration was settled before any Provider write: ${errorText(error)}`
            : `Provider Turn registration failed before any Provider write: ${errorText(error)}`
      }));
      // The Provider never saw the input in any branch. Only the durable
      // registration is in question, so that is the fact that differs.
      operation.failure = providerDeliveryFailureFrom(error, {
        phase: "turn-submit",
        hostState: snapshot.state,
        attemptId: request.run.attemptId,
        inputDisposition: "not-accepted",
        registrationDisposition: registrationUnknown
          ? "unknown"
          : registrationSettled ? "committed" : "not-committed",
        sessionDisposition: "recoverable"
      });
      if (!registrationUnknown) {
        // The Provider provably holds nothing, and the durable record either
        // never existed or is settled. Release the Session for the next
        // attempt instead of stranding it in a false `starting`.
        activeRunPayload = undefined;
        activeRunAttemptId = undefined;
        activeNativeTurnId = undefined;
      }
      throw error;
    }
    let providerAccepted = false;
    let transportAccepted = false;
    try {
      // beginDurableProviderTurn validated current execution-environment,
      // authority and Session identity before this native write.
      const receipt = endpointReceipt(await session.submit({
        ...request.run,
        boundedText: withSessionContextPointer(recoveryInput?.text ?? request.run.boundedText, activeRunPayload.environment),
        ...(recoveryInput === undefined ? {} : { requireQuiescent: true }),
        ...(recoveryInput?.expectedFailedNativeTurnId === undefined ? {} : {
          expectedFailedNativeTurnId: recoveryInput.expectedFailedNativeTurnId
        }),
        inputRef: request.runId ?? request.run.attemptId
      }), request.run.attemptId);
      transportAccepted = true;
      providerAccepted = receipt.acceptance === "provider";
      activeNativeTurnId = receipt.nativeTurnId;
      try {
        await publishStructuredProviderAccepted({
          home: input.home,
          environment: activeRunPayload.environment,
          receipt
        });
      } catch (error) {
        const unknown = new ProviderDeliveryUnknownError(
          "Input submission returned a receipt but its durable acknowledgement could not be confirmed.",
          request.run.attemptId,
          { cause: error }
        );
        // A resolve failure here must not escape before the snapshot is
        // written: the Provider has already accepted, and losing that fact
        // would report a definite non-acceptance for a live AgentRun.
        await resolveProviderTurnSubmission(input.home, durableRun, unknown);
        throw unknown;
      }
      updateSnapshot(hostSnapshot("ready", {
        adapterId: session.adapterId,
        processInstanceId: session.processInstanceId,
        nativeSessionId: receipt.nativeSessionId,
        conversationId: receipt.conversationId,
        attemptId: receipt.attemptId,
        nativeTurnId: receipt.nativeTurnId,
        inputAcceptance: receipt.acceptance,
        ...authorityFields()
      }));
      return snapshot;
    } catch (error) {
      let failureError = error;
      let settlementUnknown = false;
      if (!transportAccepted) {
        try {
          await resolveProviderTurnSubmission(input.home, durableRun, error);
        } catch (resolutionError) {
          settlementUnknown = true;
          failureError = resolutionError;
        }
      }
      const inputUnknown = error instanceof ProviderDeliveryUnknownError;
      const deliveryUnknown = inputUnknown || transportAccepted || settlementUnknown;
      const state = deliveryUnknown
        ? "delivery-unknown"
        : error instanceof ProviderTurnBusyError
          ? "busy"
          : error instanceof ProviderTurnRejectedError ? "rejected" : "failed";
      updateSnapshot(hostSnapshot(state, {
        adapterId: session.adapterId,
        processInstanceId: session.processInstanceId,
        nativeSessionId: session.nativeSessionId,
        conversationId: session.conversationId,
        attemptId: request.run.attemptId,
        ...authorityFields(),
        detail: errorText(failureError)
      }));
      operation.failure = providerDeliveryFailureFrom(failureError, {
        phase: "turn-submit",
        hostState: state,
        attemptId: request.run.attemptId,
        // Acceptance is observed, never inferred from the error class.
        inputDisposition: providerAccepted
          ? "accepted"
          : inputUnknown || transportAccepted ? "unknown" : "not-accepted",
        registrationDisposition: "committed",
        sessionDisposition: state === "failed" ? "unknown" : "recoverable"
      });
      if (state !== "delivery-unknown") {
        activeRunPayload = undefined;
        activeRunAttemptId = undefined;
        activeNativeTurnId = undefined;
      }
      if (deliveryUnknown && !(failureError instanceof ProviderDeliveryUnknownError)) {
        throw new ProviderDeliveryUnknownError(
          "Provider accepted input but its durable acknowledgement could not be confirmed.",
          request.run.attemptId,
          { cause: failureError }
        );
      }
      throw failureError;
    }
  };

  const steerRun = async (
    request: AgentHostSteerRunControl,
    operation: { failure?: ProviderDeliveryFailure }
  ): Promise<AgentHostSnapshot> => {
    if (session === undefined || sessionPayload === undefined || activeRunPayload === undefined) {
      operation.failure = providerDeliveryFailure({
        detail: "Agent Host has no active Provider Turn to steer.",
        errorName: "ProviderTurnRejectedError",
        phase: "turn-submit",
        hostState: snapshot.state,
        attemptId: request.run.attemptId,
        inputDisposition: "not-accepted",
        sessionDisposition: "recoverable"
      });
      throw new ProviderTurnRejectedError(
        "Agent Host has no active Provider Turn to steer.",
        request.run.attemptId
      );
    }
    if (request.nativeSessionId !== session.nativeSessionId
      || request.nativeTurnId !== activeNativeTurnId) {
      operation.failure = providerDeliveryFailure({
        detail: "Agent Host steer targets a different Provider Turn.",
        errorName: "ProviderTurnRejectedError",
        phase: "turn-submit",
        hostState: snapshot.state,
        attemptId: request.run.attemptId,
        inputDisposition: "not-accepted",
        sessionDisposition: "recoverable"
      });
      throw new ProviderTurnRejectedError(
        "Agent Host steer targets a different Provider Turn.",
        request.run.attemptId
      );
    }
    if (authority === undefined || !sameProviderAuthorityFence(authority, request.authority)) {
      throw new Error("Agent Host rejected a stale Provider writer fence.");
    }
    try {
      await assertHostExecutionEnvironment(input.home, sessionPayload, session.nativeSessionId);
      const receipt = endpointReceipt(await session.steer({
        ...request.run,
        boundedText: withSessionContextPointer(request.run.boundedText, sessionPayload.environment),
        inputRef: request.run.attemptId
      }), request.run.attemptId);
      if (receipt.nativeTurnId !== request.nativeTurnId) {
        throw new ProviderDeliveryUnknownError(
          "Provider accepted steer against an unexpected native Turn.",
          request.run.attemptId
        );
      }
    } catch (error) {
      const unknown = error instanceof ProviderDeliveryUnknownError;
      operation.failure = providerDeliveryFailureFrom(error, {
        phase: "turn-submit",
        hostState: snapshot.state,
        attemptId: request.run.attemptId,
        inputDisposition: unknown ? "unknown" : "not-accepted",
        sessionDisposition: "unknown"
      });
      throw error;
    }
    return snapshot;
  };

  const setAuthority = (request: AgentHostSetAuthorityControl): AgentHostSnapshot => {
    if (session === undefined || request.nativeSessionId !== session.nativeSessionId) {
      throw new Error("Agent Host authority targets a different Provider Conversation.");
    }
    if (activeRunPayload !== undefined
      || ["starting", "ready", "settling", "delivery-unknown"].includes(snapshot.state)) {
      throw new Error("Agent Host authority cannot transfer while a AgentRun is unsettled.");
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
      // Read the Agent's configuration at answer time, not from the stored
      // snapshot. The Agent may have changed it since the last state
      // transition, and a status request is exactly where a caller expects the
      // current reading rather than the one that was true at launch. Nothing is
      // sent to the Agent to obtain it: this reads what the Session has already
      // been told.
      return controlResult("status", session === undefined
        ? snapshot
        : validateSnapshot({
            ...snapshot,
            runConfiguration: session.runConfiguration
          }));
    }
    if (request.type === "cancel") {
      if (request.nativeOnly === true && session?.capabilities.cancel !== "native-interrupt") {
        throw new Error("This Endpoint cannot natively interrupt; owned-process termination is not input control.");
      }
      if (session === undefined || request.nativeSessionId !== session.nativeSessionId
        || request.attemptId !== activeRunAttemptId
        || authority === undefined || !sameProviderAuthorityFence(authority, request.authority)) {
        throw new Error("Endpoint cancellation does not match the current Session and authority.");
      }
      // Cancellation remains callable while submit is awaiting native ack.
      // The response never declares the shared native resource stopped.
      const cancellation = await session.cancel(request.attemptId);
      return Object.freeze({ ...controlResult("cancel-requested", snapshot), cancellation });
    }
    if (request.type === "submit-turn") {
      const submission = enqueueSerialized(async () => {
        const operation: { failure?: ProviderDeliveryFailure } = {};
        try {
          return await submitRun(request, operation);
        } catch (error) {
          throw new AgentHostOperationError(error, snapshot, operation.failure);
        }
      });
      return await observePendingHostSubmission(submission, () => snapshot);
    }
    if (request.type === "steer-turn") {
      const previous = recentSteerAttempts.get(request.run.attemptId);
      if (previous !== undefined) {
        if (previous.request.nativeSessionId !== request.nativeSessionId
          || previous.request.nativeTurnId !== request.nativeTurnId
          || previous.request.run.boundedText !== request.run.boundedText
          || !sameProviderAuthorityFence(previous.request.authority, request.authority)) {
          throw new Error("Steer attempt identity cannot name another input or Provider fence.");
        }
        return controlResult(previous.outcome.result === "delivered" ? "accepted"
          : previous.outcome.result === "pending" ? "pending" : "rejected", snapshot, previous.outcome.failure);
      }
      // Reserve before queueing, so inspection is meaningful even while an
      // earlier Host operation owns the serialized dispatch lane.
      const attempt = { request, outcome: { result: "pending" } as PromptPushOutcome };
      recentSteerAttempts.set(request.run.attemptId, attempt);
      const sourcePayload = activeRunPayload ?? sessionPayload ?? payload;
      const settlement = {
        home: input.home,
        environment: sourcePayload.environment,
        nativeSessionId: request.nativeSessionId,
        nativeTurnId: request.nativeTurnId,
        attemptId: request.run.attemptId,
        boundedText: request.run.boundedText
      };
      const submission = enqueueSerialized(async () => {
        const operation: { failure?: ProviderDeliveryFailure } = {};
        let providerAccepted = false;
        try {
          const accepted = await steerRun(request, operation);
          providerAccepted = true;
          await publishStructuredProviderInputSettlement({ ...settlement, status: "accepted" });
          attempt.outcome = { result: "delivered" };
          signalRoleMailbox(input.home, sessionPayload ?? payload);
          return accepted;
        } catch (error) {
          const unknown = providerAccepted || error instanceof ProviderDeliveryUnknownError;
          const failure = operation.failure ?? providerDeliveryFailureFrom(error, {
            phase: "turn-submit", attemptId: request.run.attemptId,
            inputDisposition: providerAccepted ? "accepted" : unknown ? "unknown" : "not-accepted"
          });
          attempt.outcome = {
            result: unknown ? "delivery-unknown" : "rejected",
            failure
          };
          // Persist a native disposition before replying. Accepted publication
          // already enqueued its fact before Controller apply; never replace
          // that fact with an "unknown" when only apply acknowledgement failed.
          if (!providerAccepted) {
            try {
              await publishStructuredProviderInputSettlement({
                ...settlement, status: unknown ? "unknown" : "rejected", failure
              });
            } catch (settlementError) {
              throw new AgentHostOperationError(new ProviderDeliveryUnknownError(
                "Steer disposition could not be durably acknowledged.",
                request.run.attemptId,
                { cause: new AggregateError([error, settlementError]) }
              ), snapshot, failure);
            }
          }
          signalRoleMailbox(input.home, sessionPayload ?? payload);
          throw new AgentHostOperationError(
            providerAccepted ? new ProviderDeliveryUnknownError(
              "Steer acceptance was observed but its settlement acknowledgement is unknown.",
              request.run.attemptId, { cause: error }
            ) : error,
            snapshot, failure
          );
        }
      });
      return await observePendingHostSubmission(submission, () => snapshot);
    }
    if (request.type === "set-authority") {
      const accepted = await enqueueSerialized(async () => setAuthority(request));
      return controlResult("accepted", accepted);
    }
    const redeemed = await redeem(input.home, request.ticket);
    if (activeRunPayload !== undefined
      || ["starting", "ready", "settling", "delivery-unknown"].includes(snapshot.state)) {
      if (redeemed.providerControl?.mode === "resume"
        && redeemed.providerControl.nativeSessionId === snapshot.nativeSessionId) {
        return controlResult("accepted", snapshot);
      }
      return controlResult("busy", snapshot);
    }
    const accepted = await enqueueDispatch(redeemed);
    return controlResult("accepted", accepted);
  });

  const humanConsole = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    : undefined;
  promptHuman = (): void => {
    if (humanConsole !== undefined && (authority?.owner === "human"
      || sessionPayload?.environment.YUI_SESSION_SCOPE === "global" && authority?.owner === "controller")
      && activeRunPayload === undefined
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
      if ((currentAuthority?.owner !== "human"
        && !(currentPayload?.environment.YUI_SESSION_SCOPE === "global" && currentAuthority?.owner === "controller"))
        || currentSession === undefined
        || currentPayload === undefined) {
        process.stderr.write("Provider input rejected: human authority is not active.\n");
        return;
      }
      const boundedText = line.trim();
      if (boundedText.length === 0) return;
      const attemptId = `human:${currentAuthority.holderId}:${randomUUID()}`;
      const runControl = {
        protocol: AGENT_HOST_CONTROL_PROTOCOL,
        type: "submit-turn" as const,
        nativeSessionId: currentSession.nativeSessionId,
        authority: currentAuthority,
        run: {
          attemptId,
          boundedText
        }
      };
      const submitted = await submitRun(runControl, {});
      process.stdout.write(submitted.inputAcceptance === "provider"
        ? "Provider accepted this console input; waiting for its terminal boundary.\n"
        : "Input written to transport; Provider acceptance is not yet proven.\n");
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
      session?.detach(signal);
      forceKillTimer = setTimeout(() => session?.detach("SIGKILL"), AGENT_HOST_CLIENT_EXIT_GRACE_MS);
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
    // Ask the client to exit, then hand back the Session's hold. The reference
    // is only actually returned once the client proves it exited, so the bounded
    // stop below waits on the real dependency instead of an assumed one.
    session?.detach();
    const adapterId = endpointAdapterId;
    await endpointLease?.release();
    endpointLease = undefined;
    if (adapterId !== undefined) {
      // Stop new acquisition and wait a bounded time for what is already
      // running. A timeout reports the references and pending effects that are
      // genuinely still in use; it never escalates to killing a Provider this
      // Endpoint does not own, and it never reports quiescence it cannot prove.
      const drain = await endpointOwner.stop(adapterId, ENDPOINT_DRAIN_TIMEOUT_MS);
      if (!drain.quiescent) {
        const detail = `Endpoint stop ${drain.timedOut ? "timed out" : "returned"} after ${drain.waitedMs}ms`
          + ` (bound ${ENDPOINT_DRAIN_TIMEOUT_MS}ms); ${drain.references} reference(s), `
          + `${drain.opening} opening client(s) and `
          + `${drain.sessions.reduce((total, held) => total + held.pending.length, 0)} pending effect(s) `
          + "may still be in use. Owned client resources are unknown.";
        updateSnapshot(hostSnapshot(snapshot.state, {
          ...definedFields({
            adapterId,
            nativeSessionId: snapshot.nativeSessionId,
            conversationId: snapshot.conversationId
          }),
          ...authorityFields(),
          detail
        }));
        // The snapshot is about to stop being reachable, and a stop this process
        // could not prove quiescent must remain diagnosable afterwards. Written
        // to the Host's own stream, which its pane and logs retain.
        process.stderr.write(`${detail}\n`);
      }
    }
    // Final cleanup is bounded on its own deadline. The bounded stop above may
    // already have given up on a client that never proves exit, and waiting for
    // that same drain again would leave the control socket open and this function
    // never returning. Anything still held is reported, not silently released.
    const remaining = await endpointOwner.close(ENDPOINT_DRAIN_TIMEOUT_MS).catch(() => []);
    const held = remaining.filter((drain) => !drain.quiescent);
    if (held.length > 0) {
      const references = held.reduce((total, drain) => total + drain.references, 0);
      const opening = held.reduce((total, drain) => total + drain.opening, 0);
      process.stderr.write(
        `Endpoint cleanup returned with ${references} reference(s) and ${opening} opening client(s) `
        + `still held across ${held.length} implementation(s) (bound ${ENDPOINT_DRAIN_TIMEOUT_MS}ms); `
        + "those implementations stay detached and undisposed. Owned client resources are unknown.\n"
      );
    }
    await control.close();
    void sessionPayload;
  }
}

/** Host-restart-independent OS custody. No secret or launch payload is stored. */
async function recordProviderConnection(home: string, payload: AgentHostLaunchPayload, endpoint: AgentEndpoint): Promise<void> {
  const environment = payload.environment;
  const identity = endpoint.ownedProcessId === undefined ? undefined : readLinuxProcessIdentity(endpoint.ownedProcessId);
  if (endpoint.ownedProcessId !== undefined && identity === undefined) {
    throw new Error("Dedicated Provider process identity was lost before registration.");
  }
  const taskId = environment.YUI_TASK_ID!;
  const roleName = environment.YUI_ROLE!;
  const userHome = resolve(payload.cwd, environment.HOME ?? homedir());
  await publishStructuredProviderConnection({
    home, environment, nativeSessionId: endpoint.nativeSessionId, startupRunId: payload.startupRunId,
    connection: {
      ...(identity === undefined ? {} : { processOwner: createSessionOwnerIdentity({
      owner: environment.YUI_SESSION_SCOPE === "global"
        ? { scope: "global", roleName } : { scope: "task", taskId, roleName },
      agentId: environment.YUI_AGENT_ID!, adapterId: endpoint.adapterId,
      nativeSessionId: endpoint.nativeSessionId,
      tmux: {
        serverName: yuiTmuxServerName(home),
        socketPath: join(tmuxSocketDirectory(environment), yuiTmuxServerName(home)),
        sessionName: yuiTmuxSessionName(home, taskId ?? "operator"), windowName: roleName, panePid: process.pid
      },
      providerRoot: { pid: identity.pid, startIdentity: identity.startIdentity,
        processGroupId: identity.processGroupId, processSessionId: identity.processSessionId,
        attribution: "owned-child" },
      recordedAt: new Date()
      }) }),
      ...(endpoint.adapterId !== "codex" ? {} : { account: {
      // Account location is needed after Controller/Host loss. Never retain
      // resolved credentials or duplicate the full process environment.
      home: userHome,
      codexHome: resolve(payload.cwd, environment.CODEX_HOME ?? join(userHome, ".codex")),
      ...(endpoint.nativeAccountHome === undefined ? {} : { nativeAccountHome: endpoint.nativeAccountHome })
      } })
    }
  });
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

export async function sendAgentHostRunControl(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  control: AgentHostSubmitRunControl;
}>): Promise<AgentHostControlResult> {
  return await sendAgentHostControl(input);
}

export async function sendAgentHostSteerControl(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  control: AgentHostSteerRunControl;
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

export async function sendAgentHostCancelControl(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  control: AgentHostCancelControl;
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
  requireRunAck?: boolean;
  timeoutMs?: number;
  /** Exact process check while the existing startup acknowledgement is unavailable. */
  assertHostRunning?: () => Promise<void>;
}>): Promise<AgentHostSnapshot> {
  const deadline = Date.now() + (input.timeoutMs ?? AGENT_HOST_READY_TIMEOUT_MS);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const snapshot = await inspectAgentHost(input);
      {
        if (snapshot.state === "ready"
          || (input.requireRunAck !== true && snapshot.state === "idle")) return snapshot;
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
      await input.assertHostRunning?.();
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(
    `Agent Host did not acknowledge Provider launch: ${errorText(lastError)}.`
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
  return exchangeAgentHostControl(path, input.control, AGENT_HOST_CONTROL_TIMEOUT_MS);
}

/** Read-only upgrade/diagnostic probe of a Home-fenced socket. Never launches a Host. */
export async function inspectAgentHostSocket(path: string, timeoutMs = 250): Promise<AgentHostSnapshot> {
  return (await exchangeAgentHostControl(path, {
    protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "status"
  }, timeoutMs)).snapshot;
}

async function exchangeAgentHostControl(
  path: string, control: AgentHostControl, timeoutMs: number
): Promise<AgentHostControlResult> {
  return await new Promise((resolvePromise, reject) => {
    const client = createConnection(path);
    let response = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("Agent Host control request timed out."));
    }, timeoutMs);
    let settled = false;
    const settle = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    client.setEncoding("utf8");
    client.once("connect", () => client.end(`${JSON.stringify(validateControl(control))}\n`));
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

async function redeem(home: string, ticket: string): Promise<AgentHostLaunchPayload> {
  const result = await callController(home, "runtime.launch-redeem", {
    ticket,
    hostPid: process.pid
  });
  return validateAgentHostLaunchPayload(result);
}

async function assertHostExecutionEnvironment(
  home: string, payload: AgentHostLaunchPayload, nativeSessionId: string
): Promise<void> {
  if (payload.executionEnvironment === undefined) return;
  await callController(home, "runtime.execution-environment-check", {
    taskId: payload.environment.YUI_TASK_ID!,
    roleName: payload.environment.YUI_ROLE!,
    agentId: payload.environment.YUI_AGENT_ID!,
    workspace: payload.cwd,
    nativeSessionId
  });
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
class AgentHostOperationError extends Error {
  constructor(
    cause: unknown,
    readonly snapshot: AgentHostSnapshot,
    readonly failure?: ProviderDeliveryFailure
  ) {
    super(errorText(cause), { cause });
  }
}

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
          const result = await dispatch(request);
          socket.end(`${JSON.stringify(boundControlResponse({
            ...result,
            snapshot: {
              ...result.snapshot,
              compatibility: {
                control: AGENT_HOST_CONTROL_PROTOCOL, events: AGENT_HOST_EVENT_PROTOCOL,
                rpc: FILE_TASK_CONTROLLER_PROTOCOL_VERSION, storage: "controller-owned"
              },
              hostProcess: { pid: process.pid, startIdentity: readLinuxProcessIdentity(process.pid)!.startIdentity },
              owner: {
                scope: payload.environment.YUI_SESSION_SCOPE ?? "task",
                ...(payload.environment.YUI_TASK_ID === undefined ? {} : { taskId: payload.environment.YUI_TASK_ID }),
                roleName: payload.environment.YUI_ROLE ?? "unknown-role"
              },
              ...(payload.environment.YUI_SESSION_SCOPE !== "task" ? {} : {
                eventDelivery: structuredProviderEventDelivery(home, payload.environment, result.snapshot.nativeSessionId)
              })
            }
          }))}\n`);
        } catch (caught) {
          const error = caught instanceof AgentHostOperationError ? caught.cause : caught;
          const current = caught instanceof AgentHostOperationError ? caught.snapshot : snapshot();
          const busy = error instanceof ProviderTurnBusyError;
          // Two different facts can be unknown: whether the Provider accepted
          // the input, and whether its durable registration was committed.
          // Both leave the outcome ambiguous, so neither may be reported as a
          // definite non-acceptance.
          const unknown = error instanceof ProviderDeliveryUnknownError
            || error instanceof ControllerAcknowledgementUnknownError;
          // The failing operation already recorded the exact facts. Prefer its
          // record; only synthesize one when the failure came from outside a
          // AgentRun operation (a malformed control, say), where those facts do
          // not exist.
          const recorded = caught instanceof AgentHostOperationError ? caught.failure : undefined;
          const failure = recorded ?? providerDeliveryFailureFrom(error, {
            phase: controlRequestPhase(body),
            hostState: busy ? "busy" : unknown ? "delivery-unknown" : current.state,
            ...(current.attemptId === undefined
              ? {}
              : { attemptId: current.attemptId }),
            // The Host rejected this request before writing to the
            // Provider, except when it explicitly reported an ambiguous
            // delivery. Never silently upgrade that to not-accepted.
            inputDisposition: unknown ? "unknown" : "not-accepted"
          });
          // A bare `rejected` here is indistinguishable from the Provider
          // refusing the input. Carry the real cause and an explicit input
          // disposition so no consumer has to guess from the message text.
          socket.end(`${JSON.stringify(boundControlResponse(controlResult(
            busy ? "busy" : "rejected",
            validateSnapshot({
              ...current,
              ...(busy ? { state: "busy" as const } : {}),
              ...(unknown ? { state: "delivery-unknown" as const } : {}),
              // snapshot.detail reaches the same public read chain as the
              // failure record, so it passes the same redaction boundary.
              detail: redactAgentErrorText(errorText(error)),
              updatedAt: new Date().toISOString()
            }),
            failure
          )))}\n`);
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

/**
 * Keeps a control response inside the socket bound the client enforces.
 *
 * A large `raw` chain could push the response past `HOST_CONTROL_MAX_BYTES`,
 * and the client destroys anything over it — turning a precise structured
 * failure into a bare transport error and losing the cause entirely. Bound
 * display projections first; if the raw payload still exceeds the UTF-8 byte
 * budget, retain its head and tail with an explicit truncation marker.
 */
function boundControlResponse(result: AgentHostControlResult): AgentHostControlResult {
  // Every public response, including status and successful controls, crosses
  // the same redaction/size boundary. An earlier failed operation may remain
  // visible through an otherwise successful status request.
  result = {
    ...controlResult(
      result.outcome,
      validateSnapshot(result.snapshot),
      result.failure === undefined ? undefined : providerDeliveryFailure(result.failure)
    ),
    ...(result.cancellation === undefined ? {} : { cancellation: result.cancellation })
  };
  if (withinControlBound(result)) return result;
  const clip = (text: string, chars: number): string => {
    if (text.length <= chars) return text;
    const head = Math.floor(chars * 0.75);
    return `${text.slice(0, head)}…[truncated ${text.length - chars} chars: control byte bound]${
      text.slice(text.length - (chars - head))
    }`;
  };
  // Never make an omitted option list look like a complete empty enumeration.
  if (result.snapshot.runConfiguration?.status === "observed") {
    result = controlResult(
      result.outcome,
      validateSnapshot({
        ...result.snapshot,
        runConfiguration: unknownAgentRunConfiguration(
          "The Agent's reported configuration is too large for the Agent Host "
          + "control response, so it could not be carried in full and none of it "
          + "is shown rather than part of it."
        )
      }),
      result.failure
    );
    if (withinControlBound(result)) return result;
  }
  let bounded = controlResult(
    result.outcome,
    {
      ...result.snapshot,
      ...(result.snapshot.detail === undefined ? {} : { detail: clip(result.snapshot.detail, 1200) })
    },
    result.failure === undefined ? undefined : { ...result.failure, detail: clip(result.failure.detail, 1200) }
  );
  const raw = bounded.failure?.raw;
  if (withinControlBound(bounded) || raw === undefined) return bounded;
  let chars = raw.length;
  while (!withinControlBound(bounded) && chars > 0) {
    chars = Math.floor(chars / 2);
    bounded = controlResult(bounded.outcome, bounded.snapshot, {
      ...bounded.failure!,
      raw: clip(raw, chars)
    });
  }
  return bounded;
}

function withinControlBound(result: AgentHostControlResult): boolean {
  // The newline the socket appends counts against the same bound.
  return Buffer.byteLength(`${JSON.stringify(result)}\n`, "utf8") <= HOST_CONTROL_MAX_BYTES;
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
  if (control.type === "cancel") {
    if (control.nativeOnly !== undefined && typeof control.nativeOnly !== "boolean") {
      throw new Error("Native-only cancellation flag is invalid.");
    }
    validateIdentity(control.nativeSessionId, "native Session id");
    validateIdentity(control.attemptId, "Provider input attempt id");
    validateProviderAuthorityFence(control.authority);
    return Object.freeze({ ...control });
  }
  if (control.type === "submit-turn" || control.type === "steer-turn") {
    validateIdentity(control.nativeSessionId, "native Session id");
    if (control.type === "submit-turn" && control.runId !== undefined) {
      validateIdentity(control.runId, "AgentRun id");
    }
    if (control.type === "steer-turn") validateIdentity(control.nativeTurnId, "native Turn id");
    validateProviderAuthorityFence(control.authority);
    validateIdentity(control.run.attemptId, "Provider input attempt id");
    if (typeof control.run.boundedText !== "string"
      || control.run.boundedText.includes("\0")
      || Buffer.byteLength(control.run.boundedText, "utf8") > 32 * 1024) {
      throw new Error("Agent Host Provider input is invalid.");
    }
    return Object.freeze({
      ...control,
      run: Object.freeze({ ...control.run })
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
  if (typeof control.ticket !== "string" || !/^[a-f0-9]{64}$/u.test(control.ticket)) {
    throw new Error("Agent Host launch control ticket is invalid.");
  }
  return Object.freeze({ ...control });
}

function validateIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Agent Host ${label} is invalid.`);
  }
}

function validateControlResult(result: AgentHostControlResult): AgentHostControlResult {
  if (result.protocol !== AGENT_HOST_CONTROL_PROTOCOL
    || !["status", "accepted", "pending", "cancel-requested", "rejected", "busy"].includes(
      result.outcome
    )) {
    throw new Error("Agent Host control response is invalid.");
  }
  return Object.freeze({
    ...result,
    snapshot: validateSnapshot(result.snapshot),
    // A malformed failure record must never mask the outcome it describes.
    // Drop it and let the consumer fall back to snapshot.detail.
    ...(isProviderDeliveryFailure(result.failure)
      ? { failure: Object.freeze({ ...result.failure }) }
      : {})
  });
}

function isProviderDeliveryFailure(value: unknown): value is ProviderDeliveryFailure {
  if (value === null || typeof value !== "object") return false;
  const failure = value as Partial<ProviderDeliveryFailure>;
  return typeof failure.detail === "string"
    && failure.detail.trim().length > 0
    && typeof failure.phase === "string"
    && (failure.raw === undefined || typeof failure.raw === "string")
    && (failure.registrationDisposition === undefined
      || ["committed", "not-committed", "unknown"].includes(failure.registrationDisposition))
    && ["accepted", "not-accepted", "unknown"].includes(failure.inputDisposition ?? "");
}

function validateSnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot {
  if (snapshot.schemaVersion !== 2
    || !["idle", "starting", "ready", "settling", "delivery-unknown", "busy", "rejected", "failed", "exited"]
      .includes(snapshot.state)) {
    throw new Error("Agent Host snapshot is invalid.");
  }
  if (!Number.isFinite(Date.parse(snapshot.updatedAt))) {
    throw new Error("Agent Host snapshot timestamp is invalid.");
  }
  if (snapshot.inputAcceptance !== undefined
    && snapshot.inputAcceptance !== "provider" && snapshot.inputAcceptance !== "transport") {
    throw new Error("Agent Host input acceptance evidence is invalid.");
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
  // Store only the redacted diagnostic in the live snapshot. Sanitizing the
  // immediate error response alone leaves status/launch acknowledgements able
  // to expose the original exception on their normal success paths.
  return Object.freeze({
    ...snapshot,
    ...(snapshot.runConfiguration === undefined
      ? {}
      // Re-read through the same parser the client uses. A shape this build does
      // not recognize becomes an explicit `unknown` here rather than travelling
      // as a partial record that renders like a real answer.
      : { runConfiguration: readAgentRunConfigurationObservation(snapshot.runConfiguration) }),
    ...(snapshot.detail === undefined ? {} : { detail: redactAgentErrorText(snapshot.detail) })
  });
}

function hostSnapshot(
  state: AgentHostProviderState,
  fields: Partial<Omit<AgentHostSnapshot, "schemaVersion" | "state" | "updatedAt">> = {}
): AgentHostSnapshot {
  return validateSnapshot({
    schemaVersion: 2,
    state,
    ...definedFields(fields),
    updatedAt: new Date().toISOString()
  });
}

function controlResult(
  outcome: AgentHostControlOutcome,
  snapshot: AgentHostSnapshot,
  failure?: ProviderDeliveryFailure
): AgentHostControlResult {
  return Object.freeze({
    protocol: AGENT_HOST_CONTROL_PROTOCOL,
    outcome,
    snapshot,
    ...(failure === undefined ? {} : { failure })
  });
}

/**
 * Best-effort failure phase for a request that failed before or during
 * parsing. An unparsable body cannot be attributed to a specific control, so
 * it stays `turn-submit` only when the body actually claims that type.
 */
function controlRequestPhase(body: string): AgentErrorPhase {
  try {
    const type = (JSON.parse(body.trim()) as Partial<AgentHostControl>).type;
    if (type === "submit-turn" || type === "steer-turn") return "turn-submit";
    if (type === "cancel") return "host-stop";
    if (type === "launch") return "session-restore";
  } catch {
    // An unparsable control never reached the Provider.
  }
  return "host-start";
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined)
  ) as Partial<T>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

/** Preserve the existing durable publication/failure path at the Host boundary. */
function endpointReceipt(result: AgentEndpointSubmission, attemptId: string) {
  if (result.status === "accepted") return result.receipt;
  if (result.status === "pending") {
    throw result.error ?? new ProviderTurnBusyError("The same Endpoint input is still pending.", attemptId);
  }
  throw result.error;
}

async function observePendingHostSubmission(
  submission: Promise<AgentHostSnapshot>,
  snapshot: () => AgentHostSnapshot
): Promise<AgentHostControlResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      submission.then((accepted) => controlResult("accepted", accepted)),
      new Promise<AgentHostControlResult>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(controlResult("pending", snapshot())), PROVIDER_ACCEPT_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function signalRoleMailbox(home: string, payload: AgentHostLaunchPayload): void {
  const taskId = payload.environment.YUI_TASK_ID;
  const roleName = payload.environment.YUI_ROLE;
  if (roleName === undefined) return;
  const key = taskId === undefined
    ? `global-role:${encodeURIComponent(roleName)}`
    : `role:${encodeURIComponent(taskId)}/${encodeURIComponent(roleName)}`;
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

function hostRunControlParams(
  payload: AgentHostLaunchPayload,
  nativeSessionId: string,
  authority: ProviderAuthorityFence,
  attemptId: string,
  runId?: string
): Readonly<Record<string, string | number>> {
  const environment = payload.environment;
  return Object.freeze({
    ...(environment.YUI_SESSION_SCOPE === "global" ? {} : {
      taskId: requiredEnvironment(environment.YUI_TASK_ID, "Task id")
    }),
    roleName: requiredEnvironment(environment.YUI_ROLE, "Role name"),
    ...(runId === undefined ? {} : { runId: requiredEnvironment(runId, "AgentRun id") }),
    agentId: requiredEnvironment(environment.YUI_AGENT_ID, "Agent id"),
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
  durableRun: Readonly<Record<string, string | number>>
): Promise<JsonValue> {
  try {
    return await callControllerIdempotently(home, "runtime.provider-turn-begin", durableRun);
  } catch (error) {
    if (error instanceof ControllerClientError && error.code === "SESSION_BUSY") {
      throw new ProviderTurnBusyError(error.message, String(durableRun.attemptId));
    }
    if (!(error instanceof ControllerAcknowledgementUnknownError)) throw error;
    await resolveProviderTurnSubmission(
      home,
      durableRun,
      new Error(
        `Provider Turn intent acknowledgement failed before Provider write: ${errorText(error)}`,
        { cause: error }
      ),
      true
    );
    // The resolve is fenced on this exact attempt id, so its success proves
    // the registration did commit and is now settled with nothing written to
    // the Provider. That is a known outcome; reporting it as unknown would
    // strand a Session whose durable record is in fact resolved.
    throw new ProviderTurnRegistrationSettledError(
      "Provider Turn registration acknowledgement was lost and its durable record has been "
      + `settled before any Provider write: ${errorText(error)}`,
      { cause: error }
    );
  }
}

async function callControllerIdempotently(
  home: string,
  method: string,
  request: Readonly<Record<string, string | number>>
): Promise<JsonValue> {
  try {
    return await callAgentController(home, method, request);
  } catch (error) {
    if (!(error instanceof ControllerClientError)
      || (error.code !== "INTERNAL_ERROR" && !controllerCallMayHaveApplied(error))) {
      throw error;
    }
    const firstCallMayHaveApplied = controllerCallMayHaveApplied(error);
    // These methods carry exact attempt, launch, and authority fences. A
    // bounded replay confirms a commit whose acknowledgement may have been lost.
    try {
      return await callAgentController(home, method, request);
    } catch (replayError) {
      if (firstCallMayHaveApplied || controllerCallMayHaveApplied(replayError)) {
        throw new ControllerAcknowledgementUnknownError(
          `${method} may have been committed, but its acknowledgement could not be confirmed: ${
            errorText(replayError)
          }`,
          { cause: new AggregateError(
            [error, replayError],
            "Controller acknowledgement could not be confirmed by its exact idempotent replay.",
            { cause: replayError }
          ) }
        );
      }
      throw replayError;
    }
  }
}

class ControllerAcknowledgementUnknownError extends Error {
  readonly name = "ControllerAcknowledgementUnknownError";
}

/**
 * The registration acknowledgement was lost, but the compensating resolve
 * then succeeded against the same attempt fence. Both facts are therefore
 * known: the durable record is settled and the Provider was never written to.
 */
class ProviderTurnRegistrationSettledError extends Error {
  readonly name = "ProviderTurnRegistrationSettledError";
}

async function resolveProviderTurnSubmission(
  home: string,
  durableRun: Readonly<Record<string, string | number>>,
  error: unknown,
  noProviderWrite = false
): Promise<void> {
  const attemptId = durableRun.attemptId;
  if (typeof attemptId !== "string") {
    throw new Error("Provider Turn resolution has no attempt id.");
  }
  const request = {
    ...durableRun,
    status: error instanceof ProviderDeliveryUnknownError
      ? "delivery-unknown"
      : error instanceof ProviderTurnBusyError ? "deferred" : "rejected",
    reason: errorText(error),
    raw: serializeAgentErrorRaw(error),
    ...(noProviderWrite || error instanceof CodexPreSubmissionError ? { providerWrite: "not-issued" } : {}),
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
      attemptId,
      // Without this the causal chain ends at the wrapper, and the reason the
      // resolution failed — the fact that decides whether a retry is safe —
      // survives only as prose inside the message.
      { cause: new AggregateError(
        [error, resolutionError],
        "Provider submission outcome and its failed durable settlement.",
        { cause: resolutionError }
      ) }
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
): Promise<JsonValue> {
  try {
    return await callController(home, method, params);
  } catch (error) {
    if (!isControllerUnavailable(error) || !isForeignHandoverLockHeld(home)) {
      throw error;
    }
  }
  const deadline = Date.now() + AGENT_HOST_CONTROL_TIMEOUT_MS;
  while (isForeignHandoverLockHeld(home) && Date.now() < deadline) await delay(50);
  // The pinned Host can rediscover a replacement, but must never start a
  // Controller using its own old implementation or open the Home's database.
  return await callController(home, method, params);
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
