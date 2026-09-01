import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  UNSUPPORTED,
  collectRuntimeBuildIdentity,
  createProductionRuntimeIdentityPorts
} from "../observability/runtimeIdentity.js";
import { readCurrentHomeIdentity } from "../storage/currentTaskStore.js";
import {
  detectRunningRelease,
  readActiveReleasePointer,
  releaseDirectoryName,
  type ActiveReleasePointer,
  type RuntimeReleaseManifest
} from "./runtimeRelease.js";

export type CliInvocationSource =
  | "unregistered-home"
  | "active-release"
  | "release-activation"
  | "installed-release"
  | "published-package"
  | "checkout-local"
  | "unverified-local";

/**
 * Prevent a checkout or otherwise unverified CLI from entering a Home that is
 * already owned by an immutable active release. This fence runs before any
 * TaskStore is opened, so even schema discovery cannot advance SQLite state.
 * Published global packages remain the stable ordinary CLI boundary; an exact
 * installed release may also run when it is active or is the explicit handover
 * target.
 */
export function assertCliHomeReleaseFence(input: Readonly<{
  home: string;
  packageRoot: string;
  entryPath: string;
  args: readonly string[];
}>): CliInvocationSource {
  const active = readActiveReleasePointer(input.home);
  if (active === null) return "unregistered-home";

  const running = detectRunningRelease(input.entryPath);
  if (running !== null) {
    if (matchesActiveRelease(running.manifest, active)) return "active-release";
    if (isExplicitActivation(input.args, running.manifest)) return "release-activation";
    throw fenceError(input, active, "installed-release", running.manifest);
  }

  const build = collectRuntimeBuildIdentity(
    createProductionRuntimeIdentityPorts(input.packageRoot, input.entryPath)
  );
  const distribution = readPackageDistribution(input.packageRoot);
  if (distribution === "published" && build.sourceCommit === UNSUPPORTED) {
    return "published-package";
  }

  const source = distribution === "checkout" || build.sourceCommit !== UNSUPPORTED
    ? "checkout-local"
    : "unverified-local";
  throw fenceError(input, active, source, undefined, build);
}

/** Render bounded, non-secret identity evidence for a migration diagnosis. */
export function describeCliHomeInvocation(input: Readonly<{
  home: string;
  packageRoot: string;
  entryPath: string;
}>): string {
  const running = detectRunningRelease(input.entryPath);
  const collected = collectRuntimeBuildIdentity(
    createProductionRuntimeIdentityPorts(input.packageRoot, input.entryPath)
  );
  const distribution = readPackageDistribution(input.packageRoot);
  const source: CliInvocationSource = running !== null
    ? "installed-release"
    : distribution === "published" && collected.sourceCommit === UNSUPPORTED
      ? "published-package"
      : distribution === "checkout" || collected.sourceCommit !== UNSUPPORTED
        ? "checkout-local"
        : "unverified-local";
  let homeId = "unknown";
  try {
    homeId = readCurrentHomeIdentity(input.home).homeId;
  } catch {
    // The primary migration error remains authoritative when identity is unreadable.
  }
  let activeRelease = "none";
  let activeBuild = "none";
  try {
    const active = readActiveReleasePointer(input.home);
    if (active !== null) {
      activeRelease = active.releaseId;
      activeBuild = active.buildId;
    }
  } catch {
    activeRelease = "unreadable";
    activeBuild = "unreadable";
  }
  const version = running?.manifest.version ?? collected.packageVersion;
  const buildId = running?.manifest.buildId
    ?? (source === "checkout-local" ? "checkout" : source);
  const sourceCommit = running?.manifest.sourceCommit ?? (
    collected.sourceCommit === UNSUPPORTED ? "unknown" : collected.sourceCommit
  );
  return [
    `CLI: version=${diagnostic(version)} build=${diagnostic(buildId)} sourceCommit=${diagnostic(sourceCommit)}`,
    `Home: homeId=${diagnostic(homeId)} activeRelease=${diagnostic(activeRelease)} activeBuild=${diagnostic(activeBuild)}`,
    `Invocation: source=${source}`
  ].join("\n");
}

function matchesActiveRelease(
  manifest: RuntimeReleaseManifest,
  active: ActiveReleasePointer
): boolean {
  return active.releaseId === releaseDirectoryName(manifest)
    && active.version === manifest.version
    && active.buildId === manifest.buildId
    && active.packageDigest === manifest.packageDigest;
}

function isExplicitActivation(
  args: readonly string[],
  manifest: RuntimeReleaseManifest
): boolean {
  if (args.length !== 3 || args[0] !== "release" || args[1] !== "activate") return false;
  return args[2] === releaseDirectoryName(manifest) || args[2] === manifest.buildId;
}

function readPackageDistribution(packageRoot: string): "checkout" | "published" | "unknown" {
  try {
    const value = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      private?: unknown;
    };
    if (value.private === true) return "checkout";
    if (value.private === false) return "published";
  } catch {
    // A missing or damaged package identity is not publication evidence.
  }
  return "unknown";
}

function fenceError(
  input: Readonly<{ home: string; packageRoot: string; entryPath: string }>,
  active: ActiveReleasePointer,
  source: "checkout-local" | "installed-release" | "unverified-local",
  release?: RuntimeReleaseManifest,
  collected = collectRuntimeBuildIdentity(
    createProductionRuntimeIdentityPorts(input.packageRoot, input.entryPath)
  )
): Error {
  let homeId = "unknown";
  try {
    homeId = readCurrentHomeIdentity(input.home).homeId;
  } catch {
    // The release fence must still diagnose and reject an unreadable Home.
  }
  const version = release?.version ?? collected.packageVersion;
  const buildId = release?.buildId ?? (source === "checkout-local" ? "checkout" : "unknown");
  const sourceCommit = release?.sourceCommit ?? (
    collected.sourceCommit === UNSUPPORTED ? "unknown" : collected.sourceCommit
  );
  return new Error([
    `Refusing ${source} CLI access to a Home owned by another active release.`,
    `CLI: version=${diagnostic(version)} build=${diagnostic(buildId)} sourceCommit=${diagnostic(sourceCommit)}`,
    `Home: homeId=${diagnostic(homeId)} activeRelease=${diagnostic(active.releaseId)} activeBuild=${diagnostic(active.buildId)}`,
    `Invocation: source=${source}`,
    "Use the published global yui for this Home, or run make install-local without overriding its isolated YUI_HOME."
  ].join("\n"));
}

function diagnostic(value: string): string {
  return value.replace(/[^A-Za-z0-9._:+/@-]/gu, "?").slice(0, 160);
}
