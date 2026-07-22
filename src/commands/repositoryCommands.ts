import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import { createRepository, type Repository } from "../repository/repository.js";

export type RepositoryCommandStore = Readonly<{
  nextRepositoryId(): string;
  createRepositoryIfAbsent(repository: Repository): Repository | null;
  listRepositories(): Repository[];
}>;

export type RepositoryCommandOptions = Readonly<{
  git?: Pick<GitWorkspacePort, "inspect">;
  now?: () => Date;
}>;

export async function runRepositoryCommand(
  args: readonly string[],
  store: RepositoryCommandStore,
  options: RepositoryCommandOptions = {}
): Promise<string> {
  const [command, ...rest] = args;
  if (command === "add") return addRepository(rest, store, options);
  if (command === "list") return listRepositories(rest, store);
  throw usageError(command === undefined
    ? "Repository command is required."
    : `Unknown command: repository ${command}`);
}

async function addRepository(
  args: readonly string[],
  store: RepositoryCommandStore,
  options: RepositoryCommandOptions
): Promise<string> {
  const usage = "Repository add usage: yui repository add <name> <path> [--base <ref>].";
  const parsed = parseAddArguments(args, usage);
  const git = options.git ?? new NodeGitWorkspace();
  const inspected = await git.inspect(parsed.path, parsed.baseRef ?? "HEAD");
  const repository = createRepository(
    store.nextRepositoryId(),
    parsed.name,
    inspected.root,
    parsed.baseRef ?? inspected.baseRef,
    (options.now ?? (() => new Date()))()
  );
  if (store.listRepositories().some((entry) => entry.path === repository.path)) {
    throw usageError(`Repository path is already registered: ${repository.path}.`);
  }
  const created = store.createRepositoryIfAbsent(repository);
  if (created === null) throw usageError(`Repository already exists: ${repository.name}.`);
  return [
    `Added repository ${created.id}`,
    `Name: ${created.name}`,
    `Path: ${created.path}`,
    `Base: ${created.defaultBranch}`
  ].join("\n").concat("\n");
}

function listRepositories(args: readonly string[], store: RepositoryCommandStore): string {
  if (args.length !== 0) {
    throw usageError("Repository list usage: yui repository list.");
  }
  const repositories = store.listRepositories();
  if (repositories.length === 0) return "No repositories found.\n";
  return `${renderTable(
    "Repositories",
    [
      { header: "Repository", minWidth: 10, maxWidth: 24 },
      { header: "Name", minWidth: 4, maxWidth: 28 },
      { header: "Path", minWidth: 8, maxWidth: 64 },
      { header: "Base", minWidth: 4, maxWidth: 24 }
    ],
    repositories.map((repository) => [
      repository.id,
      repository.name,
      repository.path,
      repository.defaultBranch
    ]),
    defaultTableWidth()
  )}\n`;
}

function parseAddArguments(
  args: readonly string[],
  usage: string
): Readonly<{ name: string; path: string; baseRef?: string }> {
  const positionals: string[] = [];
  let baseRef: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--base") {
      if (baseRef !== undefined) throw usageError(`--base may only be provided once. ${usage}`);
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`--base is required. ${usage}`);
      baseRef = requireText(next, "--base");
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 2) throw usageError(usage);
  return {
    name: requireText(positionals[0]!, "Repository name"),
    path: requireText(positionals[1]!, "Repository path"),
    ...(baseRef === undefined ? {} : { baseRef })
  };
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw usageError(`${label} is required.`);
  }
  return normalized;
}
