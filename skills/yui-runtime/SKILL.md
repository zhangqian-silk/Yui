---
name: yui-runtime
description: Load and use the authorized context for every Yui-managed Leader, Worker, Reviewer, Operator, or custom Role Run, and complete that Run through its bounded control-plane protocol.
---

# Yui Runtime

Treat the Session Manifest and Run Bootstrap Envelope as pointers, never as the
Task brief. Do not infer Task facts from the launch command, process list,
workspace layout, native transcript, or an earlier Run.

For every managed Task Run:

1. Read the exact Run identity from the newest Bootstrap Envelope.
2. Before acting, load its authorized pack with the ordinary Yui CLI command:

   ```sh
   yui task run context "$YUI_TASK_ID/<run-id>" --json
   ```

3. Verify that the returned Task, Run, Role, purpose, Snapshot digest, workspace,
   and Adapter match the Envelope and Session Manifest. Stop and report a
   context-load failure if the pack is missing, stale, unauthorized, malformed,
   or mismatched. Never request an inline/full-prompt fallback.
4. Use pack summaries and pointers first. Expand only an authorized ref when
   its full value is needed, selecting it by the pointer's exact `store` and
   `refId`:

   ```sh
   yui task run context expand "$YUI_TASK_ID/<run-id>" <ref-id> --store <store> --mode full --json
   ```

   A bare `<ref-id>` remains supported only when it identifies exactly one
   authorized pointer. If multiple stores use that id, bare expansion fails
   closed; never guess which store was intended.

5. On a later wake, request only the declared delta after the last pack cursor.
   If no cursor is available, reload the exact pack; do not reconstruct state
   from transcript memory.

The pack's authority view and writable Project IDs are hard boundaries. A
native subagent inherits the parent Run's refs and authority; it does not gain a
new Yui actor, Run, Session, or cross-Task read permission.

For a global Operator or custom GlobalRole Session, load the stable authorized view
before routing or acting:

```sh
yui session context "$YUI_ROLE" --json
```

Global context grants no Task implementation workspace. Read a Task only after
the Operator has routed to its public/task-authorized context command; never
invent a Task Run identity for a GlobalRole.

Provider acceptance, Context load, and workflow completion are separate facts.
Do not treat a live pane, process output, final response, or completed Provider
Turn as a Yui yield. For a managed Task Run, use the exact current Run's
supported checkpoint/yield command as the final control-plane action, then stop
immediately. If that direct command is denied or stale, report the blocker once
and stop; do not wrap, retry, broaden permissions, or target another Run.

For a transient Provider retry Envelope, continue the failed Turn in the same
native Session. Do not replay the original Assignment or reload unrelated Task
content. Process/child replacement does not by itself authorize a new Yui
generation or native conversation.
