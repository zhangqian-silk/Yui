import { resolve } from "node:path";

import { acquireHomeLifecycleLock } from "../core/controllerServer.js";
import { cleanControllerResource } from "./resourceCleanupLinux.js";
import type {
  ControllerResourceInventory,
  RuntimeResource
} from "./resourceInventory.js";
import { scanControllerResourceInventory } from "./resourceInventoryLinux.js";

const MAX_RECONCILIATION_PASSES = 4;

export type UpdateControllerReconciliationResult = Readonly<{
  cleaned: readonly string[];
}>;

/**
 * Reconcile only Controller-owned resources for the Home being updated.
 *
 * A current Controller is preserved for the update orchestrator's exact
 * capture/stop handoff. Superseded/orphaned Controller processes and stale
 * discovery/socket artifacts are cleaned using their existing process-start
 * and inode fingerprints. Agent, tmux, app, and foreign-Home resources are
 * deliberately outside this operation.
 */
export async function reconcileControllerResourcesForUpdate(
  home: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<UpdateControllerReconciliationResult> {
  const resolvedHome = resolve(home);
  const releaseLock = await acquireHomeLifecycleLock(resolvedHome, {
    removeStaleOwner: true
  });
  const cleaned = new Set<string>();
  try {
    for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass += 1) {
      const snapshot = await scanControllerResourceInventory({
        currentHome: resolvedHome,
        scope: "current",
        environment
      });
      assertCertainSnapshot(snapshot, resolvedHome);

      const resources = controllerResources(snapshot, resolvedHome);
      const controllers = resources.filter(({ kind }) => kind === "controller");
      const current = controllers.filter(({ state }) => state === "current");
      if (current.length > 1) {
        throw reconciliationBlocked(
          `multiple current Controllers were reported (${resourceLabels(current)})`
        );
      }

      const historical = controllers.filter(({ state }) => state !== "current");
      const historicalCleanup = historical.filter(isCleanupEligible);
      const unsafeHistorical = historical.filter((resource) => !isCleanupEligible(resource));
      if (unsafeHistorical.length > 0) {
        throw reconciliationBlocked(
          `historical Controller ownership is not safely cleanable (${resourceLabels(unsafeHistorical)})`
        );
      }

      const artifacts = resources.filter(isControllerArtifact);
      const staleArtifactCleanup = artifacts.filter((resource) => (
        resource.state === "stale" && isCleanupEligible(resource)
      ));
      const unresolvedArtifacts = artifacts.filter((resource) => (
        !staleArtifactCleanup.includes(resource)
      ));

      // A corrupt discovery is conservatively marked active while an orphan
      // Controller still exists. Remove the exactly fenced historical process
      // first; the next scan can then reclassify and remove the stale artifact.
      if (unresolvedArtifacts.length > 0 && historicalCleanup.length === 0) {
        throw reconciliationBlocked(
          `a Controller artifact is active or ownership is unknown (${resourceLabels(unresolvedArtifacts)})`
        );
      }

      const candidates = [...historicalCleanup, ...staleArtifactCleanup];
      if (candidates.length === 0) {
        return { cleaned: [...cleaned] };
      }

      for (const candidate of candidates) {
        try {
          await cleanControllerResource(candidate, { environment });
          cleaned.add(candidate.id);
        } catch (error) {
          // A concurrent exact cleanup that already reached the desired state
          // is harmless. Anything still present or reclassified is a real
          // ownership change and must remain a user-visible blocker.
          const afterFailure = await scanControllerResourceInventory({
            currentHome: resolvedHome,
            scope: "current",
            environment
          });
          assertCertainSnapshot(afterFailure, resolvedHome);
          if (!controllerResources(afterFailure, resolvedHome).some(({ id }) => id === candidate.id)) {
            cleaned.add(candidate.id);
            continue;
          }
          throw reconciliationBlocked(
            `resource ${candidate.id} changed or could not be cleaned: ${messageOf(error)}`
          );
        }
      }
    }
    throw reconciliationBlocked("Controller resources did not converge after bounded cleanup");
  } finally {
    await releaseLock();
  }
}

function assertCertainSnapshot(
  snapshot: ControllerResourceInventory,
  resolvedHome: string
): void {
  if (
    snapshot.scope !== "current"
    || resolve(snapshot.currentHome) !== resolvedHome
  ) {
    throw reconciliationBlocked("the Controller inventory returned a mismatched Home or scope");
  }
  if (snapshot.warnings.length > 0) {
    throw reconciliationBlocked(`the Controller inventory is uncertain: ${snapshot.warnings.join("; ")}`);
  }
}

function controllerResources(
  snapshot: ControllerResourceInventory,
  resolvedHome: string
): RuntimeResource[] {
  return snapshot.resources.filter((resource) => (
    resource.yuiHome === resolvedHome
    && (resource.kind === "controller" || isControllerArtifact(resource))
  ));
}

function isControllerArtifact(resource: RuntimeResource): boolean {
  return resource.kind === "artifact"
    && (resource.artifact?.artifactKind === "controller-discovery"
      || resource.artifact?.artifactKind === "controller-socket");
}

function isCleanupEligible(resource: RuntimeResource): boolean {
  return resource.disposition === "safe" || resource.disposition === "review";
}

function resourceLabels(resources: readonly RuntimeResource[]): string {
  return resources.map((resource) => `${resource.id}:${resource.reasonCode}`).join(", ");
}

function reconciliationBlocked(reason: string): Error {
  return new Error(
    `Automatic Controller reconciliation is blocked because ${reason}. `
      + "Run `yui controller status --verbose` and resolve only the reported current-Home resource before retrying."
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
