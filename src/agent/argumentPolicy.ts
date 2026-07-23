import type { AgentAdapterId } from "./adapterCatalog.js";

const OWNED_ARGUMENTS_BY_ADAPTER: Readonly<Record<AgentAdapterId, readonly string[]>> = {
  codex: [
    "resume", "fork", "exec", "e", "review",
    "--model", "-m", "--config", "-c", "--sandbox", "-s",
    "--ask-for-approval", "-a", "--search", "--profile", "-p",
    "--add-dir", "--cd", "-C", "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust"
  ],
  claude: [
    "--resume", "-r", "--continue", "-c", "--session-id", "--fork-session",
    "--model", "--effort", "--permission-mode", "--allowed-tools", "--allowedTools",
    "--disallowed-tools", "--disallowedTools", "--add-dir", "--settings",
    "--setting-sources", "--worktree", "-w", "--tmux", "--print", "-p",
    "--agents", "--bg", "--background", "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions", "--no-session-persistence", "--from-pr",
    "--fallback-model", "--tools", "--system-prompt", "--system-prompt-file",
    "--append-system-prompt", "--append-system-prompt-file", "--plugin-dir"
  ]
};

export function ownedArgumentsForAdapter(adapterId: AgentAdapterId): readonly string[] {
  return OWNED_ARGUMENTS_BY_ADAPTER[adapterId];
}

export function findReservedAgentArgument(adapterId: AgentAdapterId, argument: string): string | null {
  if (argument === "--") return "--";
  const owned = new Set(ownedArgumentsForAdapter(adapterId));
  const equalsToken = argument.split("=", 1)[0];
  if (owned.has(argument) || owned.has(equalsToken)) return equalsToken;
  if (!argument.startsWith("-") || argument.startsWith("--")) return null;
  const shortOptions = new Set([...owned].filter((value) => /^-[^-]$/.test(value)));
  for (const flag of argument.slice(1)) {
    const token = `-${flag}`;
    if (shortOptions.has(token)) return token;
  }
  return null;
}

/** Escape-hatch arguments cannot override fields or lifecycle owned by an adapter. */
export function validateAgentAdvancedArguments(
  adapterId: AgentAdapterId,
  rawArgs: readonly string[]
): void {
  validateArgumentList(rawArgs, "Advanced rawArgs");
  for (const argument of rawArgs) {
    const reserved = findReservedAgentArgument(adapterId, argument);
    if (reserved !== null) throw new Error(`Advanced rawArgs contains reserved argument: ${reserved}.`);
  }
}

export const validateAgentRawArguments = validateAgentAdvancedArguments;

export function validateAgentBaseArguments(
  adapterId: AgentAdapterId,
  baseArgs: readonly string[]
): void {
  validateArgumentList(baseArgs, "Agent base arguments");
  for (const argument of baseArgs) {
    const reserved = findReservedAgentArgument(adapterId, argument);
    if (reserved !== null) {
      throw new Error(`Agent base argument is reserved by adapter ${adapterId}: ${reserved}.`);
    }
  }
}

function validateArgumentList(values: readonly string[], label: string): void {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new Error(`${label} entries must be non-empty strings without NUL bytes.`);
    }
    const option = value.split("=", 1)[0];
    if (containsSecretMarker(option) || containsSecretJson(value) || looksLikeCredential(value)) {
      throw new Error(`${label} cannot persist secret-bearing arguments.`);
    }
  }
}

function containsSecretMarker(value: string): boolean {
  return /(?:api[-_]?key|token|secret|password|credential|authorization)/i.test(value);
}

function containsSecretJson(value: string): boolean {
  return /["']?(?:api[-_]?key|token|secret|password|credential|authorization)["']?\s*:/i.test(value);
}

function looksLikeCredential(value: string): boolean {
  return /(?:^|[=:\s])(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\s+\S+)/i.test(value);
}
