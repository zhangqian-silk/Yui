import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MigrationRegistry,
  StorageCompatibilityError,
  loadCompatibleSnapshot,
  type StorageVersionState
} from "./migration/index.js";
import { createProductionStorageRegistry } from "./migration/productionRegistry.js";
import {
  FileTaskStore,
  validateCurrentStorageStateSnapshot
} from "./taskStore.js";
import {
  ensureStorageSchema,
  inspectStorageSchema,
  STORAGE_SCHEMA_FILE
} from "./storageSchema.js";
import { classifyHome } from "./upgrade/homeClassification.js";
import {
  inspectSnapshotVersionState,
  type HomeSnapshot
} from "./upgrade/homeMigrationTarget.js";
import { latestStorageVersionState } from "./upgrade/recordVersions.js";

export { createProductionStorageRegistry } from "./migration/productionRegistry.js";

export type OpenCompatibleFileTaskStoreOptions = Readonly<{
  registry?: MigrationRegistry<HomeSnapshot>;
  latest?: StorageVersionState;
}>;

/**
 * Initialize a brand-new Home, or open an existing Home through the same
 * compatibility classification as every ordinary command. Setup is the one
 * ordinary flow that is also responsible for creating the initial manifest.
 */
export function initializeCompatibleFileTaskStore(
  home: string,
  options: OpenCompatibleFileTaskStoreOptions = {}
): FileTaskStore {
  if (inspectStorageSchema(home).status === "uninitialized") {
    ensureStorageSchema(home);
  }
  return openCompatibleFileTaskStore(home, options);
}

/**
 * Open current or explicitly compatible-old storage. Compatible records are
 * normalized in memory through strict old-shape validators; FileTaskStore then
 * runs its one current parser and its existing writer emits only current bytes.
 */
export function openCompatibleFileTaskStore(
  home: string,
  options: OpenCompatibleFileTaskStoreOptions = {}
): FileTaskStore {
  const registry = options.registry ?? createProductionStorageRegistry();
  const latest = options.latest ?? latestStorageVersionState();
  const classification = classifyHome({ home, registry, latest });
  switch (classification.classification.status) {
    case "current":
      return new FileTaskStore(home);
    case "compatible-old":
      return new FileTaskStore(home, {
        normalizeState: (raw) => normalizeState(home, raw, registry, latest)
      });
    case "migration-required":
      throw new StorageCompatibilityError(
        "Storage requires an offline migration. Re-run `yui update` when active Sessions are clear."
      );
    case "unsupported":
      throw new StorageCompatibilityError(describeUnsupported(classification.classification));
  }
}

/**
 * Eagerly prove that a compatible-old Home reaches the strict current parser.
 * Staged update/upgrade preflight uses this before any Controller or binary
 * action; ordinary commands may keep the store's normal lazy-read behavior.
 */
export function validateCompatibleFileTaskStore(
  home: string,
  options: OpenCompatibleFileTaskStoreOptions = {}
): void {
  openCompatibleFileTaskStore(home, options).getConfig();
}

function normalizeState(
  home: string,
  raw: string,
  registry: MigrationRegistry<HomeSnapshot>,
  latest: StorageVersionState
): string {
  let state: unknown;
  try {
    state = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new StorageCompatibilityError(
      `Compatible state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(state)) {
    throw new StorageCompatibilityError("Compatible state must be a JSON object.");
  }
  const schemaManifest = JSON.parse(
    readFileSync(join(home, STORAGE_SCHEMA_FILE), "utf8")
  ) as unknown;
  if (!isRecord(schemaManifest)) {
    throw new StorageCompatibilityError("Compatible schema manifest must be a JSON object.");
  }
  const snapshot: HomeSnapshot = { schemaManifest, state };
  const source = versionsOf(snapshot, latest);
  const normalized = loadCompatibleSnapshot({
    registry,
    source,
    latest,
    snapshot,
    inspectVersions: (candidate) => versionsOf(candidate, latest),
    validateCurrent: (candidate) => {
      if (candidate.state === null) {
        throw new StorageCompatibilityError("Compatible state unexpectedly disappeared.");
      }
      validateCurrentStorageStateSnapshot(candidate.state);
    }
  });
  return `${JSON.stringify(normalized.state)}\n`;
}

function versionsOf(
  snapshot: HomeSnapshot,
  latest: StorageVersionState
): StorageVersionState {
  const inspection = inspectSnapshotVersionState(snapshot, latest);
  if ("corruption" in inspection) {
    throw new StorageCompatibilityError(inspection.corruption.detail);
  }
  return inspection.source;
}

function describeUnsupported(
  classification: ReturnType<typeof classifyHome>["classification"]
): string {
  if (classification.verdict === "CORRUPTED") {
    return `Invalid state.json: ${classification.detail}`;
  }
  if (classification.verdict === "NEEDS_NEW_VERSION") {
    return classification.blocker.message;
  }
  return "Storage is unsupported by this Yui release.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
