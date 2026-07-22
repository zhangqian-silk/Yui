import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { runtimeError } from "../errors/cliError.js";
import { handoffTerminal, type TerminalInput } from "./terminalHandoff.js";
import { CommandExecutionError, type CommandExecutor } from "./commandExecutor.js";

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_READINESS_POLL_MS = 50;

export type TmuxRole = Readonly<{
  name: string;
  workspace: string;
  status?: string;
}>;

export type TmuxLaunchPlan = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

export type TmuxPaneState = Readonly<{
  taskId: string;
  roleName: string;
  target: string;
  dead: boolean;
  pid?: number;
  currentCommand: string;
  content: string;
}>;

export type TmuxRolePaneState = Readonly<{
  taskId: string;
  roleName: string;
  target: string;
  dead: boolean;
  pid?: number;
  currentCommand: string;
}>;

export type TmuxReadinessProbe = (pane: TmuxPaneState) => boolean;

export type TmuxManagerOptions = Readonly<{
  yuiHome?: string;
  terminalInput?: TerminalInput;
  closeInteractiveInput?: () => void;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  initialColumns?: number;
  initialRows?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => void;
}>;

export type TmuxDeliveryOutcome = "sent" | "already-sent";

export class TmuxReadinessTimeoutError extends Error {
  constructor(
    readonly taskId: string,
    readonly roleName: string,
    readonly timeoutMs: number
  ) {
    super(`Role ${roleName} did not become ready within ${timeoutMs} ms.`);
    this.name = "TmuxReadinessTimeoutError";
  }
}

export class TmuxReadinessProbeRequiredError extends Error {
  constructor() {
    super("Automated tmux delivery requires an Agent-specific readiness probe.");
    this.name = "TmuxReadinessProbeRequiredError";
  }
}

/**
 * Owns tmux lifecycle and input delivery. Interactive attach first releases
 * every Yui reader from the terminal. Automated delivery is accepted only
 * after a bounded readiness probe and is recorded by a pane-local receipt.
 */
export class TmuxManager {
  readonly #yuiHome: string;
  readonly #terminalInput: TerminalInput;
  readonly #closeInteractiveInput: () => void;
  readonly #readinessTimeoutMs: number;
  readonly #readinessPollMs: number;
  readonly #initialColumns: number;
  readonly #initialRows: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => void;

  constructor(
    private readonly tmuxBin: string,
    private readonly executor: CommandExecutor,
    yuiHomeOrOptions: string | TmuxManagerOptions = {}
  ) {
    const options = typeof yuiHomeOrOptions === "string"
      ? { yuiHome: yuiHomeOrOptions }
      : yuiHomeOrOptions;
    this.#yuiHome = options.yuiHome ?? process.env.YUI_HOME ?? process.cwd();
    this.#terminalInput = options.terminalInput ?? process.stdin as Readable & TerminalInput;
    this.#closeInteractiveInput = options.closeInteractiveInput ?? (() => {});
    this.#readinessTimeoutMs = positiveInteger(
      options.readinessTimeoutMs,
      DEFAULT_READINESS_TIMEOUT_MS,
      "readiness timeout"
    );
    this.#readinessPollMs = positiveInteger(
      options.readinessPollMs,
      DEFAULT_READINESS_POLL_MS,
      "readiness poll interval"
    );
    this.#initialColumns = positiveInteger(options.initialColumns, 120, "initial tmux columns");
    this.#initialRows = positiveInteger(options.initialRows, 40, "initial tmux rows");
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? blockingSleep;
  }

  enterRole(
    taskId: string,
    role: TmuxRole,
    launch?: TmuxLaunchPlan
  ): void {
    this.ensureRoleWindow(taskId, role, launch);
    this.attachRole(taskId, role.name);
  }

  ensureRoleWindow(
    taskId: string,
    role: TmuxRole,
    launch?: TmuxLaunchPlan
  ): boolean {
    if (this.windowNames(taskId).includes(role.name)) return false;
    if (launch === undefined) {
      throw runtimeError(`Agent launch plan is required to create Role window: ${role.name}.`);
    }

    if (!this.hasSession(taskId)) {
      this.executor.run(this.tmuxBin, [
        "new-session", "-d",
        "-x", String(this.#initialColumns),
        "-y", String(this.#initialRows),
        "-s", this.sessionName(taskId),
        "-n", role.name,
        "-c", safeValue(role.workspace, "Role workspace"),
        "--",
        ...launchCommand(launch)
      ]);
    } else {
      this.executor.run(this.tmuxBin, [
        "new-window",
        "-t", this.sessionName(taskId),
        "-n", role.name,
        "-c", safeValue(role.workspace, "Role workspace"),
        "--",
        ...launchCommand(launch)
      ]);
    }
    return true;
  }

  attachRole(taskId: string, roleName: string): void {
    handoffTerminal(this.#terminalInput, this.#closeInteractiveInput);
    this.executor.run(this.tmuxBin, [
      "attach-session", "-t", this.target(taskId, roleName)
    ], { inheritStdio: true });
  }

  captureRole(taskId: string, roleName: string, lines = 80): string {
    return this.executor.run(this.tmuxBin, [
      "capture-pane", "-p", "-t", this.target(taskId, roleName), "-S", `-${lines}`
    ]);
  }

  dispatchRole(
    taskId: string,
    role: TmuxRole,
    launch: TmuxLaunchPlan,
    input: string,
    options: Readonly<{
      receiptId: string;
      readinessProbe: TmuxReadinessProbe;
      replaceExisting?: boolean;
    }>
  ): TmuxDeliveryOutcome {
    if (options.replaceExisting === true) {
      try {
        this.killRole(taskId, role.name);
      } catch (error) {
        if (!isExplicitlyAbsentTmuxSession(error)) throw error;
      }
    }
    this.ensureRoleWindow(taskId, role, launch);
    return this.sendRoleInputOnce(
      taskId,
      role.name,
      options.receiptId,
      input,
      options.readinessProbe
    );
  }

  waitUntilReady(
    taskId: string,
    roleName: string,
    readinessProbe?: TmuxReadinessProbe
  ): TmuxPaneState {
    if (readinessProbe === undefined) {
      throw new TmuxReadinessProbeRequiredError();
    }
    const start = this.#now();
    for (;;) {
      const pane = this.inspectPane(taskId, roleName);
      if (readinessProbe(pane)) return pane;
      if (this.#now() - start >= this.#readinessTimeoutMs) {
        throw new TmuxReadinessTimeoutError(taskId, roleName, this.#readinessTimeoutMs);
      }
      this.#sleep(this.#readinessPollMs);
    }
  }

  inspectPane(taskId: string, roleName: string): TmuxPaneState {
    const target = this.target(taskId, roleName);
    const output = this.executor.run(this.tmuxBin, [
      "display-message", "-p", "-t", target,
      "#{pane_dead}|#{pane_pid}|#{pane_current_command}"
    ]).trim();
    const separator = output.indexOf("|");
    const secondSeparator = separator < 0 ? -1 : output.indexOf("|", separator + 1);
    if (separator < 0 || secondSeparator < 0) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    const dead = output.slice(0, separator);
    const pidText = output.slice(separator + 1, secondSeparator);
    const currentCommand = output.slice(secondSeparator + 1);
    const pid = Number(pidText);
    const content = this.executor.run(this.tmuxBin, [
      "capture-pane", "-p", "-t", target, "-S", "-40"
    ]);
    return {
      taskId,
      roleName,
      target,
      dead: dead === "1",
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      currentCommand,
      content
    };
  }

  /** Reads every Role pane in one tmux call without capturing terminal output. */
  inspectTaskRolePanes(taskId: string): TmuxRolePaneState[] {
    const separator = "\u001f";
    let output: string;
    try {
      output = this.executor.run(this.tmuxBin, [
        "list-panes", "-s", "-t", this.sessionName(taskId), "-F",
        `#{window_name}${separator}#{pane_dead}${separator}#{pane_pid}${separator}#{pane_current_command}`
      ]);
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return [];
      throw error;
    }
    return output.split("\n").flatMap((line): TmuxRolePaneState[] => {
      if (line.length === 0) return [];
      const [roleName, deadText, pidText, currentCommand, ...extra] = line.split(separator);
      if (
        roleName === undefined
        || deadText === undefined
        || pidText === undefined
        || currentCommand === undefined
        || extra.length > 0
        || (deadText !== "0" && deadText !== "1")
      ) {
        throw runtimeError(`Tmux returned an invalid Task Role pane state for ${taskId}.`);
      }
      const pid = Number(pidText);
      return [{
        taskId,
        roleName,
        target: this.target(taskId, roleName),
        dead: deadText === "1",
        ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
        currentCommand
      }];
    });
  }

  /**
   * The receipt test, receipt write, literal input and Enter all run through a
   * single tmux server command queue. Retrying the same receipt cannot type the
   * input twice into the same pane.
   */
  sendRoleInputOnce(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe?: TmuxReadinessProbe
  ): TmuxDeliveryOutcome {
    if (readinessProbe === undefined) {
      throw new TmuxReadinessProbeRequiredError();
    }
    safeValue(receiptId, "tmux delivery receipt id");
    safeValue(input, "tmux input");
    // A delivered run is normally still busy on the next Controller scan. The
    // pane receipt is authoritative for that retry, so do not wait for the
    // composer merely to discover that the input was already sent.
    if (this.hasDeliveryReceipt(taskId, roleName, receiptId)) {
      return "already-sent";
    }
    this.waitUntilReady(taskId, roleName, readinessProbe);
    return this.sendReadyRoleInputOnce(taskId, roleName, receiptId, input);
  }

  private sendReadyRoleInputOnce(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string
  ): TmuxDeliveryOutcome {
    safeValue(receiptId, "tmux delivery receipt id");
    safeValue(input, "tmux input");
    if (this.hasDeliveryReceipt(taskId, roleName, receiptId)) {
      return "already-sent";
    }
    const target = this.target(taskId, roleName);
    const digest = createHash("sha256").update(receiptId).digest("hex");
    const option = `@yui_delivery_${digest}`;
    const sentMarker = `__YUI_DELIVERY_SENT_${digest}__`;
    const presentMarker = `__YUI_DELIVERY_PRESENT_${digest}__`;
    const apply = [
      `set-option -w -t ${tmuxWord(target)} ${option} 1`,
      `send-keys -l -t ${tmuxWord(target)} -- ${tmuxWord(input)}`,
      `send-keys -t ${tmuxWord(target)} Enter`,
      `display-message -p ${sentMarker}`
    ].join(" ; ");
    const output = this.executor.run(this.tmuxBin, [
      "if-shell", "-t", target, "-F", `#{==:#{${option}},1}`,
      `display-message -p ${presentMarker}`,
      apply
    ]).trim();
    if (output === sentMarker) return "sent";
    if (output === presentMarker) return "already-sent";
    throw runtimeError(`Tmux did not confirm delivery receipt ${receiptId}.`);
  }

  sendRoleInputOnceIfReady(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe?: TmuxReadinessProbe
  ): TmuxDeliveryOutcome | "not-ready" {
    if (readinessProbe === undefined) {
      throw new TmuxReadinessProbeRequiredError();
    }
    if (this.hasDeliveryReceipt(taskId, roleName, receiptId)) {
      return "already-sent";
    }
    if (!readinessProbe(this.inspectPane(taskId, roleName))) return "not-ready";
    return this.sendReadyRoleInputOnce(taskId, roleName, receiptId, input);
  }

  hasDeliveryReceipt(taskId: string, roleName: string, receiptId: string): boolean {
    safeValue(receiptId, "tmux delivery receipt id");
    const digest = createHash("sha256").update(receiptId).digest("hex");
    const option = `@yui_delivery_${digest}`;
    return this.executor.run(this.tmuxBin, [
      "show-options", "-wqv", "-t", this.target(taskId, roleName), option
    ]).trim() === "1";
  }

  detachRole(taskId: string): void {
    this.executor.run(this.tmuxBin, ["detach-client", "-s", this.sessionName(taskId)]);
  }

  restartRole(taskId: string, role: TmuxRole, launch: TmuxLaunchPlan): void {
    try {
      this.killRole(taskId, role.name);
    } catch (error) {
      if (!isExplicitlyAbsentTmuxSession(error)) throw error;
    }
    this.enterRole(taskId, role, launch);
  }

  detectRoleStatus(
    taskId: string,
    roleName: string,
    fallback: string = "exited"
  ): string {
    try {
      return this.probeRoleStatus(taskId, roleName);
    } catch {
      return fallback;
    }
  }

  probeRoleStatus(taskId: string, roleName: string): "running" | "exited" {
    if (!this.hasSession(taskId)) return "exited";
    return this.windowNames(taskId).includes(roleName) ? "running" : "exited";
  }

  stopTask(taskId: string): boolean {
    if (!this.hasSession(taskId)) return false;
    this.executor.run(this.tmuxBin, ["kill-session", "-t", this.sessionName(taskId)]);
    return true;
  }

  stopRole(taskId: string, roleName: string): void {
    this.executor.run(this.tmuxBin, ["send-keys", "-t", this.target(taskId, roleName), "C-c"]);
  }

  killRole(taskId: string, roleName: string): void {
    this.executor.run(this.tmuxBin, ["kill-window", "-t", this.target(taskId, roleName)]);
  }

  renameRole(taskId: string, oldRoleName: string, newRoleName: string): void {
    this.executor.run(this.tmuxBin, [
      "rename-window", "-t", this.target(taskId, oldRoleName), safeValue(newRoleName, "Role name")
    ]);
  }

  private hasSession(taskId: string): boolean {
    try {
      this.executor.run(this.tmuxBin, ["has-session", "-t", this.sessionName(taskId)]);
      return true;
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return false;
      // Older/fake executors do not expose stderr. A failed has-session is the
      // tmux absence contract; other operations remain strict.
      if (!(error instanceof CommandExecutionError)) return false;
      throw error;
    }
  }

  private windowNames(taskId: string): string[] {
    if (!this.hasSession(taskId)) return [];
    return this.executor.run(this.tmuxBin, [
      "list-windows", "-t", this.sessionName(taskId), "-F", "#{window_name}"
    ]).split("\n").map((name) => name.trim()).filter(Boolean);
  }

  private sessionName(taskId: string): string {
    return yuiTmuxSessionName(this.#yuiHome, taskId);
  }

  private target(taskId: string, roleName: string): string {
    return yuiTmuxTarget(this.#yuiHome, taskId, roleName);
  }
}

export type TmuxDelivery = Readonly<{
  taskId: string;
  roleName: string;
  receiptId: string;
  input: string;
  readinessProbe: TmuxReadinessProbe;
}>;

export type TmuxSendOncePort = Pick<TmuxManager, "sendRoleInputOnce">;

/** A small FIFO boundary for Controller scheduler passes. */
export class TmuxDeliveryPump {
  readonly #queue: TmuxDelivery[] = [];

  constructor(private readonly tmux: TmuxSendOncePort) {}

  get pending(): number {
    return this.#queue.length;
  }

  enqueue(delivery: TmuxDelivery): void {
    this.#queue.push(delivery);
  }

  pump(limit = Number.POSITIVE_INFINITY): Array<{
    receiptId: string;
    outcome: TmuxDeliveryOutcome;
  }> {
    if (!(limit === Number.POSITIVE_INFINITY || Number.isSafeInteger(limit) && limit > 0)) {
      throw new TypeError("tmux delivery pump limit must be a positive integer");
    }
    const completed: Array<{ receiptId: string; outcome: TmuxDeliveryOutcome }> = [];
    while (this.#queue.length > 0 && completed.length < limit) {
      const delivery = this.#queue[0]!;
      const outcome = this.tmux.sendRoleInputOnce(
        delivery.taskId,
        delivery.roleName,
        delivery.receiptId,
        delivery.input,
        delivery.readinessProbe
      );
      this.#queue.shift();
      completed.push({ receiptId: delivery.receiptId, outcome });
    }
    return completed;
  }
}

export function yuiTmuxSessionName(yuiHome: string, taskId: string): string {
  const safeTaskId = safeValue(taskId, "Task id");
  const namespace = createHash("sha256").update(resolve(yuiHome)).digest("hex").slice(0, 12);
  return `yui-${namespace}-${safeTaskId}`;
}

export function yuiTmuxTarget(yuiHome: string, taskId: string, roleName: string): string {
  return `${yuiTmuxSessionName(yuiHome, taskId)}:${safeValue(roleName, "Role name")}`;
}

function launchCommand(launch: TmuxLaunchPlan): string[] {
  const command = safeValue(launch.command, "Agent command");
  const args = launch.args.map((arg) => safeValue(arg, "Agent argument"));
  const environment = Object.entries(launch.env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new TypeError(`Invalid Agent environment variable: ${key}`);
    }
    return `${key}=${safeValue(value, `Agent environment ${key}`)}`;
  });
  return environment.length === 0
    ? [command, ...args]
    : ["env", ...environment, command, ...args];
}

function isExplicitlyAbsentTmuxSession(error: unknown): boolean {
  if (!(error instanceof CommandExecutionError)) return false;
  return /can't find (?:session|window|pane)|no server running|error connecting to .+ \(No such file or directory\)/i
    .test(error.stderr);
}

function tmuxWord(value: string): string {
  return JSON.stringify(value);
}

function safeValue(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be non-empty and contain no NUL bytes`);
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return resolved;
}

function blockingSleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
