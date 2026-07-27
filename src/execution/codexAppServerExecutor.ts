import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type {
  AttemptResult,
  ExecutorKind,
  ProviderRef
} from "./executionAttempt.js";
import type { AgentProfile, AttemptAccess } from "../profile/agentProfile.js";
import type { RoleSkillContext } from "../context/roleSessionContext.js";

type JsonObject = Record<string, unknown>;

export type CodexExecutionRequest = Readonly<{
  executor: ExecutorKind;
  input: string;
  cwd: string;
  access: AttemptAccess;
  profile: AgentProfile;
  skills?: readonly RoleSkillContext[];
  parentThreadId?: string;
  command?: string;
  baseArgs?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  controlSocketPath?: string;
}>;

export type CodexExecutionStarted = (providerRef: ProviderRef) => void;

export type CodexExecutionResponse = Readonly<{
  providerRef: ProviderRef;
  result: AttemptResult;
}>;

export interface AttemptExecutionPort {
  execute(
    request: CodexExecutionRequest,
    started?: CodexExecutionStarted
  ): Promise<CodexExecutionResponse>;
  interrupt(threadId: string, turnId: string, controlSocketPath?: string): Promise<void>;
}

/**
 * A small JSONL client for Codex App Server. It intentionally persists only
 * provider IDs and the structured final result; the native Codex transcript
 * remains the authority for full turn history.
 */
export class CodexAppServerAttemptExecutor implements AttemptExecutionPort {
  constructor(
    readonly command = "codex",
    readonly environment: NodeJS.ProcessEnv = process.env,
    readonly baseArgs: readonly string[] = []
  ) {}

  async execute(
    request: CodexExecutionRequest,
    started?: CodexExecutionStarted
  ): Promise<CodexExecutionResponse> {
    const client = await AppServerClient.start(
      request.command ?? this.command,
      request.environment ?? this.environment,
      request.baseArgs ?? [],
      request.controlSocketPath
    );
    try {
      const thread = await prepareThread(client, request);
      const threadId = requiredId(thread.id, "Codex thread id");
      const sessionId = requiredId(thread.sessionId, "Codex session id");
      const turnResponse = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: compilePrompt(request), text_elements: [] }],
        cwd: request.cwd,
        runtimeWorkspaceRoots: [request.cwd],
        approvalPolicy: "never",
        sandboxPolicy: sandboxPolicy(request.access, request.cwd),
        ...(request.profile.model === undefined
          ? {}
          : { model: request.profile.model }),
        ...(request.profile.effort === undefined
          ? {}
          : { effort: request.profile.effort }),
        outputSchema: ATTEMPT_RESULT_SCHEMA
      });
      const turn = object(turnResponse.turn, "Codex turn");
      const turnId = requiredId(turn.id, "Codex turn id");
      const providerRef = { sessionId, threadId, turnId };
      started?.(providerRef);
      const completed = await client.waitForTurn(threadId, turnId);
      if (completed.status !== "completed") {
        const detail = objectOrNull(completed.error);
        throw new Error(
          `Codex turn ${completed.status}: ${
            typeof detail?.message === "string" ? detail.message : turnId
          }`
        );
      }
      return {
        providerRef,
        result: parseAttemptResult(lastAgentMessage(completed))
      };
    } finally {
      client.close();
    }
  }

  async interrupt(
    threadId: string,
    turnId: string,
    controlSocketPath?: string
  ): Promise<void> {
    const client = controlSocketPath === undefined
      ? await AppServerClient.start(this.command, this.environment, this.baseArgs)
      : await AppServerClient.connect(
          this.command,
          this.environment,
          this.baseArgs,
          controlSocketPath
        );
    try {
      await client.request("turn/interrupt", { threadId, turnId });
    } finally {
      client.close();
    }
  }
}

async function prepareThread(
  client: AppServerClient,
  request: CodexExecutionRequest
): Promise<JsonObject> {
  const shared = {
    cwd: request.cwd,
    runtimeWorkspaceRoots: [request.cwd],
    approvalPolicy: "never",
    sandbox: sandboxMode(request.access),
    model: request.profile.model ?? null,
    developerInstructions: profileInstructions(request.profile, resolvedSkills(request))
  };
  if (request.executor === "fork") {
    if (request.parentThreadId === undefined) {
      throw new Error("Fork execution requires a compatible Leader thread.");
    }
    const response = await client.request("thread/fork", {
      threadId: request.parentThreadId,
      ...shared,
      ephemeral: false,
      excludeTurns: true
    });
    return object(response.thread, "Codex forked thread");
  }
  const response = await client.request("thread/start", {
    ...shared,
    ephemeral: false
  });
  return object(response.thread, "Codex started thread");
}

function compilePrompt(request: CodexExecutionRequest): string {
  const skills = resolvedSkills(request);
  return [
    "Complete this bounded Yui Execution Attempt.",
    `Profile: ${request.profile.id} revision ${request.profile.revision}.`,
    `Access: ${request.access}.`,
    "The following Profile instructions govern this turn:",
    profileInstructions(request.profile, skills),
    "Return only the requested structured result. Keep the summary concise and evidence-based.",
    "",
    request.input
  ].join("\n");
}

function profileInstructions(
  profile: AgentProfile,
  skills: readonly RoleSkillContext[]
): string {
  return [
    profile.description,
    profile.instructions,
    ...(skills.length === 0
      ? []
      : [
          "Agent Profile Skills are available below. Read and follow each SKILL.md before performing governed work.",
          ...skills.map((skill) => `- ${skill.id}: ${skill.path}/SKILL.md`)
        ])
  ].filter((value): value is string => value !== undefined).join("\n");
}

function resolvedSkills(request: CodexExecutionRequest): readonly RoleSkillContext[] {
  const configured = [...new Set(["yui-worker", ...(request.profile.skills ?? [])])];
  const resolved = request.skills ?? [];
  if (
    configured.length !== resolved.length
    || configured.some((id, index) => resolved[index]?.id !== id)
  ) {
    throw new Error(`Agent Profile Skills are not resolved: ${request.profile.id}.`);
  }
  return resolved;
}

function sandboxMode(access: AttemptAccess): "read-only" | "workspace-write" {
  if (access === "read") return "read-only";
  return "workspace-write";
}

function sandboxPolicy(access: AttemptAccess, cwd: string): JsonObject {
  if (access === "read") return { type: "readOnly", networkAccess: false };
  if (access === "write") {
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    };
  }
  throw new Error(`Unsupported Work Attempt access: ${String(access)}.`);
}

const ATTEMPT_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", minLength: 1 },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "outcome"],
        properties: {
          name: { type: "string", minLength: 1 },
          outcome: { enum: ["passed", "failed", "skipped"] },
          details: { type: "string" }
        }
      }
    }
  }
});

class AppServerClient {
  readonly #pending = new Map<number, Readonly<{
    resolve(value: JsonObject): void;
    reject(error: Error): void;
  }>>();
  readonly #turnWaiters = new Map<string, Readonly<{
    resolve(value: JsonObject): void;
    reject(error: Error): void;
  }>>();
  readonly #completedTurns = new Map<string, JsonObject>();
  readonly #stderr: string[] = [];
  #nextId = 1;
  #closed = false;

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly serverChild?: ChildProcess,
    readonly controlSocketPath?: string
  ) {
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
    controlSocketPath?: string
  ): Promise<AppServerClient> {
    if (controlSocketPath === undefined) {
      return this.initialize(new AppServerClient(spawn(
        command,
        [...baseArgs, "app-server", "--stdio"],
        { env: environment, stdio: ["pipe", "pipe", "pipe"] }
      )));
    }
    await prepareControlDirectory(dirname(controlSocketPath));
    await rm(controlSocketPath, { force: true });
    const serverChild = spawn(
      command,
      [...baseArgs, "app-server", "--listen", `unix://${controlSocketPath}`],
      { env: environment, stdio: "ignore" }
    );
    try {
      await waitForSocket(controlSocketPath, serverChild);
      const child = spawn(
        command,
        [...baseArgs, "app-server", "proxy", "--sock", controlSocketPath],
        { env: environment, stdio: ["pipe", "pipe", "pipe"] }
      );
      return this.initialize(new AppServerClient(child, serverChild, controlSocketPath));
    } catch (error) {
      serverChild.kill("SIGTERM");
      await rm(controlSocketPath, { force: true });
      throw error;
    }
  }

  static async connect(
    command: string,
    environment: NodeJS.ProcessEnv,
    baseArgs: readonly string[],
    controlSocketPath: string
  ): Promise<AppServerClient> {
    await stat(controlSocketPath);
    const child = spawn(command, [
      ...baseArgs,
      "app-server",
      "proxy",
      "--sock",
      controlSocketPath
    ], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return this.initialize(new AppServerClient(child));
  }

  private static async initialize(client: AppServerClient): Promise<AppServerClient> {
    await client.request("initialize", {
      clientInfo: { name: "yui", title: "Yui", version: "0.2.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    client.notify("initialized", {});
    return client;
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

  waitForTurn(threadId: string, turnId: string): Promise<JsonObject> {
    const key = `${threadId}/${turnId}`;
    const completed = this.#completedTurns.get(key);
    if (completed !== undefined) {
      this.#completedTurns.delete(key);
      return Promise.resolve(completed);
    }
    return new Promise<JsonObject>((resolve, reject) => {
      this.#turnWaiters.set(key, { resolve, reject });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.child.kill("SIGTERM");
    this.serverChild?.kill("SIGTERM");
    if (this.controlSocketPath !== undefined) {
      void rm(this.controlSocketPath, { force: true });
    }
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
    if (typeof message.id === "number") {
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
      return;
    }
    if (message.method === "turn/completed") {
      const params = object(message.params, "Turn completed params");
      const threadId = requiredId(params.threadId, "Codex thread id");
      const turn = object(params.turn, "Completed turn");
      const turnId = requiredId(turn.id, "Codex turn id");
      const waiter = this.#turnWaiters.get(`${threadId}/${turnId}`);
      if (waiter !== undefined) {
        this.#turnWaiters.delete(`${threadId}/${turnId}`);
        waiter.resolve(turn);
      } else this.#completedTurns.set(`${threadId}/${turnId}`, turn);
      return;
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    for (const waiter of this.#turnWaiters.values()) waiter.reject(error);
    this.#pending.clear();
    this.#turnWaiters.clear();
  }
}

function lastAgentMessage(turn: JsonObject): string {
  const items = turn.items;
  if (!Array.isArray(items)) throw new Error("Completed Codex turn has no items.");
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = object(items[index], "Codex turn item");
    if (item.type === "agentMessage" && typeof item.text === "string") return item.text;
  }
  throw new Error("Completed Codex turn has no final Agent message.");
}

export function parseAttemptResult(text: string): AttemptResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Attempt result is not valid JSON.");
  }
  const result = object(value, "Attempt result");
  if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
    throw new Error("Attempt result summary is missing.");
  }
  if (result.checks !== undefined && !Array.isArray(result.checks)) {
    throw new Error("Attempt result checks must be an array.");
  }
  const checks = result.checks === undefined
    ? undefined
    : result.checks.map((value) => {
        const check = object(value, "Attempt check");
        if (
          typeof check.name !== "string"
          || check.name.trim().length === 0
          || !["passed", "failed", "skipped"].includes(String(check.outcome))
        ) {
          throw new Error("Attempt check is invalid.");
        }
        if (check.details !== undefined && typeof check.details !== "string") {
          throw new Error("Attempt check details are invalid.");
        }
        return {
          name: check.name.trim(),
          outcome: check.outcome as "passed" | "failed" | "skipped",
          ...(typeof check.details === "string" ? { details: check.details } : {})
        };
      });
  return {
    summary: result.summary.trim(),
    ...(checks === undefined ? {} : { checks })
  };
}

async function waitForSocket(
  path: string,
  child: ChildProcess
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Codex App Server exited before its control socket was ready.");
    }
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the Codex App Server control socket.");
}

async function prepareControlDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await stat(path);
  if (
    typeof process.getuid === "function"
    && typeof entry.uid === "number"
    && entry.uid !== process.getuid()
  ) {
    throw new Error("Codex App Server control directory belongs to another user.");
  }
  await chmod(path, 0o700);
}

function isErrno(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value
    && (value as { code?: unknown }).code === code;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as JsonObject;
}

function objectOrNull(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
