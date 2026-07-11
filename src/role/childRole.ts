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
  const trimmedName = name.trim();
  const trimmedParent = parentRole.trim();
  const description = input.description.trim();
  const expectedOutput = input.expectedOutput.trim();

  if (trimmedName.length === 0) {
    throw new Error("Child role name is required.");
  }

  if (trimmedParent.length === 0) {
    throw new Error("Child role parent is required.");
  }

  if (description.length === 0) {
    throw new Error("Child role description is required.");
  }

  if (expectedOutput.length === 0) {
    throw new Error("Child role expected output is required.");
  }

  const timestamp = now.toISOString();

  return {
    schemaVersion: 1,
    name: trimmedName,
    architecture: "child",
    parentRole: trimmedParent,
    description,
    responsibilities: input.responsibilities.map((item) => item.trim()).filter(Boolean),
    constraints: input.constraints.map((item) => item.trim()).filter(Boolean),
    expectedOutput,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
