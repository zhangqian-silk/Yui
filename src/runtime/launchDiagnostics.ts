import { CommandExecutionError } from "../tmux/commandExecutor.js";

export const RUNTIME_LAUNCH_PHASES = [
  "validation",
  "host-start",
  "host-started",
  "native-session-discovery",
  "host-stop",
  "delivery"
] as const;

export type RuntimeLaunchPhase = (typeof RUNTIME_LAUNCH_PHASES)[number];

export const RUNTIME_LAUNCH_KINDS = [
  "config",
  "auth",
  "executable",
  "tmux",
  "timeout",
  "provider",
  "unknown"
] as const;

export type RuntimeLaunchKind = (typeof RUNTIME_LAUNCH_KINDS)[number];

export type RuntimeLaunchPaneDiagnostic = Readonly<{
  target: string;
  dead: boolean;
  pid?: number;
  currentCommand: string;
  exitStatus?: number;
}>;

export type RuntimeLaunchDiagnostic = Readonly<{
  phase: RuntimeLaunchPhase;
  kind: RuntimeLaunchKind;
  command?: string;
  argv?: readonly string[];
  cwd?: string;
  exitStatus?: number;
  signal?: string;
  stderrTail?: string;
  pane?: RuntimeLaunchPaneDiagnostic;
  hint?: string;
  detail?: string;
}>;

export type RuntimeLaunchDiagnosticContext = Readonly<{
  command?: string;
  argv?: readonly string[];
  cwd?: string;
  agentId?: string;
  exitStatus?: number;
  signal?: string;
  stderrTail?: string;
  pane?: RuntimeLaunchPaneDiagnostic;
}>;

const MAX_ARGUMENT_CHARS = 1_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_DETAIL_CHARS = 1_000;

const SECRET_VALUE_PATTERN =
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|cookie|authorization)(\s*[=:]\s*)([^\s,;]+)/gi;
// Word boundary keeps "task-5-…" workspace paths from being mistaken for keys.
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{6,}/gu;

/** A bounded, single-line, secret-redacted launch failure for Run summaries. */
export class RuntimeLaunchFailure extends Error {
  override readonly name = "RuntimeLaunchFailure";

  constructor(readonly diagnostic: RuntimeLaunchDiagnostic) {
    super(formatRuntimeLaunchDiagnostic(diagnostic));
  }
}

export function toRuntimeLaunchFailure(
  error: unknown,
  phase: RuntimeLaunchPhase,
  context: RuntimeLaunchDiagnosticContext = {}
): RuntimeLaunchFailure {
  if (error instanceof RuntimeLaunchFailure) return error;
  const commandError = error instanceof CommandExecutionError ? error : undefined;
  const stderrTail = tail(
    redactLaunchText(context.stderrTail ?? commandError?.stderr ?? ""),
    MAX_STDERR_CHARS
  );
  const kind = classifyLaunchFailure(phase, error, stderrTail);
  const exitStatus = context.exitStatus ?? commandError?.exitStatus;
  const detail = tail(
    redactLaunchText(error instanceof Error ? error.message : String(error)),
    MAX_DETAIL_CHARS
  );
  return new RuntimeLaunchFailure({
    phase,
    kind,
    ...(context.command === undefined ? {} : { command: redactLaunchText(context.command) }),
    ...(context.argv === undefined
      ? {}
      : { argv: context.argv.map((argument) => redactLaunchArgument(argument)) }),
    ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
    ...(exitStatus === undefined
      ? {}
      : { exitStatus }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(stderrTail.length === 0 ? {} : { stderrTail }),
    ...(context.pane === undefined ? {} : { pane: context.pane }),
    ...(detail.length === 0 ? {} : { detail }),
    ...(launchHint(kind, context.agentId) === undefined
      ? {}
      : { hint: launchHint(kind, context.agentId) })
  });
}

export function formatRuntimeLaunchDiagnostic(
  diagnostic: RuntimeLaunchDiagnostic
): string {
  const fields: string[] = [
    `failurePhase=${diagnostic.phase}`,
    `failureKind=${diagnostic.kind}`
  ];
  if (diagnostic.command !== undefined) fields.push(`command=${JSON.stringify(diagnostic.command)}`);
  if (diagnostic.argv !== undefined) fields.push(`argv=${JSON.stringify(diagnostic.argv)}`);
  if (diagnostic.cwd !== undefined) fields.push(`cwd=${JSON.stringify(diagnostic.cwd)}`);
  if (diagnostic.exitStatus !== undefined) fields.push(`exitStatus=${diagnostic.exitStatus}`);
  if (diagnostic.signal !== undefined) fields.push(`signal=${JSON.stringify(diagnostic.signal)}`);
  if (diagnostic.stderrTail !== undefined) {
    fields.push(`stderrTail=${JSON.stringify(tail(diagnostic.stderrTail, MAX_STDERR_CHARS))}`);
  }
  if (diagnostic.pane !== undefined) fields.push(`pane=${JSON.stringify(diagnostic.pane)}`);
  if (diagnostic.detail !== undefined) {
    fields.push(`detail=${JSON.stringify(tail(diagnostic.detail, MAX_DETAIL_CHARS))}`);
  }
  if (diagnostic.hint !== undefined) fields.push(`hint=${JSON.stringify(diagnostic.hint)}`);
  return `Role Run could not start: ${fields.join(" ")}`;
}

export function redactLaunchArgument(value: string): string {
  return tail(redactLaunchText(value), MAX_ARGUMENT_CHARS);
}

export function redactLaunchText(value: string): string {
  return value
    .replace(OPENAI_KEY_PATTERN, "[REDACTED]")
    .replace(SECRET_VALUE_PATTERN, "$1$2[REDACTED]");
}

function classifyLaunchFailure(
  phase: RuntimeLaunchPhase,
  error: unknown,
  stderrTail: string
): RuntimeLaunchKind {
  if (
    (error instanceof CommandExecutionError && error.code === "COMMAND_NOT_FOUND")
    || /command not found|no such file or directory/i.test(stderrTail)
  ) {
    return "executable";
  }
  if (isConfigFailure(stderrTail)) return "config";
  if (isAuthFailure(stderrTail)) return "auth";
  if (phase === "host-start") return "tmux";
  if (phase === "native-session-discovery") return "timeout";
  if (phase === "validation" || phase === "delivery") return "config";
  return "provider";
}

function isConfigFailure(stderrTail: string): boolean {
  return /unknown model|invalid effort|unknown option|invalid value|unexpected argument|invalid .*config|model .*not (?:found|supported)|effort .*not (?:valid|supported)/i
    .test(stderrTail);
}

function isAuthFailure(stderrTail: string): boolean {
  return /\bauth(?:entication|orization)?\b|unauthorized|forbidden|credential|api[_-]?key|login|sign in|token/i
    .test(stderrTail);
}

/**
 * Conservative detection of fatal error signatures in agent output during
 * launch. These are errors the agent cannot recover from without
 * intervention (missing executable, invalid configuration, authentication
 * failure). Transient errors (network retries, temporary blips) are not
 * matched. Failure-kind classification uses the broader patterns in
 * classifyLaunchFailure once a fatal output is confirmed.
 */
export function hasFatalLaunchOutput(output: string): boolean {
  return /command not found|no such file or directory/i.test(output)
    || /unknown model|invalid effort|unknown option|invalid value|unexpected argument/i.test(output)
    || /401\s+unauthorized|403\s+forbidden|authentication failed|not logged in|sign in with/i
      .test(output);
}

function launchHint(
  kind: RuntimeLaunchKind,
  agentId: string | undefined
): string | undefined {
  switch (kind) {
    case "config":
      return agentId === undefined
        ? "Verify the Provider model and effort configuration."
        : `Verify custom model/effort with yui agent capabilities ${agentId}.`;
    case "auth":
      return "Verify Provider authentication and the Agent environment.";
    case "executable":
      return "Verify the Provider command is installed and on PATH.";
    case "timeout":
      return "Verify Provider lifecycle hooks and Controller connectivity.";
    default:
      return undefined;
  }
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}
