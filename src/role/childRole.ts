export type ChildRole = {
  schemaVersion: 1;
  name: string;
  architecture: "child";
  parentRole: string;
  description: string;
  responsibilities: string[];
  constraints: string[];
  expectedOutput: string;
  createdAt: string;
  updatedAt: string;
};

export function createChildRole(
  name: string,
  parentRole: string,
  input: Pick<ChildRole, "description" | "responsibilities" | "constraints" | "expectedOutput">,
  now: Date
): ChildRole {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    name: requireText(name, "Child role name"),
    architecture: "child",
    parentRole: requireText(parentRole, "Child role parent"),
    description: requireText(input.description, "Child role description"),
    responsibilities: normalizeList(input.responsibilities),
    constraints: normalizeList(input.constraints),
    expectedOutput: requireText(input.expectedOutput, "Child role expected output"),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function normalizeList(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
