export function hasNonWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isEcmaScriptWhitespace(value[index])) return true;
  }
  return false;
}

export function hasNoSurroundingWhitespace(value: string): boolean {
  return value.length > 0 &&
    !isEcmaScriptWhitespace(value[0]) &&
    !isEcmaScriptWhitespace(value[value.length - 1]);
}

export function trimSurroundingWhitespace(value: string): string {
  let start = 0;
  while (start < value.length && isEcmaScriptWhitespace(value[start])) start += 1;
  let end = value.length;
  while (end > start && isEcmaScriptWhitespace(value[end - 1])) end -= 1;
  if (start === 0 && end === value.length) return value;
  let trimmed = "";
  for (let index = start; index < end; index += 1) trimmed += value[index];
  return trimmed;
}

function isEcmaScriptWhitespace(character: string): boolean {
  return (character >= "\u0009" && character <= "\u000d") ||
    character === "\u0020" ||
    character === "\u00a0" ||
    character === "\u1680" ||
    (character >= "\u2000" && character <= "\u200a") ||
    character === "\u2028" ||
    character === "\u2029" ||
    character === "\u202f" ||
    character === "\u205f" ||
    character === "\u3000" ||
    character === "\ufeff";
}
