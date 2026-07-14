const OWNED_ARGUMENTS_BY_ADAPTER: Readonly<Record<string, readonly string[]>> = {
  codex: [
    "resume",
    "fork",
    "exec",
    "e",
    "review",
    "--model",
    "-m",
    "--config",
    "-c",
    "--sandbox",
    "-s",
    "--ask-for-approval",
    "-a",
    "--search",
    "--profile",
    "-p",
    "--add-dir",
    "--cd",
    "-C",
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust"
  ],
  claude: [
    "--resume",
    "-r",
    "--continue",
    "-c",
    "--session-id",
    "--fork-session",
    "--model",
    "--effort",
    "--permission-mode",
    "--allowed-tools",
    "--allowedTools",
    "--disallowed-tools",
    "--disallowedTools",
    "--add-dir",
    "--settings",
    "--setting-sources",
    "--worktree",
    "-w",
    "--tmux",
    "--print",
    "-p",
    "--agents",
    "--bg",
    "--background",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--no-session-persistence",
    "--from-pr",
    "--fallback-model",
    "--tools"
  ]
};

export function ownedArgumentsForAdapter(adapterId: string): readonly string[] {
  return OWNED_ARGUMENTS_BY_ADAPTER[adapterId] ?? [];
}

export function validateAgentAdvancedArguments(
  adapterId: string,
  rawArgs: readonly string[],
  ownedArguments: readonly string[] = ownedArgumentsForAdapter(adapterId)
): void {
  validateNoSecretMaterial(rawArgs, "Advanced rawArgs");
  const owned = new Set(ownedArguments);
  for (const argument of rawArgs) {
    const token = reservedToken(argument, owned);
    if (token !== undefined) {
      throw new Error(`Advanced rawArgs contains reserved argument: ${token}.`);
    }
  }
}

export function validateAgentBaseArguments(
  adapterId: string,
  baseArgs: readonly string[],
  ownedArguments: readonly string[] = ownedArgumentsForAdapter(adapterId)
): void {
  validateNoSecretMaterial(baseArgs, "Agent base arguments");
  const owned = new Set(ownedArguments);
  for (const argument of baseArgs) {
    const token = reservedToken(argument, owned);
    if (token !== undefined) {
      throw new Error(
        `Agent base argument is reserved by adapter ${adapterId}: ${token} (reserved argument: ${token}).`
      );
    }
  }
}

function reservedToken(argument: string, owned: ReadonlySet<string>): string | undefined {
  const equalsIndex = argument.indexOf("=");
  const token = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
  if (owned.has(token)) return token;

  if (!argument.startsWith("-") || argument.startsWith("--")) return undefined;
  const ownedShortOptions = new Set([...owned].filter((candidate) => /^-[^-]$/.test(candidate)));
  for (const flag of argument.slice(1)) {
    const candidate = `-${flag}`;
    if (ownedShortOptions.has(candidate)) return candidate;
  }
  return undefined;
}

function containsSecretMarker(value: string): boolean {
  return /(?:api[-_]?key|token|secret|password|credential|authorization)/i.test(value);
}

function validateNoSecretMaterial(args: readonly string[], label: string): void {
  for (const argument of args) {
    if (argument === "--") {
      throw new Error(`${label} contains reserved argument: --.`);
    }
    const optionName = argument.split("=", 1)[0];
    if (containsSecretMarker(optionName) || containsSecretJson(argument) || looksLikeCredential(argument)) {
      throw new Error(`${label} cannot persist secret-bearing arguments.`);
    }
  }
}

function containsSecretJson(value: string): boolean {
  return /["']?(?:api[-_]?key|token|secret|password|credential|authorization)["']?\s*:/i.test(value);
}

function looksLikeCredential(value: string): boolean {
  return /(?:^|[=:\s])(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\s+\S+)/i.test(value);
}
