import * as pty from "node-pty";

import {
  yuiTmuxServerName,
  type TmuxRoleHistory
} from "../tmux/tmuxManager.js";
import type {
  WebTerminalConnection,
  WebTerminalRequest
} from "./webServer.js";

type Disposable = Readonly<{ dispose(): void }>;
type PtyExit = Readonly<{ exitCode: number; signal?: number }>;

type PtyProcess = Readonly<{
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (exit: PtyExit) => void): Disposable;
  write(data: string | Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}>;

type PtySpawner = (
  command: string,
  args: string[],
  options: Readonly<{
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }>
) => PtyProcess;

export type TmuxWebTerminalOptions = Readonly<{
  yuiHome: string;
  tmuxBin: string;
  tmux: Readonly<{
    hasWritableClient(hostId: string): boolean;
    createInteractiveClientSession(hostId: string): string;
    destroyInteractiveClientSession(sessionName: string): void;
    inspectRoleHistory?(hostId: string, roleName: string): TmuxRoleHistory;
  }>;
  prepareTaskRole(input: Readonly<{ taskId: string; roleName: string }>): Promise<void>;
  prepareGlobalRole(roleName: string): Promise<void>;
  spawnPty?: PtySpawner;
  environment?: NodeJS.ProcessEnv;
  onError?: (error: unknown) => void;
}>;

/**
 * Creates only a tmux client PTY. Closing it detaches the browser while the
 * native Agent process remains owned by the existing tmux Role window.
 */
export class TmuxWebTerminalService {
  readonly #writers = new Set<string>();
  readonly #spawnPty: PtySpawner;

  constructor(private readonly options: TmuxWebTerminalOptions) {
    this.#spawnPty = options.spawnPty ?? ((command, args, ptyOptions) => (
      pty.spawn(command, args, ptyOptions)
    ));
  }

  async open(request: WebTerminalRequest): Promise<WebTerminalConnection> {
    const hostId = request.scope === "task" ? request.taskId : "operator";
    if (request.scope === "task") {
      await this.options.prepareTaskRole({
        taskId: request.taskId,
        roleName: request.roleName
      });
    } else {
      await this.options.prepareGlobalRole(request.roleName);
    }
    const roleHistory = this.options.tmux.inspectRoleHistory?.(hostId, request.roleName);

    const readOnly = this.#writers.has(hostId)
      || this.options.tmux.hasWritableClient(hostId);
    if (!readOnly) this.#writers.add(hostId);

    let clientSession: string | undefined;
    let process: PtyProcess;
    try {
      clientSession = this.options.tmux.createInteractiveClientSession(hostId);
      process = this.#spawnPty(
        this.options.tmuxBin,
        [
          "-L", yuiTmuxServerName(this.options.yuiHome),
          "attach-session",
          ...(readOnly ? ["-r"] : []),
          "-t",
          `${clientSession}:${request.roleName}`
        ],
        {
          name: "xterm-256color",
          cols: request.columns,
          rows: request.rows,
          cwd: this.options.yuiHome,
          env: {
            ...(this.options.environment ?? processEnvironment()),
            TERM: "xterm-256color"
          }
        }
      );
    } catch (error) {
      if (!readOnly) this.#writers.delete(hostId);
      if (clientSession !== undefined) {
        this.destroyClientSession(clientSession);
      }
      throw error;
    }

    let closed = false;
    let clientReleased = false;
    const releaseClient = () => {
      if (clientReleased) return;
      clientReleased = true;
      if (!readOnly) this.#writers.delete(hostId);
      this.destroyClientSession(clientSession);
    };
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(exit: PtyExit) => void>();
    const bufferedData: string[] = [];
    let completedExit: PtyExit | undefined;
    const dataLifecycle = process.onData((data) => {
      if (dataListeners.size === 0) {
        bufferedData.push(data);
        return;
      }
      for (const listener of dataListeners) listener(data);
    });
    const exitLifecycle = process.onExit((exit) => {
      completedExit = exit;
      releaseClient();
      for (const listener of exitListeners) listener(exit);
      exitListeners.clear();
    });
    const close = () => {
      if (closed) return;
      closed = true;
      dataLifecycle.dispose();
      exitLifecycle.dispose();
      dataListeners.clear();
      exitListeners.clear();
      bufferedData.length = 0;
      releaseClient();
      try {
        process.kill();
      } catch {
        // The tmux client may already have detached or exited.
      }
    };

    return {
      readOnly,
      ...(roleHistory === undefined ? {} : {
        history: {
          limit: roleHistory.actual,
          target: roleHistory.configured
        }
      }),
      onData(listener) {
        if (closed) return () => {};
        dataListeners.add(listener);
        for (const data of bufferedData.splice(0)) listener(data);
        return () => dataListeners.delete(listener);
      },
      onExit(listener) {
        if (completedExit !== undefined) {
          listener(completedExit);
          return () => {};
        }
        if (closed) return () => {};
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      write(data) {
        if (!readOnly) process.write(data);
      },
      resize(columns, rows) {
        process.resize(columns, rows);
      },
      close
    };
  }

  private destroyClientSession(clientSession: string): void {
    try {
      this.options.tmux.destroyInteractiveClientSession(clientSession);
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        // Cleanup reporting must not escape the PTY lifecycle.
      }
    }
  }
}

function processEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}
