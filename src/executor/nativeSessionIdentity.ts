import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { hasNonWhitespace, hasNoSurroundingWhitespace } from "../storage/stringValidation.js";

export function canonicalizeNativeSessionRoot(value: string): string {
  if (!hasNonWhitespace(value) || !isAbsolute(value)) {
    throw new Error("Native session root must be an absolute path.");
  }
  const resolved = resolve(value);
  if (pathEntryExists(resolved)) return realpathSync(resolved);

  const missingSegments: string[] = [];
  let existingPath = resolved;
  while (!pathEntryExists(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }
  return resolve(pathEntryExists(existingPath) ? realpathSync(existingPath) : existingPath, ...missingSegments);
}

function pathEntryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

export function isCanonicalNativeSessionRoot(value: unknown): value is string {
  if (typeof value !== "string" || !hasNonWhitespace(value) || !isAbsolute(value) || resolve(value) !== value) {
    return false;
  }
  try {
    return canonicalizeNativeSessionRoot(value) === value;
  } catch {
    return false;
  }
}

export function isCanonicalNativeSessionId(value: unknown): value is string {
  return typeof value === "string" && hasNoSurroundingWhitespace(value);
}
