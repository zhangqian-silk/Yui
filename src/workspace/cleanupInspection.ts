import { isAbsolute, join, relative } from "node:path";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";

/** Ephemeral observations shared by inspection and the actual cleanup boundary.
 * Never persisted as a plan, nor accepted as permission to remove a resource.
 */
export type CleanupCheck = Readonly<{
  resource: string;
  reason: string;
  status: "blocked" | "unknown";
  detail: string;
  expected: unknown;
  observed: unknown;
  sources: readonly string[];
  actions: readonly string[];
}>;

export class CleanupInspectionError extends Error {
  constructor(readonly checks: readonly CleanupCheck[]) {
    super(checks.map(renderCleanupCheck).join("\n"));
    this.name = "CleanupInspectionError";
  }
}

export function renderCleanupCheck(check: CleanupCheck): string {
  return `[${check.reason}] ${check.resource}: ${check.detail}`
    + ` Expected=${JSON.stringify(check.expected)}; observed=${JSON.stringify(check.observed)}.`
    + (check.actions.length === 0 ? "" : ` Inspect/resolve: ${check.actions.join("; ")}.`);
}

/** Do not forward arbitrary Git stderr, native arguments, or foreign paths. */
export function cleanupCheckFromError(error: unknown, resource: string, sources: readonly string[],
  actions: readonly string[]): CleanupCheck[] {
  if (error instanceof CleanupInspectionError) {
    return error.checks.map(check => ({ ...check, resource, sources, actions }));
  }
  let cause = error;
  let errorCode: string | number | undefined;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    const code = (cause as NodeJS.ErrnoException).code;
    if ((typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code))
      || (typeof code === "number" && Number.isSafeInteger(code))) {
      errorCode = code;
      break;
    }
    cause = cause.cause;
  }
  return [{ resource, reason: "inspection-unavailable", status: "unknown",
    detail: "The resource could not be inspected; no safe cleanup conclusion is available.",
    expected: "readable owned resource", observed: errorCode === undefined ? "unavailable" : { errorCode }, sources, actions }];
}

export function cleanupFailure(reason: string, detail: string, expected: unknown, observed: unknown,
  status: CleanupCheck["status"] = "blocked"): never {
  throw new CleanupInspectionError([{ resource: "git-workspace", reason, status,
    detail, expected, observed, sources: [], actions: [] }]);
}

/** Describe exact differences without disclosing paths outside this Task.
 * Legacy locations are displayed only for this Task's exact branch identity;
 * displaying a historical location is not accepting it as migration proof.
 */
export function workspacePathValue(workspace: ManagedWorkspace, path: string): string {
  const inside = (root: string) => {
    const value = relative(root, path);
    return value !== ".." && !value.startsWith("../") && !isAbsolute(value) ? value || "." : undefined;
  };
  const marker = `/workspaces/tasks/${workspace.owner.taskId}/`;
  const index = workspace.root.lastIndexOf(marker);
  if (index >= 0) {
    const home = workspace.root.slice(0, index);
    const taskPath = inside(join(home, "workspaces", "tasks", workspace.owner.taskId));
    if (taskPath !== undefined) return `<task>/${taskPath}`;
    const legacyPath = inside(join(home, "workspaces", "worktree"));
    const parts = legacyPath?.split("/");
    const taskSegment = workspace.entries.find(e => e.access === "write")?.branch.split("/")[1];
    if (parts?.length === 3 && parts[1] === taskSegment) return `<legacy-worktree>/${legacyPath}`;
  }
  const local = inside(workspace.root);
  return local === undefined ? "[outside authorized Task paths]" : `<owner>/${local}`;
}
