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
  domainIdentityPath,
  ephemeralDomainEnvironment,
  readEphemeralDomainIdentity,
  readLinuxProcessStartIdentity,
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
    tmux() {
      const manager = new TmuxManager(
        environment.YUI_TMUX_BIN ?? "tmux",
        new NodeCommandExecutor(),
        { yuiHome: home }
      );
      const refreshIdentityTargets = () => {
        const current = readEphemeralDomainIdentity(home);
        if (current.status !== "valid" || current.identity?.token !== currentIdentity.token) {
          return;
        }
        const targets = manager.inspectRolePaneInventory().map((pane) => pane.target).sort();
        currentIdentity = Object.freeze({
          ...current.identity,
          tmuxTargets: targets
        });
        writeEphemeralDomainIdentity(home, currentIdentity);
        environment.YUI_EPHEMERAL_TMUX_TARGETS = JSON.stringify(targets);
      };
      const ensureRoleWindow = manager.ensureRoleWindow.bind(manager);
      manager.ensureRoleWindow = (...args) => {
        const created = ensureRoleWindow(...args);
        refreshIdentityTargets();
        return created;
      };
      const killRole = manager.killRole.bind(manager);
      manager.killRole = (...args) => {
        killRole(...args);
        refreshIdentityTargets();
      };
      const stopTask = manager.stopTask.bind(manager);
      manager.stopTask = (...args) => {
        const stopped = stopTask(...args);
        refreshIdentityTargets();
        return stopped;
      };
      return manager;
    },
    async teardown() {
      if (closed) return;
      closed = true;
      let failure;
      const remember = (error) => {
        if (failure === undefined) failure = error;
      };
      const cleanup = async (resource) => {
        try {
          await cleanControllerResource(resource, { environment });
        } catch (error) {
          remember(error);
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

      // Reap the full Agent process trees before removing their tmux panes.
      // Pane cleanup alone is not enough when a child has escaped the shell's
      // process group during an exceptional test exit.
      try {
        let snapshot = await scanControllerResourceInventory({
          currentHome: home,
          scope: "current",
          environment
        });
        for (const resource of snapshot.resources.filter((candidate) => (
          candidate.kind === "agent-session"
          || candidate.kind === "process"
          || candidate.kind === "app-server"
          || candidate.kind === "web"
        ))) {
          if (resource.disposition === "safe" || resource.disposition === "review") {
            await cleanup(resource);
          }
        }
        snapshot = await scanControllerResourceInventory({
          currentHome: home,
          scope: "current",
          environment
        });
        for (const resource of snapshot.resources.filter((candidate) => (
          candidate.kind === "tmux-server"
          || candidate.artifact !== undefined
        ))) {
          if (resource.disposition === "safe" || resource.disposition === "review") {
            await cleanup(resource);
          }
        }
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
        let snapshot = await scanControllerResourceInventory({
          currentHome: home,
          scope: "current",
          environment
        });
        for (const resource of snapshot.resources) {
          if (resource.disposition === "safe" || resource.disposition === "review") {
            await cleanup(resource);
          }
        }
        snapshot = await scanControllerResourceInventory({
          currentHome: home,
          scope: "current",
          environment
        });
        if (snapshot.resources.length > 0) {
          remember(new Error(
            `isolated runtime leaked resources: ${snapshot.resources.map((resource) => resource.id).join(", ")}`
          ));
        }
        if (existsSync(domainIdentityPath(home))) {
          remember(new Error("isolated runtime domain identity remains after teardown"));
        }
      } catch (error) {
        remember(error);
      }

      if (failure === undefined) {
        rmSync(root, { recursive: true, force: true });
      } else {
        // Keep the root and exact identity available for failure diagnostics.
        throw failure;
      }
    }
  };
  testContext?.after(async () => runtime.teardown());
  return runtime;
}

export const isolatedRuntimeTmuxServer = defaultEphemeralTmuxServer;
