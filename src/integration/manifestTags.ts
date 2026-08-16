import type { ChangeSetManifestTag } from "./changeSetManifest.js";

/**
 * Derive semantic tags from a ChangeSet's changed paths.
 *
 * The heuristics are intentionally project-agnostic: they classify by path
 * shape so any repository gets useful overlap diagnostics without declaring
 * its file list up front.  The result is sorted and deduplicated.
 */
export function deriveManifestTags(input: Readonly<{
  changedPaths: readonly string[];
  deletedPaths?: readonly string[];
}>): readonly ChangeSetManifestTag[] {
  const tags = new Set<ChangeSetManifestTag>();
  for (const path of input.changedPaths) {
    for (const tag of manifestTagsForPath(path)) tags.add(tag);
  }
  if (input.deletedPaths !== undefined && input.deletedPaths.length > 0) {
    tags.add("deletion");
  }
  return CHANGE_SET_TAG_ORDER.filter((tag) => tags.has(tag));
}

const CHANGE_SET_TAG_ORDER: readonly ChangeSetManifestTag[] = [
  "contract",
  "schema",
  "migration",
  "command",
  "test",
  "snapshot",
  "package",
  "deletion"
];

/**
 * Classify a single changed path by every semantic tag it matches.  Overlap
 * diagnostics use this to attribute shared paths to a finding category.
 */
export function manifestTagsForPath(path: string): readonly ChangeSetManifestTag[] {
  const normalized = path.split("\\").join("/");
  const segments = normalized.split("/");
  const file = segments.at(-1) ?? normalized;
  const lower = normalized.toLowerCase();
  const lowerFile = file.toLowerCase();
  const tags: ChangeSetManifestTag[] = [];
  if (isPackageFile(lower, lowerFile)) tags.push("package");
  if (isMigrationPath(lower, segments)) tags.push("migration");
  if (isSchemaPath(lower, lowerFile)) tags.push("schema");
  if (isSnapshotPath(lower, lowerFile)) tags.push("snapshot");
  if (isCommandPath(lower, segments, lowerFile)) tags.push("command");
  if (isContractPath(lower, segments, lowerFile)) tags.push("contract");
  if (isTestPath(lower, segments, lowerFile)) tags.push("test");
  return tags;
}

function isPackageFile(lowerPath: string, lowerFile: string): boolean {
  return lowerFile === "package.json"
    || lowerFile === "package-lock.json"
    || lowerPath.endsWith("/package.json")
    || lowerPath.endsWith("/package-lock.json");
}

function isMigrationPath(lowerPath: string, segments: readonly string[]): boolean {
  return segments.some((segment) => segment === "migration" || segment === "migrations")
    || /(?:^|\/)migrations?\//u.test(lowerPath);
}

function isSchemaPath(lowerPath: string, lowerFile: string): boolean {
  return lowerFile.includes("schema")
    || lowerPath.includes("/schema/")
    || lowerPath.includes("/schemas/");
}

function isSnapshotPath(lowerPath: string, lowerFile: string): boolean {
  return lowerPath.includes("/__snapshots__/")
    || lowerFile.endsWith(".snap");
}

function isCommandPath(
  lowerPath: string,
  segments: readonly string[],
  lowerFile: string
): boolean {
  return segments.includes("commands")
    || lowerFile.startsWith("cli")
    || lowerPath.includes("/bin/");
}

function isContractPath(
  lowerPath: string,
  segments: readonly string[],
  lowerFile: string
): boolean {
  return lowerFile === "index.ts"
    || lowerFile === "index.js"
    || lowerFile === "index.mjs"
    || lowerFile.endsWith(".d.ts")
    || lowerFile.startsWith("protocol")
    || lowerPath.includes("/api/")
    || lowerPath.includes("/contract/")
    || lowerPath.includes("/contracts/");
}

function isTestPath(
  lowerPath: string,
  segments: readonly string[],
  lowerFile: string
): boolean {
  if (segments.includes("test") || segments.includes("tests") || segments.includes("__tests__")) {
    return true;
  }
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/u.test(lowerFile)
    || lowerFile.endsWith(".test.js")
    || lowerFile.endsWith(".test.ts")
    || lowerFile.endsWith(".spec.js")
    || lowerFile.endsWith(".spec.ts");
}
