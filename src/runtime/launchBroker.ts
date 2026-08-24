import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  validateProviderAuthorityFence,
  type ProviderAuthorityFence
} from "./providerAuthorityFence.js";

export type AgentHostLaunchPayload = Readonly<{
  schemaVersion: 1;
  launchId: string;
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  cwd: string;
  childLifecycle: "persistent" | "per-turn";
  startMode: "provider" | "idle";
  providerControl?: AgentHostProviderControl;
}>;

export type AgentHostProviderControl = Readonly<{
  schemaVersion: 1;
  adapterId: "codex" | "claude";
  transport: "codex-app-server-stdio" | "claude-stream-json";
  mode: "new" | "resume";
  nativeSessionId?: string;
  sessionTitle?: string;
  authority: ProviderAuthorityFence;
  initialTurn?: Readonly<{
    attemptId: string;
    boundedText: string;
  }>;
}>;

type Reservation = Readonly<{
  ticket: string;
  payload: AgentHostLaunchPayload;
  createdAt: number;
}>;

const brokers = new Map<string, LaunchBroker>();
const TICKET_TTL_MS = 60_000;

/** One Controller-process broker per canonical Home. Payloads never hit disk or tmux. */
export function launchBrokerForHome(home: string): LaunchBroker {
  const key = resolve(home);
  const existing = brokers.get(key);
  if (existing !== undefined) return existing;
  const broker = new LaunchBroker();
  brokers.set(key, broker);
  return broker;
}

export class LaunchBroker {
  readonly #reservations = new Map<string, Reservation>();

  reserve(payload: AgentHostLaunchPayload): Readonly<{ launchId: string; ticket: string }> {
    validatePayload(payload);
    if (this.#reservations.has(payload.launchId)) {
      throw new Error(`Launch payload is already reserved: ${payload.launchId}.`);
    }
    const ticket = randomBytes(32).toString("hex");
    this.#reservations.set(payload.launchId, Object.freeze({
      ticket,
      payload,
      createdAt: Date.now()
    }));
    return Object.freeze({ launchId: payload.launchId, ticket });
  }

  redeem(launchId: string, ticket: string): AgentHostLaunchPayload {
    const reservation = this.#reservations.get(launchId);
    if (reservation === undefined || reservation.ticket !== ticket) {
      throw new Error("Launch ticket is invalid or already consumed.");
    }
    this.#reservations.delete(launchId);
    if (Date.now() - reservation.createdAt > TICKET_TTL_MS) {
      throw new Error("Launch ticket expired before redemption.");
    }
    return reservation.payload;
  }

  revoke(launchId: string): void {
    this.#reservations.delete(launchId);
  }

  pendingCount(): number {
    return this.#reservations.size;
  }
}

export function validateAgentHostLaunchPayload(value: unknown): AgentHostLaunchPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Host launch payload must be an object.");
  }
  return validatePayload(value as AgentHostLaunchPayload);
}

function validatePayload(payload: AgentHostLaunchPayload): AgentHostLaunchPayload {
  if (payload.schemaVersion !== 1) throw new Error("Agent Host launch payload version is invalid.");
  text(payload.launchId, "launchId");
  text(payload.command, "command");
  text(payload.cwd, "cwd");
  if (!Array.isArray(payload.args)) throw new Error("Agent Host launch args must be an array.");
  payload.args.forEach((value) => text(value, "argument"));
  if (payload.environment === null || typeof payload.environment !== "object") {
    throw new Error("Agent Host launch environment must be an object.");
  }
  for (const [key, value] of Object.entries(payload.environment)) {
    text(key, "environment key");
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error("Agent Host launch environment value is invalid.");
    }
  }
  if (payload.childLifecycle !== "persistent" && payload.childLifecycle !== "per-turn") {
    throw new Error("Agent Host child lifecycle is invalid.");
  }
  if (payload.startMode !== "provider" && payload.startMode !== "idle") {
    throw new Error("Agent Host start mode is invalid.");
  }
  if (payload.providerControl !== undefined) validateProviderControl(payload.providerControl);
  return payload;
}

function validateProviderControl(control: AgentHostProviderControl): void {
  if (control.schemaVersion !== 1) throw new Error("Agent Host Provider control version is invalid.");
  if (control.adapterId !== "codex" && control.adapterId !== "claude") {
    throw new Error("Agent Host Provider control adapter is invalid.");
  }
  if ((control.adapterId === "codex" && control.transport !== "codex-app-server-stdio")
    || (control.adapterId === "claude" && control.transport !== "claude-stream-json")) {
    throw new Error("Agent Host Provider control transport does not match its adapter.");
  }
  if (control.mode !== "new" && control.mode !== "resume") {
    throw new Error("Agent Host Provider control mode is invalid.");
  }
  const requiresNativeSessionId = control.mode === "resume" || control.adapterId === "claude";
  if (requiresNativeSessionId !== (control.nativeSessionId !== undefined)) {
    throw new Error("Agent Host Provider resume identity is inconsistent.");
  }
  if (control.nativeSessionId !== undefined) text(control.nativeSessionId, "nativeSessionId");
  if (control.sessionTitle !== undefined) {
    const title = control.sessionTitle.trim();
    if (
      title.length === 0
      || title.length > 1_024
      || /[\r\n\0]/u.test(title)
    ) {
      throw new Error("Agent Host Provider session title is invalid.");
    }
  }
  validateProviderAuthorityFence(control.authority);
  if (control.initialTurn !== undefined) {
    text(control.initialTurn.attemptId, "Provider input attemptId");
    if (typeof control.initialTurn.boundedText !== "string"
      || control.initialTurn.boundedText.includes("\0")
      || Buffer.byteLength(control.initialTurn.boundedText, "utf8") > 32 * 1024) {
      throw new Error("Agent Host Provider input must be bounded bootstrap text.");
    }
  }
}

function text(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`Agent Host ${label} is invalid.`);
  }
  return value;
}
