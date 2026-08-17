// Shared runtime-package digest and release-manifest logic (Issue 02).
//
// The manifest is the immutable identity of one assembled runtime package:
// semantic version, source commit (when known), a content-derived build ID,
// and a per-file SHA-256 inventory. The package digest is computed over the
// sorted inventory lines, so the manifest file itself is never part of its
// own digest. Both the assembler and the release installer verify the exact
// same algorithm; a drifted or edited release fails closed.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const RELEASE_MANIFEST_FILE = "release-manifest.json";

// Files that carry no release identity: the manifest describes everything
// else, and the smoke receipt is written by the installer after a successful
// smoke run.
const NON_MANIFEST_FILES = new Set([RELEASE_MANIFEST_FILE, "smoke-receipt.json"]);

/** One regular file in the immutable release inventory. */
export function inventoryFile(root, relativePath) {
  const absolute = resolve(root, relativePath);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime release entry must be one regular file: ${relativePath}.`);
  }
  const sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  return { path: relativePath, sha256, bytes: metadata.size };
}

/** Recursively lists every regular file below a release/staging directory. */
export function listReleaseFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativeName = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listReleaseFiles(child, relativeName));
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Runtime release tree contains an unsupported entry: ${relativeName}.`);
    }
    if (NON_MANIFEST_FILES.has(relativeName)) continue;
    files.push(relativeName);
  }
  return files.sort();
}

/**
 * The package digest: SHA-256 over the sorted inventory. Each line pins one
 * file's path, digest, and byte length, so any content or shape change changes
 * the package digest.
 */
export function computePackageDigest(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))) {
    hash.update(`${file.path}\0${file.sha256}\0${file.bytes}\n`);
  }
  return hash.digest("hex");
}

/** Builds the immutable manifest for one assembled package directory. */
export function buildReleaseManifest(directory, input) {
  const version = requireText(input?.version, "Release version");
  const files = listReleaseFiles(directory).map((name) => inventoryFile(directory, name));
  const packageDigest = computePackageDigest(files);
  const sourceCommit = typeof input?.sourceCommit === "string" && input.sourceCommit.length > 0
    ? input.sourceCommit
    : undefined;
  return {
    schemaVersion: 1,
    version,
    buildId: `${version}-${packageDigest.slice(0, 12)}`,
    packageDigest,
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    files,
    assembledAt: new Date().toISOString()
  };
}

/**
 * Verifies an installed release directory against its manifest. Any missing
 * file, extra file, content drift, symlink, or digest mismatch throws: the
 * release is not safe to activate.
 */
export function verifyReleaseIntegrity(directory) {
  const manifestPath = join(directory, RELEASE_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`Runtime release is missing its manifest: ${manifestPath}.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifestShape(manifest);
  const actual = listReleaseFiles(directory).map((name) => inventoryFile(directory, name));
  const expected = [...manifest.files].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  if (actual.length !== expected.length) {
    throw new Error(
      `Runtime release file count drifted from its manifest `
        + `(expected ${expected.length}, found ${actual.length}).`
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedFile = expected[index];
    const actualFile = actual[index];
    if (
      expectedFile.path !== actualFile.path
      || expectedFile.sha256 !== actualFile.sha256
      || expectedFile.bytes !== actualFile.bytes
    ) {
      throw new Error(`Runtime release content drifted from its manifest: ${expectedFile.path}.`);
    }
  }
  if (computePackageDigest(actual) !== manifest.packageDigest) {
    throw new Error("Runtime release package digest does not match its manifest.");
  }
  return manifest;
}

/**
 * A release directory must be an immutable, self-contained tree: no Git
 * worktree metadata and no symbolic links anywhere below it.
 */
export function assertReleaseIsNotWorktreeOrLinked(directory) {
  const root = resolve(directory);
  for (const gitMarker of [".git", ".gitfile"]) {
    if (existsSync(join(root, gitMarker))) {
      throw new Error(
        `Runtime release directory must not be a Git worktree: ${root} `
          + `(found ${gitMarker}).`
      );
    }
  }
  assertNoSymlinks(root, root);
}

function assertNoSymlinks(directory, root) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Runtime release directory must not contain symbolic links: `
          + `${relative(root, child)}.`
      );
    }
    if (entry.isDirectory()) assertNoSymlinks(child, root);
  }
}

function validateManifestShape(manifest) {
  if (
    manifest === null
    || typeof manifest !== "object"
    || manifest.schemaVersion !== 1
    || typeof manifest.version !== "string"
    || manifest.version.length === 0
    || typeof manifest.buildId !== "string"
    || manifest.buildId.length === 0
    || typeof manifest.packageDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(manifest.packageDigest)
    || !Array.isArray(manifest.files)
    || manifest.files.some((file) => (
      file === null
      || typeof file !== "object"
      || typeof file.path !== "string"
      || file.path.length === 0
      || typeof file.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
    ))
  ) {
    throw new Error("Runtime release manifest is invalid.");
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
