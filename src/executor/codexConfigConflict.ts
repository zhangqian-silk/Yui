import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { parse, type TomlTable } from "smol-toml";

export type CodexConfigKeyInspection =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "configured"; source: string }>;

export type CodexDeveloperInstructionsInspection = CodexConfigKeyInspection;

export type CodexLaunchConfigInspection = Readonly<{
  developerInstructions: CodexConfigKeyInspection;
  notify: CodexConfigKeyInspection;
}>;

export type CodexConfigInspectionInput = Readonly<{
  environment?: NodeJS.ProcessEnv;
  workspace: string;
  profile?: string;
  /** Test seam for the host-wide base config; production uses the Codex path. */
  systemConfigPath?: string;
  /** Test seam for managed defaults; production uses the Codex platform path. */
  managedConfigPath?: string;
}>;

/**
 * Inspects the local, file-backed Codex configuration layers supported by Yui
 * that can conflict with launch-owned settings. Remote and platform-managed
 * layers are outside this compatibility boundary. Project files are considered
 * only when the directory, project root, or repository root is trusted.
 */
export function inspectCodexDeveloperInstructions(
  input: CodexConfigInspectionInput
): CodexDeveloperInstructionsInspection {
  return inspectCodexConfigKeys(input, ["developer_instructions"])
    .developerInstructions;
}

export function inspectCodexLaunchConfig(
  input: CodexConfigInspectionInput
): CodexLaunchConfigInspection {
  return inspectCodexConfigKeys(input, ["developer_instructions", "notify"]);
}

type CodexConfigKey = "developer_instructions" | "notify";
type TrustLevel = "trusted" | "untrusted";
type ProjectDiscovery = Readonly<{
  rootMarkers?: readonly string[];
  trust: ReadonlyMap<string, TrustLevel>;
}>;

function inspectCodexConfigKeys(
  input: CodexConfigInspectionInput,
  keys: readonly CodexConfigKey[]
): CodexLaunchConfigInspection {
  const environment = input.environment ?? process.env;
  const home = codexHome(environment);
  const systemPath = checkedAbsolutePath(
    input.systemConfigPath ?? "/etc/codex/config.toml",
    "Codex system config path"
  );
  const managedPath = checkedAbsolutePath(
    input.managedConfigPath ?? "/etc/codex/managed_config.toml",
    "Codex managed config path"
  );
  const userPath = join(home, "config.toml");
  const profilePath = input.profile === undefined
    ? undefined
    : profileConfigPath(home, input.profile);
  const discoveryPaths = [
    systemPath,
    userPath,
    ...(profilePath === undefined ? [] : [profilePath])
  ];
  const basePaths = [...discoveryPaths, managedPath];
  const contentsByPath = new Map<string, string | null>(
    basePaths.map((path) => [path, readOptionalConfig(path)])
  );
  // Managed policy is applied after project configuration by Codex and cannot
  // decide whether project configuration is discoverable.
  const discovery = effectiveProjectDiscovery(
    discoveryPaths.flatMap((path) => {
      const contents = contentsByPath.get(path);
      if (contents === null || contents === undefined) return [];
      try {
        return [inspectProjectDiscovery(contents)];
      } catch (error) {
        throw unreliableInspection(path, error);
      }
    })
  );
  const projectPaths = projectConfigPaths(input.workspace, discovery);
  const candidates = [
    ...discoveryPaths.map((path) => ({ path, keys })),
    ...projectPaths.map((path) => ({
      path,
      keys: keys.filter((key) => key === "developer_instructions")
    })),
    { path: managedPath, keys }
  ];

  let developerInstructions: CodexConfigKeyInspection = { status: "absent" };
  let notify: CodexConfigKeyInspection = { status: "absent" };
  for (const candidate of candidates) {
    const contents = contentsByPath.has(candidate.path)
      ? contentsByPath.get(candidate.path)!
      : readOptionalConfig(candidate.path);
    if (contents === null) continue;
    let configured: ReadonlySet<CodexConfigKey>;
    try {
      configured = inspectConfigContents(contents, candidate.keys);
    } catch (error) {
      throw unreliableInspection(candidate.path, error);
    }
    if (
      developerInstructions.status === "absent"
      && configured.has("developer_instructions")
    ) {
      developerInstructions = { status: "configured", source: candidate.path };
    }
    if (notify.status === "absent" && configured.has("notify")) {
      notify = { status: "configured", source: candidate.path };
    }
  }
  return { developerInstructions, notify };
}

function effectiveProjectDiscovery(layers: readonly ProjectDiscovery[]): ProjectDiscovery {
  let rootMarkers: readonly string[] | undefined;
  const trust = new Map<string, TrustLevel>();
  for (const layer of layers) {
    if (layer.rootMarkers !== undefined) rootMarkers = layer.rootMarkers;
    for (const [path, value] of layer.trust) trust.set(path, value);
  }
  return { rootMarkers, trust };
}

function projectConfigPaths(workspace: string, discovery: ProjectDiscovery): string[] {
  const start = resolve(workspace);
  const projectRoot = findProjectRoot(start, discovery.rootMarkers ?? [".git"]);
  let repositoryRoot: string | undefined;
  let repositoryRootResolved = false;
  const getRepositoryRoot = (): string | undefined => {
    if (!repositoryRootResolved) {
      repositoryRoot = resolveRepositoryRootForTrust(start);
      repositoryRootResolved = true;
    }
    return repositoryRoot;
  };
  const paths: string[] = [];
  let current = start;
  while (true) {
    const configPath = join(current, ".codex", "config.toml");
    if (
      existsSync(configPath)
      &&
      trustForDirectory(current, projectRoot, getRepositoryRoot, discovery.trust)
      === "trusted"
    ) {
      paths.push(configPath);
    }
    if (samePath(current, projectRoot)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths.reverse();
}

function findProjectRoot(start: string, markers: readonly string[]): string {
  // Native Codex treats an explicitly empty marker list as "current directory".
  if (markers.length === 0) return start;
  let current = start;
  while (true) {
    if (markers.some((marker) => existsSync(
      isAbsolute(marker) ? marker : `${current}${sep}${marker}`
    ))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function trustForDirectory(
  directory: string,
  projectRoot: string,
  repositoryRoot: () => string | undefined,
  configured: ReadonlyMap<string, TrustLevel>
): TrustLevel | undefined {
  for (const candidate of [directory, projectRoot]) {
    const value = exactTrust(candidate, configured);
    if (value !== undefined) return value;
  }
  for (const candidate of [repositoryRoot()]) {
    if (candidate === undefined) continue;
    const value = exactTrust(candidate, configured);
    if (value !== undefined) return value;
  }
  return undefined;
}

function exactTrust(
  directory: string,
  configured: ReadonlyMap<string, TrustLevel>
): TrustLevel | undefined {
  const lexical = resolve(directory);
  const canonical = canonicalPath(lexical);
  for (const [path, value] of configured) {
    const configuredLexical = resolve(path);
    if (
      samePath(configuredLexical, lexical)
      || samePath(canonicalPath(configuredLexical), canonical)
    ) {
      return value;
    }
  }
  return undefined;
}

function resolveRepositoryRootForTrust(workspace: string): string | undefined {
  const result = spawnSync(
    "git",
    ["-C", workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", timeout: 1_000, windowsHide: true }
  );
  if (result.status !== 0 || result.error !== undefined) return undefined;
  const commonDirectory = result.stdout.trim();
  if (!isAbsolute(commonDirectory) || commonDirectory.includes("\0")) return undefined;
  const normalized = resolve(commonDirectory);
  return basename(normalized) === ".git" ? dirname(normalized) : undefined;
}

function inspectProjectDiscovery(contents: string): ProjectDiscovery {
  const table = parseConfig(contents);
  const rootMarkers = parseRootMarkers(table.project_root_markers);
  const trust = new Map<string, TrustLevel>();
  const projects = table.projects;
  if (projects !== undefined) {
    if (!isTable(projects)) {
      throw new Error("projects must be a TOML table");
    }
    for (const [path, project] of Object.entries(projects)) {
      if (!isAbsolute(path) || path.includes("\0")) {
        throw new Error("project trust path is not absolute");
      }
      if (!isTable(project)) {
        throw new Error("project trust entry must be a TOML table");
      }
      const level = project.trust_level;
      if (level === "trusted" || level === "untrusted") trust.set(path, level);
      else if (level !== undefined) {
        throw new Error("project trust_level must be trusted or untrusted");
      }
    }
  }
  return {
    ...(rootMarkers === undefined ? {} : { rootMarkers }),
    trust
  };
}

function parseRootMarkers(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((marker) => typeof marker !== "string")) {
    throw new Error("project_root_markers must be an array of strings");
  }
  if (value.some((marker) => marker.includes("\0"))) {
    throw new Error("project_root_markers cannot contain NUL bytes");
  }
  return value;
}

function inspectConfigContents(
  contents: string,
  keys: readonly CodexConfigKey[]
): ReadonlySet<CodexConfigKey> {
  const table = parseConfig(contents);
  return new Set(keys.filter((key) => Object.hasOwn(table, key)));
}

function parseConfig(contents: string): TomlTable {
  try {
    return parse(contents);
  } catch (error) {
    throw new Error(
      `ambiguous or invalid TOML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedAbsolutePath(path: string, label: string): string {
  if (path.includes("\0") || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
  return path;
}

function codexHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CODEX_HOME?.trim();
  const launchHome = environment.HOME?.trim();
  if (configured?.includes("\0")) throw new Error("CODEX_HOME cannot contain NUL bytes.");
  if (launchHome?.includes("\0")) throw new Error("HOME cannot contain NUL bytes.");
  return resolve(configured === undefined || configured.length === 0
    ? join(
        launchHome === undefined || launchHome.length === 0 ? homedir() : launchHome,
        ".codex"
      )
    : configured);
}

function profileConfigPath(home: string, profile: string): string {
  const name = profile.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name)) {
    throw new Error(
      `Codex profile must be a plain name before its config can be inspected: ${profile}.`
    );
  }
  return join(home, `${name}.config.toml`);
}

function readOptionalConfig(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new Error(
      `Codex config could not be inspected: ${path}: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function unreliableInspection(path: string, error: unknown): Error {
  return new Error(
    `Codex launch config could not be inspected reliably: ${path}: `
    + `${error instanceof Error ? error.message : String(error)}`
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
