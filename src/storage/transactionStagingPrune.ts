import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { canonicalStorageOwnerUid } from "./authoritativeStorage.js";
import { executeDomainExclusiveBarrier } from "./domainTransaction.js";
import {
  inspectDirectoryAt,
  removeExactEntry,
  renameNoReplaceExact,
  withPinnedRootAt,
  type NativeExactIdentity,
  type NativePinnedRootReader,
  type NativePublicationReceipt,
  type NativeStableAncestorBarrier
} from "./nativeStorageFs.js";

const STAGING_DIRECTORY = "runtime/domain-staging";
const TERMINAL_STAGE_PATTERN = /^[A-Za-z0-9_-]+\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Retires terminal transaction staging under A1's exclusive barrier and only
 * then removes its exact private identity. A replaced public name is never
 * consumed by cleanup.
 */
export function pruneTerminalTransactionStaging(
  rootDir: string,
  dryRun: boolean
): number {
  return executeDomainExclusiveBarrier(rootDir, ({ barrier, rootIdentity }) =>
    withPinnedRootAt(barrier, ".", rootIdentity, (reader) => {
      if (reader === undefined || reader.lstat(STAGING_DIRECTORY) === undefined) return 0;
      const candidates = reader.readdir(STAGING_DIRECTORY)
        .filter((name) => TERMINAL_STAGE_PATTERN.test(name))
        .sort();
      if (dryRun) return candidates.length;

      for (const name of candidates) {
        retireAndRemoveStage(barrier, reader, name);
      }
      return candidates.length;
    })
  );
}

function retireAndRemoveStage(
  barrier: NativeStableAncestorBarrier,
  reader: NativePinnedRootReader,
  name: string
): void {
  const sourcePath = `${STAGING_DIRECTORY}/${name}`;
  const source = requireOwnedDirectory(reader, sourcePath);
  const parent = requireDirectoryIdentity(barrier, STAGING_DIRECTORY);
  const quarantineName = `.prune-quarantine-${randomUUID()}`;
  renameNoReplaceExact(
    barrier,
    STAGING_DIRECTORY,
    parent,
    name,
    source,
    STAGING_DIRECTORY,
    parent,
    quarantineName
  );
  removePrivateTree(barrier, reader, `${STAGING_DIRECTORY}/${quarantineName}`);
}

function removePrivateTree(
  barrier: NativeStableAncestorBarrier,
  reader: NativePinnedRootReader,
  path: string
): void {
  let receipt = requireOwnedReceipt(reader, path);
  if (isDirectoryReceipt(receipt)) {
    for (const name of reader.readdir(path).slice().sort()) {
      removePrivateTree(barrier, reader, `${path}/${name}`);
    }
    receipt = requireOwnedDirectory(reader, path);
  } else if (!isFileReceipt(receipt)) {
    throw new Error("Transaction staging contains an unsupported private identity.");
  }

  const parentPath = normalizeParent(dirname(path));
  const parentBefore = requireDirectoryIdentity(barrier, parentPath);
  const expectedParentAfter = isDirectoryReceipt(receipt)
    ? { ...parentBefore, nlink: parentBefore.nlink - 1n }
    : parentBefore;
  removeExactEntry(
    barrier,
    parentPath,
    parentBefore,
    basename(path),
    receipt,
    isDirectoryReceipt(receipt) ? "directory" : "file",
    expectedParentAfter
  );
}

function requireOwnedDirectory(
  reader: NativePinnedRootReader,
  path: string
): NativePublicationReceipt {
  const receipt = requireOwnedReceipt(reader, path);
  if (!isDirectoryReceipt(receipt)) {
    throw new Error("Transaction staging identity is not one real directory.");
  }
  return receipt;
}

function requireOwnedReceipt(
  reader: NativePinnedRootReader,
  path: string
): NativePublicationReceipt {
  const receipt = reader.lstat(path);
  if (receipt === undefined) throw new Error("Transaction staging identity disappeared.");
  canonicalStorageOwnerUid({ uid: receipt.uid });
  return receipt;
}

function requireDirectoryIdentity(
  barrier: NativeStableAncestorBarrier,
  path: string
): NativeExactIdentity {
  const identity = inspectDirectoryAt(barrier, path);
  if (identity === undefined) throw new Error("Transaction staging parent disappeared.");
  canonicalStorageOwnerUid({ uid: identity.uid });
  return identity;
}

function isDirectoryReceipt(receipt: { mode: bigint }): boolean {
  return (receipt.mode & 0o170000n) === 0o040000n;
}

function isFileReceipt(receipt: { mode: bigint }): boolean {
  return (receipt.mode & 0o170000n) === 0o100000n;
}

function normalizeParent(path: string): string {
  return path === "." ? "." : path.split("\\").join("/");
}
