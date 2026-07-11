import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type SnapshotWrite = {
  schemaVersion: 1;
  id: string;
  target: string;
  content: string;
  createdAt: string;
};

export function stageSnapshotWrite(
  rootDir: string,
  target: string,
  content: string,
  id = randomUUID()
): string {
  const entry = createSnapshotWrite(rootDir, target, content, id);
  const journalFile = snapshotJournalFile(rootDir, id);
  atomicWriteText(journalFile, `${JSON.stringify(entry, null, 2)}\n`);
  return journalFile;
}

export function writeRecoverableSnapshot(rootDir: string, target: string, content: string): void {
  const journalFile = stageSnapshotWrite(rootDir, target, content);
  try {
    atomicWriteText(target, content);
    rmSync(journalFile, { force: true });
  } catch (error) {
    throw error;
  }
}

export function replayPendingSnapshotWrites(rootDir: string): string[] {
  const directory = snapshotJournalDir(rootDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return names.map((name) => {
    const journalFile = join(directory, name);
    const entry = parseSnapshotWrite(readFileSync(journalFile, "utf8"), name.slice(0, -5));
    const target = resolveJournalTarget(rootDir, entry.target);
    atomicWriteText(target, entry.content);
    rmSync(journalFile, { force: true });
    return target;
  });
}

function createSnapshotWrite(rootDir: string, target: string, content: string, id: string): SnapshotWrite {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Invalid snapshot write id.");
  }
  const normalizedTarget = resolve(target);
  const targetPath = relative(resolve(rootDir), normalizedTarget);
  if (targetPath.length === 0 || targetPath.startsWith("..") || isAbsolute(targetPath)) {
    throw new Error("Snapshot target must be inside TASKMUX_HOME.");
  }
  return {
    schemaVersion: 1,
    id,
    target: targetPath,
    content,
    createdAt: new Date().toISOString()
  };
}

function parseSnapshotWrite(raw: string, expectedId: string): SnapshotWrite {
  const value = JSON.parse(raw) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 1 ||
    !("id" in value) || value.id !== expectedId ||
    !("target" in value) || typeof value.target !== "string" ||
    !("content" in value) || typeof value.content !== "string" ||
    !("createdAt" in value) || typeof value.createdAt !== "string"
  ) {
    throw new Error(`Invalid recovery journal entry: ${expectedId}.`);
  }
  return value as SnapshotWrite;
}

function resolveJournalTarget(rootDir: string, target: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(resolvedRoot, target);
  const targetPath = relative(resolvedRoot, resolvedTarget);
  if (targetPath.length === 0 || targetPath.startsWith("..") || isAbsolute(targetPath)) {
    throw new Error("Recovery journal target escapes TASKMUX_HOME.");
  }
  return resolvedTarget;
}

function snapshotJournalDir(rootDir: string): string {
  return join(rootDir, "runtime", "recovery-journal");
}

function snapshotJournalFile(rootDir: string, id: string): string {
  return join(snapshotJournalDir(rootDir), `${id}.json`);
}

function atomicWriteText(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}
