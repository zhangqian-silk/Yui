import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

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
 * Checks only effective Codex layers: project files require a trusted project,
 * use Codex's configured root markers, and cannot own the process-level notify
 * callback. The fail-closed lexer determines root assignment boundaries and
 * the narrow project-discovery settings; ambiguous input rejects the launch
 * instead of being treated as an absent key.
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
  const basePaths = [
    systemPath,
    userPath,
    ...(profilePath === undefined ? [] : [profilePath]),
    managedPath
  ];
  const contentsByPath = new Map<string, string | null>(
    basePaths.map((path) => [path, readOptionalConfig(path)])
  );
  const discovery = effectiveProjectDiscovery(
    basePaths.flatMap((path) => {
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
    ...basePaths.slice(0, -1).map((path) => ({ path, keys })),
    ...projectPaths.map((path) => ({
      path,
      keys: keys.filter((key) => key === "developer_instructions")
    })),
    { path: managedPath, keys }
  ];

  let developerInstructions: CodexConfigKeyInspection = { status: "absent" };
  let notify: CodexConfigKeyInspection = { status: "absent" };
  for (const candidate of candidates) {
    const { path } = candidate;
    const contents = contentsByPath.has(path)
      ? contentsByPath.get(path)!
      : readOptionalConfig(path);
    if (contents === null) continue;
    let configured: ReadonlySet<CodexConfigKey>;
    try {
      configured = inspectConfigContents(contents, candidate.keys);
    } catch (error) {
      throw unreliableInspection(path, error);
    }
    if (
      developerInstructions.status === "absent"
      && configured.has("developer_instructions")
    ) {
      developerInstructions = { status: "configured", source: path };
    }
    if (notify.status === "absent" && configured.has("notify")) {
      notify = { status: "configured", source: path };
    }
  }
  return { developerInstructions, notify };
}

type CodexConfigKey = "developer_instructions" | "notify";

function checkedAbsolutePath(path: string, label: string): string {
  if (path.includes("\0") || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
  return path;
}

function codexHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CODEX_HOME?.trim();
  const launchHome = environment.HOME?.trim();
  if (configured?.includes("\0")) {
    throw new Error("CODEX_HOME cannot contain NUL bytes.");
  }
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

type ProjectDiscovery = Readonly<{
  rootMarkers?: readonly string[];
  trust: ReadonlyMap<string, "trusted" | "untrusted">;
}>;

function effectiveProjectDiscovery(layers: readonly ProjectDiscovery[]): ProjectDiscovery {
  let rootMarkers: readonly string[] | undefined;
  const trust = new Map<string, "trusted" | "untrusted">();
  for (const layer of layers) {
    if (layer.rootMarkers !== undefined) rootMarkers = layer.rootMarkers;
    for (const [path, value] of layer.trust) trust.set(path, value);
  }
  return { rootMarkers, trust };
}

function projectConfigPaths(workspace: string, discovery: ProjectDiscovery): string[] {
  const start = resolve(workspace);
  if (effectiveProjectTrust(start, discovery.trust) !== "trusted") return [];
  const markers = discovery.rootMarkers ?? [".git"];
  let projectRoot = start;
  let current = start;
  while (true) {
    if (markers.some((marker) => existsSync(join(current, marker)))) {
      projectRoot = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const paths: string[] = [];
  current = start;
  while (true) {
    paths.push(join(current, ".codex", "config.toml"));
    if (current === projectRoot) break;
    current = dirname(current);
  }
  return paths.reverse();
}

function effectiveProjectTrust(
  workspace: string,
  configured: ReadonlyMap<string, "trusted" | "untrusted">
): "trusted" | "untrusted" | undefined {
  let selected: Readonly<{ path: string; value: "trusted" | "untrusted" }> | undefined;
  for (const [path, value] of configured) {
    const candidate = resolve(path);
    const child = relative(candidate, workspace);
    if (child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      continue;
    }
    if (selected === undefined || candidate.length > selected.path.length) {
      selected = { path: candidate, value };
    }
  }
  return selected?.value;
}

function readOptionalConfig(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
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

function inspectProjectDiscovery(contents: string): ProjectDiscovery {
  let tablePath: readonly string[] = [];
  let rootMarkers: readonly string[] | undefined;
  const trust = new Map<string, "trusted" | "untrusted">();
  let pendingValue: ValueLexState | null = null;
  let pendingRootMarkers:
    | Readonly<{ contents: string; lineNumber: number }>
    | null = null;
  const lines = contents.split(/\r?\n/u);
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset]!;
    const lineNumber = offset + 1;
    if (pendingValue !== null) {
      if (pendingRootMarkers !== null) {
        pendingRootMarkers = {
          contents: `${pendingRootMarkers.contents}\n${line}`,
          lineNumber: pendingRootMarkers.lineNumber
        };
      }
      scanValueLine(line, 0, pendingValue, lineNumber);
      if (pendingValue.multiline === null && pendingValue.containers.length === 0) {
        if (pendingRootMarkers !== null) {
          rootMarkers = validateProjectRootMarkers(
            parseTomlStringArray(
              collapseTomlArray(pendingRootMarkers.contents),
              0,
              pendingRootMarkers.lineNumber
            ),
            pendingRootMarkers.lineNumber
          );
          pendingRootMarkers = null;
        }
        pendingValue = null;
      }
      continue;
    }

    const start = skipHorizontalWhitespace(line, 0);
    if (start === line.length || line[start] === "#") continue;
    if (line[start] === "[") {
      tablePath = parseTableHeader(line, start, lineNumber);
      continue;
    }

    const assignment = parseAssignment(line, start, lineNumber);
    const value: ValueLexState = {
      containers: [],
      multiline: null,
      sawToken: false,
      lastToken: "start"
    };
    scanValueLine(line, assignment.valueStart, value, lineNumber);
    if (!value.sawToken) {
      throw ambiguousConfig(lineNumber, "assignment has no value");
    }
    const isRootMarkers = tablePath.length === 0
      && assignment.keys.length === 1
      && assignment.keys[0] === "project_root_markers";
    const isTrust = tablePath.length === 2
      && tablePath[0] === "projects"
      && assignment.keys.length === 1
      && assignment.keys[0] === "trust_level";
    if (
      isTrust
      && (value.multiline !== null || value.containers.length > 0)
    ) {
      throw ambiguousConfig(
        lineNumber,
        "project discovery values must be declared on one line"
      );
    }
    if (isRootMarkers) {
      if (value.multiline !== null) {
        throw ambiguousConfig(lineNumber, "project_root_markers cannot be a string");
      }
      if (value.containers.length > 0) {
        pendingRootMarkers = {
          contents: line.slice(assignment.valueStart),
          lineNumber
        };
      } else {
        rootMarkers = validateProjectRootMarkers(
          parseTomlStringArray(line, assignment.valueStart, lineNumber),
          lineNumber
        );
      }
    }
    if (isTrust) {
      const projectPath = tablePath[1]!;
      if (resolve(projectPath) !== projectPath || projectPath.includes("\0")) {
        throw ambiguousConfig(lineNumber, "project trust path is not absolute");
      }
      const level = parseTomlStringValue(line, assignment.valueStart, lineNumber);
      if (level === "trusted" || level === "untrusted") {
        trust.set(projectPath, level);
      }
    }
    if (value.multiline !== null || value.containers.length > 0) {
      pendingValue = value;
    }
  }
  if (pendingValue?.multiline !== null && pendingValue?.multiline !== undefined) {
    throw new Error("Codex config contains an unterminated multiline string.");
  }
  if (pendingValue !== null) {
    throw new Error("Codex config is ambiguous: an array or inline table is unterminated.");
  }
  return { rootMarkers, trust };
}

function validateProjectRootMarkers(
  markers: readonly string[],
  lineNumber: number
): readonly string[] {
  return markers.map((marker) => {
    if (marker.length === 0 || marker.includes("\0")) {
      throw ambiguousConfig(lineNumber, "project root marker is invalid");
    }
    return marker;
  });
}

function collapseTomlArray(contents: string): string {
  let result = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let comment = false;
  for (const character of contents) {
    if (comment) {
      if (character === "\n") {
        comment = false;
        result += " ";
      }
      continue;
    }
    if (quote !== null) {
      result += character;
      if (quote === '"' && character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    result += character === "\n" || character === "\r" ? " " : character;
  }
  return result;
}

function parseTomlStringValue(
  line: string,
  start: number,
  lineNumber: number
): string {
  const parsed = parseTomlStringAt(line, skipHorizontalWhitespace(line, start), lineNumber);
  requireValueEnd(line, parsed.end, lineNumber);
  return parsed.value;
}

function parseTomlStringArray(
  line: string,
  start: number,
  lineNumber: number
): readonly string[] {
  let index = skipHorizontalWhitespace(line, start);
  if (line[index] !== "[") {
    throw ambiguousConfig(lineNumber, "project_root_markers is not an array");
  }
  index += 1;
  const values: string[] = [];
  for (;;) {
    index = skipHorizontalWhitespace(line, index);
    if (line[index] === "]") {
      requireValueEnd(line, index + 1, lineNumber);
      return values;
    }
    const parsed = parseTomlStringAt(line, index, lineNumber);
    values.push(parsed.value);
    index = skipHorizontalWhitespace(line, parsed.end);
    if (line[index] === "]") {
      requireValueEnd(line, index + 1, lineNumber);
      return values;
    }
    if (line[index] !== ",") {
      throw ambiguousConfig(lineNumber, "project_root_markers has invalid array syntax");
    }
    index += 1;
  }
}

function parseTomlStringAt(
  line: string,
  start: number,
  lineNumber: number
): Readonly<{ value: string; end: number }> {
  if (line[start] === '"') {
    const end = scanBasicString(line, start, line.length, lineNumber, "value");
    return {
      value: decodeTomlBasicString(line.slice(start + 1, end - 1)),
      end
    };
  }
  if (line[start] === "'") {
    const end = scanLiteralString(line, start, line.length, lineNumber, "value");
    return { value: line.slice(start + 1, end - 1), end };
  }
  throw ambiguousConfig(lineNumber, "project discovery value is not a string");
}

function requireValueEnd(line: string, start: number, lineNumber: number): void {
  const end = skipHorizontalWhitespace(line, start);
  if (end !== line.length && line[end] !== "#") {
    throw ambiguousConfig(lineNumber, "project discovery value has trailing syntax");
  }
}

function inspectConfigContents(
  contents: string,
  keys: readonly CodexConfigKey[]
): ReadonlySet<CodexConfigKey> {
  const wanted = new Set<CodexConfigKey>(keys);
  const configured = new Set<CodexConfigKey>();
  let root = true;
  let pendingValue: ValueLexState | null = null;
  const lines = contents.split(/\r?\n/u);
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset]!;
    const lineNumber = offset + 1;
    if (pendingValue !== null) {
      scanValueLine(line, 0, pendingValue, lineNumber);
      if (
        pendingValue.multiline === null
        && pendingValue.containers.length === 0
      ) {
        pendingValue = null;
      }
      continue;
    }

    const start = skipHorizontalWhitespace(line, 0);
    if (start === line.length || line[start] === "#") continue;
    if (line[start] === "[") {
      parseTableHeader(line, start, lineNumber);
      root = false;
      continue;
    }

    const assignment = parseAssignment(line, start, lineNumber);
    const value: ValueLexState = {
      containers: [],
      multiline: null,
      sawToken: false,
      lastToken: "start"
    };
    scanValueLine(line, assignment.valueStart, value, lineNumber);
    if (!value.sawToken) {
      throw ambiguousConfig(lineNumber, "assignment has no value");
    }
    if (
      root
      && assignment.keys.length === 1
      && wanted.has(assignment.keys[0] as CodexConfigKey)
    ) {
      configured.add(assignment.keys[0] as CodexConfigKey);
    }
    if (value.multiline !== null || value.containers.length > 0) {
      pendingValue = value;
    }
  }
  if (pendingValue?.multiline !== null && pendingValue?.multiline !== undefined) {
    throw new Error("Codex config contains an unterminated multiline string.");
  }
  if (pendingValue !== null) {
    throw new Error("Codex config is ambiguous: an array or inline table is unterminated.");
  }
  return configured;
}

type MultilineDelimiter = '"""' | "'''";
type ContainerDelimiter = "[" | "{";
type ValueLexState = {
  containers: ContainerDelimiter[];
  multiline: MultilineDelimiter | null;
  sawToken: boolean;
  lastToken: "start" | "array-open" | "comma" | "inline-equals" | "other";
};

type ParsedAssignment = Readonly<{
  keys: readonly string[];
  valueStart: number;
}>;

function parseAssignment(
  line: string,
  start: number,
  lineNumber: number
): ParsedAssignment {
  const keys: string[] = [];
  let index = start;
  while (true) {
    index = skipHorizontalWhitespace(line, index);
    const segment = parseKeySegment(line, index, line.length, lineNumber);
    keys.push(segment.value);
    index = skipHorizontalWhitespace(line, segment.end);
    if (line[index] === "=") {
      return { keys, valueStart: index + 1 };
    }
    if (line[index] !== ".") {
      throw ambiguousConfig(lineNumber, "root statement is not a complete assignment");
    }
    index += 1;
  }
}

function parseTableHeader(
  line: string,
  start: number,
  lineNumber: number
): readonly string[] {
  const arrayHeader = line[start + 1] === "[";
  const contentStart = start + (arrayHeader ? 2 : 1);
  let index = contentStart;
  let contentEnd: number | null = null;
  while (index < line.length) {
    const character = line[index]!;
    if (character === '"') {
      index = scanBasicString(line, index, line.length, lineNumber, "table key");
      continue;
    }
    if (character === "'") {
      index = scanLiteralString(line, index, line.length, lineNumber, "table key");
      continue;
    }
    if (character === "#") {
      throw ambiguousConfig(lineNumber, "table header is unterminated before its comment");
    }
    if (character === "[") {
      throw ambiguousConfig(lineNumber, "table header contains an unexpected '['");
    }
    if (character === "]") {
      if (arrayHeader && line[index + 1] !== "]") {
        throw ambiguousConfig(lineNumber, "array-table header has only one closing bracket");
      }
      contentEnd = index;
      index += arrayHeader ? 2 : 1;
      break;
    }
    index += 1;
  }
  if (contentEnd === null) {
    throw ambiguousConfig(lineNumber, "table header is unterminated");
  }
  const keys = parseDottedKey(line, contentStart, contentEnd, lineNumber, "table header");
  index = skipHorizontalWhitespace(line, index);
  if (index < line.length && line[index] !== "#") {
    throw ambiguousConfig(lineNumber, "table header has trailing syntax");
  }
  return keys;
}

function parseDottedKey(
  line: string,
  start: number,
  end: number,
  lineNumber: number,
  label: string
): readonly string[] {
  const keys: string[] = [];
  let index = start;
  while (true) {
    index = skipHorizontalWhitespace(line, index);
    if (index >= end) {
      throw ambiguousConfig(lineNumber, `${label} has an empty key segment`);
    }
    const segment = parseKeySegment(line, index, end, lineNumber);
    keys.push(segment.value);
    index = skipHorizontalWhitespace(line, segment.end);
    if (index === end) return keys;
    if (line[index] !== ".") {
      throw ambiguousConfig(lineNumber, `${label} key is not reliably parseable`);
    }
    index += 1;
  }
}

function parseKeySegment(
  line: string,
  start: number,
  end: number,
  lineNumber: number
): Readonly<{ value: string; end: number }> {
  const character = line[start];
  if (character === '"') {
    const segmentEnd = scanBasicString(
      line,
      start,
      end,
      lineNumber,
      "quoted key"
    );
    return {
      value: decodeTomlBasicString(line.slice(start + 1, segmentEnd - 1)),
      end: segmentEnd
    };
  }
  if (character === "'") {
    const segmentEnd = scanLiteralString(
      line,
      start,
      end,
      lineNumber,
      "quoted key"
    );
    return { value: line.slice(start + 1, segmentEnd - 1), end: segmentEnd };
  }
  const match = /^[A-Za-z0-9_-]+/u.exec(line.slice(start, end));
  if (match === null) {
    throw ambiguousConfig(lineNumber, "assignment key is not reliably parseable");
  }
  return { value: match[0], end: start + match[0].length };
}

function scanValueLine(
  line: string,
  start: number,
  state: ValueLexState,
  lineNumber: number
): void {
  let index = start;
  if (state.multiline !== null) {
    index = scanMultilineString(line, index, state, lineNumber);
    if (state.multiline !== null) return;
    state.lastToken = "other";
  }

  while (index < line.length) {
    const character = line[index]!;
    if (character === " " || character === "\t") {
      index += 1;
      continue;
    }
    if (character === "#") return;
    if (character === '"' || character === "'") {
      const delimiter = character.repeat(3) as MultilineDelimiter;
      if (line.startsWith(delimiter, index)) {
        // A triple delimiter is structural only where a value may start.
        // This prevents malformed text such as `value = 1 #? """` from
        // manufacturing a multiline state that hides later root assignments.
        if (!canStartCompositeValue(state)) {
          throw ambiguousConfig(
            lineNumber,
            "multiline string does not begin at a value boundary"
          );
        }
        state.sawToken = true;
        state.multiline = delimiter;
        index = scanMultilineString(line, index + 3, state, lineNumber);
        if (state.multiline !== null) return;
        state.lastToken = "other";
        continue;
      }
      state.sawToken = true;
      index = character === '"'
        ? scanBasicString(line, index, line.length, lineNumber, "value")
        : scanLiteralString(line, index, line.length, lineNumber, "value");
      state.lastToken = "other";
      continue;
    }
    if (character === "[" || character === "{") {
      if (!canStartCompositeValue(state)) {
        throw ambiguousConfig(
          lineNumber,
          `container '${character}' does not begin at a value boundary`
        );
      }
      state.sawToken = true;
      state.containers.push(character);
      state.lastToken = character === "[" ? "array-open" : "other";
      index += 1;
      continue;
    }
    if (character === "]" || character === "}") {
      const expected = character === "]" ? "[" : "{";
      if (state.containers.at(-1) !== expected) {
        throw ambiguousConfig(lineNumber, `value contains an unmatched '${character}'`);
      }
      state.containers.pop();
      state.lastToken = "other";
      index += 1;
      continue;
    }
    if (character === ",") {
      if (state.containers.length === 0) {
        throw ambiguousConfig(lineNumber, "value contains a top-level comma");
      }
      state.sawToken = true;
      state.lastToken = "comma";
      index += 1;
      continue;
    }
    if (character === "=") {
      if (state.containers.at(-1) !== "{") {
        throw ambiguousConfig(lineNumber, "value contains an unexpected '='");
      }
      if (state.lastToken === "inline-equals") {
        throw ambiguousConfig(lineNumber, "inline-table value has repeated '='");
      }
      state.sawToken = true;
      state.lastToken = "inline-equals";
      index += 1;
      continue;
    }
    if (character.charCodeAt(0) < 0x20) {
      throw ambiguousConfig(lineNumber, "value contains an unsupported control character");
    }
    state.sawToken = true;
    state.lastToken = "other";
    index += 1;
  }
}

function canStartCompositeValue(state: ValueLexState): boolean {
  if (!state.sawToken) return true;
  const container = state.containers.at(-1);
  return (
    (container === "["
      && (state.lastToken === "array-open" || state.lastToken === "comma"))
    || (container === "{" && state.lastToken === "inline-equals")
  );
}

function scanMultilineString(
  line: string,
  start: number,
  state: ValueLexState,
  lineNumber: number
): number {
  const delimiter = state.multiline;
  if (delimiter === null) return start;
  const quote = delimiter[0]!;
  let index = start;
  while (index < line.length) {
    const character = line[index]!;
    if (delimiter === '"""' && character === "\\") {
      if (index + 1 === line.length) return line.length;
      index = scanBasicEscape(line, index, lineNumber, "multiline value");
      continue;
    }
    if (character !== quote) {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (line[runEnd] === quote) runEnd += 1;
    const runLength = runEnd - index;
    if (runLength < 3) {
      index = runEnd;
      continue;
    }
    if (runLength > 5) {
      throw ambiguousConfig(lineNumber, "multiline string has an ambiguous quote run");
    }
    state.multiline = null;
    return runEnd;
  }
  return line.length;
}

function scanBasicString(
  line: string,
  start: number,
  end: number,
  lineNumber: number,
  label: string
): number {
  let index = start + 1;
  while (index < end) {
    const character = line[index]!;
    if (character === '"') {
      decodeTomlBasicString(line.slice(start + 1, index));
      return index + 1;
    }
    if (character === "\\") {
      index = scanBasicEscape(line, index, lineNumber, label);
      continue;
    }
    index += 1;
  }
  throw new Error(`Codex config contains an unterminated ${label} string at line ${lineNumber}.`);
}

function scanLiteralString(
  line: string,
  start: number,
  end: number,
  lineNumber: number,
  label: string
): number {
  const closing = line.indexOf("'", start + 1);
  if (closing < 0 || closing >= end) {
    throw new Error(`Codex config contains an unterminated ${label} string at line ${lineNumber}.`);
  }
  return closing + 1;
}

function scanBasicEscape(
  line: string,
  start: number,
  lineNumber: number,
  label: string
): number {
  const escape = line[start + 1];
  if (escape === undefined) {
    throw new Error(`Codex config contains an unterminated ${label} escape at line ${lineNumber}.`);
  }
  if ("btnfr\"\\".includes(escape)) return start + 2;
  if (escape === "u" || escape === "U") {
    const digits = escape === "u" ? 4 : 8;
    const hexadecimal = line.slice(start + 2, start + 2 + digits);
    if (hexadecimal.length !== digits || !/^[0-9A-Fa-f]+$/u.test(hexadecimal)) {
      throw ambiguousConfig(lineNumber, `${label} has an invalid Unicode escape`);
    }
    const codePoint = Number.parseInt(hexadecimal, 16);
    if (
      codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw ambiguousConfig(lineNumber, `${label} has an invalid Unicode scalar`);
    }
    return start + 2 + digits;
  }
  throw ambiguousConfig(lineNumber, `${label} has an invalid escape`);
}

function skipHorizontalWhitespace(line: string, start: number): number {
  let index = start;
  while (line[index] === " " || line[index] === "\t") index += 1;
  return index;
}

function ambiguousConfig(lineNumber: number, reason: string): Error {
  return new Error(`Codex config is ambiguous at line ${lineNumber}: ${reason}.`);
}

function decodeTomlBasicString(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escape = value[index + 1];
    if (escape === undefined) {
      throw new Error("Codex config contains an invalid quoted key.");
    }
    const simple: Readonly<Record<string, string>> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\"
    };
    const replacement = simple[escape];
    if (replacement !== undefined) {
      decoded += replacement;
      index += 1;
      continue;
    }
    if (escape === "u" || escape === "U") {
      const digits = escape === "u" ? 4 : 8;
      const hexadecimal = value.slice(index + 2, index + 2 + digits);
      if (hexadecimal.length !== digits || !/^[0-9A-Fa-f]+$/u.test(hexadecimal)) {
        throw new Error("Codex config contains an invalid Unicode escape in a quoted key.");
      }
      const codePoint = Number.parseInt(hexadecimal, 16);
      if (
        codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw new Error("Codex config contains an invalid Unicode scalar in a quoted key.");
      }
      decoded += String.fromCodePoint(codePoint);
      index += digits + 1;
      continue;
    }
    throw new Error("Codex config contains an invalid escape in a quoted key.");
  }
  return decoded;
}
