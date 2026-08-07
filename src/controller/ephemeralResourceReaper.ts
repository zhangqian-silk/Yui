import { cleanControllerResource } from "./resourceCleanupLinux.js";
import {
  scanControllerResourceInventory,
  type ControllerInventoryScanOptions
} from "./resourceInventoryLinux.js";
import type { ControllerResourceInventory, RuntimeResource } from "./resourceInventory.js";

export type EphemeralResourceReapResult = Readonly<{
  scanned: number;
  candidates: number;
  cleaned: number;
  failed: readonly Readonly<{ id: string; message: string }>[];
  expiredDomains?: readonly Readonly<{ yuiHome: string; token?: string }>[];
}>;

export type EphemeralResourceReaperOptions = Readonly<{
  scan?: () => Promise<ControllerResourceInventory>;
  clean?: (resource: RuntimeResource) => Promise<void>;
  onExpiredDomain?: (domain: Readonly<{ yuiHome: string; token?: string }>) => void;
}>;

/**
 * One bounded, idempotent pass over expired explicitly-marked test domains.
 * Every candidate is rescanned and fingerprint-checked before the existing
 * identity-fenced cleanup executor is invoked. Unknown or concurrent state is
 * reported and left for the next periodic pass.
 */
export async function reapExpiredEphemeralResources(
  options: EphemeralResourceReaperOptions = {}
): Promise<EphemeralResourceReapResult> {
  const scan = options.scan ?? (() => Promise.reject(
    new Error("Ephemeral resource scanner is unavailable.")
  ));
  const clean = options.clean ?? ((resource) => cleanControllerResource(resource));
  const initial = await scan();
  const candidates = initial.resources
    .filter(isExpiredEphemeralResource)
    .filter((resource) => isDomainIdentityReadyForCleanup(resource, initial.resources))
    .sort(compareCleanupOrder);
  if (candidates.length === 0) {
    const expiredDomains = safeExpiredDomains(initial)
      .filter((domain) => domainHasNoResources(initial, domain.yuiHome));
    for (const domain of expiredDomains) options.onExpiredDomain?.(domain);
    return {
      scanned: initial.domains.length,
      candidates: 0,
      cleaned: 0,
      failed: [],
      expiredDomains
    };
  }

  const revalidated = await scan();
  const eligibleExpiredDomains = safeExpiredDomains(revalidated);
  const byId = new Map(revalidated.resources.map((resource) => [resource.id, resource]));
  const failed: Array<{ id: string; message: string }> = [];
  let cleaned = 0;
  for (const candidate of candidates) {
    const current = byId.get(candidate.id);
    if (
      current === undefined
      || current.fingerprint !== candidate.fingerprint
      || !isExpiredEphemeralResource(current)
    ) {
      failed.push({ id: candidate.id, message: "changed-since-scan" });
      continue;
    }
    try {
      await clean(current);
      cleaned += 1;
    } catch (error) {
      failed.push({
        id: current.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  let expiredDomains: readonly Readonly<{ yuiHome: string; token?: string }>[] = [];
  if (failed.length === 0 && eligibleExpiredDomains.length > 0) {
    // A domain callback is authority to stop the detached Controller. Verify
    // the post-cleanup snapshot first so a retained identity, a concurrent
    // resource, or a newly appeared target cannot trigger self-close.
    const converged = await scan();
    expiredDomains = eligibleExpiredDomains.filter((domain) => (
      domainHasNoResources(converged, domain.yuiHome)
    ));
  }
  const result = {
    scanned: revalidated.domains.length,
    candidates: candidates.length,
    cleaned,
    failed,
    expiredDomains
  };
  if (failed.length === 0) {
    for (const domain of expiredDomains) options.onExpiredDomain?.(domain);
  }
  return result;
}

export function createEphemeralResourceReaper(
  options: ControllerInventoryScanOptions & Pick<EphemeralResourceReaperOptions, "onExpiredDomain">
): () => Promise<EphemeralResourceReapResult> {
  return () => reapExpiredEphemeralResources({
    scan: () => scanControllerResourceInventory(options),
    clean: (resource) => cleanControllerResource(resource, {
      environment: options.environment
    }),
    onExpiredDomain: options.onExpiredDomain
  });
}

function isExpiredEphemeralResource(resource: RuntimeResource): boolean {
  return resource.domain?.kind === "ephemeral-test"
    && resource.domain.liveness === "expired"
    && resource.domain.disposition === "safe"
    && resource.disposition === "safe";
}

function isDomainIdentityReadyForCleanup(
  resource: RuntimeResource,
  resources: readonly RuntimeResource[]
): boolean {
  if (resource.artifact?.artifactKind !== "domain-identity") return true;
  // Keep the durable domain fence until every other resource in that exact
  // home has converged. Otherwise a surviving tmux server would become an
  // unmarked/review resource on the next scan and could never trigger the
  // Controller self-close. Deferring the identity to a later pass also keeps
  // one failed sibling cleanup from dropping the only remaining authority.
  return resources.every((candidate) => (
    candidate.id === resource.id || candidate.yuiHome !== resource.yuiHome
  ));
}

function safeExpiredDomains(
  snapshot: ControllerResourceInventory
): readonly Readonly<{ yuiHome: string; token?: string }>[] {
  return snapshot.domains
    .filter((domain) => (
      domain.domainKind === "ephemeral-test"
      && domain.liveness === "expired"
      && domain.disposition === "safe"
      && snapshot.resources
        .filter((resource) => resource.yuiHome === domain.yuiHome)
        .every(isExpiredEphemeralResource)
    ))
    .map((domain) => ({
      yuiHome: domain.yuiHome,
      ...(domain.token === undefined ? {} : { token: domain.token })
    }));
}

function domainHasNoResources(
  snapshot: ControllerResourceInventory,
  yuiHome: string
): boolean {
  return snapshot.resources.every((resource) => resource.yuiHome !== yuiHome);
}

function compareCleanupOrder(left: RuntimeResource, right: RuntimeResource): number {
  const order = (resource: RuntimeResource): number => resource.artifact === undefined
    ? resource.kind === "controller" ? 0
      : resource.kind === "agent-session" ? 1
        : resource.kind === "tmux-server" ? 2 : 3
    : 4;
  const byKind = order(left) - order(right);
  return byKind !== 0 ? byKind : left.id.localeCompare(right.id);
}
