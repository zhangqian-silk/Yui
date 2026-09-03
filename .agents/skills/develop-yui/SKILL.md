---
name: develop-yui
description: Develop, review, and validate the Yui repository with its seconds-scale core smoke and temporary change-specific evidence. Use only when the bound Project or current repository is Yui itself and the task is Yui feature work, bug fixing, refactoring, review, testing, release validation, or maintenance.
---

# Develop Yui

Apply this Skill only to development of the Yui repository itself. Keep its
commands, test policy, and acceptance workflow out of Yui's generic Leader,
Worker, and Reviewer Skills; other Projects define their own workflow.
These constraints apply whenever Yui is the Project being changed, regardless
of whether the work is performed manually, by a direct Agent, through Yui
orchestration, in CI, or by another development tool.

## Develop an Agent-first control plane

Yui serves intelligent Agents. Its core should expose durable context and small
atomic capabilities, while the Agent decides planning, sequencing, delegation,
retry, and recovery. Build a policy engine only when the product itself, rather
than an Agent using current context, must make the decision.

- Prefer one CLI read model and one explicit atomic mutation over a prescribed
  multi-step workflow. Preserve pending intent when a mutation cannot proceed,
  and return an observable result that lets the Agent choose what to do next.
- Keep semantic judgment in Project Skills, Knowledge, Task context, and Agent
  instructions. Core owns identity, authorization, workspace isolation,
  persistent integrity, and atomic effects; it does not need to model every
  sensible Agent decision or provider edge case.
- Treat Provider Sessions and runtime continuity as execution aids. Durable
  Task context, results, and managed workspaces must be sufficient for an Agent
  to resume or redo bounded work when a runtime cannot continue cleanly.
- Trust enforced internal contracts and valid Agent declarations. Add a state,
  fence, retry, recovery path, or permanent validation only for a normal
  product path, a hard authority or data-integrity boundary, or an observed
  failure whose cost justifies the added protocol.
- Optimize for the lowest total lifecycle complexity under the current
  contract. Do not treat “long-term” as permission to model every possible
  future edge. Prefer a bounded redesign when repeated patches reveal a wrong
  responsibility or duplicated authority; otherwise make the smallest
  coherent change and stop.
- Require a concrete current reason before adding another module, abstraction,
  configuration switch, compatibility path, fallback, or orchestration phase.
  Small implementation details do not need independently managed architecture.

## Keep Yui validation lean

Use [`docs/testing/verification-levels.md`](../../../docs/testing/verification-levels.md)
as the executable policy. Yui keeps one permanent, seconds-scale smoke suite:
`npm test` / `npm run test:core`. It covers only the essential happy paths for
CLI startup, SQLite Task persistence, supported storage migration, and built-in
Agent Driver registration.

- Treat TDD and change-specific tests as temporary development scaffolding.
  They may be added or run while implementing the current requirement, but
  remove them before handoff unless they expose a missing basic product path.
- Do not turn a bug fix into a permanent one-test-per-regression contract.
  Error branches, malformed data, deletion, retirement, archive, retry,
  rollback, compatibility matrices, and historical incidents are validated
  only for the change that touches them.
- Add a permanent smoke only when a product-level primary path would otherwise
  be absent. Keep the whole test phase measured in seconds and prefer replacing
  overlapping coverage instead of growing the suite.
- Run `npm run build` plus the smallest temporary check needed for local
  confidence. The PR gate runs the same core smoke and package-start check; the
  release adds only artifact/install evidence unique to publishing.
- Configured Leader, Worker, Reviewer, and native child Agents are normal
  execution resources and may develop or review Yui within their assigned
  authority. A generic request to implement, test, validate, or run E2E does
  not authorize additional validation that uses a live provider/model as the
  test subject, paid APIs, shared Homes, production systems, real account
  quota, or another non-disposable external effect. Run that validation only
  when the user explicitly selects its exact resource and effect boundary.

## Let the Leader choose the smallest useful topology

Execution topology is a Leader judgment made from current Task context, not a
core scheduling policy. Yui should provide the same composable operations for
direct work, native children, and managed Turns without trying to infer an
optimal decomposition from Task type, file count, risk labels, subsystem
names, or workflow phase.

Task type records intent; it does not prescribe ownership. The Leader should
own ordinary bounded work directly when current context and tools are enough.
Create WorkItems only for substantial requirements with independent ownership,
acceptance, and useful parallel progress. Investigation, implementation steps,
tests, findings, and small repairs stay inside the existing Task or WorkItem
instead of becoming a record-by-record diary.

Persistence, authorization, concurrency, recovery, release, or multi-Project
scope may justify stronger implementation and validation evidence, but none
automatically requires more WorkItems, Roles, abstractions, or protocol. Keep
tightly coupled behavior under one coherent owner unless splitting lowers the
complete coordination and Integration cost.

For an ordinary WorkItem, use its existing owner or assignee directly in the
main workspace Yui supplies for that execution. A Leader-owned WorkItem uses
Task main; a Worker-owned WorkItem uses its Develop workspace. Dispatch an
assigned WorkItem without `--lane-role` by default. That direct WorkItem Turn
is durable and has no ExecutionGroup. Request replicated execution with at
least two distinct Lane Roles only when current Task evidence justifies
independent attempts at the same frozen Assignment. This execution choice is
separate from Task decomposition and WorkItem count. Direct Candidate or
Task-final Review likewise uses one main Reviewer Turn with no Group.
Replicated Review is an explicit choice in either scope: it uses at least two
distinct Producer Lane Roles over one frozen Assignment, waits for every Lane
to settle, and gives the main Reviewer the durable successful results for one
authoritative synthesis Turn. Automatic policy-triggered Candidate Review
stays direct.

Risk controls review and evidence strength. Before delivery, the Leader makes
an explicit review judgment: direct inspection may be sufficient, or one
independent Review may materially protect the control plane. A configured
Reviewer is normal execution, not real-resource E2E. Do not create a
ReviewRound merely because work touched a sensitive subsystem, and do not
force Review through a Core gate. Route findings to the original owner; the
Leader fixes small Task-main issues directly and creates a Repair WorkItem only
when the repair is itself a substantial independently owned requirement.

## Implement the current Yui contract

Provide compatibility only through explicit migrations between valid versions
of persistent Yui data. A persistent layout, aggregate, record, or
configuration schema change must include its version transition and centralized
migration function.

For all other behavior, implement and validate only the current contract. Do
not preserve transitional paths or add recovery logic for malformed, partial,
manually modified, or historically leaked Homes, Sessions, worktrees,
configuration, or runtime artifacts. Fail closed and report a bounded
diagnosis or cleanup recommendation instead. An explicitly retired Task is an
isolation boundary rather than a repair path: preserve its stored history and
skip only the runtime cross-reference checks that would block healthy Tasks.
