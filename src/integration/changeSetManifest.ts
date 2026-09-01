import {
  normalizedUniqueText,
  requireText
} from "../domain/validation.js";

export const CHANGE_SET_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Semantic tags derived from a ChangeSet's diff.  They power read-only overlap
 * diagnostics between parallel Tasks; they never gate development.
 */
export type ChangeSetManifestTag =
  | "contract"
  | "schema"
  | "migration"
  | "command"
  | "test"
  | "snapshot"
  | "package"
  | "deletion";

export const CHANGE_SET_MANIFEST_TAGS: readonly ChangeSetManifestTag[] = [
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
 * Lightweight integration manifest for one ChangeSet.
 *
 * `tags` and `deletedPaths` are derived from the diff at capture time; `targetRef` is the
 * intended integration target; `evidenceRefs` point at durable verification
 * evidence (for example `review-round:<id>` or `integration-check:<attempt>`).
 */
export type ChangeSetManifest = Readonly<{
  schemaVersion: 1;
  tags: readonly ChangeSetManifestTag[];
  deletedPaths: readonly string[];
  targetRef?: string;
  evidenceRefs: readonly string[];
}>;

export type CreateChangeSetManifestInput = Readonly<{
  tags: readonly ChangeSetManifestTag[];
  deletedPaths: readonly string[];
  targetRef?: string;
  evidenceRefs?: readonly string[];
}>;

export function createChangeSetManifest(
  input: CreateChangeSetManifestInput
): ChangeSetManifest {
  return validateChangeSetManifest({
    schemaVersion: CHANGE_SET_MANIFEST_SCHEMA_VERSION,
    tags: [...input.tags],
    deletedPaths: [...input.deletedPaths],
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef })
  });
}

export function validateChangeSetManifest(manifest: ChangeSetManifest): ChangeSetManifest {
  if (manifest.schemaVersion !== CHANGE_SET_MANIFEST_SCHEMA_VERSION) {
    throw new Error("ChangeSet manifest must use schemaVersion 1.");
  }
  if (!Array.isArray(manifest.tags)) {
    throw new Error("ChangeSet manifest tags must be an array.");
  }
  for (const tag of manifest.tags) {
    if (!CHANGE_SET_MANIFEST_TAGS.includes(tag)) {
      throw new Error(`ChangeSet manifest tag is invalid: ${String(tag)}.`);
    }
  }
  const tags = normalizedUniqueText(
    manifest.tags,
    "ChangeSet manifest tag"
  ) as readonly ChangeSetManifestTag[];
  const deletedPaths = normalizedUniqueText(
    manifest.deletedPaths,
    "ChangeSet manifest deleted path"
  );
  const evidenceRefs = normalizedUniqueText(
    manifest.evidenceRefs,
    "ChangeSet manifest evidence reference"
  );
  return {
    schemaVersion: CHANGE_SET_MANIFEST_SCHEMA_VERSION,
    tags,
    deletedPaths,
    evidenceRefs,
    ...(manifest.targetRef === undefined ? {} : {
      targetRef: requireText(manifest.targetRef, "ChangeSet manifest target ref")
    })
  };
}
