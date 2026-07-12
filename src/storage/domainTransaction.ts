import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  applyStagedDomainTransaction,
  stageDomainTransaction,
  type DomainTransactionOperation
} from "./recoveryJournal.js";

const AUTHORITATIVE_PATHS = [
  "config.json",
  "schema.json",
  "agents",
  "roles",
  "tasks",
  "trash",
  "runtime/pending-wakeups",
  "runtime/leader-failures",
  "runtime/operator-notifications",
  "runtime/role-sessions",
  "runtime/active-runs"
] as const;

export function executeDomainTransaction<T>(
  rootDir: string,
  id: string,
  execute: (workingRoot: string) => T,
  extraOperations: (result: T) => DomainTransactionOperation[] = () => [],
  options: { includeBackups?: boolean } = {}
): T {
  const authoritativePaths = options.includeBackups
    ? [...AUTHORITATIVE_PATHS, "backups"]
    : [...AUTHORITATIVE_PATHS];
  const workingRoot = join(rootDir, "runtime", "domain-workspaces", id);
  rmSync(workingRoot, { recursive: true, force: true });
  mkdirSync(workingRoot, { recursive: true });
  copyAuthoritativeState(rootDir, workingRoot, authoritativePaths);

  try {
    const before = readAuthoritativeFiles(rootDir, authoritativePaths);
    const beforeDirectories = readAuthoritativeDirectories(rootDir, authoritativePaths);
    const result = execute(workingRoot);
    const after = readAuthoritativeFiles(workingRoot, authoritativePaths);
    const afterDirectories = readAuthoritativeDirectories(workingRoot, authoritativePaths);
    const operations = diffAuthoritativeFiles(
      rootDir,
      before,
      after,
      beforeDirectories,
      afterDirectories
    );
    operations.push(...extraOperations(result));
    if (operations.length > 0) {
      stageDomainTransaction(rootDir, id, operations);
      if (process.env.TASKMUX_DOMAIN_TRANSACTION_FAILPOINT === "after-stage") {
        throw new Error(`Domain transaction ${id} stopped after staging.`);
      }
      applyStagedDomainTransaction(rootDir, id);
    }
    return result;
  } finally {
    rmSync(workingRoot, { recursive: true, force: true });
  }
}

function readAuthoritativeDirectories(rootDir: string, authoritativePaths: string[]): Set<string> {
  const directories = new Set<string>();
  for (const path of authoritativePaths) {
    collectDirectories(rootDir, join(rootDir, path), directories);
  }
  return directories;
}

function collectDirectories(rootDir: string, target: string, directories: Set<string>): void {
  if (!existsSync(target) || !lstatSync(target).isDirectory()) {
    return;
  }
  directories.add(relative(rootDir, target));
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectDirectories(rootDir, join(target, entry.name), directories);
    }
  }
}

function copyAuthoritativeState(sourceRoot: string, targetRoot: string, authoritativePaths: string[]): void {
  for (const path of authoritativePaths) {
    const source = join(sourceRoot, path);
    if (!existsSync(source)) {
      continue;
    }
    const target = join(targetRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

function readAuthoritativeFiles(rootDir: string, authoritativePaths: string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of authoritativePaths) {
    collectFiles(rootDir, join(rootDir, path), files);
  }
  return files;
}

function collectFiles(rootDir: string, target: string, files: Map<string, string>): void {
  if (!existsSync(target)) {
    return;
  }
  if (lstatSync(target).isFile()) {
    files.set(relative(rootDir, target), readFileSync(target, "utf8"));
    return;
  }
  const entries = readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(target, entry.name);
    if (entry.isDirectory()) {
      collectFiles(rootDir, path, files);
    } else if (entry.isFile()) {
      files.set(relative(rootDir, path), readFileSync(path, "utf8"));
    }
  }
}

function diffAuthoritativeFiles(
  rootDir: string,
  before: Map<string, string>,
  after: Map<string, string>,
  beforeDirectories: Set<string>,
  afterDirectories: Set<string>
): DomainTransactionOperation[] {
  const operations: DomainTransactionOperation[] = [];
  const removedDirectories = [...beforeDirectories]
    .filter((path) => !afterDirectories.has(path))
    .sort((left, right) => left.length - right.length)
    .filter((path, index, paths) => !paths.slice(0, index).some((parent) => path.startsWith(`${parent}/`)));
  for (const path of removedDirectories) {
    operations.push({ type: "delete", target: join(rootDir, path) });
  }
  for (const path of [...before.keys()].sort()) {
    if (!after.has(path) && !removedDirectories.some((directory) => path.startsWith(`${directory}/`))) {
      operations.push({ type: "delete", target: join(rootDir, path) });
    }
  }
  for (const [path, content] of [...after.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (before.get(path) !== content) {
      operations.push({ type: "write", target: join(rootDir, path), content });
    }
  }
  return operations;
}
