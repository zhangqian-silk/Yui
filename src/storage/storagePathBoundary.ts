import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { dataError } from "../errors/cliError.js";

export function assertPathOutsideTaskmuxHome(
  output: string,
  rootDir: string,
  label = "Output path"
): void {
  const canonicalOutput = canonicalProspectivePath(output);
  const canonicalRoot = canonicalProspectivePath(rootDir);
  if (pathContains(canonicalRoot, canonicalOutput) || pathContains(canonicalOutput, canonicalRoot)) {
    throw dataError(`${label} must be outside TASKMUX_HOME.`);
  }
}

export function canonicalProspectivePath(path: string): string {
  let existingPath = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }
  const canonicalExistingPath = existsSync(existingPath) ? realpathSync(existingPath) : existingPath;
  return resolve(canonicalExistingPath, ...missingSegments);
}

function pathContains(parent: string, candidate: string): boolean {
  const childPath = relative(parent, candidate);
  return childPath === "" || (!isAbsolute(childPath) && childPath !== ".." && !childPath.startsWith(`..${sep}`));
}
