import type { Role } from "../role/role.js";
import type { RoleStatus } from "../role/role.js";
import type { AgentLaunchPlan } from "../executor/launchPlan.js";
import type { CommandExecutor } from "./commandExecutor.js";

export class TmuxManager {
  constructor(
    private readonly tmuxBin: string,
    private readonly executor: CommandExecutor
  ) {}

  enterRole(taskId: string, role: Role, launch?: AgentLaunchPlan): void {
    this.ensureSession(taskId);
    this.ensureWindow(taskId, role, launch);
    this.executor.run(this.tmuxBin, ["attach-session", "-t", this.target(taskId, role.name)], {
      inheritStdio: true
    });
  }

  captureRole(taskId: string, roleName: string, lines = 80): string {
    return this.executor.run(this.tmuxBin, [
      "capture-pane",
      "-p",
      "-t",
      this.target(taskId, roleName),
      "-S",
      `-${lines}`
    ]);
  }

  dispatchRole(
    taskId: string,
    role: Role,
    launch: AgentLaunchPlan,
    input: string,
    options: { replaceExisting?: boolean } = {}
  ): void {
    this.ensureSession(taskId);
    if (options.replaceExisting === true) {
      try {
        this.killRole(taskId, role.name);
      } catch {
        // A new session can also be the first session for this role.
      }
      this.createWindow(taskId, role, launch);
    } else {
      this.ensureWindow(taskId, role, launch);
    }
    this.sendRoleInput(taskId, role.name, input);
  }

  sendRoleInput(taskId: string, roleName: string, input: string): void {
    this.executor.run(this.tmuxBin, ["send-keys", "-l", "-t", this.target(taskId, roleName), "--", input]);
    this.executor.run(this.tmuxBin, ["send-keys", "-t", this.target(taskId, roleName), "Enter"]);
  }

  detachRole(taskId: string): void {
    this.executor.run(this.tmuxBin, ["detach-client", "-s", this.sessionName(taskId)]);
  }

  restartRole(taskId: string, role: Role): void {
    try {
      this.killRole(taskId, role.name);
    } catch {
      // Restart must recover even when the old window is already gone.
    }

    this.enterRole(taskId, role);
  }

  detectRoleStatus(taskId: string, roleName: string, fallback: RoleStatus): RoleStatus {
    try {
      const windows = this.executor.run(this.tmuxBin, [
        "list-windows",
        "-t",
        this.sessionName(taskId),
        "-F",
        "#{window_name}"
      ]);

      return windows.split("\n").includes(roleName) ? "running" : "exited";
    } catch {
      return fallback;
    }
  }

  stopRole(taskId: string, roleName: string): void {
    this.executor.run(this.tmuxBin, ["send-keys", "-t", this.target(taskId, roleName), "C-c"]);
  }

  killRole(taskId: string, roleName: string): void {
    this.executor.run(this.tmuxBin, ["kill-window", "-t", this.target(taskId, roleName)]);
  }

  renameRole(taskId: string, oldRoleName: string, newRoleName: string): void {
    this.executor.run(this.tmuxBin, ["rename-window", "-t", this.target(taskId, oldRoleName), newRoleName]);
  }

  private ensureSession(taskId: string): void {
    try {
      this.executor.run(this.tmuxBin, ["has-session", "-t", this.sessionName(taskId)]);
      return;
    } catch {
      this.executor.run(this.tmuxBin, ["new-session", "-d", "-s", this.sessionName(taskId)]);
    }
  }

  private ensureWindow(taskId: string, role: Role, launch?: AgentLaunchPlan): void {
    const windows = this.executor.run(this.tmuxBin, [
      "list-windows",
      "-t",
      this.sessionName(taskId),
      "-F",
      "#{window_name}"
    ]);

    if (windows.split("\n").includes(role.name)) {
      return;
    }

    this.createWindow(taskId, role, launch ?? role);
  }

  private createWindow(taskId: string, role: Role, launch: AgentLaunchPlan | Role): void {
    this.executor.run(this.tmuxBin, [
      "new-window",
      "-t",
      this.sessionName(taskId),
      "-n",
      role.name,
      "-c",
      role.workspace,
      roleShellCommand(launch)
    ]);
  }

  private sessionName(taskId: string): string {
    return `taskmux-${taskId}`;
  }

  private target(taskId: string, roleName: string): string {
    return `${this.sessionName(taskId)}:${roleName}`;
  }
}

function roleShellCommand(launch: Pick<Role, "command" | "args" | "env">): string {
  const env = Object.entries(launch.env).map(([key, value]) => `${key}=${value}`);
  const parts = env.length > 0
    ? ["env", ...env, launch.command, ...launch.args]
    : [launch.command, ...launch.args];

  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
