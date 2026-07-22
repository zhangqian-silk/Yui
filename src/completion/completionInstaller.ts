import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { CliIdentity } from "../cli/completion.js";
import { dataError } from "../errors/cliError.js";
import {
  activationBlock,
  activationEnd,
  activationIsAutomatic,
  activationStart,
  completionMarker,
  managedCompletionScript,
  type CompletionConfig,
  type CompletionInstallation,
  type CompletionShell
} from "./completionState.js";

export type CompletionStore = Readonly<{
  getConfig(): CompletionConfig;
  saveConfig(config: CompletionConfig): void;
}>;

export function installCompletion(
  store: CompletionStore,
  shell: CompletionShell,
  installation: CompletionInstallation,
  env: NodeJS.ProcessEnv,
  identity: CliIdentity,
  activate: boolean
): void {
  validateInstallation(installation);
  writeManagedScript(shell, installation.scriptPath, identity);
  const config = store.getConfig();
  store.saveConfig({
    ...config,
    completionInstallations: {
      ...config.completionInstallations,
      [shell]: installation
    }
  });
  if (!activationIsAutomatic(shell, installation, env, identity) && activate) {
    writeActivationBlock(shell, installation, identity);
  }
}

export function uninstallCompletion(
  store: CompletionStore,
  shell: CompletionShell,
  identity: CliIdentity
): void {
  const config = store.getConfig();
  const installation = config.completionInstallations?.[shell];
  if (installation === undefined) return;

  assertManagedScriptRemovable(shell, installation.scriptPath, identity);
  assertActivationRemovable(shell, installation, identity);
  removeManagedScript(shell, installation.scriptPath, identity);
  removeActivationBlock(shell, installation, identity);
  const installations = { ...config.completionInstallations };
  delete installations[shell];
  store.saveConfig({
    ...config,
    completionInstallations: Object.keys(installations).length === 0
      ? undefined
      : installations
  });
}

function assertManagedScriptRemovable(
  shell: CompletionShell,
  path: string,
  identity: CliIdentity
): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !readFileSync(path, "utf8").startsWith(completionMarker(shell, identity))
  ) {
    throw dataError(`Refusing to remove unmanaged completion script: ${path}`);
  }
}

function assertActivationRemovable(
  shell: CompletionShell,
  installation: CompletionInstallation,
  identity: CliIdentity
): void {
  const path = installation.activationPath;
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw dataError(`Refusing to modify unsafe activation file: ${path}`);
  }
  const contents = readFileSync(path, "utf8");
  const starts = occurrences(contents, activationStart(shell, identity));
  const ends = occurrences(contents, activationEnd(shell, identity));
  if (starts !== ends || starts > 1) {
    throw dataError(`Refusing to remove ambiguous Yui activation block: ${path}`);
  }
}

function writeManagedScript(
  shell: CompletionShell,
  path: string,
  identity: CliIdentity
): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw dataError(`Refusing to overwrite unsafe completion script: ${path}`);
    }
    if (!readFileSync(path, "utf8").startsWith(completionMarker(shell, identity))) {
      throw dataError(`Refusing to overwrite unmanaged completion script: ${path}`);
    }
  }
  writeAtomic(path, managedCompletionScript(shell, identity), 0o644);
}

function writeActivationBlock(
  shell: CompletionShell,
  installation: CompletionInstallation,
  identity: CliIdentity
): void {
  const path = installation.activationPath;
  let contents = "";
  let mode = 0o644;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw dataError(`Refusing to modify unsafe activation file: ${path}`);
    }
    contents = readFileSync(path, "utf8");
    mode = stat.mode & 0o777;
  }
  const start = activationStart(shell, identity);
  const end = activationEnd(shell, identity);
  const starts = occurrences(contents, start);
  const ends = occurrences(contents, end);
  if (starts > 1 || ends > 1 || starts !== ends) {
    throw dataError(`Refusing to modify ambiguous Yui activation block: ${path}`);
  }
  const block = activationBlock(shell, installation, identity);
  const next = starts === 1
    ? replaceManagedBlock(contents, start, end, block)
    : `${contents}${contents.length === 0 || contents.endsWith("\n") ? "" : "\n"}${block}\n`;
  writeAtomic(path, next, mode);
}

function removeManagedScript(
  shell: CompletionShell,
  path: string,
  identity: CliIdentity
): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !readFileSync(path, "utf8").startsWith(completionMarker(shell, identity))
  ) {
    throw dataError(`Refusing to remove unmanaged completion script: ${path}`);
  }
  rmSync(path);
}

function removeActivationBlock(
  shell: CompletionShell,
  installation: CompletionInstallation,
  identity: CliIdentity
): void {
  const path = installation.activationPath;
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw dataError(`Refusing to modify unsafe activation file: ${path}`);
  }
  const contents = readFileSync(path, "utf8");
  const start = activationStart(shell, identity);
  const end = activationEnd(shell, identity);
  const starts = occurrences(contents, start);
  const ends = occurrences(contents, end);
  if (starts !== ends || starts > 1) {
    throw dataError(`Refusing to remove ambiguous Yui activation block: ${path}`);
  }
  if (starts === 0) return;

  const blockStart = contents.indexOf(start);
  const blockEnd = contents.indexOf(end, blockStart) + end.length;
  let next = `${contents.slice(0, blockStart)}${contents.slice(blockEnd)}`;
  if (next.startsWith("\n")) next = next.slice(1);
  if (next.endsWith("\n\n")) next = next.slice(0, -1);
  writeAtomic(path, next, stat.mode & 0o777);
}

function writeAtomic(path: string, contents: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.yui-pending`);
  try {
    writeFileSync(temp, contents, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function replaceManagedBlock(
  contents: string,
  start: string,
  end: string,
  block: string
): string {
  const from = contents.indexOf(start);
  const to = contents.indexOf(end, from);
  if (from < 0 || to < from) throw dataError("Invalid Yui activation block.");
  return `${contents.slice(0, from)}${block}${contents.slice(to + end.length)}`;
}

function occurrences(contents: string, value: string): number {
  return contents.split(value).length - 1;
}

function validateInstallation(installation: CompletionInstallation): void {
  if (!isAbsolute(installation.scriptPath) || !isAbsolute(installation.activationPath)) {
    throw dataError("Completion script and activation paths must be absolute.");
  }
  if (resolve(installation.scriptPath) === resolve(installation.activationPath)) {
    throw dataError("Completion script and activation paths must be different.");
  }
}
