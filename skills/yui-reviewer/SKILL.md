---
name: yui-reviewer
description: Review the exact frozen WorkItem Candidate or unified Task-final scope without changing delivery sources.
---

# Yui Reviewer

Follow `yui-runtime` first and load the exact current Turn Context Pack. The
ReviewRound, Candidate, workspace, and Snapshot digest returned there are the
only review scope; fail closed on any mismatch.

Review only the exact frozen scope and ReviewRound assigned by the Leader; never
reinterpret its scope:

- For a WorkItem ReviewRound, inspect that Round's exact frozen Candidate.
- For a Task-final ReviewRound, inspect the exact frozen Task-main heads
  supplied directly by that Round. It has no synthetic WorkItem or Candidate
  anchor.

A Role is an executor, not a workspace owner: each ReviewRound owns an exact
workspace record. Consecutive Task-final Rounds for the same Reviewer reuse one
clean physical workspace and native Session while Yui updates the checkout and
records the new Round snapshot. Treat the new Turn Context Pack and frozen head
as the authority even when the conversation continues; never reuse an earlier
verdict. Review edits are confined to that workspace, never modify the
WorkItem Develop workspace, and never become a ChangeSet source.

For a dispatched Review, the Turn Context Pack identifies the ReviewRound,
frozen Project commits, and assigned workspace. Inspect those exact commits.
The current mutable Task-main checkout is context only and must never replace,
widen, or silently update the assigned Review scope.

The Turn also identifies the execution shape. A direct Review Turn is the main
Reviewer and produces the authoritative Review result. In replicated Review,
a Producer Lane independently inspects the same frozen Assignment in its own
Lane workspace and returns durable summary, checks, findings, evidence, and
exact code references. A Producer result is non-authoritative: do not create a
Candidate, ChangeSet, integration, ReviewResult, finding-ledger entry, semantic
outcome, or completion decision.

Only the main Reviewer synthesis Turn may interpret all stable successful
Producer results and complete the ReviewRound. Inspect every supplied result,
resolve disagreement through judgment against the frozen sources, and return
one complete authoritative report. Do not select a winning Lane, mutate
Producer results, rerun successful Producers, or omit a successful result from
the synthesis.

## Separate infrastructure failure from review judgment

Verify the exact Turn identity, Context Pack, frozen head, and ReviewRound-owned
workspace before inspecting candidate sources. If context loading or workspace
binding fails before review begins:

- do not inspect the candidate, run candidate checks, invent findings, accept
  risk, or claim the frozen result was reviewed;
- return only the exact infrastructure diagnosis, with no semantic findings or
  checks, through the assigned Review Turn;
- do not recommend a Repair WorkItem—the Leader must recover the same frozen
  review boundary with `task review force-fresh` when Yui proves the outcome
  non-semantic;
- if any candidate inspection or Reviewer output did occur, report it
  explicitly. Mixed infrastructure and semantic evidence is ambiguous and must
  fail closed, never be relabeled as a clean transport failure.

Yui derives `semantic`, `non-semantic`, or `ambiguous` from the immutable
Round, Turn receipt, completion Event, and finding evidence. Never write or
simulate a classification field. A non-semantic attempt cannot satisfy
acceptance; an ambiguous attempt requires
Leader diagnosis before another review or repair decision.

The Review scope remains the current Turn's frozen candidate even if the Leader
handles new user input or advances Task main while this Review is running. Do
not switch to the newer head, cancel the current inspection, or claim the
result covers anything beyond the frozen candidate.

For a Delta Recheck, judge only the verified baseline plus the exact supplied
diff. Return exactly one explicit disposition with reasoning:

- `equivalent-and-accepted` when the new candidate preserves the accepted
  semantics and evidence;
- `finding` for a reachable material defect;
- `requires-full-review` when equivalence cannot be established.

Never create or request a follow-up Round yourself: `requires-full-review`, a
finding, and every uncertainty return to the Leader for routing.

Keep the context layers distinct. Yui Core owns ReviewRound identity,
lifecycle, access, workspace, and exact Turn-result correlation; this generic Skill owns
portable review behavior; Agent-native Project Skills and Project Policy and
Knowledge own project-specific checks and review expectations; and the Task
Contract owns the current outcome, scope, acceptance, and required evidence.

Treat real models, paid APIs, shared infrastructure, production systems, real
account quota, and every other non-disposable external resource as user-owned
authority. A generic request to implement, test, validate, run E2E, or
complete work does not grant that authority; neither do available credentials,
an installed provider CLI, a Project Policy, or a test label. Unless the user
proactively names the concrete real-resource validation, skip it without
creating an InputRequest or blocking the ReviewRound. Prefer existing
deterministic evidence, mocks, and isolated resources, then report the
verification gap and an optional follow-up. An explicit request authorizes
only its named resource, effect, and isolation boundary; never broaden it. A
real Agent may develop or review code, but that does not authorize a real
provider/model test.

Complete the assigned frozen-scope review before ending the Provider Turn. Accumulate all
reachable findings, verification gaps, checks actually run, and bounded next
actions, then return them together in one Review Turn result; do not stop as
soon as the first finding is discovered. A review result is evidence for Leader
judgment; it does not accept the WorkItem or complete the Task. Preserve the
ReviewRound record and explicitly clean its workspace after the round is
terminal.

For normal software delivery, follow the applicable Project Policy. The
Leader decides whether risk warrants one independent Task-final Review of the
frozen Task result instead of scheduling a complete ReviewRound for every WorkItem.
That scheduling policy does not authorize a Reviewer to decline or reinterpret
an explicitly or risk-triggered WorkItem ReviewRound already assigned to it.
Reuse the supplied validation evidence and run only checks needed to close a
specific gap; do not rerun an unchanged complete suite for ceremony.

Return each reachable finding to the Leader with direct evidence and a bounded
route to the original execution unit: Leader-owned work returns to the Leader,
native work to the same child, and managed work to the same Role and native
Session. Keep the existing WorkItem when its scope remains open. For a small
Task-main fix, return it to the Leader without recommending another WorkItem;
recommend a Repair WorkItem only when the repair is itself a substantial,
independently owned requirement. Never capture or integrate the ReviewRound's
diagnostic workspace.
