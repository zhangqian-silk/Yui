---
name: develop-yui
description: Develop, review, and validate the Yui repository with its project-specific test tiers and Mock Agent defaults. Use only when the bound Project or current repository is Yui itself and the task is Yui feature work, bug fixing, refactoring, review, testing, release validation, or maintenance.
---

# Develop Yui

Apply this Skill only to development of the Yui repository itself. Keep its
commands, tier names, and acceptance workflow out of Yui's generic Leader,
Worker, and Reviewer Skills; other Projects define their own workflow.

## Choose proportionate Yui validation

Use [`docs/testing/test-tiers.md`](../../../docs/testing/test-tiers.md) as the
executable tier contract:

- Use Unit tests for pure logic and storage behavior.
- Use Isolated Integration tests for real Yui runtime seams inside a disposable
  Home and namespace, without a real model.
- Use Mock Agent Session tests for Agent lifecycle and transport behavior with a
  deterministic local Agent process.
- Treat Provider E2E as real external-resource validation because it invokes a
  real Agent/provider/model.
- Treat Release E2E as privileged release validation, separate from
  provider-native acceptance.

For ordinary Yui features, fixes, refactors, reviews, and validation, select the
smallest relevant combination of Unit, Isolated Integration, and Mock Agent
Session coverage. Do not make either privileged E2E tier a routine acceptance
step.

Run Provider E2E only when the user explicitly asks in the current request to
exercise a real Agent, provider, or model. A generic request to implement,
validate, run tests, or run E2E does not select a real Provider. Credentials,
installed Provider CLIs, and an available runner do not change this boundary.

When real-resource validation is not selected, report it as not run and state
the remaining provider-native or release verification gap without presenting
Mock transport success as real Provider acceptance.
