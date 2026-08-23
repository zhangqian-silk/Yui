import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export type AgentHostLaunchPayload = Readonly<{
  schemaVersion: 1;
  launchId: string;
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  cwd: string;
  childLifecycle: "persistent" | "per-turn";
  startMode: "provider" | "idle";
  providerInput?: Readonly<{
    /** Provider-neutral Host primitive; the Adapter owns the JSON wire choice. */
    kind: "stdin-json-user-message";
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
  if (payload.providerInput !== undefined) {
    if (payload.providerInput.kind !== "stdin-json-user-message") {
      throw new Error("Agent Host Provider input transport is invalid.");
    }
    if (typeof payload.providerInput.boundedText !== "string"
      || payload.providerInput.boundedText.includes("\0")
      || Buffer.byteLength(payload.providerInput.boundedText, "utf8") > 4 * 1024) {
      throw new Error("Agent Host Provider input must be bounded bootstrap text.");
    }
  }
  return payload;
}

function text(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`Agent Host ${label} is invalid.`);
  }
  return value;
}
