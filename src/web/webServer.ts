import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

import { CliError, usageError } from "../errors/cliError.js";
import { parseTaskCatalogOptions } from "../context/taskCatalog.js";
import type { WebTaskSurface, WebControlInput } from "./webTaskSurface.js";
import { WebRequestRejected } from "./webMutation.js";
import { TASK_SUBMISSION_INTENTS, type TaskSubmissionIntent } from "../message/message.js";
import type { SurfaceContributionRef, SurfacePanelContribution } from "../surface/surfaceContributions.js";
import type { CapabilityResult } from "../kernel/capabilityRegistry.js";
import { DASHBOARD_HTML, findWebAsset, type WebAsset } from "./assets/assetManifest.js";
import {
  buildWebDashboardSnapshot,
  buildWebTaskCatalog,
  buildWebTaskDetail,
  type WebDashboardStore
} from "./webSnapshot.js";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_TERMINAL_MESSAGE_BYTES = 64 * 1024;
const MAX_TERMINAL_BUFFERED_BYTES = 1024 * 1024;

export type WebServerOptions = Readonly<{ host: string; port: number }>;
export type YuiWebServer = Server & Readonly<{ closeTerminals(): void }>;

export type WebInputAnswer =
  | Readonly<{ choiceKey: string }>
  | Readonly<{ text: string }>;

export type WebTerminalRequest =
  | Readonly<{
      scope: "global";
      roleName: string;
      columns: number;
      rows: number;
    }>
  | Readonly<{
      scope: "task";
      taskId: string;
      roleName: string;
      columns: number;
      rows: number;
    }>;

export type WebTerminalConnection = Readonly<{
  readOnly: boolean;
  history?: Readonly<{ limit: number; target: number }>;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: Readonly<{ exitCode: number; signal?: number }>) => void): () => void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  close(): void;
}>;

export type WebServerDependencies = Readonly<{
  panels?: Readonly<{
    list(taskId: string): readonly SurfacePanelContribution[];
    read(taskId: string, ref: SurfaceContributionRef, input: unknown): Promise<CapabilityResult>;
  }>;
  surface?: WebTaskSurface;
  now?: () => Date;
  token?: string;
  answerInput?: (input: Readonly<{
    taskId: string;
    inputId: string;
    answer: WebInputAnswer;
  }>) => Promise<unknown>;
  terminal?: Readonly<{
    open(request: WebTerminalRequest): Promise<WebTerminalConnection>;
  }>;
}>;

export function parseWebCommandOptions(args: readonly string[]): WebServerOptions {
  let host = "127.0.0.1";
  let port = 4173;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--host" && value !== undefined) {
      host = value;
      index += 1;
    } else if (option === "--port" && value !== undefined) {
      port = Number(value);
      index += 1;
    } else {
      throw webUsageError();
    }
  }
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw usageError("Web host must be a loopback address (127.0.0.1, ::1, or localhost).", webUsage());
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw usageError("Web port must be an integer between 1 and 65535.", webUsage());
  }
  return { host, port };
}

export function createYuiWebServer(
  store: WebDashboardStore,
  dependencies: WebServerDependencies = {}
): YuiWebServer {
  const now = dependencies.now ?? (() => new Date());
  const token = dependencies.token ?? randomBytes(24).toString("base64url");
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_TERMINAL_MESSAGE_BYTES
  });
  const server = createServer((request, response) => {
    void handleHttpRequest(
      request,
      response,
      store,
      dependencies,
      token,
      now
    ).catch(() => {
      if (!response.headersSent) setSecurityHeaders(response);
      if (!response.writableEnded) {
        sendJson(response, 500, { error: "Unable to process Yui web request." }, false);
      }
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void handleTerminalUpgrade(
      request,
      socket,
      head,
      webSocketServer,
      dependencies.terminal,
      token
    );
  });
  let terminalsClosed = false;
  const closeTerminals = () => {
    if (terminalsClosed) return;
    terminalsClosed = true;
    for (const socket of webSocketServer.clients) socket.terminate();
    webSocketServer.close();
  };
  server.on("close", closeTerminals);
  return Object.assign(server, { closeTerminals });
}

export async function startYuiWebServer(
  store: WebDashboardStore,
  options: WebServerOptions,
  dependencies: WebServerDependencies = {}
): Promise<YuiWebServer> {
  const server = createYuiWebServer(store, dependencies);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: WebDashboardStore,
  dependencies: WebServerDependencies,
  token: string,
  now: () => Date
): Promise<void> {
  setSecurityHeaders(response);
  const method = request.method ?? "GET";
  if (!isLoopbackHost(headerValue(request, "host"))) {
    sendJson(response, 403, { error: "Invalid Host.", disposition: "not-submitted" }, method === "HEAD");
    return;
  }
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    sendJson(response, 400, { error: "Invalid URL.", disposition: "not-submitted" }, method === "HEAD");
    return;
  }

  // The loopback page token is the actual user ingress. A request body cannot
  // select Operator/Leader authority; all API reads use this boundary too.
  if (pathname.startsWith("/api/") && !tokenMatches(headerValue(request, "x-yui-web-token"), token)) {
    sendJson(response, 403, { error: "Invalid Yui web token.", disposition: "not-submitted" }, method === "HEAD");
    return;
  }
  const globalControl = /^\/api\/roles\/([^/]+)\/control$/.exec(pathname);
  if (globalControl && dependencies.surface) {
    try {
      const roleName = decodeURIComponent(globalControl[1]!);
      if (!/^[A-Za-z0-9_-]+$/.test(roleName)) throw new WebRequestRejected("Invalid Global Role.");
      if (method === "GET") {
        sendJson(response, 200, dependencies.surface.globalState(roleName), false);
      } else if (method === "POST") {
        const body = await readMutationBody(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some(key =>
            !["action", "requestId", "body", "expectedTarget", "thenMessage"].includes(key))) {
          throw new WebRequestRejected("Global input accepts only action, input and exact target fields.");
        }
        const input = body as Record<string, unknown>;
        const parsed = parseWebControlInput({ ...input,
          ...(input.action === "interrupt" ? { role: roleName }
            : input.action === "steer" ? { to: roleName } : {}) });
        sendJson(response, 200, {
          ...await dependencies.surface.globalControl(roleName, parsed), requestId: parsed.requestId
        }, false);
      } else sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Global input unavailable.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown" }, false);
    }
    return;
  }
  const panelTarget = /^\/api\/tasks\/([^/]+)\/panels$/.exec(pathname);
  if (panelTarget && dependencies.panels) {
    try {
      const taskId = decodeURIComponent(panelTarget[1]);
      if (method === "GET") {
        sendJson(response, 200, { panels: dependencies.panels.list(taskId), observedAt: now().toISOString() }, false);
      } else if (method === "POST") {
        const body = await readMutationBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some((key) => !["ref","input"].includes(key))
          || !("ref" in body) || !("input" in body)) throw new WebRequestRejected("Expected panel ref and input.");
        const ref = body.ref as SurfaceContributionRef;
        if (!ref || typeof ref !== "object" || typeof ref.capability !== "string"
          || typeof ref.contractVersion !== "string" || !ref.provider
          || typeof ref.provider.id !== "string" || typeof ref.provider.generation !== "string") {
          throw new WebRequestRejected("Invalid panel reference.");
        }
        const result = await dependencies.panels.read(taskId, ref, body.input);
        sendJson(response, 200, { result, observedAt: now().toISOString() }, false);
      } else sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Panel unavailable.",
        disposition: "not-submitted" }, false);
    }
    return;
  }
  const surfaceTarget = /^\/api\/tasks\/([^/]+)\/(context|delta|inspect|metadata|messages|control)$/.exec(pathname);
  if (surfaceTarget && dependencies.surface) {
    try {
      let taskId: string;
      try { taskId = decodeURIComponent(surfaceTarget[1]); }
      catch { throw new WebRequestRejected("Invalid Task URL encoding."); }
      const action = surfaceTarget[2];
      const query = new URL(request.url!, "http://localhost").searchParams;
      let value: unknown;
      if (method === "GET" && action === "context") {
        value = await dependencies.surface.read(taskId);
      } else if (method === "GET" && action === "delta") {
        value = dependencies.surface.delta(taskId, {
          after: query.get("after") ?? "",
          ...(query.has("continuation") ? { continuation: query.get("continuation")! } : {})
        });
      } else if (method === "GET" && action === "inspect") {
        value = dependencies.surface.inspect(taskId, {
          store: query.get("store") ?? "", refId: query.get("ref") ?? "",
          ...(query.has("digest") ? { digest: query.get("digest")! } : {})
        });
      } else if (method === "POST" && action === "messages") {
        const body = await readMutationBody(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !["body", "requestId", "intent"].includes(key))
          || !("requestId" in body) || typeof body.requestId !== "string" || !body.requestId.trim()
          || !("body" in body) || typeof body.body !== "string") throw new WebRequestRejected("Expected body, requestId and optional intent.");
        const intent = webSubmissionIntent(body);
        // requestId is threaded as the submission key (§2.3) and echoed back on the receipt.
        value = { ...dependencies.surface.message(taskId, body.body, intent, body.requestId), requestId: body.requestId };
      } else if (method === "POST" && action === "control") {
        const body = await readMutationBody(request);
        value = { ...await dependencies.surface.control(taskId, parseWebControlInput(body)), requestId: parseWebControlRequestId(body) };
      } else if (method === "POST" && action === "metadata") {
        const body = await readMutationBody(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !["patch", "requestId"].includes(key))
          || !("requestId" in body) || typeof body.requestId !== "string" || !body.requestId.trim()
          || !("patch" in body)) throw new WebRequestRejected("Expected patch and requestId only.");
        value = { ...dependencies.surface.update(taskId, body.patch), requestId: body.requestId };
      } else {
        sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
        return;
      }
      sendJson(response, 200, value, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Surface unavailable.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown" }, false);
    }
    return;
  }

  if (method === "GET" || method === "HEAD") {
    try {
      const asset = findWebAsset(pathname);
      if (pathname === "/" || pathname === "/index.html") {
        sendText(
          response,
          200,
          "text/html; charset=utf-8",
          dashboardHtml(token),
          method === "HEAD"
        );
      } else if (asset !== null) {
        sendAsset(response, asset, method === "HEAD");
      } else if (pathname === "/api/dashboard") {
        const query = new URL(request.url!, "http://localhost").searchParams;
        const snapshot = query.has("view")
          ? buildWebTaskCatalog(store, parseTaskCatalogOptions(
            [...query].flatMap(([key, value]) => key === "all"
              ? (value === "true" ? ["--all"] : ["--invalid-all"])
              : [`--${key}`, value])))
          : buildWebDashboardSnapshot(store, now());
        sendJson(response, 200, snapshot, method === "HEAD");
      } else if (pathname.startsWith("/api/tasks/")) {
        const taskId = decodeURIComponent(pathname.slice("/api/tasks/".length));
        const detail = taskId.length === 0 || taskId.includes("/")
          ? null
          : buildWebTaskDetail(store, taskId);
        sendJson(
          response,
          detail === null ? 404 : 200,
          detail ?? { error: "Task not found." },
          method === "HEAD"
        );
      } else {
        sendJson(response, 404, { error: "Not found." }, method === "HEAD");
      }
    } catch (error) {
      if (error instanceof CliError) {
        sendJson(response, 400, { error: error.message }, method === "HEAD");
        return;
      }
      if (error instanceof URIError) {
        sendJson(response, 400, { error: "Invalid URL encoding." }, method === "HEAD");
        return;
      }
      sendJson(response, 500, { error: "Unable to read Yui state." }, method === "HEAD");
    }
    return;
  }

  const answerTarget = parseAnswerPath(pathname);
  if (method === "POST" && answerTarget !== null && dependencies.answerInput !== undefined) {
    if (!tokenMatches(headerValue(request, "x-yui-web-token"), token)) {
      sendJson(response, 403, { error: "Invalid Yui web token." }, false);
      return;
    }
    let answer: WebInputAnswer;
    try {
      answer = parseWebInputAnswer(await readJsonBody(request));
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid input answer.", disposition: "not-submitted"
      }, false);
      return;
    }
    try {
      const answered = await dependencies.answerInput({
        ...answerTarget,
        answer
      });
      sendJson(response, 200, { request: answered }, false);
    } catch (error) {
      sendJson(response, 409, {
        error: error instanceof Error ? error.message : "Unable to answer input request.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown"
      }, false);
    }
    return;
  }

  response.setHeader("allow", "GET, HEAD");
  sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, method === "HEAD");
}

async function handleTerminalUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  webSocketServer: WebSocketServer,
  terminalPort: WebServerDependencies["terminal"],
  token: string
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!isLoopbackHost(headerValue(request, "host"))) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (url.pathname !== "/api/terminal" || terminalPort === undefined) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!tokenMatches(url.searchParams.get("token") ?? undefined, token)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const origin = headerValue(request, "origin");
    const host = headerValue(request, "host");
    if (origin === undefined || host === undefined || origin !== `http://${host}`) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const terminalRequest = parseTerminalRequest(url.searchParams);
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      void connectTerminal(webSocket, terminalPort, terminalRequest);
    });
  } catch {
    rejectUpgrade(socket, 400, "Bad Request");
  }
}

async function connectTerminal(
  webSocket: WebSocket,
  terminalPort: NonNullable<WebServerDependencies["terminal"]>,
  request: WebTerminalRequest
): Promise<void> {
  let disconnected = false;
  const markDisconnected = () => {
    disconnected = true;
  };
  webSocket.once("close", markDisconnected);
  webSocket.once("error", markDisconnected);

  let connection: WebTerminalConnection;
  try {
    connection = await terminalPort.open(request);
  } catch (error) {
    if (!disconnected) {
      sendWebSocket(webSocket, {
        type: "error",
        message: error instanceof Error ? error.message : "Unable to open terminal."
      });
      webSocket.close(1011, "Unable to open terminal");
    }
    return;
  }
  webSocket.off("close", markDisconnected);
  webSocket.off("error", markDisconnected);
  if (disconnected || webSocket.readyState !== WebSocket.OPEN) {
    connection.close();
    return;
  }

  let closed = false;
  let stopData = () => {};
  let stopExit = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    stopData();
    stopExit();
    connection.close();
  };
  webSocket.once("close", close);
  webSocket.once("error", close);
  stopData = connection.onData((data) => {
    if (webSocket.bufferedAmount > MAX_TERMINAL_BUFFERED_BYTES) {
      webSocket.close(1013, "Terminal client is too slow");
      return;
    }
    sendWebSocket(webSocket, { type: "data", data });
  });
  if (closed) {
    stopData();
    return;
  }
  stopExit = connection.onExit((exit) => {
    sendWebSocket(webSocket, { type: "exit", ...exit });
    webSocket.close(1000, "Terminal detached");
    close();
  });
  if (closed) {
    stopExit();
    return;
  }
  webSocket.on("message", (payload, binary) => {
    if (binary) {
      webSocket.close(1003, "Invalid terminal message");
      return;
    }
    try {
      const message = parseTerminalClientMessage(String(payload));
      if (message.type === "resize") {
        connection.resize(message.columns, message.rows);
      } else if (!connection.readOnly) {
        connection.write(message.data);
      }
    } catch {
      webSocket.close(1003, "Invalid terminal message");
    }
  });
  sendWebSocket(webSocket, {
    type: "ready",
    readOnly: connection.readOnly,
    ...(connection.history === undefined ? {} : { history: connection.history })
  });
}

function parseTerminalRequest(parameters: URLSearchParams): WebTerminalRequest {
  const scope = parameters.get("scope");
  const roleName = safeIdentity(parameters.get("role"), "Role");
  const columns = boundedInteger(parameters.get("cols"), 20, 400, "Terminal columns");
  const rows = boundedInteger(parameters.get("rows"), 5, 200, "Terminal rows");
  if (scope === "global") {
    if (parameters.has("task")) throw new Error("Global terminal cannot include a Task.");
    return { scope, roleName, columns, rows };
  }
  if (scope === "task") {
    return {
      scope,
      taskId: safeIdentity(parameters.get("task"), "Task"),
      roleName,
      columns,
      rows
    };
  }
  throw new Error("Terminal scope is invalid.");
}

type TerminalClientMessage =
  | Readonly<{ type: "input"; data: string }>
  | Readonly<{ type: "resize"; columns: number; rows: number }>;

function parseTerminalClientMessage(value: string): TerminalClientMessage {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Terminal message must be an object.");
  }
  const message = parsed as Record<string, unknown>;
  if (message.type === "input"
    && Object.keys(message).length === 2
    && typeof message.data === "string"
    && Buffer.byteLength(message.data) <= MAX_TERMINAL_MESSAGE_BYTES) {
    return { type: "input", data: message.data };
  }
  if (message.type === "resize"
    && Object.keys(message).length === 3
    && Number.isInteger(message.columns)
    && Number.isInteger(message.rows)) {
    return {
      type: "resize",
      columns: boundedInteger(String(message.columns), 20, 400, "Terminal columns"),
      rows: boundedInteger(String(message.rows), 5, 200, "Terminal rows")
    };
  }
  throw new Error("Terminal message is invalid.");
}

function parseAnswerPath(pathname: string): Readonly<{
  taskId: string;
  inputId: string;
}> | null {
  const match = /^\/api\/tasks\/([^/]+)\/inputs\/([^/]+)\/answer$/u.exec(pathname);
  if (match === null) return null;
  try {
    return {
      taskId: safeIdentity(decodeURIComponent(match[1]), "Task"),
      inputId: safeIdentity(decodeURIComponent(match[2]), "Input request")
    };
  } catch {
    return null;
  }
}

/** The three-action control body is validated to the exact CLI-equivalent
 * shape before it reaches the surface, so an unknown or malformed field is a
 * visible not-submitted rejection rather than a silent default. `requestId` is
 * the caller-supplied idempotency key common to all three actions. */
function parseWebControlRequestId(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebRequestRejected("Control input must be an object.");
  }
  const requestId = (value as Record<string, unknown>).requestId;
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new WebRequestRejected("A non-empty requestId is required.");
  }
  return requestId;
}

function requiredControlString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WebRequestRejected(`${key} is required.`);
  }
  return value;
}

function optionalControlString(input: Record<string, unknown>, key: string): string | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WebRequestRejected(`${key} must be a non-empty string when provided.`);
  }
  return value;
}

function parseWebControlInput(value: unknown): WebControlInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebRequestRejected("Control input must be an object.");
  }
  const input = value as Record<string, unknown>;
  const action = input.action;
  if (action === "queue") {
    for (const key of Object.keys(input)) {
      if (!["action", "body", "requestId", "to", "workItem", "reviewRound"].includes(key)) {
        throw new WebRequestRejected(`Unexpected field for queue: ${key}.`);
      }
    }
    if (input.workItem !== undefined && input.reviewRound !== undefined) {
      throw new WebRequestRejected("A queue takes at most one of workItem or reviewRound.");
    }
    return { action: "queue", body: requiredControlString(input, "body"),
      requestId: requiredControlString(input, "requestId"),
      ...(optionalControlString(input, "to") === undefined ? {} : { to: optionalControlString(input, "to") }),
      ...(optionalControlString(input, "workItem") === undefined ? {} : { workItem: optionalControlString(input, "workItem") }),
      ...(optionalControlString(input, "reviewRound") === undefined ? {} : { reviewRound: optionalControlString(input, "reviewRound") }) };
  }
  if (action === "steer") {
    for (const key of Object.keys(input)) {
      if (!["action", "body", "requestId", "expectedTarget", "to", "workItem", "reviewRound"].includes(key)) {
        throw new WebRequestRejected(`Unexpected field for steer: ${key}.`);
      }
    }
    if (input.workItem !== undefined && input.reviewRound !== undefined) {
      throw new WebRequestRejected("A steer takes at most one of workItem or reviewRound.");
    }
    return { action: "steer", body: requiredControlString(input, "body"),
      requestId: requiredControlString(input, "requestId"),
      expectedTarget: requiredControlString(input, "expectedTarget"),
      to: requiredControlString(input, "to"),
      ...(optionalControlString(input, "workItem") === undefined ? {} : { workItem: optionalControlString(input, "workItem") }),
      ...(optionalControlString(input, "reviewRound") === undefined ? {} : { reviewRound: optionalControlString(input, "reviewRound") }) };
  }
  if (action === "interrupt") {
    for (const key of Object.keys(input)) {
      if (!["action", "requestId", "expectedTarget", "role", "thenMessage"].includes(key)) {
        throw new WebRequestRejected(`Unexpected field for interrupt: ${key}.`);
      }
    }
    return { action: "interrupt", requestId: requiredControlString(input, "requestId"),
      expectedTarget: requiredControlString(input, "expectedTarget"),
      role: requiredControlString(input, "role"),
      ...(optionalControlString(input, "thenMessage") === undefined ? {} : { thenMessage: optionalControlString(input, "thenMessage") }) };
  }
  throw new WebRequestRejected("action must be one of queue, steer, or interrupt.");
}

function parseWebInputAnswer(value: unknown): WebInputAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Input answer must be an object.");
  }
  const answer = value as Record<string, unknown>;
  if (Object.keys(answer).length !== 1) {
    throw new Error("Exactly one of choiceKey or text is required.");
  }
  if (typeof answer.choiceKey === "string" && answer.choiceKey.trim().length > 0) {
    return { choiceKey: answer.choiceKey.trim() };
  }
  if (typeof answer.text === "string" && answer.text.trim().length > 0) {
    return { text: answer.text.trim() };
  }
  throw new Error("Exactly one non-empty choiceKey or text is required.");
}

async function readMutationBody(request: IncomingMessage): Promise<unknown> {
  try { return await readJsonBody(request); }
  catch (error) { throw new WebRequestRejected(error instanceof Error ? error.message : "Invalid request body."); }
}

/** Validate an optional submission intent from a Web message body. Absent leaves
 *  it undefined so the shared service applies the discuss default (task-32 §2.5).
 *  A present-but-invalid value is rejected rather than silently downgraded. */
function webSubmissionIntent(body: Record<string, unknown>): TaskSubmissionIntent | undefined {
  if (!("intent" in body) || body.intent === undefined) return undefined;
  if (typeof body.intent === "string"
    && (TASK_SUBMISSION_INTENTS as readonly string[]).includes(body.intent)) {
    return body.intent as TaskSubmissionIntent;
  }
  throw new WebRequestRejected(`intent must be one of ${TASK_SUBMISSION_INTENTS.join(", ")}.`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("Request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown, head: boolean): void {
  sendText(response, status, "application/json; charset=utf-8", JSON.stringify(value), head);
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  head: boolean
): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(head ? undefined : body);
}

function sendAsset(response: ServerResponse, asset: WebAsset, head: boolean): void {
  const payload = asset.encoding === "base64"
    ? Buffer.from(asset.body, "base64")
    : Buffer.from(asset.body, "utf-8");
  if (asset.contentType.startsWith("font/") || asset.contentType.startsWith("image/")) {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
  }
  response.statusCode = 200;
  response.setHeader("content-type", asset.contentType);
  response.setHeader("content-length", payload.length);
  response.end(head ? undefined : payload);
}

function sendWebSocket(webSocket: WebSocket, value: unknown): void {
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(JSON.stringify(value));
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n`
    + "Connection: close\r\n"
    + "Content-Length: 0\r\n\r\n"
  );
}

function dashboardHtml(token: string): string {
  return DASHBOARD_HTML.replace(
    'content="__YUI_WEB_TOKEN__"',
    `content="${escapeHtmlAttribute(token)}"`
  );
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHost(value: string | undefined): boolean {
  if (value === undefined) return false;
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    return false;
  }
  if (
    url.username.length > 0
    || url.password.length > 0
    || url.pathname !== "/"
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function safeIdentity(value: string | null, label: string): string {
  if (value === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedInteger(
  value: string | null,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === null || !/^[0-9]+$/u.test(value)) throw new Error(`${label} is invalid.`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function webUsageError(): Error {
  return usageError("Web usage: yui web [--host <loopback>] [--port <port>].", webUsage());
}

function webUsage(): string {
  return "Usage: yui web [--host <127.0.0.1|::1|localhost>] [--port <1-65535>]";
}
