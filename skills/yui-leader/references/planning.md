# Planning and activation handoff

Use this for Draft discussion, planning-only Sessions and the boundary into
delivery. The [Leader entry](../SKILL.md) owns shared context maintenance and
turn reporting; [Runtime](../../yui-runtime/SKILL.md) owns authority.

## Discuss and preserve the outcome

If the user asked only to create/store a Task, preserve the requirements and
stop: do not start a planning Session. Once discussion is authorized, clarify
requirements, inspect authorized current facts, compare options and revise the
technical approach as the conversation develops. Distinguish unresolved
questions, recommendations and accepted decisions.

Planning can include research explicitly authorized by the user and permitted
by the Session, Project and resource boundaries. Discussion is not delivery
authorization: do not modify Project code or run implementation tests merely
to support a proposal. Keep full planning results in supported Task result
storage and maintain the Brief's current summary and references. Planning
storage and Project delivery workspaces have different purposes and authority.

Saving a useful revision, reporting what changed and waiting for feedback is
the normal end of a discussion. Do not create implementation WorkItems,
dispatch, Review, acceptance or Task completion to make a planning turn look
finished. An InputRequest is not required for ordinary continued discussion.

## Hand off only through authorized activation

User/Operator submissions use `--intent record|discuss|develop` on
`operator submit` or an unaddressed `task message send`. The default is
`discuss`; Core does not infer intent from message text.

- `record` saves the message without waking the Leader.
- `discuss` on an unplanned Draft records the planning route and wakes planning.
- `develop` on an unplanned Draft saves the requirement and activation intent,
  then enters delivery through formal activation, without first starting planning.
- `develop` after planning has been entered saves the input but does not wake
  or activate; the routing result is `planned-needs-manual-activation`.

Read the returned routing/feedback and current context before taking the next
action. Active submissions do not downgrade or reactivate the Task; terminal
submissions do not reopen it. A stopped execution gate is not permission to
resume. `--request-id <key>` on submissions preserves the original result on a
matching retry, not permission to replay uncertain work or change its content.

Once planning has been entered, starting delivery requires a distinct,
explicit activation authorization. A development remark during discussion,
the end or failure of a planning Run, or Session replacement is not that
action and does not restore “blank Draft” status. Accepted planning routing
and historical Runs/Sessions count even when no Session is currently busy.
“Manual activation” means an explicit user action, not that the user must type
CLI commands: an authorized Operator can perform the mechanical operation.

With that authorization, inspect any existing activation request before creating
one with `task activation request <task-id> --request-id <id> --environment <plan>`.
Choose the plan from the authorized resources; retain the request id for retries.
The Controller adopts an eligible request. `task activate <task-id>` is the
foreground adoption operation for an existing request, not a request-free shortcut.
A planning Session requests activation and finishes its turn; it must not
synchronously wait for its own native turn to become quiescent.

Inspect the observable result. Preserve a busy or unknown
operation's exact request and follow
[Runtime recovery](../../yui-runtime/references/recovery.md); do not
self-dispatch, interrupt, kill or replace a Session to bypass the handoff.
New discussion during a pending handoff does not authorize a competing
planning Session. A failure calls for an explicit diagnosis and authorized
recovery, not automatic downgrade or replay.

Continue the durable requirements once the Task is formally active and a
delivery-authorized Session/workspace is ready. Do not demand another
“continue.” An old planning Session remains planning-scoped: preserve its
successor context and end its turn rather than promoting itself.

## Task artifact operations

These operations apply to planning and delivery results. The current Leader
adopts contributions from other Agents' authorized workspaces; do not share
an uncoordinated Git index or edit Yui storage directly.

```sh
yui task artifact list <task-id>
yui task artifact save <task-id> plans/design.md "<UTF-8 content>" --message "Revise design"
yui task artifact read <task-id> plans/design.md
yui task artifact read <task-id> plans/design.md <full-commit>
```

`save` writes and locally commits exactly one relative path, creating the
repository on first save. The `artifact.save` capability takes `taskId`,
`relativePath`, `content`, optional `message` and optional `expectedHead`;
the CLI equivalent is `--expected-head <commit>`. A head conflict leaves
the save unapplied: re-read and reconcile the intended update, not overwrite
blindly. The text interface accepts UTF-8 files up to 8 MiB, not arbitrary
binary payloads or an invented directory-upload command.

Current reads use Task and relative path at HEAD. Frozen Candidate, Review,
Context and completion evidence use the returned `taskId + commit +
relativePath`; do not replace a pinned read with a current read. For same-Task
string reference lists, use `git:<full-commit>:<relativePath>`, including
`task complete ... --artifact-ref "git:<full-commit>:plans/design.md"`.
The commit must be the artifact repository's returned commit, not the Project
code head. Preserve fixed old references when updating the current document.

After a meaningful save, update the Brief's summary/reference; keep Decisions
to the choice, reason and boundary. No document-body, HEAD or timestamp mirror
is needed. The artifact repository has no remote or transport; this does not
prohibit a Project code repository's legitimate remote. Saving in Draft grants
no delivery authority; Session handoff and archive preserve the artifacts.
Stored scripts/HTML remain data and are never implicitly executed or previewed.

These commands describe this source version's interface. A managed Session
still uses its authorized CLI and actual available capabilities. If an older
installation lacks them, report that version boundary; do not switch it to
an unapproved checkout CLI, migrate a shared Home, or upgrade the installation
merely to save a result.
