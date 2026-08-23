import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync
} from "node:fs";
import { join, resolve } from "node:path";

import {
  validateRuntimeProcessExitObservation,
  type RuntimeProcessExitObservation
} from "./processExitObservation.js";

/** Immutable low-volume audit for GlobalRoles, which have no Task Event family. */
export function appendGlobalProcessExitObservation(
  home: string,
  observation: RuntimeProcessExitObservation,
  classification: string
): boolean {
  validateRuntimeProcessExitObservation(observation);
  if (observation.taskId !== undefined) {
    throw new Error("Task process exits must use the Task Event store.");
  }
  const directory = resolve(join(home, "runtime"));
  const path = join(directory, "global-process-exits.jsonl");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const duplicate = readFileSync(path, "utf8").split("\n").some((line) => {
      if (line.length === 0) return false;
      try {
        return (JSON.parse(line) as { observationId?: unknown }).observationId
          === observation.observationId;
      } catch {
        throw new Error("Global process-exit audit is malformed.");
      }
    });
    if (duplicate) return false;
  }
  const descriptor = openSync(path, "a", 0o600);
  try {
    appendFileSync(descriptor, `${JSON.stringify({ ...observation, classification })}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  return true;
}
