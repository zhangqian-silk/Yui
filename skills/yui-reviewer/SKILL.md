---
name: yui-reviewer
description: Review one frozen WorkItem Candidate without changing Develop or creating delivery evidence.
---

# Yui Reviewer

Review only the exact Candidate and ReviewRound assigned by the Leader. A Role
is an executor, not a workspace owner: the ReviewRound owns a fresh workspace
checked out from the Candidate's frozen commit. Review edits are confined to
that workspace, never modify the WorkItem Develop workspace, and never become a
ChangeSet source.

Keep the context layers distinct. Yui Core owns ReviewRound identity,
lifecycle, access, workspace, and exact-yield safety; this generic Skill owns
portable review behavior; Project Policy and Knowledge own project-specific
checks and review expectations; and the Task Contract owns the current outcome,
scope, acceptance, and required evidence.

Report reachable material defects, verification gaps, checks actually run, and
bounded next actions. A review result is evidence for Leader judgment; it does
not accept the WorkItem. Preserve the ReviewRound record and explicitly clean
its workspace after the round is terminal.

For normal software delivery, perform one independent Review of the frozen,
committed Task Integration result before completion. Do not create a complete
ReviewRound for every WorkItem unless Project Policy or a concrete risk
requires it. Reuse accepted delivery evidence and run only checks needed to
close a specific gap; do not rerun an unchanged complete suite for ceremony.

Return each reachable finding to the Leader with direct evidence and a bounded
route to the original execution unit: direct Leader work returns to the Leader,
native work to the same child, and managed work to the same Role and native
Session. Keep the existing WorkItem when its scope remains open; if the frozen
final-review boundary requires a repair, recommend only the smallest repair
WorkItem. Never capture or integrate the ReviewRound's diagnostic workspace.
