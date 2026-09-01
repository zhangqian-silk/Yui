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

Runtime opens only aggregate v13 / StoredTask v12. It does not convert,
dual-read, or infer records from an older schema. If an existing `YUI_HOME`
does not match the current schema, keep it untouched for external archival
and initialize a fresh home for this runtime.

This hard cut keeps Task-local references, Role desired configuration, and
immutable Turn/RoleSession effective snapshots under one unambiguous
contract. There is no compatibility lookup, conversion command, or
intermediate storage format.
