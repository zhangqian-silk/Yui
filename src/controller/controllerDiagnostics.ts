import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function appendControllerDiagnostic(
  rootDir: string,
  event: string,
  message: string,
  details: Record<string, unknown> = {}
): void {
  const directory = join(rootDir, "runtime", "logs");
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, "controller.jsonl"), `${JSON.stringify({
    schemaVersion: 1,
    event,
    message,
    details,
    createdAt: new Date().toISOString()
  })}\n`, { encoding: "utf8", mode: 0o600 });
}
