import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";

export type RuntimeStopReceipt = Readonly<{
  schemaVersion: 1;
  receiptId: string;
  runtimeGenerationId: string;
  requestedAt: string;
}>;

export function writeRuntimeStopReceipt(
  home: string,
  runtimeGenerationId: string,
  requestedAt: Date
): RuntimeStopReceipt {
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    receiptId: `runtime-stop-${createHash("sha256")
      .update(`${runtimeGenerationId}\0${requestedAt.toISOString()}`)
      .digest("hex")}`,
    runtimeGenerationId,
    requestedAt: requestedAt.toISOString()
  });
  const path = stopReceiptPath(home, runtimeGenerationId);
  mkdirSync(resolve(join(home, "runtime", "stop-receipts")), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return receipt;
}

export function readRuntimeStopReceipt(
  home: string,
  runtimeGenerationId: string
): RuntimeStopReceipt | null {
  try {
    const value = JSON.parse(readFileSync(stopReceiptPath(home, runtimeGenerationId), "utf8")) as RuntimeStopReceipt;
    if (value.schemaVersion !== 1 || value.runtimeGenerationId !== runtimeGenerationId
      || typeof value.receiptId !== "string" || !Number.isFinite(Date.parse(value.requestedAt))) {
      throw new Error("Runtime stop receipt is invalid.");
    }
    return Object.freeze({ ...value });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function removeRuntimeStopReceipt(home: string, runtimeGenerationId: string): void {
  rmSync(stopReceiptPath(home, runtimeGenerationId), { force: true });
}

function stopReceiptPath(home: string, runtimeGenerationId: string): string {
  const name = createHash("sha256").update(runtimeGenerationId).digest("hex");
  return resolve(join(home, "runtime", "stop-receipts", `${name}.json`));
}
