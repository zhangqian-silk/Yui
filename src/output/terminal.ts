const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

type TerminalStream = { isTTY?: boolean; columns?: number };

export type DetailEntry = readonly [label: string, value: string];

export function renderSection(title: string, body?: string): string {
  const normalizedTitle = title.trim();
  const normalizedBody = body?.trimEnd();
  if (normalizedBody === undefined || normalizedBody.length === 0) return normalizedTitle;
  return `${normalizedTitle}\n${normalizedBody.split("\n").map((line) => `  ${line}`).join("\n")}`;
}

export function renderDetails(entries: readonly DetailEntry[]): string {
  if (entries.length === 0) return "";
  const labelWidth = Math.max(...entries.map(([label]) => visibleWidth(label)));
  return entries.map(([label, value]) =>
    `  ${padVisibleEnd(label, labelWidth)}  ${value.length === 0 ? "—" : value}`
  ).join("\n");
}

export function renderCodeBlock(contents: string): string {
  return contents.trimEnd().split("\n").map((line) => `  │ ${line}`).join("\n");
}

export function renderPrompt(question: string, hint?: string): string {
  const suffix = hint === undefined || hint.length === 0 ? "" : ` [${hint}]`;
  return `› ${question.trim()}${suffix}: `;
}

export function withPromptAnswerSpacing<T>(
  question: (prompt: string) => Promise<T>,
  write: (value: string) => void,
  inputIsEchoed: boolean
): (prompt: string) => Promise<T> {
  return async (prompt) => {
    const answer = await question(prompt);
    write(inputIsEchoed ? "\n" : "\n\n");
    return answer;
  };
}

export function renderSuccess(message: string): string {
  return renderOutcome("✓", message);
}

export function renderInfo(message: string): string {
  return renderOutcome("›", message);
}

export function renderWarning(message: string): string {
  return renderOutcome("!", message);
}

export function renderError(message: string): string {
  return renderOutcome("✕", message);
}

export function renderEmpty(message: string): string {
  return renderOutcome("○", message);
}

function renderOutcome(symbol: string, message: string): string {
  const lines = message.trimEnd().split("\n");
  return `${lines.map((line, index) => index === 0 ? `${symbol} ${line}` : `  ${line}`).join("\n")}\n`;
}

export function terminalSupportsColor(
  stream: TerminalStream,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (Object.hasOwn(env, "NO_COLOR")) return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined) return true;
  return stream.isTTY === true && env.TERM !== "dumb";
}

export function usableInteractiveTerminal(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized === undefined
    || normalized.length === 0
    || normalized.toLowerCase() === "dumb"
    ? "xterm-256color"
    : normalized;
}

export function defaultTerminalWidth(stream: TerminalStream = process.stdout): number {
  const columns = stream.columns;
  return columns === undefined || !Number.isFinite(columns) || columns <= 0
    ? 100
    : Math.max(20, Math.min(Math.floor(columns), 140));
}

export function paintTerminalOutput(output: string, color: boolean): string {
  if (!color || output.length === 0 || ANSI_PATTERN.test(output)) {
    ANSI_PATTERN.lastIndex = 0;
    return output;
  }
  const lines = output.split("\n");
  return lines.map((line, index) => paintLine(line, lines, index)).join("\n");
}

function paintLine(line: string, lines: readonly string[], index: number): string {
  if (line.startsWith("✓ ")) return `${GREEN}✓${RESET}${line.slice(1)}`;
  if (line.startsWith("! ")) return `${YELLOW}!${RESET}${line.slice(1)}`;
  if (line.startsWith("✕ ")) return `${RED}✕${RESET}${line.slice(1)}`;
  if (line.startsWith("› ")) return `${CYAN}›${RESET}${line.slice(1)}`;
  if (line.startsWith("○ ")) return `${DIM}${line}${RESET}`;
  if (/^\s*─+(?:\s+─+)*\s*$/.test(line)) return `${DIM}${line}${RESET}`;
  if (line.startsWith("  │ ")) return `  ${DIM}│${RESET}${line.slice(3)}`;
  if (isHeadingLine(line, lines, index)) return `${BOLD}${line}${RESET}`;
  return line;
}

function isHeadingLine(line: string, lines: readonly string[], index: number): boolean {
  if (line.length === 0 || /^\s/.test(line) || /^(?:#|\{|\[)/.test(line)) return false;
  if (/^[A-Z][A-Z0-9_]+: /.test(line) || /^[^:]{1,24}:\s+\S/.test(line)) return false;
  const previousIsBlank = index === 0 || lines[index - 1]?.length === 0;
  const nextIsBlank = index + 1 < lines.length && lines[index + 1]?.length === 0;
  return nextIsBlank || previousIsBlank && index === 0;
}

export function visibleWidth(value: string): number {
  const plain = value.replace(ANSI_PATTERN, "");
  let width = 0;
  for (const segment of graphemes(plain)) width += graphemeWidth(segment);
  return width;
}

export function padVisibleEnd(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

export function wrapVisibleText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  return value.replaceAll("\t", "  ").split("\n")
    .flatMap((paragraph) => wrapParagraph(paragraph, safeWidth));
}

function wrapParagraph(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    for (const chunk of splitVisible(word, width)) {
      if (current.length === 0) {
        current = chunk;
      } else if (visibleWidth(current) + 1 + visibleWidth(chunk) <= width) {
        current = `${current} ${chunk}`;
      } else {
        lines.push(current);
        current = chunk;
      }
    }
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

function splitVisible(value: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkWidth = 0;
  for (const segment of graphemes(value)) {
    const segmentWidth = graphemeWidth(segment);
    if (chunk.length > 0 && chunkWidth + segmentWidth > width) {
      chunks.push(chunk);
      chunk = "";
      chunkWidth = 0;
    }
    chunk += segment;
    chunkWidth += segmentWidth;
  }
  if (chunk.length > 0 || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
      .map(({ segment }) => segment);
  }
  return [...value];
}

function graphemeWidth(value: string): number {
  if (value.length === 0) return 0;
  if (/\p{Extended_Pictographic}/u.test(value)) return 2;
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || codePoint < 32 || codePoint >= 0x7f && codePoint < 0xa0) continue;
    if (/\p{Mark}/u.test(character) || codePoint === 0x200d || codePoint >= 0xfe00 && codePoint <= 0xfe0f) continue;
    width = Math.max(width, isWideCodePoint(codePoint) ? 2 : 1);
  }
  return width;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329 || codePoint === 0x232a
    || codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f
    || codePoint >= 0xac00 && codePoint <= 0xd7a3
    || codePoint >= 0xf900 && codePoint <= 0xfaff
    || codePoint >= 0xfe10 && codePoint <= 0xfe19
    || codePoint >= 0xfe30 && codePoint <= 0xfe6f
    || codePoint >= 0xff00 && codePoint <= 0xff60
    || codePoint >= 0xffe0 && codePoint <= 0xffe6
    || codePoint >= 0x1b000 && codePoint <= 0x1b2ff
    || codePoint >= 0x20000 && codePoint <= 0x3fffd
  );
}
