import { createServer, type Server, type ServerResponse } from "node:http";
import { usageError } from "../errors/cliError.js";
import { DASHBOARD_HTML, findWebAsset } from "./assets/assetManifest.js";
import {
  buildWebDashboardSnapshot,
  buildWebTaskDetail,
  type WebDashboardStore
} from "./webSnapshot.js";

export type WebServerOptions = Readonly<{ host: string; port: number }>;

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
  dependencies: Readonly<{ now?: () => Date }> = {}
): Server {
  const now = dependencies.now ?? (() => new Date());
  return createServer((request, response) => {
    setSecurityHeaders(response);
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      sendJson(response, 405, { error: "Method not allowed." }, method === "HEAD");
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { error: "Invalid URL." }, method === "HEAD");
      return;
    }
    try {
      const asset = findWebAsset(pathname);
      if (pathname === "/" || pathname === "/index.html") {
        sendText(response, 200, "text/html; charset=utf-8", DASHBOARD_HTML, method === "HEAD");
      } else if (asset !== null) {
        sendText(response, 200, asset.contentType, asset.body, method === "HEAD");
      } else if (pathname === "/api/dashboard") {
        sendJson(response, 200, buildWebDashboardSnapshot(store, now()), method === "HEAD");
      } else if (pathname.startsWith("/api/tasks/")) {
        const taskId = decodeURIComponent(pathname.slice("/api/tasks/".length));
        const detail = taskId.length === 0 || taskId.includes("/") ? null : buildWebTaskDetail(store, taskId);
        sendJson(response, detail === null ? 404 : 200, detail ?? { error: "Task not found." }, method === "HEAD");
      } else {
        sendJson(response, 404, { error: "Not found." }, method === "HEAD");
      }
    } catch (error) {
      if (error instanceof URIError) {
        sendJson(response, 400, { error: "Invalid URL encoding." }, method === "HEAD");
        return;
      }
      sendJson(response, 500, { error: "Unable to read Yui state." }, method === "HEAD");
    }
  });
}

export async function startYuiWebServer(
  store: WebDashboardStore,
  options: WebServerOptions
): Promise<Server> {
  const server = createYuiWebServer(store);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown, head: boolean): void {
  sendText(response, status, "application/json; charset=utf-8", JSON.stringify(value), head);
}

function sendText(response: ServerResponse, status: number, contentType: string, body: string, head: boolean): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(head ? undefined : body);
}

function webUsageError(): Error {
  return usageError("Web usage: yui web [--host <loopback>] [--port <port>].", webUsage());
}

function webUsage(): string {
  return "Usage: yui web [--host <127.0.0.1|::1|localhost>] [--port <1-65535>]";
}
