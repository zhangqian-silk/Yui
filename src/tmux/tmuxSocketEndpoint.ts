import { join, resolve } from "node:path";

/**
 * Exact same-user directory in which `tmux -L` publishes a named server.
 * TMUX_TMPDIR is tmux's only configurable root; TMPDIR/TMP/TEMP do not apply.
 */
export function tmuxSocketDirectory(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(resolve(nonEmptyTmuxTmpdir(environment) ?? "/tmp"), `tmux-${uid}`);
}

/** Pins an invoked tmux process to the same root selected above. */
export function tmuxSocketEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...environment,
    TMUX_TMPDIR: nonEmptyTmuxTmpdir(environment)
  };
}

function nonEmptyTmuxTmpdir(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.TMUX_TMPDIR;
  return configured !== undefined && configured.length > 0 ? configured : undefined;
}
