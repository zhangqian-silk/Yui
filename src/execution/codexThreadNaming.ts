import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;

export type CodexThreadNameRequest = Readonly<{
  command: string;
  baseArgs?: readonly string[];
  environment: NodeJS.ProcessEnv;
  threadId: string;
  name: string;
  timeoutMs?: number;
}>;

const DEFAULT_TIMEOUT_MS = 1_000;

export async function setCodexThreadName(
  request: CodexThreadNameRequest
): Promise<void> {
  const timeoutMs = threadNameTimeout(request.timeoutMs);
  const client = await CodexNamingClient.start(
    request.command,
    request.environment,
    request.baseArgs ?? [],
    timeoutMs
  );
  try {
    await withTimeout(
      client.request("thread/name/set", {
        threadId: requiredText(request.threadId, "Codex thread id"),
        name: requiredThreadName(request.name)
      }),
      timeoutMs,
      "Timed out setting Codex thread name."
    );
  } finally {
    client.close();
  }
}

class CodexNamingClient {
  readonly #pending = new Map<number, Readonly<{
    resolve(value: JsonObject): void;
    reject(error: Error): void;
  }>>();
  readonly #stderr: string[] = [];
  #nextId = 1;
  #closed = false;

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => { this.#receive(line); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr.push(chunk);
      if (this.#stderr.join("").length > 16_384) this.#stderr.shift();
    });
    child.on("error", (error) => { this.#failAll(error); });
    child.on("exit", (code, signal) => {
      if (this.#closed) return;
      const detail = this.#stderr.join("").trim();
      this.#failAll(new Error(
        `Codex App Server exited (${code ?? signal ?? "unknown"})${
          detail.length === 0 ? "" : `: ${detail}`
        }`
      ));
    });
  }

  static async start(
    command: string,
    environment: NodeJS.ProcessEnv,
    baseArgs: readonly string[],
    timeoutMs: number
  ): Promise<CodexNamingClient> {
    const client = new CodexNamingClient(spawn(
      command,
      [...baseArgs, "app-server", "--stdio"],
      { env: environment, stdio: ["pipe", "pipe", "pipe"] }
    ));
    try {
      await withTimeout(
        client.request("initialize", {
          clientInfo: { name: "yui", title: "Yui", version: "0.2.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false
          }
        }),
        timeoutMs,
        "Timed out initializing Codex App Server for thread naming."
      );
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.#closed) return Promise.reject(new Error("Codex App Server is closed."));
    const id = this.#nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    this.#write({ method, params });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.child.kill("SIGTERM");
    this.#failAll(new Error("Codex App Server closed."));
  }

  #write(value: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #receive(line: string): void {
    let message: JsonObject;
    try {
      message = object(JSON.parse(line), "Codex App Server message");
    } catch (error) {
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      if (typeof message.method === "string") {
        this.#write({
          id: message.id,
          error: { code: -32601, message: `Unsupported App Server request: ${message.method}` }
        });
      }
      return;
    }
    this.#pending.delete(message.id);
    if (message.error !== undefined) {
      const error = object(message.error, "Codex App Server error");
      pending.reject(new Error(
        typeof error.message === "string" ? error.message : "Codex App Server request failed."
      ));
    } else {
      pending.resolve(object(message.result, "Codex App Server result"));
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as JsonObject;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requiredThreadName(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Codex thread name is invalid.");
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error("Codex thread name is invalid.");
  }
  return normalized;
}

function threadNameTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10_000) {
    throw new Error("Codex thread name timeout is invalid.");
  }
  return Number(value);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(message)); }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
