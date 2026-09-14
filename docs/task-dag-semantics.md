<p align="right"><strong>English</strong> | <a href="./task-dag-semantics.zh-CN.md">简体中文</a></p>

# Task dependencies and WorkItem semantics

## Requirement and execution are separate

A Task is one bounded outcome; a WorkItem is an independently acceptable
requirement within it. Task type does not dictate execution topology: the Leader
can work directly or create WorkItems delivered by separate owners. An
implementation step, a single test, a review finding or a small fix does not
become a new WorkItem on its own.

The persistent WorkItem status is only `open / accepted / retired`:

- `open`: the requirement is still in progress — not yet executed, executing,
  awaiting acceptance or needing another attempt.
- `accepted`: the Leader has explicitly accepted the current delivery.
- `retired`: the requirement is explicitly retired, with its record and reason
  preserved.

Execution status belongs to AgentRun, and a Candidate records the result
currently awaiting acceptance. Submission, rejection or execution failure does
not turn a WorkItem into a second runtime state machine. Withdrawing acceptance
is an explicit action.

## One dependency authority

`WorkItem.dependsOn` is the list of direct dependencies within the same Task. A
prerequisite A → downstream B means B's `dependsOn` contains A. Saving checks
same-Task references, existence and the acyclic constraint. It does not express
Provider concurrency, Session occupancy or file locks.

At dispatch, every direct dependency must exist and be `accepted`. An open,
retired or missing dependency cannot satisfy it, and the error returns the exact
ID and current status. A successful Run, an existing Candidate, a completed
Review or an integrated Git change does not substitute for WorkItem acceptance.

A retired WorkItem's replacement field only explains the substitution; it does
not redirect or rewrite dependencies. The Leader must explicitly revise the
requirement or its dependencies. The Controller does not release downstream work
along a replacement chain, cascade cancellation, auto-skip, or turn the
dependency list into a scheduling plan.

## Editing and recovery

A legal edit to an open WorkItem definition preserves the before/after values and
keeps its identity and execution evidence. An already-started Run keeps its
frozen Assignment; editing the current requirement does not retroactively rewrite
that Run's Context or permissions. Accepted and retired definitions cannot be
overwritten by an ordinary edit. Owner and resource-scope changes are checked at
their own boundaries.

On execution failure, the Leader inspects the original result, Session,
dependencies and workspace, then decides to continue, retry, retire or revise the
plan. After retirement, a late message keeps its source and non-delivery reason
and does not auto-reopen. An InputRequest represents an open question; answering
it does not accept a WorkItem or rewrite dependencies.

## Acceptance, integration and Task completion

Direct and replicated execution share one Leader acceptance boundary. A
replicated Producer does not form a Candidate; only the explicitly synthesized
main Run result enters the candidate path. Delivery the Leader manages directly
must also satisfy the applicable Candidate and Integration boundaries.

An isolated code result freezes per-Project Candidate commits and integrates via
compare-and-swap after its checks; an unsnapshotted, unintegrated or stale latest
result cannot satisfy delivery. Review is checked against the applicable rule and
the Task contract. A Task main the Leader delivers itself needs a clean,
committed, exact snapshot.

The Task lifecycle is `draft / active / completed / cancelled / archived`. A
Draft plans first and then explicitly adopts a workspace; completed and cancelled
Tasks do not accept implicit new execution, and a reopen never replays old
requests; an archived Task cannot reopen. Archive also requires resources to be
quiescent, clean and removable, and never deletes a workspace merely because of
the dependency graph or a completion status.

CLI and Web derive their views and suggestions from these facts; they do not
maintain a second writable DAG, acceptance state or plan.
