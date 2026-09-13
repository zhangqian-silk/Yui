---
name: yui-runtime
description: Use authorized context, durable results, and recovery boundaries in a Yui-managed Session, including global conversation, direct Leader work, and dispatched AgentRuns.
---

# Yui Runtime

Use this Skill for the shared Yui execution contract. The Role Skill owns
coordination or delivery judgment; Project Skills, Policy and Knowledge own
project-specific methods. These instructions grant no additional authority.
Resolve links relative to this Skill's directory, not the execution workspace.

Treat the Session Manifest and AgentRun Bootstrap Envelope as pointers, never as the
Task brief. Do not infer Task facts from the launch command, process list,
workspace layout, native transcript, or an earlier AgentRun.

## Enter through the current context

There are two normal Task entry points. A user may continue directly with the
current, unrevoked Leader Session: read current context using the Session CLI
with `task context <task-id> --json`. Do not request a self-wake, reopen a Task,
or reuse an old completed AgentRun snapshot merely to obtain authority. Pending
delivery, unknown execution evidence and missing reports do not themselves
revoke Session authority. Task lifecycle, scope, Assignment, workspace and
resource boundaries still apply; a planning Session does not gain delivery
authority merely because the Task becomes active.
Use the runtime-provided `TMPDIR` for temporary context or diagnostic files,
not fixed shared `/tmp` names or the logical multi-Project workspace container.

For every explicitly dispatched managed Task AgentRun:

1. Read the exact AgentRun identity from the newest Bootstrap Envelope.
2. Before acting, load its authorized pack with the Session CLI named by the
   current Session Manifest:

   ```sh
   "$YUI_SESSION_CLI" task run context "$YUI_TASK_ID/<run-id>" --json
   ```

3. Verify that the returned Task, AgentRun, Role, purpose, Snapshot digest, workspace,
   and Adapter match the Envelope and Session Manifest. Stop and report a
   context-load failure if the pack is missing, stale, unauthorized, malformed,
   or mismatched. Never request an inline/full-prompt fallback.
4. Use pack summaries and pointers first. Expand only an authorized ref when
   its full value is needed, selecting it by the pointer's exact `store` and
   `refId`:

   ```sh
   "$YUI_SESSION_CLI" task run context expand "$YUI_TASK_ID/<run-id>" <ref-id> --store <store> --mode full --json
   ```

   A bare `<ref-id>` remains supported only when it identifies exactly one
   authorized pointer. If multiple stores use that id, bare expansion fails
   closed; never guess which store was intended.

   A pointer or summary is not the request's body. Before planning or executing,
   read the relevant WorkItem/Task requirements and referenced user/Operator
   messages; use the expansion command above or the Leader's current Task Context.
   Reports remain evidence, not authority to enlarge the assignment.

5. On a later wake, request only the declared delta after the last pack cursor.
   If no cursor is available, reload the exact pack; do not reconstruct state
   from transcript memory.

Loading and verifying Context is the start of the work, not its result. Continue
with the authorized assignment. In Draft, persist the discussed plan and wait
when the user asks for alignment; do not end with only a context-loaded receipt.

`liveTaskState.activeRuns` and `liveTaskState.activeTaskReviews` are
observational views of work currently in flight. They grant no authority and
create no Task-wide lock or gate; use each exact AgentRun or Review binding when a
decision depends on it.

The pack's authority view and writable Project IDs are hard boundaries. A
native subagent inherits only its parent's current refs and authority, including
any Assignment restrictions. It gains no new Yui actor, AgentRun, Session or
cross-Task read permission.

For a global Operator or custom GlobalRole Session, execute the exact
`contextProtocol.loadCommand` carried by the current Session Manifest before
routing or acting. That command is self-contained because a Global Codex Thread
may move between Yui's remote TUI and Desktop; never reconstruct it from
`YUI_SESSION_*` process variables.

If that read fails because the Controller is unavailable, use only authorized
offline diagnostics and [Controller recovery](references/recovery.md) to restore
access, then reload context. Failure does not grant Task execution authority,
but a successful preliminary RPC is not a prerequisite for that recovery.

Global context grants no Task implementation workspace. Read a Task only after
the Operator has routed to its public/task-authorized context command; never
invent a Task AgentRun identity for a GlobalRole.

A GlobalRole's durable input uses the same three actions as a Task Role,
addressed by the Role's own name instead of a Task. The local-user Web surface
exposes this contract. The current public CLI catalog does not register the
top-level `role` path, even though its handlers implement `yui role message
queue|steer` and `yui role interrupt`; CLI routing rejects these commands as
unknown. Report this availability gap when it prevents authorized work. Do not
invent another command, fabricate Task/Run ownership or borrow the browser's
user authority to bypass a managed Session boundary.

Queue and steer
save an owned Message; bare interrupt records a control request, not a new
Message. Each uses a stable request id and that Role's own Session; none fabricates a Task or
runId to reuse Task-scoped delivery. `queue` delivers at the Role's next legal
opportunity and is idempotent by request id. `steer` and `interrupt` affect only
the exact current native Turn — a stale `--expected-target`, an incapable plan,
or an unproven delivery leaves the Message saved and reports the reason, and
`interrupt` stops only through the Provider's native cancel with an optional
`--then-message` naming one already-saved GlobalRole Message. When the Role holds
no live managed Turn, a steer or interrupt is `NO_ACTIVE_TURN` and never falls
back to another action.

New controlled Global Sessions use the existing Host console, not the native
TUI, with the configured Agent, permissions and workspace unchanged. A live
unmanaged Session is not silently replaced or adopted; use an explicit Session
lifecycle action before enabling controlled delivery.

Context reads never consume queue entries. Read the referenced Message in full
from Session Context. Native/transport acceptance is not implementation, and
`interrupt-requested` is not a stopped Turn or stopped background resources.
Only an exact terminal and the original Session/writer boundary can release a
then handoff. An accepted or unconfirmed steer must not be submitted again by
changing its request id or composing then. A conclusive rejection permits an
explicit new control attempt; uncertainty does not.

## Preserve intent and authority

An analysis, diagnosis, or review request is read-only unless the user also
requests changes. A request to fix or implement authorizes the bounded work,
not unrelated configuration, new external effects, or broader cleanup.
Choose routine legal implementation and recovery actions without asking the
user to operate Yui mechanically.

Tasks, WorkItems, Messages, Decisions, results and managed workspaces hold
durable intent and progress. Sessions, AgentRuns and runtime observations
describe execution; their failure is not failed acceptance or permission to
discard the assignment. Save context that a successor needs in durable records,
not only in the native conversation.

The Leader normally owns Task coordination and acceptance. An authorized
Operator may perform the same legal Task-management actions; responsibility
is not an extra permission gate. Worker and Reviewer results remain evidence
until an authorized acceptance decision.

## Separate execution from real-resource validation

The current Leader and configured Worker, Reviewer, Operator, custom Role, and
native child Agents are normal execution resources. They may develop, inspect,
and review within their existing Task authority without additional user
authorization merely because the Agent uses a real model.

Using a live provider or model as the subject of validation is different.
Paid APIs, shared infrastructure, production systems, real account quota, and
other non-disposable external effects require the user to proactively authorize
that exact resource and effect boundary. A generic request to implement, test,
validate, run E2E, or complete a Task does not grant that authority.

When such validation was not requested, use deterministic or isolated evidence,
state the material gap, and optionally recommend a separate follow-up. Do not
create an InputRequest merely to solicit permission for it.

## Return evidence and recover within scope

Provider acceptance, Context load, AgentRun completion, and Task completion are
separate facts. For an explicitly dispatched managed Task AgentRun, end with one truthful
final report. Yui automatically correlates that native terminal with the exact
current AgentRun and persists the report; no completion command is required. The
report itself does not accept the WorkItem or complete the Task.

Ordinary native conversation is not an implicit managed assignment and does
not require a separate execution report. Result Messages reference the
execution's original report; read them with `task message show <task/message>`
instead of asking the producer to copy or resend the report.

Session reuse is a preference, not a prerequisite for progress. Before retry,
replacement, or intervention in uncertain execution, read
[runtime recovery](references/recovery.md). Preserve pending intent, exact
runtime identity and workspace progress; never edit Run status or substitute
a native Session behind Yui's back. A timeout is not proof of quiescence and
does not authorize replay of unknown input.

After an authorized external PR/MR operation, use the shared
[publication recording contract](references/publication.md). Recording delivery
facts does not authorize the external operation, imply acceptance, or grant
permission to archive.
