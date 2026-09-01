---
name: yui-runtime
description: Load and use the authorized context for every Yui-managed Leader, Worker, Reviewer, Operator, or custom Role Turn, and complete that Turn through its bounded control-plane protocol.
---

# Yui Runtime

Treat the Session Manifest and Turn Bootstrap Envelope as pointers, never as the
Task brief. Do not infer Task facts from the launch command, process list,
workspace layout, native transcript, or an earlier Turn.

For every managed Task Turn:

1. Read the exact Turn identity from the newest Bootstrap Envelope.
2. Before acting, load its authorized pack with the Session CLI named by the
   current Session Manifest:

   ```sh
   "$YUI_SESSION_CLI" task turn context "$YUI_TASK_ID/<turn-id>" --json
   ```

3. Verify that the returned Task, Turn, Role, purpose, Snapshot digest, workspace,
   and Adapter match the Envelope and Session Manifest. Stop and report a
   context-load failure if the pack is missing, stale, unauthorized, malformed,
   or mismatched. Never request an inline/full-prompt fallback.
4. Use pack summaries and pointers first. Expand only an authorized ref when
   its full value is needed, selecting it by the pointer's exact `store` and
   `refId`:

   ```sh
   "$YUI_SESSION_CLI" task turn context expand "$YUI_TASK_ID/<turn-id>" <ref-id> --store <store> --mode full --json
   ```

   A bare `<ref-id>` remains supported only when it identifies exactly one
   authorized pointer. If multiple stores use that id, bare expansion fails
   closed; never guess which store was intended.

5. On a later wake, request only the declared delta after the last pack cursor.
   If no cursor is available, reload the exact pack; do not reconstruct state
   from transcript memory.

The pack's authority view and writable Project IDs are hard boundaries. A
native subagent inherits the parent Turn's refs and authority; it does not gain a
new Yui actor, Turn, Session, or cross-Task read permission.

For a global Operator or custom GlobalRole Session, execute the exact
`contextProtocol.loadCommand` carried by the current Session Manifest before
routing or acting. That command is self-contained because a Global Codex Thread
may move between Yui's remote TUI and Desktop; never reconstruct it from
`YUI_SESSION_*` process variables.

Global context grants no Task implementation workspace. Read a Task only after
the Operator has routed to its public/task-authorized context command; never
invent a Task Turn identity for a GlobalRole.

Provider acceptance, Context load, Turn completion, and Task completion are
separate facts. For a managed Task Turn, end the Provider Turn with one truthful
final report. Yui automatically correlates that native terminal with the exact
current Turn and persists the report; no completion command is required. The
Leader alone decides whether the WorkItem or Task is complete.

After a failed Provider Turn, read the referenced `runtime.agent-error` fact.
The failed Turn is immutable; a recovery is always a new Turn. Continue on the
same native Session when it remains recoverable, and load only the current Turn
delta instead of replaying its original Assignment. A new Host process does not
imply a new Session, and a new Session must never be substituted silently for
the persisted native Session id.
