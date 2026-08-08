/**
 * Deterministic two-process seam for the inbox/cutover coordination contract.
 *
 * publisher: admits a hook, announces that admission while holding the shared
 * lock, waits for the upgrade process to place its fence, then completes the
 * durable write.
 * upgrade: places the fence, waits for the publisher/parent barrier, copies
 * the complete Home and performs the two-step switch while holding the same
 * lock, then keeps the fence until the parent has inspected the result.
 */

import {
  existsSync,
  writeFileSync,
  renameSync
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, home, barrier, resultPath] = process.argv.slice(2);

function waitForFileSync(path) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
function writeResult(value) {
  const temporary = `${resultPath}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, resultPath);
}

async function runPublisher() {
  const { FileRuntimeEventInbox } = await import(pathToFileURL(
    join(process.cwd(), "dist", "controller", "runtimeEventInbox.js")
  ).href);
  writeFileSync(`${barrier}.publisher-started`, "1");
  const inbox = new FileRuntimeEventInbox(home, undefined, {
    afterAdmission: () => {
      writeFileSync(`${barrier}.admitted`, "1");
      waitForFileSync(`${barrier}.release-publisher`);
    }
  });
  try {
    const result = inbox.enqueueTurnCompleted({
      scope: "task",
      taskId: "task-coordination",
      roleName: "leader",
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "native-coordination",
      turnId: "turn-coordination",
      summary: "admitted before the upgrade fence"
    });
    writeResult({ ok: true, result });
  } catch (error) {
    writeResult({
      ok: false,
      errorName: error?.constructor?.name,
      error: String(error?.message ?? error)
    });
  }
}

async function runUpgrade() {
  const { placeUpgradeFence } = await import(pathToFileURL(
    join(process.cwd(), "dist", "storage", "upgradeFence.js")
  ).href);
  const { withUpgradeCoordinationLock } = await import(pathToFileURL(
    join(process.cwd(), "dist", "storage", "upgradeCoordination.js")
  ).href);
  const { createHomeMigrationTarget } = await import(pathToFileURL(
    join(process.cwd(), "dist", "storage", "upgrade", "homeMigrationTarget.js")
  ).href);
  const { latestStorageVersionState } = await import(pathToFileURL(
    join(process.cwd(), "dist", "storage", "upgrade", "recordVersions.js")
  ).href);

  const releaseFence = placeUpgradeFence(home, {
    reason: "deterministic coordination regression",
    createdAt: new Date(0).toISOString(),
    ownerPid: process.pid
  });
  writeFileSync(`${barrier}.upgrade-started`, "1");
  try {
    const target = createHomeMigrationTarget({
      home,
      latest: latestStorageVersionState(),
      stagingPath: `${home}.coordination-staging`
    });
    const switchOutcome = withUpgradeCoordinationLock(home, () => {
      writeFileSync(`${barrier}.upgrade-locked`, "1");
      waitForFileSync(`${barrier}.release-to-switch`);
      const snapshot = target.readSource();
      target.writeFreshOutput(snapshot);
      return target.atomicSwitchWithBackup();
    });
    // The lock is released before the fence so a waiting hook can acquire the
    // lock and observe an explicit fence failure rather than racing an absent
    // marker. The parent inspects the promoted Home before allowing release.
    writeFileSync(`${barrier}.cutover-done`, "1");
    waitForFileSync(`${barrier}.allow-fence-release`);
    writeResult({ ok: true, switchOutcome });
  } catch (error) {
    writeResult({
      ok: false,
      errorName: error?.constructor?.name,
      error: String(error?.message ?? error)
    });
  } finally {
    releaseFence();
  }
}

try {
  if (mode === "publisher") await runPublisher();
  else if (mode === "upgrade") await runUpgrade();
  else throw new Error(`Unknown runner mode: ${mode}`);
  process.exit(0);
} catch (error) {
  writeResult({
    ok: false,
    errorName: error?.constructor?.name,
    error: String(error?.message ?? error)
  });
  process.exit(1);
}
