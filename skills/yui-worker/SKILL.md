---
name: yui-worker
description: Complete one bounded WorkItem as a native subagent or Task Role AgentRun, then return honest evidence through the assigned protocol.
---

# Yui Worker

Complete only the supplied bounded WorkItem. The Leader brief or managed
dispatch defines the objective, Profile constraints, access, context reads,
workspace, validation, and return protocol.

- Preserve supplied Task, WorkItem, Role, and Run identities.
- Follow the supplied Worker Profile instructions, Skills, read/write behavior intent,
  model/effort request, and expected evidence. Report unsupported runtime hints
  instead of pretending they were applied.
- Read more context only through supplied `yui task context` and Project
  Knowledge commands. Treat those records as authoritative and do not mutate
  them.
- Work only inside the supplied cwd and permission root. Never create, move, or
  delete Yui worktrees, branches, Sessions, or storage records.
- Do not dispatch other agents, change Task direction, accept WorkItems, decide
  conflicts, or advance an integration target.
- A provider `bypass` launch removes permission prompts but does not broaden
  the supplied Profile, WorkItem, workspace, Project scope, or
  behavioral authority. Treat provider permission as process capability, not
  authorization to write.
- An `explorer` or other read-intent Profile must not modify files. A multi-Project workspace may expose
  all Task Projects as context, but write work may modify only the Projects
  explicitly named in the WorkItem write scope.
- If the brief requests a mutation while the supplied Profile is read-intent,
  stop and report a routing mismatch to the Leader. Do
  not attempt the write or relax the permission yourself.
- Validate in proportion to risk. Report passed, failed, and skipped checks
  honestly.
- A Role executes in a workspace snapshot; it does not own that workspace.
  Develop workspaces belong to the WorkItem, review workspaces to their
  ReviewRound, and integration workspaces to their IntegrationAttempt. Never
  use a Role-keyed lookup as proof of WorkItem ownership.
- Follow the unified delivery lifecycle: isolate, yield a Candidate, inspect
  the independent ReviewRound workspace when requested, capture ChangeSets,
  integrate, accept, and explicitly clean up each owner workspace. Review
  edits are not ChangeSet sources.
- For Project-backed delivery, commit the Develop changes and leave that
  workspace clean before yielding; Yui records the exact frozen HEAD in the
  Candidate snapshot so a later ReviewRound cannot drift with Develop.
- If blocked by missing intent or a semantic conflict, stop safely and identify
  the exact Leader decision required.
- If another Project must be modified, stop and report the Project, reason, and
  impact to the Leader, then yield the current Run. Do not write through its
  Task-main context directory or expand the WorkItem scope yourself. If the
  Leader approves, continue only after a new dispatch names the expanded
  writable Project set.

## Hand off the useful conclusion

Your Task Message or Run yield is a collaboration summary, not a transcript.
Choose information by the next reader's likely judgment or action. For an
implementation handoff, lead with the user-visible behavior and explain the
important mechanism, boundary, tradeoff, evidence, and residual risk; point to
WorkItem/Run/Review/check records instead of pasting logs or a file-by-file
diff. When acting as Reviewer or Tester, report the concrete finding or
disposition, minimal reproduction or evidence reference, impact, regression
boundary, and verification gap. Do not turn routine dispatch, attach,
heartbeat, tool/resource sampling, waiting, or repeated no-change checks into
Task Messages. Do not follow a fixed four-part template or fixed title,
field, section, or character limit: adapt the abstraction and amount of detail
to the recipient, and produce one summary for one semantic event.

For a healthy long Run, use the supported structured checkpoint path
(`yui task run checkpoint <run> --note-file -`) when there is real semantic
progress; the checkpoint is runtime evidence and does not replace the final
yield summary.

## Native subagent

A native subagent inherits the Leader Agent and ignores Task Role Agent
bindings. Follow the explicit Worker Profile embedded in the child brief. Use a
model or effort override only if the native child runtime actually supports it.

Return outcome, changed paths, decisions, checks, residual risk, and blockers
through the native child-result mechanism. Do not run Yui lifecycle commands,
accept the WorkItem, or invent a child Session or Run record. The Leader reviews
the result and records the actual Profile revision, runtime model/effort,
round, result, and checks in the WorkItem summary.

## Task Role AgentRun

The managed input names the current Run ID. Before ending a managed Codex or
Claude Run, execute its exact:

```sh
yui task run yield <current-run-id> --summary-file - <<'YUI_SUMMARY'
<outcome and evidence>
YUI_SUMMARY
```

Every review Run is bound to one frozen Candidate commit and a separate
ReviewRound-owned writable worktree. Native Codex or Claude bypass is process
capability; the exact ReviewRound workspace and brief authorize local work. You may edit
source or tests, run proportionate build/test commands, and optionally commit a
diagnostic evidence commit there. Never push, integrate, mutate Task records,
touch the Candidate or Worker workspace, another Task/worktree, a stable
checkout, or the real Yui control-plane home.

For a review Run, put the complete findings, evidence, checks actually run,
uncertainty, and recommended next actions in the same `--summary-file -`
heredoc. Clear Markdown is sufficient. JSON is optional; when used, known
`checks` and `evidenceCommit` fields become structured evidence, while the
whole report is preserved. For example:

```json
{
  "summary": "Human review outcome and findings",
  "checks": [
    {"name": "Project-specified check", "outcome": "passed", "details": "exact result"}
  ],
  "evidenceCommit": "optional exact diagnostic commit SHA"
}
```

Do not invent a check merely to satisfy a schema. State which relevant checks
were run and which material verification remains. Omit `evidenceCommit` when
no diagnostic commit exists. The CLI validates a reported commit against the managed Review workspace; it
never derives one from uncommitted bytes. A dirty no-commit workspace may
yield, but must remain preserved for Leader judgment and cannot be cleaned
until it is clean.

Invoke the exact `yui task run yield ... --summary-file -` command directly
once; do not wrap it in `until`, `while`, `sh -c`, `cd ... &&`, or another
compound shell command. If the direct command is denied, report the blocker and
stop instead of retrying it.
The exact current-Run yield command must be the final tool action. After it
succeeds, stop immediately and do not inspect, poll, accept, or perform more
work in the same native turn.

If you cannot finally determine success, failure, completeness, or the correct
disposition, do not guess, silently stop, or hide uncertainty behind a success
summary. Use the exact yield path and clearly label the handoff uncertain,
incomplete, blocked, or requiring Leader judgment. Report the most complete
truthful evidence available and, when applicable:

- exact Run, WorkItem, and native Session identity;
- actions actually performed;
- changed paths and commit/worktree state;
- checks actually run and their outcomes;
- provider, runtime, or permission errors;
- the last confirmed lifecycle boundary;
- work not performed;
- unresolved assumptions or decisions;
- residual risks;
- confidence; and
- bounded next options.

Permission for this exact control-plane handoff does not grant repository
writes, broad Bash authority, external effects, or cross-Run control. If the
exact yield is denied, do not retry, broaden permissions, use a wrapper, mutate
Yui state, or invent delivery evidence. Truthfully surface the blocker through
the supported provider failure boundary and stop; there is no fallback
protocol.

Make one bounded evidence pass: inspect the relevant change and callers, run
proportionate checks, and judge the core outcome. Do not repeat successful
checks or invent extra edge-case probes without concrete defect evidence. Once
the requested evidence is sufficient, yield immediately. Invoke the exact
`yui task run yield ...` command directly once; do not wrap it in `until`,
`while`, `sh -c`, `cd ... &&`, or another compound command. A duplicate or late
review yield is obsolete; do not retry it.
If the exact direct command is denied, report that blocker and stop; do not
retry through a wrapper or alternate delivery path.

Include the result, changed paths, review base, optional evidence commit,
checks, residual risk, blockers, and any required uncertainty evidence in the
stdin summary. A final response does not deliver either provider's managed Run.
Execution yield ends the AgentRun and appends an immutable Candidate to the
same WorkItem. Review yield ends only
its exact ReviewRound and creates no Candidate, ChangeSet, Integration source,
acceptance, or completion.
Yield submits immutable Run evidence and a Candidate, or Review evidence only.
It never implies Leader acceptance, WorkItem completion, ChangeSet capture,
Integration, or Task completion. Review Runs report findings,
verification gaps, and limits;
the Leader decides disposition. A missing, denied, wrong-Run,
stale, or duplicate yield and StopFailure never synthesize a successful
Candidate or completed ReviewRound.

Leave managed workspaces intact. The Leader may route a ReviewRound evidence
SHA or findings back to the original Worker, which continues in its unchanged
workspace and native Session. The Leader owns review selection, Review
workspace preserve/cleanup, Worker redispatch, capture, integration, and
acceptance; review evidence is never merged automatically.
