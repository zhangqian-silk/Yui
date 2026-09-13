import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { AgentHostSnapshot, openAgentHostControl as OpenAgentHostControl } from "./agentHost.js";
import { AGENT_HOST_CONTROL_PROTOCOL } from "./agentHostProtocol.js";
import type { AgentHostLaunchPayload } from "./launchBroker.js";
import { openCodexInteractiveConnection } from "./structuredProviderHost.js";

/**
 * Keep the native TUI and its transparent App Server attachment in one pane.
 * The existing Host acknowledgement carries the ID from that TUI's exact
 * thread/start or thread/resume response, before any user/model AgentRun.
 *
 * Codex 0.150.1 cannot resume a pre-created empty Thread: no rollout exists
 * until its first message. Observing the TUI's own startup avoids creating a
 * second Thread or manufacturing a bootstrap message to materialize history.
 */
export async function runCodexInteractiveHost(
  home: string,
  payload: AgentHostLaunchPayload,
  openAgentHostControl: typeof OpenAgentHostControl
): Promise<number> {
  const environment = payload.environment;
  if (environment.YUI_SESSION_SCOPE !== "global" || environment.YUI_ADAPTER_ID !== "codex"
    || payload.providerControl !== undefined) {
    throw new Error("Interactive Codex Host requires a global native TUI launch.");
  }
  const remoteIndex = payload.args.indexOf("--remote");
  if (remoteIndex < 0 || payload.args[remoteIndex + 1] !== "unix://") {
    throw new Error("Global Codex must target the default shared daemon.");
  }
  const baseArgs: unknown = JSON.parse(environment.YUI_AGENT_BASE_ARGS ?? "[]");
  if (!Array.isArray(baseArgs) || baseArgs.some((arg) => typeof arg !== "string")) {
    throw new Error("Codex proxy base arguments are invalid.");
  }
  const expectedId = environment.YUI_NATIVE_SESSION_ID;
  let snapshot: AgentHostSnapshot = {
    schemaVersion: 2, state: "starting", adapterId: "codex", updatedAt: new Date().toISOString()
  };
  const control = await openAgentHostControl(home, payload, () => snapshot, async (request) => {
    if (request.type !== "status") {
      throw new Error("Global Codex uses its native TUI; stop it before switching Sessions.");
    }
    return { protocol: AGENT_HOST_CONTROL_PROTOCOL, outcome: "status", snapshot };
  });
  let child: ChildProcess | undefined;
  let client: WebSocket | undefined;
  let closing = false;
  let startupRequestId: string | number | undefined;
  let connection: Awaited<ReturnType<typeof openCodexInteractiveConnection>> | undefined;
  let relay: WebSocketServer | undefined;
  const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
  const stop = () => { child?.kill("SIGTERM"); };
  const fail = (error: unknown) => {
    if (closing || snapshot.state === "failed") return;
    snapshot = {
      ...snapshot, state: "failed",
      detail: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    };
    process.stderr.write(`Yui Codex attachment failed: ${snapshot.detail}\n`);
    client?.terminate();
    stop();
  };
  try {
    // This proxy is a disposable client, not the daemon. All requests belong
    // to the TUI; its startup carries the reserved launch's per-Thread options.
    connection = await openCodexInteractiveConnection({
      command: payload.command, args: [...baseArgs, "app-server", "proxy"],
      environment, cwd: payload.cwd
    });
    connection.onClose(fail);
    const token = randomBytes(32).toString("hex");
    relay = new WebSocketServer({
      host: "127.0.0.1", port: 0,
      maxPayload: 16 * 1024 * 1024, perMessageDeflate: false,
      verifyClient: (info: { req: IncomingMessage }) => info.req.headers.authorization === `Bearer ${token}`
    });
    relay.on("error", fail);
    relay.on("connection", (socket) => {
      if (client !== undefined || closing) {
        socket.close(1008, "This attachment already has its native TUI.");
        return;
      }
      client = socket;
      socket.on("error", fail);
      socket.on("close", () => {
        if (!closing) {
          closing = true;
          connection?.close();
          stop();
        }
      });
      socket.on("message", (data, binary) => {
        try {
          if (binary) throw new Error("Codex TUI sent a binary App Server request.");
          const message = jsonObject(JSON.parse(data.toString()));
          if (snapshot.nativeSessionId === undefined
            && (message.method === "thread/start" || message.method === "thread/resume")) {
            if (startupRequestId !== undefined) throw new Error("Codex sent overlapping startup requests.");
            if (typeof message.id !== "string" && typeof message.id !== "number") {
              throw new Error("Codex startup request has no correlation id.");
            }
            const params = jsonObject(message.params);
            if (expectedId === undefined ? message.method !== "thread/start"
              : message.method !== "thread/resume" || params.threadId !== expectedId) {
              throw new Error("Codex TUI startup does not match the reserved Session.");
            }
            startupRequestId = message.id;
            message.params = codexInteractiveStartupParameters(payload, params);
          }
          void connection!.send(message).catch(fail);
        } catch (error) {
          fail(error);
        }
      });
    });
    connection.onMessage((message) => {
      try {
        let nativeSessionId: string | undefined;
        if (startupRequestId !== undefined && message.id === startupRequestId
          && message.method === undefined) {
          if (message.error !== undefined) {
            throw new Error(`Codex startup failed: ${JSON.stringify(message.error)}`);
          }
          const id = jsonObject(jsonObject(message.result).thread).id;
          if (typeof id !== "string" || id.length === 0 || id.trim() !== id || id.includes("\0")
            || (expectedId !== undefined && id !== expectedId)) {
            throw new Error("Codex startup returned an invalid or mismatched Thread identity.");
          }
          nativeSessionId = id;
        }
        if (client?.readyState !== WebSocket.OPEN) throw new Error("Codex TUI attachment is closed.");
        client.send(JSON.stringify(message), (error) => {
          if (error) { fail(error); return; }
          if (nativeSessionId === undefined || snapshot.state === "failed") return;
          startupRequestId = undefined;
          snapshot = {
            ...snapshot, state: "ready", nativeSessionId, conversationId: nativeSessionId,
            updatedAt: new Date().toISOString()
          };
        });
      } catch (error) {
        fail(error);
      }
    });
    await once(relay, "listening");
    if (snapshot.state === "failed") throw new Error(snapshot.detail);
    const address = relay.address();
    if (typeof address !== "object" || address === null) throw new Error("Codex TUI relay did not bind.");
    const args = [...payload.args];
    args[remoteIndex + 1] = `ws://127.0.0.1:${address.port}`;
    args.splice(remoteIndex + 2, 0, "--remote-auth-token-env", "YUI_CODEX_REMOTE_AUTH_TOKEN");
    child = spawn(payload.command, args, {
      cwd: payload.cwd,
      env: { ...localCodexTuiEnvironment(environment), YUI_CODEX_REMOTE_AUTH_TOKEN: token },
      stdio: "inherit"
    });
    for (const signal of signals) process.on(signal, stop);
    const [code] = await once(child, "exit");
    return typeof code === "number" ? code : 1;
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    closing = true;
    for (const signal of signals) process.removeListener(signal, stop);
    stop();
    client?.terminate();
    connection?.close();
    if (relay !== undefined) await new Promise<void>((done) => relay!.close(() => done()));
    await control.close();
  }
}

/** The remote TUI can omit local launch configuration. Apply the reserved
 * workspace and managed identity on its actual startup, never by starting a
 * second Thread or changing daemon-wide configuration. */
export function codexInteractiveStartupParameters(
  payload: Pick<AgentHostLaunchPayload, "cwd" | "environment" | "interactiveCodexThread">,
  params: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const options = payload.interactiveCodexThread;
  if (options === undefined) throw new Error("Global Codex launch is missing its per-Thread options.");
  const config = params.config === undefined || params.config === null ? {} : jsonObject(params.config);
  const shell = config.shell_environment_policy === undefined ? {} : jsonObject(config.shell_environment_policy);
  const set = shell.set === undefined ? {} : jsonObject(shell.set);
  return {
    ...params,
    ...options,
    cwd: payload.cwd,
    config: {
      ...config,
      ...options.config,
      shell_environment_policy: {
        ...shell,
        set: {
          ...set,
          ...Object.fromEntries(Object.entries(payload.environment).filter(([name]) => name.startsWith("YUI_")))
        }
      }
    }
  };
}

/** Our loopback relay must stay local, even when the TUI inherits HTTP proxies. */
export function localCodexTuiEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bypass = [
    "127.0.0.1", "localhost", "::1",
    environment.NO_PROXY, environment.no_proxy
  ].filter(Boolean).join(",");
  return { ...environment, NO_PROXY: bypass, no_proxy: bypass };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex App Server object.");
  }
  return value as Record<string, unknown>;
}
