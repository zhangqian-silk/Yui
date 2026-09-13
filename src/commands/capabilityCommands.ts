import { usageError } from "../errors/cliError.js";
import { resolveJobCaller } from "../task/taskAuthority.js";
import { callFileTaskController } from "../controller/clientRuntime.js";
import type { JsonValue } from "../core/protocol.js";

export async function runCapabilityCommand(
  args: readonly string[], home: string, environment: NodeJS.ProcessEnv
): Promise<JsonValue> {
  const [action, ...rest] = args;
  const usage = "yui capability search [query] --task <id> | commands --task <id> | panels --task <id> | describe <name> --task <id> [--provider <id>] [--version <version>] | call <name> --task <id> --input <json> [--provider <id>] [--version <version>] [--request-id <id>]";
  if (!["search", "commands", "panels", "describe", "call"].includes(action)) throw usageError(usage);
  const surfaceList = action === "commands" || action === "panels";
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  const allowed = new Set(["--task", "--provider", "--version", "--input", "--request-id"]);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const next = rest[++index];
    if (!allowed.has(arg) || flags.has(arg) || next === undefined || next.startsWith("--")) {
      throw usageError(`Invalid capability option: ${arg}.`, usage);
    }
    flags.set(arg, next);
  }
  const taskId = flags.get("--task") ?? environment.YUI_TASK_ID;
  if (!taskId || positionals.length > 1
    || (!surfaceList && action !== "search" && !positionals.length)
    || (surfaceList && positionals.length)) throw usageError(usage);
  if ((action === "search" || surfaceList) && [...flags.keys()].some((key) => key !== "--task")) throw usageError(usage);
  if (action === "describe" && (flags.has("--input") || flags.has("--request-id"))) throw usageError(usage);
  let input: JsonValue | undefined;
  if (action === "call") {
    if (!flags.has("--input")) throw usageError("Capability call requires --input <json>.", usage);
    try { input = JSON.parse(flags.get("--input")!) as JsonValue; } catch { throw usageError("Invalid capability JSON input."); }
  }
  return callFileTaskController(home, `capability.${surfaceList ? "search" : action}`, {
    taskId, caller: resolveJobCaller(environment, taskId),
    ...(surfaceList ? { surface: action } : action === "search" ? { query: positionals[0] ?? "" } : {
      request: {
        name: positionals[0],
        ...(input === undefined ? {} : { input }),
        ...(flags.has("--provider") ? { providerId: flags.get("--provider") } : {}),
        ...(flags.has("--version") ? { contractVersion: flags.get("--version") } : {}),
        ...(flags.has("--request-id") ? { requestId: flags.get("--request-id") } : {})
      }
    })
  } as JsonValue, { environment });
}
