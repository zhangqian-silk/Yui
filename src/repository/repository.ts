import { resolve } from "node:path";

export type Repository = Readonly<{
  schemaVersion: 1;
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}>;

export function createRepository(
  id: string,
  name: string,
  path: string,
  defaultBranch: string,
  now: Date
): Repository {
  const timestamp = now.toISOString();
  return validateRepository({
    schemaVersion: 1,
    id: requireIdentity(id, "Repository id"),
    name: requireText(name, "Repository name"),
    path: resolve(requireText(path, "Repository path")),
    defaultBranch: requireGitRef(defaultBranch),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function validateRepository(repository: Repository): Repository {
  if (repository.schemaVersion !== 1) {
    throw new Error("Repository must use schemaVersion 1.");
  }
  requireIdentity(repository.id, "Repository id");
  requireText(repository.name, "Repository name");
  if (resolve(requireText(repository.path, "Repository path")) !== repository.path) {
    throw new Error("Repository path must be absolute and normalized.");
  }
  requireGitRef(repository.defaultBranch);
  requireTimestamp(repository.createdAt, "Repository createdAt");
  requireTimestamp(repository.updatedAt, "Repository updatedAt");
  return repository;
}

function requireIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireGitRef(value: string): string {
  const ref = requireText(value, "Repository base ref");
  if (ref.startsWith("-") || /[\r\n]/.test(ref)) {
    throw new Error("Repository base ref is invalid.");
  }
  return ref;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}
