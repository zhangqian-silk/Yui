/**
 * Scalar storage version constants.
 *
 * These live in their own module so that `storageSchema.ts`, `recordVersions.ts`,
 * and `taskStore.ts` can all import them without creating a circular dependency.
 * `storageSchema.ts` re-exports them for backward compatibility.
 */

/** Version of the on-disk layout (`schema.json`, root `state.json`, and locks). */
export const CURRENT_STORAGE_LAYOUT_VERSION = 6;

/** Version of the authoritative aggregate stored in `state.json`. */
export const CURRENT_AGGREGATE_SCHEMA_VERSION = 17;
