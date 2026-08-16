import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeTextFileAtomically } from "../storage/durableFile.js";
import type { ReleaseStepEffect } from "./releaseWorkflowPorts.js";

/**
 * Durable adapter-level idempotency for the real release-workflow adapter.
 *
 * The engine already prevents duplicate effects within a workflow run (it
 * never re-submits a step it has marked terminal, and re-attempts after a
 * crash are serialized by a cross-process lock). The residual window is the
 * crash AFTER the external effect landed but BEFORE the engine persisted the
 * step result: a resumed process re-invokes `executeStep` under the same
 * idempotency key, and without this store the shell command runs a second
 * time. This store makes `executeStep` idempotent across processes: a
 * recorded successful effect is replayed instead of re-executed.
 *
 * Only SUCCEEDED effects are recorded. A failed effect produced no confirmed
 * landing (and the engine retries failed steps), so caching it would strand
 * recoverable failures; a timeout is re-queried authoritatively by the
 * engine and re-executed only when the effect is proven absent.
 *
 * Layout
 * ------
 * Each key is its own record file under `release-idempotency/`, named by the
 * percent-encoded key. There is deliberately no whole-map cache and no
 * whole-file rewrite: two processes that record different keys touch
 * different files, so neither can clobber the other, and a process that
 * crashes mid-write leaves at most one stale temp file (the atomic
 * temp+rename in `writeTextFileAtomically` never exposes a partial record).
 * The temp filename carries the writer pid and a UUID, so two processes
 * never share a temp pathname.
 *
 * Every record carries `schemaVersion: 1`. A record whose version is unknown,
 * whose key does not match the file it was read from, or whose effect is not
 * a succeeded effect fails closed (the read throws) rather than being
 * silently skipped: at-most-once cannot be proven from a corrupt record.
 *
 * A persistence failure is propagated, never swallowed. The adapter converts
 * an unpersisted success into an ambiguous/fail-closed outcome; reporting
 * success for an effect whose dedup record did not land would let a crash
 * re-run the effect.
 *
 * Unsupported layouts
 * -------------------
 * The per-key `schemaVersion: 1` layout is the only supported format. A
 * legacy whole-map file (`release-idempotency.json`) from an unsupported
 * older layout is never auto-migrated: it fails closed with a bounded
 * diagnostic so the operator can inspect and clean it up deliberately.
 */

export const RELEASE_IDEMPOTENCY_SCHEMA_VERSION = 1;

const DIRECTORY_NAME = "release-idempotency";
const LEGACY_FILE_NAME = "release-idempotency.json";

type StoredReleaseIdempotencyRecord = Readonly<{
  schemaVersion: typeof RELEASE_IDEMPOTENCY_SCHEMA_VERSION;
  key: string;
  effect: ReleaseStepEffect;
  recordedAt: string;
}>;

export type ReleaseIdempotencyStore = Readonly<{
  /** The recorded successful effect for this key, or undefined when absent. */
  load(key: string): Promise<ReleaseStepEffect | undefined>;
  /**
   * Record a successful effect so a later call with the same key replays it.
   * Throws when the record cannot be persisted; the caller must not report
   * the effect as a clean success in that case.
   */
  recordSuccess(key: string, effect: ReleaseStepEffect): Promise<void>;
}>;

export function createFileReleaseIdempotencyStore(
  home: string,
  now: () => Date = () => new Date()
): ReleaseIdempotencyStore {
  const directory = join(home, DIRECTORY_NAME);
  const legacyPath = join(home, LEGACY_FILE_NAME);

  function recordPath(key: string): string {
    // encodeURIComponent is injective and leaves only Linux-filename-safe
    // characters unescaped, so distinct keys never collide on disk.
    return join(directory, `${encodeURIComponent(key)}.json`);
  }

  /**
   * Fail closed when an unsupported legacy whole-map file is present.
   * The per-key layout is the only supported format; a whole-map file
   * from an unsupported older layout must not be silently trusted.
   */
  function rejectLegacyLayout(): void {
    if (existsSync(legacyPath)) {
      throw new Error(
        `unsupported legacy release idempotency layout: ${legacyPath} ` +
        `(whole-map file). Remove it after inspecting its contents; ` +
        `the per-key schemaVersion 1 layout is the only supported format.`
      );
    }
  }

  return {
    async load(key) {
      try {
        rejectLegacyLayout();
        const path = recordPath(key);
        if (!existsSync(path)) return undefined;
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return requireRecord(parsed, key).effect;
      } catch (error) {
        throw new Error(
          `release idempotency store cannot be read: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async recordSuccess(key, effect) {
      if (effect.outcome !== "succeeded") {
        throw new Error(
          `release idempotency store only records succeeded effects: ${effect.outcome}`
        );
      }
      try {
        rejectLegacyLayout();
        const record: StoredReleaseIdempotencyRecord = Object.freeze({
          schemaVersion: RELEASE_IDEMPOTENCY_SCHEMA_VERSION,
          key,
          effect,
          recordedAt: now().toISOString()
        });
        writeTextFileAtomically(recordPath(key), JSON.stringify(record, null, 2));
      } catch (error) {
        // Propagate: the adapter must not turn an unpersisted success into a
        // successful return.
        throw new Error(
          `release idempotency store cannot be written: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
}

/** An in-memory store for tests; two instances over the same map simulate processes. */
export function createInMemoryReleaseIdempotencyStore(
  backing?: Map<string, StoredReleaseIdempotencyRecord>
): ReleaseIdempotencyStore {
  const records = backing ?? new Map<string, StoredReleaseIdempotencyRecord>();
  return {
    async load(key) {
      return records.get(key)?.effect;
    },
    async recordSuccess(key, effect) {
      if (effect.outcome !== "succeeded") {
        throw new Error(
          `release idempotency store only records succeeded effects: ${effect.outcome}`
        );
      }
      records.set(key, {
        schemaVersion: RELEASE_IDEMPOTENCY_SCHEMA_VERSION,
        key,
        effect,
        recordedAt: new Date(0).toISOString()
      });
    }
  };
}

/**
 * Strictly validate one per-key record. Fails closed on any drift: an unknown
 * schema version, a key that does not name the file it was read from, or a
 * non-succeeded effect.
 */
function requireRecord(value: unknown, expectedKey: string): StoredReleaseIdempotencyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("idempotency record is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RELEASE_IDEMPOTENCY_SCHEMA_VERSION) {
    throw new Error(
      `idempotency record schemaVersion is ${String(record.schemaVersion)}, ` +
      `expected ${RELEASE_IDEMPOTENCY_SCHEMA_VERSION}`
    );
  }
  if (typeof record.key !== "string" || record.key !== expectedKey) {
    throw new Error(
      `idempotency record key ${String(record.key)} does not match ${expectedKey}`
    );
  }
  const effect = requireSucceededEffect(record.effect);
  if (typeof record.recordedAt !== "string" || record.recordedAt.length === 0) {
    throw new Error("idempotency record recordedAt is invalid");
  }
  return Object.freeze({
    schemaVersion: RELEASE_IDEMPOTENCY_SCHEMA_VERSION,
    key: record.key,
    effect,
    recordedAt: record.recordedAt
  });
}

function requireSucceededEffect(value: unknown): ReleaseStepEffect {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("idempotency record effect is not an object");
  }
  const effect = value as Record<string, unknown>;
  if (effect.outcome !== "succeeded") {
    throw new Error(`idempotency record effect outcome is ${String(effect.outcome)}, expected succeeded`);
  }
  return value as ReleaseStepEffect;
}
