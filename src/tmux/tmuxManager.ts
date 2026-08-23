import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { runtimeError } from "../errors/cliError.js";
import { usableInteractiveTerminal } from "../output/terminal.js";
import { handoffTerminal, type TerminalInput } from "./terminalHandoff.js";
import {
  CommandExecutionError,
  type CommandExecutor,
  type CommandRunOptions
} from "./commandExecutor.js";

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_READINESS_POLL_MS = 50;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_HISTORY_LIMIT = 100_000;
const PANE_STATE_MARKER = "__YUI_PANE_STATE__";
const WRITABLE_CLIENT_SESSION_PREFIX = "yui-writer-";
const HOST_WRITABLE_CLIENT_SESSION_PREFIX = `${WRITABLE_CLIENT_SESSION_PREFIX}host-`;
const ROLE_WRITABLE_CLIENT_SESSION_PREFIX = `${WRITABLE_CLIENT_SESSION_PREFIX}role-`;

export type TmuxRole = Readonly<{
  name: string;
  workspace: string;
  /** Native process cwd; workspace remains the durable Yui scope root. */
  cwd?: string;
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
  deadStatus?: number;
  pid?: number;
  currentCommand: string;
  exitStatus?: number;
  cursorX?: number;
  cursorY?: number;
  historySize?: number;
}>;

export type TmuxRolePaneState = Readonly<{
  taskId: string;
  roleName: string;
  target: string;
  dead: boolean;
  deadStatus?: number;
  pid?: number;
  currentCommand: string;
  exitStatus?: number;
}>;

export type TmuxRoleHistory = Readonly<{
  actual: number;
  configured: number;
  limited: boolean;
}>;

export type TmuxReadinessProbe = (pane: TmuxPaneState) => boolean;
export type TmuxAttachAccess = "auto" | "read-only" | "read-write";
export type TmuxAttachOptions = Readonly<{
  /** Runs after the writer lease is visible, immediately before terminal handoff. */
  revalidateWritableAttach?: () => void;
}>;

export type TmuxManagerOptions = Readonly<{
  yuiHome?: string;
  /** Records exact Yui Role pane targets for an explicitly fenced domain. */
  onRoleTargetRecorded?: (target: string) => void;
  terminalInput?: TerminalInput;
  terminalType?: string;
  closeInteractiveInput?: () => void;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  initialColumns?: number;
  initialRows?: number;
  historyLimit?: number;
  onWarning?: (message: string) => void;
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
  readonly #serverName: string;
  readonly #onRoleTargetRecorded: ((target: string) => void) | undefined;
  readonly #terminalInput: TerminalInput;
  readonly #terminalType: string;
  readonly #closeInteractiveInput: () => void;
  readonly #readinessTimeoutMs: number;
  readonly #readinessPollMs: number;
  readonly #initialColumns: number;
  readonly #initialRows: number;
  readonly #historyLimit: number;
  readonly #onWarning: ((message: string) => void) | undefined;
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
    this.#serverName = yuiTmuxServerName(this.#yuiHome);
    this.#onRoleTargetRecorded = options.onRoleTargetRecorded;
    this.#terminalInput = options.terminalInput ?? process.stdin as Readable & TerminalInput;
    this.#terminalType = usableInteractiveTerminal(options.terminalType ?? process.env.TERM);
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
    this.#historyLimit = positiveInteger(
      options.historyLimit,
      DEFAULT_HISTORY_LIMIT,
      "tmux history limit"
    );
    this.#onWarning = options.onWarning;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? blockingSleep;
  }

  enterRole(
    taskId: string,
    role: TmuxRole,
    launch?: TmuxLaunchPlan
  ): void {
    this.ensureRoleWindow(taskId, role, launch);
    this.attachRole(taskId, role.name, "auto");
  }

  ensureRoleWindow(
    taskId: string,
    role: TmuxRole,
    launch?: TmuxLaunchPlan
  ): boolean {
    if (this.windowNames(taskId).includes(role.name)) {
      this.recordRoleTarget(taskId, role.name);
      this.configureServerHistory();
      this.configureRoleWindowSizing(taskId, role.name);
      return false;
    }
    if (launch === undefined) {
      throw runtimeError(`Agent launch plan is required to create Role window: ${role.name}.`);
    }

    // Persist the exact target before any tmux mutation. If the recorder
    // cannot prove the current ephemeral identity/token, do not create a
    // pane that a later reaper could not fence.
    this.recordRoleTarget(taskId, role.name);
    if (!this.hasSession(taskId)) {
      this.run([
        "start-server",
        ";",
        "set-option", "-g", "history-limit", String(this.#historyLimit),
        ";",
        "set-option", "-g", "remain-on-exit", "on",
        ";",
        "new-session", "-d",
        "-x", String(this.#initialColumns),
        "-y", String(this.#initialRows),
        "-s", this.sessionName(taskId),
        "-n", role.name,
        "-c", safeValue(role.cwd ?? role.workspace, "Role cwd"),
        "--",
        ...launchCommand(launch)
      ]);
    } else {
      this.configureServerHistory();
      this.run(["set-option", "-g", "remain-on-exit", "on"]);
      this.run([
        "new-window",
        "-t", this.sessionName(taskId),
        "-n", role.name,
        "-c", safeValue(role.cwd ?? role.workspace, "Role cwd"),
        "--",
        ...launchCommand(launch)
      ]);
    }
    this.configureRoleWindowSizing(taskId, role.name);
    return true;
  }

  async ensureRoleWindowAsync(
    taskId: string,
    role: TmuxRole,
    launch?: TmuxLaunchPlan
  ): Promise<boolean> {
    const snapshot = await this.sessionWindowNamesAsync(taskId);
    if (snapshot.names.includes(role.name)) {
      this.recordRoleTarget(taskId, role.name);
      await this.configureServerHistoryAsync();
      await this.configureRoleWindowSizingAsync(taskId, role.name);
      return false;
    }
    if (launch === undefined) {
      throw runtimeError(`Agent launch plan is required to create Role window: ${role.name}.`);
    }
    // Keep the async launch ordering identical to the sync path: a recorder
    // failure is a precondition failure, never a post-launch cleanup hint.
    this.recordRoleTarget(taskId, role.name);
    if (!snapshot.exists) {
      await this.runAsync([
        "start-server",
        ";",
        "set-option", "-g", "history-limit", String(this.#historyLimit),
        ";",
        "set-option", "-g", "remain-on-exit", "on",
        ";",
        "new-session", "-d",
        "-x", String(this.#initialColumns),
        "-y", String(this.#initialRows),
        "-s", this.sessionName(taskId),
        "-n", role.name,
        "-c", safeValue(role.cwd ?? role.workspace, "Role cwd"),
        "--",
        ...launchCommand(launch)
      ]);
    } else {
      await this.configureServerHistoryAsync();
      await this.runAsync(["set-option", "-g", "remain-on-exit", "on"]);
      await this.runAsync([
        "new-window",
        "-t", this.sessionName(taskId),
        "-n", role.name,
        "-c", safeValue(role.cwd ?? role.workspace, "Role cwd"),
        "--",
        ...launchCommand(launch)
      ]);
    }
    await this.configureRoleWindowSizingAsync(taskId, role.name);
    return true;
  }

  attachRole(
    taskId: string,
    roleName: string,
    access: TmuxAttachAccess,
    options: TmuxAttachOptions = {}
  ): "read-only" | "read-write" {
    if (access !== "auto" && access !== "read-only" && access !== "read-write") {
      throw runtimeError("Tmux attach access must be auto, read-only, or read-write.");
    }
    let historyNotice: string | undefined;
    if (this.#onWarning !== undefined) {
      const history = this.inspectRoleHistory(taskId, roleName);
      if (history.limited) {
        historyNotice = roleHistoryWarning(history);
        this.#onWarning(historyNotice);
      }
    }
    let resolvedAccess: "read-only" | "read-write" = access === "read-only"
      ? "read-only"
      : "read-write";
    // Automatic entry is used by global Roles and retains one writer for the
    // whole tmux host. Explicit Task write access is scoped to the selected
    // Role so a human in one pane cannot pause unrelated Role launches.
    const writerRoleName = access === "read-write" ? roleName : undefined;
    let clientSession = this.createInteractiveClientSession(
      taskId,
      historyNotice,
      resolvedAccess,
      writerRoleName
    );
    try {
      if (
        resolvedAccess === "read-write"
        && this.hasWritableClient(taskId, writerRoleName, clientSession)
      ) {
        if (access !== "auto") {
          throw runtimeError(
            `A writable tmux client is already attached to ${taskId}; use read-only access.`
          );
        }
        this.destroyInteractiveClientSession(clientSession);
        resolvedAccess = "read-only";
        clientSession = this.createInteractiveClientSession(
          taskId,
          historyNotice,
          resolvedAccess
        );
      }
      if (resolvedAccess === "read-write") options.revalidateWritableAttach?.();
      handoffTerminal(this.#terminalInput, this.#closeInteractiveInput);
      this.run([
        "attach-session",
        ...(resolvedAccess === "read-only" ? ["-r"] : []),
        "-t", `${clientSession}:${safeValue(roleName, "Role name")}`
      ], {
        inheritStdio: true,
        environment: { TERM: this.#terminalType }
      });
      return resolvedAccess;
    } finally {
      this.destroyInteractiveClientSession(clientSession);
    }
  }

  /**
   * A grouped session shares the Agent windows while keeping the selected
   * window and terminal options local to this one human client.
   */
  createInteractiveClientSession(
    taskId: string,
    attachedNotice?: string,
    access: Exclude<TmuxAttachAccess, "auto"> = "read-only",
    writerRoleName?: string
  ): string {
    const prefix = access === "read-write"
      ? writableClientSessionPrefix(writerRoleName)
      : "yui-client-";
    const clientSession = `${prefix}${randomBytes(12).toString("hex")}`;
    this.run([
      "new-session", "-d",
      "-t", this.sessionName(taskId),
      "-s", clientSession
    ]);
    try {
      // Let tmux use the outer terminal's native alternate screen. Mouse mode
      // keeps scrollback inside the long-lived Role pane instead of mixing it
      // with terminal output that predates this attach.
      this.run(["set-option", "-t", clientSession, "status", "off"]);
      this.run(["set-option", "-t", clientSession, "mouse", "on"]);
      this.run([
        "set-hook", "-t", clientSession, "client-detached",
        `kill-session -t ${clientSession}`
      ]);
      if (attachedNotice !== undefined) {
        this.run([
          "set-hook", "-t", clientSession, "client-attached",
          `display-message -d 10000 ${tmuxWord(attachedNotice)}`
        ]);
      }
      return clientSession;
    } catch (error) {
      this.destroyInteractiveClientSession(clientSession);
      throw error;
    }
  }

  destroyInteractiveClientSession(clientSession: string): void {
    try {
      this.run(["kill-session", "-t", safeValue(clientSession, "tmux client session")]);
    } catch (error) {
      if (!isExplicitlyAbsentTmuxSession(error)) throw error;
    }
  }

  inspectRoleHistory(taskId: string, roleName: string): TmuxRoleHistory {
    const output = this.run([
      "display-message", "-p",
      "-t", this.target(taskId, roleName),
      "#{history_limit}"
    ]).trim();
    const actual = Number(output);
    if (!Number.isSafeInteger(actual) || actual <= 0) {
      throw runtimeError(`Tmux returned an invalid history limit for ${taskId}/${roleName}.`);
    }
    return {
      actual,
      configured: this.#historyLimit,
      limited: actual < this.#historyLimit
    };
  }

  /** Multiple viewers are safe, but one pane may have only one writer. */
  hasWritableClient(
    taskId: string,
    roleName?: string,
    excludedLease?: string
  ): boolean {
    if (this.taskSessionGroupNames(taskId).some((sessionName) => (
      sessionName !== excludedLease
      && writableLeaseMatchesRole(sessionName, roleName)
    ))) {
      return true;
    }
    const formatSeparator = "\u001f";
    const encodedSeparator = "\\037";
    const taskSession = this.sessionName(taskId);
    try {
      const clients = this.run([
        "list-clients",
        "-F",
        `#{session_name}${formatSeparator}#{session_group}${formatSeparator}#{client_readonly}`
      ]);
      return writableClientRowsContainMatch(
        clients,
        taskSession,
        roleName,
        excludedLease,
        formatSeparator,
        encodedSeparator
      );
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return false;
      throw error;
    }
  }

  async hasWritableClientAsync(
    taskId: string,
    roleName?: string,
    excludedLease?: string
  ): Promise<boolean> {
    if ((await this.taskSessionGroupNamesAsync(taskId)).some((sessionName) => (
      sessionName !== excludedLease
      && writableLeaseMatchesRole(sessionName, roleName)
    ))) {
      return true;
    }
    const formatSeparator = "\u001f";
    const encodedSeparator = "\\037";
    const taskSession = this.sessionName(taskId);
    try {
      const clients = await this.runAsync([
        "list-clients",
        "-F",
        `#{session_name}${formatSeparator}#{session_group}${formatSeparator}#{client_readonly}`
      ]);
      return writableClientRowsContainMatch(
        clients,
        taskSession,
        roleName,
        excludedLease,
        formatSeparator,
        encodedSeparator
      );
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return false;
      throw error;
    }
  }

  captureRole(taskId: string, roleName: string, lines = 80): string {
    return this.run([
      "capture-pane", "-p", "-t", this.target(taskId, roleName), "-S", `-${lines}`
    ]);
  }

  captureRolePane(taskId: string, roleName: string, lines = 80): string {
    return this.captureRole(taskId, roleName, lines);
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
    const output = this.run([
      "display-message", "-p", "-t", target,
      [
        "#{pane_dead}",
        "#{pane_pid}",
        "#{pane_current_command}",
        "#{pane_dead_status}"
      ].join("|")
    ]).trim();
    const separator = output.indexOf("|");
    const secondSeparator = separator < 0 ? -1 : output.indexOf("|", separator + 1);
    const lastSeparator = secondSeparator < 0 ? -1 : output.lastIndexOf("|");
    if (separator < 0 || secondSeparator < 0 || lastSeparator <= secondSeparator) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    const dead = output.slice(0, separator);
    const pidText = output.slice(separator + 1, secondSeparator);
    const currentCommand = output.slice(secondSeparator + 1, lastSeparator);
    const exitStatusText = output.slice(lastSeparator + 1);
    const pid = Number(pidText);
    const exitStatus = nonNegativeNumber(exitStatusText);
    return {
      taskId,
      roleName,
      target,
      dead: dead === "1",
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      currentCommand,
      ...(dead === "1" && exitStatus !== undefined ? { exitStatus } : {})
    };
  }

  async inspectPaneAsync(taskId: string, roleName: string): Promise<TmuxPaneState> {
    return (await this.inspectDeliveryPaneAsync(taskId, roleName)).pane;
  }

  /** Reads receipt and pane identity through one tmux client without terminal output. */
  private async inspectDeliveryPaneAsync(
    taskId: string,
    roleName: string,
    receiptId?: string
  ): Promise<Readonly<{ pane: TmuxPaneState; receiptPresent: boolean }>> {
    const target = this.target(taskId, roleName);
    const receiptOption = receiptId === undefined
      ? undefined
      : deliveryReceiptOption(receiptId);
    const receiptFormat = receiptOption === undefined ? "" : `#{${receiptOption}}`;
    const output = await this.runAsync([
      "display-message", "-p", "-t", target,
      [
        PANE_STATE_MARKER,
        "#{pane_dead}",
        "#{pane_pid}",
        "#{cursor_x}",
        "#{cursor_y}",
        "#{history_size}",
        "#{pane_current_command}",
        "#{pane_dead_status}",
        receiptFormat
      ].join("|")
    ]);
    const normalizedOutput = output.trimEnd();
    const fieldSeparators = [...normalizedOutput.matchAll(/\|/g)].map((match) => match.index);
    const lastSeparator = fieldSeparators.at(-1);
    const exitSeparator = fieldSeparators.at(-2);
    if (
      fieldSeparators.length < 8
      || lastSeparator === undefined
      || exitSeparator === undefined
      || !normalizedOutput.startsWith(PANE_STATE_MARKER)
    ) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    const [markerEnd, deadEnd, pidEnd, cursorXEnd, cursorYEnd, historyEnd] =
      fieldSeparators;
    const receiptSeparator = lastSeparator;
    const deadText = normalizedOutput.slice(markerEnd! + 1, deadEnd!);
    const pidText = normalizedOutput.slice(deadEnd! + 1, pidEnd!);
    const cursorXText = normalizedOutput.slice(pidEnd! + 1, cursorXEnd!);
    const cursorYText = normalizedOutput.slice(cursorXEnd! + 1, cursorYEnd!);
    const historySizeText = normalizedOutput.slice(cursorYEnd! + 1, historyEnd!);
    const currentCommand = normalizedOutput.slice(historyEnd! + 1, exitSeparator);
    const exitStatusText = normalizedOutput.slice(exitSeparator + 1, receiptSeparator);
    const receiptText = normalizedOutput.slice(receiptSeparator + 1);
    if (!normalizedOutput.slice(0, markerEnd!).startsWith(PANE_STATE_MARKER)) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    if (
      (deadText !== "0" && deadText !== "1")
      || currentCommand === undefined
      || receiptText === undefined
      || (receiptText !== "" && receiptText !== "1")
    ) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    const pid = positiveNumber(pidText);
    const cursorX = nonNegativeNumber(cursorXText);
    const cursorY = nonNegativeNumber(cursorYText);
    const historySize = nonNegativeNumber(historySizeText);
    const exitStatus = nonNegativeNumber(exitStatusText);
    if (cursorX === undefined || cursorY === undefined || historySize === undefined) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    return {
      pane: {
        taskId,
        roleName,
        target,
        dead: deadText === "1",
        ...(pid === undefined ? {} : { pid }),
        currentCommand,
        ...(deadText === "1" && exitStatus !== undefined ? { exitStatus } : {}),
        cursorX,
        cursorY,
        historySize
      },
      receiptPresent: receiptText === "1"
    };
  }

  /** Reads every Role pane in one tmux call without capturing terminal output. */
  inspectTaskRolePanes(taskId: string): TmuxRolePaneState[] {
    const formatSeparator = "\u001f";
    // tmux escapes control bytes in formatted output using backslash-octal
    // notation, so an argv separator of 0x1f is returned as the four
    // printable characters "\\037". Accept the raw form as well for test
    // executors and older implementations that do not escape it.
    const encodedSeparator = "\\037";
    let output: string;
    try {
      output = this.run([
        "list-panes", "-s", "-t", this.sessionName(taskId), "-F",
        `#{window_name}${formatSeparator}#{pane_dead}${formatSeparator}#{pane_dead_status}${formatSeparator}#{pane_pid}${formatSeparator}#{pane_current_command}`
      ]);
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return [];
      throw error;
    }
    return output.split("\n").flatMap((line): TmuxRolePaneState[] => {
      if (line.length === 0) return [];
      const separator = line.includes(encodedSeparator) ? encodedSeparator : formatSeparator;
      const [roleName, deadText, deadStatusText, pidText, currentCommand, ...extra] = line.split(separator);
      if (
        roleName === undefined
        || deadText === undefined
        || deadStatusText === undefined
        || pidText === undefined
        || currentCommand === undefined
        || extra.length > 0
        || (deadText !== "0" && deadText !== "1")
      ) {
        throw runtimeError(`Tmux returned an invalid Task Role pane state for ${taskId}.`);
      }
      const pid = Number(pidText);
      const deadStatus = Number(deadStatusText);
      return [{
        taskId,
        roleName,
        target: this.target(taskId, roleName),
        dead: deadText === "1",
        ...(Number.isSafeInteger(deadStatus) && deadStatus >= 0 ? { deadStatus } : {}),
        ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
        currentCommand
      }];
    });
  }

  /**
   * Reads the Role pane inventory for this YUI_HOME in one tmux server call.
   * Terminal contents are deliberately excluded; recovery can inspect process
   * identity later for the small set of suspicious panes.
   */
  inspectRolePaneInventory(): TmuxRolePaneState[] {
    const formatSeparator = "\u001f";
    const encodedSeparator = "\\037";
    const sessionPrefix = yuiTmuxSessionPrefix(this.#yuiHome);
    let output: string;
    try {
      output = this.run([
        "list-panes", "-a", "-F",
        [
          "#{session_name}",
          "#{window_name}",
          "#{pane_dead}",
          "#{pane_dead_status}",
          "#{pane_pid}",
          "#{pane_current_command}"
        ].join(formatSeparator)
      ]);
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return [];
      throw error;
    }

    return output.split("\n").flatMap((line): TmuxRolePaneState[] => {
      if (line.length === 0) return [];
      const separator = line.includes(encodedSeparator) ? encodedSeparator : formatSeparator;
      const [
        sessionName,
        roleName,
        deadText,
        deadStatusText,
        pidText,
        currentCommand,
        ...extra
      ] = line.split(separator);
      if (
        sessionName === undefined
        || roleName === undefined
        || deadText === undefined
        || deadStatusText === undefined
        || pidText === undefined
        || currentCommand === undefined
        || extra.length > 0
        || (deadText !== "0" && deadText !== "1")
      ) {
        throw runtimeError("Tmux returned an invalid Role pane inventory row.");
      }
      if (!sessionName.startsWith(sessionPrefix)) return [];
      const taskId = sessionName.slice(sessionPrefix.length);
      if (taskId.length === 0 || roleName.length === 0) {
        throw runtimeError("Tmux returned an invalid Yui Role pane identity.");
      }
      const pid = Number(pidText);
      const deadStatus = Number(deadStatusText);
      return [{
        taskId,
        roleName,
        target: this.target(taskId, roleName),
        dead: deadText === "1",
        ...(Number.isSafeInteger(deadStatus) && deadStatus >= 0 ? { deadStatus } : {}),
        ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
        currentCommand
      }];
    });
  }

  async inspectRolePaneInventoryAsync(): Promise<TmuxRolePaneState[]> {
    const formatSeparator = "\u001f";
    const encodedSeparator = "\\037";
    const sessionPrefix = yuiTmuxSessionPrefix(this.#yuiHome);
    let output: string;
    try {
      output = await this.runAsync([
        "list-panes", "-a", "-F",
        [
          "#{session_name}",
          "#{window_name}",
          "#{pane_dead}",
          "#{pane_dead_status}",
          "#{pane_pid}",
          "#{pane_current_command}"
        ].join(formatSeparator)
      ]);
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return [];
      throw error;
    }
    return parseRolePaneInventory(
      output,
      formatSeparator,
      encodedSeparator,
      sessionPrefix,
      (taskId, roleName) => this.target(taskId, roleName)
    );
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
    // pane receipt is authoritative for that retry, so return before another
    // process-readiness check when the input was already sent.
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
    const buffer = `yui_delivery_${digest}`;
    const sentMarker = `__YUI_DELIVERY_SENT_${digest}__`;
    const presentMarker = `__YUI_DELIVERY_PRESENT_${digest}__`;
    const alreadyApplied = [
      `delete-buffer -b ${buffer}`,
      `display-message -p ${presentMarker}`
    ].join(" ; ");
    const apply = [
      // One bracketed paste preserves literal and multiline input without
      // expanding it into a long sequence of tmux key events.
      `paste-buffer -dpr -b ${buffer} -t ${tmuxWord(target)}`,
      // Full-screen clients can finish handling the bracketed paste after tmux
      // has already queued the next key. Let the client settle before Enter so
      // the receipt proves that a submission key followed the completed paste.
      `run-shell ${tmuxWord("sleep 0.05")}`,
      `send-keys -t ${tmuxWord(target)} Enter`,
      // A receipt is proof that Enter was accepted, never merely that an
      // attempt began.
      `set-option -w -t ${tmuxWord(target)} ${option} 1`,
      `display-message -p ${sentMarker}`
    ].join(" ; ");
    try {
      const output = this.run([
        "set-buffer", "-b", buffer, "--", input,
        ";",
        "if-shell", "-t", target, "-F", `#{==:#{${option}},1}`,
        alreadyApplied,
        apply
      ]).trim();
      if (output === sentMarker) return "sent";
      if (output === presentMarker) return "already-sent";
      throw runtimeError(`Tmux did not confirm delivery receipt ${receiptId}.`);
    } catch (error) {
      try {
        this.run(["delete-buffer", "-b", buffer]);
      } catch {
        // The apply branch normally consumed it with paste-buffer -d.
      }
      throw error;
    }
  }

  private async sendReadyRoleInputOnceAsync(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    expectedPane?: TmuxPaneState
  ): Promise<TmuxDeliveryOutcome | "not-ready"> {
    safeValue(receiptId, "tmux delivery receipt id");
    safeValue(input, "tmux input");
    const target = this.target(taskId, roleName);
    const digest = createHash("sha256").update(receiptId).digest("hex");
    const option = deliveryReceiptOption(receiptId);
    const buffer = `yui_delivery_${digest}`;
    const sentMarker = `__YUI_DELIVERY_SENT_${digest}__`;
    const presentMarker = `__YUI_DELIVERY_PRESENT_${digest}__`;
    const notReadyMarker = `__YUI_DELIVERY_NOT_READY_${digest}__`;
    const alreadyApplied = [
      `delete-buffer -b ${buffer}`,
      `display-message -p ${presentMarker}`
    ].join(" ; ");
    const apply = [
      `paste-buffer -dpr -b ${buffer} -t ${tmuxWord(target)}`,
      `run-shell ${tmuxWord("sleep 0.05")}`,
      `send-keys -t ${tmuxWord(target)} Enter`,
      `set-option -w -t ${tmuxWord(target)} ${option} 1`,
      `display-message -p ${sentMarker}`
    ].join(" ; ");
    const guard = expectedPane === undefined ? undefined : deliveryPaneGuard(expectedPane);
    const applyIfUnchanged = guard === undefined
      ? apply
      : [
          "if-shell -t",
          tmuxWord(target),
          "-F",
          tmuxWord(guard),
          tmuxWord(apply),
          tmuxWord([
            `delete-buffer -b ${buffer}`,
            `display-message -p ${notReadyMarker}`
          ].join(" ; "))
        ].join(" ");
    try {
      const output = (await this.runAsync([
        "set-buffer", "-b", buffer, "--", input,
        ";",
        "if-shell", "-t", target, "-F", `#{==:#{${option}},1}`,
        alreadyApplied,
        applyIfUnchanged
      ])).trim();
      if (output === sentMarker) return "sent";
      if (output === presentMarker) return "already-sent";
      if (output === notReadyMarker) return "not-ready";
      throw runtimeError(`Tmux did not confirm delivery receipt ${receiptId}.`);
    } catch (error) {
      try {
        await this.runAsync(["delete-buffer", "-b", buffer]);
      } catch {
        // The apply branch normally consumed it with paste-buffer -d.
      }
      throw error;
    }
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

  async sendRoleInputOnceIfReadyAsync(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe?: TmuxReadinessProbe
  ): Promise<TmuxDeliveryOutcome | "not-ready" | "unavailable"> {
    if (readinessProbe === undefined) {
      throw new TmuxReadinessProbeRequiredError();
    }
    let inspected: Readonly<{ pane: TmuxPaneState; receiptPresent: boolean }>;
    try {
      inspected = await this.inspectDeliveryPaneAsync(taskId, roleName, receiptId);
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return "unavailable";
      throw error;
    }
    if (inspected.receiptPresent) return "already-sent";
    if (!readinessProbe(inspected.pane)) return "not-ready";
    return this.sendReadyRoleInputOnceAsync(
      taskId,
      roleName,
      receiptId,
      input,
      inspected.pane
    );
  }

  hasDeliveryReceipt(taskId: string, roleName: string, receiptId: string): boolean {
    safeValue(receiptId, "tmux delivery receipt id");
    const digest = createHash("sha256").update(receiptId).digest("hex");
    const option = `@yui_delivery_${digest}`;
    return this.run([
      "show-options", "-wqv", "-t", this.target(taskId, roleName), option
    ]).trim() === "1";
  }

  async hasDeliveryReceiptAsync(
    taskId: string,
    roleName: string,
    receiptId: string
  ): Promise<boolean> {
    safeValue(receiptId, "tmux delivery receipt id");
    const option = deliveryReceiptOption(receiptId);
    return (await this.runAsync([
      "show-options", "-wqv", "-t", this.target(taskId, roleName), option
    ])).trim() === "1";
  }

  detachRole(taskId: string): void {
    this.run(["detach-client", "-s", this.sessionName(taskId)]);
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

  async probeRoleStatusAsync(
    taskId: string,
    roleName: string
  ): Promise<"running" | "exited"> {
    const snapshot = await this.sessionWindowNamesAsync(taskId);
    return snapshot.names.includes(roleName) ? "running" : "exited";
  }

  /** Exact pane process state for one Role, used by owner-identity recording. */
  inspectRolePane(
    taskId: string,
    roleName: string
  ): Readonly<{
    pid?: number;
    target: string;
    dead: boolean;
    currentCommand: string;
    exitStatus?: number;
  }> {
    const pane = this.inspectPane(taskId, roleName);
    return {
      ...(pane.pid === undefined ? {} : { pid: pane.pid }),
      target: pane.target,
      dead: pane.dead,
      currentCommand: pane.currentCommand,
      ...(pane.exitStatus === undefined ? {} : { exitStatus: pane.exitStatus })
    };
  }

  async inspectRolePaneAsync(
    taskId: string,
    roleName: string
  ): Promise<Readonly<{
    pid?: number;
    target: string;
    dead: boolean;
    currentCommand: string;
    exitStatus?: number;
  }>> {
    const pane = await this.inspectPaneAsync(taskId, roleName);
    return {
      ...(pane.pid === undefined ? {} : { pid: pane.pid }),
      target: pane.target,
      dead: pane.dead,
      currentCommand: pane.currentCommand,
      ...(pane.exitStatus === undefined ? {} : { exitStatus: pane.exitStatus })
    };
  }

  stopTask(taskId: string): boolean {
    const taskSession = this.sessionName(taskId);
    const sessions = this.taskSessionGroupNames(taskId);
    if (sessions.length === 0 && !this.hasSession(taskId)) return false;
    this.recordTaskTargets(taskId);
    for (const session of [...sessions.filter((name) => name !== taskSession), taskSession]) {
      try {
        this.run(["kill-session", "-t", session]);
      } catch (error) {
        if (!isExplicitlyAbsentTmuxSession(error)) throw error;
      }
    }
    return true;
  }

  async stopTaskAsync(taskId: string): Promise<boolean> {
    const taskSession = this.sessionName(taskId);
    const sessions = await this.taskSessionGroupNamesAsync(taskId);
    if (sessions.length === 0 && !(await this.hasSessionAsync(taskId))) return false;
    await this.recordTaskTargetsAsync(taskId);
    for (const session of [...sessions.filter((name) => name !== taskSession), taskSession]) {
      try {
        await this.runAsync(["kill-session", "-t", session]);
      } catch (error) {
        if (!isExplicitlyAbsentTmuxSession(error)) throw error;
      }
    }
    return true;
  }

  stopRole(taskId: string, roleName: string): void {
    this.recordRoleTarget(taskId, roleName);
    this.run(["send-keys", "-t", this.target(taskId, roleName), "C-c"]);
  }

  killRole(taskId: string, roleName: string): void {
    this.recordRoleTarget(taskId, roleName);
    this.run(["kill-window", "-t", this.target(taskId, roleName)]);
  }

  async killRoleAsync(taskId: string, roleName: string): Promise<void> {
    this.recordRoleTarget(taskId, roleName);
    await this.runAsync(["kill-window", "-t", this.target(taskId, roleName)]);
  }

  renameRole(taskId: string, oldRoleName: string, newRoleName: string): void {
    const target = this.target(taskId, oldRoleName);
    const nextRoleName = safeValue(newRoleName, "Role name");
    // Retain the new exact fence even if tmux later rejects the rename. The
    // stale fence is conservative and lets a later bounded retry revalidate
    // the pane instead of guessing or dropping ownership evidence.
    this.recordRoleTarget(taskId, newRoleName);
    this.run([
      "rename-window", "-t", target, nextRoleName
    ]);
  }

  private hasSession(taskId: string): boolean {
    try {
      this.run(["has-session", "-t", this.sessionName(taskId)]);
      return true;
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return false;
      // Older/fake executors do not expose stderr. A failed has-session is the
      // tmux absence contract; other operations remain strict.
      if (!(error instanceof CommandExecutionError)) return false;
      throw error;
    }
  }

  private async hasSessionAsync(taskId: string): Promise<boolean> {
    try {
      await this.runAsync(["has-session", "-t", this.sessionName(taskId)]);
      return true;
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return false;
      if (!(error instanceof CommandExecutionError)) return false;
      throw error;
    }
  }

  private windowNames(taskId: string): string[] {
    if (!this.hasSession(taskId)) return [];
    try {
      return this.run([
        "list-windows", "-t", this.sessionName(taskId), "-F", "#{window_name}"
      ]).split("\n").map((name) => name.trim()).filter(Boolean);
    } catch (error) {
      if (isUnavailableTmuxStatus(error)) return [];
      throw error;
    }
  }

  private async sessionWindowNamesAsync(
    taskId: string
  ): Promise<Readonly<{ exists: boolean; names: string[] }>> {
    try {
      const names = (await this.runAsync([
        "list-windows", "-t", this.sessionName(taskId), "-F", "#{window_name}"
      ])).split("\n").map((name) => name.trim()).filter(Boolean);
      return { exists: true, names };
    } catch (error) {
      if (isUnavailableTmuxStatus(error)) return { exists: false, names: [] };
      throw error;
    }
  }

  private sessionName(taskId: string): string {
    return yuiTmuxSessionName(this.#yuiHome, taskId);
  }

  private taskSessionGroupNames(taskId: string): string[] {
    const formatSeparator = "\u001f";
    const encodedSeparator = "\\037";
    const taskSession = this.sessionName(taskId);
    let output: string;
    try {
      output = this.run([
        "list-sessions", "-F",
        `#{session_name}${formatSeparator}#{session_group}`
      ]);
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return [];
      throw error;
    }
    return parseTaskSessionGroupNames(
      output,
      taskSession,
      formatSeparator,
      encodedSeparator
    );
  }

  private async taskSessionGroupNamesAsync(taskId: string): Promise<string[]> {
    const formatSeparator = "\u001f";
    const encodedSeparator = "\\037";
    const taskSession = this.sessionName(taskId);
    let output: string;
    try {
      output = await this.runAsync([
        "list-sessions", "-F",
        `#{session_name}${formatSeparator}#{session_group}`
      ]);
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return [];
      throw error;
    }
    return parseTaskSessionGroupNames(
      output,
      taskSession,
      formatSeparator,
      encodedSeparator
    );
  }

  private target(taskId: string, roleName: string): string {
    return yuiTmuxTarget(this.#yuiHome, taskId, roleName);
  }

  private recordRoleTarget(taskId: string, roleName: string): void {
    this.#onRoleTargetRecorded?.(this.target(taskId, roleName));
  }

  private recordTaskTargets(taskId: string): void {
    if (this.#onRoleTargetRecorded === undefined) return;
    for (const pane of this.inspectTaskRolePanes(taskId)) {
      this.#onRoleTargetRecorded(pane.target);
    }
  }

  private async recordTaskTargetsAsync(taskId: string): Promise<void> {
    if (this.#onRoleTargetRecorded === undefined) return;
    for (const pane of await this.inspectRolePaneInventoryAsync()) {
      if (pane.taskId === taskId) this.#onRoleTargetRecorded(pane.target);
    }
  }

  private configureServerHistory(): void {
    this.run([
      "start-server",
      ";",
      "set-option", "-g", "history-limit", String(this.#historyLimit)
    ]);
  }

  private async configureServerHistoryAsync(): Promise<void> {
    await this.runAsync([
      "start-server",
      ";",
      "set-option", "-g", "history-limit", String(this.#historyLimit)
    ]);
  }

  /**
   * Pin the Role window to the largest attached client. The tmux default
   * `window-size latest` lets a later-attaching smaller client (e.g. the Web
   * terminal or a second Role viewer from a smaller pane) shrink the shared
   * Role window, leaving the primary viewer with a TUI pinned to the top of a
   * large terminal and no scrollback. `largest` keeps the window at the
   * biggest attached client so a compact viewer cannot compress it.
   */
  private configureRoleWindowSizing(taskId: string, roleName: string): void {
    this.run([
      "set-option", "-w",
      "-t", `${this.sessionName(taskId)}:${safeValue(roleName, "Role name")}`,
      "window-size", "largest"
    ]);
  }

  private async configureRoleWindowSizingAsync(
    taskId: string,
    roleName: string
  ): Promise<void> {
    await this.runAsync([
      "set-option", "-w",
      "-t", `${this.sessionName(taskId)}:${safeValue(roleName, "Role name")}`,
      "window-size", "largest"
    ]);
  }

  /** Every operation is pinned to the server derived from this YUI_HOME. */
  private run(args: string[], options?: CommandRunOptions): string {
    const bounded = options?.inheritStdio === true
      ? options
      : { ...options, timeoutMs: options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS };
    return this.executor.run(this.tmuxBin, ["-L", this.#serverName, ...args], bounded);
  }

  private runAsync(args: string[], options?: CommandRunOptions): Promise<string> {
    const bounded = {
      ...options,
      timeoutMs: options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    };
    if (this.executor.runAsync !== undefined) {
      return this.executor.runAsync(this.tmuxBin, ["-L", this.#serverName, ...args], bounded);
    }
    return Promise.resolve().then(() => this.run(args, bounded));
  }
}

function parseRolePaneInventory(
  output: string,
  formatSeparator: string,
  encodedSeparator: string,
  sessionPrefix: string,
  target: (taskId: string, roleName: string) => string
): TmuxRolePaneState[] {
  return output.split("\n").flatMap((line): TmuxRolePaneState[] => {
    if (line.length === 0) return [];
    const separator = line.includes(encodedSeparator) ? encodedSeparator : formatSeparator;
    const [
      sessionName,
      roleName,
      deadText,
      deadStatusText,
      pidText,
      currentCommand,
      ...extra
    ] = line.split(separator);
    if (
      sessionName === undefined
      || roleName === undefined
      || deadText === undefined
      || deadStatusText === undefined
      || pidText === undefined
      || currentCommand === undefined
      || extra.length > 0
      || (deadText !== "0" && deadText !== "1")
    ) {
      throw runtimeError("Tmux returned an invalid Role pane inventory row.");
    }
    if (!sessionName.startsWith(sessionPrefix)) return [];
    const taskId = sessionName.slice(sessionPrefix.length);
    if (taskId.length === 0 || roleName.length === 0) {
      throw runtimeError("Tmux returned an invalid Yui Role pane identity.");
    }
    const pid = Number(pidText);
    const deadStatus = Number(deadStatusText);
    return [{
      taskId,
      roleName,
      target: target(taskId, roleName),
      dead: deadText === "1",
      ...(Number.isSafeInteger(deadStatus) && deadStatus >= 0 ? { deadStatus } : {}),
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      currentCommand
    }];
  });
}

function parseTaskSessionGroupNames(
  output: string,
  taskSession: string,
  formatSeparator: string,
  encodedSeparator: string
): string[] {
  return output.split("\n").flatMap((line): string[] => {
    if (line.length === 0) return [];
    const separator = line.includes(encodedSeparator) ? encodedSeparator : formatSeparator;
    const [sessionName, sessionGroup, ...extra] = line.split(separator);
    if (sessionName === undefined || sessionGroup === undefined || extra.length > 0) {
      throw runtimeError("Tmux returned an invalid session group row.");
    }
    return sessionName === taskSession || sessionGroup === taskSession ? [sessionName] : [];
  });
}

function writableClientSessionPrefix(roleName?: string): string {
  if (roleName === undefined) return HOST_WRITABLE_CLIENT_SESSION_PREFIX;
  const digest = createHash("sha256")
    .update(safeValue(roleName, "Role name"))
    .digest("hex")
    .slice(0, 24);
  return `${ROLE_WRITABLE_CLIENT_SESSION_PREFIX}${digest}-`;
}

function writableLeaseMatchesRole(
  sessionName: string,
  roleName?: string
): boolean {
  if (!sessionName.startsWith(WRITABLE_CLIENT_SESSION_PREFIX)) return false;
  if (roleName === undefined) return true;
  if (sessionName.startsWith(HOST_WRITABLE_CLIENT_SESSION_PREFIX)) return true;
  if (sessionName.startsWith(ROLE_WRITABLE_CLIENT_SESSION_PREFIX)) {
    return sessionName.startsWith(writableClientSessionPrefix(roleName));
  }
  // Conservative compatibility for writer leases created before Role-scoped
  // lease names existed.
  return true;
}

function writableClientRowsContainMatch(
  clients: string,
  taskSession: string,
  roleName: string | undefined,
  excludedLease: string | undefined,
  formatSeparator: string,
  encodedSeparator: string
): boolean {
  return clients.split("\n").some((line) => {
    if (line.length === 0) return false;
    const separator = line.includes(encodedSeparator) ? encodedSeparator : formatSeparator;
    const [sessionName, sessionGroup, readOnly, ...extra] = line.split(separator);
    if (
      sessionName === undefined
      || sessionGroup === undefined
      || readOnly === undefined
      || extra.length > 0
    ) {
      throw runtimeError("Tmux returned an invalid client state row.");
    }
    if (
      sessionName === excludedLease
      || (sessionName !== taskSession && sessionGroup !== taskSession)
      || readOnly !== "0"
    ) {
      return false;
    }
    // Current Yui clients publish a lease before attach. A direct or legacy
    // writable tmux client has no Role identity, so conservatively fence every
    // Role in that host.
    return !sessionName.startsWith(WRITABLE_CLIENT_SESSION_PREFIX)
      || writableLeaseMatchesRole(sessionName, roleName);
  });
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
  return `${yuiTmuxSessionPrefix(yuiHome)}${safeTaskId}`;
}

function yuiTmuxSessionPrefix(yuiHome: string): string {
  const namespace = createHash("sha256").update(resolve(yuiHome)).digest("hex").slice(0, 12);
  return `yui-${namespace}-`;
}

/**
 * tmux socket labels are not paths. Keep the label in a deliberately narrow,
 * fixed-size alphabet so it is safe as argv and leaves ample Unix socket-path
 * headroom. resolve() makes equivalent absolute/relative YUI_HOME paths share
 * one server without depending on whether the directory already exists.
 */
export function yuiTmuxServerName(yuiHome: string): string {
  const canonicalHome = resolve(safeValue(yuiHome, "YUI_HOME"));
  const digest = createHash("sha256").update(canonicalHome).digest("hex").slice(0, 24);
  return `yui-${digest}`;
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
  // The launch plan is a complete environment assembled by the planner for
  // this exact Agent. Never inherit the Controller or tmux server environment:
  // it may contain credentials belonging to another configured Agent.
  return ["env", "-i", "--", ...environment, command, ...args];
}

function isExplicitlyAbsentTmuxSession(error: unknown): boolean {
  if (!(error instanceof CommandExecutionError)) return false;
  return /can't find (?:session|window|pane)|no server running|no current target|session not found|error connecting to .+ \(No such file or directory\)/i
    .test(error.stderr);
}

function isUnavailableTmuxStatus(error: unknown): boolean {
  return isExplicitlyAbsentTmuxSession(error)
    || (error instanceof CommandExecutionError
      && /server exited unexpectedly/i.test(error.stderr));
}

function tmuxWord(value: string): string {
  return JSON.stringify(value);
}

function deliveryReceiptOption(receiptId: string): string {
  safeValue(receiptId, "tmux delivery receipt id");
  return `@yui_delivery_${createHash("sha256").update(receiptId).digest("hex")}`;
}

function deliveryPaneGuard(pane: TmuxPaneState): string {
  if (
    pane.dead
    || pane.pid === undefined
    || pane.cursorX === undefined
    || pane.cursorY === undefined
    || pane.historySize === undefined
    || !/^[A-Za-z0-9_.+-]+$/.test(pane.currentCommand)
  ) {
    return "0";
  }
  const comparisons = [
    "#{==:#{pane_dead},0}",
    `#{==:#{pane_pid},${pane.pid}}`,
    `#{==:#{cursor_x},${pane.cursorX}}`,
    `#{==:#{cursor_y},${pane.cursorY}}`,
    `#{==:#{history_size},${pane.historySize}}`,
    `#{==:#{pane_current_command},${pane.currentCommand}}`
  ];
  return comparisons.slice(1).reduce(
    (combined, comparison) => `#{&&:${combined},${comparison}}`,
    comparisons[0]!
  );
}

function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
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

function roleHistoryWarning(history: TmuxRoleHistory): string {
  return "This existing Role has a "
    + `${history.actual.toLocaleString("en-US")}-line tmux history. `
    + "Please exit and re-enter the Role to use "
    + `${history.configured.toLocaleString("en-US")} lines.`;
}

function blockingSleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
