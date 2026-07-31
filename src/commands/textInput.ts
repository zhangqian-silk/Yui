import { readFileSync } from "node:fs";

import { usageError } from "../errors/cliError.js";

export function readCommandText(
  inline: string | undefined,
  file: string | undefined,
  label: string,
  usage: string
): string {
  if ((inline === undefined) === (file === undefined)) {
    throw usageError(`Specify exactly one of ${label} or ${label}-file.`, usage);
  }
  const value = file === undefined
    ? inline!
    : readFileSync(file === "-" ? 0 : file, "utf8");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw usageError(`${label} is required.`, usage);
  }
  return normalized;
}
