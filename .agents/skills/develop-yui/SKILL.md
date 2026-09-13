---
name: develop-yui
description: Implement, diagnose, review, and validate changes to the Yui repository itself using its control-plane boundaries, isolated checkout workflow, and lean regression policy. Not for ordinary Tasks in other Projects managed by Yui.
---

# Develop Yui

Use this Skill whenever Yui itself is the Project being changed, independent
of the developer or orchestrator. Read the repository's
[AGENTS.md](../../../AGENTS.md) for standing authority, architecture and isolation
constraints. This Skill owns Yui-specific development methods, not generic
Leader, Worker or Reviewer scheduling. Resolve links relative to this directory.

## Match the requested work

- For diagnosis or review, inspect the bounded behavior and report evidence;
  do not change code, configuration or runtime state unless requested.
- For implementation or fixes, complete the requested change and proportionate
  verification. Ask only when a material product choice or new authority is
  needed, not for routine engineering choices.
- For simplification, preserve supported outputs, authority and recovery
  behavior; lower total lifecycle complexity rather than just line count.

## Locate the existing authority before adding a mechanism

Trace the actual entry point, current CLI/context reads, configuration sources
and owning runtime component. Establish a reachable violation of the intended
contract before fixing it. Compare equivalent inputs, native configuration and
initialization conditions when a provider or isolated fixture behaves differently.
Do not turn a fixture difference into a new product authentication or recovery
policy.

Keep durable Task intent separate from engineering execution data. Session
replacement must preserve requirements, results and managed workspaces without
making an old Run or conversation a prerequisite. Prefer existing atomic
operations and exact diagnostics; redesign a misplaced responsibility only
when that is simpler than another patch.

Before adding persistent state, a fallback, retry protocol or policy branch,
identify the current product path or hard boundary and why observable failure
plus an authorized Agent action is insufficient. Keep project-specific
judgment out of the generic CLI and Role Skills.

## Exercise this checkout in isolation

Follow the exact local-launcher procedure in AGENTS.md: `make install-local`,
then the absolute `<checkout>/output/dev/bin/yui` path. It selects this checkout
and its isolated default data home; initialize it with `setup` when needed.
Rebuild after code updates, and restart only this isolated Controller when an
older build is running. Never use `make link` or assume bare `yui` selects the
current checkout. Additional fixtures need their own explicit `YUI_HOME`.

## Keep Yui validation lean

Read [verification policy](../../../docs/testing/verification-levels.md) when
selecting checks. Use a focused test-first reproduction for costly behavioral
regressions; use an existing narrow check for a small low-risk edit.
Retain deterministic regressions for high-impact, easily changed boundaries,
not wording, implementation layout or every incident. Do not remove useful
coverage merely to meet a line-count or runtime target.

Run `npm run build` and the smallest relevant check during implementation.
The permanent delivery gate is `npm test` / `npm run test:core`, plus the
package-start check for runtime packaging changes. Keep its test phase
seconds-scale and measure incremental cost when adding coverage.
Broaden checks for a new change, failure or unresolved risk, not unchanged success.

Real-model, paid, shared or production validation needs explicit authorization
for that resource and effect boundary; do not solicit it through an InputRequest.
Use isolated deterministic evidence otherwise. Remove temporary harnesses
after preserving their reports; do not turn exploratory matrices into a second
permanent suite.

## Close the test resources you create

For tests that start a Controller or Agent Host, own a fresh fixture Home and
register teardown before the first CLI call (`setup` can start a Controller).
Use `finally` or the test runner's teardown hook on both success and failure.
Stop fixture work and its owned processes, stop its Controller, release only
its tmux namespace, then remove its temporary directories. Controller restart
replaces the Controller but intentionally keeps managed Sessions; it is not
fixture teardown.

Before handing off Yui development, the executing Agent checks that its test
resources were released and cleans its own attributable leftovers without
asking the user to do the mechanical work. A Leader checks the cleanup evidence
for delegated tests as well. Preserve useful reports before removing scratch
data; remove temporary release worktrees through Git only when clean.

If cleanup fails or a resource's owner is unclear, retain its Home and report
the exact paths/process identities for a separate Agent to inspect. Do not
claim cleanup succeeded, delete the ownership evidence, sweep shared `/tmp`,
or stop another Home. Hard-kill recovery and historical orphan cleanup are
separate work, not a reason to add a background protocol to the normal path.

## Read specialized guidance when it applies

- Before changing persistent schema/payloads or the updater, read
  [storage migrations](references/storage-migrations.md). Use the centralized
  version chain; never repair runtime state heuristically.
- For Role Skill changes, inspect the shared Runtime contract and affected
  Role instructions together. Keep Project-specific rules here. Check local
  references in the installed package as well as the source checkout.
- For release or package changes, read the relevant section of
  [release workflow](../../../docs/release-workflow.md); verification does not
  authorize publishing.

## Hand off evidence

Inspect the complete final change and affected contracts. Report the observable
result, validation actually performed, material gaps and remaining decisions.
Distinguish self-review, deterministic tests and real-Agent evidence; passing
format or package checks alone does not establish Agent behavior.
