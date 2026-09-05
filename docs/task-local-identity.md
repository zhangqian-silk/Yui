# Task-local identity

Yui treats a Task as the aggregate boundary for durable workflow records. Each
Task owns an independent, monotonically increasing sequence for every record
family:

- WorkItem
- Turn
- ReviewRound
- ChangeSet
- IntegrationAttempt
- Message
- InputRequest
- Decision
- Milestone
- Event

The first record of each family in each Task is therefore local `-1`. Deleted,
cancelled, completed, reopened, and archived records never lower the persisted
high-water mark, so a local ID is never reused inside its Task. Each allocation
advances that aggregate high-water mark under the storage process lock.

Candidate identity is narrower: `candidate-N` is a WorkItem-local sequence.
Every Candidate stores its `taskId` and `workItemId`, in addition to the source
Turn when one exists.

## Reference contract

The portable form of a Task-owned reference is:

```text
<task-id>/<local-id>
```

For example, `task-7/work-item-1` and `task-9/work-item-1` are distinct. CLI,
JSON, mailbox, Controller, Hook, receipt, Web, and error paths retain the Task
scope. Context-free commands reject a bare local ID instead of searching all
Tasks, even if that ID currently happens to be unique.

A managed Task session may use `work-item-1` or `turn-1` because its
`YUI_TASK_ID` is explicit. A command that already receives the Task as another
argument may also use a subordinate local ID. Outside those two cases, use the
qualified form. Delivery receipts use the same provenance, for example:

```text
turn:task-7/turn-1
input-request:task-7/input-1
```

There is no compatibility lookup, cross-Task guess, or bare-ID fallback.

## Current-schema boundary

Runtime opens only the current Home storage version and current record shapes.
It does not dual-read or infer historical records during ordinary work.
Historical decoding and rewriting are confined to the explicit `yui upgrade`
boundary and the migration phase of `yui update`; every valid Home at or above
the CLI's minimum supported storage version can advance directly to current.

This boundary keeps Task-local references, Role desired configuration, and
immutable Turn/RoleSession effective snapshots under one unambiguous runtime
contract while the append-only migration chain preserves supported history.
