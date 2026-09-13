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

## Permanent core smoke

`npm test` and `npm run test:core` build the checkout and run one permanent suite:

1. the packaged CLI starts and exposes setup/update/upgrade/Task commands;
2. one normal SQLite Task and Message survive a reopen;
3. a supported historical Home migrates through the linear storage chain to current;
4. the built-in Codex and Claude Drivers are registered;
5. one independent declarative plugin is created, validated, called and disabled
   through authenticated ingress, with its selection and validation preserved.
6. a Task starts from durable Operator input, exposes planning Context and enters
   delivery with its original intent and captured planning authority preserved.
7. Session replacement preserves pending original Messages and independent work;
   old Sessions keep scoped reads but cannot regain write authority;
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

Keep the test phase seconds-scale; measure TypeScript build separately. Record
incremental runtime when adding a critical regression. The seven recovery boundary
cases initially add about 0.4 seconds of test bodies (about 0.6 seconds standalone,
including module startup) on the development host. Avoid sleep-based checks or
mandatory model/daemon launches in the permanent suite.
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

`ci.yml` runs the core smoke plus one package-assembly/start check. It does not
run a second lint pass or a separate broad regression suite. `publish.yml` reuses that
exact gated commit and adds only tag, artifact, install, and provenance checks
that are unique to publishing.

Configured Agents acting as developers or reviewers are ordinary execution
resources. Using a live provider or model as the subject of validation is
different: paid APIs, shared Homes, production systems, real account quota, and
other non-disposable external effects are never implied by a request to test or
validate. They require an explicit user request for the exact resource and
effect boundary.
