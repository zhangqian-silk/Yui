import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeTextFileAtomically } from "../storage/durableFile.js";
import {
  validateRuntimeProcessExitObservation,
  type RuntimeProcessExitObservation
} from "./processExitObservation.js";

export type RuntimeProcessExitSubmit = (
  observation: RuntimeProcessExitObservation
) => Promise<void>;

/**
 * Persist before attempting Controller delivery. The Controller also drains
 * this outbox before it begins serving after a restart, so a Session does not
 * have to remain alive merely to bridge a short handover window.
 */
export async function persistRuntimeProcessExitObservation(
  home: string,
  observation: RuntimeProcessExitObservation,
  submit: RuntimeProcessExitSubmit
): Promise<void> {
  const validated = validateRuntimeProcessExitObservation(observation);
  const directory = outboxDirectory(home);
  const identity = createHash("sha256").update(validated.observationId).digest("hex");
  writeTextFileAtomically(
    join(directory, `${identity}.json`),
    `${JSON.stringify(validated)}\n`
  );
  await replayRuntimeProcessExitOutbox(home, submit);
}

/**
 * Replays every record through an idempotent observation boundary. A failed
 * record remains durable and is considered again by the next replay.
 */
export async function replayRuntimeProcessExitOutbox(
  home: string,
  submit: RuntimeProcessExitSubmit
): Promise<void> {
  const directory = outboxDirectory(home);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of entries.filter((name) => name.endsWith(".json")).sort()) {
    const path = join(directory, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      // Another Agent Host or the replacement Controller may have submitted
      // and removed this immutable record after our directory snapshot.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const observation = validateRuntimeProcessExitObservation(
      JSON.parse(raw) as RuntimeProcessExitObservation
    );
    await submit(observation);
    await unlink(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  // One-generation bridge for observations written by an Agent Host that was
  // already running before this release. New writers use one immutable file
  // per observation above, so they never share an append/unlink boundary.
  for (const name of entries.filter(isLegacyOutboxEntry).sort()) {
    const path = join(directory, name);
    const claimed = `${path}.claim-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const lines = (await readFile(claimed, "utf8")).split("\n").filter(Boolean);
      for (const line of lines) {
        await submit(validateRuntimeProcessExitObservation(
          JSON.parse(line) as RuntimeProcessExitObservation
        ));
      }
      await unlink(claimed);
    } catch (error) {
      // Keep the unique claim file. It remains discoverable by the next replay,
      // while a concurrent append can safely create/use the ordinary path.
      throw error;
    }
  }
}

function outboxDirectory(home: string): string {
  return resolve(join(home, "runtime", "agent-host-outbox"));
}

function isLegacyOutboxEntry(name: string): boolean {
  // A previous process may have stopped after its atomic claim but before
  // delivery. Re-claiming is safe because the observation boundary dedupes by
  // observationId.
  return name.includes(".jsonl");
}
