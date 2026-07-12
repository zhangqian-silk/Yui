import { execFileSync } from "node:child_process";

export type CommandRunOptions = {
  inheritStdio?: boolean;
};

export type CommandExecutor = {
  run(command: string, args: string[], options?: CommandRunOptions): string;
};

export class NodeCommandExecutor implements CommandExecutor {
  run(command: string, args: string[], options: CommandRunOptions = {}): string {
    if (options.inheritStdio === true) {
      execFileSync(command, args, { stdio: "inherit" });
      return "";
    }

    return execFileSync(command, args, { encoding: "utf8" });
  }
}
