import test from "node:test";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { scanControllerResourceInventory } from "../../dist/controller/resourceInventoryLinux.js";

import {
  assertIsolationReady,
  createOwnedRunRoot,
  recordActiveSessionObservation
} from "./isolationPreflight.js";
import { resolveTier, tierIsPrivileged } from "./testTiers.js";

/**
 * Runs one Provider/Release body behind the mandatory isolation boundary.
 * The fixture owns the disposable root, registers cleanup before observation,
 * requires an explicit active-Session observer, and invokes the body only after
 * assertIsolationReady succeeds. There is no body-only or skip-preflight path.
 *
 * @param {{ after(callback: () => unknown): void }} testContext
 * @param {Readonly<{
 *   tier: string,
 *   checkoutRoot: string,
 *   temporaryBase?: string,
 *   environment?: NodeJS.ProcessEnv,
 *   protectedHomes?: readonly string[],
 *   globalNpmPrefix?: string | null,
 *   observeActiveSessions: (context: PrivilegedTestContext) => Promise<{sessions: readonly string[], source?: string}> | {sessions: readonly string[], source?: string},
 *   cleanup: (context: PrivilegedTestContext) => Promise<unknown> | unknown
 * }>} input
 * @param {(testContext: unknown, context: PrivilegedTestContext & {preflight: object}) => Promise<unknown> | unknown} body
 * @returns {Promise<unknown>}
 */
export async function runPrivilegedTestBoundary(testContext, input, body) {
  const tier = resolveTier(input?.tier);
  if (!tierIsPrivileged(tier.id)) {
    throw new Error(`privilegedTest requires Provider/Release tier, got ${tier.id}.`);
  }
  if (typeof testContext?.after !== "function") {
    throw new Error("privilegedTest requires node:test cleanup registration.");
  }
  if (typeof input?.observeActiveSessions !== "function") {
    throw new Error("privilegedTest observeActiveSessions is required before side effects.");
  }
  if (typeof input?.cleanup !== "function") {
    throw new Error("privilegedTest cleanup is required before side effects.");
  }
  if (typeof body !== "function") {
    throw new Error("privilegedTest body is required.");
  }
  if (typeof input.checkoutRoot !== "string" || !isAbsolute(input.checkoutRoot)) {
    throw new Error("privilegedTest checkoutRoot must be absolute.");
  }

  const checkoutRoot = resolve(input.checkoutRoot);
  const owned = createOwnedRunRoot({
    ...(input.temporaryBase === undefined ? {} : { temporaryBase: input.temporaryBase }),
    prefix: `yui-${tier.id}-`
  });
  const runtimeRoot = join(owned.canonicalRunRoot, "runtime-domain");
  const context = Object.freeze({
    tier: tier.id,
    checkoutRoot,
    runRoot: owned.canonicalRunRoot,
    runRootOwnership: owned.ownership,
    ownerToken: owned.token,
    launcherPath: join(checkoutRoot, "output", "dev", "bin", "yui"),
    runtimeRoot,
    yuiHome: join(runtimeRoot, "yui-home"),
    workspace: join(owned.canonicalRunRoot, "workspace"),
    npmPrefix: join(owned.canonicalRunRoot, "npm-prefix")
  });

  // Register the exact cleanup before observation, module loading, preflight,
  // or any privileged body code. A cleanup failure preserves the owned root as
  // evidence instead of masking live resources with a broad recursive removal.
  testContext.after(async () => {
    await input.cleanup(context);
    rmSync(context.runRoot, { recursive: true, force: true });
    if (existsSync(context.runRoot)) {
      throw new Error(`privilegedTest cleanup left its owned root: ${context.runRoot}`);
    }
  });

  const observed = await input.observeActiveSessions(context);
  const activeSessionObservation = recordActiveSessionObservation(observed);
  const preflight = assertIsolationReady({
    checkoutRoot,
    runRoot: context.runRoot,
    runRootOwnership: context.runRootOwnership,
    launcherPath: context.launcherPath,
    yuiHome: context.yuiHome,
    workspace: context.workspace,
    npmPrefix: context.npmPrefix,
    activeSessionObservation,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.protectedHomes === undefined ? {} : { protectedHomes: input.protectedHomes }),
    ...(input.globalNpmPrefix === undefined ? {} : { globalNpmPrefix: input.globalNpmPrefix })
  });

  return body(testContext, Object.freeze({ ...context, preflight }));
}

/**
 * Runner-owned active-Session observation. Scenario modules cannot replace this
 * seam or manufacture an empty observation: the privileged driver scans the
 * current user's complete Yui runtime inventory before loading scenario code.
 */
export async function observeActiveProductionSessions(context) {
  const inventory = await scanControllerResourceInventory({
    currentHome: context.yuiHome,
    scope: "all",
    environment: process.env
  });
  if (inventory.warnings.length > 0) {
    throw new Error(
      "Privileged preflight could not prove active Session state: "
      + inventory.warnings.join("; ")
    );
  }
  const sessions = inventory.resources
    .filter((resource) => (
      resource.kind === "agent-session" && resource.state !== "dead"
      || resource.kind === "process" && resource.reasonCode === "orphan-agent"
    ))
    .map((resource) => resource.id);
  return Object.freeze({
    sessions: Object.freeze(sessions),
    source: `runner-owned Yui resource inventory at ${inventory.observedAt}`
  });
}

const PRIVILEGED_SCENARIO_RUNTIME = Object.freeze({
  observeActiveSessions: observeActiveProductionSessions
});

/**
 * Composes one manifest scenario with the mandatory boundary. Cleanup is
 * registered through runPrivilegedTestBoundary before observation. The module
 * import lives only in the body callback, so it is unreachable until every
 * preflight check passes. The runtime override is a deterministic core-test
 * seam; the manifest driver always uses the fixed runner-owned runtime above.
 */
export async function runPrivilegedScenarioBoundary(
  testContext,
  input,
  runtime = PRIVILEGED_SCENARIO_RUNTIME
) {
  if (typeof input?.scenarioName !== "string" || input.scenarioName.length === 0) {
    throw new Error("privileged scenario name is required.");
  }
  if (typeof input?.modulePath !== "string" || !isAbsolute(input.modulePath)) {
    throw new Error("privileged scenario modulePath must be absolute.");
  }

  let loadedScenario;
  return runPrivilegedTestBoundary(
    testContext,
    {
      tier: input.tier,
      checkoutRoot: input.checkoutRoot,
      ...(input.temporaryBase === undefined ? {} : { temporaryBase: input.temporaryBase }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      ...(input.protectedHomes === undefined ? {} : { protectedHomes: input.protectedHomes }),
      ...(input.globalNpmPrefix === undefined ? {} : { globalNpmPrefix: input.globalNpmPrefix }),
      observeActiveSessions: runtime?.observeActiveSessions,
      cleanup: async (context) => {
        if (loadedScenario === undefined) return;
        if (typeof loadedScenario.cleanup !== "function") {
          throw new Error(
            `${input.tier} scenario ${input.scenarioName} must export a cleanup function.`
          );
        }
        await loadedScenario.cleanup(context);
      }
    },
    async (scenarioTestContext, context) => {
      loadedScenario = await import(pathToFileURL(input.modulePath).href);
      if (
        typeof loadedScenario.cleanup !== "function"
        || typeof loadedScenario.run !== "function"
      ) {
        throw new Error(
          `${input.tier} scenario ${input.scenarioName} must export cleanup and run functions.`
        );
      }
      return loadedScenario.run(scenarioTestContext, context);
    }
  );
}

/**
 * The only registration wrapper used by privileged scenario drivers.
 */
export function privilegedTest(name, input, body) {
  return test(name, async (testContext) => (
    runPrivilegedTestBoundary(testContext, input, body)
  ));
}

/** The only registration wrapper used by manifested privileged scenarios. */
export function privilegedScenarioTest(name, input) {
  return test(name, async (testContext) => (
    runPrivilegedScenarioBoundary(testContext, {
      ...input,
      scenarioName: name
    })
  ));
}

/** @typedef {Readonly<{
 *   tier: string,
 *   checkoutRoot: string,
 *   runRoot: string,
 *   runRootOwnership: object,
 *   ownerToken: string,
 *   launcherPath: string,
 *   runtimeRoot: string,
 *   yuiHome: string,
 *   workspace: string,
 *   npmPrefix: string
 * }>} PrivilegedTestContext */
