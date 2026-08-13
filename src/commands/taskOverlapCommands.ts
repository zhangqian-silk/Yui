import { usageError } from "../errors/cliError.js";
import type { ChangeSet } from "../integration/changeSet.js";
import {
  diagnoseOverlap,
  overlapSubjectFromChangeSet,
  overlapSubjectKey,
  type OverlapFinding
} from "../integration/overlapDiagnostics.js";
import type { TaskStore } from "../storage/taskStore.js";

/**
 * Read-only cross-Task overlap diagnostics.  Gathers the latest ChangeSet
 * per (Task, WorkItem, Project) and reports semantic overlap, a suggested
 * integration order, and semantic review areas.  Never mutates state.
 */
export async function runTaskOverlapCommand(
  args: readonly string[],
  store: TaskStore
): Promise<Readonly<{ output: string; data?: unknown }>> {
  const parsed = parseOverlapArgs(args);
  const tasks = store.listTasks()
    .filter((task) => parsed.tasks.size === 0 || parsed.tasks.has(task.id));
  const latest = new Map<string, ChangeSet>();
  for (const task of tasks) {
    for (const changeSet of store.listChangeSets(task.id)) {
      if (parsed.project !== undefined && changeSet.projectId !== parsed.project) continue;
      if (parsed.base !== undefined && changeSet.baseCommit !== parsed.base) continue;
      const key = `${changeSet.taskId}/${changeSet.workItemId}/${changeSet.projectId}`;
      const current = latest.get(key);
      if (current === undefined || isNewer(changeSet, current)) {
        latest.set(key, changeSet);
      }
    }
  }
  const subjects = [...latest.values()].map(overlapSubjectFromChangeSet);
  const report = diagnoseOverlap(subjects);
  return {
    output: renderOverlapReport(report.findings, report.suggestedOrder, report.reviewAreas, subjects),
    data: { report }
  };
}

function isNewer(candidate: ChangeSet, current: ChangeSet): boolean {
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt;
  }
  return candidate.id.localeCompare(current.id) > 0;
}

function parseOverlapArgs(args: readonly string[]): Readonly<{
  project?: string;
  base?: string;
  tasks: ReadonlySet<string>;
}> {
  let project: string | undefined;
  let base: string | undefined;
  const tasks = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      project = requireValue(args, index, "--project");
      index += 1;
    } else if (arg === "--base") {
      base = requireValue(args, index, "--base");
      index += 1;
    } else if (arg === "--task") {
      tasks.add(requireValue(args, index, "--task"));
      index += 1;
    } else {
      throw usageError(
        "Task overlap usage: yui task overlap [--project <project>] [--base <sha>] [--task <task>] ..."
      );
    }
  }
  return { project, base, tasks };
}

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw usageError(`Task overlap option ${option} requires a value.`);
  }
  return value;
}

function renderOverlapReport(
  findings: readonly OverlapFinding[],
  suggestedOrder: readonly string[],
  reviewAreas: readonly string[],
  subjects: readonly ReturnType<typeof overlapSubjectFromChangeSet>[]
): string {
  const lines = [
    `Overlap: ${subjects.length} subjects, ${findings.length} findings`
  ];
  if (subjects.length === 0) {
    lines.push("No ChangeSets match the given filters.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("Subjects:");
  for (const subject of subjects) {
    const tags = subject.manifestTags.length === 0 ? "-" : subject.manifestTags.join(",");
    lines.push(
      `  ${subject.changeSetId} ${subject.taskId}/${subject.workItemId} ${subject.projectId} `
      + `base=${subject.baseCommit.slice(0, 12)} head=${subject.headCommit.slice(0, 12)} tags=${tags}`
    );
  }
  if (findings.length === 0) {
    lines.push("No semantic overlap detected.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(`  [${finding.risk}] ${finding.kind}: ${finding.changeSetIds.join(" vs ")}`);
      for (const path of finding.paths) lines.push(`    ${path}`);
      lines.push(`    ${finding.detail}`);
    }
  }
  lines.push("Suggested integration order:");
  suggestedOrder.forEach((ref, index) => {
    const subject = subjects.find((candidate) => overlapSubjectKey(candidate) === ref);
    lines.push(`  ${index + 1}. ${ref}${subject === undefined ? "" : ` (${subject.workItemId})`}`);
  });
  if (reviewAreas.length === 0) {
    lines.push("Review areas: none (no high/medium findings)");
  } else {
    lines.push("Review areas:");
    for (const area of reviewAreas) lines.push(`  - ${area}`);
  }
  return `${lines.join("\n")}\n`;
}
