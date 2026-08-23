import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync, rmSync } from "node:fs";
import { readdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer, createConnection, type Server } from "node:net";

import { callController } from "../core/controllerClient.js";
import {
  validateAgentHostLaunchPayload,
  type AgentHostLaunchPayload
} from "./launchBroker.js";
import {
  validateRuntimeProcessExitObservation,
  type RuntimeProcessExitObservation
} from "./processExitObservation.js";
import {
  readRuntimeStopReceipt,
  removeRuntimeStopReceipt
} from "./runtimeStopReceipt.js";

export const AGENT_HOST_CONTROL_PROTOCOL = "yui-agent-host/v1" as const;
const HOST_CONTROL_TIMEOUT_MS = 5_000;
const HOST_CONTROL_MAX_BYTES = 8 * 1024;
export type AgentHostLaunchControl = Readonly<{
  protocol: typeof AGENT_HOST_CONTROL_PROTOCOL;
  type: "launch";
  launchId: string;
  ticket: string;
}>;
export type AgentHostControlResult = "accepted" | "active-same-launch" | "active-other-launch";

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
  await replayExitOutbox(input.home);
  const control = await openHostControl(input.home, payload);
  try {
    for (;;) {
      while (payload.startMode === "idle") {
        const next = await control.next();
        payload = await redeem(input.home, next.launchId, next.ticket);
      }
      control.setActive(true, payload.launchId);
      const result = await runAgentHostProviderChild(payload);
      control.setActive(false);
      hostSequence += 1;
      const stopReceipt = readRuntimeStopReceipt(input.home, payload.launchId);
      await persistAndSubmitExit(input.home, validateRuntimeProcessExitObservation({
      schemaVersion: 1,
      observationId: `${hostInstanceId}-${hostSequence}`,
      hostSequence,
      hostInstanceId,
      providerProcessInstanceId: result.processInstanceId,
      ...(payload.environment.YUI_TASK_ID === undefined
        ? {}
        : { taskId: payload.environment.YUI_TASK_ID }),
      roleName: payload.environment.YUI_ROLE ?? "unknown-role",
      ...(payload.environment.YUI_RUN_ID === undefined
        ? {}
        : { runId: payload.environment.YUI_RUN_ID }),
      launchId: payload.launchId,
      ...(payload.environment.YUI_NATIVE_SESSION_ID === undefined
        ? {}
        : { nativeSessionId: payload.environment.YUI_NATIVE_SESSION_ID }),
      processKind: "provider-child",
      ...(result.code === null ? {} : { exitCode: result.code }),
      ...(result.signal === null ? {} : { signal: result.signal }),
      ...(stopReceipt === null ? {} : { stopReceiptId: stopReceipt.receiptId }),
      observedAt: new Date().toISOString()
      }));
      if (stopReceipt !== null) removeRuntimeStopReceipt(input.home, payload.launchId);
      if (result.hostStopRequested) return 0;
      // The Agent Host is the durable pane owner. Provider-child exit only
      // moves it to idle; an exact resume launch may arrive over the private
      // control socket without replacing the Host or native conversation.
      const next = await control.next();
      payload = await redeem(input.home, next.launchId, next.ticket);
    }
  } finally {
    await control.close();
  }
}

export function agentHostControlSocketPath(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
}>): string {
  const owner = input.scope === "task" ? input.taskId ?? "missing-task" : "global";
  const digest = Buffer.from(`${input.scope}\0${owner}\0${input.roleName}`, "utf8")
    .toString("base64url")
    .slice(0, 80);
  return resolve(join(input.home, "runtime", "agent-host-control", `${digest}.sock`));
}

export async function sendAgentHostLaunchControl(input: Readonly<{
  home: string;
  scope: string;
  taskId?: string;
  roleName: string;
  control: AgentHostLaunchControl;
}>): Promise<AgentHostControlResult> {
  const path = agentHostControlSocketPath(input);
  return await new Promise((resolvePromise, reject) => {
    const client = createConnection(path);
    let response = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("Agent Host control request timed out."));
    }, HOST_CONTROL_TIMEOUT_MS);
    const settle = <T>(callback: (value: T) => void, value: T): void => {
      clearTimeout(timer);
      callback(value);
    };
    client.setEncoding("utf8");
    client.once("connect", () => client.end(`${serializeAgentHostLaunchControl(input.control)}\n`));
    client.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > HOST_CONTROL_MAX_BYTES) {
        client.destroy(new Error("Agent Host control response exceeds its bound."));
      }
    });
    client.once("error", (error) => settle(reject, error));
    client.once("close", () => {
      const value = response.trim();
      if (value === "accepted" || value === "active-same-launch"
        || value === "active-other-launch") settle(resolvePromise, value);
      else settle(reject, new Error(`Agent Host control response is invalid: ${value || "empty"}.`));
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

export async function runAgentHostProviderChild(
  payload: AgentHostLaunchPayload
): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  processInstanceId: string;
  hostStopRequested: boolean;
}>> {
  const processInstanceId = randomUUID();
  const child = spawn(payload.command, [...payload.args], {
    cwd: payload.cwd,
    env: { ...payload.environment },
    stdio: payload.providerInput === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    detached: true
  });
  if (payload.providerInput !== undefined) {
    if (child.stdin === null) throw new Error("Provider input pipe is unavailable.");
    const providerInput = `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: payload.providerInput.boundedText }]
      }
    })}\n`;
    child.stdin.end(providerInput, "utf8");
  }
  const forward = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  let hostStopRequested = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  for (const signal of signals) {
    const handler = () => {
      hostStopRequested = true;
      forward(signal);
      forceKillTimer ??= setTimeout(() => forward("SIGKILL"), 10_000);
      forceKillTimer.unref();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal, processInstanceId, hostStopRequested });
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  }
}

async function persistAndSubmitExit(home: string, observation: RuntimeProcessExitObservation): Promise<void> {
  const directory = resolve(join(home, "runtime", "agent-host-outbox"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${observation.hostInstanceId}.jsonl`);
  const descriptor = openSync(path, "a", 0o600);
  try {
    appendFileSync(descriptor, `${JSON.stringify(observation)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  await callController(home, "runtime.process-exit-observe", observation);
  rmSync(path, { force: true });
}

async function replayExitOutbox(home: string): Promise<void> {
  const directory = resolve(join(home, "runtime", "agent-host-outbox"));
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of entries.filter((value) => value.includes(".jsonl")).sort()) {
    const path = join(directory, name);
    const claimed = `${path}.claim-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const lines = (await readFile(claimed, "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      const observation = validateRuntimeProcessExitObservation(
        JSON.parse(line) as RuntimeProcessExitObservation
      );
      await callController(home, "runtime.process-exit-observe", observation);
    }
    await unlink(claimed);
  }
}

async function openHostControl(home: string, payload: AgentHostLaunchPayload): Promise<Readonly<{
  setActive(value: boolean, launchId?: string): void;
  next(): Promise<AgentHostLaunchControl>;
  close(): Promise<void>;
}>> {
  const directory = resolve(join(home, "runtime", "agent-host-control"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = agentHostControlSocketPath({
    home,
    scope: payload.environment.YUI_SESSION_SCOPE ?? "task",
    ...(payload.environment.YUI_TASK_ID === undefined
      ? {}
      : { taskId: payload.environment.YUI_TASK_ID }),
    roleName: payload.environment.YUI_ROLE ?? "unknown-role"
  });
  if (await hostControlSocketIsLive(path)) {
    throw new Error(`Agent Host control socket is already owned: ${path}.`);
  }
  rmSync(path, { force: true });
  let active = false;
  let activeLaunchId: string | undefined;
  const queued: AgentHostLaunchControl[] = [];
  const waiters: Array<(control: AgentHostLaunchControl) => void> = [];
  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > HOST_CONTROL_MAX_BYTES) {
        socket.destroy(new Error("Agent Host control request exceeds its bound."));
      }
    });
    socket.once("end", () => {
      try {
        const control = validateControl(JSON.parse(body.trim()) as AgentHostLaunchControl);
        if (active || queued.length > 0) {
          socket.end(activeLaunchId === control.launchId
            ? "active-same-launch\n"
            : "active-other-launch\n");
          return;
        }
        const waiter = waiters.shift();
        if (waiter === undefined) queued.push(control);
        else waiter(control);
        socket.end("accepted\n");
      } catch (error) {
        socket.destroy(error as Error);
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolvePromise());
  });
  chmodSync(path, 0o600);
  return Object.freeze({
    setActive(value: boolean, launchId?: string): void {
      active = value;
      activeLaunchId = value ? launchId : undefined;
    },
    next(): Promise<AgentHostLaunchControl> {
      const available = queued.shift();
      if (available !== undefined) return Promise.resolve(available);
      return new Promise((resolvePromise) => waiters.push(resolvePromise));
    },
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

function validateControl(control: AgentHostLaunchControl): AgentHostLaunchControl {
  if (control.protocol !== AGENT_HOST_CONTROL_PROTOCOL || control.type !== "launch") {
    throw new Error("Agent Host control protocol is invalid.");
  }
  if (typeof control.launchId !== "string" || control.launchId.length === 0
    || control.launchId.length > 256 || control.launchId.includes("\0")) {
    throw new Error("Agent Host launch control identity is invalid.");
  }
  if (typeof control.ticket !== "string" || !/^[a-f0-9]{64}$/u.test(control.ticket)) {
    throw new Error("Agent Host launch control ticket is invalid.");
  }
  return Object.freeze({ ...control });
}
