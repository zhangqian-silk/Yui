import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEphemeralDomainIdentity,
  defaultEphemeralTmuxServer,
  ephemeralDomainEnvironment,
  recordEphemeralTmuxTarget,
  readEphemeralDomainIdentity,
  readLinuxProcessStartIdentity,
  removeEphemeralDomainIdentityIfUnchanged,
  writeEphemeralDomainIdentity
} from "../../dist/controller/domainIdentity.js";
import {
  ensureFileTaskController,
  stopFileTaskController
} from "../../dist/controller/clientRuntime.js";
import { scanControllerResourceInventory } from "../../dist/controller/resourceInventoryLinux.js";
import { cleanControllerResource } from "../../dist/controller/resourceCleanupLinux.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { NodeCommandExecutor } from "../../dist/tmux/commandExecutor.js";
import { TmuxManager, yuiTmuxServerName } from "../../dist/tmux/tmuxManager.js";

/**
 * Creates an isolated real YUI_HOME + Controller/tmux namespace for E2E tests.
 * Registering this fixture with a node:test TestContext makes cleanup run when
 * the test passes, fails an assertion, or aborts with an exception.
 */
export function createIsolatedRuntime(testContext, options = {}) {
  const requestedRoot = options.root;
  const root = requestedRoot === undefined
    ? mkdtempSync(join(tmpdir(), "yui-isolated-runtime-"))
    : requestedRoot;
  const retainRoot = options.retainRoot ?? requestedRoot !== undefined;
  if (requestedRoot !== undefined) assert.equal(existsSync(root), false);
  const home = join(root, "yui-home");
  const tmuxServer = yuiTmuxServerName(home);
  const identity = createEphemeralDomainIdentity({
    tmuxServer,
    tmuxTargets: [],
    hostPid: process.pid,
    hostProcessStartIdentity: readLinuxProcessStartIdentity(process.pid),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt })
  });
  const environment = Object.fromEntries(
    Object.entries({
      ...process.env,
      YUI_HOME: home,
      ...ephemeralDomainEnvironment(identity),
      ...(options.environment ?? {})
    }).filter(([, value]) => value !== undefined && value !== "")
  );
  ensureStorageSchema(home, new Date());
  writeEphemeralDomainIdentity(home, identity);
  let currentIdentity = identity;
  let controllerStarted = false;
  let closed = false;
  let tearingDown = false;

  const runtime = {
    root,
    home,
    environment,
    get identity() {
      return currentIdentity;
    },
    async startController() {
      await ensureFileTaskController(home, { environment });
      controllerStarted = true;
    },
    recordTmuxTarget(target) {
      if (!recordEphemeralTmuxTarget(home, currentIdentity.token, target)) {
        throw new Error(`Isolated runtime target fence was not recorded: ${target}`);
      }
      const current = readEphemeralDomainIdentity(home);
      if (current.status !== "valid") {
        throw new Error("Isolated runtime domain identity became unavailable.");
      }
      currentIdentity = current.identity;
      environment.YUI_EPHEMERAL_TMUX_TARGETS = JSON.stringify(
        currentIdentity.tmuxTargets
      );
    },
    tmux(options = {}) {
      const { executor, ...managerOptions } = options;
      const recordTarget = (target) => {
        runtime.recordTmuxTarget(target);
      };
      const baseExecutor = executor ?? new NodeCommandExecutor();
      const scopedExecutor = {
        run(command, args, runOptions = {}) {
          return baseExecutor.run(command, args, {
            ...runOptions,
            environment: {
              ...runtime.environment,
              ...(runOptions.environment ?? {})
            }
          });
        },
        ...(baseExecutor.runAsync === undefined ? {} : {
          runAsync(command, args, runOptions = {}) {
            return baseExecutor.runAsync(command, args, {
              ...runOptions,
              environment: {
                ...runtime.environment,
                ...(runOptions.environment ?? {})
              }
            });
          }
        })
      };
      const manager = new TmuxManager(
        environment.YUI_TMUX_BIN ?? "tmux",
        scopedExecutor,
        {
          ...managerOptions,
          yuiHome: home,
          onRoleTargetRecorded: recordTarget
        }
      );
      return manager;
    },
    async teardown() {
      if (closed || tearingDown) return;
      tearingDown = true;
      let failure;
      const remember = (error) => {
        if (failure === undefined) failure = error;
      };
      const cleanupResource = options.cleanupResource ?? cleanControllerResource;
      const ownedResource = (resource) => (
        resource.yuiHome === home
        && resource.domain?.kind === "ephemeral-test"
        && resource.domain.token === currentIdentity.token
      );
      const cleanup = async (resource) => {
        try {
          // This fixture is the exact owner of its marked Home. Inventory
          // protects an active host by default, but teardown is that owner's
          // explicit bounded cleanup request; retain the domain fence while
          // allowing the existing process/pane/artifact primitives to run.
          await cleanupResource(
            ownedResource(resource) ? { ...resource, disposition: "safe" } : resource,
            { environment }
          );
        } catch (error) {
          remember(error);
        }
      };
      const preserveIdentity = () => {
        const current = readEphemeralDomainIdentity(home);
        if (current.status === "absent") {
          writeEphemeralDomainIdentity(home, currentIdentity);
          return;
        }
        if (current.status !== "valid" || current.identity.token !== currentIdentity.token) {
          throw new Error("isolated runtime domain identity changed during teardown");
        }
        currentIdentity = current.identity;
      };
      const identityArtifact = (resource) => (
        resource.artifact?.artifactKind === "domain-identity"
      );
      const scan = async () => scanControllerResourceInventory({
        currentHome: home,
        scope: "current",
        environment
      });
      const cleanupPass = async (predicate) => {
        const snapshot = await scan();
        for (const resource of snapshot.resources.filter((candidate) => (
          !identityArtifact(candidate)
          && ownedResource(candidate)
          && predicate(candidate)
        ))) {
          await cleanup(resource);
        }
      };

      // Stop the detached Controller first, but keep converging if it is
      // already wedged. The inventory/cleanup executor fences every process
      // and artifact by its exact identity; no name or age guessing is used.
      if (controllerStarted || existsSync(join(home, "runtime", "controller.json"))) {
        try {
          await stopFileTaskController(home, { environment });
        } catch (error) {
          remember(error);
        }
      }

      try {
        // A Controller with no recorded panes removes its empty identity on a
        // normal close. Restore the exact same token/generation before any
        // inventory or cleanup so every later operation remains fenced.
        preserveIdentity();
      } catch (error) {
        remember(error);
      }

      // Reap the full Agent process trees before removing their tmux panes.
      // Pane cleanup alone is not enough when a child has escaped the shell's
      // process group during an exceptional test exit.
      try {
        await cleanupPass((candidate) => (
          candidate.kind === "controller"
          || candidate.kind === "agent-session"
          || candidate.kind === "process"
          || candidate.kind === "app-server"
          || candidate.kind === "web"
        ));
        await cleanupPass((candidate) => (
          candidate.kind === "tmux-server"
          || candidate.artifact !== undefined
        ));
      } catch (error) {
        remember(error);
      }

      // The exact hash-derived server is the final bounded fallback. A
      // missing server is already the desired state.
      try {
        const stopped = spawnSync(
          environment.YUI_TMUX_BIN ?? "tmux",
          ["-L", tmuxServer, "kill-server"],
          { encoding: "utf8", env: environment }
        );
        if (
          stopped.status !== 0
          && !/no server running|failed to connect|error connecting/i.test(stopped.stderr ?? "")
        ) {
          throw new Error(`Isolated tmux server did not stop: ${stopped.stderr ?? "unknown error"}`);
        }
      } catch (error) {
        remember(error);
      }

      try {
        await cleanupPass(() => true);
        const snapshot = await scan();
        const residual = snapshot.resources.filter((resource) => !identityArtifact(resource));
        if (residual.length > 0) {
          remember(new Error(
            `isolated runtime leaked resources: ${residual.map((resource) => resource.id).join(", ")}`
          ));
        }
        if (failure === undefined) {
          const current = readEphemeralDomainIdentity(home);
          if (current.status !== "valid" || current.identity.token !== currentIdentity.token) {
            throw new Error("isolated runtime domain identity changed before final cleanup");
          }
          currentIdentity = current.identity;
          const removal = removeEphemeralDomainIdentityIfUnchanged(
            home,
            currentIdentity.token,
            current.fingerprint
          );
          if (removal !== "removed") {
            if (removal === "absent") preserveIdentity();
            throw new Error("isolated runtime domain identity changed before final cleanup");
          }
          const final = await scan();
          if (final.resources.length > 0) {
            // Re-establish the exact authority for diagnosis/retry if a late
            // resource appeared in the final window.
            if (readEphemeralDomainIdentity(home).status === "absent") {
              writeEphemeralDomainIdentity(home, currentIdentity);
            }
            throw new Error(
              `isolated runtime leaked resources after final cleanup: ${final.resources.map((resource) => resource.id).join(", ")}`
            );
          }
        }
      } catch (error) {
        remember(error);
      }

      if (failure === undefined) {
        // An explicitly supplied root is a diagnostic boundary: clean the
        // marked runtime resources and identity, but retain that exact root
        // for the caller to inspect. Automatically allocated roots remain
        // disposable.
        if (!retainRoot) rmSync(root, { recursive: true, force: true });
        closed = true;
        tearingDown = false;
      } else {
        // Keep the root and exact identity available for failure diagnostics.
        tearingDown = false;
        throw failure;
      }
    }
  };
  testContext?.after(async () => runtime.teardown());
  return runtime;
}

export const isolatedRuntimeTmuxServer = defaultEphemeralTmuxServer;
