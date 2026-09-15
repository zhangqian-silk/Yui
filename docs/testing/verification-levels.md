<p align="right"><strong>English</strong> | <a href="./verification-levels.zh-CN.md">简体中文</a></p>

# Verification policy

Yui is a single-user local product. Permanent verification protects essential
happy paths and a few critical, easily changed correctness boundaries. It is
not a historical catalog of every defect or edge case.

## Local development

Use the smallest evidence needed for the current change. Retain a focused
regression when all of the following apply:

- Failure would lose durable intent, cross an authority/isolation boundary, or
  prevent an Agent/Operator from making legitimate progress.
- The boundary is shared by frequently changed code or has already failed in
  a realistic execution.
- The check is deterministic, uses disposable local fixtures, runs in
  milliseconds, and asserts observable behavior rather than incidental layout.
- Equivalent coverage is not already present; prefer one coherent scenario
  over separate cases for each historical symptom.

Keep broad fault matrices, real-model exercises, malformed-data combinations
and incident-specific scripts temporary. Remove their harnesses after the
change, preserving useful reports. Real-resource results do not replace fast
regressions, and fast regressions do not establish real-model behavior.

## Coverage, not test count

Keep three complementary kinds of evidence: a few normal paths through real
entry points and component wiring; critical regressions for durable intent,
idempotency, authority, isolation and historical storage; and cheap pure-logic
checks for meaningful branching. A passing suite proves its assertions, not
the absence of every bug.

Pin constants that are persisted or public contracts (event names, protocol
identifiers, historical encodings), with an independent literal expectation.
Where possible, also prove the current reader understands migrated data.
Do not derive expected and actual values from the same constant, or lock an
internal default merely because it is a constant.

Merge tests only when each assertion has an identified surviving scenario.
Identical constant checks and repeated setup can be consolidated; similar
names do not make Task and Global authority boundaries interchangeable.
Do not target a particular test count or delete safety checks to hit a time
budget. A temporary deliberate fault can confirm that a critical check detects
its intended regression; no permanent mutation service or broad fault matrix
is required.

## Permanent core smoke

`npm test` and `npm run test:core` build the checkout and run one permanent suite:

1. the built CLI starts and its catalog exposes setup/update/upgrade/Task commands;
2. one normal SQLite Task and Message survive a reopen;
3. a supported historical Home migrates through the linear storage chain to current;
4. the built-in Codex and Claude Drivers are registered;
5. one independent declarative plugin is created, validated, called and disabled
   through authenticated ingress, with its selection and validation preserved.
6. a Task starts from durable Operator input, exposes planning Context and enters
   delivery with its original intent and captured planning authority preserved;
   scratch workspace release does not require a fabricated Git identity.
7. Session replacement preserves pending original Messages and independent work;
   cleanup blocks new notification claims, and successor acceptance cannot
   settle an old wake or later queued input. Old Sessions keep scoped reads
   but cannot regain write authority;
8. InputRequests survive Session replacement without a synthetic AgentRun;
9. late native terminals cannot settle successor input or invent acceptance;
10. remote Operator startup carries its reserved workspace, Role instructions
    and scoped CLI identity, while offline diagnostics/recovery remain reachable.
11. durably queued native results survive Controller outages and replay without
    poisoning the Host; known terminal inputs do not become active merely by aging;
12. Task-final review can use its Task-local Reviewer without a global template.
13. a native error label permits replacement only with latest-Turn terminal
    evidence and drained background execution; a wrong native account cannot
    authorize cleanup.
14. Claude receives its native environment and settings paths without injected
    authentication helpers, rewritten approval records, or secrets forwarded
    to unrelated adapters; native authentication selection stays with Claude. Environment refresh
    removes revoked keys and keeps values out of durable Task/Role records.
15. ordinary Integration conflicts continue without a decision gate; exact Git
    receipts and an admitted Job resume interrupted delivery without replay.
    Validation settlement distinguishes current check conditions from an
    already-applied CAS. Migration preserves provable old bound FF Jobs and
    classifies old conflicts without inventing successful checks.
16. explicit force archive commits before cleanup and preserves uncertain
    delivery/runtime evidence; partial cleanup and late results remain traceable,
    while archived runtime resources never become automatically safe to delete.
    Archive preflight preserves durable records and the Git index, distinguishes
    frozen-result differences, and cleanup rechecks moved heads, owner branches
    and new dirt. Read-only Git status never executes configured clean filters.
17. Host facts reach the existing Inbox even when its compiled store cannot
    read the Home; Controller-side fencing, ACK-loss replay, and legacy-Host
    upgrade refusal preserve the original execution. A frozen independent v1
    protocol producer remains the same process across a real 19→22 migration,
    authenticates RPCs to both Controllers through refreshed discovery, and
    retains facts during the disconnected window. Production launch planning
    also preserves scoped startup evidence before native Session adoption
    without exporting a Run ID into the Session environment.
    This fixture is the minimum supported new wire contract, not a claim that
    pre-fix released Hosts can be hot-patched.
    Archive racing Host ingress retains the complete source envelope without
    reopening the Task or settling original uncertain input.
18. Project maintenance waiters yield to the holder, use a shared 60-second
    monotonic budget with independent 200–500ms jitter, and cancel on Controller
    stop without losing activation intent. Disposable lock/SQLite/Git fixtures
    cover exclusion, partial release and under-lock revalidation; injected time
    checks the minute-long deadline without sleeping for a minute. Competing
    activations each adopt their own workspace without replaying Git work.
19. Task usage distinguishes zero, partial and unknown across exact requests,
    cumulative baselines, Session replacement and native child overlap. A small
    event fixture checks direct Leader/parallel time semantics and the shared
    CLI/Web/audit lifetime projection without collecting Provider data.
20. explicit cleanup releases retained terminals without affecting other Tasks
    or claiming that live resources are gone; Controller replacement waits for
    the old process to exit.
21. structured verification preserves argv, explicit shell failure, environment
    and workspace-relative cwd through the actual RPC parser and both local
    executors. Corrected execution semantics invalidate old gate reuse without
    rewriting historical artifacts or migrations.
22. concurrent resource registration preserves unrelated rows and rejects
    stale same-record writes; GC closes owned connections on success/failure.
23. Context counts, exact inspection and bounded event deltas work without
    materializing complete history or acquiring a writer lock. Telemetry
    ingestion yields to the event loop and drains its worker on close.
24. Release resume re-queries uncertain effects, retains confirmed work and
    refuses exhausted grants, using disposable SQLite and fake external ports.
    These checks do not claim validation of real release services.
25. The pre-1.0 contract cleanup normalizes old singleton dispatches only through
    explicit storage migration. Unsupported CLI/ACP input, unregistered development
    links, unpinned release identities and unsupported quarantine receipts are
    refused without inventing acceptance or discarding evidence. Current link,
    configuration and quarantine operations remain usable.
26. Activation refuses absent intent before resource adoption and still honors
    planning deferral and cancellation. Retiring the integration queue preserves
    exact records and active attempts in one rollback-safe migration, without
    inventing delivery. Conflicted Integrations remain completion blockers.
27. Unknown lock ownership stays fenced, including unavailable OS evidence.
    PR lookup distinguishes absence, malformed/ambiguous results and transport
    failure through injected ports. Receipt-free Git operations remain unchanged,
    while normal receipt-backed continuation still works. Notification-only
    migration preserves current delivery and audit history and refuses live links.
28. SQLite admission ignores unrelated side files but refuses a non-empty Home
    without its database. Default CLI/HTTP discovery stays bounded and retains
    off-page Task detail; unknown writer leases diagnose without mutation.
    Review migration preserves candidate evidence while making scope explicit.
29. Missing authoritative readers fail before Provider preparation or queue
    admission instead of becoming empty evidence. WorkItem history retirement
    preserves the original payload and current work, advances event IDs safely,
    and refuses unknown old shapes without advancing the migration ledger.
30. WorkItem overlap is a read-only advisory; exact permission/dependency guards
    remain. Real local verification proves default reuse, explicit rerun failure,
    selected-check isolation, incomplete evidence and stale-consumer rejection.
    An Integration rerun cannot bypass an equivalent unfinished gate. Policy
    migration preserves historical execution and blocks an admitted old gate.

Keep the test phase seconds-scale; measure TypeScript build separately. Record
incremental runtime when adding a critical regression. The seven recovery boundary
cases initially add about 0.4 seconds of test bodies (about 0.6 seconds standalone,
including module startup) on the development host. Keep real-model launches out
of this suite. Real tmux/CLI lifecycle checks belong to the bounded package smoke
below, not a second core daemon matrix.
The Integration continuation regressions use disposable Git repositories,
SQLite and fake Jobs, without a provider or shared Home. Their test bodies
take about 3 seconds on the development host; validation settlement adds
about 1.4 seconds to the initial 1.5-second coverage.
Archive preflight adds three small disposable Git/SQLite scenarios (about
one second of test bodies); broader owner/diagnostic combinations remain
temporary validation evidence, not a second permanent matrix.

## Skill and instruction changes

Review the shared Runtime contract and affected Role/Project Skills together.
Check instruction boundaries with a few relevant scenarios: analysis remains
read-only, existing mechanisms are reused, Session loss preserves Task intent,
and execution failure does not prevent authorized supervision. This is a
bounded review, not a new permanent matrix or permission to use real models.

The package-start check follows local Skill references in the installed tree,
including cross-Role links. Entry points and their referenced Markdown must
ship together. File/format checks establish availability, not Agent behavior;
do not add prose-matching tests or claim model validation from static checks.

## CI and release

`ci.yml` builds once and runs core plus one assembled-package normal-path smoke
on every PR, without another lint or broad regression suite.
`node scripts/smoke-runtime-package.mjs --assembled .release-stage` exercises
the actual CLI/Controller/Host/SQLite and isolated tmux, replacing only the
external Provider with a deterministic fixture. It covers setup, durable input
and idempotency across restart, scratch activation, native result ingestion,
completion preserving the conversation, and archive releasing live/dead panes
and grouped viewers without affecting a similarly named neighboring session.
The fixture owns a fresh Home and its PATH, installs cleanup before setup,
and never calls an installed model Agent.

`publish.yml` runs the same smoke against the freshly installed package through
`YUI_INSTALLED_ROOT`, adding actual npm-bin, dependency, supported Node version,
artifact and provenance boundaries. This validates runtime integration, not
real-model behavior. Pure contract and safety tests remain in `test/core`;
production wiring is exercised here rather than only through mocked ports.
The package smoke also checks unconditional status identity and update-owned
resource/identity capture through the assembled package, without an installation
or publication effect.

Configured Agents acting as developers or reviewers are ordinary execution
resources. Using a live provider or model as the subject of validation is
different: paid APIs, shared Homes, production systems, real account quota, and
other non-disposable external effects are never implied by a request to test or
validate. They require an explicit user request for the exact resource and
effect boundary.

For authorized real-model probes, distinguish native acceptance, exact Turn
completion and independently checked work (files, tests, commits and Task
facts). A missing echo marker is not a functional failure. After Session
replacement, verify the successor read the original input and correlate its
own terminal; do not require every historical wake to receive that terminal.
Check normal completion/archive before stopping execution, since stop/cancel
cleanup is a different path. Preserve these evidence distinctions in the report.
