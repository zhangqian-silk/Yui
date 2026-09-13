import { usageError } from "../errors/cliError.js";

export function parseRepeatable(
  args: readonly string[],
  repeatable: ReadonlySet<string>,
  singular: ReadonlySet<string>,
  usage: string
): Readonly<{
  positionals: string[];
  many: Map<string, string[]>;
  one: Map<string, string>;
}> {
  const positionals: string[] = [];
  const many = new Map<string, string[]>();
  const one = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!repeatable.has(value) && !singular.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (singular.has(value) && one.has(value)) {
      throw usageError(`Option may only be specified once: ${value}.`, usage);
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    if (repeatable.has(value)) many.set(value, [...(many.get(value) ?? []), optionValue]);
    else one.set(value, optionValue);
    index += 1;
  }
  return { positionals, many, one };
}
