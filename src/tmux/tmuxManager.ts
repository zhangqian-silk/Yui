import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { runtimeError } from "../errors/cliError.js";
import { handoffTerminal, type TerminalInput } from "./terminalHandoff.js";
import {
  CommandExecutionError,
  type CommandExecutor,
  type CommandRunOptions
} from "./commandExecutor.js";

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_READINESS_POLL_MS = 50;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const PANE_STATE_MARKER = "__YUI_PANE_STATE__";
const NATIVE_SCROLL_TERMINAL_FEATURES = [
  "256", "RGB", "clipboard", "ccolour", "cstyle", "extkeys", "focus",
  "hyperlinks", "ignorefkeys", "mouse", "osc7", "overline", "rectfill",
  "strikethrough", "sync", "title", "usstyle"
].join(",");

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
  styledContent?: string;
  cursorX?: number;
  cursorY?: number;
  historySize?: number;
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
  readonly #serverName: string;
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
    this.#serverName = yuiTmuxServerName(this.#yuiHome);
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
      this.run([
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
      this.run([
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

  async ensureRoleWindowAsync(
    taskId: string,
    role: TmuxRole,
    launch?: TmuxLaunchPlan
  ): Promise<boolean> {
    const snapshot = await this.sessionWindowNamesAsync(taskId);
    if (snapshot.names.includes(role.name)) return false;
    if (launch === undefined) {
      throw runtimeError(`Agent launch plan is required to create Role window: ${role.name}.`);
    }

    if (!snapshot.exists) {
      await this.runAsync([
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
      await this.runAsync([
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
    const session = this.sessionName(taskId);
    // An ANSI outer terminal omits smcup/rmcup, so tmux cannot replace the
    // terminal's native scrollback with an alternate screen. -T restores the
    // modern rendering and input capabilities that the real terminal offers.
    this.run([
      "set-option", "-t", session, "status", "off"
    ]);
    this.run([
      "set-option", "-t", session, "mouse", "off"
    ]);
    handoffTerminal(this.#terminalInput, this.#closeInteractiveInput);
    this.run([
      "-T", NATIVE_SCROLL_TERMINAL_FEATURES,
      "attach-session", "-t", this.target(taskId, roleName)
    ], {
      inheritStdio: true,
      environment: { TERM: "ansi" }
    });
  }

  captureRole(taskId: string, roleName: string, lines = 80): string {
    return this.run([
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
    const output = this.run([
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
    const styledContent = this.run([
      "capture-pane", "-ep", "-t", target, "-S", "-40"
    ]);
    return {
      taskId,
      roleName,
      target,
      dead: dead === "1",
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      currentCommand,
      content: stripVTControlCharacters(styledContent),
      styledContent
    };
  }

  async inspectPaneAsync(taskId: string, roleName: string): Promise<TmuxPaneState> {
    return (await this.inspectDeliveryPaneAsync(taskId, roleName)).pane;
  }

  /**
   * Reads receipt, pane identity, cursor fence and styled terminal contents
   * through one tmux client. The styled snapshot lets adapter probes distinguish
   * an empty placeholder from user-authored composer text.
   */
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
        receiptFormat
      ].join("|"),
      ";",
      "capture-pane", "-ep", "-t", target, "-S", "-40"
    ]);
    const newline = output.indexOf("\n");
    if (newline < 0) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    const state = output.slice(0, newline).split("|");
    if (state.length !== 8 || state[0] !== PANE_STATE_MARKER) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    const [
      ,
      deadText,
      pidText,
      cursorXText,
      cursorYText,
      historySizeText,
      currentCommand,
      receiptText
    ] = state;
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
    if (cursorX === undefined || cursorY === undefined || historySize === undefined) {
      throw runtimeError(`Tmux returned an invalid pane state for ${roleName}.`);
    }
    const styledContent = output.slice(newline + 1);
    return {
      pane: {
        taskId,
        roleName,
        target,
        dead: deadText === "1",
        ...(pid === undefined ? {} : { pid }),
        currentCommand,
        content: stripVTControlCharacters(styledContent),
        styledContent,
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
        `#{window_name}${formatSeparator}#{pane_dead}${formatSeparator}#{pane_pid}${formatSeparator}#{pane_current_command}`
      ]);
    } catch (error) {
      if (isExplicitlyAbsentTmuxSession(error)) return [];
      throw error;
    }
    return output.split("\n").flatMap((line): TmuxRolePaneState[] => {
      if (line.length === 0) return [];
      const separator = line.includes(encodedSeparator) ? encodedSeparator : formatSeparator;
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
   * Reads the Role pane inventory for this YUI_HOME in one tmux server call.
   * Terminal contents are deliberately excluded; recovery code can take a
   * targeted readiness snapshot later for the small set of suspicious panes.
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
        pidText,
        currentCommand,
        ...extra
      ] = line.split(separator);
      if (
        sessionName === undefined
        || roleName === undefined
        || deadText === undefined
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

  stopTask(taskId: string): boolean {
    if (!this.hasSession(taskId)) return false;
    this.run(["kill-session", "-t", this.sessionName(taskId)]);
    return true;
  }

  async stopTaskAsync(taskId: string): Promise<boolean> {
    if (!(await this.hasSessionAsync(taskId))) return false;
    await this.runAsync(["kill-session", "-t", this.sessionName(taskId)]);
    return true;
  }

  stopRole(taskId: string, roleName: string): void {
    this.run(["send-keys", "-t", this.target(taskId, roleName), "C-c"]);
  }

  killRole(taskId: string, roleName: string): void {
    this.run(["kill-window", "-t", this.target(taskId, roleName)]);
  }

  async killRoleAsync(taskId: string, roleName: string): Promise<void> {
    await this.runAsync(["kill-window", "-t", this.target(taskId, roleName)]);
  }

  renameRole(taskId: string, oldRoleName: string, newRoleName: string): void {
    this.run([
      "rename-window", "-t", this.target(taskId, oldRoleName), safeValue(newRoleName, "Role name")
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
    return this.run([
      "list-windows", "-t", this.sessionName(taskId), "-F", "#{window_name}"
    ]).split("\n").map((name) => name.trim()).filter(Boolean);
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
      if (isExplicitlyAbsentTmuxSession(error)) return { exists: false, names: [] };
      throw error;
    }
  }

  private sessionName(taskId: string): string {
    return yuiTmuxSessionName(this.#yuiHome, taskId);
  }

  private target(taskId: string, roleName: string): string {
    return yuiTmuxTarget(this.#yuiHome, taskId, roleName);
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
      pidText,
      currentCommand,
      ...extra
    ] = line.split(separator);
    if (
      sessionName === undefined
      || roleName === undefined
      || deadText === undefined
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
    return [{
      taskId,
      roleName,
      target: target(taskId, roleName),
      dead: deadText === "1",
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      currentCommand
    }];
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
  return /can't find (?:session|window|pane)|no server running|error connecting to .+ \(No such file or directory\)/i
    .test(error.stderr);
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

function blockingSleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
