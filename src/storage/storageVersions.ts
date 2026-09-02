/**
 * Scalar storage version constants.
 *
 * These live in their own module so that `storageSchema.ts`, `recordVersions.ts`,
 * and `taskStore.ts` can all import them without creating a circular dependency.
 * `storageSchema.ts` re-exports them as the public storage-contract boundary.
 */

/**
 * Version of the on-disk layout (`schema.json` plus the SQLite database).
 *
 * Layout 8 is the current SQLite WAL control-plane layout: the authoritative
 * store is `yui.db`. Layout 8 is the only physical layout this release reads
 * and writes; logical aggregate upgrades within layout 8 use the centralized
 * adjacent migration graph.
 */
export const CURRENT_STORAGE_LAYOUT_VERSION = 8;

/** Aggregate 26 unifies Review direct/replicated execution and Turn main-Group provenance. */
export const CURRENT_AGGREGATE_SCHEMA_VERSION = 26;
