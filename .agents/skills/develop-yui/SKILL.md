---
name: develop-yui
description: Develop, review, and validate the Yui repository with its project-specific test tiers and Mock Agent defaults. Use only when the bound Project or current repository is Yui itself and the task is Yui feature work, bug fixing, refactoring, review, testing, release validation, or maintenance.
---

# Develop Yui

Apply this Skill only to development of the Yui repository itself. Keep its
commands, tier names, and acceptance workflow out of Yui's generic Leader,
Worker, and Reviewer Skills; other Projects define their own workflow.
These constraints apply whenever Yui is the Project being changed, regardless
of whether the work is performed manually, by a direct Agent, through Yui
orchestration, in CI, or by another development tool.

## Choose proportionate Yui validation

Use [`docs/testing/test-tiers.md`](../../../docs/testing/test-tiers.md) as the
executable tier contract, and
[`docs/testing/verification-levels.md`](../../../docs/testing/verification-levels.md)
for how evidence is split across local development, the PR gate, and release:

- Local changes get the smallest targeted check set for their risk. The
  `ci.yml` PR gate is only a bounded core tripwire, so change-specific coverage
  remains the responsibility of local validation.
- The full deterministic `npm test` suite is an on-demand diagnostic for
  unusually cross-cutting changes or regression investigation. It is not a
  routine handoff requirement or merge gate.
- The release reuses the PR/master-gated exact commit and runs only
  release-unique package/install smoke; never re-run the diagnostic suite
  or lint as part of a release.

- Use Unit tests for pure logic and storage behavior.
- Use Isolated Integration tests for real Yui runtime seams inside a disposable
  Home and namespace, without a real model.
- Use Mock Agent Session tests for Agent lifecycle and transport behavior with a
  deterministic local Agent process.
- Treat Provider E2E as real external-resource validation because it invokes a
  real Agent/provider/model.
- Treat Release E2E as privileged release validation, separate from
  provider-native acceptance.

These tier names and their resource meanings belong to the Yui Project. They
must not become generic Yui CLI or Role policy, and naming a tier never grants
permission to consume its real resources.

For ordinary Yui features, fixes, refactors, reviews, and validation, select the
smallest relevant combination of Unit, Isolated Integration, and Mock Agent
Session coverage. Do not make either privileged E2E tier a routine acceptance
step.

Run Provider E2E only when the user explicitly asks in the current request to
exercise a real Agent, provider, or model. A generic request to implement,
validate, run tests, or run E2E does not select a real Provider. Credentials,
installed Provider CLIs, and an available runner do not change this boundary.

When the user has not proactively selected a specific real-resource
validation, skip it without creating an InputRequest merely to solicit
permission. Complete the bounded Task with deterministic and isolated evidence.
In the final Task summary, report any material provider-native or release
verification gap and, when useful, recommend the real-resource validation as a
separate follow-up without making it a blocker or user prompt. Do not present
Mock transport success as real Provider acceptance.

When the user does explicitly request a specific real-resource E2E, keep the
run within that exact resource and effect boundary and use the tier's mandatory
isolation and cleanup safeguards.

## Implement the current Yui contract

Provide compatibility only through explicit migrations between valid versions
of persistent Yui data. A persistent layout, aggregate, record, or
configuration schema change must include its version transition and centralized
migration function.

For all other behavior, implement and validate only the current contract. Do
not preserve transitional paths or add recovery logic for malformed, partial,
manually modified, or historically leaked Homes, Sessions, worktrees,
configuration, or runtime artifacts. Fail closed and report a bounded
diagnosis or cleanup recommendation instead.
