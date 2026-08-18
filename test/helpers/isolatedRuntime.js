import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEphemeralDomainIdentity,
  defaultEphemeralTmuxServer,
  domainIdentityPath,
  ephemeralDomainEnvironment,
  recordEphemeralTmuxTarget,
  readEphemeralDomainIdentity,
  readLinuxProcessStartIdentity,
  removeEphemeralDomainIdentity,
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

const ABSENT_TMUX_SERVER = /no server running|failed to connect|error connecting/iu;

/**
 * Test-owned real runtime for deterministic integration and Mock Agent tests.
 * The creator-owned root and durable ephemeral-domain identity fence every
 * Controller, process, artifact, and tmux target without granting authority
 * over a shared Home or an unrelated runtime generation.
 */
export function createIsolatedRuntime(testContext, options = {}) {
  const requestedRoot = options.root;
  const allocatedRoot = requestedRoot === undefined
    ? mkdtempSync(join(tmpdir(), "yui-isolated-runtime-"))
    : resolve(requestedRoot);
  const root = resolve(allocatedRoot);
  const retainRoot = options.retainRoot ?? requestedRoot !== undefined;
  if (requestedRoot !== undefined) {
    assert.equal(existsSync(root), false, `isolated runtime root already exists: ${root}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  const home = join(root, "yui-home");
  const tmuxServer = yuiTmuxServerName(home);
  const identity = createEphemeralDomainIdentity({
    tmuxServer,
    tmuxTargets: [],
    hostPid: process.pid,
    hostProcessStartIdentity: readLinuxProcessStartIdentity(process.pid),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt })
  });
  const environment = Object.fromEntries(Object.entries({
    ...process.env,
    ...(options.environment ?? {}),
    YUI_HOME: home,
    ...ephemeralDomainEnvironment(identity)
  }).filter(([, value]) => value !== undefined && value !== ""));

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
    /** Path to the captured Controller stderr log (best-effort debug aid). */
    controllerLogPath: join(root, "controller-stderr.log"),
    get identity() {
      return currentIdentity;
    },
    async startController() {
      const controllerEntry = fileURLToPath(
        new URL("../../dist/controller/controllerMain.js", import.meta.url)
      );
      const status = await ensureFileTaskController(home, {
        environment,
        spawnController: (controllerHome, controllerEnv) => {
          const child = spawn(
            process.execPath,
            [controllerEntry],
            {
              env: controllerEnv,
              detached: true,
              stdio: ["ignore", "ignore", openSync(runtime.controllerLogPath, "a")]
            }
          );
          child.unref();
        }
      });
      if (!Number.isSafeInteger(status?.pid) || status.pid <= 1) {
        throw new Error("isolated Controller did not report a valid process identity");
      }
      controllerStarted = true;
    },
    tmux(options = {}) {
      const {
        executor,
        onRoleTargetRecorded,
        ...managerOptions
      } = options;
      const baseExecutor = executor ?? new NodeCommandExecutor();
      const scopedExecutor = {
        run(command, args, runOptions = {}) {
          return baseExecutor.run(command, args, {
            ...runOptions,
            environment: {
              ...environment,
              ...(runOptions.environment ?? {}),
              YUI_HOME: home
            }
          });
        },
        ...(baseExecutor.runAsync === undefined ? {} : {
          runAsync(command, args, runOptions = {}) {
            return baseExecutor.runAsync(command, args, {
              ...runOptions,
              environment: {
                ...environment,
                ...(runOptions.environment ?? {}),
                YUI_HOME: home
              }
            });
          }
        })
      };
      const recordTarget = (target) => {
        if (!recordEphemeralTmuxTarget(home, currentIdentity.token, target)) {
          throw new Error(`isolated runtime target fence was not recorded: ${target}`);
        }
        const current = readEphemeralDomainIdentity(home);
        if (current.status !== "valid") {
          throw new Error("isolated runtime domain identity became unavailable");
        }
        currentIdentity = current.identity;
        Object.assign(environment, ephemeralDomainEnvironment(currentIdentity));
        onRoleTargetRecorded?.(target);
      };
      return new TmuxManager(
        environment.YUI_TMUX_BIN ?? "tmux",
        scopedExecutor,
        {
          ...managerOptions,
          yuiHome: home,
          onRoleTargetRecorded: recordTarget
        }
      );
    },
    async teardown() {
      if (closed || tearingDown) return;
      tearingDown = true;
      let failure;
      const remember = (error) => {
        if (failure === undefined) failure = error;
      };
      const discovery = join(home, "runtime", "controller.json");
      const scan = async () => scanControllerResourceInventory({
        currentHome: home,
        scope: "current",
        environment
      });
      const isOwned = (resource) => resource.yuiHome === home;
      const clean = async (resource) => {
        if (!isOwned(resource)) {
          throw new Error(`isolated cleanup refused a foreign resource: ${resource.id}`);
        }
        const exactOwnedDomain = resource.domain?.kind === "ephemeral-test"
          && resource.domain.token === currentIdentity.token;
        if (
          resource.disposition !== "safe"
          && resource.disposition !== "review"
          && !exactOwnedDomain
        ) {
          throw new Error(`isolated cleanup refused an ineligible resource: ${resource.id}`);
        }
        try {
          await cleanControllerResource(
            exactOwnedDomain && resource.disposition === "protected"
              ? { ...resource, disposition: "safe" }
              : resource,
            { environment }
          );
        } catch (error) {
          const changedSinceScan = error instanceof Error
            && error.message === `Resource changed since scan: ${resource.id}.`;
          if (changedSinceScan) {
            try {
              const refreshed = await scan();
              const exactResourceRemains = refreshed.resources.some((candidate) => (
                isOwned(candidate) && candidate.id === resource.id
              ));
              if (refreshed.warnings.length === 0 && !exactResourceRemains) return;
            } catch {
              // An uncertain rescan cannot override the production identity fence.
            }
          }
          remember(error);
        }
      };
      const cleanupPass = async (predicate) => {
        const snapshot = await scan();
        for (const resource of snapshot.resources.filter((candidate) => (
          isOwned(candidate) && predicate(candidate)
        ))) {
          await clean(resource);
        }
      };

      if (controllerStarted || existsSync(discovery)) {
        try {
          await stopFileTaskController(home, { environment });
        } catch (error) {
          remember(error);
        }
      }

      // The host process is deliberately live while its fixture tears down.
      // Production inventory therefore protects this domain by default. The
      // fixture may clean only resources carrying its exact Home + token, and
      // cleanControllerResource still revalidates that durable generation.
      try {
        await cleanupPass((resource) => (
          resource.kind === "controller"
          || resource.kind === "agent-session"
          || resource.kind === "process"
          || resource.kind === "app-server"
          || resource.kind === "web"
        ));
        await cleanupPass((resource) => resource.kind === "tmux-server");
      } catch (error) {
        remember(error);
      }

      // A normal Controller stop deliberately retains the exact domain fence
      // so a restart cannot orphan surviving panes. Once its exact resources
      // are gone, this disposable fixture removes only its current token.
      try {
        const current = readEphemeralDomainIdentity(home);
        if (current.status === "invalid") {
          throw new Error("isolated runtime domain identity is invalid");
        }
        if (current.status === "valid") {
          if (current.identity.token !== currentIdentity.token) {
            throw new Error("isolated runtime domain identity token changed");
          }
          if (!removeEphemeralDomainIdentity(home, currentIdentity.token)) {
            throw new Error("isolated runtime domain identity could not be removed");
          }
        }
      } catch (error) {
        remember(error);
      }

      try {
        await cleanupPass((resource) => resource.artifact !== undefined);
      } catch (error) {
        remember(error);
      }

      try {
        const stopped = spawnSync(
          environment.YUI_TMUX_BIN ?? "tmux",
          ["-L", tmuxServer, "kill-server"],
          { encoding: "utf8", env: environment, timeout: 10_000 }
        );
        if (stopped.error !== undefined) throw stopped.error;
        if (stopped.status !== 0 && !ABSENT_TMUX_SERVER.test(stopped.stderr ?? "")) {
          throw new Error(`isolated tmux server did not stop: ${stopped.stderr ?? "unknown error"}`);
        }
      } catch (error) {
        remember(error);
      }

      try {
        const remaining = spawnSync(
          environment.YUI_TMUX_BIN ?? "tmux",
          ["-L", tmuxServer, "list-sessions"],
          { encoding: "utf8", env: environment, timeout: 10_000 }
        );
        if (remaining.error !== undefined) throw remaining.error;
        if (remaining.status === 0) {
          throw new Error(`isolated tmux server still has sessions: ${remaining.stdout.trim()}`);
        }
        if (!ABSENT_TMUX_SERVER.test(remaining.stderr ?? "")) {
          throw new Error(`isolated tmux cleanup could not prove absence: ${remaining.stderr ?? ""}`);
        }
      } catch (error) {
        remember(error);
      }

      try {
        await cleanupPass(() => true);
        const final = await scan();
        const residual = final.resources.filter(isOwned);
        if (residual.length > 0) {
          throw new Error(
            `isolated runtime leaked resources: ${residual.map(({ id }) => id).join(", ")}`
          );
        }
        if (final.warnings.length > 0) {
          throw new Error(
            `isolated cleanup could not prove resource absence: ${final.warnings.join("; ")}`
          );
        }
        if (existsSync(domainIdentityPath(home))) {
          throw new Error("isolated runtime domain identity remains after teardown");
        }
      } catch (error) {
        remember(error);
      }

      if (failure === undefined) {
        if (!retainRoot) {
          rmSync(root, { recursive: true, force: true });
          if (existsSync(root)) throw new Error(`isolated runtime root remains: ${root}`);
        }
        closed = true;
        tearingDown = false;
        return;
      }
      tearingDown = false;
      throw failure;
    }
  };
  testContext?.after(async () => runtime.teardown());
  return runtime;
}

export const isolatedRuntimeTmuxServer = defaultEphemeralTmuxServer;
