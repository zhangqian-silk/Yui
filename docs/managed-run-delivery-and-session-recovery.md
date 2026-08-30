# Managed Run Delivery and Task Continuation

Status: implemented contract

This document defines the boundary between durable Task progress and disposable
Agent execution state. The design keeps ordinary continuation simple and uses a
Task-wide execution fence as the final operational fallback.

## Product decision

Task progress is authoritative. Agent runtime history is not.

- Task intent, WorkItems, ReviewRounds, ChangeSets, Integrations, Messages,
  Decisions, Milestones, Candidates, managed workspaces, and repository changes
  are durable progress.
- AgentRuns, native Sessions, Provider activations, delivery receipts, runtime
  observations, lifecycle mailboxes, and failure records are execution and
  audit evidence.
- A failed or terminal execution attempt may be replaced by a new AgentRun and
  a new native Session. Continuation reads the durable Task records instead of
  reconstructing the old conversation.
- Historical execution evidence may explain what happened, but it does not
  keep healthy Task progress permanently blocked.
- Actual live writers still obey the single-writer and atomic launch fences.
  Removing historical blockers does not allow two Providers to write through
  the same Role concurrently.

## Normal execution

Every admitted Run still has one durable delivery intent and one active pointer.
The Controller checks current Task admission, Role identity, mailbox ownership,
and live-writer authority at the mutation boundary.

The Controller does not reject a launch merely because an old lifecycle mailbox,
Session record, or failed Provider continuation exists. It attempts the current
atomic reservation. A genuinely live writer produces bounded backpressure; a
terminal old Session can be superseded by a fresh Session.

When a Run fails:

1. the Run and its current execution lane record the attempt outcome;
2. the WorkItem, Candidate, repository changes, Messages, and other durable
   progress remain intact;
3. the Leader may retry the failed lane with `yui task run retry`; and
4. the new Run loads current Task context and may use a fresh Session.

There is no `yui task run recover` workflow. `yui task run show` presents audit
evidence only. Yui does not generate per-Run recovery plans that the Leader must
execute before progress can continue.

There is likewise no Role-level Session switch protocol. A usable Session is
resumed; a terminal or explicitly broken Session is replaced on the next Run.
If the live runtime cannot reach either state, Task execution stop/start is the
single fallback instead of another recovery state machine.

## Task completion

Task completion is decided by semantic records:

- WorkItems are completed or explicitly retired;
- required Reviews and findings are settled;
- current delivery ChangeSets and Integrations are settled;
- open InputRequests and active DurableJobs are settled; and
- required repository evidence is present.

Current Runs and Sessions are not completion requirements. In the completion
transaction Yui terminalizes disposable attempts, clears execution pointers,
marks Role Sessions stopped, preserves all durable results, and queues physical
runtime cleanup. Terminal workspace cleanup is advisory until archive.

Archive remains the physical reclamation boundary. It verifies that live jobs,
runtimes, and managed workspaces have actually been released. Historical
Provider continuation events are retained as audit evidence and are not a
standalone archive blocker once physical ownership is gone.

## Final operational fallback

The global Operator or a human user can fence the whole Task:

```text
yui task execution stop <task> --force --reason <text>
yui task execution start <task>
```

`stop` first disables all new Task execution atomically. It then cancels active
DurableJobs, terminates current Runs, clears delivery and lifecycle claims, and
stops Role runtime owners. Task status remains `active`; WorkItems, code,
workspaces, Messages, Candidates, and audit history are preserved.

If physical cleanup reports an error, the Task remains stopped. No old writer
can be admitted again through Yui until the resource problem is fixed.

`start` requires physical writer absence, enables execution, and queues exactly
one Leader wake. The Leader continues from durable Task progress. Start does not
resume or repair an old Agent conversation and does not create a Task generation.

## Retry and storm boundary

Yui does not continuously recreate a Leader Session after the same launch
failure. The failed delivery batch is consumed and the failure remains visible
as audit/attention. A new durable Task fact, an explicit scheduler retry, or
Task execution stop/start may admit the next Leader attempt.

This boundary prevents both permanent history-based deadlocks and unbounded
Session recreation loops without adding a generation protocol or recovery
worker.

## Failure semantics

- Malformed persistent data still fails closed with a bounded diagnosis.
- A current live writer still blocks a competing launch until it exits or the
  Operator stops Task execution.
- CLI or Operator implementation failures are repaired outside the Yui Task
  workflow; Yui does not need an internal self-repair loop.
- Real Provider uncertainty remains audit evidence. It does not authorize
  replaying an accepted input.

The intended steady state is therefore small: durable Task progress, disposable
execution attempts, one live-writer fence, and one Task-wide stop/start fallback.
