# Task-local identity and offline conversion

Yui treats a Task as the aggregate boundary for durable workflow records. Each
Task owns an independent, monotonically increasing sequence for every record
family:

- WorkItem
- AgentRun
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
Run when one exists.

## Reference contract

The portable form of a Task-owned reference is:

```text
<task-id>/<local-id>
```

For example, `task-7/work-item-1` and `task-9/work-item-1` are distinct. CLI,
JSON, mailbox, Controller, Hook, receipt, Web, and error paths retain the Task
scope. Context-free commands reject a bare local ID instead of searching all
Tasks, even if that ID currently happens to be unique.

A managed Task session may use `work-item-1` or `agent-run-1` because its
`YUI_TASK_ID` is explicit. A command that already receives the Task as another
argument may also use a subordinate local ID. Outside those two cases, use the
qualified form. Delivery receipts use the same provenance, for example:

```text
agent-run:task-7/agent-run-1
input-request:task-7/input-1
```

There is no compatibility lookup, cross-Task guess, or bare-ID fallback.

## Offline conversion

Runtime opens only the current aggregate-v13 / StoredTask-v12 schema. It does
not read the legacy global-ID shape or an identity-only intermediate shape.
Conversion is an explicit, stopped-system operation from the supported
aggregate-v10 / StoredTask-v9 source into a separate fresh output:

```sh
yui storage convert-task-identity \
  --source /absolute/path/to/old-yui-home \
  --output /absolute/path/to/fresh-yui-home
```

Before running it:

1. Stop the Controller that owns the source home.
2. Preserve a backup or immutable snapshot of that home.
3. Choose an output path that does not exist and is not inside the source.

The converter reads a stable source snapshot, deterministically remaps every
Task-owned family and nested reference, and writes current-schema state into
the fresh directory. In the same direct cutover it creates versioned Role
desired configuration and immutable effective AgentRun/RoleSession snapshots,
including the provider-neutral `read-only` or `unrestricted` execution mode.
Missing legacy permission facts are never guessed: historical effective
snapshots are marked `legacy-cutover`, forced read-only, and are not resumable.
For the next fresh launch, exact built-in `operator`, `leader`, `worker`, and
`implementer` Roles receive the current write-capable default; custom Roles
remain read-only because the old schema did not persist their Profile identity.
The output
uses `config.review` as the sole reviewer bootstrap authority. It upgrades only
the configured Global Role and existing same-name Task Roles to normal isolated
Review write/bypass capability, removes their obsolete forced-read provider
settings, and upgrades only an exact old built-in `reviewer` Profile. Custom or
unrelated Roles and Profiles are preserved. A missing configured Global Role,
external additional directory, custom advanced argument, or Claude settings
source is ambiguous for isolation and fails before an output is retained. The
conversion report records the target Role, affected Task Roles, and built-in
Profile disposition. Existing Run and Session effective snapshots remain
`legacy-cutover`, read-only, immutable, and non-resumable.

The output also records historical terminal ReviewRounds as
`legacy-unavailable` when the
old format did not persist a frozen Candidate commit. An active legacy review
cannot be reconstructed safely and makes conversion fail closed. New reviews
always carry a frozen commit and ReviewRound-owned workspace. The output is
validated through the normal `FileTaskStore` with zero dangling references.
The converter also writes `identity-conversion.json` with the source hash and
per-Task record counts, then checks the source bytes again before returning.
The operation fails on a dangling or ambiguous legacy reference and removes
only the fresh output that it created; the source is never rewritten.

After conversion, inspect the report and representative `yui --json task
context <task-id>` results with `YUI_HOME` pointed at the fresh directory. Move
the runtime binding only after that verification. Keep the source snapshot as
the rollback boundary; do not merge converted records back into it.
