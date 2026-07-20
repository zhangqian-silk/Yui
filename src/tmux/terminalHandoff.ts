import type { Readable } from "node:stream";

export type TerminalInput = Pick<Readable, "pause"> & Readonly<{
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
}>;

/**
 * Release every TaskMux claim on a terminal before a foreground tmux client
 * inherits it. The optional close callback is expected to be idempotent.
 */
export function handoffTerminal(
  input: TerminalInput,
  closeInteractiveInput: () => void = () => {}
): void {
  try {
    closeInteractiveInput();
  } finally {
    if (
      input.isTTY === true
      && input.isRaw === true
      && typeof input.setRawMode === "function"
    ) {
      input.setRawMode(false);
    }
    input.pause();
  }
}
