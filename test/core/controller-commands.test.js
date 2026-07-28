import assert from "node:assert/strict";
import test from "node:test";

import {
  parseControllerCleanupOptions,
  parseControllerStatusOptions,
  renderControllerResourceStatus,
  runInteractiveControllerCleanup
} from "../../dist/commands/controllerCommands.js";

const HOME = "/tmp/yui-controller-command";

function resource(overrides) {
  return {
    id: "resource-1",
    fingerprint: "fingerprint-1",
    kind: "artifact",
    state: "stale",
    disposition: "safe",
    reasonCode: "stale-tmux-socket",
    owner: { kind: "none" },
    processes: [],
    rssBytes: 0,
    cpuTimeMs: 0,
    ageMs: 0,
    ...overrides
  };
}

function snapshot(resources) {
  return {
    schemaVersion: 1,
    observedAt: "2026-07-28T00:00:00.000Z",
    currentHome: HOME,
    scope: "all",
    summary: {
      domainCount: 1,
      resourceCount: resources.length,
      liveProcessCount: 2,
      rssBytes: 768 * 1024 * 1024,
      byDisposition: {
        safe: resources.filter(({ disposition }) => disposition === "safe").length,
        review: resources.filter(({ disposition }) => disposition === "review").length,
        protected: resources.filter(({ disposition }) => disposition === "protected").length,
        "report-only": resources.filter(({ disposition }) => disposition === "report-only").length
      }
    },
    domains: [{
      yuiHome: HOME,
      storageStatus: "current",
      resourceCount: resources.length,
      liveProcessCount: 2,
      rssBytes: 768 * 1024 * 1024,
      issueCount: resources.filter(({ disposition }) => disposition !== "protected").length
    }],
    resources
  };
}

test("Controller status options keep scope and verbosity independent", () => {
  assert.deepEqual(parseControllerStatusOptions([]), { scope: "current", verbose: false });
  assert.deepEqual(parseControllerStatusOptions(["--all"]), { scope: "all", verbose: false });
  assert.deepEqual(parseControllerStatusOptions(["--verbose"]), {
    scope: "current",
    verbose: true
  });
  assert.deepEqual(parseControllerStatusOptions(["--all", "--verbose"]), {
    scope: "all",
    verbose: true
  });
  assert.throws(
    () => parseControllerStatusOptions(["--unknown"]),
    /Controller status usage/
  );
});

test("default Controller status lists owned Agent sessions but summarizes residual artifacts", () => {
  const output = renderControllerResourceStatus(snapshot([
    resource({
      id: "controller",
      kind: "controller",
      state: "current",
      disposition: "protected",
      reasonCode: "current-controller",
      yuiHome: HOME,
      owner: { kind: "controller-domain", yuiHome: HOME },
      processes: [{
        pid: 100,
        ppid: 1,
        uid: 1000,
        startIdentity: "1000",
        command: "node",
        rssBytes: 64 * 1024 * 1024,
        cpuTimeMs: 100,
        ageMs: 60_000
      }],
      rssBytes: 64 * 1024 * 1024,
      cpuTimeMs: 100,
      ageMs: 60_000
    }),
    resource({
      id: "role",
      kind: "agent-session",
      state: "running",
      disposition: "protected",
      reasonCode: "owned-role-pane",
      yuiHome: HOME,
      owner: {
        kind: "task-role",
        taskId: "task-1",
        taskTitle: "Status",
        taskStatus: "active",
        roleName: "worker",
        agentId: "codex",
        nativeSessionId: "thread-1"
      },
      processes: [{
        pid: 200,
        ppid: 150,
        uid: 1000,
        startIdentity: "2000",
        command: "codex",
        rssBytes: 704 * 1024 * 1024,
        cpuTimeMs: 500,
        ageMs: 30_000
      }],
      rssBytes: 704 * 1024 * 1024,
      cpuTimeMs: 500,
      ageMs: 30_000,
      target: "task-1:worker"
    }),
    resource({
      id: "stale",
      artifact: {
        artifactKind: "tmux-socket",
        path: "/tmp/tmux-1000/yui-secret-path",
        active: false,
        fingerprint: "stale"
      }
    })
  ]), false);

  assert.match(output, /Controller is running \(PID 100\)/);
  assert.match(output, /task-1/);
  assert.match(output, /worker/);
  assert.match(output, /codex/);
  assert.match(output, /stale-tmux-socket/);
  assert.doesNotMatch(output, /yui-secret-path/);
});

test("verbose Controller status expands live anomalies without dumping stale artifact paths", () => {
  const output = renderControllerResourceStatus(snapshot([
    resource({
      id: "orphan",
      kind: "app-server",
      state: "orphaned",
      disposition: "review",
      reasonCode: "orphan-app-server",
      yuiHome: HOME,
      processes: [{
        pid: 333,
        ppid: 1,
        uid: 1000,
        startIdentity: "3330",
        command: "codex",
        rssBytes: 512 * 1024 * 1024,
        cpuTimeMs: 800,
        ageMs: 120_000
      }],
      rssBytes: 512 * 1024 * 1024,
      cpuTimeMs: 800,
      ageMs: 120_000
    }),
    resource({
      id: "stale",
      artifact: {
        artifactKind: "tmux-socket",
        path: "/tmp/tmux-1000/yui-many-stale",
        active: false,
        fingerprint: "stale"
      }
    })
  ]), true);

  assert.match(output, /333/);
  assert.match(output, /orphan-app-server/);
  assert.doesNotMatch(output, /yui-many-stale/);
});

test("Controller cleanup options are deliberately limited to interactive scope", () => {
  assert.deepEqual(parseControllerCleanupOptions([]), { scope: "current" });
  assert.deepEqual(parseControllerCleanupOptions(["--all"]), { scope: "all" });
  assert.throws(
    () => parseControllerCleanupOptions(["--all", "--all"]),
    /Controller cleanup usage/
  );
  assert.throws(
    () => parseControllerCleanupOptions(["--verbose"]),
    /Controller cleanup usage/
  );
});

test("interactive cleanup selects safe resources, reviews live orphans, and revalidates once", async () => {
  const safeController = resource({
    id: "safe-controller",
    fingerprint: "controller:100:1000",
    kind: "controller",
    state: "superseded",
    disposition: "safe",
    reasonCode: "superseded-controller",
    yuiHome: HOME,
    owner: { kind: "controller-domain", yuiHome: HOME },
    processes: [{
      pid: 100,
      ppid: 1,
      uid: 1000,
      startIdentity: "1000",
      command: "node",
      rssBytes: 64 * 1024 * 1024,
      cpuTimeMs: 100,
      ageMs: 60_000
    }],
    rssBytes: 64 * 1024 * 1024,
    cpuTimeMs: 100,
    ageMs: 60_000
  });
  const stale = resource({
    id: "stale-artifact",
    fingerprint: "stale-artifact",
    artifact: {
      artifactKind: "tmux-socket",
      path: "/tmp/tmux-1000/yui-stale",
      active: false,
      fingerprint: "stale-artifact"
    }
  });
  const review = resource({
    id: "review-server",
    fingerprint: "server:200:2000",
    kind: "app-server",
    state: "orphaned",
    disposition: "review",
    reasonCode: "orphan-app-server",
    yuiHome: HOME,
    processes: [{
      pid: 200,
      ppid: 1,
      uid: 1000,
      startIdentity: "2000",
      command: "codex",
      rssBytes: 512 * 1024 * 1024,
      cpuTimeMs: 100,
      ageMs: 60_000
    }],
    rssBytes: 512 * 1024 * 1024,
    cpuTimeMs: 100,
    ageMs: 60_000
  });
  const initial = snapshot([safeController, stale, review]);
  const after = snapshot([]);
  const answers = ["y", "y", "n", "cleanup"];
  const prompts = [];
  const cleaned = [];
  let scans = 0;

  const result = await runInteractiveControllerCleanup({
    io: {
      interactive: true,
      write() {},
      async question(prompt) {
        prompts.push(prompt);
        return answers.shift();
      }
    },
    scan: async () => {
      scans += 1;
      return scans < 3 ? initial : after;
    },
    clean: async (candidate) => {
      cleaned.push(candidate.id);
    }
  });

  assert.deepEqual(cleaned, ["safe-controller", "stale-artifact"]);
  assert.equal(scans, 3);
  assert.equal(prompts.some((prompt) => /Review 1 live resource/i.test(prompt)), true);
  assert.equal(prompts.some((prompt) => /Type cleanup/i.test(prompt)), true);
  assert.equal(result.data.cleaned.length, 2);
  assert.equal(result.data.failed.length, 0);
  assert.equal(result.data.reclaimedRssBytes, 64 * 1024 * 1024);
});

test("cleanup skips a candidate whose runtime fingerprint changed after confirmation", async () => {
  const stale = resource({
    id: "stale-artifact",
    fingerprint: "before",
    artifact: {
      artifactKind: "tmux-socket",
      path: "/tmp/tmux-1000/yui-stale",
      active: false,
      fingerprint: "before"
    }
  });
  const changed = resource({
    ...stale,
    fingerprint: "after",
    artifact: { ...stale.artifact, fingerprint: "after" }
  });
  const scans = [snapshot([stale]), snapshot([changed]), snapshot([changed])];
  let cleaned = false;
  const result = await runInteractiveControllerCleanup({
    io: {
      interactive: true,
      write() {},
      async question() {
        return "y";
      }
    },
    scan: async () => scans.shift(),
    clean: async () => {
      cleaned = true;
    }
  });

  assert.equal(cleaned, false);
  assert.deepEqual(result.data.skipped, [{
    id: "stale-artifact",
    reason: "changed-since-scan"
  }]);
});

test("cleanup skips a safe candidate that becomes review-only during revalidation", async () => {
  const safe = resource({
    id: "controller",
    fingerprint: "controller:100:1000",
    kind: "controller",
    state: "superseded",
    disposition: "safe",
    reasonCode: "superseded-controller"
  });
  const escalated = resource({
    ...safe,
    state: "orphaned",
    disposition: "review",
    reasonCode: "orphan-controller"
  });
  const scans = [snapshot([safe]), snapshot([escalated]), snapshot([escalated])];
  let cleaned = false;
  const result = await runInteractiveControllerCleanup({
    io: {
      interactive: true,
      write() {},
      async question() {
        return "y";
      }
    },
    scan: async () => scans.shift(),
    clean: async () => {
      cleaned = true;
    }
  });

  assert.equal(cleaned, false);
  assert.deepEqual(result.data.skipped, [{
    id: "controller",
    reason: "changed-since-scan"
  }]);
});

test("cleanup rejects non-interactive execution before scanning", async () => {
  let scanned = false;
  await assert.rejects(
    runInteractiveControllerCleanup({
      io: {
        interactive: false,
        write() {},
        async question() {
          return undefined;
        }
      },
      scan: async () => {
        scanned = true;
        return snapshot([]);
      },
      clean: async () => {}
    }),
    /interactive terminal/
  );
  assert.equal(scanned, false);
});
