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
- A generic request to implement, test, validate, or run E2E never authorizes a
  real Agent, provider, model, paid API, shared Home, or production resource.
  Run such validation only when the user explicitly selects that exact resource
  and effect boundary in the current request.

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
